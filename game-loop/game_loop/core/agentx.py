from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Protocol

from game_loop.core.attribution import AttributionReport
from game_loop.core.agent_circuit_evolution import (
    CircuitCostModel,
    CircuitMutationTransaction,
)
from game_loop.core.agent_circuit_attribution import (
    CircuitAblationQueue,
    CircuitAblationTrial,
)
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
from game_loop.core.harness_transformation_library import (
    HarnessTransformationLibraryStore,
)
from game_loop.core.harness_transformation_agent import (
    HarnessTransformationLibraryAgent,
    TransformationLibraryUpdate,
)
from game_loop.utils import atomic_write_json, read_json, utc_now


_NOOP_MUTATION_MESSAGE = (
    "harness mutation is a no-op: candidate does not change executable behavior"
)


def _rejected_candidate_ids_for_parent(
    *,
    engine: HarnessEvolutionEngine,
    parent: HarnessProfile,
) -> set[str]:
    return {
        item.candidate_harness_id
        for item in HarnessEvolutionMemory(
            engine.root
        ).load_recent(limit=256)
        if item.loop_role == engine.config.loop_role
        and item.parent_harness_id == parent.harness_id
    }


def _rejected_behavior_signatures_for_parent(
    *,
    engine: HarnessEvolutionEngine,
    parent: HarnessProfile,
) -> set[tuple[object, ...]]:
    """Load executable signatures rejected for this exact champion branch.

    Harness IDs also include provenance such as generation/rationale, so the same
    executable harness can legitimately receive a different ID on a later retry.
    The signature intentionally ignores that provenance.
    """
    signatures: set[tuple[object, ...]] = set()
    experiences = HarnessEvolutionMemory(engine.root).load_recent(limit=256)
    for item in experiences:
        if (
            item.loop_role != engine.config.loop_role
            or item.parent_harness_id != parent.harness_id
        ):
            continue
        profile_path = (
            engine.root
            / "profiles"
            / f"{item.candidate_harness_id}.json"
        )
        try:
            profile = HarnessProfile.from_dict(read_json(profile_path))
        except (OSError, KeyError, TypeError, ValueError):
            # Older rejection records may not have retained their profile. The
            # candidate-ID blacklist remains the safe compatibility fallback.
            continue
        signatures.add(engine._behavior_signature(profile))
    return signatures


def _repeated_candidate_infrastructure_failures(
    *,
    state: dict,
    engine: HarnessEvolutionEngine,
    parent: HarnessProfile,
    minimum_failures: int = 2,
) -> tuple[set[str], set[tuple[object, ...]]]:
    """Return repeatedly broken candidates as proposal-diversity exclusions."""
    counts: Counter[str] = Counter()
    for attempt in state.get("attempts", []):
        if not isinstance(attempt, dict) or attempt.get("status") != "FAILED_INFRA":
            continue
        inner = attempt.get("inner")
        if not isinstance(inner, dict) or inner.get("parent_harness_id") != parent.harness_id:
            continue
        outcomes = inner.get("candidate_outcomes", [])
        if not any(
            isinstance(outcome, dict) and outcome.get("infrastructure_ok") is False
            for outcome in outcomes
        ):
            continue
        candidate_id = inner.get("candidate_harness_id")
        if isinstance(candidate_id, str) and candidate_id:
            counts[candidate_id] += 1

    candidate_ids = {
        candidate_id
        for candidate_id, count in counts.items()
        if count >= minimum_failures
    }
    signatures: set[tuple[object, ...]] = set()
    for candidate_id in candidate_ids:
        try:
            profile = HarnessProfile.from_dict(
                read_json(engine.root / "profiles" / f"{candidate_id}.json")
            )
        except (OSError, KeyError, TypeError, ValueError):
            continue
        signatures.add(engine._behavior_signature(profile))
    return candidate_ids, signatures


class InnerGradientProposer(Protocol):
    """Outer agent: proposes a semantic gradient for the game-agent harness."""

    def propose_inner(
        self,
        report: AttributionReport,
        *,
        proposer_harness: HarnessProfile,
        target_harness: HarnessProfile,
    ) -> HarnessSemanticGradient: ...


class InnerCircuitProposer(Protocol):
    def propose_circuit(
        self,
        report: AttributionReport,
        *,
        proposer_harness: HarnessProfile,
        target_harness: HarnessProfile,
    ) -> CircuitMutationTransaction | None: ...


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

    @classmethod
    def from_dict(cls, value: dict) -> "AgentXNestedEpochResult":
        return cls(
            inner=HarnessEpochResult.from_dict(value["inner"]),
            outer=(
                None
                if value.get("outer") is None
                else HarnessEpochResult.from_dict(value["outer"])
            ),
            inner_proposer_harness_id=str(value["inner_proposer_harness_id"]),
            outer_target_harness_id=str(value["outer_target_harness_id"]),
        )


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
        inner_circuit_proposer: InnerCircuitProposer | None = None,
        outer_gradient_proposer: OuterGradientProposer,
        replay_oracle: NestedReplayOracle,
        inner_rubric_validator: HarnessRubricValidator | None = None,
        outer_rubric_validator: HarnessRubricValidator | None = None,
        inner_memory: HarnessEvolutionMemory | None = None,
        outer_memory: HarnessEvolutionMemory | None = None,
        outer_library_agent: OuterHarnessLibraryAgent | None = None,
        circuit_transformation_store: HarnessTransformationLibraryStore | None = None,
        circuit_transformation_agent: HarnessTransformationLibraryAgent | None = None,
        circuit_ablation_queue: CircuitAblationQueue | None = None,
        hpa_max_structural_actions: int = 4,
        hpa_max_additions: int = 2,
        outer_enabled: bool = False,
    ):
        if inner_engine.config.mutation_width != 1 or outer_engine.config.mutation_width != 1:
            raise ValueError(
                "AgentX-safe nested evolution requires atomic mutation_width=1 "
                "at both levels; use bundle_width for attributed throughput"
            )
        if (
            inner_engine.config.bundle_width > 1
            and inner_engine.config.attribution_mode != "bundle_then_ablate"
        ):
            raise ValueError(
                "wide AgentX bundles require attribution_mode=bundle_then_ablate"
            )
        if hpa_max_structural_actions < 1:
            raise ValueError("shared HPA action budget must be positive")
        if not 0 <= hpa_max_additions <= hpa_max_structural_actions:
            raise ValueError("shared HPA addition budget is invalid")
        self.run_dir = run_dir.resolve()
        self.inner_engine = inner_engine
        self.outer_engine = outer_engine
        self.inner_gradient_proposer = inner_gradient_proposer
        self.inner_circuit_proposer = inner_circuit_proposer
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
        self.circuit_transformation_store = circuit_transformation_store
        self.circuit_transformation_agent = circuit_transformation_agent
        self.circuit_ablation_queue = circuit_ablation_queue
        self.circuit_cost_model = CircuitCostModel(
            minimum_net_utility=inner_engine.config.circuit_min_net_utility
        )
        self.hpa_max_structural_actions = hpa_max_structural_actions
        self.hpa_max_additions = hpa_max_additions
        self.outer_enabled = outer_enabled
        self.state_path = self.run_dir / "nested_evolution.json"

    def initialize(self) -> None:
        self.run_dir.mkdir(parents=True, exist_ok=True)
        inner = self.inner_engine.initialize()
        outer = self.outer_engine.initialize()
        if self.outer_library_agent is not None:
            self.outer_library_agent.store.initialize(self.outer_engine.elements.values())
        if self.circuit_ablation_queue is not None:
            self.circuit_ablation_queue.initialize()
        if self.circuit_transformation_agent is not None:
            self.circuit_transformation_agent.store.initialize()
        if self.state_path.is_file():
            existing = read_json(self.state_path)
            if existing.get("schema_version") != self.schema_version:
                raise ValueError("unsupported nested evolution state schema")
            return
        atomic_write_json(self.state_path, {
            "schema_version": self.schema_version,
            "terminology": {
                "inner": "game_agent_harness_evolution",
                "outer": "harness_improvement_agent_harness_evolution",
            },
            "inner_seed_harness_id": inner.harness_id,
            "outer_seed_harness_id": outer.harness_id,
            "epochs": [],
            "attempts": [],
            "created_at": utc_now(),
        })

    def _epoch_journal_path(self, epoch: int) -> Path:
        return self.run_dir / "epoch_journals" / f"epoch_{epoch:03d}.json"

    def _recorded_inner_result(self, epoch: int) -> HarnessEpochResult | None:
        path = self.inner_engine.root / "epochs.json"
        if not path.is_file():
            return None
        matches = [
            item
            for item in read_json(path).get("items", [])
            if int(item.get("epoch", -1)) == epoch
        ]
        if len(matches) > 1:
            raise RuntimeError(f"inner epoch {epoch} has multiple formal results")
        return None if not matches else HarnessEpochResult.from_dict(matches[0])

    def _recover_recorded_inner_epoch(
        self,
        *,
        epoch: int,
        inner_result: HarnessEpochResult,
        journal: dict[str, object] | None,
    ) -> AgentXNestedEpochResult:
        expected_champion = (
            inner_result.candidate_harness_id
            if inner_result.accepted
            else inner_result.parent_harness_id
        )
        actual_champion = self.inner_engine.champion().harness_id
        if actual_champion != expected_champion:
            raise RuntimeError(
                f"cannot recover inner epoch {epoch}: champion drift; expected "
                f"{expected_champion}, found {actual_champion}"
            )
        payload = journal or {}
        raw_transaction = payload.get("inner_circuit_transaction")
        transaction = (
            None
            if not isinstance(raw_transaction, dict)
            else CircuitMutationTransaction.from_dict(raw_transaction)
        )
        raw_trial = payload.get("circuit_ablation_trial")
        trial = (
            None
            if not isinstance(raw_trial, dict)
            else CircuitAblationTrial.from_dict(raw_trial)
        )
        infrastructure_ok = bool(payload.get("inner_infrastructure_ok", False))
        utility = payload.get("circuit_utility")
        utility_dict = utility if isinstance(utility, dict) else {}
        recovery_errors: list[str] = []
        if self.circuit_ablation_queue is not None and infrastructure_ok:
            try:
                if trial is not None:
                    self.circuit_ablation_queue.record_trial(
                        epoch=epoch,
                        trial=trial,
                        infrastructure_ok=True,
                        accepted=inner_result.accepted,
                        candidate_harness_id=inner_result.candidate_harness_id,
                        quality_delta=inner_result.median_delta,
                        cost_penalty=(
                            None
                            if utility_dict.get("cost_penalty") is None
                            else float(utility_dict["cost_penalty"])
                        ),
                        net_utility=(
                            None
                            if utility_dict.get("net_utility") is None
                            else float(utility_dict["net_utility"])
                        ),
                        reasons=inner_result.reasons,
                    )
                elif transaction is not None and inner_result.accepted:
                    self.circuit_ablation_queue.schedule(
                        epoch=epoch,
                        source_parent_harness_id=inner_result.parent_harness_id,
                        accepted_harness_id=inner_result.candidate_harness_id,
                        transaction=transaction,
                    )
            except Exception as exc:  # noqa: BLE001 - preserve formal inner result.
                recovery_errors.append(f"circuit attribution: {type(exc).__name__}: {exc}")
        if (
            transaction is not None
            and trial is None
            and infrastructure_ok
            and self.circuit_transformation_store is not None
            and transaction.transformation_ids
        ):
            try:
                self.circuit_transformation_store.record_use(
                    transformation_ids=transaction.transformation_ids,
                    epoch=epoch,
                    success=inner_result.accepted,
                    quality_delta=inner_result.median_delta or 0.0,
                    cost_penalty=float(utility_dict.get("cost_penalty", 0.0)),
                    hard_regression=any(
                        delta < -self.inner_engine.config.max_case_regression
                        for delta in inner_result.paired_deltas
                    ),
                )
            except ValueError as exc:
                if "already attributed" not in str(exc):
                    recovery_errors.append(
                        f"transformation attribution: {type(exc).__name__}: {exc}"
                    )
            except Exception as exc:  # noqa: BLE001 - preserve formal inner result.
                recovery_errors.append(
                    f"transformation attribution: {type(exc).__name__}: {exc}"
                )
        frozen_outer_id = str(
            payload.get(
                "inner_proposer_harness_id",
                self.outer_engine.champion().harness_id,
            )
        )
        result = AgentXNestedEpochResult(
            inner=inner_result,
            outer=None,
            inner_proposer_harness_id=frozen_outer_id,
            outer_target_harness_id=actual_champion,
        )
        state = read_json(self.state_path)
        state["epochs"].append(
            {
                **result.to_dict(),
                "inner_gradient": payload.get("inner_gradient"),
                "inner_circuit_transaction": raw_transaction,
                "circuit_ablation_trial": raw_trial,
                "circuit_utility": utility,
                "inner_rubric_validation": inner_result.rubric_validation,
                "outer_element_library_update": {
                    "accepted": False,
                    "mode": "interrupted_after_inner_commit",
                    "reasons": [
                        "HPA metadata evolution skipped during idempotent resume"
                    ],
                },
                "hpa_transformation_library_update": None,
                "resume_recovery": {
                    "recovered": True,
                    "journal_present": journal is not None,
                    "errors": recovery_errors,
                },
                "completed_at": utc_now(),
            }
        )
        atomic_write_json(self.state_path, state)
        self._epoch_journal_path(epoch).unlink(missing_ok=True)
        return result

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
        state = read_json(self.state_path)
        completed = [
            item
            for item in state.get("epochs", [])
            if isinstance(item, dict)
            and int(dict(item.get("inner", {})).get("epoch", -1)) == epoch
        ]
        if len(completed) > 1:
            raise RuntimeError(f"nested epoch {epoch} has multiple completed records")
        if completed:
            self._epoch_journal_path(epoch).unlink(missing_ok=True)
            return AgentXNestedEpochResult.from_dict(completed[0])
        journal_path = self._epoch_journal_path(epoch)
        journal = read_json(journal_path) if journal_path.is_file() else None
        recorded_inner = self._recorded_inner_result(epoch)
        if recorded_inner is not None:
            if journal is not None and journal.get("phase") != "inner_recorded":
                raise RuntimeError(
                    f"inner epoch {epoch} is committed but its resume journal is "
                    f"only at phase {journal.get('phase')!r}"
                )
            return self._recover_recorded_inner_epoch(
                epoch=epoch,
                inner_result=recorded_inner,
                journal=journal,
            )
        if journal is not None:
            # No formal result exists, so replay is safe. Preserve the abandoned
            # intent for audit and replace it with this attempt's journal.
            archive = journal_path.with_name(
                f"{journal_path.stem}.incomplete-{utc_now().replace(':', '')}.json"
            )
            journal_path.rename(archive)
        inner_parent = self.inner_engine.champion()
        (
            infra_failed_candidate_ids,
            infra_failed_behavior_signatures,
        ) = _repeated_candidate_infrastructure_failures(
            state=state,
            engine=self.inner_engine,
            parent=inner_parent,
        )
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
        inner_circuit_transaction = None
        circuit_ablation_trial: CircuitAblationTrial | None = None
        if self.circuit_ablation_queue is not None:
            circuit_ablation_trial = self.circuit_ablation_queue.next_trial(
                champion_harness_id=inner_parent.harness_id
            )
        if circuit_ablation_trial is not None:
            inner_circuit_transaction = circuit_ablation_trial.candidate_transaction
            if inner_circuit_transaction is None:
                inner_candidate = self.inner_engine.get(
                    circuit_ablation_trial.source_parent_harness_id
                )
            else:
                inner_candidate = self.inner_engine.propose_circuit(
                    parent_id=circuit_ablation_trial.source_parent_harness_id,
                    transaction=inner_circuit_transaction,
                    epoch=epoch,
                )
        elif self.inner_circuit_proposer is not None:
            inner_circuit_transaction = self.inner_circuit_proposer.propose_circuit(
                report,
                proposer_harness=frozen_outer,
                target_harness=inner_parent,
            )
        if circuit_ablation_trial is not None:
            pass
        elif inner_circuit_transaction is not None:
            inner_candidate = self.inner_engine.propose_circuit(
                parent_id=inner_parent.harness_id,
                transaction=inner_circuit_transaction,
                epoch=epoch,
            )
            rejected_signatures = _rejected_behavior_signatures_for_parent(
                engine=self.inner_engine,
                parent=inner_parent,
            )
            rejected_signatures.update(infra_failed_behavior_signatures)
            if self.inner_engine._behavior_signature(inner_candidate) in rejected_signatures:
                inner_candidate = _propose_with_noop_retries(
                    engine=self.inner_engine,
                    parent=inner_parent,
                    gradient=inner_gradient,
                    epoch=epoch,
                    excluded_candidate_ids=infra_failed_candidate_ids,
                    excluded_behavior_signatures=infra_failed_behavior_signatures,
                )
                inner_circuit_transaction = None
        else:
            inner_candidate = _propose_with_noop_retries(
                engine=self.inner_engine,
                parent=inner_parent,
                gradient=inner_gradient,
                epoch=epoch,
                excluded_candidate_ids=infra_failed_candidate_ids,
                excluded_behavior_signatures=infra_failed_behavior_signatures,
            )
        journal_path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(
            journal_path,
            {
                "schema_version": "agentx-epoch-journal.v1",
                "epoch": epoch,
                "phase": "evaluating_inner",
                "inner_parent_harness_id": inner_parent.harness_id,
                "inner_candidate_harness_id": inner_candidate.harness_id,
                "inner_proposer_harness_id": frozen_outer.harness_id,
                "inner_gradient": inner_gradient.to_dict(),
                "inner_circuit_transaction": (
                    None
                    if inner_circuit_transaction is None
                    else inner_circuit_transaction.to_dict()
                ),
                "circuit_ablation_trial": (
                    None
                    if circuit_ablation_trial is None
                    else circuit_ablation_trial.to_dict()
                ),
                "created_at": utc_now(),
            },
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
            net_utility_admission=(
                inner_circuit_transaction is not None
                or circuit_ablation_trial is not None
            ),
        )
        circuit_utility = None
        inner_infrastructure_ok = inner_rubric.infrastructure_ok and all(
            outcome.infrastructure_ok
            for outcome in (*inner_outcomes.parent, *inner_outcomes.candidate)
        )
        if not inner_infrastructure_ok:
            circuit_ablation_error = None
            if self.circuit_ablation_queue is not None and circuit_ablation_trial is not None:
                try:
                    self.circuit_ablation_queue.record_trial(
                        epoch=epoch,
                        trial=circuit_ablation_trial,
                        infrastructure_ok=False,
                        accepted=False,
                        candidate_harness_id=inner_candidate.harness_id,
                        quality_delta=None,
                        cost_penalty=None,
                        net_utility=None,
                        reasons=inner_result.reasons,
                    )
                except Exception as exc:  # noqa: BLE001 - retain failed attempt evidence.
                    circuit_ablation_error = f"{type(exc).__name__}: {exc}"
            result = AgentXNestedEpochResult(
                inner=inner_result,
                outer=None,
                inner_proposer_harness_id=frozen_outer.harness_id,
                outer_target_harness_id=inner_parent.harness_id,
            )
            state = read_json(self.state_path)
            state.setdefault("attempts", []).append({
                **result.to_dict(),
                "status": "FAILED_INFRA",
                "inner_gradient": inner_gradient.to_dict(),
                "inner_circuit_transaction": (
                    None
                    if inner_circuit_transaction is None
                    else inner_circuit_transaction.to_dict()
                ),
                "circuit_ablation_trial": (
                    None
                    if circuit_ablation_trial is None
                    else circuit_ablation_trial.to_dict()
                ),
                "circuit_ablation_error": circuit_ablation_error,
                "inner_rubric_validation": inner_rubric.to_dict(),
                "created_at": utc_now(),
            })
            atomic_write_json(self.state_path, state)
            failed_journal = read_json(journal_path)
            failed_journal.update({
                "phase": "failed_infrastructure",
                "inner_result": inner_result.to_dict(),
                "inner_infrastructure_ok": False,
                "failed_at": utc_now(),
            })
            atomic_write_json(journal_path, failed_journal)
            archived_journal = journal_path.with_name(
                f"{journal_path.stem}.failed-infra-{utc_now().replace(':', '')}.json"
            )
            journal_path.rename(archived_journal)
            return result
        if (
            (inner_circuit_transaction is not None or circuit_ablation_trial is not None)
            and inner_infrastructure_ok
        ):
            circuit_utility = self.circuit_cost_model.decide(
                parent=inner_parent.effective_agent_circuit(),
                candidate=inner_candidate.effective_agent_circuit(),
                quality_delta=inner_result.median_delta or 0.0,
            )
            validation = dict(inner_result.rubric_validation or {})
            validation["circuit_utility"] = {
                "accepted": circuit_utility.accepted,
                "quality_delta": circuit_utility.quality_delta,
                "cost_penalty": circuit_utility.cost_penalty,
                "net_utility": circuit_utility.net_utility,
                "reasons": list(circuit_utility.reasons),
            }
            if inner_result.accepted and not circuit_utility.accepted:
                inner_result = replace(
                    inner_result,
                    accepted=False,
                    reasons=tuple((*inner_result.reasons, *circuit_utility.reasons)),
                    rubric_validation=validation,
                )
            else:
                inner_result = replace(inner_result, rubric_validation=validation)
        self.inner_engine.record_epoch(inner_result)
        committed_journal = read_json(journal_path)
        committed_journal.update(
            {
                "phase": "inner_recorded",
                "inner_result": inner_result.to_dict(),
                "inner_infrastructure_ok": inner_infrastructure_ok,
                "circuit_utility": (
                    None
                    if circuit_utility is None
                    else {
                        "accepted": circuit_utility.accepted,
                        "quality_delta": circuit_utility.quality_delta,
                        "cost_penalty": circuit_utility.cost_penalty,
                        "net_utility": circuit_utility.net_utility,
                        "reasons": list(circuit_utility.reasons),
                    }
                ),
                "inner_recorded_at": utc_now(),
            }
        )
        atomic_write_json(journal_path, committed_journal)
        circuit_ablation_error = None
        if self.circuit_ablation_queue is not None:
            try:
                if circuit_ablation_trial is not None:
                    self.circuit_ablation_queue.record_trial(
                        epoch=epoch,
                        trial=circuit_ablation_trial,
                        infrastructure_ok=inner_infrastructure_ok,
                        accepted=inner_result.accepted,
                        candidate_harness_id=inner_candidate.harness_id,
                        quality_delta=inner_result.median_delta,
                        cost_penalty=(
                            None
                            if circuit_utility is None
                            else circuit_utility.cost_penalty
                        ),
                        net_utility=(
                            None
                            if circuit_utility is None
                            else circuit_utility.net_utility
                        ),
                        reasons=inner_result.reasons,
                    )
                elif (
                    inner_circuit_transaction is not None
                    and inner_infrastructure_ok
                    and inner_result.accepted
                ):
                    self.circuit_ablation_queue.schedule(
                        epoch=epoch,
                        source_parent_harness_id=inner_parent.harness_id,
                        accepted_harness_id=inner_candidate.harness_id,
                        transaction=inner_circuit_transaction,
                    )
            except Exception as exc:  # noqa: BLE001 - formal result is committed.
                circuit_ablation_error = f"{type(exc).__name__}: {exc}"
        circuit_transformation_error = None
        if (
            inner_circuit_transaction is not None
            and circuit_ablation_trial is None
            and inner_infrastructure_ok
            and self.circuit_transformation_store is not None
            and inner_circuit_transaction.transformation_ids
        ):
            try:
                self.circuit_transformation_store.record_use(
                    transformation_ids=inner_circuit_transaction.transformation_ids,
                    epoch=epoch,
                    success=inner_result.accepted,
                    quality_delta=inner_result.median_delta or 0.0,
                    cost_penalty=(
                        0.0 if circuit_utility is None else circuit_utility.cost_penalty
                    ),
                    hard_regression=any(
                        delta < -self.inner_engine.config.max_case_regression
                        for delta in inner_result.paired_deltas
                    ),
                )
            except Exception as exc:  # noqa: BLE001 - formal inner result is committed.
                circuit_transformation_error = f"{type(exc).__name__}: {exc}"
        if (
            not inner_result.accepted
            and inner_infrastructure_ok
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
        transformation_library_update: TransformationLibraryUpdate | None = None
        if self.circuit_transformation_agent is not None and self.outer_enabled:
            transformation_revision = self.circuit_transformation_agent.store.revision()
            if not inner_infrastructure_ok:
                transformation_library_update = TransformationLibraryUpdate(
                    epoch=epoch,
                    status="failed_infrastructure_or_validation",
                    revision_before=transformation_revision,
                    revision_after=transformation_revision,
                    error=(
                        "inner epoch infrastructure failure excludes HPA "
                        "transformation evolution"
                    ),
                )
                self.circuit_transformation_agent.store.write_epoch_record(
                    epoch,
                    {
                        "schema_version": "hpa-transformation-evolution.v1",
                        **transformation_library_update.to_dict(),
                        "current_circuit": frozen_inner.effective_agent_circuit().to_dict(),
                        "completed_at": utc_now(),
                    },
                )
            else:
                try:
                    current_state = read_json(self.state_path)
                    transformation_library_update = (
                        self.circuit_transformation_agent.evolve(
                            epoch=epoch,
                            inner_history=list(current_state.get("epochs", [])),
                            latest_inner_result=inner_result,
                            current_circuit=frozen_inner.effective_agent_circuit(),
                            harness_catalog=self.inner_engine.role_harness_catalog(),
                        )
                    )
                except Exception as exc:  # noqa: BLE001 - inner result is committed.
                    transformation_library_update = TransformationLibraryUpdate(
                        epoch=epoch,
                        status="failed_infrastructure_or_validation",
                        revision_before=transformation_revision,
                        revision_after=self.circuit_transformation_agent.store.revision(),
                        error=f"{type(exc).__name__}: {exc}",
                    )
        outer_result: HarnessEpochResult | None = None
        outer_validation: dict[str, object]
        outer_gradient = None
        if self.outer_enabled and self.outer_library_agent is not None:
            outer_failure = outer_preparation_error or outer_usage_error
            if not inner_infrastructure_ok:
                outer_failure = (
                    outer_failure
                    or "inner epoch infrastructure failure excludes outer library evolution"
                )
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
                    transformation_actions = (
                        ()
                        if transformation_library_update is None
                        else transformation_library_update.actions
                    )
                    used_actions = len(transformation_actions)
                    used_additions = sum(
                        str(item.get("operation", "")) == "add"
                        for item in transformation_actions
                    )
                    remaining_actions = max(
                        0, self.hpa_max_structural_actions - used_actions
                    )
                    remaining_additions = max(
                        0, self.hpa_max_additions - used_additions
                    )
                    if remaining_actions == 0:
                        update = OuterLibraryUpdate(
                            epoch=epoch,
                            status="skipped_shared_hpa_action_budget",
                            revision_before=revision,
                            revision_after=revision,
                            shortlist=(),
                            operations=(),
                            additions=(),
                        )
                    else:
                        state = read_json(self.state_path)
                        original_actions = (
                            self.outer_library_agent.max_structural_actions
                        )
                        original_additions = self.outer_library_agent.max_additions
                        self.outer_library_agent.max_structural_actions = min(
                            original_actions, remaining_actions
                        )
                        self.outer_library_agent.max_additions = min(
                            original_additions,
                            remaining_additions,
                            self.outer_library_agent.max_structural_actions,
                        )
                        try:
                            update = self.outer_library_agent.evolve(
                                epoch=epoch,
                                inner_history=list(state.get("epochs", [])),
                                latest_inner_result=inner_result,
                                current_inner_element_ids=outer_element_ids_used,
                            )
                        finally:
                            self.outer_library_agent.max_structural_actions = (
                                original_actions
                            )
                            self.outer_library_agent.max_additions = original_additions
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
            transformation_applied = bool(
                transformation_library_update is not None
                and transformation_library_update.applied
            )
            transformation_error = (
                None
                if transformation_library_update is None
                else transformation_library_update.error
            )
            if transformation_error:
                outer_reasons.append(transformation_error)
            if not update.applied and not transformation_applied and not outer_reasons:
                outer_reasons.append(update.status)
                if transformation_library_update is not None:
                    outer_reasons.append(transformation_library_update.status)
            if engine_catalog_sync_error is not None:
                outer_reasons.append(engine_catalog_sync_error)
            outer_validation = {
                "accepted": update.applied or transformation_applied,
                "mode": "hpa_library_management",
                "inner_epoch_accepted": inner_result.accepted,
                "target_inner_harness_id": frozen_inner.harness_id,
                "record_element_stats": False,
                "library_update": update.to_dict(),
                "transformation_library_update": (
                    None
                    if transformation_library_update is None
                    else transformation_library_update.to_dict()
                ),
                "reasons": outer_reasons,
                "engine_catalog_sync_error": engine_catalog_sync_error,
                "created_at": utc_now(),
            }
            outer_result = HarnessEpochResult(
                epoch=epoch,
                parent_harness_id=outer_parent.harness_id,
                candidate_harness_id=outer_parent.harness_id,
                accepted=update.applied or transformation_applied,
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
            "inner_circuit_transaction": (
                None
                if inner_circuit_transaction is None
                else inner_circuit_transaction.to_dict()
            ),
            "circuit_ablation_trial": (
                None
                if circuit_ablation_trial is None
                else circuit_ablation_trial.to_dict()
            ),
            "circuit_ablation_error": circuit_ablation_error,
            "circuit_utility": (
                None
                if circuit_utility is None
                else {
                    "accepted": circuit_utility.accepted,
                    "quality_delta": circuit_utility.quality_delta,
                    "cost_penalty": circuit_utility.cost_penalty,
                    "net_utility": circuit_utility.net_utility,
                    "reasons": list(circuit_utility.reasons),
                }
            ),
            "circuit_transformation_error": circuit_transformation_error,
            "outer_gradient": None if outer_gradient is None else outer_gradient.to_dict(),
            "inner_rubric_validation": inner_rubric.to_dict(),
            "outer_element_ids_used_for_inner_proposal": list(outer_element_ids_used),
            "outer_element_usage_update": outer_usage_update,
            "outer_element_preparation_error": outer_preparation_error,
            "outer_element_usage_error": outer_usage_error,
            "legacy_outer_element_stats_error": legacy_outer_stats_error,
            "outer_element_library_update": outer_validation,
            "hpa_transformation_library_update": (
                None
                if transformation_library_update is None
                else transformation_library_update.to_dict()
            ),
            "completed_at": utc_now(),
        })
        atomic_write_json(self.state_path, state)
        journal_path.unlink(missing_ok=True)
        return result


def _propose_with_noop_retries(
    *,
    engine: HarnessEvolutionEngine,
    parent: HarnessProfile,
    gradient: HarnessSemanticGradient,
    epoch: int,
    excluded_candidate_ids: set[str] | None = None,
    excluded_behavior_signatures: set[tuple[object, ...]] | None = None,
) -> HarnessProfile:
    errors: list[str] = []
    rejected_candidate_ids = _rejected_candidate_ids_for_parent(
        engine=engine,
        parent=parent,
    )
    rejected_candidate_ids.update(excluded_candidate_ids or ())
    rejected_behavior_signatures = _rejected_behavior_signatures_for_parent(
        engine=engine,
        parent=parent,
    )
    rejected_behavior_signatures.update(excluded_behavior_signatures or ())
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
        candidate_signature = engine._behavior_signature(candidate)
        if (
            candidate.harness_id in rejected_candidate_ids
            or candidate_signature in rejected_behavior_signatures
        ):
            errors.append(
                f"attempt {attempt}: rejected candidate behavior replay "
                f"{candidate.harness_id} tags={list(candidate_gradient.target_tags)}"
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
        for category in (
            "dsh_plugin", "workflow", "mcp", "protocol", "context", "skill", "tool"
        )
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
