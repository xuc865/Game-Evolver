from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from game_loop.benchmarks import load_adapter
from game_loop.core.models import AttemptContext, BackendExecution
from scripts.general_benchmark_progress import (
    cumulative_accuracy,
    record_task_notice,
    terminalbench_difficulty_stats,
)
from scripts.run_new_bench_experiments import (
    _process_tree_rss_kib,
    load_done_ids,
    terminalbench_docker_ready,
)


class GeneralBenchmarkContractTests(unittest.TestCase):
    @patch("scripts.run_new_bench_experiments.subprocess.run")
    def test_process_tree_rss_includes_only_owned_descendants(self, run):
        run.return_value.stdout = "10 1 100\n11 10 200\n12 11 300\n20 1 999\n"
        self.assertEqual(_process_tree_rss_kib(10), 600)

    @patch("scripts.run_new_bench_experiments.shutil.which", return_value="/usr/bin/docker")
    @patch("scripts.run_new_bench_experiments.subprocess.run")
    def test_terminalbench_preflight_rejects_stopped_docker(self, run, _which):
        run.return_value.returncode = 1
        with patch.dict(os.environ, {"TERMINALBENCH_DOCKER_HOST": "unix:///dead.sock"}, clear=False):
            self.assertEqual(
                terminalbench_docker_ready(),
                (False, "Docker daemon is not running"),
            )

    @patch("scripts.run_new_bench_experiments.shutil.which", return_value="/usr/bin/docker")
    @patch("scripts.run_new_bench_experiments.subprocess.run")
    def test_terminalbench_preflight_selects_configured_sandbox(self, run, _which):
        run.return_value.returncode = 0
        host = "unix:///sandbox/docker.sock"
        with patch.dict(os.environ, {"TERMINALBENCH_DOCKER_HOST": host}, clear=False):
            self.assertEqual(terminalbench_docker_ready(), (True, ""))
            self.assertEqual(os.environ["DOCKER_HOST"], host)

    def test_progress_notice_is_deduplicated_and_reports_cumulative_accuracy(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            runs = root / "runs"
            candidate = (
                runs / "new_bench_kimi_terminalbench-resume-1" / "run-one"
                / "generation_001" / "candidate_01"
            )
            candidate.mkdir(parents=True)
            (candidate / "terminalbench_execution.json").write_text(
                json.dumps({"infrastructure_error": False, "passed": True, "reward": 1}),
                encoding="utf-8",
            )
            progress = root / "progress.txt"
            kwargs = dict(
                runs=runs, prefix="new_bench_kimi", model="kimi",
                bench="terminalbench", task_name="run-one", run_id="run-one",
                completed_at="2026-08-11T20:00:00+0800", status="completed",
                progress_file=progress,
            )
            self.assertTrue(record_task_notice(**kwargs))
            self.assertFalse(record_task_notice(**kwargs))
            lines = progress.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 1)
            self.assertIn("cumulative_accuracy=100.00% (1/1)", lines[0])

    def test_tau_cumulative_accuracy_expands_simulations(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td)
            candidate = (
                runs / "new_bench_qwen_taubench-resume-1" / "run-one"
                / "generation_001" / "candidate_01"
            )
            result_dir = candidate / "tau2_1"
            result_dir.mkdir(parents=True)
            result = result_dir / "results.json"
            result.write_text(json.dumps({"simulations": [
                {"reward_info": {"reward": 1}},
                {"reward_info": {"reward": 0}},
                {"reward_info": None, "infrastructure_error": True},
            ]}), encoding="utf-8")
            (candidate / "taubench_execution.json").write_text(json.dumps({
                "status": "completed", "result_path": str(result),
            }), encoding="utf-8")
            self.assertEqual(
                cumulative_accuracy(runs, "new_bench_qwen", "taubench"),
                (1, 2),
            )

    def test_terminalbench_requires_reward_and_passed(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td)
            root = runs / "new_bench_kimi_terminalbench-resume-1"
            for run_id, payload in (
                ("missing-reward", {"infrastructure_error": False, "passed": True}),
                ("missing-passed", {"infrastructure_error": False, "reward": 1}),
            ):
                candidate = root / run_id / "generation_001" / "candidate_01"
                candidate.mkdir(parents=True)
                (candidate / "terminalbench_execution.json").write_text(
                    json.dumps(payload), encoding="utf-8"
                )
            self.assertEqual(
                cumulative_accuracy(runs, "new_bench_kimi", "terminalbench"),
                (0, 0),
            )

    def test_terminalbench_difficulty_stats_uses_official_metadata(self):
        with tempfile.TemporaryDirectory() as td:
            runs = Path(td)
            candidate = (
                runs / "new_bench_kimi_terminalbench-resume-1"
                / "new_bench_kimi_terminalbench_path-tracing"
                / "generation_001" / "candidate_01"
            )
            candidate.mkdir(parents=True)
            (candidate / "terminalbench_execution.json").write_text(
                json.dumps({"infrastructure_error": False, "passed": True, "reward": 1}),
                encoding="utf-8",
            )
            stats = terminalbench_difficulty_stats(runs, "new_bench_kimi")
            self.assertEqual(stats["hard"]["valid"], 1)
            self.assertEqual(stats["hard"]["passed"], 1)
            self.assertEqual(stats["hard"]["accuracy"], 1.0)

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

    def test_nl2repo_defaults_to_official_start_md(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            task = root / "task"
            task.mkdir()
            (task / "start.md").write_text("OFFICIAL REQUIREMENTS\n", encoding="utf-8")
            parent = root / "parent"
            parent.mkdir()
            (parent / "seed.py").write_text("pass\n", encoding="utf-8")
            prepared = load_adapter("nl2repo", {"root": str(root)}).prepare(
                task_source=task,
                parent_artifact=parent,
                feedback={"agent_harness": {"rendered_instruction": "HARNESS_SENTINEL"}},
                candidate_dir=root / "candidate",
                context=AttemptContext("contract", 1, 1),
            )
            prompt = Path(prepared.command_context["task_file"]).read_text(encoding="utf-8")
            self.assertIn("OFFICIAL REQUIREMENTS", prompt)
            self.assertIn("HARNESS_SENTINEL", prompt)

    def test_nl2repo_collects_generated_repository_for_gates(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            task = root / "task"
            task.mkdir()
            (task / "start.md").write_text("requirements\n", encoding="utf-8")
            parent = root / "parent"
            parent.mkdir()
            (parent / "seed.py").write_text("pass\n", encoding="utf-8")
            adapter = load_adapter("nl2repo", {"root": str(root)})
            prepared = adapter.prepare(
                task_source=task,
                parent_artifact=parent,
                feedback={},
                candidate_dir=root / "candidate",
                context=AttemptContext("contract", 1, 1),
            )
            generated = root / "generated"
            generated.mkdir()
            (generated / "start.md").write_text("requirements\n", encoding="utf-8")
            (generated / "solution.py").write_text("pass\n", encoding="utf-8")
            result_dir = root / "result"
            result_dir.mkdir()
            (result_dir / "result.json").write_text(
                json.dumps({"reward": 0.5, "total": 2, "passed_count": 1}),
                encoding="utf-8",
            )
            Path(prepared.metadata["output_manifest"]).write_text(
                json.dumps({"result_dir": str(result_dir), "artifact_ref": str(generated)}),
                encoding="utf-8",
            )
            result = adapter.collect(prepared, BackendExecution(0, root / "run.log"))
            self.assertIsNone(result.error)
            self.assertTrue(result.artifact_dir.joinpath("solution.py").is_file())
            self.assertFalse(result.artifact_dir.joinpath("result.json").exists())

    def test_nl2repo_resume_rejects_pre_fix_results(self):
        with tempfile.TemporaryDirectory() as td:
            out_dir = Path(td)
            run_id = "new_bench_kimi_nl2repo_example"
            run_dir = out_dir / run_id
            manifest = run_dir / "generation_001" / "candidate_01" / "nl2repo_execution.json"
            manifest.parent.mkdir(parents=True)
            (out_dir / "summary.json").write_text(
                json.dumps({
                    "bench": "nl2repo",
                    "cases": [{"run_id": run_id, "status": "completed"}],
                }),
                encoding="utf-8",
            )
            manifest.write_text(json.dumps({"reward": 1.0}), encoding="utf-8")
            self.assertNotIn(run_id, load_done_ids(out_dir))
            manifest.write_text(
                json.dumps({"reward": 1.0, "artifact_ref": str(run_dir)}),
                encoding="utf-8",
            )
            self.assertIn(run_id, load_done_ids(out_dir))

    def test_tau_resume_rejects_partial_or_infrastructure_batch(self):
        with tempfile.TemporaryDirectory() as td:
            out_dir = Path(td)
            run_id = "new_bench_qwen_taubench_taubench-instruction"
            candidate = out_dir / run_id / "generation_001" / "candidate_01"
            result_dir = candidate / "tau2_1"
            result_dir.mkdir(parents=True)
            (out_dir / "summary.json").write_text(json.dumps({
                "bench": "taubench",
                "cases": [{"run_id": run_id, "status": "completed"}],
            }), encoding="utf-8")
            manifest = candidate / "taubench_execution.json"
            manifest.write_text(
                json.dumps({"status": "infrastructure_failure"}),
                encoding="utf-8",
            )
            (result_dir / "results.json").write_text(
                json.dumps({"simulations": [{"reward_info": {"reward": 1}}]}),
                encoding="utf-8",
            )
            self.assertNotIn(run_id, load_done_ids(out_dir))

            manifest.write_text(json.dumps({"status": "completed"}), encoding="utf-8")
            self.assertNotIn(run_id, load_done_ids(out_dir))
            (result_dir / "results.json").write_text(
                json.dumps({"simulations": [
                    {"reward_info": {"reward": 1}} for _ in range(50)
                ]}),
                encoding="utf-8",
            )
            self.assertIn(run_id, load_done_ids(out_dir))

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
        self.assertIn("set -o pipefail", bridge)
        self.assertIn("${PIPESTATUS[0]}", bridge)
        self.assertIn("return_code not in (0, 1)", bridge)
        self.assertIn("stdout=subprocess.DEVNULL", bridge)
        self.assertNotIn("capture_output=True", bridge)
        self.assertIn("1024 * 1024", bridge)


if __name__ == "__main__":
    unittest.main()
