from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from game_loop.config import HarnessEvolutionConfig
from game_loop.core.agentx import AgentXNestedEvolution, PairedOutcomes
from game_loop.core.agentx_runtime import (
    AttributionDrivenInnerGradientProposer,
    InnerOutcomeOuterGradientProposer,
)
from game_loop.core.attribution import AttributionReport
from game_loop.core.harness import (
    HarnessEpisodeOutcome,
    HarnessEvolutionEngine,
    HarnessReplayCase,
    HarnessSemanticGradient,
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


class AgentXNestedEvolutionTests(unittest.TestCase):
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
