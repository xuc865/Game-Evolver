from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from game_loop.cli import _resolve_seed_evaluation
from game_loop.config import AppConfig
from game_loop.core.models import EvaluationResult


ROOT = Path(__file__).resolve().parents[1]


def _import_gcbench_verifier() -> None:
    gcbench_root = Path(__file__).resolve().parents[2] / "gcbench"
    if str(gcbench_root) not in sys.path:
        sys.path.insert(0, str(gcbench_root))


def _gcbench_config(root: Path) -> AppConfig:
    gcbench_root = root / "gcbench"
    gcbench_root.mkdir()
    config_path = root / "config.json"
    config_path.write_text(json.dumps({
        "benchmark": {"adapter": "gcbench", "options": {"root": str(gcbench_root)}},
        "backend": {"command": ["true"]},
        "method": {"name": "L4"},
    }), encoding="utf-8")
    return AppConfig.load(config_path)


class GameCraftBenchScoringTests(unittest.TestCase):
    def test_resolve_seed_evaluation_uses_manual_score_by_default(self) -> None:
        from game_loop.benchmarks import load_adapter
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            config = _gcbench_config(root)
            adapter = load_adapter(config.benchmark.adapter, config.benchmark.options)
            seed = root / "seed"; seed.mkdir()
            args = argparse.Namespace(evaluate_seed=False, seed_score=0.42, seed_artifact=seed,
                                      task_source=root / "task", run_dir=root / "run")
            result = _resolve_seed_evaluation(args=args, adapter=adapter, config=config)
            self.assertAlmostEqual(result.primary_score, 0.42)
            self.assertTrue(result.feasible)

    def test_resolve_seed_evaluation_runs_verifier_when_requested(self) -> None:
        from game_loop.benchmarks import load_adapter
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            config = _gcbench_config(root)
            adapter = load_adapter(config.benchmark.adapter, config.benchmark.options)
            seed = root / "seed"; seed.mkdir()
            task = root / "puzzle-sokoban-dungeon"; task.mkdir()
            run_dir = root / "run"

            def fake_evaluate(**kwargs):
                self.assertEqual(kwargs["seed_artifact"], seed)
                return EvaluationResult(0.12, False, {"mechanics": 0.0})

            args = argparse.Namespace(evaluate_seed=True, seed_score=0.99, seed_artifact=seed,
                                      task_source=task, run_dir=run_dir)
            with patch("game_loop.gcbench_verifier.evaluate_seed_artifact", side_effect=fake_evaluate):
                result = _resolve_seed_evaluation(args=args, adapter=adapter, config=config)
            self.assertAlmostEqual(result.primary_score, 0.12)
            self.assertFalse(result.feasible)

    def test_export_judge_env_rejects_missing_api_key(self) -> None:
        script = ROOT / "scripts/gcbench_e2e/export_judge_env.sh"
        completed = subprocess.run(["bash", "-c", f"source '{script}'"], capture_output=True,
                                   text=True, env={"PATH": "/usr/bin:/bin", "GAMECRAFT_BENCH_JUDGE": "openai"})
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("requires OPENAI_API_KEY", completed.stderr)

    def test_export_judge_env_allows_explicit_stub(self) -> None:
        script = ROOT / "scripts/gcbench_e2e/export_judge_env.sh"
        completed = subprocess.run(["bash", "-c", f"source '{script}'; echo judge=$GAMECRAFT_BENCH_JUDGE"],
                                   capture_output=True, text=True,
                                   env={"PATH": "/usr/bin:/bin", "GAMECRAFT_BENCH_JUDGE": "stub"})
        self.assertEqual(completed.returncode, 0)
        self.assertIn("judge=stub", completed.stdout)

    def test_export_judge_env_auto_selects_text_for_deepseek(self) -> None:
        script = ROOT / "scripts/gcbench_e2e/export_judge_env.sh"
        completed = subprocess.run(
            ["bash", "-c", f"source '{script}'; echo mode=$GAMECRAFT_BENCH_JUDGE_INPUT_MODE"],
            capture_output=True, text=True,
            env={"PATH": "/usr/bin:/bin", "OPENAI_API_KEY": "test-key",
                 "GAMECRAFT_BENCH_JUDGE_MODEL": "DeepSeek-V4-Flash"})
        self.assertEqual(completed.returncode, 0)
        self.assertIn("mode=text", completed.stdout)

    def test_localize_build_cmd_uses_project_and_godot(self) -> None:
        _import_gcbench_verifier()
        from gamecraft_bench.verifier import score as score_mod
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); project = root / "game"; project.mkdir()
            fake_godot = root / "godot"; fake_godot.write_text("#!/bin/sh\nexit 0\n"); fake_godot.chmod(0o755)
            original = score_mod.cfg.GODOT_BIN
            try:
                score_mod.cfg.GODOT_BIN = str(fake_godot)
                cmd = score_mod._localize_build_cmd(
                    "godot --headless --path /workspace/game --quit-after 5", project_dir=project)
            finally:
                score_mod.cfg.GODOT_BIN = original
            self.assertIn(str(project), cmd); self.assertIn(str(fake_godot), cmd)
            self.assertNotIn("/workspace/game", cmd)

    def test_openai_text_mode_sends_plain_text_without_image_url(self) -> None:
        _import_gcbench_verifier()
        from gamecraft_bench.verifier.judges.base import JudgeRequest, RequirementSpec
        from gamecraft_bench.verifier.judges.openai_gpt import OpenAIJudge
        captured: dict = {}

        class FakeCompletions:
            def create(self, **kwargs):
                captured.update(kwargs)
                message = types.SimpleNamespace(content='{"scores":{"R1":0.75},"rationales":{"R1":"ok"}}')
                return types.SimpleNamespace(choices=[types.SimpleNamespace(message=message)])

        class FakeOpenAI:
            def __init__(self, **kwargs):
                captured["client_kwargs"] = kwargs
                self.chat = types.SimpleNamespace(completions=FakeCompletions())

        with tempfile.TemporaryDirectory() as raw:
            request = JudgeRequest(demo_id="demo_01", video_path=None, frame_paths=[],
                requirements=[RequirementSpec(id="R1", description="player can move")],
                evidence_text="godot.log: player moved to (2, 3)", input_mode="text")
            with patch.dict(sys.modules, {"openai": types.SimpleNamespace(OpenAI=FakeOpenAI)}), \
                    patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=False):
                response = OpenAIJudge(model="deepseek-v4-flash").score(request)
        self.assertIsInstance(captured["messages"][1]["content"], str)
        self.assertIn("player moved to (2, 3)", captured["messages"][1]["content"])
        self.assertNotIn("image_url", json.dumps(captured["messages"]))
        self.assertEqual(captured["temperature"], 0)
        self.assertEqual(captured["extra_body"], {"thinking": {"type": "disabled"}})
        self.assertAlmostEqual(response.scores["R1"], 0.75)

    def test_text_evidence_collects_code_trace_logs_but_not_env_secret(self) -> None:
        _import_gcbench_verifier()
        from gamecraft_bench.verifier.score import _collect_text_evidence
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); project = root / "game"; project.mkdir()
            (project / "main.gd").write_text("func move(): print('moved')")
            (project / ".env").write_text("TOKEN=must-not-leak")
            trace = project / "trace.json"; trace.write_text('{"events":[{"key":"RIGHT"}]}')
            logs = root / "logs"; logs.mkdir(); (logs / "godot.log").write_text("moved to x=1")
            evidence = _collect_text_evidence(project_dir=project, trace_path=trace,
                                               build_log="build succeeded", replay_log_dir=logs)
        for expected in ("build succeeded", "RIGHT", "moved to x=1", "func move"):
            self.assertIn(expected, evidence)
        self.assertNotIn("must-not-leak", evidence)

    def test_score_project_text_mode_bypasses_all_visual_pipeline(self) -> None:
        _import_gcbench_verifier()
        from gamecraft_bench.verifier import score as score_mod
        from gamecraft_bench.verifier.judges.base import JudgeResponse
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); project = root / "game"; (project / "demo_outputs").mkdir(parents=True)
            (project / "project.godot").write_text("[application]\n")
            (project / "main.gd").write_text("func _ready(): print('ready')")
            (project / "demo_outputs/demo_01.json").write_text('{"duration_frames":30,"events":[]}')
            rubric = root / "rubric.json"; rubric.write_text(json.dumps({
                "score_formula": "BUILD * R1", "build_check": {"id": "BUILD", "cmd": "true"},
                "requirements": [{"id": "R1", "description": "game starts"}]}))

            class TextJudge:
                model = "text-model"
                def score(self, request):
                    self_request = request
                    if self_request.input_mode != "text" or self_request.video_path is not None:
                        raise AssertionError("text request used visual evidence")
                    return JudgeResponse(scores={"R1": 0.8}, raw="ok")

            def forbidden(*args, **kwargs):
                raise AssertionError("visual pipeline must not run in text mode")

            with patch.object(score_mod, "replay_trace", side_effect=forbidden), \
                    patch.object(score_mod, "_sample_frames", side_effect=forbidden), \
                    patch.object(score_mod, "_run_text_runtime_probe", return_value=0.1):
                result = score_mod.score_project(project_dir=project, rubric_path=rubric,
                    output_dir=root / "out", judge=TextJudge(), judge_input_mode="text")
            self.assertAlmostEqual(result.reward, 0.8)
            self.assertEqual(result.infrastructure_errors, [])
            self.assertIsNone(result.demos[0].mp4_path)
            breakdown = json.loads((root / "out/breakdown.json").read_text())
            self.assertIsNone(breakdown["demos"][0]["mp4"])
            self.assertEqual(breakdown["demos"][0]["frames"], [])

    def test_malformed_candidate_trace_is_quality_failure_not_infra(self) -> None:
        _import_gcbench_verifier()
        from gamecraft_bench.verifier import score as score_mod
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); project = root / "game"; (project / "demo_outputs").mkdir(parents=True)
            (project / "project.godot").write_text("[application]\n")
            (project / "demo_outputs/demo_01.json").write_text('{"duration_frames": 30, "events": [')
            fake_godot = root / "godot"; fake_godot.write_text("#!/bin/sh\nexit 0\n"); fake_godot.chmod(0o755)
            rubric = root / "rubric.json"; rubric.write_text(json.dumps({
                "score_formula": "BUILD * R1", "build_check": {"id": "BUILD", "cmd": "true"},
                "requirements": [{"id": "R1", "description": "game starts"}]}))

            class ShouldNotJudge:
                model = "text-model"
                def score(self, request):
                    raise AssertionError("invalid traces should not call the judge")

            original = score_mod.cfg.GODOT_BIN
            try:
                score_mod.cfg.GODOT_BIN = str(fake_godot)
                result = score_mod.score_project(project_dir=project, rubric_path=rubric,
                    output_dir=root / "out", judge=ShouldNotJudge(), judge_input_mode="text")
            finally:
                score_mod.cfg.GODOT_BIN = original

            self.assertEqual(result.reward, 0.0)
            self.assertEqual(result.infrastructure_errors, [])
            self.assertIn("text runtime probe rejected demo_01", result.errors[0])
            breakdown = json.loads((root / "out/breakdown.json").read_text())
            self.assertTrue(breakdown["infrastructure_ok"])

    def test_cli_returns_two_for_judge_infrastructure_failure(self) -> None:
        _import_gcbench_verifier()
        from gamecraft_bench.verifier import cli
        from gamecraft_bench.verifier.score import ScoreResult
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); output = root / "out"
            result = ScoreResult(reward=0.0, build_ok=True, build_log="ok", formula="BUILD",
                requirements=[], demos=[], judge_name="FailingJudge", judge_model="text-only",
                errors=["judge failed"], infrastructure_errors=["judge failed"], judge_input_mode="text")
            with patch.object(cli, "get_judge", return_value=types.SimpleNamespace(model="text-only")), \
                    patch.object(cli, "score_project", return_value=result):
                rc = cli.main(["--project", str(root), "--rubric", str(root / "rubric.json"),
                               "--output", str(output), "--judge-input-mode", "text"])
            self.assertEqual(rc, 2)
            self.assertTrue(json.loads((output / "ctrf.json").read_text())["results"]["extra"]["infrastructure_errors"])

    def test_adapter_uses_structured_infrastructure_status(self) -> None:
        from game_loop.benchmarks.gcbench import GameCraftBenchAdapter
        with tempfile.TemporaryDirectory() as raw:
            breakdown = Path(raw) / "breakdown.json"
            breakdown.write_text(json.dumps({"reward": 0.0, "build_ok": True,
                "infrastructure_ok": False, "infrastructure_errors": ["probe timeout"],
                "errors": [], "requirements": []}))
            evaluation = GameCraftBenchAdapter({}).parse_evaluation(breakdown)
        self.assertFalse(evaluation.feasible)
        self.assertTrue(evaluation.evaluator["infrastructure_failure"])
        self.assertFalse(evaluation.constraints["infrastructure_ok"])


if __name__ == "__main__":
    unittest.main()
