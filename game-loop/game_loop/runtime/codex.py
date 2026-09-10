from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any, Mapping, Protocol

from game_loop.runtime.isolation import EpisodeIsolation
from game_loop.runtime.providers import load_provider
from game_loop.runtime.protocol import GameSubmission, GameTask
from game_loop.runtime.trajectory import TrajectoryRecorder
from game_loop.utils import atomic_write_json, sha256_json


@dataclass(frozen=True)
class CodexRuntimeConfig:
    """Frozen settings for one source-backed Codex CLI episode."""

    model: str = "Qwen3.8-27B-node1"
    backbone_provider: str | None = "qwen"
    codex_bin: str = "codex"
    codex_source_root: str | None = None
    codex_source_revision: str | None = None
    system_prompt: str | None = None
    system_prompt_path: str | None = None
    active_subagent_prototypes: tuple[dict[str, Any], ...] = ()
    reasoning_effort: str = "high"
    model_context_window: int | None = None
    timeout_seconds: int = 3600
    environment: dict[str, str] = field(default_factory=dict)
    feature_flags: dict[str, bool] = field(default_factory=lambda: {
        "apps": False,
        "plugins": False,
        "multi_agent": True,
    })
    runtime_id: str = "codex-source-cli-v1"
    runtime_type: str = "codex"
    artifact_relpath: str | None = None

    def __post_init__(self) -> None:
        if self.system_prompt is not None and self.system_prompt_path is not None:
            raise ValueError("set only one of system_prompt and system_prompt_path")
        if not self.model:
            raise ValueError("Codex model is required")
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if self.model_context_window is not None and self.model_context_window <= 0:
            raise ValueError("model_context_window must be positive")
        if self.backbone_provider is not None:
            load_provider(self.backbone_provider)
        forbidden = sorted(
            key for key in self.environment
            if any(marker in key.upper() for marker in ("KEY", "TOKEN", "SECRET", "PASSWORD"))
        )
        if forbidden:
            raise ValueError(
                "runtime profile cannot contain credentials; set them only in the process environment: "
                + ", ".join(forbidden)
            )

    def to_dict(self, *, redact_environment: bool = False) -> dict[str, Any]:
        value = asdict(self)
        value["active_subagent_prototypes"] = [
            dict(item) for item in self.active_subagent_prototypes
        ]
        if redact_environment:
            value["environment"] = {key: "<redacted>" for key in self.environment}
        return value

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "CodexRuntimeConfig":
        return cls(
            model=str(value.get("model", "Qwen3.8-27B-node1")),
            backbone_provider=(
                None if value.get("backbone_provider") is None
                else str(value["backbone_provider"])
            ),
            codex_bin=str(value.get("codex_bin", "codex")),
            codex_source_root=(
                None if value.get("codex_source_root") is None
                else str(value["codex_source_root"])
            ),
            codex_source_revision=(
                None if value.get("codex_source_revision") is None
                else str(value["codex_source_revision"])
            ),
            system_prompt=(
                None if value.get("system_prompt") is None else str(value["system_prompt"])
            ),
            system_prompt_path=(
                None if value.get("system_prompt_path") is None
                else str(value["system_prompt_path"])
            ),
            active_subagent_prototypes=tuple(
                dict(item) for item in value.get("active_subagent_prototypes", [])
            ),
            reasoning_effort=str(value.get("reasoning_effort", "high")),
            model_context_window=(
                None if value.get("model_context_window") is None
                else int(value["model_context_window"])
            ),
            timeout_seconds=int(value.get("timeout_seconds", 3600)),
            environment={str(k): str(v) for k, v in value.get("environment", {}).items()},
            feature_flags={
                str(k): bool(v) for k, v in value.get(
                    "feature_flags",
                    {"apps": False, "plugins": False, "multi_agent": True},
                ).items()
            },
            runtime_id=str(value.get("runtime_id", "codex-source-cli-v1")),
            runtime_type=str(value.get("runtime_type", "codex")),
            artifact_relpath=(
                None if value.get("artifact_relpath") is None
                else str(value["artifact_relpath"])
            ),
        )


@dataclass(frozen=True)
class CodexRunnerResult:
    return_code: int
    events: tuple[dict[str, Any], ...] = ()
    result_text: str = ""
    usage: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


class CodexRunner(Protocol):
    def run(
        self,
        prompt: str,
        *,
        isolation: EpisodeIsolation,
        config: CodexRuntimeConfig,
        environment: Mapping[str, str],
        provider_base_url: str,
        provider_env_key: str,
    ) -> CodexRunnerResult: ...


class CodexCliRunner:
    """Runs the official Codex agent loop and captures its JSONL event stream."""

    def run(
        self,
        prompt: str,
        *,
        isolation: EpisodeIsolation,
        config: CodexRuntimeConfig,
        environment: Mapping[str, str],
        provider_base_url: str,
        provider_env_key: str,
    ) -> CodexRunnerResult:
        events_path = isolation.root / "codex-events.jsonl"
        stderr_path = isolation.root / "codex-stderr.log"
        last_message_path = isolation.root / "codex-last-message.txt"
        provider = (
            '{name="Game Evolver",base_url='
            f'{json.dumps(provider_base_url)},env_key={json.dumps(provider_env_key)},'
            'wire_api="responses"}'
        )
        command = [
            _resolve_executable(config.codex_bin),
            "exec",
            "--ignore-user-config",
            "--ephemeral",
            "--json",
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            "-C", str(isolation.workspace),
            "-m", config.model,
            "-o", str(last_message_path),
            "-c", 'model_provider="game_evolver"',
            "-c", f"model_providers.game_evolver={provider}",
            "-c", f"model_reasoning_effort={json.dumps(config.reasoning_effort)}",
        ]
        if config.model_context_window is not None:
            command.extend(["-c", f"model_context_window={config.model_context_window}"])
        for name, enabled in sorted(config.feature_flags.items()):
            command.extend(["-c", f"features.{name}={'true' if enabled else 'false'}"])
        command.append(prompt)
        with events_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            process = subprocess.Popen(
                command,
                cwd=isolation.workspace,
                env=dict(environment),
                stdout=stdout,
                stderr=stderr,
                start_new_session=True,
            )
            try:
                return_code = process.wait(timeout=config.timeout_seconds)
            except subprocess.TimeoutExpired:
                _terminate_process_group(process)
                return CodexRunnerResult(
                    -9,
                    events=_read_json_lines(events_path),
                    error=f"Codex timed out after {config.timeout_seconds}s",
                )
        events = _read_json_lines(events_path)
        result_text = (
            last_message_path.read_text(encoding="utf-8", errors="replace")
            if last_message_path.is_file()
            else _last_agent_message(events)
        )
        turn_completed = any(event.get("type") == "turn.completed" for event in events)
        failures = [
            str(event.get("error", event.get("message", "Codex turn failed")))
            for event in events
            if event.get("type") == "turn.failed"
            or (event.get("type") == "error" and not turn_completed)
        ]
        error = None
        if return_code != 0 or failures:
            stderr_tail = _tail(stderr_path, 4000)
            error = "; ".join((*failures, stderr_tail)).strip("; ") or (
                f"Codex exited {return_code}"
            )
        return CodexRunnerResult(
            return_code,
            events=events,
            result_text=result_text,
            usage=_collect_usage(events),
            error=error,
        )


class CodexRuntime:
    def __init__(
        self,
        config: CodexRuntimeConfig,
        *,
        runner: CodexRunner | None = None,
    ) -> None:
        self.config = config
        self.runner = runner or CodexCliRunner()

    def doctor(self) -> dict[str, Any]:
        executable = _which(self.config.codex_bin)
        source = (
            None if self.config.codex_source_root is None
            else Path(self.config.codex_source_root).expanduser().resolve()
        )
        actual_revision = _git_revision(source)
        checks: dict[str, bool] = {
            "codex_bin_resolves": executable is not None,
            "codex_source_is_dir": source is not None and source.is_dir(),
            "codex_source_revision_matches": bool(
                actual_revision
                and self.config.codex_source_revision
                and actual_revision == self.config.codex_source_revision
            ),
        }
        provider_report: dict[str, Any] | None = None
        if self.config.backbone_provider is not None:
            provider_report = load_provider(self.config.backbone_provider).resolve().doctor()
            checks["provider_ready"] = bool(provider_report["ready"])
        version = ""
        if executable is not None:
            completed = subprocess.run(
                [executable, "--version"], capture_output=True, text=True, timeout=10
            )
            version = (completed.stdout or completed.stderr).strip()
            checks["codex_starts"] = completed.returncode == 0 and version.startswith("codex-cli")
        return {
            "runtime_id": self.config.runtime_id,
            "runtime_type": self.config.runtime_type,
            "runner": type(self.runner).__name__,
            "ok": all(checks.values()),
            "checks": checks,
            "provider": provider_report,
            "codex_bin": executable,
            "codex_version": version,
            "codex_source_root": None if source is None else str(source),
            "codex_source_revision": actual_revision,
        }

    def run(self, task: GameTask, *, episode_dir: Path) -> GameSubmission:
        run_config = replace(self.config, artifact_relpath=task.artifact_relpath)
        isolation = EpisodeIsolation.create(
            episode_dir,
            workspace_seed=(
                None if task.workspace_seed_ref is None else Path(task.workspace_seed_ref)
            ),
            runtime_layout="codex",
        )
        atomic_write_json(isolation.root / "task.json", task.to_dict())
        _install_agent_roles(isolation.workspace, run_config.active_subagent_prototypes)
        environment = isolation.environment(_runtime_base_environment(), inherit_process=False)
        environment.update(run_config.environment)
        environment["CODEX_HOME"] = str(isolation.home / ".codex")
        provider_base_url = "https://api.openai.com/v1"
        provider_env_key = "GAME_LOOP_CODEX_API_KEY"
        provider_route: str | None = None
        if run_config.backbone_provider is not None:
            provider = load_provider(run_config.backbone_provider)
            provider_environment = dict(os.environ)
            provider_environment.update(run_config.environment)
            resolved = provider.resolve(provider_environment)
            if resolved.api_key is None and resolved.requires_credential:
                raise RuntimeError(
                    f"{run_config.backbone_provider} credential is missing; set one of: "
                    + ", ".join(provider.credential_envs)
                )
            provider_base_url = resolved.base_url
            provider_route = resolved.route_id
            environment[provider_env_key] = resolved.api_key or "EMPTY"
            run_config = replace(run_config, model=resolved.model)
        prompt = _runtime_prompt(task, run_config, isolation.workspace)
        trajectory = TrajectoryRecorder(isolation.root / "trajectory.jsonl")
        trajectory.record("runtime_started", "codex", {
            "task_id": task.task_id,
            "benchmark_id": task.benchmark_id,
            "runtime_id": run_config.runtime_id,
        })
        artifact = _workspace_artifact(isolation.workspace, task.artifact_relpath)
        artifact_before = _artifact_digest(artifact)
        result = self.runner.run(
            prompt,
            isolation=isolation,
            config=run_config,
            environment=environment,
            provider_base_url=provider_base_url,
            provider_env_key=provider_env_key,
        )
        for event in result.events:
            trajectory.record("session_event", "codex", event)
        diagnostics: list[str] = []
        if result.error:
            diagnostics.append(result.error)
        if not any(event.get("type") == "turn.completed" for event in result.events):
            diagnostics.append("Codex did not emit turn.completed")
        if not _artifact_exists(artifact):
            diagnostics.append(f"expected artifact is missing: {task.artifact_relpath}")
        elif _artifact_digest(artifact) == artifact_before:
            diagnostics.append(
                f"expected artifact was not changed by this episode: {task.artifact_relpath}"
            )
        status = "completed" if not diagnostics else "failed"
        trajectory.record("runtime_finished", "codex", {
            "status": status,
            "finish_reason": "completed" if status == "completed" else "error",
            "diagnostics": diagnostics,
        })
        usage = dict(result.usage)
        usage.setdefault("modelCalls", sum(
            event.get("type") == "turn.started" for event in result.events
        ))
        role_ids = [str(item.get("id", "")) for item in run_config.active_subagent_prototypes]
        submission = GameSubmission.create(
            task_id=task.task_id,
            runtime_id=run_config.runtime_id,
            status=status,
            artifact_ref=artifact if status == "completed" else None,
            trajectory_ref=trajectory.path,
            result_text=result.result_text,
            diagnostics=tuple(diagnostics),
            usage=usage,
            metadata={
                "episode_root": str(isolation.root),
                "session_root": str(isolation.root / "codex-events"),
                "event_stream": str(isolation.root / "codex-events.jsonl"),
                "runtime_type": "codex",
                "runtime_config_hash": sha256_json(run_config.to_dict()),
                "provider_route": provider_route,
                "provider_base_url": provider_base_url,
                "provider_model": run_config.model,
                "active_subagent_roles": role_ids,
                "root_visible_subagent_tools": (["spawn_agent"] if role_ids else []),
                "subagent_contract_prompt_sha256": (
                    hashlib.sha256(_prototype_prompt(role_ids).encode("utf-8")).hexdigest()
                    if role_ids else None
                ),
                "codex_source_revision": run_config.codex_source_revision,
            },
        )
        atomic_write_json(isolation.root / "submission.json", submission.to_dict())
        atomic_write_json(isolation.root / "runtime_manifest.json", {
            "runtime": run_config.to_dict(redact_environment=True),
            "runtime_config_hash": sha256_json(run_config.to_dict()),
            "isolation": isolation.to_dict(),
            "trajectory_ref": str(trajectory.path),
            "submission_ref": str(isolation.root / "submission.json"),
        })
        return submission


def _runtime_prompt(task: GameTask, config: CodexRuntimeConfig, workspace: Path) -> str:
    system_prompt = config.system_prompt
    if config.system_prompt_path is not None:
        system_prompt = Path(config.system_prompt_path).read_text(encoding="utf-8")
    role_ids = [str(item.get("id", "")) for item in config.active_subagent_prototypes]
    sections = [
        "## Runtime workspace authority\n\n"
        f"Your writable workspace is `{workspace}`. Work only inside it. "
        f"Make a concrete production improvement under `{task.artifact_relpath}` and verify it.",
        "## Runtime deadline\n\n"
        f"You have at most {config.timeout_seconds} seconds. Implement early, then run bounded tests "
        "and finish with a concise account of the changed artifact.",
    ]
    if role_ids:
        sections.append(_prototype_prompt(role_ids))
    if system_prompt:
        sections.append(system_prompt.strip())
    sections.append(f"## Task\n\n{task.prompt}")
    return "\n\n".join(sections)


def _prototype_prompt(role_ids: list[str]) -> str:
    return (
        "## Evolved Codex agent roles\n\n"
        "The following HPA-evolved roles are available through Codex multi-agent tools: "
        + ", ".join(f"`{item}`" for item in role_ids)
        + ". Delegate only when a bounded independent slice is useful, then integrate and verify its work."
    )


def _install_agent_roles(workspace: Path, prototypes: tuple[dict[str, Any], ...]) -> None:
    roles = workspace / ".codex" / "agents"
    roles.mkdir(parents=True, exist_ok=True)
    for prototype in prototypes:
        role_id = _safe_role_id(str(prototype.get("id", "")))
        if not role_id:
            raise ValueError("Codex subagent prototype requires an id")
        description = str(prototype.get("description", "")).strip()
        instructions = str(prototype.get("persona", "")).strip()
        if not description or not instructions:
            raise ValueError(f"Codex subagent prototype {role_id!r} is incomplete")
        (roles / f"{role_id}.toml").write_text(
            f"name = {json.dumps(role_id)}\n"
            f"description = {json.dumps(description)}\n"
            f"developer_instructions = {json.dumps(instructions)}\n",
            encoding="utf-8",
        )


def _safe_role_id(value: str) -> str:
    return re.sub(r"[^a-z0-9_-]+", "-", value.strip().casefold()).strip("-")


def _read_json_lines(path: Path) -> tuple[dict[str, Any], ...]:
    if not path.is_file():
        return ()
    events: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            events.append(value)
    return tuple(events)


def _collect_usage(events: tuple[dict[str, Any], ...]) -> dict[str, Any]:
    usage = {
        "inputTokens": 0,
        "cachedInputTokens": 0,
        "outputTokens": 0,
        "reasoningOutputTokens": 0,
    }
    for event in events:
        if event.get("type") != "turn.completed":
            continue
        raw = event.get("usage", {})
        if not isinstance(raw, Mapping):
            continue
        usage["inputTokens"] += int(raw.get("input_tokens", 0))
        usage["cachedInputTokens"] += int(raw.get("cached_input_tokens", 0))
        usage["outputTokens"] += int(raw.get("output_tokens", 0))
        usage["reasoningOutputTokens"] += int(raw.get("reasoning_output_tokens", 0))
    return usage


def _last_agent_message(events: tuple[dict[str, Any], ...]) -> str:
    messages = [
        str(event.get("item", {}).get("text", ""))
        for event in events
        if event.get("type") == "item.completed"
        and isinstance(event.get("item"), Mapping)
        and event["item"].get("type") == "agent_message"
    ]
    return messages[-1] if messages else ""


def _workspace_artifact(workspace: Path, relative: str) -> Path:
    artifact = (workspace / relative).resolve()
    try:
        artifact.relative_to(workspace.resolve())
    except ValueError as exc:
        raise ValueError("artifact path escaped the episode workspace") from exc
    return artifact


def _artifact_exists(artifact: Path) -> bool:
    if artifact.is_file():
        return True
    return artifact.is_dir() and any(
        path.is_file() and ".codex" not in path.relative_to(artifact).parts
        for path in artifact.rglob("*")
    )


def _artifact_digest(artifact: Path) -> str | None:
    if not artifact.exists():
        return None
    digest = hashlib.sha256()
    paths = [artifact] if artifact.is_file() else sorted(artifact.rglob("*"))
    for path in paths:
        relative = Path(path.name) if artifact.is_file() else path.relative_to(artifact)
        if ".codex" in relative.parts or not path.is_file():
            continue
        digest.update(relative.as_posix().encode())
        digest.update(b"\0")
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def _runtime_base_environment() -> dict[str, str]:
    allowed = {
        "COMSPEC", "LANG", "LC_ALL", "NODE_PATH", "PATH", "PATHEXT", "SHELL",
        "SSL_CERT_DIR", "SSL_CERT_FILE", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR",
    }
    return {key: value for key, value in os.environ.items() if key in allowed}


def _which(value: str) -> str | None:
    path = Path(value).expanduser()
    if path.is_file():
        return str(path.resolve())
    return shutil.which(value)


def _resolve_executable(value: str) -> str:
    resolved = _which(value)
    if resolved is None:
        raise FileNotFoundError(f"Codex executable not found: {value}")
    return resolved


def _git_revision(source: Path | None) -> str | None:
    if source is None or not source.is_dir():
        return None
    completed = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        timeout=10,
    )
    return completed.stdout.strip() if completed.returncode == 0 else None


def _terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=10)


def _tail(path: Path, limit: int) -> str:
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")[-limit:]
