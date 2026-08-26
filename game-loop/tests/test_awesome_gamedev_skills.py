from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from game_loop.baselines.awesome_gamedev_skills import (
    build_skills_index,
    inspect_skills_source,
    materialize_skills_source,
)
from game_loop.runtime.profile import merge_runtime_profile


def _write_skill(path: Path, *, name: str, description: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "---\n"
        f"name: {name}\n"
        "description: >\n"
        f"  {description}\n"
        "---\n\n"
        "# Skill\n",
        encoding="utf-8",
    )


class AwesomeGamedevSkillsTests(unittest.TestCase):
    def test_inspection_and_materialization_flatten_official_layout(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            _write_skill(
                root / "router" / "SKILL.md",
                name="router",
                description="Routes game requests to a relevant skill.",
            )
            _write_skill(
                root / "skills" / "godot" / "godot-gdscript" / "SKILL.md",
                name="godot-gdscript",
                description="Writes Godot GDScript.",
            )
            _write_skill(
                root / "skills" / "genres" / "platformer" / "SKILL.md",
                name="platformer",
                description="Builds platform games.",
            )

            entries = inspect_skills_source(root)
            destination = root / "materialized"
            copied = materialize_skills_source(root, destination)

            self.assertEqual([entry["name"] for entry in entries], [
                "router", "platformer", "godot-gdscript",
            ])
            self.assertEqual(entries, copied)
            self.assertTrue((destination / "router" / "SKILL.md").is_file())
            self.assertTrue((destination / "godot-gdscript" / "SKILL.md").is_file())
            self.assertTrue((destination / "platformer" / "SKILL.md").is_file())
            self.assertEqual(len(list(destination.glob("*/SKILL.md"))), 3)

            index = build_skills_index(root)
            self.assertIn("Routes game requests", index)
            self.assertIn("path: skills/godot/godot-gdscript/SKILL.md", index)

    def test_runtime_profile_can_overlay_a_skills_baseline(self) -> None:
        profile = merge_runtime_profile(
            opengame_profile={
                "runtime_id": "opengame",
                "sdk_module": "sdk",
                "settings": {"base": True},
            },
            baseline_profile={
                "skills_source": "third_party/awesome-gamedev-agent-skills",
                "settings": {"skills": True},
            },
            backbone_profile={"backbone_provider": "qwen"},
        )
        self.assertEqual(
            profile.skills_source,
            "third_party/awesome-gamedev-agent-skills",
        )
        self.assertEqual(profile.settings, {"base": True, "skills": True})
        self.assertEqual(profile.backbone_provider, "qwen")


if __name__ == "__main__":
    unittest.main()
