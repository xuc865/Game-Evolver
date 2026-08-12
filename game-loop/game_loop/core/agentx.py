from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, Sequence

from game_loop.core.attribution import AttributionReport
from game_loop.core.harness import (
    HarnessEpisodeOutcome,
    HarnessEpochResult,
    HarnessEvolutionEngine,
    HarnessProfile,
    HarnessReplayCase,
    HarnessSemanticGradient,
)
from game_loop.core.harness_evolution_memory import (
    HarnessEvolutionMemory,
    build_rejection_experience,
)
from game_loop.core.harness_rubric_validator import HarnessRubricValidator
from game_loop.utils import atomic_write_json, read_json, utc_now


class InnerGradientProposer(Protocol):
    """Outer agent: proposes a semantic gradient for the game-agent harness."""

    def propose_inner(
        self,
        report: AttributionReport,
        *,
        proposer_harness: HarnessProfile,
        target_harness: HarnessProfile,
    ) -> HarnessSemanticGradient: ...


class OuterGradientProposer(Protocol):
    """Diagnoses how the harness-improvement agent itself should change."""

    def propose_outer(
        self,
        report: AttributionReport,
        *,
        latest_inner_result: HarnessEpochResult,
        proposer_harness: HarnessProfile,
    ) -> HarnessSemanticGradient: ...


@dataclass(frozen=True)
class PairedOutcomes:
    parent: tuple[HarnessEpisodeOutcome, ...]
    candidate: tuple[HarnessEpisodeOutcome, ...]


class NestedReplayOracle(Protocol):
    """Scores frozen parent/candidate harnesses on matched replay cases."""

    def evaluate_inner(
        self,
        cases: Sequence[HarnessReplayCase],
        *,
        parent: HarnessProfile,
        candidate: HarnessProfile,
        proposer_harness: HarnessProfile,
        epoch: int,
    ) -> PairedOutcomes: ...

    def evaluate_outer(
        self,
        cases: Sequence[HarnessReplayCase],
        *,
        parent: HarnessProfile,
        candidate: HarnessProfile,
        target_harness: HarnessProfile,
        epoch: int,
    ) -> PairedOutcomes: ...


@dataclass(frozen=True)
class AgentXNestedEpochResult:
    inner: HarnessEpochResult
    outer: HarnessEpochResult | None
    inner_proposer_harness_id: str
    outer_target_harness_id: str

    def to_dict(self) -> dict:
        return {
            "inner": self.inner.to_dict(),
            "outer": None if self.outer is None else self.outer.to_dict(),
            "inner_proposer_harness_id": self.inner_proposer_harness_id,
            "outer_target_harness_id": self.outer_target_harness_id,
        }


class AgentXNestedEvolution:
    """Two-level SGPO-style evolution with strict paired-replay admission.

    Project terminology:
    - inner: evolve the game-making Agent harness;
    - outer: evolve the harness of the agent proposing inner-harness changes.

    Both levels reuse the existing content-addressed HarnessEvolutionEngine. A
    complete inner epoch freezes the outer proposer harness; a complete outer
    epoch freezes the current inner target harness. No candidate is promoted
    from self-assessment or a single artifact.
    """

    schema_version = "agentx-nested-evolution.v1"

    def __init__(
        self,
        *,
        run_dir: Path,
        inner_engine: HarnessEvolutionEngine,
        outer_engine: HarnessEvolutionEngine,
        inner_gradient_proposer: InnerGradientProposer,
        outer_gradient_proposer: OuterGradientProposer,
        replay_oracle: NestedReplayOracle,
        inner_rubric_validator: HarnessRubricValidator | None = None,
        outer_rubric_validator: HarnessRubricValidator | None = None,
        inner_memory: HarnessEvolutionMemory | None = None,
        outer_memory: HarnessEvolutionMemory | None = None,
        outer_enabled: bool = False,
    ):
        if inner_engine.config.mutation_width != 1 or outer_engine.config.mutation_width != 1:
            raise ValueError("AgentX-safe nested evolution requires mutation_width=1 at both levels")
        self.run_dir = run_dir.resolve()
        self.inner_engine = inner_engine
        self.outer_engine = outer_engine
        self.inner_gradient_proposer = inner_gradient_proposer
        self.outer_gradient_proposer = outer_gradient_proposer
        self.replay_oracle = replay_oracle
        self.inner_rubric_validator = inner_rubric_validator or HarnessRubricValidator(
            inner_engine.config
        )
        self.outer_rubric_validator = outer_rubric_validator or HarnessRubricValidator(
            outer_engine.config
        )
        self.inner_memory = inner_memory
        self.outer_memory = outer_memory
        self.outer_enabled = outer_enabled
        self.state_path = self.run_dir / "nested_evolution.json"

    def initialize(self) -> None:
        self.run_dir.mkdir(parents=True, exist_ok=True)
        inner = self.inner_engine.initialize()
        outer = self.outer_engine.initialize()
        atomic_write_json(self.state_path, {
            "schema_version": self.schema_version,
            "terminology": {
                "inner": "game_agent_harness_evolution",
                "outer": "harness_improvement_agent_harness_evolution",
            },
            "inner_seed_harness_id": inner.harness_id,
            "outer_seed_harness_id": outer.harness_id,
            "epochs": [],
            "created_at": utc_now(),
        })

    def run_epoch(
        self,
        *,
        epoch: int,
        report: AttributionReport,
        inner_cases: Sequence[HarnessReplayCase],
        outer_cases: Sequence[HarnessReplayCase],
    ) -> AgentXNestedEpochResult:
        if not self.state_path.is_file():
            raise RuntimeError("nested evolution is not initialized")
        inner_parent = self.inner_engine.champion()
        frozen_outer = self.outer_engine.champion()
        inner_gradient = self.inner_gradient_proposer.propose_inner(
            report,
            proposer_harness=frozen_outer,
            target_harness=inner_parent,
        )
        inner_candidate = self.inner_engine.propose(
            parent_id=inner_parent.harness_id,
            gradient=inner_gradient,
            epoch=epoch,
        )
        inner_outcomes = self.replay_oracle.evaluate_inner(
            inner_cases,
            parent=inner_parent,
            candidate=inner_candidate,
            proposer_harness=frozen_outer,
            epoch=epoch,
        )
        inner_rubric = self.inner_rubric_validator.validate_paired_outcomes(
            parent_outcomes=inner_outcomes.parent,
            candidate_outcomes=inner_outcomes.candidate,
            parent_profile=inner_parent,
            candidate_profile=inner_candidate,
            case_task_refs={
                case.case_id: Path(case.task_ref)
                for case in inner_cases
            },
            module_categories=self.inner_engine.module_categories,
        )
        inner_result = self.inner_engine.assess_epoch(
            epoch=epoch,
            parent=inner_parent,
            candidate=inner_candidate,
            parent_outcomes=inner_outcomes.parent,
            candidate_outcomes=inner_outcomes.candidate,
            rubric_validation=inner_rubric.to_dict(),
        )
        self.inner_engine.record_epoch(inner_result)
        if (
            not inner_result.accepted
            and self.inner_memory is not None
            and self.inner_engine.config.enable_long_term_memory
        ):
            self.inner_memory.append(
                build_rejection_experience(
                    epoch=epoch,
                    loop_role=self.inner_engine.config.loop_role,
                    parent=inner_parent,
                    candidate=inner_candidate,
                    epoch_result=inner_result,
                    rubric_validation=inner_rubric.to_dict(),
                )
            )
        self.outer_engine.record_element_usage(
            profile=frozen_outer,
            success=inner_result.accepted,
        )

        frozen_inner = self.inner_engine.champion()
        outer_result: HarnessEpochResult | None = None
        outer_validation: dict[str, object]
        if self.outer_enabled:
            # The outer epoch starts only after the complete inner epoch. Its
            # target is the resulting inner champion and remains frozen while
            # the outer harness-generation element library is updated.
            outer_parent = self.outer_engine.champion()
            outer_gradient = self.outer_gradient_proposer.propose_outer(
                report,
                latest_inner_result=inner_result,
                proposer_harness=outer_parent,
            )
            outer_candidate = self.outer_engine.propose(
                parent_id=outer_parent.harness_id,
                gradient=outer_gradient,
                epoch=epoch,
            )
            del outer_cases
            outer_validation = {
                "accepted": True,
                "mode": "outer_element_library_management",
                "inner_epoch_accepted": inner_result.accepted,
                "target_inner_harness_id": frozen_inner.harness_id,
                "record_element_stats": False,
                "reasons": [],
                "created_at": utc_now(),
            }
            outer_result = HarnessEpochResult(
                epoch=epoch,
                parent_harness_id=outer_parent.harness_id,
                candidate_harness_id=outer_candidate.harness_id,
                accepted=True,
                paired_deltas=(),
                median_delta=None,
                reasons=(),
                excluded_pairs=(),
                parent_outcomes=(),
                candidate_outcomes=(),
                created_at=utc_now(),
                rubric_validation=outer_validation,
            )
            self.outer_engine.record_epoch(outer_result)
        else:
            del outer_cases
            outer_validation = {
                "accepted": True,
                "mode": "outer_evolution_disabled",
                "inner_epoch_accepted": inner_result.accepted,
                "target_inner_harness_id": frozen_inner.harness_id,
                "record_element_stats": False,
                "reasons": [],
                "created_at": utc_now(),
            }
        result = AgentXNestedEpochResult(
            inner_result,
            outer_result,
            frozen_outer.harness_id,
            frozen_inner.harness_id,
        )
        state = read_json(self.state_path)
        state["epochs"].append({
            **result.to_dict(),
            "inner_gradient": inner_gradient.to_dict(),
            "outer_gradient": None if not self.outer_enabled else outer_gradient.to_dict(),
            "inner_rubric_validation": inner_rubric.to_dict(),
            "outer_element_library_update": outer_validation,
            "completed_at": utc_now(),
        })
        atomic_write_json(self.state_path, state)
        return result
