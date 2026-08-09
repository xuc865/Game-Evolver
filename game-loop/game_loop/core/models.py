from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from game_loop.utils import utc_now


@dataclass
class EvaluationResult:
    """Normalized observation emitted by any benchmark evaluator."""

    primary_score: float | None
    feasible: bool
    objectives: dict[str, float] = field(default_factory=dict)
    constraints: dict[str, bool] = field(default_factory=dict)
    diagnostics: list[str] = field(default_factory=list)
    evaluator: dict[str, Any] = field(default_factory=dict)
    uncertainty: dict[str, Any] = field(default_factory=dict)
    cost: dict[str, Any] = field(default_factory=dict)
    terminal_success: bool = False
    raw_result_ref: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "EvaluationResult":
        score = value.get("primary_score")
        return cls(
            primary_score=None if score is None else float(score),
            feasible=bool(value.get("feasible", False)),
            objectives={str(k): float(v) for k, v in value.get("objectives", {}).items()},
            constraints={str(k): bool(v) for k, v in value.get("constraints", {}).items()},
            diagnostics=[str(v) for v in value.get("diagnostics", [])],
            evaluator=dict(value.get("evaluator", {})),
            uncertainty=dict(value.get("uncertainty", {})),
            cost=dict(value.get("cost", {})),
            terminal_success=bool(value.get("terminal_success", False)),
            raw_result_ref=value.get("raw_result_ref"),
        )


@dataclass(frozen=True)
class MutationIntent:
    """Benchmark-independent reason for asking the frozen agent to mutate an artifact."""

    kind: str
    target: str | None
    rationale: str
    preserve: tuple[str, ...] = ()
    exploration: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class GateResult:
    passed: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    stats: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ArtifactDescriptor:
    kind: str
    ignore_patterns: tuple[str, ...] = ()
    component_patterns: dict[str, tuple[str, ...]] = field(default_factory=dict)


@dataclass
class ArtifactRecord:
    artifact_id: str
    artifact_hash: str
    payload_hash: str
    component_hashes: dict[str, str]
    artifact_kind: str
    file_count: int
    total_bytes: int
    relative_path: str
    created_at: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ArtifactRecord":
        return cls(**value)


@dataclass(frozen=True)
class AttemptContext:
    run_id: str
    generation: int
    candidate_index: int


@dataclass
class PreparedTask:
    adapter_id: str
    root_dir: Path
    command_context: dict[str, str]
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class BackendExecution:
    return_code: int
    log_path: Path
    error: str | None = None


@dataclass
class CandidateResult:
    artifact_dir: Path | None
    evaluation: EvaluationResult | None
    error: str | None = None
    evaluator_queries: int = 0


@dataclass
class ProbeResult:
    probe_id: str
    status: str
    passed: bool | None
    score: float | None
    return_code: int | None
    duration_seconds: float
    log_path: str
    diagnostics: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ProbeSuiteResult:
    phase: str
    results: list[ProbeResult]
    calls: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "phase": self.phase,
            "calls": self.calls,
            "results": [result.to_dict() for result in self.results],
        }

    @property
    def infrastructure_ok(self) -> bool:
        return all(result.status == "completed" for result in self.results)


@dataclass
class AttemptRecord:
    attempt_id: str
    generation: int
    candidate_index: int
    parent_artifact_id: str
    artifact_id: str | None
    status: str
    primary_score: float | None
    score_delta: float | None
    intent_kind: str
    accepted: bool
    reasons: list[str]
    objectives: dict[str, float]
    diagnostics: list[str]
    candidate_dir: str
    mutation_intent: dict[str, Any] = field(default_factory=dict)
    probe_summary: dict[str, Any] = field(default_factory=dict)
    parent_harness_id: str | None = None
    harness_id: str | None = None
    harness_modules: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "AttemptRecord":
        return cls(**value)


@dataclass
class RunState:
    schema_version: str
    run_id: str
    benchmark_id: str
    status: str
    seed_artifact_id: str
    champion_artifact_id: str
    champion_evaluation: dict[str, Any]
    next_generation: int = 1
    next_candidate: int = 1
    generation_parent_artifact_id: str | None = None
    consecutive_rejections: int = 0
    attempts: list[dict[str, Any]] = field(default_factory=list)
    model_calls: int = 0
    evaluator_queries: int = 0
    evaluator_attempts: int = 0
    infrastructure_failures: int = 0
    probe_calls: int = 0
    seed_harness_id: str | None = None
    champion_harness_id: str | None = None
    harness_mutations: int = 0
    stop_reason: str | None = None
    updated_at: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "RunState":
        return cls(**value)

    @property
    def champion_result(self) -> EvaluationResult:
        return EvaluationResult.from_dict(self.champion_evaluation)
