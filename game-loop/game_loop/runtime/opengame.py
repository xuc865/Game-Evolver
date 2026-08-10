from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence

from game_loop.runtime.isolation import EpisodeIsolation
from game_loop.runtime.providers import load_provider
from game_loop.runtime.protocol import GameSubmission, GameTask
from game_loop.runtime.trajectory import TrajectoryRecorder
from game_loop.utils import atomic_write_json, read_json, sha256_json


@dataclass(frozen=True)
class OpenGameRuntimeConfig:
    """Frozen runtime settings. Benchmark evaluation deliberately lives elsewhere."""

    model: str | None = None
    backbone_provider: str | None = None
    system_prompt: str | None = None
    system_prompt_path: str | None = None
    system_prompt_variables: dict[str, str] = field(default_factory=dict)
    skills_source: str | None = None
    permission_mode: str = "auto-edit"
    core_tools: tuple[str, ...] = ()
    exclude_tools: tuple[str, ...] = ()
    allowed_tools: tuple[str, ...] = ()
    mcp_servers: dict[str, dict[str, Any]] = field(default_factory=dict)
    max_session_turns: int = -1
    timeout_seconds: int = 3600
    node_executable: str = "node"
    sdk_module: str = "@opengame/sdk"
    opengame_executable: str | None = None
    environment: dict[str, str] = field(default_factory=dict)
    settings: dict[str, Any] = field(default_factory=dict)
    runtime_id: str = "opengame-typescript-sdk-v1"

    def __post_init__(self) -> None:
        if self.system_prompt is not None and self.system_prompt_path is not None:
            raise ValueError("set only one of system_prompt and system_prompt_path")
        if self.permission_mode not in {"default", "plan", "auto-edit", "yolo"}:
            raise ValueError(f"unsupported permission_mode: {self.permission_mode}")
        if self.max_session_turns == 0 or self.max_session_turns < -1:
            raise ValueError("max_session_turns must be -1 or positive")
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
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
        for name, server in self.mcp_servers.items():
            if "instance" in server or server.get("type") == "sdk":
                raise ValueError(
                    f"MCP server {name} is not JSON-serializable; use an external transport"
                )

    def to_dict(self, *, redact_environment: bool = False) -> dict[str, Any]:
        value = asdict(self)
        if redact_environment:
            value["environment"] = {key: "<redacted>" for key in self.environment}
        return value

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "OpenGameRuntimeConfig":
        return cls(
            model=None if value.get("model") is None else str(value["model"]),
            backbone_provider=(
                None
                if value.get("backbone_provider") is None
                else str(value["backbone_provider"])
            ),
            system_prompt=(
                None if value.get("system_prompt") is None else str(value["system_prompt"])
            ),
            system_prompt_path=(
                None
                if value.get("system_prompt_path") is None
                else str(value["system_prompt_path"])
            ),
            system_prompt_variables={
                str(k): str(v) for k, v in value.get("system_prompt_variables", {}).items()
            },
            skills_source=(
                None if value.get("skills_source") is None else str(value["skills_source"])
            ),
            permission_mode=str(value.get("permission_mode", "auto-edit")),
            core_tools=tuple(str(item) for item in value.get("core_tools", [])),
            exclude_tools=tuple(str(item) for item in value.get("exclude_tools", [])),
            allowed_tools=tuple(str(item) for item in value.get("allowed_tools", [])),
            mcp_servers={str(k): dict(v) for k, v in value.get("mcp_servers", {}).items()},
            max_session_turns=int(value.get("max_session_turns", -1)),
            timeout_seconds=int(value.get("timeout_seconds", 3600)),
            node_executable=str(value.get("node_executable", "node")),
            sdk_module=str(value.get("sdk_module", "@opengame/sdk")),
            opengame_executable=(
                None
                if value.get("opengame_executable") is None
                else str(value["opengame_executable"])
            ),
            environment={str(k): str(v) for k, v in value.get("environment", {}).items()},
            settings=dict(value.get("settings", {})),
            runtime_id=str(value.get("runtime_id", "opengame-typescript-sdk-v1")),
        )


@dataclass(frozen=True)
class RunnerResult:
    return_code: int
    events: tuple[dict[str, Any], ...] = ()
    result_text: str = ""
    usage: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


class OpenGameRunner(Protocol):
    def run(
        self,
        request: dict[str, Any],
        *,
        isolation: EpisodeIsolation,
        environment: Mapping[str, str],
        timeout_seconds: int,
    ) -> RunnerResult: ...


class TypeScriptSDKRunner:
    """Executes the official @opengame/sdk through a small Node bridge."""

    def __init__(self, *, node_executable: str = "node", bridge_path: Path | None = None):
        self.node_executable = node_executable
        self.bridge_path = (
            Path(__file__).with_name("opengame_bridge.mjs")
            if bridge_path is None
            else bridge_path.resolve()
        )

    def run(
        self,
        request: dict[str, Any],
        *,
        isolation: EpisodeIsolation,
        environment: Mapping[str, str],
        timeout_seconds: int,
    ) -> RunnerResult:
        request_path = isolation.root / "sdk_request.json"
        raw_events = isolation.root / "sdk_events.jsonl"
        result_path = isolation.root / "sdk_result.json"
        log_path = isolation.root / "sdk_bridge.log"
        atomic_write_json(request_path, request)
        with log_path.open("wb") as log:
            try:
                completed = subprocess.run(
                    [
                        self.node_executable,
                        str(self.bridge_path),
                        str(request_path),
                        str(raw_events),
                        str(result_path),
                    ],
                    cwd=isolation.workspace,
                    env=dict(environment),
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    timeout=timeout_seconds,
                    check=False,
                )
            except subprocess.TimeoutExpired:
                return RunnerResult(-9, error=f"OpenGame SDK timed out after {timeout_seconds}s")
        events = tuple(_read_json_lines(raw_events))
        result = read_json(result_path) if result_path.is_file() else {}
        final = result.get("final_result") or {}
        return RunnerResult(
            return_code=completed.returncode,
            events=events,
            result_text=str(final.get("result", "")),
            usage=dict(final.get("usage", {})),
            error=None if result.get("ok") else str(result.get("error", "OpenGame SDK failed")),
        )

    def doctor(self, *, sdk_module: str, environment: Mapping[str, str] | None = None) -> dict[str, Any]:
        node = shutil.which(self.node_executable)
        report: dict[str, Any] = {
            "node_executable": self.node_executable,
            "node_resolved": node,
            "bridge_path": str(self.bridge_path),
            "bridge_exists": self.bridge_path.is_file(),
            "sdk_module": sdk_module,
            "sdk_importable": False,
        }
        if node is None or not self.bridge_path.is_file():
            return report
        script = (
            "import {pathToFileURL} from 'node:url';"
            "const m=process.argv[1];"
            "const s=m.startsWith('/')?pathToFileURL(m).href:m;"
            "import(s).then(x=>process.exit(typeof x.query==='function'?0:2)).catch(()=>process.exit(1));"
        )
        completed = subprocess.run(
            [node, "--input-type=module", "-e", script, sdk_module],
            env=dict(os.environ if environment is None else environment),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
            check=False,
        )
        report["sdk_importable"] = completed.returncode == 0
        report["sdk_import_return_code"] = completed.returncode
        return report


class OpenGameRuntime:
    def __init__(
        self,
        config: OpenGameRuntimeConfig,
        *,
        runner: OpenGameRunner | None = None,
    ):
        self.config = config
        self.runner = runner or TypeScriptSDKRunner(node_executable=config.node_executable)

    def doctor(self) -> dict[str, Any]:
        method = getattr(self.runner, "doctor", None)
        provider_report = (
            None
            if self.config.backbone_provider is None
            else load_provider(self.config.backbone_provider).resolve().doctor()
        )
        if method is None:
            return {
                "runtime_id": self.config.runtime_id,
                "runner": type(self.runner).__name__,
                "runner_doctor_available": False,
                "provider": provider_report,
            }
        return {
            "runtime_id": self.config.runtime_id,
            "runner": type(self.runner).__name__,
            "runner_doctor_available": True,
            "provider": provider_report,
            **method(sdk_module=self.config.sdk_module),
        }

    def run(self, task: GameTask, *, episode_dir: Path) -> GameSubmission:
        system_prompt = self.config.system_prompt
        if self.config.system_prompt_path is not None:
            prompt_path = Path(self.config.system_prompt_path).expanduser().resolve()
            if not prompt_path.is_file():
                raise FileNotFoundError(f"system_prompt_path does not exist: {prompt_path}")
            system_prompt = prompt_path.read_text(encoding="utf-8")
        if system_prompt is not None:
            for placeholder, replacement in self.config.system_prompt_variables.items():
                system_prompt = system_prompt.replace(placeholder, replacement)
        isolation = EpisodeIsolation.create(
            episode_dir,
            workspace_seed=(
                None if task.workspace_seed_ref is None else Path(task.workspace_seed_ref)
            ),
            skills_source=(
                None if self.config.skills_source is None else Path(self.config.skills_source)
            ),
            settings=self.config.settings,
            system_prompt=system_prompt,
        )
        atomic_write_json(isolation.root / "task.json", task.to_dict())
        trajectory = TrajectoryRecorder(isolation.root / "trajectory.jsonl")
        trajectory.record("runtime_started", "harness", {
            "task_id": task.task_id,
            "benchmark_id": task.benchmark_id,
            "runtime_id": self.config.runtime_id,
        })
        environment = isolation.environment()
        environment.update(self.config.environment)
        environment.update({
            "HOME": str(isolation.home),
            "USERPROFILE": str(isolation.home),
            "XDG_CONFIG_HOME": str(isolation.config_home),
            "XDG_CACHE_HOME": str(isolation.cache_home),
            "XDG_DATA_HOME": str(isolation.data_home),
        })
        provider_model = None
        if self.config.backbone_provider is not None:
            resolved_provider = load_provider(self.config.backbone_provider).resolve(environment)
            environment = resolved_provider.inject(environment)
            provider_model = resolved_provider.model
        request = self._request(task, isolation, provider_model=provider_model)
        atomic_write_json(isolation.root / "sdk_request.json", request)
        if system_prompt is not None:
            environment["QWEN_SYSTEM_MD"] = "1"
        result = self.runner.run(
            request,
            isolation=isolation,
            environment=environment,
            timeout_seconds=self.config.timeout_seconds,
        )
        for raw in result.events:
            trajectory.record("sdk_message", "opengame", dict(raw))

        artifact = _workspace_artifact(isolation.workspace, task.artifact_relpath)
        diagnostics: list[str] = []
        if result.error:
            diagnostics.append(result.error)
        provider_error = _looks_like_provider_error(result.result_text)
        if provider_error:
            diagnostics.append(result.result_text)
        if not artifact.exists():
            diagnostics.append(f"expected artifact is missing: {task.artifact_relpath}")
        status = (
            "completed"
            if result.return_code == 0 and artifact.exists() and not provider_error
            else "failed"
        )
        trajectory.record("runtime_finished", "harness", {
            "return_code": result.return_code,
            "status": status,
            "diagnostics": diagnostics,
        })
        submission = GameSubmission.create(
            task_id=task.task_id,
            runtime_id=self.config.runtime_id,
            status=status,
            artifact_ref=artifact if status == "completed" else None,
            trajectory_ref=trajectory.path,
            result_text=result.result_text,
            diagnostics=tuple(diagnostics),
            usage=result.usage,
            metadata={
                "episode_root": str(isolation.root),
                "runtime_config_hash": sha256_json(self.config.to_dict()),
                "return_code": result.return_code,
            },
        )
        atomic_write_json(isolation.root / "submission.json", submission.to_dict())
        atomic_write_json(isolation.root / "runtime_manifest.json", {
            "runtime": self.config.to_dict(redact_environment=True),
            "runtime_config_hash": sha256_json(self.config.to_dict()),
            "isolation": isolation.to_dict(),
            "request_ref": str(isolation.root / "sdk_request.json"),
            "trajectory_ref": str(trajectory.path),
            "submission_ref": str(isolation.root / "submission.json"),
        })
        return submission

    def _request(
        self,
        task: GameTask,
        isolation: EpisodeIsolation,
        *,
        provider_model: str | None = None,
    ) -> dict[str, Any]:
        options: dict[str, Any] = {
            "cwd": str(isolation.workspace),
            "permissionMode": self.config.permission_mode,
            "maxSessionTurns": self.config.max_session_turns,
        }
        model = self.config.model or provider_model
        if model is not None:
            options["model"] = model
        if self.config.opengame_executable is not None:
            options["pathToQwenExecutable"] = self.config.opengame_executable
        if self.config.core_tools:
            options["coreTools"] = list(self.config.core_tools)
        if self.config.exclude_tools:
            options["excludeTools"] = list(self.config.exclude_tools)
        if self.config.allowed_tools:
            options["allowedTools"] = list(self.config.allowed_tools)
        if self.config.mcp_servers:
            options["mcpServers"] = self.config.mcp_servers
        return {
            "sdk_module": self.config.sdk_module,
            "prompt": task.prompt,
            "options": options,
        }


def _read_json_lines(path: Path) -> Sequence[dict[str, Any]]:
    if not path.is_file():
        return ()
    values: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            values.append(dict(json.loads(line)))
    return values


def _workspace_artifact(workspace: Path, relative: str) -> Path:
    artifact = (workspace / relative).resolve()
    try:
        artifact.relative_to(workspace.resolve())
    except ValueError as exc:
        raise ValueError("artifact path escaped the episode workspace") from exc
    return artifact


def _looks_like_provider_error(text: str) -> bool:
    lowered = text.strip().casefold()
    return (
        lowered.startswith("[api error:")
        or "access denied" in lowered
        or '"type":"arrearage"' in lowered
        or '"code":"arrearage"' in lowered
    )
