from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from game_loop.benchmarks import load_adapter
from game_loop.core.models import AttemptContext


class GeneralBenchmarkContractTests(unittest.TestCase):
    def test_requested_adapters_are_registered(self):
        for name in ("terminalbench", "taubench", "nl2repo"):
            self.assertEqual(load_adapter(name, {}).adapter_id, name)

    def test_prepare_contract_for_requested_adapters(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            task = root / "task"
            task.mkdir()
            (task / "instruction.md").write_text("public task\n", encoding="utf-8")
            (task / "tests").mkdir()
            (task / "solution").mkdir()
            parent = root / "parent"
            parent.mkdir()
            (parent / "main.py").write_text("print('ok')\n", encoding="utf-8")
            options = {
                "root": str(root),
                "task_file": str(task / "instruction.md"),
                "tau_root": str(root),
            }
            for name in ("terminalbench", "taubench", "nl2repo"):
                prepared = load_adapter(name, options).prepare(
                    task_source=task,
                    parent_artifact=parent,
                    feedback={"agent_harness": {"rendered_instruction": "HARNESS_SENTINEL"}},
                    candidate_dir=root / name,
                    context=AttemptContext("contract", 1, 1),
                )
                for key in ("agent_cwd", "artifact_path", "instruction_file", "output_manifest"):
                    value = Path(prepared.command_context[key])
                    self.assertTrue(value.exists() or key == "output_manifest", (name, key))
                    self.assertTrue(value.parent.exists(), (name, key, "parent"))
                if "harness_context" in prepared.command_context:
                    self.assertIn(
                        "HARNESS_SENTINEL",
                        Path(prepared.command_context["harness_context"]).read_text(encoding="utf-8"),
                    )
                if name == "terminalbench":
                    agent_workspace = Path(prepared.command_context["agent_workspace"])
                    self.assertFalse((agent_workspace / "tests").exists())
                    self.assertFalse((agent_workspace / "solution").exists())
                    self.assertTrue(Path(prepared.command_context["task_root"]).joinpath("tests").is_dir())
                if name == "nl2repo":
                    self.assertEqual(
                        prepared.command_context["task_file"],
                        prepared.command_context["instruction_file"],
                    )
                    self.assertIn(
                        "HARNESS_SENTINEL",
                        Path(prepared.command_context["task_file"]).read_text(encoding="utf-8"),
                    )

    def test_continuous_results_are_not_collapsed_to_binary(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "result.json"
            path.write_text(json.dumps({"reward": 0.375, "total": 8,
                                        "passed_count": 3}), encoding="utf-8")
            result = load_adapter("nl2repo", {}).parse_evaluation(path)
            self.assertEqual(result.primary_score, 0.375)

    def test_tau_factory_accepts_generic_runner_metadata(self):
        root = Path(__file__).resolve().parents[1]
        tau_python = root / "third_party" / "tau2-bench" / ".venv" / "bin" / "python"
        if not tau_python.is_file():
            self.skipTest("Tau project environment is not installed")
        script = """
from game_loop.benchmarks.agents.tau_agent import GameMakingTauAgent, create_game_making_tau_agent
agent = create_game_making_tau_agent([], 'policy', llm='test-model', llm_args={},
    task=object(), audio_native_config=object(), audio_taps_dir='unused')
assert isinstance(agent, GameMakingTauAgent)
"""
        env = dict(os.environ)
        env["PYTHONPATH"] = str(root)
        completed = subprocess.run(
            [str(tau_python), "-c", script], env=env, capture_output=True, text=True
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_nl2repo_uses_official_image_workspace(self):
        bridge = (
            Path(__file__).resolve().parents[1]
            / "game_loop"
            / "benchmarks"
            / "nl2repo_bridge.py"
        ).read_text(encoding="utf-8")
        self.assertIn('"cp -a /workspace /workspace_eval\\n"', bridge)
        self.assertNotIn("cp -a /workspace_orig", bridge)


if __name__ == "__main__":
    unittest.main()
