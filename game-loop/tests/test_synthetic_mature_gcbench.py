from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from game_loop.config import AppConfig
from game_loop.core.harness import HarnessEvolutionEngine, HarnessProfile
from scripts.build_synthetic_mature_gcbench_harness import (
    MATURE_ELEMENTS,
    MATURE_MODULES,
    build_effective_config,
    build_profile,
)


ROOT = Path(__file__).resolve().parents[1]


class SyntheticMatureGcbenchTests(unittest.TestCase):
    def test_profile_is_content_addressed_and_valid(self) -> None:
        source = ROOT / "experiments/configs-v4/gcbench-L4_glm5.2_produce.json"
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            config = build_effective_config(source, output / "config.json")
            profile_path = build_profile(config=config, output_dir=output)
            profile = HarnessProfile.from_dict(json.loads(profile_path.read_text()))
            engine = HarnessEvolutionEngine(output / "validation", config.method.harness_evolution)
            initialized = engine.initialize(profile)
            self.assertEqual(initialized.harness_id, profile.harness_id)
            self.assertEqual(set(profile.active_modules), {item["id"] for item in MATURE_MODULES})
            self.assertEqual(
                {item.element_id for item in profile.active_elements},
                {element_id for ids in MATURE_ELEMENTS.values() for element_id in ids},
            )

    def test_effective_config_keeps_one_candidate(self) -> None:
        source = ROOT / "experiments/configs-v4/gcbench-L4_kimi.json"
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "config.json"
            config = build_effective_config(source, destination)
            raw = json.loads(destination.read_text())
            self.assertEqual(config.evolution.max_generations, 1)
            self.assertEqual(config.evolution.candidates_per_generation, 1)
            self.assertFalse(raw["method"]["harness_evolution"]["enable_usage_driven_mutation"])
            self.assertEqual(raw["experiment"]["arm"], "L4_agent")


if __name__ == "__main__":
    unittest.main()
