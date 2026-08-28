from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import types
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

from game_loop.backends.command import CommandBackend
from game_loop.config import AppConfig, BackendConfig, HarnessElementConfig
from game_loop.benchmarks.terminalbench import TerminalBenchAdapter
from game_loop.core.models import BackendExecution, PreparedTask
from game_loop.core.agent_circuit import AgentCircuit
from game_loop.core.episode_runner import _episode_config_dict
from game_loop.core.harness import HarnessProfile
from game_loop.runtime import (
    DeepSeekHarnessRunnerResult,
    DeepSeekHarnessRuntime,
    DeepSeekHarnessRuntimeConfig,
    PythonSDKRunner,
    GameTask,
    OpenGameRuntimeConfig,
    build_runtime,
    load_runtime_config,
)
from game_loop.runtime_profile_snapshot import (
    capture_runtime_profile,
    materialize_runtime_profile,
)
from game_loop.runtime.deepseek_harness import _collect_usage


class FakeDeepSeekHarnessRunner:
    def __init__(
        self,
        *,
        write_artifact: bool = True,
        finish_reason: str | None = "completed",
    ):
        self.write_artifact = write_artifact
        self.finish_reason = finish_reason
        self.calls: list[dict[str, object]] = []

    def run(self, prompt, *, cwd, session_root, config, environment):
        self.calls.append({
            "prompt": prompt,
            "cwd": cwd,
            "session_root": session_root,
            "config": config,
            "environment": dict(environment),
        })
        if self.write_artifact:
            (cwd / "game.txt").write_text("built by dsh\n", encoding="utf-8")
        return DeepSeekHarnessRunnerResult(
            finish_reason=self.finish_reason,
            final_response="done",
            events=(
                {
                    "type": "assistant/chunk",
                    "data": {
                        "turn": 1,
                        "step": 1,
                        "chunk": {
                            "type": "usage",
                            "usage": {"inputTokens": 7, "outputTokens": 3},
                        },
                    },
                },
                {
                    "type": "assistant/message",
                    "data": {
                        "turn": 1,
                        "step": 1,
                        "usage": {
                            "inputTokens": 7,
                            "outputTokens": 3,
                            "cacheReadTokens": 2,
                            "reasoningTokens": 1,
                        },
                    },
                },
            ),
            notifications=(
                {"method": "session.status", "payload": {"status": "idle"}},
            ),
            session_root=str(session_root),
        )


class DeepSeekHarnessRuntimeTests(unittest.TestCase):
    def test_frozen_episode_propagates_dsh_plugin_genome(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            cordis = root / "seed.cordis.yml"
            cordis.write_text("- id: seed\n  name: '@deepseek-ai/dsh-seed'\n")
            runtime_profile = root / "runtime.json"
            runtime_profile.write_text(json.dumps({
                "runtime_type": "deepseek-harness",
                "cordis": str(cordis),
                "cordis_plugin_catalog": {
                    "search": [{
                        "id": "evolved-search",
                        "name": "@deepseek-ai/dsh-tool-fs-search",
                    }],
                },
                "active_cordis_plugins": [],
            }))
            source = (
                Path(__file__).resolve().parents[1]
                / "experiments/configs-v4/gcbench-L4_deepseek_v4.json"
            )
            raw = json.loads(source.read_text())
            raw["evolution"]["max_generations"] = 1
            raw["evolution"]["candidates_per_generation"] = 1
            app_path = root / "app.json"
            app_path.write_text(json.dumps(raw))
            config = AppConfig.load(app_path)
            config = replace(config, backend=BackendConfig.from_dict({
                "command": ["true"],
                "cwd": str(root),
                "runtime_profile": str(runtime_profile),
            }))
            harness = HarnessProfile.from_dict({
                "harness_id": "test-profile",
                "agent_circuit": AgentCircuit.singleton().to_dict(),
                "active_elements": [{
                    "element_id": "dsh_plugin_search",
                    "category": "dsh_plugin",
                    "spec": {"plugin_id": "search"},
                }],
            })
            payload = _episode_config_dict(config, harness=harness)
            self.assertEqual(
                payload["backend"]["runtime_profile_value"]["active_cordis_plugins"],
                ["search"],
            )
            self.assertEqual(
                payload["backend"]["runtime_profile_value"]["agent_circuit"][
                    "circuit_id"
                ],
                harness.agent_circuit.circuit_id,
            )
            self.assertIn(
                "dsh_plugin_search",
                {
                    item["id"]
                    for item in payload["method"]["harness_evolution"][
                        "element_catalog"
                    ]
                },
            )

    def test_frozen_episode_compiles_active_child_prototype(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            cordis = root / "seed.cordis.yml"
            cordis.write_text("- id: seed\n  name: '@deepseek-ai/dsh-seed'\n")
            runtime_profile = root / "runtime.json"
            runtime_profile.write_text(json.dumps({
                "runtime_type": "deepseek-harness",
                "cordis": str(cordis),
                "cordis_plugin_catalog": {
                    "fork_context_subagent": [{
                        "id": "evolved-fork-provider",
                        "name": "@deepseek-ai/dsh-subagent-fork-in-process",
                        "config": {"providerName": "fork"},
                    }],
                },
                "active_cordis_plugins": [],
            }))
            source = (
                Path(__file__).resolve().parents[1]
                / "experiments/configs-v4/gcbench-L4_deepseek_v4.json"
            )
            raw = json.loads(source.read_text())
            raw["evolution"]["max_generations"] = 1
            raw["evolution"]["candidates_per_generation"] = 1
            app_path = root / "app.json"
            app_path.write_text(json.dumps(raw))
            config = AppConfig.load(app_path)
            config = replace(config, backend=BackendConfig.from_dict({
                "command": ["true"],
                "cwd": str(root),
                "runtime_profile": str(runtime_profile),
            }))
            harness = HarnessProfile.from_dict({
                "harness_id": "prototype-profile",
                "active_elements": [{
                    "element_id": "evidence_mapper",
                    "category": "subagent",
                    "description": "Map delegated evidence.",
                    "spec": {
                        "persona": "Map evidence into one bounded recommendation.",
                    },
                }],
            })
            payload = _episode_config_dict(config, harness=harness)
            runtime = payload["backend"]["runtime_profile_value"]
            self.assertEqual(
                runtime["active_cordis_plugins"],
                ["fork_context_subagent"],
            )
            self.assertEqual(
                runtime["active_subagent_prototypes"][0]["id"],
                "evidence_mapper",
            )

    def test_runtime_profile_materializes_validated_cordis_plugin_overlay(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            cordis = root / "seed.cordis.yml"
            cordis.write_text("- id: seed\n  name: '@deepseek-ai/dsh-seed'\n")
            profile = root / "runtime.json"
            profile.write_text(json.dumps({
                "runtime_type": "deepseek-harness",
                "cordis": str(cordis),
                "cordis_plugin_catalog": {
                    "search": [{
                        "id": "evolved-search",
                        "name": "@deepseek-ai/dsh-tool-fs-search",
                        "config": {"sampleOverCapGlobResults": True},
                    }],
                },
                "active_cordis_plugins": ["search"],
            }))
            captured, _, assets = capture_runtime_profile(profile)
            materialized, _ = materialize_runtime_profile(
                profile=captured,
                assets=assets,
                destination=root / "snapshot",
            )
            value = json.loads(materialized.read_text())
            effective = Path(value["cordis"]).read_text()
            self.assertIn("evolved-search", effective)
            self.assertIn("@deepseek-ai/dsh-tool-fs-search", effective)
            self.assertIn("effective_cordis_sha256", value)

    def test_runtime_profile_rejects_unknown_cordis_plugin(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            cordis = root / "seed.cordis.yml"
            cordis.write_text("- id: seed\n")
            profile = root / "runtime.json"
            profile.write_text(json.dumps({
                "runtime_type": "deepseek-harness",
                "cordis": str(cordis),
                "cordis_plugin_catalog": {},
                "active_cordis_plugins": ["not-approved"],
            }))
            with self.assertRaisesRegex(ValueError, "unknown plugins"):
                capture_runtime_profile(profile)

    def test_runtime_profile_materializes_evolved_fork_targets(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            cordis = root / "seed.cordis.yml"
            cordis.write_text("- id: seed\n  name: '@deepseek-ai/dsh-seed'\n")
            profile = root / "runtime.json"
            profile.write_text(json.dumps({
                "runtime_type": "deepseek-harness",
                "cordis": str(cordis),
                "cordis_plugin_catalog": {
                    "fork_context_subagent": [{
                        "id": "evolved-fork-provider",
                        "name": "@deepseek-ai/dsh-subagent-fork-in-process",
                        "config": {"providerName": "fork"},
                    }],
                },
                "active_cordis_plugins": ["fork_context_subagent"],
                "active_subagent_prototypes": [
                    {
                        "id": "evidence_mapper",
                        "description": "Map task evidence into bounded work.",
                        "persona": "Map evidence and return one concrete recommendation.",
                        "tool_filter": {"deny": ["fork_agent"]},
                        "max_tokens": 4096,
                    },
                    {
                        "id": "artifact_refiner",
                        "description": "Refine one delegated artifact slice.",
                        "persona": "Implement the delegated artifact slice and verify it.",
                    },
                ],
            }))
            captured, _, assets = capture_runtime_profile(profile)
            materialized, _ = materialize_runtime_profile(
                profile=captured,
                assets=assets,
                destination=root / "snapshot",
            )
            value = json.loads(materialized.read_text())
            effective = Path(value["cordis"]).read_text()
            self.assertIn("fork_agent_evidence_mapper", effective)
            self.assertIn("fork_agent_artifact_refiner", effective)
            self.assertIn("Map evidence and return one concrete recommendation.", effective)
            self.assertIn('\"maxTokens\":4096', effective)
            self.assertIn('\"enableRunInBackground\":false', effective)
            self.assertIn('\"maxDepth\":2', effective)

    def test_subagent_prototype_rejects_fork_policy_genes(self):
        with self.assertRaisesRegex(ValueError, "not fork policy"):
            HarnessElementConfig.from_dict({
                "id": "bad_child",
                "category": "subagent",
                "description": "Invalid policy-bearing child.",
                "spec": {
                    "persona": "Do one delegated task.",
                    "maxDepth": 9,
                },
                "tags": ["subagent"],
            })

    def test_subagent_prototype_rejects_root_ownership_persona(self):
        with self.assertRaisesRegex(ValueError, "injected into a child"):
            HarnessElementConfig.from_dict({
                "id": "bad_root_child",
                "category": "subagent",
                "description": "Invalid root-claiming child.",
                "spec": {
                    "persona": "You are the singleton builder and own the final delivery.",
                },
                "tags": ["subagent"],
            })

    def test_runtime_factory_is_backward_compatible_and_selects_dsh(self):
        legacy = load_runtime_config({"runtime_id": "opengame-typescript-sdk-v1"})
        self.assertIsInstance(legacy, OpenGameRuntimeConfig)
        dsh = load_runtime_config({
            "runtime_type": "deepseek-harness",
            "model": "deepseek-v4-flash",
        })
        self.assertIsInstance(dsh, DeepSeekHarnessRuntimeConfig)
        self.assertIsInstance(build_runtime(dsh, runner=FakeDeepSeekHarnessRunner()), DeepSeekHarnessRuntime)

    def test_runtime_records_trajectory_usage_and_isolated_sessions(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "README.md").write_text("seed\n", encoding="utf-8")
            skills = root / "skills"
            (skills / "probe-first").mkdir(parents=True)
            (skills / "probe-first" / "SKILL.md").write_text(
                "---\nname: probe-first\ndescription: Probe first.\n---\nUse probes.\n",
                encoding="utf-8",
            )
            runner = FakeDeepSeekHarnessRunner()
            config = DeepSeekHarnessRuntimeConfig(
                system_prompt="Harness [[MODE]]",
                system_prompt_variables={"[[MODE]]": "evolution"},
                skills_source=str(skills),
                backbone_provider=None,
                timeout_seconds=600,
            )
            runtime = DeepSeekHarnessRuntime(config, runner=runner)
            task = GameTask(
                task_id="dsh-case",
                benchmark_id="gcbench",
                prompt="Build the game.",
                task_source_ref=str(root / "task.json"),
                workspace_seed_ref=str(seed),
                artifact_relpath="game.txt",
            )
            with patch.dict(os.environ, {"AWS_SECRET_ACCESS_KEY": "must-not-leak"}):
                submission = runtime.run(task, episode_dir=root / "episode")

            self.assertEqual(submission.status, "completed", submission.to_dict())
            self.assertEqual(submission.runtime_id, "deepseek-harness-sdk-v1")
            self.assertEqual(submission.usage, {
                "inputTokens": 7,
                "outputTokens": 3,
                "cacheReadTokens": 2,
                "reasoningTokens": 1,
                "modelCalls": 1,
            })
            self.assertIn("Harness evolution", runner.calls[0]["prompt"])
            self.assertIn("## Hard runtime deadline", runner.calls[0]["prompt"])
            self.assertIn("hard 600-second wall-clock limit", runner.calls[0]["prompt"])
            isolated_workspace = (root / "episode" / "workspace").resolve()
            self.assertIn(
                f"Your only writable workspace for this episode is `{isolated_workspace}`",
                runner.calls[0]["prompt"],
            )
            self.assertIn("Ignore any different absolute", runner.calls[0]["prompt"])
            self.assertEqual(runner.calls[0]["cwd"], isolated_workspace)
            environment = runner.calls[0]["environment"]
            self.assertNotIn("AWS_SECRET_ACCESS_KEY", environment)
            self.assertEqual(
                Path(environment["DSH_HOME"]),
                (root / "episode" / "home" / ".dsh").resolve(),
            )
            self.assertNotEqual(environment["HOME"], os.environ.get("HOME"))
            self.assertTrue(
                (root / "episode" / "workspace" / ".agents" / "skills" / "probe-first" / "SKILL.md").is_file()
            )
            self.assertFalse((root / "episode" / "workspace" / ".qwen").exists())
            trajectory = [
                json.loads(line)
                for line in (root / "episode" / "trajectory.jsonl").read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(
                [item["event_type"] for item in trajectory],
                ["runtime_started", "session_event", "session_event", "notification", "runtime_finished"],
            )
            manifest = json.loads(
                (root / "episode" / "runtime_manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["runtime"]["runtime_type"], "deepseek-harness")
            self.assertEqual(
                manifest["isolation"]["runtime_layout"], "deepseek-harness"
            )

    def test_nested_awesome_skills_are_materialized_for_dsh_discovery(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / ".agents" / "skills" / "stale").mkdir(parents=True)
            (seed / ".agents" / "skills" / "stale" / "SKILL.md").write_text(
                "stale\n", encoding="utf-8"
            )
            skills = root / "awesome-skills"
            (skills / "router").mkdir(parents=True)
            (skills / "skills" / "engines" / "godot").mkdir(parents=True)
            (skills / "router" / "SKILL.md").write_text(
                "---\nname: router\ndescription: Route work.\n---\nRoute.\n",
                encoding="utf-8",
            )
            (skills / "skills" / "engines" / "godot" / "SKILL.md").write_text(
                "---\nname: godot\ndescription: Build Godot games.\n---\nBuild.\n",
                encoding="utf-8",
            )
            runner = FakeDeepSeekHarnessRunner()
            DeepSeekHarnessRuntime(
                DeepSeekHarnessRuntimeConfig(
                    backbone_provider=None,
                    skills_source=str(skills),
                ),
                runner=runner,
            ).run(
                GameTask(
                    task_id="skills",
                    benchmark_id="gcbench",
                    prompt="Build.",
                    task_source_ref=str(root),
                    workspace_seed_ref=str(seed),
                    artifact_relpath="game.txt",
                ),
                episode_dir=root / "episode",
            )

            installed = root / "episode" / "workspace" / ".agents" / "skills"
            self.assertTrue((installed / "router" / "SKILL.md").is_file())
            self.assertTrue((installed / "godot" / "SKILL.md").is_file())
            self.assertFalse((installed / "skills").exists())
            self.assertFalse((installed / "stale").exists())

    def test_mixed_polaris_route_passes_resolved_model_to_runner(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            runner = FakeDeepSeekHarnessRunner()
            runtime = DeepSeekHarnessRuntime(
                DeepSeekHarnessRuntimeConfig(),
                runner=runner,
            )
            environment = {
                "DEEPSEEK_API_KEY": "official-secret",
                "DEEPSEEK_API_BASE": "https://api.deepseek.com",
                "DEEPSEEK_ROUTE_MODE": "mixed",
                "DEEPSEEK_POLARIS_BASE_URL": "http://polaris.invalid/v1",
                "DEEPSEEK_POLARIS_API_KEY": "polaris-secret",
                "DEEPSEEK_POLARIS_MODEL": "kaiwu-llm-model",
            }
            task = GameTask(
                task_id="v030-open-circuit-paired-proof",
                benchmark_id="provider-test",
                prompt="Build.",
                task_source_ref=str(root),
                workspace_seed_ref=str(seed),
                artifact_relpath="game.txt",
            )

            with patch.dict(os.environ, environment, clear=False):
                submission = runtime.run(task, episode_dir=root / "episode")

            self.assertEqual(runner.calls[0]["config"].model, "kaiwu-llm-model")
            self.assertEqual(submission.metadata["provider_route"], "polaris")
            self.assertEqual(submission.metadata["provider_model"], "kaiwu-llm-model")
            self.assertNotIn(
                "GAME_LOOP_PROVIDER_KEY_SALT",
                runner.calls[0]["config"].environment,
            )

    def test_existing_seed_artifact_must_be_changed_by_the_agent(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "game.txt").write_text("seed output\n", encoding="utf-8")
            submission = DeepSeekHarnessRuntime(
                DeepSeekHarnessRuntimeConfig(backbone_provider=None),
                runner=FakeDeepSeekHarnessRunner(write_artifact=False),
            ).run(
                GameTask(
                    task_id="unchanged",
                    benchmark_id="verigame",
                    prompt="Build.",
                    task_source_ref=str(root),
                    workspace_seed_ref=str(seed),
                    artifact_relpath="game.txt",
                ),
                episode_dir=root / "episode",
            )
            self.assertEqual(submission.status, "failed")
            self.assertTrue(any("not changed" in item for item in submission.diagnostics))

    def test_runtime_failure_never_promotes_an_empty_artifact(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            runner = FakeDeepSeekHarnessRunner(write_artifact=False, finish_reason="error")
            runtime = DeepSeekHarnessRuntime(
                DeepSeekHarnessRuntimeConfig(backbone_provider=None), runner=runner
            )
            submission = runtime.run(
                GameTask(
                    task_id="failed",
                    benchmark_id="verigame",
                    prompt="Build.",
                    task_source_ref=str(root),
                    workspace_seed_ref=str(seed),
                    artifact_relpath="game.txt",
                ),
                episode_dir=root / "episode",
            )
            self.assertEqual(submission.status, "failed")
            self.assertIsNone(submission.artifact_ref)
            self.assertTrue(any("finish reason" in item for item in submission.diagnostics))

    def test_runtime_rejects_blocked_and_missing_finish_reasons(self):
        for finish_reason in ("blocked", "max-tokens", "future-reason", None):
            with self.subTest(finish_reason=finish_reason), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                seed = root / "seed"
                seed.mkdir()
                runner = FakeDeepSeekHarnessRunner(finish_reason=finish_reason)
                submission = DeepSeekHarnessRuntime(
                    DeepSeekHarnessRuntimeConfig(backbone_provider=None),
                    runner=runner,
                ).run(
                    GameTask(
                        task_id="incomplete",
                        benchmark_id="verigame",
                        prompt="Build.",
                        task_source_ref=str(root),
                        workspace_seed_ref=str(seed),
                        artifact_relpath="game.txt",
                    ),
                    episode_dir=root / "episode",
                )
                self.assertEqual(submission.status, "failed")
                self.assertIsNone(submission.artifact_ref)

    def test_max_tokens_requires_explicit_success_policy(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            submission = DeepSeekHarnessRuntime(
                DeepSeekHarnessRuntimeConfig(
                    backbone_provider=None,
                    successful_finish_reasons=("completed", "max-tokens"),
                ),
                runner=FakeDeepSeekHarnessRunner(finish_reason="max-tokens"),
            ).run(
                GameTask("opt-in", "verigame", "Build.", str(root), str(seed), "game.txt"),
                episode_dir=root / "episode",
            )
            self.assertEqual(submission.status, "completed")

    def test_descendant_notification_usage_is_counted_once(self):
        class DescendantRunner(FakeDeepSeekHarnessRunner):
            def run(self, prompt, *, cwd, session_root, config, environment):
                base = super().run(
                    prompt, cwd=cwd, session_root=session_root,
                    config=config, environment=environment,
                )
                root_event = base.events[-1]
                child_event = {
                    "type": "assistant/message",
                    "data": {"turn": 1, "step": 1,
                             "usage": {"inputTokens": 5, "outputTokens": 2}},
                }
                return DeepSeekHarnessRunnerResult(
                    base.finish_reason, base.final_response, base.events,
                    (
                        {"method": "session.event", "payload": {
                            "sessionId": "root", "event": root_event}},
                        {"method": "session.event", "payload": {
                            "sessionId": "child", "event": child_event}},
                    ),
                    base.session_root,
                )

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            submission = DeepSeekHarnessRuntime(
                DeepSeekHarnessRuntimeConfig(backbone_provider=None),
                runner=DescendantRunner(),
            ).run(
                GameTask("usage", "verigame", "Build.", str(root), str(seed), "game.txt"),
                episode_dir=root / "episode",
            )
            self.assertEqual(submission.usage["inputTokens"], 12)
            self.assertEqual(submission.usage["outputTokens"], 5)

    def test_profile_rejects_embedded_credentials(self):
        with self.assertRaisesRegex(ValueError, "cannot contain credentials"):
            DeepSeekHarnessRuntimeConfig(environment={"DEEPSEEK_API_KEY": "secret"})

    def test_doctor_requires_static_inputs_provider_and_sdk_startup(self):
        class DoctorRunner(FakeDeepSeekHarnessRunner):
            def doctor(self, config, environment):
                return {"sdk_importable": True, "sdk_startup": False}

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            cordis = root / "cordis.yml"
            cordis.write_text("- id: test\n", encoding="utf-8")
            report = DeepSeekHarnessRuntime(
                DeepSeekHarnessRuntimeConfig(
                    backbone_provider=None,
                    cordis=str(cordis),
                    runtime_cwd=str(root),
                ),
                runner=DoctorRunner(),
            ).doctor()
            self.assertFalse(report["ok"])
            self.assertFalse(report["checks"]["sdk_startup"])

    def test_environment_can_select_dsh_runtime_for_bridges(self):
        from game_loop.benchmarks.runtime_config import runtime_config_from_environment

        with patch.dict(
            os.environ,
            {
                "GAME_LOOP_MAKER_RUNTIME": "dsh",
                "GAME_LOOP_BACKBONE_PROVIDER": "deepseek",
                "CODEX_MODEL": "deepseek-v4-flash",
            },
            clear=False,
        ):
            config = runtime_config_from_environment(timeout_seconds=123)
        self.assertIsInstance(config, DeepSeekHarnessRuntimeConfig)
        self.assertEqual(config.timeout_seconds, 123)

    def test_backend_profile_is_pinned_and_loaded_by_bridge_runtime(self):
        from game_loop.benchmarks.runtime_config import runtime_config_from_environment

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            profile = root / "dsh.json"
            profile.write_text(
                json.dumps({
                    "runtime_type": "deepseek-harness",
                    "backbone_provider": None,
                    "model": "test-dsh-model",
                }),
                encoding="utf-8",
            )
            backend = BackendConfig.from_dict({
                "command": ["true"],
                "cwd": str(root),
                "runtime_profile": "dsh.json",
            })
            self.assertEqual(backend.runtime_profile, profile.resolve())
            self.assertIsNotNone(backend.runtime_profile_hash)
            with patch.dict(
                os.environ,
                {"GAME_LOOP_MAKER_RUNTIME_PROFILE": str(backend.runtime_profile)},
                clear=False,
            ):
                config = runtime_config_from_environment(timeout_seconds=456)
            self.assertIsInstance(config, DeepSeekHarnessRuntimeConfig)
            self.assertEqual(config.model, "test-dsh-model")
            self.assertEqual(config.timeout_seconds, 3600)

    def test_command_backend_exports_pinned_runtime_profile(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            profile = root / "dsh.json"
            profile.write_text(
                json.dumps({
                    "runtime_type": "deepseek-harness",
                    "backbone_provider": None,
                    "model": "test-dsh-model",
                }),
                encoding="utf-8",
            )
            backend_config = BackendConfig.from_dict({
                "command": ["true"],
                "cwd": str(root),
                "runtime_profile": "dsh.json",
            })
            process = Mock()
            process.wait.return_value = 0
            with patch(
                "game_loop.backends.command.subprocess.Popen",
                return_value=process,
            ) as popen:
                execution = CommandBackend(backend_config).run(
                    PreparedTask("verigame", root, {}),
                    root,
                )

            self.assertEqual(execution.return_code, 0)
            exported = Path(
                popen.call_args.kwargs["env"]["GAME_LOOP_MAKER_RUNTIME_PROFILE"]
            )
            self.assertNotEqual(exported, profile.resolve())
            self.assertTrue(exported.is_file())
            self.assertEqual(json.loads(exported.read_text())["model"], "test-dsh-model")
            self.assertEqual(
                popen.call_args.kwargs["env"]["GAME_LOOP_MAKER_RUNTIME_PROFILE_HASH"],
                json.loads((root / "backend_manifest.json").read_text())[
                    "runtime_profile_snapshot_hash"
                ],
            )
            manifest = json.loads((root / "backend_manifest.json").read_text())
            self.assertEqual(manifest["runtime_profile"], str(profile.resolve()))
            self.assertEqual(
                manifest["runtime_profile_hash"],
                backend_config.runtime_profile_hash,
            )

    def test_command_backend_uses_captured_profile_after_source_changes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            profile = root / "dsh.json"
            profile.write_text(json.dumps({
                "runtime_type": "deepseek-harness",
                "backbone_provider": None,
                "model": "captured-model",
            }), encoding="utf-8")
            config = BackendConfig.from_dict({
                "command": ["true"], "cwd": str(root),
                "runtime_profile": str(profile),
            })
            profile.write_text(json.dumps({
                "runtime_type": "deepseek-harness", "model": "mutated-model",
            }), encoding="utf-8")
            process = Mock()
            process.wait.return_value = 0
            with patch("game_loop.backends.command.subprocess.Popen", return_value=process) as popen:
                CommandBackend(config).run(PreparedTask("verigame", root, {}), root)
            snapshot = Path(popen.call_args.kwargs["env"]["GAME_LOOP_MAKER_RUNTIME_PROFILE"])
            self.assertEqual(json.loads(snapshot.read_text())["model"], "captured-model")

    def test_command_backend_rejects_changed_profile_asset(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            cordis = root / "cordis.yml"
            cordis.write_text("- id: original\n", encoding="utf-8")
            profile = root / "dsh.json"
            profile.write_text(json.dumps({
                "runtime_type": "deepseek-harness",
                "backbone_provider": None,
                "model": "test-model",
                "cordis": str(cordis),
            }), encoding="utf-8")
            config = BackendConfig.from_dict({
                "command": ["true"], "cwd": str(root),
                "runtime_profile": str(profile),
            })
            cordis.write_text("- id: mutated\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "asset changed"):
                CommandBackend(config).run(PreparedTask("verigame", root, {}), root)

    def test_terminalbench_collector_preserves_generated_workspace(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            candidate = root / "candidate"
            candidate.mkdir()
            generated = root / "maker" / "workspace"
            generated.mkdir(parents=True)
            (generated / "answer.txt").write_text("agent output\n", encoding="utf-8")
            result_dir = root / "results"
            result_dir.mkdir()
            (result_dir / "result.json").write_text(json.dumps({
                "passed": True, "reward": 1.0, "infrastructure_error": False,
            }), encoding="utf-8")
            manifest = candidate / "terminalbench_execution.json"
            manifest.write_text(json.dumps({
                "result_dir": str(result_dir), "artifact_dir": str(generated),
            }), encoding="utf-8")
            prepared = PreparedTask(
                "terminalbench", candidate, {},
                {"output_manifest": str(manifest), "candidate_dir": str(candidate)},
            )
            result = TerminalBenchAdapter({}).collect(
                prepared, BackendExecution(0, candidate / "backend.log")
            )
            self.assertIsNotNone(result.artifact_dir)
            self.assertTrue((result.artifact_dir / "answer.txt").is_file())
            self.assertFalse((result.artifact_dir / "result.json").exists())

    def test_python_sdk_runner_enforces_full_turn_timeout_and_closes_runtime(self):
        closed = threading.Event()
        started_environment: dict[str, str] = {}

        class HangingHarness:
            def __init__(self, **kwargs):
                self.client = self
                self.id = "hanging-session"

            def start(self):
                started_environment.update(os.environ)

            def start_session(self):
                return self

            def run(self, prompt, on_notification=None):
                closed.wait(10)
                raise RuntimeError("transport closed")

            def close(self):
                closed.set()

        fake_module = types.ModuleType("deepseek_harness")
        fake_module.DeepSeekHarness = HangingHarness
        with tempfile.TemporaryDirectory() as td, patch.dict(
            sys.modules, {"deepseek_harness": fake_module}
        ), patch.dict(os.environ, {"AWS_SECRET_ACCESS_KEY": "must-not-leak"}):
            root = Path(td)
            started = time.monotonic()
            with self.assertRaisesRegex(TimeoutError, "timed out"):
                PythonSDKRunner().run(
                    "wait", cwd=root, session_root=root / "sessions",
                    config=DeepSeekHarnessRuntimeConfig(
                        backbone_provider=None, timeout_seconds=1,
                        shutdown_timeout_seconds=0.2,
                    ),
                    environment={},
                )
            self.assertLess(time.monotonic() - started, 2.0)
            self.assertTrue(closed.is_set())
            self.assertNotIn("AWS_SECRET_ACCESS_KEY", started_environment)
            self.assertEqual(os.environ["AWS_SECRET_ACCESS_KEY"], "must-not-leak")

    def test_python_sdk_runner_cancels_and_finishes_in_same_session(self):
        cancelled = threading.Event()
        prompts: list[str] = []
        notifications: list[tuple[str, dict[str, str]]] = []

        class Result:
            def __init__(self, reason, response, turn):
                self.finish_reason = reason
                self.final_response = response
                self.events = ({
                    "type": "assistant/message",
                    "data": {
                        "turn": turn,
                        "step": 1,
                        "usage": {"inputTokens": turn * 10, "outputTokens": turn},
                    },
                },)
                self.notifications = ()
                self.session_root = "/fake/session"

        class Session:
            id = "shared-session"

            def run(self, prompt, on_notification=None):
                prompts.append(prompt)
                if len(prompts) == 1:
                    cancelled.wait(5)
                    return Result("cancelled", "partial", 1)
                return Result("completed", "finalized", 2)

        class ControlledHarness:
            def __init__(self, **kwargs):
                self.client = self
                self.session = Session()

            def start(self):
                pass

            def start_session(self):
                return self.session

            def notify(self, method, params):
                notifications.append((method, params))
                cancelled.set()

            def close(self):
                cancelled.set()

        fake_module = types.ModuleType("deepseek_harness")
        fake_module.DeepSeekHarness = ControlledHarness
        with tempfile.TemporaryDirectory() as td, patch.dict(
            sys.modules, {"deepseek_harness": fake_module}
        ):
            root = Path(td)
            result = PythonSDKRunner().run(
                "build",
                cwd=root,
                session_root=root / "sessions",
                config=DeepSeekHarnessRuntimeConfig(
                    backbone_provider=None,
                    timeout_seconds=3,
                    finalization_reserve_seconds=2,
                    finalization_cancel_grace_seconds=0.5,
                ),
                environment={},
            )

        self.assertEqual(result.finish_reason, "completed")
        self.assertEqual(result.final_response, "finalized")
        self.assertEqual(result.model_calls, 2)
        self.assertTrue(result.finalization_attempted)
        self.assertTrue(result.finalization_completed)
        self.assertEqual(len(prompts), 2)
        self.assertIn("Do not call any tool", prompts[1])
        self.assertEqual(
            notifications,
            [("session/cancel", {"sessionId": "shared-session"})],
        )
        usage = _collect_usage(result.events, result.notifications)
        self.assertEqual(usage["inputTokens"], 30)
        self.assertEqual(usage["outputTokens"], 3)

    def test_python_sdk_runner_restarts_finalization_when_cancel_is_blocked(self):
        instances = []

        class Result:
            finish_reason = "completed"
            final_response = "recovered"
            events = ()
            notifications = ()
            session_root = "/fake/session"

        class Session:
            id = "session"

            def __init__(self, owner):
                self.owner = owner

            def run(self, prompt, on_notification=None):
                if self.owner.index == 0:
                    if on_notification is not None:
                        on_notification({
                            "method": "session.event",
                            "payload": {
                                "sessionId": "session",
                                "event": {
                                    "type": "assistant/message",
                                    "data": {
                                        "turn": 1,
                                        "step": 1,
                                        "usage": {"inputTokens": 9, "outputTokens": 1},
                                    },
                                },
                            },
                        })
                    self.owner.closed.wait(5)
                    raise RuntimeError("transport closed")
                return Result()

        class RestartedHarness:
            def __init__(self, **kwargs):
                self.index = len(instances)
                self.closed = threading.Event()
                self.client = self
                instances.append(self)

            def start(self):
                pass

            def start_session(self):
                return Session(self)

            def notify(self, method, params):
                pass

            def close(self):
                self.closed.set()

        fake_module = types.ModuleType("deepseek_harness")
        fake_module.DeepSeekHarness = RestartedHarness
        with tempfile.TemporaryDirectory() as td, patch.dict(
            sys.modules, {"deepseek_harness": fake_module}
        ):
            root = Path(td)
            result = PythonSDKRunner().run(
                "build",
                cwd=root,
                session_root=root / "sessions",
                config=DeepSeekHarnessRuntimeConfig(
                    backbone_provider=None,
                    timeout_seconds=3,
                    finalization_reserve_seconds=2,
                    finalization_cancel_grace_seconds=0.1,
                ),
                environment={},
            )

        self.assertEqual(len(instances), 2)
        self.assertEqual(result.finish_reason, "completed")
        self.assertTrue(result.finalization_restarted)
        self.assertEqual(result.model_calls, 2)
        usage = _collect_usage(result.events, result.notifications)
        self.assertEqual(usage, {"inputTokens": 9, "outputTokens": 1})

    def test_runtime_profile_content_changes_app_config_fingerprint(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            profile = root / "dsh.json"
            profile.write_text(
                json.dumps({"runtime_type": "deepseek-harness", "model": "model-a"}),
                encoding="utf-8",
            )
            app_path = root / "app.json"
            app_path.write_text(
                json.dumps({
                    "benchmark": {"adapter": "verigame"},
                    "backend": {
                        "command": ["true"],
                        "cwd": str(root),
                        "runtime_profile": str(profile),
                    },
                    "method": {"level": "L0"},
                }),
                encoding="utf-8",
            )
            before = AppConfig.load(app_path).fingerprint
            profile.write_text(
                json.dumps({"runtime_type": "deepseek-harness", "model": "model-b"}),
                encoding="utf-8",
            )
            after = AppConfig.load(app_path).fingerprint
            self.assertNotEqual(before, after)

    def test_official_python_sdk_runner_protocol_smoke_when_installed(self):
        try:
            import deepseek_harness  # noqa: F401
        except ImportError:
            self.skipTest("optional deepseek-harness-sdk is not installed")

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            script = root / "fake_dsh_runtime.py"
            script.write_text(
                """
import json
import os
import pathlib
import sys

for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif method == "session/prompt":
        session_id = message["params"]["sessionId"]
        pathlib.Path(os.environ["DSH_CWD"], "game.txt").write_text("sdk protocol smoke\\n")
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": session_id, "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": session_id, "event": {"type": "assistant/message", "data": {"message": {"role": "assistant", "content": [{"type": "text", "text": "SDK_OK"}]}}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": session_id, "event": {"type": "turn/end", "data": {"reason": {"kind": "completed"}}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": session_id, "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {}}), flush=True)
        break
""".strip()
                + "\n",
                encoding="utf-8",
            )
            config = DeepSeekHarnessRuntimeConfig(
                backbone_provider=None,
                launch_args_override=(sys.executable, str(script)),
                runtime_cwd=str(root),
                timeout_seconds=10,
            )
            submission = DeepSeekHarnessRuntime(config).run(
                GameTask(
                    task_id="sdk-smoke",
                    benchmark_id="verigame",
                    prompt="Build.",
                    task_source_ref=str(root),
                    workspace_seed_ref=str(seed),
                    artifact_relpath="game.txt",
                ),
                episode_dir=root / "episode",
            )
            self.assertEqual(submission.status, "completed", submission.to_dict())
            self.assertEqual(submission.result_text, "SDK_OK")


if __name__ == "__main__":
    unittest.main()
