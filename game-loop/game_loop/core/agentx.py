from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

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
from game_loop.core.outer_harness_library import (
    OuterHarnessLibraryAgent,
    OuterLibraryUpdate,
)
from game_loop.utils import atomic_write_json, read_json, utc_now


_NOOP_MUTATION_MESSAGE = (
    "harness mutation is a no-op: candidate does not change executable behavior"
)


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
        outer_library_agent: OuterHarnessLibraryAgent | None = None,
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
        self.outer_library_agent = outer_library_agent
        self.outer_enabled = outer_enabled
        self.state_path = self.run_dir / "nested_evolution.json"

    def initialize(self) -> None:
        self.run_dir.mkdir(parents=True, exist_ok=True)
        inner = self.inner_engine.initialize()
        outer = self.outer_engine.initialize()
        if self.outer_library_agent is not None:
            self.outer_library_agent.store.initialize(self.outer_engine.elements.values())
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
        outer_element_ids_used: tuple[str, ...] = ()
        outer_preparation_error: str | None = None
        if self.outer_library_agent is not None:
            try:
                outer_element_ids_used = (
                    self.outer_library_agent.store.element_ids_for_inner_proposal(
                        frozen_outer
                    )
                )
            except Exception as exc:  # noqa: BLE001 - isolate outer metadata failure.
                outer_element_ids_used = tuple(
                    element.element_id for element in frozen_outer.active_elements
                )
                outer_preparation_error = f"{type(exc).__name__}: {exc}"
        inner_gradient = self.inner_gradient_proposer.propose_inner(
            report,
            proposer_harness=frozen_outer,
            target_harness=inner_parent,
        )
        inner_candidate = _propose_with_noop_retries(
            engine=self.inner_engine,
            parent=inner_parent,
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
        legacy_outer_stats_error: str | None = None
        try:
            self.outer_engine.record_element_usage(
                profile=frozen_outer,
                success=inner_result.accepted,
            )
        except Exception as exc:  # noqa: BLE001 - inner result is already committed.
            legacy_outer_stats_error = f"{type(exc).__name__}: {exc}"
        outer_usage_error: str | None = None
        if self.outer_library_agent is not None:
            try:
                outer_usage_update = self.outer_library_agent.store.record_inner_epoch(
                    element_ids=outer_element_ids_used,
                    result=inner_result,
                )
            except Exception as exc:  # noqa: BLE001 - inner result is already committed.
                outer_usage_update = None
                outer_usage_error = f"{type(exc).__name__}: {exc}"
        else:
            outer_usage_update = None

        frozen_inner = self.inner_engine.champion()
        outer_result: HarnessEpochResult | None = None
        outer_validation: dict[str, object]
        outer_gradient = None
        if self.outer_enabled and self.outer_library_agent is not None:
            outer_failure = outer_preparation_error or outer_usage_error
            try:
                revision = self.outer_library_agent.store.revision()
            except Exception:  # noqa: BLE001 - preserve the completed inner epoch.
                revision = 0
            if outer_failure is not None:
                update = OuterLibraryUpdate(
                    epoch=epoch,
                    status="failed_infrastructure_or_validation",
                    revision_before=revision,
                    revision_after=revision,
                    shortlist=(),
                    operations=(),
                    additions=(),
                    error=outer_failure,
                )
            else:
                try:
                    state = read_json(self.state_path)
                    update = self.outer_library_agent.evolve(
                        epoch=epoch,
                        inner_history=list(state.get("epochs", [])),
                        latest_inner_result=inner_result,
                        current_inner_element_ids=outer_element_ids_used,
                    )
                except Exception as exc:  # noqa: BLE001 - outer failure is non-fatal.
                    update = OuterLibraryUpdate(
                        epoch=epoch,
                        status="failed_infrastructure_or_validation",
                        revision_before=revision,
                        revision_after=revision,
                        shortlist=(),
                        operations=(),
                        additions=(),
                        error=f"{type(exc).__name__}: {exc}",
                    )
            engine_catalog_sync_error: str | None = None
            try:
                # Profile activation remains a separate content-addressed decision.
                self.outer_engine.elements.update(
                    self.outer_library_agent.store.catalog()
                )
            except Exception as exc:  # noqa: BLE001 - legacy sync is best effort.
                engine_catalog_sync_error = f"{type(exc).__name__}: {exc}"
            outer_parent = self.outer_engine.champion()
            outer_reasons = [update.error] if update.error else []
            if not update.applied and not outer_reasons:
                outer_reasons.append(update.status)
            if engine_catalog_sync_error is not None:
                outer_reasons.append(engine_catalog_sync_error)
            outer_validation = {
                "accepted": update.applied,
                "mode": "outer_element_library_management",
                "inner_epoch_accepted": inner_result.accepted,
                "target_inner_harness_id": frozen_inner.harness_id,
                "record_element_stats": False,
                "library_update": update.to_dict(),
                "reasons": outer_reasons,
                "engine_catalog_sync_error": engine_catalog_sync_error,
                "created_at": utc_now(),
            }
            outer_result = HarnessEpochResult(
                epoch=epoch,
                parent_harness_id=outer_parent.harness_id,
                candidate_harness_id=outer_parent.harness_id,
                accepted=update.applied,
                paired_deltas=(),
                median_delta=None,
                reasons=tuple(outer_validation["reasons"]),
                excluded_pairs=(),
                parent_outcomes=(),
                candidate_outcomes=(),
                created_at=utc_now(),
                rubric_validation=outer_validation,
            )
        elif self.outer_enabled:
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
                "reasons": [
                    item for item in (
                        outer_preparation_error,
                        outer_usage_error,
                        legacy_outer_stats_error,
                    ) if item is not None
                ],
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
                "mode": (
                    "outer_evolution_frozen_metadata_only"
                    if self.outer_library_agent is not None
                    else "outer_evolution_disabled"
                ),
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
            "outer_gradient": None if outer_gradient is None else outer_gradient.to_dict(),
            "inner_rubric_validation": inner_rubric.to_dict(),
            "outer_element_ids_used_for_inner_proposal": list(outer_element_ids_used),
            "outer_element_usage_update": outer_usage_update,
            "outer_element_preparation_error": outer_preparation_error,
            "outer_element_usage_error": outer_usage_error,
            "legacy_outer_element_stats_error": legacy_outer_stats_error,
            "outer_element_library_update": outer_validation,
            "completed_at": utc_now(),
        })
        atomic_write_json(self.state_path, state)
        return result


def _propose_with_noop_retries(
    *,
    engine: HarnessEvolutionEngine,
    parent: HarnessProfile,
    gradient: HarnessSemanticGradient,
    epoch: int,
) -> HarnessProfile:
    errors: list[str] = []
    retry_gradients = _behavior_changing_retry_gradients(
        parent=parent,
        engine=engine,
        epoch=epoch,
        original=gradient,
    )
    for attempt, candidate_gradient in enumerate((gradient, *retry_gradients), start=1):
        try:
            candidate = engine.propose(
                parent_id=parent.harness_id,
                gradient=candidate_gradient,
                epoch=epoch,
            )
        except ValueError as exc:
            if str(exc) != _NOOP_MUTATION_MESSAGE:
                raise
            errors.append(
                f"attempt {attempt}: tags={list(candidate_gradient.target_tags)}"
            )
            continue
        if attempt > 1:
            print(
                f"[agentx] recovered no-op inner mutation at epoch {epoch} "
                f"on attempt {attempt}: tags={list(candidate_gradient.target_tags)}"
            )
        return candidate
    raise ValueError(
        _NOOP_MUTATION_MESSAGE
        + "; retries exhausted: "
        + " | ".join(errors[-6:])
    )


def _behavior_changing_retry_gradients(
    *,
    parent: HarnessProfile,
    engine: HarnessEvolutionEngine,
    epoch: int,
    original: HarnessSemanticGradient,
) -> tuple[HarnessSemanticGradient, ...]:
    counts: dict[str, int] = {}
    for element in parent.active_elements:
        counts[element.category] = counts.get(element.category, 0) + 1
    categories = tuple(
        category
        for category in ("workflow", "mcp", "protocol", "context", "skill", "tool")
        if engine.category_is_mutable(category)
        and any(spec.category == category for spec in engine.elements.values())
    )
    open_categories = tuple(
        category
        for category in categories
        if counts.get(category, 0)
        < engine.config.max_active_elements.get(category, 1)
    )
    ordered_categories = tuple(dict.fromkeys((*open_categories, *categories)))
    module_tags = (
        "mechanic_depth",
        "gameplay_observability",
        "regression_first",
        "engine_tooling_first",
        "evidence_first",
        "minimal_coherent_patch",
    )
    gradients: list[HarnessSemanticGradient] = []
    for index, category in enumerate(ordered_categories):
        inactive_ids = sorted(
            spec.element_id
            for spec in engine.elements.values()
            if spec.category == category
            and spec.element_id
            not in {
                element.element_id
                for element in parent.active_elements
                if element.category == category
            }
        )
        mode = (
            "element_add"
            if counts.get(category, 0)
            < engine.config.max_active_elements.get(category, 1)
            else "element_replace"
        )
        module_tag = module_tags[(epoch + index) % len(module_tags)]
        target_tags = [category, "usage_driven", mode, module_tag]
        if mode == "element_replace" and inactive_ids:
            target_tags.append(f"element_id:{inactive_ids[(epoch + index) % len(inactive_ids)]}")
        gradients.append(
            HarnessSemanticGradient(
                diagnosis=(
                    f"epoch {epoch}: retry no-op inner mutation via {category} "
                    f"{mode}; original={original.diagnosis}"
                ),
                target_tags=tuple(target_tags),
                evidence_refs=original.evidence_refs,
            )
        )
    return tuple(gradients)
