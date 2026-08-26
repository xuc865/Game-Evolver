from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

from game_loop.benchmarks import load_adapter
from game_loop.benchmarks.tinymmo import TinyMMOAdapter
from game_loop.config import GateConfig
from game_loop.core.models import AttemptContext


class TinyMMOAdapterTests(unittest.TestCase):
    def test_godot_validation_ignores_transient_first_import_error(self):
        from scripts.evaluate_tinymmo import _run_godot_import

        warmup = CompletedProcess(
            args=[],
            returncode=0,
            stdout="Parse Error: referenced non-existent imported resource\n",
        )
        stable = CompletedProcess(args=[], returncode=0, stdout="Godot Engine\n")
        with tempfile.TemporaryDirectory() as td, patch(
            "scripts.evaluate_tinymmo.subprocess.run",
            side_effect=[warmup, stable],
        ) as run:
            result = _run_godot_import(Path(td), "godot", 10)

        self.assertEqual(run.call_count, 2)
        self.assertTrue(result["complete"])
        self.assertFalse(result["compile_errors"])

    def test_adapter_is_registered_and_parses_multi_objective_score(self):
        adapter = load_adapter("tinymmo")
        self.assertIsInstance(adapter, TinyMMOAdapter)
        with tempfile.TemporaryDirectory() as td:
            result = Path(td) / "result.json"
            result.write_text(json.dumps({
                "status": "completed",
                "primary_score": 0.8,
                "objectives": {"runtime_health": 1.0, "network_smoothing": 0.7},
                "constraints": {"architecture_intact": True, "gdscript_compiles": True},
                "diagnostics": [],
            }), encoding="utf-8")
            parsed = adapter.parse_evaluation(result)
            self.assertTrue(parsed.feasible)
            self.assertEqual(parsed.primary_score, 0.8)
            self.assertEqual(parsed.objectives["network_smoothing"], 0.7)

    def test_prepare_keeps_task_and_evaluator_outside_project(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            (seed / "source/common/network").mkdir(parents=True)
            (seed / "project.godot").write_text("[application]\n", encoding="utf-8")
            dependency = root / "dependency/addons/godot-sqlite"
            dependency.mkdir(parents=True)
            (dependency / "gdsqlite.gdextension").write_text("", encoding="utf-8")
            task = root / "task.md"
            task.write_text("Improve motion.", encoding="utf-8")
            adapter = TinyMMOAdapter({"runtime_dependency_root": str(root / "dependency")})
            prepared = adapter.prepare(
                task_source=task,
                parent_artifact=seed,
                feedback={},
                candidate_dir=root / "candidate",
                context=AttemptContext("run", 1, 1),
            )
            project = Path(prepared.command_context["artifact_path"])
            self.assertTrue((project / "project.godot").is_file())
            self.assertTrue((project / "addons/godot-sqlite/gdsqlite.gdextension").is_file())
            self.assertFalse((project / "instruction.md").exists())

    def test_gate_rejects_removed_mmo_role(self):
        with tempfile.TemporaryDirectory() as td:
            project = Path(td)
            (project / "project.godot").write_text("", encoding="utf-8")
            gate = TinyMMOAdapter({}).validate(project, GateConfig())
            self.assertFalse(gate.passed)
            self.assertTrue(any("source/server/world" in error for error in gate.errors))


if __name__ == "__main__":
    unittest.main()
