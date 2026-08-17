from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

from game_loop.benchmarks.ggv_contract import run_paper_compatible_ggv
from game_loop.benchmarks.verigame import VerigameAdapter
from game_loop.benchmarks.verigame_bridge import run_bridge as run_verigame_bridge
from game_loop.benchmarks.vgamegym import VGameGymAdapter
from game_loop.benchmarks.vgamegym_bridge import run_bridge as run_vgamegym_bridge
from game_loop.benchmarks.vgamegym_eval import candidate_execution_failure, normalize_official_result
from game_loop.core.models import AttemptContext, BackendExecution, PreparedTask
from game_loop.runtime import (
    GameTask,
    InnerLoopPipeline,
    OpenGameRuntime,
    OpenGameRuntimeConfig,
    RunnerResult,
)


class FakeOpenGameRunner:
    def __init__(self, artifact_name: str, contents: str):
        self.artifact_name = artifact_name
        self.contents = contents
        self.calls = 0

    def run(self, request, *, isolation, environment, timeout_seconds):
        self.calls += 1
        (isolation.workspace / self.artifact_name).write_text(
            self.contents, encoding="utf-8"
        )
        return RunnerResult(return_code=0, result_text="fake OpenGame maker completed")


class FakeTimedOutOpenGameRunner(FakeOpenGameRunner):
    def run(self, request, *, isolation, environment, timeout_seconds):
        self.calls += 1
        (isolation.workspace / self.artifact_name).write_text(
            self.contents, encoding="utf-8"
        )
        return RunnerResult(return_code=-9, error="OpenGame SDK timed out after 240s")


class FakeGGVWorker:
    def invoke(self, operation, payload):
        if operation == "extract_keypoints":
            return {
                "specification_elements": [
                    {"id": "movement", "text": "The player can move."},
                    {"id": "score", "text": "Collecting a coin increments score."},
                ],
                "keypoints": [
                    {
                        "id": "kp_move",
                        "specification_element_ids": ["movement"],
                        "precondition": "player at x=0",
                        "bounded_interaction": "press right once",
                        "postcondition": "player x increases",
                    },
                    {
                        "id": "kp_score",
                        "specification_element_ids": ["score"],
                        "precondition": "coin overlaps player and score=0",
                        "bounded_interaction": "advance one tick",
                        "postcondition": "score=1",
                    },
                ],
            }
        if operation == "ground_units":
            return {
                "verification_units": [
                    {
                        "id": "u_move",
                        "keypoint_id": "kp_move",
                        "injected_state": {"player": {"x": 0}},
                        "bounded_interaction": [{"key": "ArrowRight"}],
                        "expected_outcome": {"player.x": {"gt": 0}},
                    },
                    {
                        "id": "u_score",
                        "keypoint_id": "kp_score",
                        "injected_state": {"score": 0, "coin_overlap": True},
                        "bounded_interaction": [{"ticks": 1}],
                        "expected_outcome": {"score": 1},
                    },
                ]
            }
        if operation == "execute_unit":
            unit_id = payload["verification_unit"]["id"]
            return {
                "unit_id": unit_id,
                "state_injection_succeeded": True,
                "interaction_succeeded": True,
                "evidence_refs": [str(Path(payload["runtime_dir"]) / "trace.json")],
            }
        if operation == "judge_evidence":
            unit_id = payload["verification_unit"]["id"]
            return {
                "unit_id": unit_id,
                "verdict": "pass" if unit_id == "u_move" else "fail",
                "rationale": "deterministic fake verdict",
            }
        raise AssertionError(operation)


class MissingJudgeWorker(FakeGGVWorker):
    def invoke(self, operation, payload):
        if operation == "judge_evidence":
            return {"unit_id": payload["verification_unit"]["id"], "verdict": "unverified"}
        return super().invoke(operation, payload)


class GameBenchmarkContractTests(unittest.TestCase):
    def test_vgamegym_prepare_exposes_requirement_but_not_reference_code(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            task = root / "private_task"
            task.mkdir()
            (task / "task.json").write_text(json.dumps({
                "game_id": "vgg_1",
                "requirement": "Show an autonomous maze demo.",
                "reference_code": "SECRET_REFERENCE",
                "code": "SECRET_CODE",
            }), encoding="utf-8")
            (task / "evaluator_secret.json").write_text("SECRET_EVALUATOR", encoding="utf-8")
            parent = root / "parent"
            parent.mkdir()
            candidate = root / "candidate"
            candidate.mkdir()
            prepared = VGameGymAdapter({}).prepare(
                task_source=task,
                parent_artifact=parent,
                feedback={},
                candidate_dir=candidate,
                context=AttemptContext("run", 1, 1),
            )
            visible = "\n".join(
                path.read_text(encoding="utf-8")
                for path in prepared.root_dir.rglob("*")
                if path.is_file()
            )
            self.assertIn("autonomous maze", visible)
            self.assertNotIn("SECRET_REFERENCE", visible)
            self.assertNotIn("SECRET_EVALUATOR", visible)

    def test_verigame_prepare_exposes_only_public_specification(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            task = root / "private_task"
            task.mkdir()
            (task / "specification.md").write_text("Public movement rule.", encoding="utf-8")
            (task / "hidden_keypoints.json").write_text("SECRET_KEYPOINT", encoding="utf-8")
            parent = root / "parent"
            parent.mkdir()
            candidate = root / "candidate"
            candidate.mkdir()
            prepared = VerigameAdapter({}).prepare(
                task_source=task,
                parent_artifact=parent,
                feedback={},
                candidate_dir=candidate,
                context=AttemptContext("run", 1, 1),
            )
            visible = "\n".join(
                path.read_text(encoding="utf-8")
                for path in prepared.root_dir.rglob("*")
                if path.is_file()
            )
            self.assertIn("Public movement rule", visible)
            self.assertNotIn("SECRET_KEYPOINT", visible)

    def test_vgamegym_normalizes_all_three_official_modalities(self):
        with tempfile.TemporaryDirectory() as td:
            raw_path = Path(td) / "raw.json"
            result = normalize_official_result(
                {
                    "run_ok": True,
                    "code_evaluation": {"total_score": 90},
                    "screenshot_evaluation": {"total_score": 60},
                    "video_evaluation": {"total_score": 30},
                },
                raw_result_ref=raw_path,
            )
            self.assertEqual(result["status"], "completed")
            self.assertAlmostEqual(result["primary_score"], (0.9 + 0.15 + 0.075) / 3)
            self.assertEqual(result["objectives"], {"code": 0.9, "screenshot": 0.15, "video": 0.075})

    def test_vgamegym_missing_judge_is_infrastructure_failure(self):
        with tempfile.TemporaryDirectory() as td:
            result = normalize_official_result(
                {
                    "run_ok": True,
                    "code_evaluation": {"total_score": 90},
                    "screenshot_evaluation": {"total_score": 60},
                    "video_evaluation": {"error": "judge timed out", "total_score": 0},
                },
                raw_result_ref=Path(td) / "raw.json",
            )
            self.assertEqual(result["status"], "infrastructure_failure")
            self.assertIsNone(result["primary_score"])

    def test_vgamegym_candidate_execution_failure_is_zero_not_infrastructure(self):
        with tempfile.TemporaryDirectory() as td:
            result = candidate_execution_failure(
                "official recorder exited 2: candidate crashed",
                raw_result_ref=Path(td) / "raw.json",
            )
            self.assertEqual(result["status"], "candidate_execution_failure")
            self.assertEqual(result["primary_score"], 0.0)
            self.assertEqual(result["objectives"], {"code": 0.0, "screenshot": 0.0, "video": 0.0})

    def test_vgamegym_completed_evaluation_with_unrunnable_game_is_not_infrastructure(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            artifact = root / "artifact"
            artifact.mkdir()
            (artifact / "game.py").write_text("raise RuntimeError('bad game')\n")
            evaluation_path = root / "evaluation.json"
            evaluation_path.write_text(json.dumps({
                "status": "completed",
                "primary_score": 0.1,
                "objectives": {"code": 0.3, "screenshot": 0.0, "video": 0.0},
                "constraints": {
                    "game_runnable": False,
                    "code_judge_complete": True,
                    "screenshot_judge_complete": True,
                    "video_judge_complete": True,
                },
                "diagnostics": ["generated Pygame artifact did not execute successfully"],
            }))
            manifest = root / "execution.json"
            manifest.write_text(json.dumps({
                "status": "completed",
                "artifact_dir": str(artifact),
                "evaluation_path": str(evaluation_path),
            }))
            prepared = PreparedTask(
                "vgamegym",
                root,
                {},
                {"output_manifest": str(manifest), "candidate_dir": str(root / "candidate")},
            )
            result = VGameGymAdapter({}).collect(
                prepared,
                BackendExecution(0, root / "backend.log"),
            )
            self.assertIsNone(result.error)
            self.assertIsNotNone(result.artifact_dir)
            self.assertIsNotNone(result.evaluation)
            self.assertFalse(result.evaluation.feasible)

    def test_ggv_contract_runs_injected_bounded_units_and_aggregates_elements(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            spec = root / "specification.md"
            spec.write_text("movement and scoring", encoding="utf-8")
            artifact = root / "artifact"
            artifact.mkdir()
            result = run_paper_compatible_ggv(
                specification_path=spec,
                artifact_dir=artifact,
                work_dir=root / "units",
                worker=FakeGGVWorker(),
            )
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["primary_score"], 0.5)
            self.assertTrue(result["constraints"]["state_injection_complete"])
            self.assertEqual(len(result["unit_verdicts"]), 2)

    def test_ggv_missing_judge_is_infrastructure_failure_not_a_score(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            spec = root / "specification.md"
            spec.write_text("movement and scoring", encoding="utf-8")
            artifact = root / "artifact"
            artifact.mkdir()
            result = run_paper_compatible_ggv(
                specification_path=spec,
                artifact_dir=artifact,
                work_dir=root / "units",
                worker=MissingJudgeWorker(),
            )
            self.assertEqual(result["status"], "infrastructure_failure")
            self.assertIsNone(result["primary_score"])

    def test_vgamegym_bridge_offline_fake_evaluator_keeps_artifact_separate(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            task = root / "task"
            task.mkdir()
            (task / "task.md").write_text("make a demo", encoding="utf-8")
            instruction = root / "instruction.md"
            instruction.write_text("Build the requested autonomous demo.", encoding="utf-8")
            seed = root / "agent_workspace"
            seed.mkdir()
            fake = root / "fake_vgame_eval.py"
            fake.write_text(
                "import json,sys\n"
                "json.dump({'run_ok':True,'code_evaluation':{'total_score':90},"
                "'screenshot_evaluation':{'total_score':80},'video_evaluation':{'total_score':70}},"
                "open(sys.argv[1],'w'))\n",
                encoding="utf-8",
            )
            manifest = root / "execution.json"
            maker = FakeOpenGameRunner("game.py", "print('game')\n")
            runtime = OpenGameRuntime(OpenGameRuntimeConfig(), runner=maker)
            rc = run_vgamegym_bridge(
                runtime=runtime,
                agent_workspace=seed,
                instruction_file=instruction,
                public_task_root=task,
                output_manifest=manifest,
                evaluator_command=[sys.executable, str(fake), "{raw_output}"],
            )
            self.assertEqual(rc, 0)
            self.assertEqual(maker.calls, 1)
            payload = json.loads(manifest.read_text())
            self.assertTrue((Path(payload["artifact_dir"]) / "game.py").is_file())
            self.assertNotEqual(Path(payload["artifact_dir"]), Path(payload["evaluation_path"]).parent)
            self.assertFalse((Path(payload["artifact_dir"]) / "result.json").exists())
            adapter = VGameGymAdapter({})
            evaluation = adapter.parse_evaluation(Path(payload["evaluation_path"]))
            self.assertTrue(evaluation.feasible)
            self.assertAlmostEqual(evaluation.primary_score, (0.9 + 0.2 + 0.175) / 3)

    def test_verigame_bridge_offline_fake_worker_is_paper_compatible(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            task = root / "task"
            task.mkdir()
            (task / "specification.md").write_text("Player moves.", encoding="utf-8")
            instruction = root / "instruction.md"
            instruction.write_text("Build the public game specification.", encoding="utf-8")
            seed = root / "agent_workspace"
            seed.mkdir()
            manifest = root / "execution.json"
            maker = FakeOpenGameRunner("index.html", "<canvas></canvas>")
            runtime = OpenGameRuntime(OpenGameRuntimeConfig(), runner=maker)
            rc = run_verigame_bridge(
                runtime=runtime,
                agent_workspace=seed,
                instruction_file=instruction,
                public_task_root=task,
                output_manifest=manifest,
                worker=FakeGGVWorker(),
            )
            self.assertEqual(rc, 0)
            self.assertEqual(maker.calls, 1)
            payload = json.loads(manifest.read_text())
            self.assertTrue((Path(payload["artifact_dir"]) / "index.html").is_file())
            self.assertNotEqual(Path(payload["artifact_dir"]), Path(payload["evaluation_path"]).parent)
            self.assertFalse((Path(payload["artifact_dir"]) / "result.json").exists())
            adapter = VerigameAdapter({})
            evaluation = adapter.parse_evaluation(Path(payload["evaluation_path"]))
            self.assertTrue(evaluation.feasible)
            self.assertEqual(evaluation.primary_score, 0.5)
            self.assertFalse(evaluation.evaluator["official_implementation"])

    def test_verigame_bridge_salvages_workspace_artifact_after_timeout(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            task = root / "task"
            task.mkdir()
            (task / "specification.md").write_text("Player moves.", encoding="utf-8")
            instruction = root / "instruction.md"
            instruction.write_text("Build the public game specification.", encoding="utf-8")
            seed = root / "agent_workspace"
            seed.mkdir()
            manifest = root / "execution.json"
            maker = FakeTimedOutOpenGameRunner("index.html", "<canvas></canvas>")
            runtime = OpenGameRuntime(OpenGameRuntimeConfig(), runner=maker)
            rc = run_verigame_bridge(
                runtime=runtime,
                agent_workspace=seed,
                instruction_file=instruction,
                public_task_root=task,
                output_manifest=manifest,
                worker=FakeGGVWorker(),
            )
            self.assertEqual(rc, 0)
            payload = json.loads(manifest.read_text())
            self.assertEqual(payload["status"], "completed")
            self.assertEqual(payload["submission"]["status"], "failed")
            self.assertIn("artifact_salvaged_after_runtime_failure", payload["diagnostics"])
            self.assertTrue((Path(payload["artifact_dir"]) / "index.html").is_file())

    def test_vgamegym_unified_inner_loop_pipeline_golden(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            task_source = root / "private_task"
            task_source.mkdir()
            (task_source / "task.json").write_text(json.dumps({
                "game_id": "vgg_pipeline",
                "requirement": "Show an autonomous maze demo.",
                "reference_code": "SECRET_REFERENCE",
            }), encoding="utf-8")
            parent = root / "parent"
            parent.mkdir()

            class Maker:
                def run(self, request, *, isolation, environment, timeout_seconds):
                    visible = "\n".join(
                        path.read_text(errors="ignore")
                        for path in isolation.workspace.rglob("*")
                        if path.is_file()
                    )
                    assert "SECRET_REFERENCE" not in visible
                    artifact = isolation.workspace / "candidate"
                    artifact.mkdir(exist_ok=True)
                    (artifact / "game.py").write_text("print('demo')\n", encoding="utf-8")
                    return RunnerResult(0)

            class Evaluator:
                def evaluate(self, *, adapter, prepared, task, submission, output_dir):
                    assert (Path(submission.artifact_ref) / "game.py").is_file()
                    output_dir.mkdir(parents=True)
                    result = output_dir / "result.json"
                    result.write_text(json.dumps({
                        "status": "completed",
                        "primary_score": 0.8,
                        "objectives": {"code": 0.9, "screenshot": 0.8, "video": 0.7},
                        "constraints": {
                            "game_runnable": True,
                            "code_judge_complete": True,
                            "screenshot_judge_complete": True,
                            "video_judge_complete": True,
                        },
                    }))
                    return result

            result = InnerLoopPipeline(
                adapter=VGameGymAdapter({}),
                runtime_config=OpenGameRuntimeConfig(),
                maker_runner=Maker(),
                evaluator_runner=Evaluator(),
            ).run(
                GameTask(
                    task_id="vgg-golden",
                    benchmark_id="vgamegym",
                    prompt="fallback",
                    task_source_ref=str(task_source),
                    workspace_seed_ref=str(parent),
                ),
                run_dir=root / "run",
            )
            self.assertEqual(Path(result.submission.artifact_ref).name, "candidate")
            self.assertTrue(result.evaluation.feasible)
            self.assertEqual(result.evaluation.primary_score, 0.8)

    def test_verigame_unified_inner_loop_pipeline_golden(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            task_source = root / "private_task"
            task_source.mkdir()
            (task_source / "specification.md").write_text(
                "Player movement is inspectable.", encoding="utf-8"
            )
            (task_source / "hidden_keypoints.json").write_text(
                "SECRET_KEYPOINT", encoding="utf-8"
            )
            parent = root / "parent"
            parent.mkdir()

            class Maker:
                def run(self, request, *, isolation, environment, timeout_seconds):
                    visible = "\n".join(
                        path.read_text(errors="ignore")
                        for path in isolation.workspace.rglob("*")
                        if path.is_file()
                    )
                    assert "SECRET_KEYPOINT" not in visible
                    artifact = isolation.workspace / "candidate"
                    artifact.mkdir(exist_ok=True)
                    (artifact / "index.html").write_text("<canvas></canvas>", encoding="utf-8")
                    return RunnerResult(0)

            class Evaluator:
                def evaluate(self, *, adapter, prepared, task, submission, output_dir):
                    assert (Path(submission.artifact_ref) / "index.html").is_file()
                    output_dir.mkdir(parents=True)
                    result = output_dir / "result.json"
                    result.write_text(json.dumps({
                        "status": "completed",
                        "primary_score": 1.0,
                        "objectives": {"specification_coverage": 1.0},
                        "constraints": {
                            "state_injection_complete": True,
                            "bounded_execution_complete": True,
                            "judge_complete": True,
                        },
                        "implementation": "offline-paper-compatible",
                    }))
                    return result

            result = InnerLoopPipeline(
                adapter=VerigameAdapter({}),
                runtime_config=OpenGameRuntimeConfig(),
                maker_runner=Maker(),
                evaluator_runner=Evaluator(),
            ).run(
                GameTask(
                    task_id="ggv-golden",
                    benchmark_id="verigame",
                    prompt="fallback",
                    task_source_ref=str(task_source),
                    workspace_seed_ref=str(parent),
                ),
                run_dir=root / "run",
            )
            self.assertEqual(Path(result.submission.artifact_ref).name, "candidate")
            self.assertTrue(result.evaluation.feasible)
            self.assertEqual(result.evaluation.primary_score, 1.0)


if __name__ == "__main__":
    unittest.main()
