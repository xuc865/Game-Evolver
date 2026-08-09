from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence

from game_loop.benchmarks.base import BenchmarkAdapter
from game_loop.core.models import AttemptContext, EvaluationResult, PreparedTask
from game_loop.runtime.opengame import OpenGameRunner, OpenGameRuntime, OpenGameRuntimeConfig
from game_loop.runtime.protocol import GameEvaluation, GameSubmission, GameTask
from game_loop.utils import atomic_write_json


class BenchmarkEvaluatorRunner(Protocol):
    """Runs a benchmark-owned evaluator and returns its official result file."""

    def evaluate(
        self,
        *,
        adapter: BenchmarkAdapter,
        prepared: PreparedTask,
        task: GameTask,
        submission: GameSubmission,
        output_dir: Path,
    ) -> Path | EvaluationResult: ...


@dataclass(frozen=True)
class CommandEvaluatorProfile:
    command: tuple[str, ...]
    result_path: str
    cwd: str | None = None
    environment: dict[str, str] | None = None
    timeout_seconds: int = 3600

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "CommandEvaluatorProfile":
        command = tuple(str(item) for item in value.get("command", []))
        if not command:
            raise ValueError("evaluator command is required")
        return cls(
            command=command,
            result_path=str(value["result_path"]),
            cwd=None if value.get("cwd") is None else str(value["cwd"]),
            environment={str(k): str(v) for k, v in value.get("environment", {}).items()},
            timeout_seconds=int(value.get("timeout_seconds", 3600)),
        )


class CommandEvaluatorRunner:
    def __init__(self, profile: CommandEvaluatorProfile):
        self.profile = profile

    def evaluate(
        self,
        *,
        adapter: BenchmarkAdapter,
        prepared: PreparedTask,
        task: GameTask,
        submission: GameSubmission,
        output_dir: Path,
    ) -> Path:
        output_dir.mkdir(parents=True, exist_ok=True)
        context = {
            "benchmark_id": task.benchmark_id,
            "task_source": str(Path(task.task_source_ref).resolve()),
            "artifact_path": str(Path(submission.artifact_ref or "").resolve()),
            "prepared_root": str(prepared.root_dir.resolve()),
            "output_dir": str(output_dir.resolve()),
        }
        command = [part.format_map(context) for part in self.profile.command]
        cwd = (
            output_dir
            if self.profile.cwd is None
            else Path(self.profile.cwd.format_map(context)).resolve()
        )
        log_path = output_dir / "evaluator.log"
        env = dict(os.environ)
        env.update(self.profile.environment or {})
        with log_path.open("wb") as log:
            completed = subprocess.run(
                command,
                cwd=cwd,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=self.profile.timeout_seconds,
                check=False,
            )
        if completed.returncode != 0:
            raise RuntimeError(
                f"benchmark evaluator failed with return code {completed.returncode}; log={log_path}"
            )
        result_path = Path(self.profile.result_path.format_map(context))
        if not result_path.is_absolute():
            result_path = output_dir / result_path
        if not result_path.is_file():
            raise RuntimeError(f"benchmark evaluator result is missing: {result_path}")
        return result_path.resolve()


@dataclass(frozen=True)
class InnerLoopResult:
    task: GameTask
    prepared: PreparedTask
    submission: GameSubmission
    evaluation: GameEvaluation | None


class InnerLoopPipeline:
    """One shared adapter → OpenGame → official evaluator execution path."""

    def __init__(
        self,
        *,
        adapter: BenchmarkAdapter,
        runtime_config: OpenGameRuntimeConfig,
        maker_runner: OpenGameRunner | None = None,
        evaluator_runner: BenchmarkEvaluatorRunner | None = None,
    ):
        self.adapter = adapter
        self.runtime = OpenGameRuntime(runtime_config, runner=maker_runner)
        self.evaluator_runner = evaluator_runner

    def run(
        self,
        task: GameTask,
        *,
        run_dir: Path,
        feedback: Mapping[str, Any] | None = None,
        context: AttemptContext | None = None,
    ) -> InnerLoopResult:
        run_dir = run_dir.resolve()
        run_dir.mkdir(parents=True, exist_ok=True)
        atomic_write_json(run_dir / "task.json", task.to_dict())
        if task.workspace_seed_ref is None:
            raise ValueError("InnerLoopPipeline requires task.workspace_seed_ref")
        prepared = self.adapter.prepare(
            task_source=Path(task.task_source_ref),
            parent_artifact=Path(task.workspace_seed_ref),
            feedback=dict(feedback or {}),
            candidate_dir=run_dir / "prepared",
            context=context or AttemptContext(task.task_id, 1, 1),
        )
        agent_cwd, artifact_relpath = _prepared_workspace_contract(prepared)
        maker_task = GameTask(
            task_id=task.task_id,
            benchmark_id=task.benchmark_id,
            prompt=_prepared_prompt(prepared, fallback=task.prompt),
            task_source_ref=task.task_source_ref,
            workspace_seed_ref=str(agent_cwd),
            artifact_relpath=artifact_relpath,
            constraints=dict(task.constraints),
            metadata={**task.metadata, "adapter_id": prepared.adapter_id},
        )
        submission = self.runtime.run(maker_task, episode_dir=run_dir / "maker")
        evaluation: GameEvaluation | None = None
        if submission.status == "completed" and self.evaluator_runner is not None:
            raw = self.evaluator_runner.evaluate(
                adapter=self.adapter,
                prepared=prepared,
                task=task,
                submission=submission,
                output_dir=run_dir / "evaluator",
            )
            core = raw if isinstance(raw, EvaluationResult) else self.adapter.parse_evaluation(raw)
            evaluation = GameEvaluation.from_core(
                core,
                task_id=task.task_id,
                submission_id=submission.submission_id,
            )
            atomic_write_json(run_dir / "evaluation.json", evaluation.to_dict())
        result = InnerLoopResult(task, prepared, submission, evaluation)
        atomic_write_json(run_dir / "inner_loop_manifest.json", {
            "schema_version": "game-agent.inner-loop-run.v1",
            "task_ref": str(run_dir / "task.json"),
            "maker_task_ref": str(run_dir / "maker" / "task.json"),
            "submission_ref": str(run_dir / "maker" / "submission.json"),
            "evaluation_ref": None if evaluation is None else str(run_dir / "evaluation.json"),
            "adapter_id": prepared.adapter_id,
        })
        return result


def _prepared_prompt(prepared: PreparedTask, *, fallback: str) -> str:
    for key in ("instruction_file", "extra_instruction"):
        value = prepared.command_context.get(key)
        if value and Path(value).is_file():
            return Path(value).read_text(encoding="utf-8")
    for name in ("evolution_directive.md", "instruction.md"):
        path = prepared.root_dir / name
        if path.is_file():
            return path.read_text(encoding="utf-8")
    return fallback


def _prepared_workspace_contract(prepared: PreparedTask) -> tuple[Path, str]:
    missing = [
        key for key in ("agent_cwd", "artifact_path")
        if not prepared.command_context.get(key)
    ]
    if missing:
        raise ValueError(
            f"adapter {prepared.adapter_id} is missing OpenGame workspace fields: {missing}"
        )
    agent_cwd = Path(prepared.command_context["agent_cwd"]).resolve()
    artifact = Path(prepared.command_context["artifact_path"]).resolve()
    if not agent_cwd.is_dir():
        raise ValueError(f"adapter agent_cwd is not a directory: {agent_cwd}")
    try:
        relative = artifact.relative_to(agent_cwd).as_posix() or "."
    except ValueError as exc:
        raise ValueError("adapter artifact_path must stay within agent_cwd") from exc
    return agent_cwd, relative
