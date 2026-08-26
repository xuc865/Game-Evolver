from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from game_loop.config import HarnessElementConfig, HarnessEvolutionConfig
from game_loop.cli import _resolve_inner_outer_harness_configs
from game_loop.core.agentx_runtime import (
    AgentXRuntimeConfig,
    AttributionDrivenInnerGradientProposer,
    EvidenceDrivenCircuitProposer,
    InnerOutcomeOuterGradientProposer,
    build_agentx_nested_evolution,
)
from game_loop.core.attribution import AttributionReport
from game_loop.core.agent_circuit_evolution import CircuitMutationEngine
from game_loop.core.harness import HarnessEpochResult, HarnessProfile
from game_loop.core.outer_harness_library import OuterHarnessLibraryStore


def _profile(prefix: str) -> HarnessProfile:
    return HarnessProfile.from_dict({"harness_id": f"{prefix}-seed"})


class AgentXRuntimeTests(unittest.TestCase):
    @staticmethod
    def _builder_configs(*, circuit_evolution: bool):
        inner = HarnessEvolutionConfig.from_dict({
            "modules": [{"id": "inner", "instruction": "inner", "tags": []}],
            "seed_modules": ["inner"],
            "max_active_modules": 1,
            "mutation_width": 1,
            "replay_min_cases": 1,
            "require_rubric_validation": False,
            "enable_agent_circuit_evolution": circuit_evolution,
            "circuit_max_actions": 3,
            "circuit_bundle_width": 1,
        })
        outer = HarnessEvolutionConfig.from_dict({
            "modules": [{"id": "outer", "instruction": "outer", "tags": []}],
            "seed_modules": ["outer"],
            "max_active_modules": 1,
            "mutation_width": 1,
            "replay_min_cases": 1,
            "require_rubric_validation": False,
        })
        return inner, outer

    def test_builder_keeps_circuit_evolution_off_for_legacy_runs(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            inner, outer = self._builder_configs(circuit_evolution=False)
            app_config = mock.Mock()
            app_config.backend.runtime_profile_value = {}
            coordinator = build_agentx_nested_evolution(
                run_dir=root / "legacy-circuit-run",
                runtime=AgentXRuntimeConfig(
                    inner_harness=inner,
                    outer_harness=outer,
                    app_config=app_config,
                    task_source=root / "task",
                    seed_artifact=root / "seed",
                ),
                init_handler=mock.Mock(),
                evolve_handler=mock.Mock(),
            )
            self.assertIsNone(coordinator.inner_circuit_proposer)
            self.assertFalse((root / "legacy-circuit-run" / "harness_transformation_library").exists())

    def test_builder_starts_without_a_source_defined_team_roster(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            inner, outer = self._builder_configs(circuit_evolution=True)
            app_config = mock.Mock()
            app_config.backend.runtime_profile_value = {}
            coordinator = build_agentx_nested_evolution(
                run_dir=root / "studio-circuit-run",
                runtime=AgentXRuntimeConfig(
                    inner_harness=inner,
                    outer_harness=outer,
                    app_config=app_config,
                    task_source=root / "task",
                    seed_artifact=root / "seed",
                ),
                init_handler=mock.Mock(),
                evolve_handler=mock.Mock(),
            )
            proposer = coordinator.inner_circuit_proposer
            self.assertIsInstance(proposer, EvidenceDrivenCircuitProposer)
            self.assertEqual(proposer.max_actions, 3)
            self.assertEqual(proposer.bundle_width, 1)
            self.assertEqual(
                coordinator.circuit_transformation_agent.max_structural_actions,
                1,
            )
            self.assertEqual(
                coordinator.circuit_transformation_agent.max_circuit_actions,
                3,
            )
            parent = coordinator.inner_engine.initialize()
            transaction = proposer.propose_circuit(
                AttributionReport(("trace://quality-gap",), {}, (), 0),
                proposer_harness=_profile("outer"),
                target_harness=parent,
            )
            self.assertIsNone(transaction)
            self.assertEqual(coordinator.circuit_transformation_store.catalog(), {})

    def test_circuit_proposer_bundles_evidence_linked_transformations(self):
        with tempfile.TemporaryDirectory() as td:
            from game_loop.core.harness_transformation_library import (
                HarnessTransformationLibraryStore,
            )

            store = HarnessTransformationLibraryStore(Path(td) / "transformations")
            store.initialize()
            proposer = EvidenceDrivenCircuitProposer(
                store,
                max_actions=4,
                bundle_width=3,
            )
            target = _profile("singleton")
            transaction = proposer.propose_circuit(
                AttributionReport(
                    ("trace://cross-domain-handoff",),
                    {"probe_failed": 1, "handoff_ambiguity": 1},
                    (),
                    0,
                ),
                proposer_harness=_profile("outer"),
                target_harness=target,
            )
            self.assertIsNotNone(transaction)
            self.assertEqual(
                transaction.transformation_ids,
                ("single_to_studio", "tighten_artifact_handoff"),
            )
            self.assertEqual(len(transaction.actions), 4)
            self.assertEqual(len({item.action_id for item in transaction.actions}), 4)
            studio_actions = {
                item.action_id
                for item in transaction.actions
                if item.action_id.startswith("b1_single_to_studio_")
            }
            mailbox_actions = [
                item
                for item in transaction.actions
                if item.action_id.startswith("b2_tighten_artifact_handoff_")
            ]
            self.assertTrue(studio_actions)
            self.assertTrue(mailbox_actions)
            self.assertTrue(set(mailbox_actions[0].depends_on) <= studio_actions)
            candidate = CircuitMutationEngine().apply(
                target.effective_agent_circuit(), transaction
            )
            self.assertEqual(len(candidate.roles), 5)
            self.assertTrue(
                any(role.context.mode == "selected_artifacts" for role in candidate.roles)
            )

    def test_circuit_proposer_respects_action_cap_and_shared_evidence(self):
        with tempfile.TemporaryDirectory() as td:
            from game_loop.core.harness_transformation_library import (
                HarnessTransformationLibraryStore,
            )

            store = HarnessTransformationLibraryStore(Path(td) / "transformations")
            store.initialize()
            proposer = EvidenceDrivenCircuitProposer(
                store,
                max_actions=3,
                bundle_width=3,
            )
            transaction = proposer.propose_circuit(
                AttributionReport(
                    ("trace://quality-and-handoff",),
                    {"probe_failed": 1, "handoff_ambiguity": 1},
                    (),
                    0,
                ),
                proposer_harness=_profile("outer"),
                target_harness=_profile("singleton"),
            )
            self.assertIsNotNone(transaction)
            self.assertEqual(transaction.transformation_ids, ("single_to_studio",))
            self.assertLessEqual(len(transaction.actions), 3)

    def test_attribution_report_normalizes_single_string_reference(self):
        report = AttributionReport("trace://one", {}, (), 0)  # type: ignore[arg-type]
        self.assertEqual(report.run_refs, ("trace://one",))

    def test_builder_initializes_outer_library_for_legacy_nested_run(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            inner = HarnessEvolutionConfig.from_dict({
                "modules": [{"id": "inner", "instruction": "inner", "tags": []}],
                "seed_modules": ["inner"],
                "max_active_modules": 1,
                "mutation_width": 1,
                "replay_min_cases": 1,
                "require_rubric_validation": False,
            })
            outer = HarnessEvolutionConfig.from_dict({
                "modules": [{"id": "outer", "instruction": "outer", "tags": []}],
                "seed_modules": ["outer"],
                "max_active_modules": 1,
                "mutation_width": 1,
                "replay_min_cases": 1,
                "require_rubric_validation": False,
                "element_catalog": [
                    {
                        "id": "outer_element",
                        "category": "workflow",
                        "description": "outer element",
                        "spec": {"inner_tags": ["outer_signal"]},
                        "tags": ["workflow"],
                    }
                ],
                "seed_elements": {"workflow": ["outer_element"]},
            })
            coordinator = build_agentx_nested_evolution(
                run_dir=root / "legacy-run",
                runtime=AgentXRuntimeConfig(
                    inner_harness=inner,
                    outer_harness=outer,
                    app_config=mock.Mock(),
                    task_source=root / "task",
                    seed_artifact=root / "seed",
                ),
                init_handler=mock.Mock(),
                evolve_handler=mock.Mock(),
            )
            store = coordinator.outer_library_agent.store
            self.assertTrue(store.catalog_path.is_file())
            self.assertEqual(set(store.catalog()), {"outer_element"})

    def test_default_nested_configs_are_cli_resolvable(self):
        inner, outer = _resolve_inner_outer_harness_configs(
            None,
            inner_config=None,
            outer_config=None,
            bench="gcbench",
        )
        self.assertEqual(inner.loop_role, "inner")
        self.assertEqual(outer.loop_role, "outer")
        self.assertTrue(outer.element_catalog)

    def test_inner_gradient_uses_only_latest_progressively_selected_outer_details(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            selected = HarnessElementConfig.from_dict({
                "id": "selected",
                "category": "context",
                "description": "selected details",
                "spec": {"inner_tags": ["outer_selected_signal"]},
                "tags": ["context"],
            })
            store.initialize((selected,))
            store.write_epoch_record(1, {
                "status": "unchanged",
                "shortlist": ["selected"],
                "plan": {
                    "operations": [
                        {"element_id": "selected", "operation": "unchanged"}
                    ],
                    "additions": [],
                },
            })
            proposer = AttributionDrivenInnerGradientProposer(
                outer_library_store=store
            )
            gradient = proposer.propose_inner(
                AttributionReport(("trace://one",), {}, (), 0),
                proposer_harness=_profile("outer"),
                target_harness=_profile("inner"),
            )
            self.assertIn("outer_selected_signal", gradient.target_tags)

    def test_inner_gradient_targets_probe_failures(self):
        proposer = AttributionDrivenInnerGradientProposer()
        gradient = proposer.propose_inner(
            AttributionReport(("trace://one",), {"probe_failed": 3}, (), 0),
            proposer_harness=_profile("outer"),
            target_harness=_profile("inner"),
        )
        self.assertIn("skill", gradient.target_tags)

    def test_hpa_prioritizes_validated_dsh_plugins_for_dsh_goa(self):
        proposer = AttributionDrivenInnerGradientProposer(
            dsh_plugin_evolution=True
        )
        gradient = proposer.propose_inner(
            AttributionReport(("trace://one",), {}, (), 0),
            proposer_harness=_profile("outer"),
            target_harness=_profile("inner"),
        )
        self.assertEqual(gradient.target_tags[0], "dsh_plugin")
        self.assertIn("DeepSeek Harness", gradient.diagnosis)
        self.assertIn("soft marginal costs", gradient.diagnosis)
        self.assertIn("usage_driven", gradient.target_tags)

    def test_hpa_keeps_prioritizing_dsh_plugins_until_catalog_target(self):
        proposer = AttributionDrivenInnerGradientProposer(
            dsh_plugin_evolution=True,
            dsh_plugin_target_count=4,
        )
        target = HarnessProfile.from_dict({
            "harness_id": "inner-with-two-plugins",
            "active_elements": [
                {
                    "element_id": f"dsh-plugin-{index}",
                    "category": "dsh_plugin",
                    "description": "audited DSH feature bundle",
                    "spec": {"plugin_id": f"bundle-{index}"},
                }
                for index in range(2)
            ],
        })
        gradient = proposer.propose_inner(
            AttributionReport(("trace://one",), {}, (), 0),
            proposer_harness=_profile("outer"),
            target_harness=target,
        )
        self.assertEqual(gradient.target_tags[0], "dsh_plugin")
        self.assertEqual(gradient.target_tags[1], "element_add")

    def test_builder_uses_audited_dsh_catalog_as_natural_activation_boundary(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            dsh_elements = [
                {
                    "id": f"dsh_plugin_{plugin_id}",
                    "category": "dsh_plugin",
                    "description": f"audited {plugin_id}",
                    "spec": {"plugin_id": plugin_id},
                    "tags": ["dsh_plugin"],
                }
                for plugin_id in ("one", "two", "three")
            ]
            inner = HarnessEvolutionConfig.from_dict({
                "modules": [{"id": "inner", "instruction": "inner", "tags": []}],
                "seed_modules": ["inner"],
                "max_active_modules": 1,
                "mutation_width": 1,
                "replay_min_cases": 1,
                "require_rubric_validation": False,
                "element_catalog": dsh_elements,
                "max_active_elements": {"dsh_plugin": 1},
            })
            outer = HarnessEvolutionConfig.from_dict({
                "modules": [{"id": "outer", "instruction": "outer", "tags": []}],
                "seed_modules": ["outer"],
                "max_active_modules": 1,
                "mutation_width": 1,
                "replay_min_cases": 1,
                "require_rubric_validation": False,
            })
            app_config = mock.Mock()
            app_config.backend.runtime_profile_value = {
                "cordis_plugin_catalog": {
                    plugin_id: {"path": f"plugins/{plugin_id}.ts"}
                    for plugin_id in ("one", "two", "three")
                }
            }
            coordinator = build_agentx_nested_evolution(
                run_dir=root / "dsh-run",
                runtime=AgentXRuntimeConfig(
                    inner_harness=inner,
                    outer_harness=outer,
                    app_config=app_config,
                    task_source=root / "task",
                    seed_artifact=root / "seed",
                ),
                init_handler=mock.Mock(),
                evolve_handler=mock.Mock(),
            )
            self.assertEqual(
                coordinator.inner_engine.config.max_active_elements["dsh_plugin"],
                3,
            )
            self.assertEqual(
                coordinator.inner_gradient_proposer.dsh_plugin_target_count,
                3,
            )

    def test_outer_gradient_reacts_to_rejected_inner_epoch(self):
        proposer = InnerOutcomeOuterGradientProposer()
        gradient = proposer.propose_outer(
            AttributionReport(("trace://one",), {}, (), 0),
            latest_inner_result=HarnessEpochResult(
                epoch=1,
                parent_harness_id="p",
                candidate_harness_id="c",
                accepted=False,
                paired_deltas=(-0.1,),
                median_delta=-0.1,
                reasons=("replay_rejected",),
                excluded_pairs=(),
                parent_outcomes=(),
                candidate_outcomes=(),
                created_at="2026-01-01T00:00:00Z",
            ),
            proposer_harness=_profile("outer"),
        )
        self.assertIn("context", gradient.target_tags)
        self.assertIn("usage_driven", gradient.target_tags)


if __name__ == "__main__":
    unittest.main()
