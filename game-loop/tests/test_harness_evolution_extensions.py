from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from game_loop.config import HarnessElementConfig, HarnessEvolutionConfig
from game_loop.core.harness import (
    ContextCompilerPolicy,
    HarnessActiveElement,
    HarnessProfile,
    RecoveryPolicy,
    ValidationPolicy,
)
from game_loop.core.harness_element_stats import (
    HarnessElementStatsStore,
    compose_merged_element,
    element_similarity,
    mutate_category_elements,
    resolve_target_category,
)
from game_loop.core.harness_evolution_loop import HarnessBenchLoopRunner
from game_loop.core.harness_rubric_generator import generate_dynamic_rubric_set
from game_loop.core.harness_rubric_validator import TaskPoolEntry
from game_loop.harness_element_catalog import INNER_ELEMENT_CATALOG


def _profile(*, elements: tuple[HarnessActiveElement, ...] = ()) -> HarnessProfile:
    return HarnessProfile(
        harness_id="h-test",
        parent_harness_id=None,
        active_modules=("evidence_first",),
        active_tool_interfaces=(),
        active_elements=elements,
        context_compiler=ContextCompilerPolicy(),
        recovery_policy=RecoveryPolicy(),
        validation_policy=ValidationPolicy(),
        generation=1,
        rationale="test",
        created_at="now",
    )


def _element(element_id: str) -> HarnessActiveElement:
    spec = next(item for item in INNER_ELEMENT_CATALOG if item["id"] == element_id)
    return HarnessActiveElement.from_config(HarnessElementConfig.from_dict(spec))


def _catalog() -> dict[str, HarnessElementConfig]:
    return {
        item.element_id: item
        for item in (
            HarnessElementConfig.from_dict(spec) for spec in INNER_ELEMENT_CATALOG
        )
    }


class DynamicRubricGeneratorTests(unittest.TestCase):
    def test_generates_task_and_harness_specific_rubrics_without_official_leakage(self):
        with tempfile.TemporaryDirectory() as td:
            task = Path(td) / "task"
            task.mkdir()
            (task / "instruction.md").write_text(
                "Build a pygame game with player controls and score UI.",
                encoding="utf-8",
            )
            rubric = generate_dynamic_rubric_set(
                task_ref=task,
                benchmark_id="gcbench",
                harness_profile=_profile(
                    elements=(
                        _element("skill_runtime_smoke"),
                        _element("tool_entrypoint_discover"),
                        _element("wf_plan_patch_verify"),
                    )
                ),
                loop_role="inner",
            )
            self.assertGreaterEqual(len(rubric.hard_rubrics), 3)
            self.assertGreaterEqual(len(rubric.soft_rubrics), 4)
            blob = rubric.to_dict()
            text = str(blob).lower()
            self.assertNotIn("primary_score", text)
            self.assertNotIn("hidden rubric", text)
            self.assertIn("skill", rubric.harness_focus)
            soft_ids = {item.rubric_id for item in rubric.soft_rubrics}
            self.assertEqual(soft_ids, {
                "public_feature_completion",
                "core_gameplay_depth",
                "interaction_correctness",
                "progression_and_end_state",
                "playability_and_balance",
                "runtime_feedback_quality",
                "demo_coverage",
            })
            self.assertAlmostEqual(sum(item.weight for item in rubric.soft_rubrics), 1.0)
            self.assertFalse(any(
                token in rubric_id
                for rubric_id in soft_ids
                for token in ("skill", "tool", "mcp", "context", "workflow")
            ))


class ElementStatsMutationTests(unittest.TestCase):
    def test_explicit_category_precedes_usage_control_alias(self):
        self.assertEqual(
            resolve_target_category(("workflow", "usage_driven", "godot")),
            "workflow",
        )

    def test_benchmark_affinity_prevents_web_skill_in_godot_evolution(self):
        stats = HarnessElementStatsStore(root="/tmp")
        selected = stats.addition_target(
            _catalog(),
            [
                _element("skill_runtime_smoke"),
                _element("skill_regression_suite"),
            ],
            "skill",
            preferred_tags=("skill", "usage_driven", "godot"),
        )
        self.assertEqual(selected, "skill_godot_headless_playtest")

    def test_strict_removal_requires_high_usage_share_and_low_accuracy(self):
        stats = HarnessElementStatsStore(root="/tmp")
        for _ in range(3):
            stats.touch(category="skill", element_id="skill_regression_suite", success=False)
        for _ in range(10):
            stats.touch(category="skill", element_id="skill_runtime_smoke", success=True)
        active = [
            _element("skill_regression_suite"),
            _element("skill_runtime_smoke"),
        ]
        self.assertIsNone(stats.removal_target(active, "skill"))

        for _ in range(10):
            stats.touch(category="skill", element_id="skill_regression_suite", success=False)
        removal = stats.removal_target(active, "skill")
        self.assertEqual(removal, "skill_regression_suite")

    def test_merge_combines_similar_active_elements(self):
        catalog = _catalog()
        left = catalog["wf_probe_first"]
        right = catalog["wf_diagnose_then_patch"]
        self.assertGreaterEqual(element_similarity(left, right), 0.55)
        merged = compose_merged_element(left=left, right=right)
        self.assertEqual(merged.category, "workflow")
        self.assertIn("wf_probe_first", merged.spec["merged_from"])

    def test_mutate_can_compose_new_catalog_element(self):
        stats = HarnessElementStatsStore(root="/tmp")
        catalog = _catalog()
        active = [_element("skill_runtime_smoke")]
        result = mutate_category_elements(
            active=active,
            category="skill",
            catalog=catalog,
            stats=stats,
            limits={"skill": 4},
            gradient_tags=("skill", "usage_driven"),
        )
        self.assertIsNotNone(result)
        self.assertIn(result.operation, {"add", "compose", "replace", "derive"})
        if result.operation == "compose":
            self.assertEqual(len(result.catalog_additions), 1)


class BenchLoopRunnerTests(unittest.TestCase):
    def test_runner_state_advances_task_index(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            pool = (
                TaskPoolEntry(str(root / "t1"), str(root / "s1")),
                TaskPoolEntry(str(root / "t2"), str(root / "s2")),
            )
            cfg = HarnessEvolutionConfig.from_dict({
                "modules": [{"id": "a", "instruction": "a", "tags": [], "category": "workflow"}],
                "seed_modules": ["a"],
                "max_active_modules": 1,
                "max_active_tool_interfaces": 0,
                "mutation_width": 1,
                "replay_min_cases": 1,
                "require_rubric_validation": False,
            })
            from game_loop.core.harness import HarnessEvolutionEngine

            engine = HarnessEvolutionEngine(root / "harness", cfg)
            engine.initialize()
            runner = HarnessBenchLoopRunner(
                loop_dir=root / "loop",
                config=__import__("unittest.mock").mock.Mock(),
                task_pool=pool,
                harness_engine=engine,
                init_handler=lambda *_args, **_kwargs: 0,
                evolve_handler=lambda *_args, **_kwargs: 0,
                bench="gcbench",
            )
            runner.config = __import__("unittest.mock").mock.Mock()
            runner.initialize()
            state = runner.load_state()
            self.assertEqual(state.task_index, 0)


if __name__ == "__main__":
    unittest.main()
