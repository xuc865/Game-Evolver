from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from game_loop.cli import _build_dynamic_gradient
from game_loop.config import HarnessEvolutionConfig
from game_loop.core.harness import HarnessEvolutionEngine, HarnessSemanticGradient
from game_loop.experiment_presets import build_method_section


class AblationConfigTests(unittest.TestCase):
    def test_new_flags_default_to_legacy_behavior(self) -> None:
        config = HarnessEvolutionConfig.from_dict({
            "modules": [{"id": "base", "instruction": "base", "tags": []}],
            "seed_modules": ["base"],
            "max_active_modules": 1,
            "max_active_tool_interfaces": 0,
            "replay_min_cases": 1,
            "require_rubric_validation": False,
        })
        self.assertTrue(config.enable_long_term_memory)
        self.assertEqual(config.allowed_element_categories, ())
        self.assertTrue(config.enable_tool_interface_mutation)
        self.assertTrue(config.enable_executable_policy_mutation)

    def test_ablation_profiles_share_the_same_epoch_zero_harness(self) -> None:
        profiles = {
            "L0": {
                "enable_long_term_memory": False,
                "allowed_element_categories": ["context", "protocol"],
                "enable_tool_interface_mutation": False,
                "enable_executable_policy_mutation": False,
            },
            "L1": {
                "enable_long_term_memory": False,
                "allowed_element_categories": ["context", "protocol"],
                "enable_tool_interface_mutation": False,
                "enable_executable_policy_mutation": False,
            },
            "L2": {
                "enable_long_term_memory": False,
                "allowed_element_categories": [
                    "skill", "mcp", "tool", "context", "protocol", "workflow",
                ],
                "enable_tool_interface_mutation": True,
                "enable_executable_policy_mutation": True,
            },
            "L3": {
                "enable_long_term_memory": True,
                "allowed_element_categories": [
                    "skill", "mcp", "tool", "context", "protocol", "workflow",
                ],
                "enable_tool_interface_mutation": True,
                "enable_executable_policy_mutation": True,
            },
        }
        harnesses = {
            level: build_method_section(
                "gcbench", ablation=True, ablation_profile=profile
            )["harness_evolution"]
            for level, profile in profiles.items()
        }
        baseline_keys = (
            "modules", "tool_interfaces", "seed_modules", "seed_tool_interfaces",
            "element_catalog", "seed_elements", "max_active_modules",
            "max_active_tool_interfaces", "max_active_elements",
        )
        baseline = {key: harnesses["L0"].get(key) for key in baseline_keys}
        for level, harness in harnesses.items():
            with self.subTest(level=level):
                self.assertEqual(
                    {key: harness.get(key) for key in baseline_keys}, baseline
                )


class AblationEngineTests(unittest.TestCase):
    def _config(self, **overrides) -> HarnessEvolutionConfig:
        payload = {
            "modules": [
                {"id": "base", "instruction": "base", "tags": ["base"]},
                {"id": "text", "instruction": "text", "tags": ["tool_interface"]},
            ],
            "seed_modules": ["base"],
            "max_active_modules": 2,
            "tool_interfaces": [{
                "id": "runner",
                "kind": "command_wrapper",
                "description": "runner",
                "command": ["true"],
                "tags": ["tool_interface"],
            }],
            "max_active_tool_interfaces": 1,
            "element_catalog": [
                {
                    "id": "ctx_base",
                    "category": "context",
                    "description": "base context",
                    "spec": {"window": "base"},
                    "tags": ["context"],
                },
                {
                    "id": "ctx_new",
                    "category": "context",
                    "description": "new context",
                    "spec": {"window": "new"},
                    "tags": ["context"],
                },
                {
                    "id": "tool_new",
                    "category": "tool",
                    "description": "new tool",
                    "spec": {"command": "new"},
                    "tags": ["tool"],
                },
            ],
            "seed_elements": {"context": ["ctx_base"]},
            "max_active_elements": {"context": 1, "tool": 1},
            "replay_min_cases": 1,
            "require_rubric_validation": False,
            "allowed_element_categories": ["context", "protocol"],
            "enable_tool_interface_mutation": False,
            "enable_executable_policy_mutation": False,
            "enable_long_term_memory": False,
        }
        payload.update(overrides)
        return HarnessEvolutionConfig.from_dict(payload)

    def test_l0_freeze_returns_parent(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            engine = HarnessEvolutionEngine(Path(raw), self._config(), allow_mutation=False)
            parent = engine.initialize()
            candidate = engine.propose(
                parent_id=parent.harness_id,
                gradient=HarnessSemanticGradient("tool", ("tool",)),
                epoch=1,
            )
            self.assertEqual(candidate.harness_id, parent.harness_id)

    def test_l1_can_change_context_but_not_executable_state(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            engine = HarnessEvolutionEngine(Path(raw), self._config())
            parent = engine.initialize()
            candidate = engine.propose(
                parent_id=parent.harness_id,
                gradient=HarnessSemanticGradient(
                    "context",
                    ("context", "usage_driven", "element_add", "element_id:ctx_new"),
                ),
                epoch=1,
            )
            self.assertNotEqual(candidate.harness_id, parent.harness_id)
            self.assertEqual(candidate.active_tool_interfaces, parent.active_tool_interfaces)
            self.assertEqual(candidate.recovery_policy, parent.recovery_policy)
            self.assertEqual(candidate.validation_policy, parent.validation_policy)
            self.assertEqual(
                {item.category for item in candidate.active_elements}, {"context"}
            )

    def test_memory_disabled_gradient_does_not_read_memory(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            engine = HarnessEvolutionEngine(root, self._config())
            parent = engine.initialize()
            with patch(
                "game_loop.cli.HarnessEvolutionMemory.render_proposer_context",
                side_effect=AssertionError("memory must stay disabled"),
            ):
                gradient = _build_dynamic_gradient(
                    root,
                    1,
                    parent,
                    engine.config,
                    benchmark_id="gcbench",
                )
            self.assertIn("context", gradient.target_tags)


class GeneratedAblationTests(unittest.TestCase):
    def test_generated_ladder_has_only_l0_through_l3(self) -> None:
        root = Path(__file__).resolve().parents[1]
        config_dir = root / "experiments" / "configs-ablation"
        levels = {
            path.stem.split("-")[1].split("_")[0]
            for path in config_dir.glob("gcbench-*_ablation_kimi.json")
        }
        self.assertEqual(levels, {"L0", "L1", "L2", "L3"})
        configs = {
            level: json.loads(
                (config_dir / f"gcbench-{level}_ablation_kimi.json").read_text(
                    encoding="utf-8"
                )
            )
            for level in levels
        }
        self.assertTrue(all(value["method"]["level"] == "L4" for value in configs.values()))
        self.assertEqual(configs["L0"]["experiment"]["arm"], "L4_agent_no_harness_evolve")
        self.assertFalse(
            configs["L1"]["method"]["harness_evolution"]["enable_long_term_memory"]
        )
        self.assertTrue(
            configs["L3"]["method"]["harness_evolution"]["enable_long_term_memory"]
        )


if __name__ == "__main__":
    unittest.main()
