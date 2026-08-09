from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Sequence

from game_loop.config import AppConfig
from game_loop.core.episode_runner import run_frozen_harness_episode
from game_loop.core.harness import (
    HarnessEvolutionEngine,
    HarnessProfile,
    load_episode_outcome,
)
from game_loop.core.harness_rubric_validator import TaskPoolEntry, load_task_pool
from game_loop.utils import atomic_write_json, read_json, utc_now


@dataclass(frozen=True)
class BenchLoopState:
    schema_version: str = "harness-bench-loop.v1"
    bench: str = ""
    task_index: int = 0
    completed_tasks: tuple[str, ...] = ()
    current_harness_id: str | None = None
    last_run_ref: str | None = None
    last_official_score: float | None = None
    updated_at: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "bench": self.bench,
            "task_index": self.task_index,
            "completed_tasks": list(self.completed_tasks),
            "current_harness_id": self.current_harness_id,
            "last_run_ref": self.last_run_ref,
            "last_official_score": self.last_official_score,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "BenchLoopState":
        return cls(
            schema_version=str(value.get("schema_version", "harness-bench-loop.v1")),
            bench=str(value.get("bench", "")),
            task_index=int(value.get("task_index", 0)),
            completed_tasks=tuple(str(item) for item in value.get("completed_tasks", [])),
            current_harness_id=value.get("current_harness_id"),
            last_run_ref=value.get("last_run_ref"),
            last_official_score=(
                None
                if value.get("last_official_score") is None
                else float(value["last_official_score"])
            ),
            updated_at=str(value.get("updated_at", utc_now())),
        )


@dataclass(frozen=True)
class BenchLoopStepResult:
    task: TaskPoolEntry
    task_index: int
    run_ref: str
    official_score: float | None
    feasible: bool
    harness_id: str
    advanced: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "task": {
                "task_ref": self.task.task_ref,
                "seed_artifact_ref": self.task.seed_artifact_ref,
                "seed_score": self.task.seed_score,
            },
            "task_index": self.task_index,
            "run_ref": self.run_ref,
            "official_score": self.official_score,
            "feasible": self.feasible,
            "harness_id": self.harness_id,
            "advanced": self.advanced,
        }


class HarnessBenchLoopRunner:
    """Closed-loop runner: finish one task, advance queue, carry harness forward."""

    def __init__(
        self,
        *,
        loop_dir: Path,
        config: AppConfig,
        task_pool: Sequence[TaskPoolEntry],
        harness_engine: HarnessEvolutionEngine,
        init_handler: Callable[..., Any],
        evolve_handler: Callable[..., Any],
        bench: str,
    ):
        self.loop_dir = loop_dir.resolve()
        self.config = config
        self.task_pool = tuple(task_pool)
        self.harness_engine = harness_engine
        self.init_handler = init_handler
        self.evolve_handler = evolve_handler
        self.bench = bench
        self.state_path = self.loop_dir / "bench_loop_state.json"
        self.runs_root = self.loop_dir / "task_runs"

    def initialize(self) -> BenchLoopState:
        self.loop_dir.mkdir(parents=True, exist_ok=True)
        champion = self.harness_engine.champion()
        state = BenchLoopState(
            bench=self.bench,
            task_index=0,
            current_harness_id=champion.harness_id,
        )
        atomic_write_json(self.state_path, state.to_dict())
        return state

    def load_state(self) -> BenchLoopState:
        if not self.state_path.is_file():
            raise RuntimeError("bench loop is not initialized")
        return BenchLoopState.from_dict(read_json(self.state_path))

    def current_task(self, state: BenchLoopState) -> TaskPoolEntry:
        if not self.task_pool:
            raise RuntimeError("task pool is empty")
        index = state.task_index % len(self.task_pool)
        return self.task_pool[index]

    def run_step(self, *, run_id_prefix: str = "loop") -> BenchLoopStepResult:
        state = self.load_state()
        task = self.current_task(state)
        harness = self.harness_engine.champion()
        case_dir = self.runs_root / f"task_{state.task_index:04d}"
        outcome = run_frozen_harness_episode(
            case_id=f"task-{state.task_index:04d}",
            case_dir=case_dir,
            harness=harness,
            config=self.config,
            task_source=Path(task.task_ref),
            seed_artifact=Path(task.seed_artifact_ref),
            seed_score=float(task.seed_score),
            epoch=state.task_index + 1,
            run_id_prefix=run_id_prefix,
            init_handler=self.init_handler,
            evolve_handler=self.evolve_handler,
        )
        next_index = state.task_index + 1
        completed = (*state.completed_tasks, task.task_ref)
        next_state = BenchLoopState(
            bench=self.bench,
            task_index=next_index,
            completed_tasks=completed,
            current_harness_id=harness.harness_id,
            last_run_ref=str(case_dir),
            last_official_score=outcome.final_score,
        )
        atomic_write_json(self.state_path, next_state.to_dict())
        return BenchLoopStepResult(
            task=task,
            task_index=state.task_index,
            run_ref=str(case_dir),
            official_score=outcome.final_score,
            feasible=outcome.feasible,
            harness_id=harness.harness_id,
            advanced=True,
        )

    def run_until(self, *, steps: int, run_id_prefix: str = "loop") -> list[BenchLoopStepResult]:
        return [self.run_step(run_id_prefix=run_id_prefix) for _ in range(max(1, steps))]


def run_public_bench_eval(
    *,
    config: AppConfig,
    harness_profile: HarnessProfile,
    task_source: Path,
    seed_artifact: Path,
    seed_score: float,
    run_dir: Path,
    init_handler: Callable[..., Any],
    evolve_handler: Callable[..., Any],
    run_id_prefix: str = "public",
) -> dict[str, Any]:
    """On-demand official benchmark evaluation for a specific harness profile."""
    run_dir = run_dir.resolve()
    outcome = run_frozen_harness_episode(
        case_id="public-eval",
        case_dir=run_dir,
        harness=harness_profile,
        config=config,
        task_source=task_source.resolve(),
        seed_artifact=seed_artifact.resolve(),
        seed_score=seed_score,
        epoch=1,
        run_id_prefix=run_id_prefix,
        init_handler=init_handler,
        evolve_handler=evolve_handler,
    )
    return {
        "eval_kind": "official_public_benchmark",
        "harness_id": harness_profile.harness_id,
        "task_source": str(task_source.resolve()),
        "seed_artifact": str(seed_artifact.resolve()),
        "run_ref": outcome.run_ref,
        "official_score": outcome.final_score,
        "feasible": outcome.feasible,
        "infrastructure_ok": outcome.infrastructure_ok,
        "created_at": utc_now(),
    }


def load_loop_task_pool(path: Path) -> tuple[TaskPoolEntry, ...]:
    return load_task_pool(path)
