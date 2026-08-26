from __future__ import annotations

import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from game_loop.config import HarnessEvolutionConfig
from game_loop.core.agentx import (
    AgentXNestedEvolution,
    PairedOutcomes,
    _rejected_behavior_signatures_for_parent,
    _rejected_candidate_ids_for_parent,
    _repeated_candidate_infrastructure_failures,
)
from game_loop.core.agentx_runtime import (
    AttributionDrivenInnerGradientProposer,
    EvidenceDrivenCircuitProposer,
    InnerOutcomeOuterGradientProposer,
)
from game_loop.core.agent_circuit_attribution import CircuitAblationQueue
from game_loop.core.attribution import AttributionReport
from game_loop.core.harness import (
    HarnessEpisodeOutcome,
    HarnessEvolutionEngine,
    HarnessReplayCase,
    HarnessSemanticGradient,
)
from game_loop.core.outer_harness_library import (
    OuterHarnessLibraryAgent,
    OuterHarnessLibraryStore,
)
from game_loop.core.harness_evolution_memory import (
    HarnessEvolutionMemory,
    HarnessRejectionExperience,
)
from game_loop.core.harness_transformation_library import (
    HarnessTransformationLibraryStore,
)
from game_loop.core.harness_transformation_agent import (
    HarnessTransformationLibraryAgent,
)
from game_loop.harness_element_catalog import (
    DEFAULT_OUTER_SEED_ELEMENTS,
    OUTER_ELEMENT_CATALOG,
)


def evolution_config(prefix: str) -> HarnessEvolutionConfig:
    return HarnessEvolutionConfig.from_dict({
        "modules": [
            {
                "id": f"{prefix}_base",
                "instruction": f"base {prefix} behavior",
                "tags": [f"{prefix}_base"],
            },
            {
                "id": f"{prefix}_improve",
                "instruction": f"improve {prefix} behavior",
                "tags": [f"{prefix}_improve"],
            },
        ],
        "seed_modules": [f"{prefix}_base"],
        "max_active_modules": 2,
        "max_active_tool_interfaces": 0,
        "mutation_width": 1,
        "replay_min_cases": 2,
        "promotion_delta_min": 0.05,
        "max_case_regression": 0.05,
        "require_rubric_validation": False,
    })


class DeterministicGradients:
    def propose_inner(self, report, *, proposer_harness, target_harness):
        self.inner_frozen_outer = proposer_harness.harness_id
        return HarnessSemanticGradient(
            "add an evidence-grounded inner rule",
            ("inner_improve",),
            report.run_refs,
        )

    def propose_outer(self, report, *, latest_inner_result, proposer_harness):
        self.latest_inner_accepted = latest_inner_result.accepted
        return HarnessSemanticGradient(
            "improve the harness-refinement contract",
            ("outer_improve",),
            report.run_refs,
        )


class DeterministicNestedOracle:
    """Explicit simulation oracle for protocol smoke; never presented as a real model."""

    def __init__(self):
        self.inner_proposer_ids = []
        self.outer_target_ids = []

    @staticmethod
    def _outcomes(cases, harness, score):
        return tuple(
            HarnessEpisodeOutcome(
                case.case_id,
                harness.harness_id,
                score,
                True,
                model_calls=2,
                evaluator_queries=1,
                allocated_model_calls=2,
                allocated_evaluator_queries=1,
                allocated_probe_calls=0,
            )
            for case in cases
        )

    def evaluate_inner(self, cases, *, parent, candidate, proposer_harness, epoch):
        del epoch
        self.inner_proposer_ids.append(proposer_harness.harness_id)
        return PairedOutcomes(
            self._outcomes(cases, parent, 0.50),
            self._outcomes(cases, candidate, 0.70),
        )

    def evaluate_outer(self, cases, *, parent, candidate, target_harness, epoch):
        del epoch
        self.outer_target_ids.append(target_harness.harness_id)
        return PairedOutcomes(
            self._outcomes(cases, parent, 0.40),
            self._outcomes(cases, candidate, 0.55),
        )


class CandidateInfrastructureFailureOracle(DeterministicNestedOracle):
    def evaluate_inner(self, cases, *, parent, candidate, proposer_harness, epoch):
        outcomes = super().evaluate_inner(
            cases,
            parent=parent,
            candidate=candidate,
            proposer_harness=proposer_harness,
            epoch=epoch,
        )
        return PairedOutcomes(
            outcomes.parent,
            tuple(
                HarnessEpisodeOutcome(
                    case_id=item.case_id,
                    harness_id=item.harness_id,
                    final_score=None,
                    feasible=item.feasible,
                    model_calls=item.model_calls,
                    evaluator_queries=0,
                    infrastructure_ok=False,
                )
                for item in outcomes.candidate
            ),
        )


class StudioThenEqualQualityOracle(DeterministicNestedOracle):
    def evaluate_inner(self, cases, *, parent, candidate, proposer_harness, epoch):
        del proposer_harness
        if epoch == 1:
            parent_score, candidate_score = 0.10, 0.90
        else:
            parent_score = candidate_score = 0.90
        return PairedOutcomes(
            self._outcomes(cases, parent, parent_score),
            self._outcomes(cases, candidate, candidate_score),
        )


class AgentXNestedEvolutionTests(unittest.TestCase):
    def test_accepted_studio_bundle_runs_persistent_cost_aware_ablation(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            inner_config = replace(
                evolution_config("inner"),
                enable_agent_circuit_evolution=True,
                circuit_max_actions=4,
                circuit_min_net_utility=0.0,
            )
            inner_engine = HarnessEvolutionEngine(root / "inner", inner_config)
            outer_engine = HarnessEvolutionEngine(
                root / "outer", evolution_config("outer")
            )
            transformation_store = HarnessTransformationLibraryStore(
                root / "nested" / "harness_transformation_library"
            )
            transformation_store.initialize()
            queue = CircuitAblationQueue(
                root / "inner" / "circuit_ablation.json"
            )
            coordinator = AgentXNestedEvolution(
                run_dir=root / "nested",
                inner_engine=inner_engine,
                outer_engine=outer_engine,
                inner_gradient_proposer=DeterministicGradients(),
                inner_circuit_proposer=EvidenceDrivenCircuitProposer(
                    transformation_store
                ),
                outer_gradient_proposer=DeterministicGradients(),
                replay_oracle=StudioThenEqualQualityOracle(),
                circuit_transformation_store=transformation_store,
                circuit_ablation_queue=queue,
            )
            coordinator.initialize()
            seed_id = inner_engine.champion().harness_id

            expansion = coordinator.run_epoch(
                epoch=1,
                report=self._report(),
                inner_cases=self._cases(),
                outer_cases=self._cases(),
            )
            self.assertTrue(expansion.inner.accepted)
            self.assertEqual(
                len(inner_engine.champion().effective_agent_circuit().roles), 5
            )
            self.assertEqual(queue.pending_count(), 2)

            ablation = coordinator.run_epoch(
                epoch=2,
                report=self._report(),
                inner_cases=self._cases(),
                outer_cases=self._cases(),
            )
            self.assertTrue(ablation.inner.accepted)
            self.assertEqual(inner_engine.champion().harness_id, seed_id)
            self.assertEqual(queue.pending_count(), 0)
            state = json.loads(
                (root / "nested" / "nested_evolution.json").read_text()
            )
            self.assertIsNotNone(state["epochs"][1]["circuit_ablation_trial"])
            self.assertLess(
                state["epochs"][1]["circuit_utility"]["cost_penalty"], 0
            )
            stats = transformation_store.stats()["single_to_studio"]
            self.assertEqual(stats.uses, 1)

    def test_resume_never_replays_an_inner_epoch_committed_before_hpa_crash(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            inner_engine = HarnessEvolutionEngine(
                root / "inner", evolution_config("inner")
            )
            outer_engine = HarnessEvolutionEngine(
                root / "outer", evolution_config("outer")
            )
            transformation_store = HarnessTransformationLibraryStore(
                root / "nested" / "harness_transformation_library"
            )
            transformation_store.initialize()

            def interrupted_hpa(_stage, _payload):
                raise KeyboardInterrupt("simulated process interruption")

            oracle = DeterministicNestedOracle()
            coordinator = AgentXNestedEvolution(
                run_dir=root / "nested",
                inner_engine=inner_engine,
                outer_engine=outer_engine,
                inner_gradient_proposer=DeterministicGradients(),
                outer_gradient_proposer=DeterministicGradients(),
                replay_oracle=oracle,
                circuit_transformation_store=transformation_store,
                circuit_transformation_agent=HarnessTransformationLibraryAgent(
                    transformation_store, interrupted_hpa
                ),
                outer_enabled=True,
            )
            coordinator.initialize()

            with self.assertRaises(KeyboardInterrupt):
                coordinator.run_epoch(
                    epoch=1,
                    report=self._report(),
                    inner_cases=self._cases(),
                    outer_cases=self._cases(),
                )

            journal = root / "nested" / "epoch_journals" / "epoch_001.json"
            self.assertEqual(json.loads(journal.read_text())["phase"], "inner_recorded")
            self.assertEqual(len(oracle.inner_proposer_ids), 1)
            coordinator.initialize()

            recovered = coordinator.run_epoch(
                epoch=1,
                report=self._report(),
                inner_cases=self._cases(),
                outer_cases=self._cases(),
            )

            self.assertTrue(recovered.inner.accepted)
            self.assertIsNone(recovered.outer)
            self.assertEqual(len(oracle.inner_proposer_ids), 1)
            self.assertFalse(journal.exists())
            inner_epochs = json.loads(
                (inner_engine.root / "epochs.json").read_text()
            )["items"]
            self.assertEqual(len(inner_epochs), 1)
            nested = json.loads(
                (root / "nested" / "nested_evolution.json").read_text()
            )
            self.assertEqual(len(nested["epochs"]), 1)
            self.assertTrue(nested["epochs"][0]["resume_recovery"]["recovered"])
            repeated = coordinator.run_epoch(
                epoch=1,
                report=self._report(),
                inner_cases=self._cases(),
                outer_cases=self._cases(),
            )
            self.assertEqual(repeated.inner, recovered.inner)
            self.assertEqual(len(oracle.inner_proposer_ids), 1)

    def test_rejected_candidate_blacklist_is_scoped_to_parent(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            engine = HarnessEvolutionEngine(root / "inner", evolution_config("inner"))
            parent = engine.initialize()
            memory = HarnessEvolutionMemory(engine.root)
            memory.append(HarnessRejectionExperience(
                epoch=32,
                loop_role="inner",
                parent_harness_id=parent.harness_id,
                candidate_harness_id="candidate-timeout",
                harness_delta_summary="workflow replacement timed out repeatedly",
                failed_tasks=("DeepSeek Harness turn timed out",),
                hard_rubric_misses=(),
                soft_regression_summary="not quality evidence",
                root_cause="repeated infrastructure timeout",
                do_not_repeat=("candidate-timeout",),
            ))
            memory.append(HarnessRejectionExperience(
                epoch=31,
                loop_role="inner",
                parent_harness_id="different-parent",
                candidate_harness_id="candidate-other-parent",
                harness_delta_summary="different branch",
                failed_tasks=(),
                hard_rubric_misses=(),
                soft_regression_summary="",
                root_cause="",
                do_not_repeat=(),
            ))

            blocked = _rejected_candidate_ids_for_parent(
                engine=engine,
                parent=parent,
            )

            self.assertEqual(blocked, {"candidate-timeout"})

    def test_rejected_behavior_blacklist_ignores_candidate_provenance(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            engine = HarnessEvolutionEngine(root / "inner", evolution_config("inner"))
            parent = engine.initialize()
            rejected = replace(
                parent,
                harness_id="candidate-timeout",
                parent_harness_id=parent.harness_id,
                active_modules=parent.active_modules + ("behavior-change",),
                generation=32,
                rationale="first provenance",
            )
            profile_path = (
                engine.root
                / "profiles"
                / f"{rejected.harness_id}.json"
            )
            profile_path.parent.mkdir(parents=True, exist_ok=True)
            profile_path.write_text(json.dumps(rejected.to_dict()), encoding="utf-8")
            HarnessEvolutionMemory(engine.root).append(
                HarnessRejectionExperience(
                    epoch=32,
                    loop_role="inner",
                    parent_harness_id=parent.harness_id,
                    candidate_harness_id=rejected.harness_id,
                    harness_delta_summary="timed out",
                    failed_tasks=("timeout",),
                    hard_rubric_misses=(),
                    soft_regression_summary="",
                    root_cause="timeout",
                    do_not_repeat=("timeout",),
                )
            )
            same_behavior_new_id = replace(
                rejected,
                harness_id="candidate-new-id",
                generation=33,
                rationale="different provenance",
            )

            blocked = _rejected_behavior_signatures_for_parent(
                engine=engine,
                parent=parent,
            )

            self.assertIn(engine._behavior_signature(same_behavior_new_id), blocked)

    def test_repeated_infrastructure_failures_only_exclude_proposal_replay(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            engine = HarnessEvolutionEngine(root / "inner", evolution_config("inner"))
            parent = engine.initialize()
            candidate = replace(
                parent,
                harness_id="candidate-infra-failure",
                parent_harness_id=parent.harness_id,
                active_modules=parent.active_modules + ("inner_improve",),
                generation=1,
                rationale="candidate-side infrastructure failure",
            )
            profile_path = engine.root / "profiles" / f"{candidate.harness_id}.json"
            profile_path.parent.mkdir(parents=True, exist_ok=True)
            profile_path.write_text(json.dumps(candidate.to_dict()), encoding="utf-8")
            failed_inner = {
                "parent_harness_id": parent.harness_id,
                "candidate_harness_id": candidate.harness_id,
                "candidate_outcomes": [{"infrastructure_ok": False}],
            }
            state = {
                "attempts": [
                    {"status": "FAILED_INFRA", "inner": failed_inner},
                    {"status": "FAILED_INFRA", "inner": failed_inner},
                ]
            }

            candidate_ids, signatures = _repeated_candidate_infrastructure_failures(
                state=state,
                engine=engine,
                parent=parent,
            )

            self.assertEqual(candidate_ids, {candidate.harness_id})
            self.assertEqual(signatures, {engine._behavior_signature(candidate)})
            archive = json.loads((engine.root / "epochs.json").read_text())
            self.assertEqual(archive["items"], [])

    @staticmethod
    def _outer_config_with_elements():
        return HarnessEvolutionConfig.from_dict({
            "modules": [
                {"id": "outer_base", "instruction": "outer base", "tags": ["context"]},
                {"id": "outer_alt", "instruction": "outer alt", "tags": ["strategy"]},
            ],
            "seed_modules": ["outer_base"],
            "max_active_modules": 2,
            "max_active_tool_interfaces": 0,
            "mutation_width": 1,
            "replay_min_cases": 2,
            "promotion_delta_min": 0.05,
            "max_case_regression": 0.05,
            "require_rubric_validation": False,
            "element_catalog": OUTER_ELEMENT_CATALOG,
            "seed_elements": DEFAULT_OUTER_SEED_ELEMENTS,
        })

    @staticmethod
    def _cases():
        return (
            HarnessReplayCase("case-a", "/task/a", "/seed/a"),
            HarnessReplayCase("case-b", "/task/b", "/seed/b"),
        )

    @staticmethod
    def _report():
        return AttributionReport(
            run_refs=("trace://one",),
            outcome_counts={"probe_failed": 2},
            repeated_failures=(),
            infrastructure_events=0,
        )

    def test_frozen_outer_library_records_metadata_without_api_call(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            inner_engine = HarnessEvolutionEngine(root / "inner", evolution_config("inner"))
            outer_engine = HarnessEvolutionEngine(
                root / "outer", self._outer_config_with_elements()
            )
            store = OuterHarnessLibraryStore(root / "nested" / "outer_element_library")

            def forbidden_request(_stage, _payload):
                raise AssertionError("frozen outer evolution must not call the API")

            coordinator = AgentXNestedEvolution(
                run_dir=root / "nested",
                inner_engine=inner_engine,
                outer_engine=outer_engine,
                inner_gradient_proposer=AttributionDrivenInnerGradientProposer(
                    outer_library_store=store
                ),
                outer_gradient_proposer=InnerOutcomeOuterGradientProposer(),
                replay_oracle=DeterministicNestedOracle(),
                outer_library_agent=OuterHarnessLibraryAgent(store, forbidden_request),
            )
            coordinator.initialize()
            seed_ids = {
                item.element_id for item in outer_engine.champion().active_elements
            }
            result = coordinator.run_epoch(
                epoch=1,
                report=self._report(),
                inner_cases=self._cases(),
                outer_cases=self._cases(),
            )
            self.assertIsNone(result.outer)
            metadata = store.metadata()
            self.assertTrue(seed_ids)
            self.assertTrue(all(metadata[item]["usage_count"] == 1 for item in seed_ids))
            state = json.loads((root / "nested" / "nested_evolution.json").read_text())
            epoch = state["epochs"][0]
            self.assertEqual(
                set(epoch["outer_element_ids_used_for_inner_proposal"]), seed_ids
            )
            self.assertEqual(
                epoch["outer_element_library_update"]["mode"],
                "outer_evolution_frozen_metadata_only",
            )

    def test_enabled_outer_library_runs_after_inner_and_api_failure_is_isolated(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            inner_engine = HarnessEvolutionEngine(root / "inner", evolution_config("inner"))
            outer_engine = HarnessEvolutionEngine(
                root / "outer", self._outer_config_with_elements()
            )
            store = OuterHarnessLibraryStore(root / "nested" / "outer_element_library")
            observed = {}

            def failing_request(stage, payload):
                observed["stage"] = stage
                observed["latest_inner_accepted"] = payload["latest_inner_result"]["accepted"]
                observed["usage_counts"] = {
                    item["id"]: item["usage"]["usage_count"]
                    for item in payload["catalog_index"]
                }
                raise TimeoutError("outer provider unavailable")

            coordinator = AgentXNestedEvolution(
                run_dir=root / "nested",
                inner_engine=inner_engine,
                outer_engine=outer_engine,
                inner_gradient_proposer=AttributionDrivenInnerGradientProposer(
                    outer_library_store=store
                ),
                outer_gradient_proposer=InnerOutcomeOuterGradientProposer(),
                replay_oracle=DeterministicNestedOracle(),
                outer_library_agent=OuterHarnessLibraryAgent(store, failing_request),
                outer_enabled=True,
            )
            coordinator.initialize()
            inner_seed = inner_engine.champion().harness_id
            result = coordinator.run_epoch(
                epoch=1,
                report=self._report(),
                inner_cases=self._cases(),
                outer_cases=self._cases(),
            )
            self.assertTrue(result.inner.accepted)
            self.assertNotEqual(inner_engine.champion().harness_id, inner_seed)
            self.assertFalse(result.outer.accepted)
            self.assertEqual(observed["stage"], "shortlist")
            self.assertTrue(observed["latest_inner_accepted"])
            self.assertGreater(max(observed["usage_counts"].values()), 0)
            self.assertEqual(store.revision(), 0)
            state = json.loads((root / "nested" / "nested_evolution.json").read_text())
            update = state["epochs"][0]["outer_element_library_update"]["library_update"]
            self.assertEqual(update["status"], "failed_infrastructure_or_validation")

    def test_hpa_transformation_update_is_part_of_outer_epoch(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            inner_engine = HarnessEvolutionEngine(root / "inner", evolution_config("inner"))
            outer_engine = HarnessEvolutionEngine(
                root / "outer", self._outer_config_with_elements()
            )
            outer_store = OuterHarnessLibraryStore(
                root / "nested" / "outer_element_library"
            )
            transformation_store = HarnessTransformationLibraryStore(
                root / "nested" / "harness_transformation_library"
            )
            transformation_store.initialize()

            def legacy_request(stage, _payload):
                raise AssertionError(
                    f"legacy HPA request must be skipped after shared budget use: {stage}"
                )

            def transformation_request(stage, _payload):
                if stage == "shortlist":
                    return {"shortlist": [], "addition_needed": True}
                return {
                    "actions": [
                        {
                            "action_id": "add_parallel_repair",
                            "operation": "add",
                            "rationale": "The paired replay retains a quality gap.",
                            "evidence_refs": ["inner://epoch/1/result"],
                            "payload": {
                                "transformation": {
                                    "id": "parallel_repair",
                                    "name": "Parallel repair",
                                    "description": "Split independent repairs and integrate typed patches.",
                                    "trigger_signals": ["regression"],
                                    "supported_operations": ["modify_role"],
                                    "plan_template": {
                                        "shape": "declarative_circuit",
                                        "actions": [{
                                            "action_id": "specialize_repair",
                                            "operation": "modify_role",
                                            "rationale": "Use the paired replay quality gap.",
                                            "payload": {
                                                "role_id": "$primary",
                                                "replacement": {
                                                    "inherit_from": "$primary",
                                                    "system_prompt": "Diagnose the regression, repair it, and verify the result.",
                                                    "capabilities": ["regression_repair"]
                                                }
                                            }
                                        }]
                                    },
                                }
                            },
                        }
                    ]
                }

            transformation_agent = HarnessTransformationLibraryAgent(
                transformation_store,
                transformation_request,
            )
            coordinator = AgentXNestedEvolution(
                run_dir=root / "nested",
                inner_engine=inner_engine,
                outer_engine=outer_engine,
                inner_gradient_proposer=AttributionDrivenInnerGradientProposer(
                    outer_library_store=outer_store
                ),
                outer_gradient_proposer=InnerOutcomeOuterGradientProposer(),
                replay_oracle=DeterministicNestedOracle(),
                outer_library_agent=OuterHarnessLibraryAgent(
                    outer_store, legacy_request
                ),
                circuit_transformation_store=transformation_store,
                circuit_transformation_agent=transformation_agent,
                hpa_max_structural_actions=1,
                hpa_max_additions=1,
                outer_enabled=True,
            )
            coordinator.initialize()

            epoch = coordinator.run_epoch(
                epoch=1,
                report=self._report(),
                inner_cases=self._cases(),
                outer_cases=self._cases(),
            )

            self.assertIsNotNone(epoch.outer)
            self.assertTrue(epoch.outer.accepted)  # type: ignore[union-attr]
            self.assertIn("parallel_repair", transformation_store.catalog())
            state = json.loads((root / "nested" / "nested_evolution.json").read_text())
            update = state["epochs"][0]["hpa_transformation_library_update"]
            self.assertEqual(update["status"], "applied")
            self.assertEqual(update["revision_after"], 1)
            legacy_update = state["epochs"][0]["outer_element_library_update"][
                "library_update"
            ]
            self.assertEqual(
                legacy_update["status"], "skipped_shared_hpa_action_budget"
            )

    def test_inner_infrastructure_failure_skips_outer_library_evolution(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            inner_engine = HarnessEvolutionEngine(root / "inner", evolution_config("inner"))
            outer_engine = HarnessEvolutionEngine(
                root / "outer", self._outer_config_with_elements()
            )
            store = OuterHarnessLibraryStore(root / "nested" / "outer_element_library")
            transformation_store = HarnessTransformationLibraryStore(
                root / "nested" / "harness_transformation_library"
            )
            transformation_store.initialize()
            api_called = False

            def request(_stage, _payload):
                nonlocal api_called
                api_called = True
                return {}

            coordinator = AgentXNestedEvolution(
                run_dir=root / "nested",
                inner_engine=inner_engine,
                outer_engine=outer_engine,
                inner_gradient_proposer=AttributionDrivenInnerGradientProposer(
                    outer_library_store=store
                ),
                outer_gradient_proposer=InnerOutcomeOuterGradientProposer(),
                replay_oracle=CandidateInfrastructureFailureOracle(),
                outer_library_agent=OuterHarnessLibraryAgent(store, request),
                circuit_transformation_store=transformation_store,
                circuit_transformation_agent=HarnessTransformationLibraryAgent(
                    transformation_store, request
                ),
                outer_enabled=True,
            )
            coordinator.initialize()
            result = coordinator.run_epoch(
                epoch=1,
                report=self._report(),
                inner_cases=self._cases(),
                outer_cases=self._cases(),
            )

            self.assertTrue(
                any(not item.infrastructure_ok for item in result.inner.candidate_outcomes)
            )
            self.assertIsNone(result.outer)
            self.assertFalse(api_called)
            self.assertEqual(store.revision(), 0)
            state = json.loads((root / "nested" / "nested_evolution.json").read_text())
            self.assertEqual(state["epochs"], [])
            self.assertEqual(state["attempts"][0]["status"], "FAILED_INFRA")
            self.assertEqual(
                json.loads((root / "inner" / "harness_archive" / "epochs.json").read_text())["items"],
                [],
            )
            self.assertFalse(
                (transformation_store.epochs_dir / "epoch_001.json").exists()
            )

    def test_outer_metadata_failure_does_not_invalidate_completed_inner_epoch(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            inner_engine = HarnessEvolutionEngine(root / "inner", evolution_config("inner"))
            outer_engine = HarnessEvolutionEngine(
                root / "outer", self._outer_config_with_elements()
            )
            store = OuterHarnessLibraryStore(root / "nested" / "outer_element_library")
            api_called = False

            def request(_stage, _payload):
                nonlocal api_called
                api_called = True
                return {}

            coordinator = AgentXNestedEvolution(
                run_dir=root / "nested",
                inner_engine=inner_engine,
                outer_engine=outer_engine,
                inner_gradient_proposer=AttributionDrivenInnerGradientProposer(
                    outer_library_store=store
                ),
                outer_gradient_proposer=InnerOutcomeOuterGradientProposer(),
                replay_oracle=DeterministicNestedOracle(),
                outer_library_agent=OuterHarnessLibraryAgent(store, request),
                outer_enabled=True,
            )
            coordinator.initialize()
            inner_seed = inner_engine.champion().harness_id
            with mock.patch.object(
                store,
                "record_inner_epoch",
                side_effect=OSError("simulated metadata disk failure"),
            ):
                result = coordinator.run_epoch(
                    epoch=1,
                    report=self._report(),
                    inner_cases=self._cases(),
                    outer_cases=self._cases(),
                )
            self.assertTrue(result.inner.accepted)
            self.assertNotEqual(inner_engine.champion().harness_id, inner_seed)
            self.assertFalse(result.outer.accepted)
            self.assertFalse(api_called)
            state = json.loads((root / "nested" / "nested_evolution.json").read_text())
            self.assertIn(
                "simulated metadata disk failure",
                state["epochs"][0]["outer_element_usage_error"],
            )

    def test_enabled_outer_library_applies_complete_unchanged_plan(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            inner_engine = HarnessEvolutionEngine(root / "inner", evolution_config("inner"))
            outer_engine = HarnessEvolutionEngine(
                root / "outer", self._outer_config_with_elements()
            )
            store = OuterHarnessLibraryStore(root / "nested" / "outer_element_library")
            stages = []

            def request(stage, payload):
                stages.append(stage)
                if stage == "shortlist":
                    return {"shortlist": [payload["catalog_index"][0]["id"]]}
                return {
                    "operations": [
                        {"element_id": element_id, "operation": "unchanged"}
                        for element_id in payload["all_element_ids"]
                    ],
                    "additions": [],
                }

            coordinator = AgentXNestedEvolution(
                run_dir=root / "nested",
                inner_engine=inner_engine,
                outer_engine=outer_engine,
                inner_gradient_proposer=AttributionDrivenInnerGradientProposer(
                    outer_library_store=store
                ),
                outer_gradient_proposer=InnerOutcomeOuterGradientProposer(),
                replay_oracle=DeterministicNestedOracle(),
                outer_library_agent=OuterHarnessLibraryAgent(store, request),
                outer_enabled=True,
            )
            coordinator.initialize()
            outer_seed = outer_engine.champion().harness_id
            result = coordinator.run_epoch(
                epoch=1,
                report=self._report(),
                inner_cases=self._cases(),
                outer_cases=self._cases(),
            )
            self.assertEqual(stages, ["shortlist", "plan"])
            self.assertTrue(result.outer.accepted)
            self.assertEqual(result.outer.parent_harness_id, outer_seed)
            self.assertEqual(result.outer.candidate_harness_id, outer_seed)
            self.assertEqual(store.revision(), 0)
            record = json.loads(
                (store.epochs_dir / "epoch_001.json").read_text()
            )
            self.assertEqual(record["status"], "unchanged")

    def test_outer_audit_write_failure_is_recorded_in_nested_state(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            inner_engine = HarnessEvolutionEngine(root / "inner", evolution_config("inner"))
            outer_engine = HarnessEvolutionEngine(
                root / "outer", self._outer_config_with_elements()
            )
            store = OuterHarnessLibraryStore(root / "nested" / "outer_element_library")

            def request(stage, payload):
                if stage == "shortlist":
                    return {"shortlist": [payload["catalog_index"][0]["id"]]}
                return {
                    "operations": [
                        {"element_id": element_id, "operation": "unchanged"}
                        for element_id in payload["all_element_ids"]
                    ],
                    "additions": [],
                }

            coordinator = AgentXNestedEvolution(
                run_dir=root / "nested",
                inner_engine=inner_engine,
                outer_engine=outer_engine,
                inner_gradient_proposer=AttributionDrivenInnerGradientProposer(
                    outer_library_store=store
                ),
                outer_gradient_proposer=InnerOutcomeOuterGradientProposer(),
                replay_oracle=DeterministicNestedOracle(),
                outer_library_agent=OuterHarnessLibraryAgent(store, request),
                outer_enabled=True,
            )
            coordinator.initialize()
            real_write = store.write_epoch_record
            write_count = 0

            def fail_final_write(epoch, payload):
                nonlocal write_count
                write_count += 1
                if write_count == 3:
                    raise OSError("simulated outer audit failure")
                return real_write(epoch, payload)

            with mock.patch.object(store, "write_epoch_record", fail_final_write):
                result = coordinator.run_epoch(
                    epoch=1,
                    report=self._report(),
                    inner_cases=self._cases(),
                    outer_cases=self._cases(),
                )
            self.assertTrue(result.inner.accepted)
            self.assertTrue(result.outer.accepted)
            self.assertEqual(store.revision(), 0)
            state = json.loads((root / "nested" / "nested_evolution.json").read_text())
            validation = state["epochs"][0]["outer_element_library_update"]
            self.assertIn("audit_record_error", validation["library_update"]["error"])
            self.assertIn("audit_record_error", validation["reasons"][0])

    def test_inner_and_outer_harnesses_promote_only_after_separate_paired_replays(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            gradients = DeterministicGradients()
            oracle = DeterministicNestedOracle()
            inner_engine = HarnessEvolutionEngine(root / "inner", evolution_config("inner"))
            outer_engine = HarnessEvolutionEngine(root / "outer", evolution_config("outer"))
            coordinator = AgentXNestedEvolution(
                run_dir=root / "nested",
                inner_engine=inner_engine,
                outer_engine=outer_engine,
                inner_gradient_proposer=gradients,
                outer_gradient_proposer=gradients,
                replay_oracle=oracle,
                outer_enabled=True,
            )
            coordinator.initialize()
            inner_seed = inner_engine.champion().harness_id
            outer_seed = outer_engine.champion().harness_id
            cases = (
                HarnessReplayCase("case-a", "/task/a", "/seed/a"),
                HarnessReplayCase("case-b", "/task/b", "/seed/b"),
            )
            report = AttributionReport(
                run_refs=("trace://one",),
                outcome_counts={"probe_failed": 2},
                repeated_failures=(),
                infrastructure_events=0,
            )
            result = coordinator.run_epoch(
                epoch=1,
                report=report,
                inner_cases=cases,
                outer_cases=cases,
            )

            self.assertTrue(result.inner.accepted)
            self.assertTrue(result.outer.accepted)
            self.assertNotEqual(inner_engine.champion().harness_id, inner_seed)
            self.assertNotEqual(outer_engine.champion().harness_id, outer_seed)
            self.assertEqual(result.inner_proposer_harness_id, outer_seed)
            self.assertEqual(oracle.inner_proposer_ids, [outer_seed])
            self.assertEqual(oracle.outer_target_ids, [])
            self.assertTrue(gradients.latest_inner_accepted)
            state = json.loads((root / "nested" / "nested_evolution.json").read_text())
            self.assertEqual(state["schema_version"], "agentx-nested-evolution.v1")
            self.assertEqual(len(state["epochs"]), 1)
            for delta in state["epochs"][0]["inner"]["paired_deltas"]:
                self.assertAlmostEqual(delta, 0.2)
            self.assertIsNone(state["epochs"][0]["outer"]["median_delta"])
            self.assertEqual(
                state["epochs"][0]["outer_element_library_update"]["mode"],
                "outer_element_library_management",
            )

    def test_outer_evolution_is_disabled_by_default(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            gradients = DeterministicGradients()
            oracle = DeterministicNestedOracle()
            inner_engine = HarnessEvolutionEngine(root / "inner", evolution_config("inner"))
            outer_engine = HarnessEvolutionEngine(root / "outer", evolution_config("outer"))
            coordinator = AgentXNestedEvolution(
                run_dir=root / "nested",
                inner_engine=inner_engine,
                outer_engine=outer_engine,
                inner_gradient_proposer=gradients,
                outer_gradient_proposer=gradients,
                replay_oracle=oracle,
            )
            coordinator.initialize()
            cases = (
                HarnessReplayCase("case-a", "/task/a", "/seed/a"),
                HarnessReplayCase("case-b", "/task/b", "/seed/b"),
            )
            report = AttributionReport(
                run_refs=("trace://one",),
                outcome_counts={"probe_failed": 2},
                repeated_failures=(),
                infrastructure_events=0,
            )
            result = coordinator.run_epoch(
                epoch=1,
                report=report,
                inner_cases=cases,
                outer_cases=cases,
            )

            self.assertTrue(result.inner.accepted)
            self.assertIsNone(result.outer)
            state = json.loads((root / "nested" / "nested_evolution.json").read_text())
            self.assertIsNone(state["epochs"][0]["outer"])
            self.assertEqual(
                state["epochs"][0]["outer_element_library_update"]["mode"],
                "outer_evolution_disabled",
            )
            self.assertEqual(oracle.outer_target_ids, [])

    def test_outer_elements_drive_inner_proposal_and_stats_without_outer_replay(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            inner_engine = HarnessEvolutionEngine(root / "inner", evolution_config("inner"))
            outer_config = HarnessEvolutionConfig.from_dict({
                "modules": [
                    {"id": "outer_base", "instruction": "outer base", "tags": ["context"]},
                    {"id": "outer_alt", "instruction": "outer alt", "tags": ["strategy"]},
                ],
                "seed_modules": ["outer_base"],
                "max_active_modules": 2,
                "max_active_tool_interfaces": 0,
                "mutation_width": 1,
                "replay_min_cases": 1,
                "require_rubric_validation": False,
                "enable_usage_driven_mutation": True,
                "element_catalog": OUTER_ELEMENT_CATALOG,
                "seed_elements": DEFAULT_OUTER_SEED_ELEMENTS,
            })
            outer_engine = HarnessEvolutionEngine(root / "outer", outer_config)
            oracle = DeterministicNestedOracle()
            coordinator = AgentXNestedEvolution(
                run_dir=root / "nested",
                inner_engine=inner_engine,
                outer_engine=outer_engine,
                inner_gradient_proposer=AttributionDrivenInnerGradientProposer(),
                outer_gradient_proposer=InnerOutcomeOuterGradientProposer(),
                replay_oracle=oracle,
                outer_enabled=True,
            )
            coordinator.initialize()
            outer_seed = outer_engine.champion()
            report = AttributionReport(
                run_refs=("trace://one",),
                outcome_counts={"probe_failed": 2},
                repeated_failures=(),
                infrastructure_events=0,
            )

            result = coordinator.run_epoch(
                epoch=1,
                report=report,
                inner_cases=(
                    HarnessReplayCase("case-a", "/task/a", "/seed/a"),
                    HarnessReplayCase("case-b", "/task/b", "/seed/b"),
                ),
                outer_cases=(
                    HarnessReplayCase("outer-a", "/task/a", "/seed/a"),
                ),
            )

            state = json.loads((root / "nested" / "nested_evolution.json").read_text())
            inner_tags = set(state["epochs"][0]["inner_gradient"]["target_tags"])
            self.assertIn("usage_driven", inner_tags)
            self.assertIn("element_add", inner_tags)
            self.assertEqual(oracle.outer_target_ids, [])
            self.assertTrue(result.outer.accepted)
            self.assertEqual(result.outer.paired_deltas, ())
            stats = json.loads(
                (root / "outer" / "harness_archive" / "element_stats.json").read_text()
            )
            for element in outer_seed.active_elements:
                key = f"{element.category}:{element.element_id}"
                self.assertEqual(stats["items"][key]["usage_count"], 1)
                self.assertEqual(stats["items"][key]["success_count"], 1)

    def test_nested_framework_rejects_wide_non_agentx_mutations(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            wide = HarnessEvolutionConfig.from_dict({
                "modules": [
                    {"id": "a", "instruction": "a", "tags": []},
                    {"id": "b", "instruction": "b", "tags": []},
                ],
                "seed_modules": [],
                "max_active_modules": 2,
                "mutation_width": 2,
                "replay_min_cases": 1,
            })
            with self.assertRaisesRegex(ValueError, "mutation_width=1"):
                AgentXNestedEvolution(
                    run_dir=root / "nested",
                    inner_engine=HarnessEvolutionEngine(root / "inner", wide),
                    outer_engine=HarnessEvolutionEngine(root / "outer", wide),
                    inner_gradient_proposer=DeterministicGradients(),
                    outer_gradient_proposer=DeterministicGradients(),
                    replay_oracle=DeterministicNestedOracle(),
                )


if __name__ == "__main__":
    unittest.main()
