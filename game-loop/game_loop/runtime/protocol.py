from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

from game_loop.core.models import EvaluationResult
from game_loop.utils import sha256_json, utc_now


TASK_SCHEMA = "game-agent.task.v1"
SUBMISSION_SCHEMA = "game-agent.submission.v1"
EVALUATION_SCHEMA = "game-agent.evaluation.v1"


def _relative_artifact_path(value: str) -> str:
    path = PurePosixPath(value or ".")
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("artifact_relpath must stay within the episode workspace")
    return path.as_posix()


@dataclass(frozen=True)
class GameTask:
    """Benchmark-neutral input contract for one game-making episode."""

    task_id: str
    benchmark_id: str
    prompt: str
    task_source_ref: str
    workspace_seed_ref: str | None = None
    artifact_relpath: str = "."
    constraints: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    schema_version: str = TASK_SCHEMA

    def __post_init__(self) -> None:
        if self.schema_version != TASK_SCHEMA:
            raise ValueError(f"unsupported task schema: {self.schema_version}")
        if not self.task_id or not self.benchmark_id or not self.prompt.strip():
            raise ValueError("task_id, benchmark_id, and prompt are required")
        object.__setattr__(self, "artifact_relpath", _relative_artifact_path(self.artifact_relpath))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "GameTask":
        return cls(
            task_id=str(value["task_id"]),
            benchmark_id=str(value["benchmark_id"]),
            prompt=str(value["prompt"]),
            task_source_ref=str(value["task_source_ref"]),
            workspace_seed_ref=(
                None
                if value.get("workspace_seed_ref") is None
                else str(value["workspace_seed_ref"])
            ),
            artifact_relpath=str(value.get("artifact_relpath", ".")),
            constraints=dict(value.get("constraints", {})),
            metadata=dict(value.get("metadata", {})),
            schema_version=str(value.get("schema_version", TASK_SCHEMA)),
        )


@dataclass(frozen=True)
class GameSubmission:
    """Normalized artifact and trajectory produced by a game-making runtime."""

    submission_id: str
    task_id: str
    runtime_id: str
    status: str
    artifact_ref: str | None
    trajectory_ref: str
    result_text: str = ""
    diagnostics: tuple[str, ...] = ()
    usage: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=utc_now)
    schema_version: str = SUBMISSION_SCHEMA

    def __post_init__(self) -> None:
        if self.schema_version != SUBMISSION_SCHEMA:
            raise ValueError(f"unsupported submission schema: {self.schema_version}")
        if self.status not in {"completed", "failed"}:
            raise ValueError("submission status must be completed or failed")
        if self.status == "completed" and not self.artifact_ref:
            raise ValueError("completed submission requires artifact_ref")

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["diagnostics"] = list(self.diagnostics)
        return value

    @classmethod
    def create(
        cls,
        *,
        task_id: str,
        runtime_id: str,
        status: str,
        artifact_ref: Path | None,
        trajectory_ref: Path,
        result_text: str = "",
        diagnostics: tuple[str, ...] = (),
        usage: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> "GameSubmission":
        payload = {
            "task_id": task_id,
            "runtime_id": runtime_id,
            "status": status,
            "artifact_ref": None if artifact_ref is None else str(artifact_ref.resolve()),
            "trajectory_ref": str(trajectory_ref.resolve()),
            "result_text": result_text,
            "diagnostics": list(diagnostics),
            "usage": usage or {},
            "metadata": metadata or {},
        }
        return cls(
            submission_id="submission-" + sha256_json(payload)[:16],
            task_id=task_id,
            runtime_id=runtime_id,
            status=status,
            artifact_ref=payload["artifact_ref"],
            trajectory_ref=payload["trajectory_ref"],
            result_text=result_text,
            diagnostics=diagnostics,
            usage=usage or {},
            metadata=metadata or {},
        )

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "GameSubmission":
        return cls(
            submission_id=str(value["submission_id"]),
            task_id=str(value["task_id"]),
            runtime_id=str(value["runtime_id"]),
            status=str(value["status"]),
            artifact_ref=(None if value.get("artifact_ref") is None else str(value["artifact_ref"])),
            trajectory_ref=str(value["trajectory_ref"]),
            result_text=str(value.get("result_text", "")),
            diagnostics=tuple(str(item) for item in value.get("diagnostics", [])),
            usage=dict(value.get("usage", {})),
            metadata=dict(value.get("metadata", {})),
            created_at=str(value.get("created_at", "")),
            schema_version=str(value.get("schema_version", SUBMISSION_SCHEMA)),
        )


@dataclass(frozen=True)
class GameEvaluation:
    """Stable envelope around a benchmark-owned evaluation result."""

    evaluation_id: str
    task_id: str
    submission_id: str
    primary_score: float | None
    feasible: bool
    objectives: dict[str, float] = field(default_factory=dict)
    constraints: dict[str, bool] = field(default_factory=dict)
    diagnostics: tuple[str, ...] = ()
    evaluator: dict[str, Any] = field(default_factory=dict)
    uncertainty: dict[str, Any] = field(default_factory=dict)
    cost: dict[str, Any] = field(default_factory=dict)
    terminal_success: bool = False
    raw_result_ref: str | None = None
    created_at: str = field(default_factory=utc_now)
    schema_version: str = EVALUATION_SCHEMA

    def __post_init__(self) -> None:
        if self.schema_version != EVALUATION_SCHEMA:
            raise ValueError(f"unsupported evaluation schema: {self.schema_version}")

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["diagnostics"] = list(self.diagnostics)
        return value

    @classmethod
    def from_core(
        cls,
        result: EvaluationResult,
        *,
        task_id: str,
        submission_id: str,
    ) -> "GameEvaluation":
        payload = {
            "task_id": task_id,
            "submission_id": submission_id,
            **result.to_dict(),
        }
        return cls(
            evaluation_id="evaluation-" + sha256_json(payload)[:16],
            task_id=task_id,
            submission_id=submission_id,
            primary_score=result.primary_score,
            feasible=result.feasible,
            objectives=dict(result.objectives),
            constraints=dict(result.constraints),
            diagnostics=tuple(result.diagnostics),
            evaluator=dict(result.evaluator),
            uncertainty=dict(result.uncertainty),
            cost=dict(result.cost),
            terminal_success=result.terminal_success,
            raw_result_ref=result.raw_result_ref,
        )

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "GameEvaluation":
        score = value.get("primary_score")
        return cls(
            evaluation_id=str(value["evaluation_id"]),
            task_id=str(value["task_id"]),
            submission_id=str(value["submission_id"]),
            primary_score=None if score is None else float(score),
            feasible=bool(value.get("feasible", False)),
            objectives={str(k): float(v) for k, v in value.get("objectives", {}).items()},
            constraints={str(k): bool(v) for k, v in value.get("constraints", {}).items()},
            diagnostics=tuple(str(item) for item in value.get("diagnostics", [])),
            evaluator=dict(value.get("evaluator", {})),
            uncertainty=dict(value.get("uncertainty", {})),
            cost=dict(value.get("cost", {})),
            terminal_success=bool(value.get("terminal_success", False)),
            raw_result_ref=(
                None if value.get("raw_result_ref") is None else str(value["raw_result_ref"])
            ),
            created_at=str(value.get("created_at", "")),
            schema_version=str(value.get("schema_version", EVALUATION_SCHEMA)),
        )

    def to_core(self) -> EvaluationResult:
        return EvaluationResult(
            primary_score=self.primary_score,
            feasible=self.feasible,
            objectives=dict(self.objectives),
            constraints=dict(self.constraints),
            diagnostics=list(self.diagnostics),
            evaluator=dict(self.evaluator),
            uncertainty=dict(self.uncertainty),
            cost=dict(self.cost),
            terminal_success=self.terminal_success,
            raw_result_ref=self.raw_result_ref,
        )
