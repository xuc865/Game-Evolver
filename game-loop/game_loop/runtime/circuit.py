from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any

from game_loop.core.agent_circuit import validate_workspace_lineage
from game_loop.core.agent_circuit_runtime import (
    CIRCUIT_RUNTIME_ROOTS,
    AgentCircuitExecutor,
    FilesystemCircuitWorkspaceManager,
)
from game_loop.runtime.deepseek_circuit import DeepSeekCircuitRoleRunner
from game_loop.runtime.deepseek_harness import (
    DeepSeekHarnessRunner,
    DeepSeekHarnessRuntime,
    DeepSeekHarnessRuntimeConfig,
)
from game_loop.runtime.protocol import GameSubmission, GameTask
from game_loop.utils import atomic_write_json


class DeepSeekCircuitRuntime:
    """MakerRuntime that executes an explicit v0.3 GOA Agent Circuit."""

    def __init__(
        self,
        config: DeepSeekHarnessRuntimeConfig,
        *,
        runner: DeepSeekHarnessRunner | None = None,
    ):
        if config.agent_circuit is None:
            raise ValueError("DeepSeekCircuitRuntime requires agent_circuit")
        self.config = config
        self.runner = runner

    def doctor(self) -> dict[str, Any]:
        base = DeepSeekHarnessRuntime(self.config, runner=self.runner).doctor()
        circuit = self.config.agent_circuit
        assert circuit is not None
        checks = dict(base["checks"])
        lineage_error: str | None = None
        try:
            validate_workspace_lineage(circuit)
        except ValueError as exc:
            lineage_error = str(exc)
        checks.update(
            {
                "agent_circuit_valid": True,
                "agent_circuit_workspace_lineage_valid": lineage_error is None,
                "agent_circuit_has_roles": bool(circuit.roles),
                "agent_circuit_budget_valid": (
                    sum(item.budget.max_model_calls for item in circuit.roles)
                    <= circuit.policy.max_total_model_calls
                ),
            }
        )
        role_runner = DeepSeekCircuitRoleRunner(self.config, runner=self.runner)
        role_harnesses: dict[str, Any] = {}
        with tempfile.TemporaryDirectory(prefix="game-loop-circuit-doctor-") as td:
            root = Path(td)
            for role in circuit.roles:
                report = role_runner.doctor_role(
                    role,
                    workspace=root / role.role_id,
                )
                role_harnesses[role.role_id] = report
                checks[f"role_{role.role_id}_sdk_startup"] = bool(report["ok"])
        return {
            **base,
            "runtime_id": f"{self.config.runtime_id}-circuit",
            "runner": type(self).__name__,
            "ok": all(checks.values()),
            "checks": checks,
            "agent_circuit": {
                "circuit_id": circuit.circuit_id,
                "roles": len(circuit.roles),
                "edges": len(circuit.edges),
                "max_parallel_roles": circuit.policy.max_parallel_roles,
                "role_harnesses": role_harnesses,
                "workspace_lineage_error": lineage_error,
            },
        }

    def run(self, task: GameTask, *, episode_dir: Path) -> GameSubmission:
        circuit = self.config.agent_circuit
        assert circuit is not None
        validate_workspace_lineage(circuit)
        episode_dir = episode_dir.resolve()
        episode_dir.mkdir(parents=True, exist_ok=True)
        source = episode_dir / "source"
        if source.exists():
            shutil.rmtree(source)
        if task.workspace_seed_ref is None:
            source.mkdir()
        else:
            seed = Path(task.workspace_seed_ref).expanduser().resolve()
            if not seed.is_dir():
                raise ValueError(f"circuit workspace seed is not a directory: {seed}")
            shutil.copytree(
                seed,
                source,
                symlinks=True,
                ignore=shutil.ignore_patterns(*CIRCUIT_RUNTIME_ROOTS),
            )
        executor = AgentCircuitExecutor(
            runner=DeepSeekCircuitRoleRunner(self.config, runner=self.runner),
            workspace_manager=FilesystemCircuitWorkspaceManager(
                source_workspace=source,
                run_root=episode_dir / "circuit",
                shared=circuit.policy.workspace_mode == "shared",
            ),
        )
        result = executor.run(circuit, task=task.prompt)
        run_path = episode_dir / "circuit_run.json"
        atomic_write_json(run_path, result.to_dict())
        artifact_source = self._select_artifact_workspace(
            task=task,
            result=result,
        )
        artifact_target: Path | None = None
        diagnostics = list(result.reasons)
        if result.status == "completed" and artifact_source is not None:
            artifact_target = episode_dir / "artifact"
            if artifact_target.exists():
                if artifact_target.is_dir():
                    shutil.rmtree(artifact_target)
                else:
                    artifact_target.unlink()
            if artifact_source.is_dir():
                shutil.copytree(
                    artifact_source,
                    artifact_target,
                    symlinks=True,
                    ignore=shutil.ignore_patterns(*CIRCUIT_RUNTIME_ROOTS),
                )
            else:
                artifact_target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(artifact_source, artifact_target)
        elif result.status == "completed":
            diagnostics.append(
                f"agent circuit completed without artifact: {task.artifact_relpath}"
            )
        status = "completed" if artifact_target is not None and not diagnostics else "failed"
        submission = GameSubmission.create(
            task_id=task.task_id,
            runtime_id=f"{self.config.runtime_id}-circuit",
            status=status,
            artifact_ref=artifact_target if status == "completed" else None,
            trajectory_ref=run_path,
            result_text=self._terminal_summary(result),
            diagnostics=tuple(diagnostics),
            usage={
                "modelCalls": result.model_calls,
                "totalTokens": result.tokens,
                "costUnits": result.cost_units,
                "elapsedSeconds": result.elapsed_seconds,
            },
            metadata={
                "agent_circuit_id": circuit.circuit_id,
                "agent_roles": list(result.role_attempts),
                "role_attempts": result.role_attempts,
                "infrastructure_ok": result.infrastructure_ok,
                "provider_routes": {
                    item.role_id: {
                        "route": item.provider_route,
                        "base_url": item.provider_base_url,
                        "model": item.provider_model,
                    }
                    for item in result.role_results
                },
            },
        )
        atomic_write_json(episode_dir / "submission.json", submission.to_dict())
        return submission

    @staticmethod
    def _select_artifact_workspace(*, task: GameTask, result) -> Path | None:
        preferred_roles = [
            item.role_id
            for item in reversed(result.role_results)
            if item.status == "completed"
            and any(
                artifact.metadata.get("workspace_snapshot") is True
                for artifact in item.artifacts
            )
        ]
        for role_id in preferred_roles:
            workspace = result.role_workspaces.get(role_id)
            if workspace is None:
                continue
            artifact = (Path(workspace) / task.artifact_relpath).resolve()
            if artifact.exists():
                return artifact
        return None

    @staticmethod
    def _terminal_summary(result) -> str:
        summaries = [
            item.summary
            for item in result.role_results
            if item.role_id in result.terminal_role_ids and item.status == "completed"
        ]
        return summaries[-1] if summaries else ""
