from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import tempfile
import threading
import time
from collections.abc import Mapping, Sequence
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any, Protocol

from game_loop.core.agent_circuit import AgentCircuit
from game_loop.runtime.isolation import EpisodeIsolation
from game_loop.runtime.protocol import GameSubmission, GameTask
from game_loop.runtime.providers import load_provider
from game_loop.runtime.trajectory import TrajectoryRecorder
from game_loop.utils import atomic_write_json, sha256_json


_PROCESS_ENVIRONMENT_LOCK = threading.Lock()
_FINALIZATION_PROMPT = (
    "The runtime soft deadline has been reached. Stop all implementation, inspection, "
    "and verification now. Do not call any tool. Briefly summarize the artifact already "
    "written in the workspace, any verification already completed, and any known "
    "limitations, then end this turn immediately."
)


@dataclass(frozen=True)
class DeepSeekHarnessRuntimeConfig:
    """Frozen settings for one DeepSeek Harness SDK episode."""

    provider: str = "deepseek-official"
    model: str = "deepseek-v4-flash"
    backbone_provider: str | None = "deepseek"
    max_tokens: int | None = None
    system_prompt: str | None = None
    system_prompt_path: str | None = None
    system_prompt_variables: dict[str, str] = field(default_factory=dict)
    skills_source: str | None = None
    cordis: str | None = None
    cordis_seed: str | None = None
    cordis_plugin_catalog: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    active_cordis_plugins: tuple[str, ...] = ()
    effective_cordis_sha256: str | None = None
    harness_module_catalog: dict[str, dict[str, Any]] = field(default_factory=dict)
    harness_element_catalog: dict[str, dict[str, Any]] = field(default_factory=dict)
    harness_tool_interface_catalog: dict[str, dict[str, Any]] = field(default_factory=dict)
    runtime_bin: str | None = None
    launch_args_override: tuple[str, ...] = ()
    runtime_cwd: str | None = None
    timeout_seconds: int = 3600
    shutdown_timeout_seconds: float = 5.0
    finalization_reserve_seconds: int = 120
    finalization_cancel_grace_seconds: float = 15.0
    environment: dict[str, str] = field(default_factory=dict)
    successful_finish_reasons: tuple[str, ...] = ("completed",)
    runtime_id: str = "deepseek-harness-sdk-v1"
    runtime_type: str = "deepseek-harness"
    agent_circuit: AgentCircuit | None = None

    def __post_init__(self) -> None:
        if self.system_prompt is not None and self.system_prompt_path is not None:
            raise ValueError("set only one of system_prompt and system_prompt_path")
        if not self.provider or not self.model:
            raise ValueError("DeepSeek Harness provider and model are required")
        if self.max_tokens is not None and self.max_tokens <= 0:
            raise ValueError("max_tokens must be positive")
        if self.timeout_seconds <= 0 or self.shutdown_timeout_seconds <= 0:
            raise ValueError("runtime timeouts must be positive")
        if self.finalization_reserve_seconds < 0:
            raise ValueError("finalization_reserve_seconds must not be negative")
        if self.finalization_cancel_grace_seconds <= 0:
            raise ValueError("finalization_cancel_grace_seconds must be positive")
        if not self.successful_finish_reasons:
            raise ValueError("successful_finish_reasons must not be empty")
        if self.backbone_provider is not None:
            load_provider(self.backbone_provider)
        catalogs = (
            ("module", self.harness_module_catalog, "id"),
            ("element", self.harness_element_catalog, "element_id"),
            (
                "tool interface",
                self.harness_tool_interface_catalog,
                "interface_id",
            ),
        )
        for label, catalog, identity_field in catalogs:
            for component_id, raw in catalog.items():
                if not isinstance(raw, Mapping):
                    raise ValueError(f"harness {label} catalog rows must be objects")
                supplied_id = str(raw.get(identity_field, raw.get("id", "")))
                if supplied_id != component_id:
                    raise ValueError(
                        f"harness {label} catalog key/content mismatch: "
                        f"{component_id!r} != {supplied_id!r}"
                    )
        for module_id, raw in self.harness_module_catalog.items():
            if not str(raw.get("instruction", "")).strip():
                raise ValueError(
                    f"harness module {module_id} requires an executable instruction"
                )
        for element_id, raw in self.harness_element_catalog.items():
            if not str(raw.get("category", "")).strip() or not str(
                raw.get("description", "")
            ).strip():
                raise ValueError(
                    f"harness element {element_id} requires category and description"
                )
        forbidden = sorted(
            key
            for key in self.environment
            if any(marker in key.upper() for marker in ("KEY", "TOKEN", "SECRET", "PASSWORD"))
        )
        if forbidden:
            raise ValueError(
                "runtime profile cannot contain credentials; set them only in the process environment: "
                + ", ".join(forbidden)
            )

    def to_dict(self, *, redact_environment: bool = False) -> dict[str, Any]:
        value = asdict(self)
        value["agent_circuit"] = (
            None if self.agent_circuit is None else self.agent_circuit.to_dict()
        )
        value["launch_args_override"] = list(self.launch_args_override)
        value["successful_finish_reasons"] = list(self.successful_finish_reasons)
        value["active_cordis_plugins"] = list(self.active_cordis_plugins)
        if redact_environment:
            value["environment"] = {key: "<redacted>" for key in self.environment}
        return value

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> DeepSeekHarnessRuntimeConfig:
        return cls(
            provider=str(value.get("provider", "deepseek-official")),
            model=str(value.get("model", "deepseek-v4-flash")),
            backbone_provider=(
                None
                if value.get("backbone_provider") is None
                else str(value["backbone_provider"])
            ),
            max_tokens=(None if value.get("max_tokens") is None else int(value["max_tokens"])),
            system_prompt=(
                None if value.get("system_prompt") is None else str(value["system_prompt"])
            ),
            system_prompt_path=(
                None
                if value.get("system_prompt_path") is None
                else str(value["system_prompt_path"])
            ),
            system_prompt_variables={
                str(key): str(item)
                for key, item in value.get("system_prompt_variables", {}).items()
            },
            skills_source=(
                None if value.get("skills_source") is None else str(value["skills_source"])
            ),
            cordis=None if value.get("cordis") is None else str(value["cordis"]),
            cordis_seed=(
                None if value.get("cordis_seed") is None else str(value["cordis_seed"])
            ),
            cordis_plugin_catalog={
                str(key): [dict(row) for row in rows]
                for key, rows in dict(value.get("cordis_plugin_catalog", {})).items()
            },
            active_cordis_plugins=tuple(
                str(item) for item in value.get("active_cordis_plugins", [])
            ),
            effective_cordis_sha256=(
                None
                if value.get("effective_cordis_sha256") is None
                else str(value["effective_cordis_sha256"])
            ),
            harness_module_catalog={
                str(key): dict(item)
                for key, item in dict(value.get("harness_module_catalog", {})).items()
            },
            harness_element_catalog={
                str(key): dict(item)
                for key, item in dict(value.get("harness_element_catalog", {})).items()
            },
            harness_tool_interface_catalog={
                str(key): dict(item)
                for key, item in dict(
                    value.get("harness_tool_interface_catalog", {})
                ).items()
            },
            runtime_bin=(
                None if value.get("runtime_bin") is None else str(value["runtime_bin"])
            ),
            launch_args_override=tuple(
                str(item) for item in value.get("launch_args_override", [])
            ),
            runtime_cwd=(
                None if value.get("runtime_cwd") is None else str(value["runtime_cwd"])
            ),
            timeout_seconds=int(value.get("timeout_seconds", 3600)),
            shutdown_timeout_seconds=float(value.get("shutdown_timeout_seconds", 5.0)),
            finalization_reserve_seconds=int(
                value.get("finalization_reserve_seconds", 120)
            ),
            finalization_cancel_grace_seconds=float(
                value.get("finalization_cancel_grace_seconds", 15.0)
            ),
            environment={str(key): str(item) for key, item in value.get("environment", {}).items()},
            successful_finish_reasons=tuple(
                str(item) for item in value.get("successful_finish_reasons", ["completed"])
            ),
            runtime_id=str(value.get("runtime_id", "deepseek-harness-sdk-v1")),
            runtime_type=str(value.get("runtime_type", "deepseek-harness")),
            agent_circuit=(
                None
                if value.get("agent_circuit") is None
                else AgentCircuit.from_dict(dict(value["agent_circuit"]))
            ),
        )


@dataclass(frozen=True)
class DeepSeekHarnessRunnerResult:
    finish_reason: str | None
    final_response: str
    events: tuple[dict[str, Any], ...] = ()
    notifications: tuple[dict[str, Any], ...] = ()
    session_root: str | None = None
    model_calls: int = 1
    finalization_attempted: bool = False
    finalization_completed: bool = False
    finalization_restarted: bool = False


class DeepSeekHarnessRunner(Protocol):
    def run(
        self,
        prompt: str,
        *,
        cwd: Path,
        session_root: Path,
        config: DeepSeekHarnessRuntimeConfig,
        environment: Mapping[str, str],
    ) -> DeepSeekHarnessRunnerResult: ...


class PythonSDKRunner:
    """Drive the official DeepSeek Harness JSON-RPC SDK lazily."""

    def run(
        self,
        prompt: str,
        *,
        cwd: Path,
        session_root: Path,
        config: DeepSeekHarnessRuntimeConfig,
        environment: Mapping[str, str],
    ) -> DeepSeekHarnessRunnerResult:
        try:
            from deepseek_harness import DeepSeekHarness
        except ImportError as exc:
            raise RuntimeError(
                "DeepSeek Harness SDK is unavailable; install deepseek-harness-sdk "
                "or configure its source package on PYTHONPATH"
            ) from exc

        kwargs = _sdk_kwargs(config, cwd, session_root, environment)
        harness = DeepSeekHarness(**kwargs)
        outcome: dict[str, Any] = {}
        observed_notifications: list[dict[str, Any]] = []
        started = time.monotonic()

        def execute() -> None:
            try:
                # The rc.7 SDK merges env overrides onto os.environ.  Start it
                # while this dedicated backend process exposes only the
                # allowlisted environment, then immediately restore the
                # launcher's environment for normal controller bookkeeping.
                with _temporary_process_environment(environment):
                    harness.start()
                session = harness.start_session()
                outcome["session"] = session
                outcome["result"] = session.run(
                    prompt,
                    on_notification=lambda item: observed_notifications.append(
                        _notification_dict(item)
                    ),
                )
            except BaseException as exc:  # noqa: BLE001 - cross-thread transport outcome.
                outcome["error"] = exc

        worker = threading.Thread(target=execute, name="dsh-owned-turn", daemon=True)
        worker.start()
        reserve = min(
            config.finalization_reserve_seconds,
            max(0, config.timeout_seconds - 1),
        )
        soft_timeout = config.timeout_seconds - reserve
        worker.join(soft_timeout)
        if worker.is_alive():
            if reserve <= 0:
                _close_harness(harness)
                worker.join(config.shutdown_timeout_seconds)
                raise TimeoutError(
                    f"DeepSeek Harness turn timed out after {config.timeout_seconds}s"
                )
            session = outcome.get("session")
            if session is None:
                _close_harness(harness)
                worker.join(config.shutdown_timeout_seconds)
                raise TimeoutError(
                    "DeepSeek Harness turn timed out before session initialization"
                )
            try:
                harness.client.notify("session/cancel", {"sessionId": session.id})
            except BaseException:  # noqa: BLE001 - ensure the owned process is reaped.
                _close_harness(harness)
                worker.join(config.shutdown_timeout_seconds)
                raise
            cancel_grace = min(
                config.finalization_cancel_grace_seconds,
                max(0.0, config.timeout_seconds - (time.monotonic() - started)),
            )
            worker.join(cancel_grace)
            finalization_restarted = worker.is_alive()
            if worker.is_alive():
                _close_harness(harness)
                worker.join(config.shutdown_timeout_seconds)
                if worker.is_alive():
                    raise TimeoutError(
                        "DeepSeek Harness turn did not stop after owned runtime shutdown"
                    )
                harness = DeepSeekHarness(**kwargs)
                with _temporary_process_environment(environment):
                    harness.start()
                session = harness.start_session()
                first_result = None
            else:
                if "error" in outcome:
                    _close_harness(harness)
                    raise outcome["error"]
                first_result = outcome["result"]
            final_outcome: dict[str, Any] = {}

            def finalize() -> None:
                try:
                    final_outcome["result"] = session.run(_FINALIZATION_PROMPT)
                except BaseException as exc:  # noqa: BLE001 - cross-thread transport outcome.
                    final_outcome["error"] = exc

            final_worker = threading.Thread(
                target=finalize,
                name="dsh-owned-finalization-turn",
                daemon=True,
            )
            final_worker.start()
            remaining = max(0.0, config.timeout_seconds - (time.monotonic() - started))
            final_worker.join(remaining)
            if final_worker.is_alive():
                _close_harness(harness)
                final_worker.join(config.shutdown_timeout_seconds)
                raise TimeoutError(
                    "DeepSeek Harness finalization turn exceeded the hard runtime deadline"
                )
            if "error" in final_outcome:
                _close_harness(harness)
                raise final_outcome["error"]
            final_result = final_outcome["result"]
            result = DeepSeekHarnessRunnerResult(
                finish_reason=final_result.finish_reason,
                final_response=final_result.final_response,
                events=(
                    ()
                    if first_result is None
                    else tuple(dict(item) for item in first_result.events)
                )
                + tuple(dict(item) for item in final_result.events),
                notifications=(
                    tuple(observed_notifications)
                    if first_result is None
                    else tuple(
                        _notification_dict(item)
                        for item in first_result.notifications
                    )
                )
                + ({
                    "method": "game-loop.finalization",
                    "payload": {
                        "trigger": "soft-deadline",
                        "cancelled_finish_reason": (
                            "disposed"
                            if first_result is None
                            else first_result.finish_reason
                        ),
                        "session_restarted": finalization_restarted,
                    },
                },)
                + tuple(
                    _notification_dict(item) for item in final_result.notifications
                ),
                session_root=(
                    str(final_result.session_root)
                    if final_result.session_root is not None
                    else (
                        None
                        if first_result is None or first_result.session_root is None
                        else str(first_result.session_root)
                    )
                ),
                model_calls=2,
                finalization_attempted=True,
                finalization_completed=final_result.finish_reason == "completed",
                finalization_restarted=finalization_restarted,
            )
        else:
            if "error" in outcome:
                _close_harness(harness)
                raise outcome["error"]
            sdk_result = outcome["result"]
            result = DeepSeekHarnessRunnerResult(
                finish_reason=sdk_result.finish_reason,
                final_response=sdk_result.final_response,
                events=tuple(dict(item) for item in sdk_result.events),
                notifications=tuple(
                    _notification_dict(item) for item in sdk_result.notifications
                ),
                session_root=(
                    None if sdk_result.session_root is None else str(sdk_result.session_root)
                ),
            )
        try:
            return result
        finally:
            _close_harness(harness)

    def doctor(
        self,
        config: DeepSeekHarnessRuntimeConfig | None = None,
        environment: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        spec = importlib.util.find_spec("deepseek_harness")
        report: dict[str, Any] = {
            "sdk_importable": spec is not None,
            "sdk_module": None if spec is None else spec.origin,
        }
        if spec is None or config is None or environment is None:
            return report
        try:
            from deepseek_harness import DeepSeekHarness

            with tempfile.TemporaryDirectory(prefix="game-loop-dsh-doctor-") as td:
                root = Path(td)
                probe_environment = dict(environment)
                probe_environment.update({
                    "HOME": str(root / "home"),
                    "USERPROFILE": str(root / "home"),
                    "XDG_CONFIG_HOME": str(root / "xdg-config"),
                    "XDG_CACHE_HOME": str(root / "xdg-cache"),
                    "XDG_DATA_HOME": str(root / "xdg-data"),
                    "DSH_HOME": str(root / "home" / ".dsh"),
                })
                harness = DeepSeekHarness(
                    **_sdk_kwargs(config, root, root / "sessions", probe_environment)
                )
                try:
                    with _temporary_process_environment(probe_environment):
                        harness.start()
                finally:
                    _close_harness(harness)
            report["sdk_startup"] = True
        except Exception as exc:  # noqa: BLE001 - readiness report.
            report["sdk_startup"] = False
            report["sdk_startup_error"] = str(exc)
        return report


class DeepSeekHarnessRuntime:
    def __init__(
        self,
        config: DeepSeekHarnessRuntimeConfig,
        *,
        runner: DeepSeekHarnessRunner | None = None,
    ) -> None:
        self.config = config
        self.runner = runner or PythonSDKRunner()

    def doctor(self) -> dict[str, Any]:
        checks: dict[str, Any] = {
            "cordis_is_file": bool(
                self.config.cordis
                and Path(self.config.cordis).expanduser().is_file()
            ),
            "runtime_cwd_is_dir": bool(
                self.config.runtime_cwd
                and Path(self.config.runtime_cwd).expanduser().is_dir()
            ),
        }
        if self.config.skills_source is not None:
            checks["skills_source_is_dir"] = Path(
                self.config.skills_source
            ).expanduser().is_dir()
        if self.config.system_prompt_path is not None:
            checks["system_prompt_path_is_file"] = Path(
                self.config.system_prompt_path
            ).expanduser().is_file()
        if self.config.runtime_bin is not None:
            runtime_bin = Path(self.config.runtime_bin).expanduser()
            checks["runtime_bin_resolves"] = bool(
                runtime_bin.is_file() or shutil.which(self.config.runtime_bin)
            )

        environment = _runtime_base_environment()
        environment.update(self.config.environment)
        provider_report: dict[str, Any] | None = None
        if self.config.backbone_provider is not None:
            provider = load_provider(self.config.backbone_provider)
            resolved = provider.resolve()
            provider_report = resolved.doctor()
            checks["provider_ready"] = bool(provider_report["ready"])
            if resolved.provider_id == "deepseek" and resolved.api_key:
                environment.update({
                    "DEEPSEEK_BASE_URL": resolved.base_url,
                    "DEEPSEEK_API_KEY": resolved.api_key,
                })
            elif resolved.provider_id == "deepseek":
                # initialize/startup does not issue a model request.  A
                # placeholder lets doctor validate the binary and Cordis even
                # when provider readiness correctly remains false.
                environment.update({
                    "DEEPSEEK_BASE_URL": resolved.base_url,
                    "DEEPSEEK_API_KEY": "doctor-readiness-placeholder",
                })
        runner_doctor = getattr(self.runner, "doctor", None)
        runner_checks: dict[str, Any] = {}
        startup_prerequisites_ready = all(
            value for key, value in checks.items() if key != "provider_ready"
        )
        if runner_doctor is not None and startup_prerequisites_ready:
            runner_checks.update(runner_doctor(self.config, environment))
            checks["sdk_importable"] = bool(runner_checks.get("sdk_importable"))
            checks["sdk_startup"] = bool(runner_checks.get("sdk_startup"))
        return {
            "runtime_id": self.config.runtime_id,
            "runtime_type": self.config.runtime_type,
            "runner": type(self.runner).__name__,
            "ok": all(checks.values()),
            "checks": checks,
            "provider": provider_report,
            **runner_checks,
        }

    def run(self, task: GameTask, *, episode_dir: Path) -> GameSubmission:
        system_prompt = _load_system_prompt(self.config)
        run_config = self.config
        isolation = EpisodeIsolation.create(
            episode_dir,
            workspace_seed=(
                None if task.workspace_seed_ref is None else Path(task.workspace_seed_ref)
            ),
            runtime_layout="deepseek-harness",
        )
        atomic_write_json(isolation.root / "task.json", task.to_dict())
        if self.config.skills_source is not None:
            _install_skills(Path(self.config.skills_source), isolation.workspace / ".agents" / "skills")
        dsh_home = isolation.home / ".dsh"
        dsh_home.mkdir(parents=True, exist_ok=True)
        sessions = isolation.root / "sessions"
        sessions.mkdir(parents=True, exist_ok=True)
        environment = isolation.environment(
            _runtime_base_environment(), inherit_process=False
        )
        environment.update(self.config.environment)
        environment.setdefault("GAME_LOOP_PROVIDER_KEY_SALT", task.task_id)
        environment.update({
            "DSH_HOME": str(dsh_home),
            "DSH_SESSION_ROOT": str(sessions),
        })
        if self.config.backbone_provider is not None:
            provider = load_provider(self.config.backbone_provider)
            provider_environment = dict(os.environ)
            provider_environment.update(self.config.environment)
            provider_environment["GAME_LOOP_PROVIDER_KEY_SALT"] = task.task_id
            resolved = provider.resolve(provider_environment)
            if resolved.api_key is None and resolved.requires_credential:
                expected = ", ".join(
                    provider.credential_envs
                )
                raise RuntimeError(
                    f"{self.config.backbone_provider} credential is missing; set one of: {expected}"
                )
            if resolved.provider_id == "deepseek":
                environment.update({
                    "DEEPSEEK_BASE_URL": resolved.base_url,
                    "DEEPSEEK_API_KEY": resolved.api_key or "EMPTY",
                })
                if resolved.route_id == "polaris":
                    run_config = replace(self.config, model=resolved.model)
            else:
                environment = resolved.inject(environment)

        prompt = task.prompt
        if system_prompt:
            prompt = f"{system_prompt.rstrip()}\n\n## Task\n\n{task.prompt}"
        prompt = f"{_deadline_contract(run_config.timeout_seconds)}\n\n{prompt}"
        prompt = (
            "## Runtime workspace authority\n\n"
            f"Your only writable workspace for this episode is `{isolation.workspace}`. "
            "It is also your process current working directory. Use relative paths under "
            "this directory for every read, edit, and command. Ignore any different absolute "
            "workspace, staging, repository, or `/workspace` path that appears later in the "
            "task text; those paths identify an earlier environment and are not submission "
            "output. The required artifact must be changed inside this workspace before you "
            "finish.\n\n"
            f"{prompt}"
        )
        trajectory = TrajectoryRecorder(isolation.root / "trajectory.jsonl")
        trajectory.record("runtime_started", "deepseek-harness", {
            "task_id": task.task_id,
            "benchmark_id": task.benchmark_id,
            "runtime_id": self.config.runtime_id,
        })
        artifact = _workspace_artifact(isolation.workspace, task.artifact_relpath)
        artifact_before = _artifact_digest(artifact)
        error: str | None = None
        try:
            result = self.runner.run(
                prompt,
                cwd=isolation.workspace,
                session_root=sessions,
                config=run_config,
                environment=environment,
            )
        except Exception as exc:  # noqa: BLE001 - normalize runtime failures.
            error = f"DeepSeek Harness failed: {exc}"
            result = DeepSeekHarnessRunnerResult("error", "")
        for event in result.events:
            trajectory.record("session_event", "deepseek-harness", event)
        for notification in result.notifications:
            trajectory.record("notification", "deepseek-harness", notification)

        diagnostics: list[str] = []
        if error:
            diagnostics.append(error)
        if result.finish_reason is None:
            diagnostics.append("DeepSeek Harness did not emit a turn/end finish reason")
        elif result.finish_reason not in run_config.successful_finish_reasons:
            diagnostics.append(f"DeepSeek Harness finish reason: {result.finish_reason}")
        if not _artifact_exists(artifact):
            diagnostics.append(f"expected artifact is missing: {task.artifact_relpath}")
        elif _artifact_digest(artifact) == artifact_before:
            diagnostics.append(
                f"expected artifact was not changed by this episode: {task.artifact_relpath}"
            )
        status = "completed" if not diagnostics else "failed"
        trajectory.record("runtime_finished", "deepseek-harness", {
            "status": status,
            "finish_reason": result.finish_reason,
            "diagnostics": diagnostics,
        })
        usage = _collect_usage(result.events, result.notifications)
        usage["modelCalls"] = result.model_calls
        submission = GameSubmission.create(
            task_id=task.task_id,
            runtime_id=self.config.runtime_id,
            status=status,
            artifact_ref=artifact if status == "completed" else None,
            trajectory_ref=trajectory.path,
            result_text=result.final_response,
            diagnostics=tuple(diagnostics),
            usage=usage,
            metadata={
                "episode_root": str(isolation.root),
                "runtime_config_hash": sha256_json(run_config.to_dict()),
                "finish_reason": result.finish_reason,
                "session_root": result.session_root or str(sessions),
                "provider_route": None if self.config.backbone_provider is None else resolved.route_id,
                "provider_base_url": None if self.config.backbone_provider is None else resolved.base_url,
                "provider_model": run_config.model,
                "finalization_attempted": result.finalization_attempted,
                "finalization_completed": result.finalization_completed,
                "finalization_restarted": result.finalization_restarted,
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


def _deadline_contract(timeout_seconds: int) -> str:
    reserve_seconds = max(15, min(90, timeout_seconds // 10))
    inspection_seconds = max(15, timeout_seconds // 5)
    return (
        "## Hard runtime deadline\n\n"
        f"This session has a hard {timeout_seconds}-second wall-clock limit. "
        f"Finish tool use and send the final response at least {reserve_seconds} seconds "
        "before that limit; work lost to timeout is an infrastructure failure. "
        f"Limit initial inspection and planning to about {inspection_seconds} seconds, "
        "then implement the smallest complete solution that satisfies the task. "
        "Avoid exhaustive asset enumeration and repeated long tests. Prioritize a "
        "launchable, changed artifact, then use remaining time for bounded verification."
    )


def _load_system_prompt(config: DeepSeekHarnessRuntimeConfig) -> str | None:
    prompt = config.system_prompt
    if config.system_prompt_path is not None:
        path = Path(config.system_prompt_path).expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError(f"system_prompt_path does not exist: {path}")
        prompt = path.read_text(encoding="utf-8")
    if prompt is not None:
        for placeholder, replacement in config.system_prompt_variables.items():
            prompt = prompt.replace(placeholder, replacement)
    return prompt


def _install_skills(source: Path, destination: Path) -> None:
    source = source.expanduser().resolve()
    if not source.is_dir():
        raise ValueError(f"skills_source must be a directory: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if (source / "router" / "SKILL.md").is_file() and (source / "skills").is_dir():
        from game_loop.baselines.awesome_gamedev_skills import materialize_skills_source

        materialize_skills_source(source, destination)
        return
    shutil.copytree(source, destination)


def _notification_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    return {
        "method": str(getattr(value, "method", "")),
        "payload": dict(getattr(value, "payload", {})),
    }


def _collect_usage(
    events: Sequence[Mapping[str, Any]],
    notifications: Sequence[Mapping[str, Any]] = (),
) -> dict[str, Any]:
    # DSH can persist the same provider report first as an assistant/chunk and
    # later as the assembled assistant/message. Keep only the last carrier for
    # each model step, while retaining unscoped usage such as compaction calls.
    by_step: dict[tuple[str, int, int], Mapping[str, Any]] = {}
    unscoped: dict[tuple[str, str], Mapping[str, Any]] = {}
    carriers: list[tuple[str, Mapping[str, Any]]] = []
    notification_event_signatures: set[str] = set()
    notification_sessions: dict[str, str] = {}
    for notification in notifications:
        if notification.get("method") != "session.event":
            continue
        payload = notification.get("payload")
        if not isinstance(payload, Mapping):
            payload = notification.get("params")
        if not isinstance(payload, Mapping):
            continue
        event = payload.get("event")
        if not isinstance(event, Mapping):
            continue
        session_id = str(payload.get("sessionId", "notification-session"))
        carriers.append((session_id, event))
        signature = json.dumps(
            event, sort_keys=True, separators=(",", ":"), default=str
        )
        notification_event_signatures.add(signature)
        notification_sessions[signature] = session_id
    root_session_id = next(
        (
            notification_sessions[signature]
            for event in events
            if (signature := json.dumps(
                event, sort_keys=True, separators=(",", ":"), default=str
            )) in notification_sessions
        ),
        "root-session",
    )
    for event in events:
        signature = json.dumps(event, sort_keys=True, separators=(",", ":"), default=str)
        if signature not in notification_event_signatures:
            carriers.append((root_session_id, event))

    for session_id, event in carriers:
        data = event.get("data")
        if not isinstance(data, Mapping):
            continue
        usage = data.get("usage")
        chunk = data.get("chunk")
        if (
            not isinstance(usage, Mapping)
            and isinstance(chunk, Mapping)
            and chunk.get("type") == "usage"
        ):
            usage = chunk.get("usage")
        if not isinstance(usage, Mapping):
            continue
        turn = data.get("turn")
        step = data.get("step")
        if isinstance(turn, int) and isinstance(step, int):
            by_step[(session_id, turn, step)] = usage
        else:
            signature = json.dumps(usage, sort_keys=True, separators=(",", ":"), default=str)
            unscoped[(session_id, signature)] = usage

    canonical_keys = {
        "inputtokens": "inputTokens",
        "prompttokens": "inputTokens",
        "outputtokens": "outputTokens",
        "completiontokens": "outputTokens",
        "totaltokens": "totalTokens",
        "cachereadtokens": "cacheReadTokens",
        "cachehittokens": "cacheReadTokens",
        "cachewritetokens": "cacheWriteTokens",
        "cachemisstokens": "cacheWriteTokens",
        "reasoningtokens": "reasoningTokens",
    }
    totals: dict[str, float] = {}
    for usage in (*by_step.values(), *unscoped.values()):
        for key, item in usage.items():
            normalized = str(key).replace("_", "").casefold()
            canonical = canonical_keys.get(normalized)
            if canonical is not None and isinstance(item, (int, float)):
                totals[canonical] = totals.get(canonical, 0.0) + float(item)
    return {
        key: int(value) if value.is_integer() else value
        for key, value in totals.items()
    }


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
    if not artifact.is_dir():
        return False
    ignored = {".qwen", ".dsh", ".agents"}
    return any(
        path.is_file() and not ignored.intersection(path.relative_to(artifact).parts)
        for path in artifact.rglob("*")
    )


def _artifact_digest(artifact: Path) -> str | None:
    if not artifact.exists():
        return None
    digest = hashlib.sha256()
    ignored = {".qwen", ".dsh", ".agents"}
    paths = [artifact] if artifact.is_file() else sorted(artifact.rglob("*"))
    for path in paths:
        relative = Path(path.name) if artifact.is_file() else path.relative_to(artifact)
        if ignored.intersection(relative.parts) or not path.is_file():
            continue
        digest.update(relative.as_posix().encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def _runtime_base_environment() -> dict[str, str]:
    # The selected provider credential is injected separately.  Keep unrelated
    # launcher secrets out of both the runtime and model-facing Bash tools.
    allowed = {
        "COMSPEC",
        "LANG",
        "LC_ALL",
        "NODE_PATH",
        "PATH",
        "PATHEXT",
        "SHELL",
        "SSL_CERT_DIR",
        "SSL_CERT_FILE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
    }
    return {key: value for key, value in os.environ.items() if key in allowed}


def _sdk_kwargs(
    config: DeepSeekHarnessRuntimeConfig,
    cwd: Path,
    session_root: Path,
    environment: Mapping[str, str],
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "provider": config.provider,
        "model": config.model,
        "max_tokens": config.max_tokens,
        "cwd": str(cwd),
        "runtime_cwd": config.runtime_cwd,
        "session_root": str(session_root),
        "cordis": config.cordis,
        "env": dict(environment),
        "request_timeout_seconds": float(config.timeout_seconds),
        "shutdown_timeout_seconds": config.shutdown_timeout_seconds,
    }
    if config.runtime_bin is not None:
        kwargs["runtime_bin"] = config.runtime_bin
    if config.launch_args_override:
        kwargs["launch_args_override"] = config.launch_args_override
    return kwargs


def _close_harness(harness: Any) -> None:
    # rc.7 reaps the process but leaves its stdout/stderr wrappers open.  Keep
    # the adapter leak-free across long multi-episode evolution runs.
    client = getattr(harness, "client", None)
    process = getattr(client, "_proc", None)
    harness.close()
    if process is None:
        return
    for name in ("stdout", "stderr"):
        stream = getattr(process, name, None)
        if stream is not None and not stream.closed:
            stream.close()


@contextmanager
def _temporary_process_environment(environment: Mapping[str, str]):
    with _PROCESS_ENVIRONMENT_LOCK:
        original = dict(os.environ)
        os.environ.clear()
        os.environ.update(environment)
        try:
            yield
        finally:
            os.environ.clear()
            os.environ.update(original)
