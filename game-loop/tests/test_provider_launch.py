from __future__ import annotations

import json
import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from game_loop.backends.command import CommandBackend
from game_loop.config import BackendConfig
from game_loop.core.models import PreparedTask
from game_loop.gcbench_runtime import sanitize_public_instruction, stage_local_runtime_overlay


ROOT = Path(__file__).resolve().parents[1]
PROVIDER_ENV = ROOT / "scripts" / "provider_env.sh"
CONFIGS = ROOT / "experiments" / "configs-v4"


def _provider_policy(script: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", f'source "$1"; {script}', "bash", str(PROVIDER_ENV)],
        env={"PATH": os.environ.get("PATH", ""), **env},
        text=True,
        capture_output=True,
        check=False,
    )


class ProviderLaunchTests(unittest.TestCase):
    def test_text_only_removes_visual_tool_from_prompt_and_workspace(self) -> None:
        instruction = (
            "# Task\n\nKeep authored visuals.\n\n"
            "A screenshot helper is available at `/workspace/tools/screenshot.sh`.\n\n"
            "```\n/workspace/tools/screenshot.sh --path /workspace/game\n```\n\n"
            "To screenshot a scenario, append `--scenario demo`.\n\n"
            "## Demos\n\nShip deterministic traces.\n"
        )
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            tools = root / "gcbench" / "tools"
            tools.mkdir(parents=True)
            (tools / "screenshot.sh").write_text("#!/bin/sh\n", encoding="utf-8")
            with patch.dict(os.environ, {"GAME_LOOP_TEXT_ONLY": "1"}, clear=False):
                with patch(
                    "game_loop.gcbench_runtime.resolve_godot_executable",
                    return_value="/bin/true",
                ):
                    stage_local_runtime_overlay(
                        overlay_workspace=root / "workspace",
                        gcbench_root=root / "gcbench",
                    )
                sanitized = sanitize_public_instruction(instruction)
            self.assertFalse((root / "workspace/tools/screenshot.sh").exists())
            self.assertNotIn("screenshot", sanitized.casefold())
            self.assertIn("Keep authored visuals", sanitized)
            self.assertIn("Ship deterministic traces", sanitized)

    def test_internal_provider_is_real_without_api_key(self) -> None:
        providers = [
        ("http://29.116.237.135:8080/v1", "Kimi-K2.7-Code"),
        ("http://29.116.237.75:8080/v1", "GLM-5.2-W4AFP8-node1"),
        ]
        for base, model in providers:
            with self.subTest(model=model):
                env = {"CODEX_API_BASE": base, "CODEX_MODEL": model}
                self.assertEqual(_provider_policy("game_loop_validate_agent_env", env).returncode, 0)
                self.assertEqual(_provider_policy("game_loop_should_stub_agent", env).returncode, 1)

    def test_dashscope_qwen_requires_runtime_secret(self) -> None:
        env = {
            "CODEX_API_BASE": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "CODEX_MODEL": "qwen3.6-27b",
            "GAME_LOOP_AGENT_REQUIRES_API_KEY": "1",
        }
        missing = _provider_policy("game_loop_validate_agent_env", env)
        self.assertNotEqual(missing.returncode, 0)
        env["CODEX_API_KEY"] = "runtime-secret"
        self.assertEqual(_provider_policy("game_loop_validate_agent_env", env).returncode, 0)

    def test_stub_requires_explicit_switch(self) -> None:
        completed = _provider_policy(
            "game_loop_should_stub_agent",
            {"GAME_LOOP_STUB_AGENT": "1"},
        )
        self.assertEqual(completed.returncode, 0)

    def test_deepseek_requires_runtime_secret(self) -> None:
        env = {
            "CODEX_API_BASE": "https://api.deepseek.com",
            "CODEX_MODEL": "deepseek-v4-flash",
            "GAME_LOOP_AGENT_REQUIRES_API_KEY": "1",
        }
        missing = _provider_policy("game_loop_validate_agent_env", env)
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("CODEX_API_KEY is required", missing.stderr)
        env["CODEX_API_KEY"] = "runtime-secret"
        self.assertEqual(_provider_policy("game_loop_validate_agent_env", env).returncode, 0)

    def test_produce_configs_do_not_embed_api_key(self) -> None:
        filenames = [
        "gcbench-L4_deepseek_v4_produce.json",
        "gcbench-L4_kimi_produce.json",
        "gcbench-L4_glm5.2_produce.json",
        "gcbench-L4_qwen3.6-27b_produce.json",
        ]
        for filename in filenames:
            with self.subTest(filename=filename):
                config = json.loads((CONFIGS / filename).read_text(encoding="utf-8"))
                self.assertNotIn("CODEX_API_KEY", config["backend"]["env"])

    def test_generated_configs_never_embed_placeholder_api_keys(self) -> None:
        for directory in (CONFIGS, ROOT / "experiments" / "configs-ablation"):
            for path in directory.glob("*.json"):
                self.assertNotIn("sk-placeholder", path.read_text(encoding="utf-8"), str(path))

    def test_bootstrap_never_writes_fake_credentials(self) -> None:
        source = (ROOT / "experiments" / "scripts" / "bootstrap_produce_run.py").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("sk-your-key-here", source)
        self.assertNotIn("sk-placeholder", source)

    def test_keyless_provider_uses_empty_openai_compatible_bearer(self) -> None:
        source = (ROOT / "experiments" / "scripts" / "bootstrap_produce_run.py").read_text(
            encoding="utf-8"
        )
        self.assertIn('export CODEX_API_KEY="${CODEX_API_KEY:-EMPTY}"', source)
        self.assertIn('GAME_LOOP_AGENT_REQUIRES_API_KEY:-0', source)

    def test_bootstrap_builds_a_real_cross_task_admission_pool(self) -> None:
        bootstrap_path = ROOT / "experiments" / "scripts" / "bootstrap_produce_run.py"
        spec = importlib.util.spec_from_file_location("bootstrap_produce_run", bootstrap_path)
        self.assertIsNotNone(spec)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        pool = module.build_task_pool()
        task_refs = {str(entry["task_ref"]) for entry in pool}
        self.assertGreaterEqual(len(task_refs), 3)
        self.assertEqual(len(task_refs), len(pool))
        self.assertIn("../../../../gcbench/tasks/puzzle-sokoban-dungeon", task_refs)

    def test_text_only_switch_removes_every_visual_harness_path(self) -> None:
        bootstrap_path = ROOT / "experiments" / "scripts" / "bootstrap_produce_run.py"
        spec = importlib.util.spec_from_file_location("bootstrap_text_only", bootstrap_path)
        self.assertIsNotNone(spec)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        config = json.loads((CONFIGS / "gcbench-L4_kimi.json").read_text(encoding="utf-8"))
        module._disable_visual_harness(config)
        harness = config["method"]["harness_evolution"]
        serialized = json.dumps({
            "modules": harness["modules"],
            "tool_interfaces": harness["tool_interfaces"],
            "element_catalog": harness["element_catalog"],
            "seed_elements": harness["seed_elements"],
        }).casefold()
        for forbidden in ("visual", "screenshot", "image", "video"):
            self.assertNotIn(forbidden, serialized)
        self.assertLess(len(harness["element_catalog"]), 30)

    def test_daemon_is_the_only_watchdog_owner(self) -> None:
        source = (ROOT / "experiments" / "scripts" / "bootstrap_produce_run.py").read_text(
            encoding="utf-8"
        )
        supervisor = source.split("START_SUPERVISOR_SH =", 1)[1].split("WATCHDOG_SH =", 1)[0]
        self.assertNotIn('bash "$RUN_DIR/watchdog.sh"', supervisor)
        daemon = (ROOT / "experiments" / "scripts" / "run_experiment_daemon.py").read_text(
            encoding="utf-8"
        )
        self.assertIn('str(watchdog), "--foreground"', daemon)

    def test_parallel_start_preflights_before_stopping(self) -> None:
        source = (ROOT / "experiments" / "scripts" / "start_parallel_produce.sh").read_text(
            encoding="utf-8"
        )
        self.assertLess(source.index('preflight_provider "$model"'), source.index('stop_run "$ROOT/experiments/runs/gcbench-harness-evolve"'))

    def test_orphan_stop_matches_exact_run_and_known_roles(self) -> None:
        helper_path = ROOT / "experiments" / "scripts" / "stop_run_processes.py"
        spec = importlib.util.spec_from_file_location("stop_run_processes", helper_path)
        self.assertIsNotNone(spec)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        run_dir = ROOT / "experiments" / "runs" / "gcbench-produce-kimi"
        other = ROOT / "experiments" / "runs" / "gcbench-produce-qwen"
        table = {
            100: (1, f"python -m game_loop.cli harness-self-supervise --outer-dir {run_dir}"),
            101: (100, "python -m game_loop.chat_agent"),
            200: (1, f"python -m game_loop.cli harness-self-supervise --outer-dir {other}"),
            300: (1, f"python unrelated.py {run_dir}"),
        }
        self.assertEqual(module.matching_process_tree(run_dir, table), [101, 100])

    def test_launcher_environment_wins_over_backend_config(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            tmp_path = Path(raw)
            process = Mock()
            process.wait.return_value = 0
            backend = CommandBackend(
                BackendConfig(
                    command=("true",),
                    cwd=tmp_path,
                    env={"CODEX_API_KEY": "config-value"},
                )
            )
            prepared = PreparedTask("test", tmp_path, {})
            with patch.dict(os.environ, {"CODEX_API_KEY": "runtime-value"}, clear=False):
                with patch("game_loop.backends.command.subprocess.Popen", return_value=process) as popen:
                    result = backend.run(prepared, tmp_path)
            self.assertEqual(result.return_code, 0)
            self.assertEqual(popen.call_args.kwargs["env"]["CODEX_API_KEY"], "runtime-value")

    def test_backend_config_routes_provider_even_when_shell_has_stale_base(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            tmp_path = Path(raw)
            process = Mock()
            process.wait.return_value = 0
            backend = CommandBackend(
                BackendConfig(
                    command=("true",),
                    cwd=tmp_path,
                    env={
                        "CODEX_API_BASE": "http://29.163.228.59:8080/v1",
                        "CODEX_MODEL": "Qwen3.6-27B",
                    },
                )
            )
            prepared = PreparedTask("test", tmp_path, {})
            stale = {
                "CODEX_API_BASE": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "CODEX_MODEL": "qwen3.6-27b",
            }
            with patch.dict(os.environ, stale, clear=False):
                with patch("game_loop.backends.command.subprocess.Popen", return_value=process) as popen:
                    result = backend.run(prepared, tmp_path)
            self.assertEqual(result.return_code, 0)
            self.assertEqual(popen.call_args.kwargs["env"]["CODEX_API_BASE"], "http://29.163.228.59:8080/v1")
            self.assertEqual(popen.call_args.kwargs["env"]["CODEX_MODEL"], "Qwen3.6-27B")

    def test_daemon_template_owns_descendants_and_rejects_stale_pid(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            tmp_path = Path(raw)
            daemon_path = ROOT / "experiments" / "scripts" / "run_experiment_daemon.py"
            spec = importlib.util.spec_from_file_location("run_experiment_daemon", daemon_path)
            self.assertIsNotNone(spec)
            assert spec is not None and spec.loader is not None
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            (tmp_path / "daemon.pid").write_text("100\n", encoding="utf-8")
            (tmp_path / "supervisor.pid").write_text("900\n", encoding="utf-8")
            table = {
                100: (1, f"bash {tmp_path}/watchdog.sh --foreground"),
                101: (100, "python -m game_loop.experiment_watchdog"),
                102: (101, "python -m game_loop.chat_agent"),
                900: (1, "python unrelated_service.py"),
            }
            with patch.object(module, "_process_table", return_value=table):
                self.assertEqual(module._owned_process_tree(tmp_path), [102, 101, 100])

    def test_daemon_records_itself_as_the_single_watchdog(self) -> None:
        source = (ROOT / "experiments" / "scripts" / "run_experiment_daemon.py").read_text(
            encoding="utf-8"
        )
        self.assertIn('(run_dir / "watchdog.pid").write_text(pid_text', source)
        self.assertIn('str(watchdog), "--foreground"', source)

    def test_daemon_accepts_business_supervisor_pidfile(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            tmp_path = Path(raw)
            daemon_path = ROOT / "experiments" / "scripts" / "run_experiment_daemon.py"
            spec = importlib.util.spec_from_file_location(
                "run_experiment_daemon_json_pid",
                daemon_path,
            )
            self.assertIsNotNone(spec)
            assert spec is not None and spec.loader is not None
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            (tmp_path / ".supervisor.pid").write_text(
                '{"pid": 100}\n',
                encoding="utf-8",
            )
            table = {
                100: (
                    1,
                    f"python -m game_loop.cli harness-self-supervise --outer-dir {tmp_path}",
                ),
                101: (100, "python -m game_loop.chat_agent"),
            }
            with patch.object(module, "_process_table", return_value=table):
                self.assertEqual(module._owned_process_tree(tmp_path), [101, 100])

    def test_bootstrap_uses_versioned_daemon_template(self) -> None:
        source = (ROOT / "experiments" / "scripts" / "bootstrap_produce_run.py").read_text(
            encoding="utf-8"
        )
        self.assertIn('experiments/scripts/run_experiment_daemon.py', source)
        self.assertNotIn('runs/gcbench-harness-evolve/run_experiment_daemon.py', source)


if __name__ == "__main__":
    unittest.main()
