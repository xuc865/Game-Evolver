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
    InnerOutcomeOuterGradientProposer,
    build_agentx_nested_evolution,
)
from game_loop.core.attribution import AttributionReport
from game_loop.core.harness import HarnessEpochResult, HarnessProfile
from game_loop.core.outer_harness_library import OuterHarnessLibraryStore


def _profile(prefix: str) -> HarnessProfile:
    return HarnessProfile.from_dict({"harness_id": f"{prefix}-seed"})


class AgentXRuntimeTests(unittest.TestCase):
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
        self.assertIn("usage_driven", gradient.target_tags)

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
