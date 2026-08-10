from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from unittest.mock import patch

from game_loop import inner_loop
from game_loop.core.models import EvaluationResult
from game_loop.benchmarks.base import BenchmarkAdapter
from game_loop.core.models import (
    ArtifactDescriptor,
    CandidateResult,
    GateResult,
    PreparedTask,
)
from game_loop.runtime import (
    GameEvaluation,
    GameTask,
    InnerLoopPipeline,
    OpenGameRuntime,
    OpenGameRuntimeConfig,
    RunnerResult,
)


class FakeOpenGameRunner:
    def __init__(self, result: RunnerResult | None = None):
        self.result = result or RunnerResult(
            0,
            events=(
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "done"}]}},
                {"type": "result", "subtype": "success", "usage": {"input_tokens": 10}},
            ),
            result_text="done",
            usage={"input_tokens": 10},
        )
        self.calls = []

    def run(self, request, *, isolation, environment, timeout_seconds):
        self.calls.append((request, isolation, dict(environment), timeout_seconds))
        (isolation.workspace / "game.html").write_text("<canvas></canvas>", encoding="utf-8")
        return self.result


class EmptyThenArtifactRunner:
    def __init__(self):
        self.calls = []

    def run(self, request, *, isolation, environment, timeout_seconds):
        self.calls.append((request, dict(environment)))
        if len(self.calls) == 2:
            (isolation.workspace / "game.py").write_text("print('game')\n", encoding="utf-8")
        return RunnerResult(0, result_text="done")


class PipelineAdapter(BenchmarkAdapter):
    artifact_descriptor = ArtifactDescriptor(kind="pipeline-test")

    def __init__(self, adapter_id):
        super().__init__({})
        self.adapter_id = adapter_id
        self.parse_calls = []

    def doctor(self):
        return {"adapter": self.adapter_id}

    def prepare(self, *, task_source, parent_artifact, feedback, candidate_dir, context):
        del task_source, feedback, context
        workspace = candidate_dir / "workspace"
        self.stage_artifact(parent_artifact, workspace)
        instruction = candidate_dir / "instruction.txt"
        instruction.parent.mkdir(parents=True, exist_ok=True)
        instruction.write_text("prepared public instruction", encoding="utf-8")
        return PreparedTask(
            self.adapter_id,
            workspace,
            {
                "agent_cwd": str(workspace),
                "artifact_path": str(workspace),
                "candidate_workspace": str(workspace),
                "instruction_file": str(instruction),
            },
        )

    def parse_evaluation(self, path):
        self.parse_calls.append(path)
        value = json.loads(path.read_text())
        return EvaluationResult(float(value["score"]), True, evaluator={"name": self.adapter_id})

    def collect(self, prepared, execution):
        return CandidateResult(None, None, "not used")

    def validate(self, artifact, common_config):
        return GateResult(True)


class FileEvaluator:
    def evaluate(self, *, adapter, prepared, task, submission, output_dir):
        del adapter, prepared, task, submission
        output_dir.mkdir(parents=True, exist_ok=True)
        result = output_dir / "official-result.json"
        result.write_text('{"score": 0.9}', encoding="utf-8")
        return result


class OpenGameRuntimeTests(unittest.TestCase):
    def test_inner_loop_cli_returns_nonzero_for_failed_submission(self):
        with tempfile.TemporaryDirectory() as td:
            submission = Path(td) / "submission.json"
            submission.write_text('{"status": "failed"}', encoding="utf-8")
            with patch.object(inner_loop, "run_command", return_value=submission):
                self.assertEqual(
                    inner_loop.main([
                        "run", "--benchmark", "b", "--task-source", "/unused/task",
                        "--run-dir", "/unused/run", "--profile", "/unused/profile",
                    ]),
                    1,
                )

    def test_fake_runner_smoke_is_isolated_and_writes_protocol_artifacts(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "index.html").write_text("seed", encoding="utf-8")
            inherited = seed / ".qwen"
            inherited.mkdir()
            (inherited / "settings.json").write_text('{"leak": true}', encoding="utf-8")
            skills = root / "skills"
            (skills / "game-skill").mkdir(parents=True)
            (skills / "game-skill" / "SKILL.md").write_text("fixed skill", encoding="utf-8")
            fake = FakeOpenGameRunner()
            config = OpenGameRuntimeConfig(
                model="fixed-model",
                system_prompt="fixed game prompt",
                skills_source=str(skills),
                core_tools=("read_file", "write_file"),
                exclude_tools=("run_shell_command",),
                max_session_turns=7,
                environment={"OPENGAME_TEST_MODE": "1"},
            )
            task = GameTask(
                task_id="task-1",
                benchmark_id="fakebench",
                prompt="make a game",
                task_source_ref=str(root / "task.json"),
                workspace_seed_ref=str(seed),
                artifact_relpath="game.html",
            )
            episode = root / "episode"
            submission = OpenGameRuntime(config, runner=fake).run(task, episode_dir=episode)

            self.assertEqual(submission.status, "completed")
            self.assertEqual(
                Path(submission.artifact_ref),
                (episode / "workspace" / "game.html").resolve(),
            )
            request, isolation, environment, timeout = fake.calls[0]
            self.assertEqual(request["prompt"], "make a game")
            self.assertEqual(request["sdk_module"], "@opengame/sdk")
            self.assertEqual(request["options"]["model"], "fixed-model")
            self.assertEqual(request["options"]["coreTools"], ["read_file", "write_file"])
            self.assertEqual(request["options"]["excludeTools"], ["run_shell_command"])
            self.assertEqual(request["options"]["maxSessionTurns"], 7)
            self.assertEqual(environment["HOME"], str((episode / "home").resolve()))
            self.assertEqual(environment["OPENGAME_TEST_MODE"], "1")
            self.assertTrue(environment.get("PATH"))
            self.assertEqual(environment["QWEN_SYSTEM_MD"], "1")
            self.assertFalse((episode / "workspace" / ".qwen" / "settings.json").read_text().find("leak") >= 0)
            self.assertTrue(episode.joinpath("workspace/.qwen/skills/game-skill/SKILL.md").is_file())
            self.assertTrue(episode.joinpath("home/.qwen/projects").is_dir())
            self.assertTrue(episode.joinpath("submission.json").is_file())
            self.assertTrue(episode.joinpath("sdk_request.json").is_file())
            lines = episode.joinpath("trajectory.jsonl").read_text().splitlines()
            self.assertEqual(len(lines), 4)
            self.assertEqual([json.loads(line)["sequence"] for line in lines], [1, 2, 3, 4])
            manifest = json.loads(episode.joinpath("runtime_manifest.json").read_text())
            self.assertEqual(manifest["runtime"]["environment"], {"OPENGAME_TEST_MODE": "<redacted>"})
            self.assertEqual(timeout, 3600)
            self.assertEqual(isolation.workspace, (episode / "workspace").resolve())

    def test_failed_runner_produces_failed_submission(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            fake = FakeOpenGameRunner(RunnerResult(1, error="sdk unavailable"))
            task = GameTask("t", "b", "make", str(root / "task"), artifact_relpath="missing")
            submission = OpenGameRuntime(
                OpenGameRuntimeConfig(), runner=fake
            ).run(task, episode_dir=root / "episode")
            self.assertEqual(submission.status, "failed")
            self.assertIsNone(submission.artifact_ref)
            self.assertIn("sdk unavailable", submission.diagnostics)
            self.assertTrue(any("expected artifact is missing" in item for item in submission.diagnostics))

    def test_empty_directory_artifact_triggers_provider_fallback(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            runner = EmptyThenArtifactRunner()
            task = GameTask("t", "b", "make", str(root / "task"), artifact_relpath=".")
            with patch.dict(os.environ, {"OPENROUTER_API_KEY": "fallback-secret"}, clear=False):
                submission = OpenGameRuntime(
                    OpenGameRuntimeConfig(backbone_provider="qwen"), runner=runner
                ).run(task, episode_dir=root / "episode")
            self.assertEqual(submission.status, "completed")
            self.assertEqual(submission.metadata["provider_route"], "fallback")
            self.assertEqual(len(runner.calls), 2)
            self.assertEqual(runner.calls[1][1]["OPENAI_BASE_URL"], "https://openrouter.ai/api/v1")

    def test_task_rejects_artifact_escape(self):
        with self.assertRaisesRegex(ValueError, "stay within"):
            GameTask("t", "b", "make", "/task", artifact_relpath="../outside")

    def test_evaluation_envelope_round_trips_core_result(self):
        core = EvaluationResult(
            0.75,
            True,
            objectives={"playability": 0.8},
            constraints={"builds": True},
            diagnostics=["minor warning"],
            evaluator={"name": "official"},
            terminal_success=False,
        )
        envelope = GameEvaluation.from_core(core, task_id="t", submission_id="s")
        restored = envelope.to_core()
        self.assertEqual(restored.to_dict(), core.to_dict())
        self.assertEqual(
            GameEvaluation.from_dict(envelope.to_dict()).to_core().to_dict(),
            core.to_dict(),
        )
        self.assertEqual(envelope.task_id, "t")
        self.assertEqual(envelope.submission_id, "s")

    def test_episode_directory_cannot_reuse_prior_session(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            occupied = root / "episode"
            occupied.mkdir()
            (occupied / "old-session.jsonl").write_text("old", encoding="utf-8")
            task = GameTask("t", "b", "make", str(root / "task"))
            with self.assertRaisesRegex(ValueError, "new or empty"):
                OpenGameRuntime(OpenGameRuntimeConfig(), runner=FakeOpenGameRunner()).run(
                    task, episode_dir=occupied
                )

    def test_four_benchmark_ids_share_one_pipeline_contract(self):
        for benchmark_id in ("gcbench", "gdbench", "vgamegym", "verigame"):
            with self.subTest(benchmark_id=benchmark_id), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                seed = root / "seed"
                seed.mkdir()
                (seed / "starter.txt").write_text("seed", encoding="utf-8")
                task_source = root / "task"
                task_source.mkdir()
                adapter = PipelineAdapter(benchmark_id)
                pipeline = InnerLoopPipeline(
                    adapter=adapter,
                    runtime_config=OpenGameRuntimeConfig(),
                    maker_runner=FakeOpenGameRunner(),
                    evaluator_runner=FileEvaluator(),
                )
                task = GameTask(
                    task_id=f"{benchmark_id}-1",
                    benchmark_id=benchmark_id,
                    prompt="fallback prompt",
                    task_source_ref=str(task_source),
                    workspace_seed_ref=str(seed),
                )
                result = pipeline.run(task, run_dir=root / "run")
                self.assertEqual(result.submission.status, "completed")
                self.assertIsNotNone(result.evaluation)
                self.assertEqual(result.evaluation.primary_score, 0.9)
                self.assertEqual(len(adapter.parse_calls), 1)
                self.assertTrue((root / "run" / "inner_loop_manifest.json").is_file())

    def test_four_backbones_resolve_env_only_credentials_without_persisting_them(self):
        cases = {
            "deepseek": "DEEPSEEK_API_KEY",
            "kimi": None,
            "glm": None,
            "qwen": "DASHSCOPE_API_KEY",
        }
        for provider, credential_env in cases.items():
            with self.subTest(provider=provider), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                secret = f"never-write-{provider}"
                fake = FakeOpenGameRunner()
                task = GameTask("t", "b", "make", str(root / "task"), artifact_relpath="game.html")
                injected = {} if credential_env is None else {credential_env: secret}
                with patch.dict(os.environ, injected, clear=False):
                    runtime = OpenGameRuntime(
                        OpenGameRuntimeConfig(backbone_provider=provider), runner=fake
                    )
                    report = runtime.doctor()
                    self.assertTrue(report["provider"]["ready"])
                    runtime.run(task, episode_dir=root / "episode")
                request, _, environment, _ = fake.calls[0]
                self.assertEqual(
                    environment["OPENAI_API_KEY"],
                    "EMPTY" if credential_env is None else secret,
                )
                self.assertEqual(request["options"]["model"], report["provider"]["model"])
                persisted = "\n".join(
                    path.read_text(encoding="utf-8", errors="ignore")
                    for path in (root / "episode").rglob("*")
                    if path.is_file()
                )
                self.assertNotIn(secret, persisted)

    def test_runtime_profile_rejects_embedded_credentials(self):
        with self.assertRaisesRegex(ValueError, "cannot contain credentials"):
            OpenGameRuntimeConfig(environment={"OPENAI_API_KEY": "must-not-be-here"})


if __name__ == "__main__":
    unittest.main()
