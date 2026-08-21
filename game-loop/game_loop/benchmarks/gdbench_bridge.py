from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import os
import queue
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from game_loop.runtime import GameTask, MakerRuntime, build_runtime, load_runtime_config

from .runtime_config import load_pinned_runtime_profile, runtime_config_from_environment


def _ensure_gdbench_import_stubs() -> None:
    """Validation-only bridge must not require solver SDK packages at import time."""
    import types

    if "claude_agent_sdk" in sys.modules:
        return

    class MessageParseError(Exception):
        pass

    def _parse_message(_data):
        return None

    parser = types.ModuleType("claude_agent_sdk._internal.message_parser")
    parser.MessageParseError = MessageParseError
    parser.parse_message = _parse_message
    internal = types.ModuleType("claude_agent_sdk._internal")
    internal.message_parser = parser
    root = types.ModuleType("claude_agent_sdk")
    root._internal = internal
    root.query = lambda *args, **kwargs: None
    root.ClaudeAgentOptions = type("ClaudeAgentOptions", (), {})
    client = types.ModuleType("claude_agent_sdk.client")
    sys.modules["claude_agent_sdk"] = root
    sys.modules["claude_agent_sdk._internal"] = internal
    sys.modules["claude_agent_sdk._internal.message_parser"] = parser
    sys.modules["claude_agent_sdk.client"] = client


def doctor(
    *,
    gdbench_root: Path,
    agent_workspace: Path,
    private_task_source: Path,
    instruction_file: Path,
) -> dict[str, object]:
    root = gdbench_root.expanduser().resolve()
    workspace = agent_workspace.expanduser().resolve()
    private_source = private_task_source.expanduser().resolve()
    instruction = instruction_file.expanduser().resolve()
    godot = os.environ.get("GODOT_EXEC_PATH") or _default_godot_path(root)
    godot_resolved = shutil.which(godot) or (
        str(Path(godot).expanduser().resolve())
        if Path(godot).expanduser().is_file()
        else None
    )
    checks = {
        "official_runner_exists": (root / "gamedevbench" / "src" / "benchmark_runner.py").is_file(),
        "godot_resolves": godot_resolved is not None,
        "agent_workspace_exists": workspace.is_dir(),
        "instruction_exists": instruction.is_file(),
        "private_task_source_exists": private_source.is_dir(),
        "hidden_task_config_exists": (private_source / "task_config.json").is_file(),
        "hidden_test_script_exists": (private_source / "scripts" / "test.gd").is_file(),
        "hidden_files_absent_from_agent_workspace": not any(
            (workspace / relative).exists()
            for relative in ("task_config.json", "scripts/test.gd", "scenes/test.tscn")
        ),
    }
    return {
        "benchmark": "gamedevbench",
        "ok": all(checks.values()),
        "checks": checks,
        "godot": godot_resolved,
        "mode_boundary": "maker runtime followed by GodotBenchmarkRunner(agent=None) validation-only",
    }


def _default_godot_path(gdbench_root: Path) -> str:
    # Prefer a local engine.  The Docker wrapper is a useful fallback, but its
    # executable can resolve while the daemon is down; that previously turned
    # every validator invocation into an apparent benchmark failure.
    for candidate in (
        shutil.which("godot"),
        "/Applications/Godot.app/Contents/MacOS/Godot",
    ):
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    start = gdbench_root.resolve()
    for root in (start, *start.parents):
        for candidate in (
            root / "scripts" / "gdbench_e2e" / "godot_docker.sh",
            root / "game-loop" / "scripts" / "gdbench_e2e" / "godot_docker.sh",
        ):
            if candidate.is_file():
                return str(candidate)
    return "godot"


def _godot_backend_error(godot_path: str) -> str | None:
    try:
        completed = subprocess.run(
            [godot_path, "--version"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return f"Godot backend unavailable: {exc}"
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        return f"Godot backend unavailable: {detail or f'exit {completed.returncode}'}"
    return None


def run_bridge(
    *,
    runtime: MakerRuntime,
    gdbench_root: Path,
    agent_workspace: Path,
    private_task_source: Path,
    task_name: str,
    instruction_file: Path,
    output_manifest: Path,
    evaluator_timeout: int = 900,
) -> int:
    root = gdbench_root.resolve()
    workspace = agent_workspace.resolve()
    private_source = private_task_source.resolve()
    output_manifest = output_manifest.resolve()
    output_root = output_manifest.parent / "gdbench_bridge"
    task = GameTask(
        task_id=task_name,
        benchmark_id="gamedevbench",
        prompt=instruction_file.read_text(encoding="utf-8"),
        task_source_ref=str(instruction_file.resolve()),
        workspace_seed_ref=str(workspace),
        artifact_relpath=".",
        constraints={"hidden_evaluator": True, "edit_existing_project": True},
    )
    submission = runtime.run(task, episode_dir=output_root / "maker_episode")
    artifact = Path(submission.artifact_ref) if submission.artifact_ref else None

    result: dict = {
        "task_name": task_name,
        "success": False,
        "message": "maker runtime failed",
        "solver_success": submission.status == "completed",
    }
    retained = output_manifest.parent / "gdbench_result"
    if retained.exists():
        shutil.rmtree(retained)
    retained.mkdir(parents=True)

    if submission.status == "completed" and artifact is not None:
        with tempfile.TemporaryDirectory(prefix="game-loop-gdbench-eval-") as td:
            evaluation_root = Path(td)
            tasks_dir = evaluation_root / "tasks"
            validation_task = tasks_dir / task_name
            shutil.copytree(artifact, validation_task)
            _copy_hidden_validation(private_source, validation_task)

            sys.path.insert(0, str(root))
            _ensure_gdbench_import_stubs()
            from gamedevbench.src.benchmark_runner import GodotBenchmarkRunner

            # agent=None is the important boundary: this path performs only the
            # native deterministic evaluator and cannot launch a second solver.
            runner = GodotBenchmarkRunner(
                use_gt=False,
                agent=None,
                model=submission.runtime_id,
                debug=False,
                run_name="game-loop-maker-evaluator",
            )
            # The upstream runner currently hard-codes ``godot`` even though
            # its README documents GODOT_EXEC_PATH.  Honour the documented
            # override here so the validation-only bridge works with a pinned
            # engine that is not globally symlinked.
            runner.godot_path = os.environ.get(
                "GODOT_EXEC_PATH",
                _default_godot_path(root),
            )
            runner.tasks_dir = tasks_dir
            runner.results_dir = evaluation_root / "results"
            backend_error = _godot_backend_error(runner.godot_path)
            native = (
                {
                    "task_name": task_name,
                    "success": False,
                    "message": backend_error,
                    "infrastructure_error": True,
                }
                if backend_error
                else _run_official_validation_with_timeout(
                    runner=runner,
                    task_name=task_name,
                    timeout_seconds=evaluator_timeout,
                )
            )
            if native.get("message") == "No validation result found in output":
                native["infrastructure_error"] = True
            result.update(native)
            result["solver_success"] = True

    # Retain only the public artifact plus the normalized result.  Hidden tests
    # never cross back into the artifact or future maker-runtime context.
    if artifact is not None:
        _copy_public_artifact(artifact, retained)
    (retained / "result.json").write_text(
        json.dumps({"validation": {
            "success": bool(result.get("success", False)),
            "message": str(result.get("message", "")),
            "infrastructure_error": bool(result.get("infrastructure_error", False)),
        }, "solver": {"success": submission.status == "completed"}}, indent=2) + "\n",
        encoding="utf-8",
    )
    payload = {
        "result": result,
        "result_dir": str(retained),
        "submission": submission.to_dict(),
    }
    output_manifest.parent.mkdir(parents=True, exist_ok=True)
    output_manifest.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return 0 if result.get("success", False) else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run one maker runtime, then use GameDevBench validation-only"
    )
    parser.add_argument("--gdbench-root", type=Path, required=True)
    parser.add_argument("--agent-workspace", type=Path, required=True)
    parser.add_argument("--private-task-source", type=Path, required=True)
    parser.add_argument("--task-name", required=True)
    parser.add_argument("--instruction-file", type=Path, required=True)
    parser.add_argument("--output-manifest", type=Path, required=True)
    runtime = parser.add_mutually_exclusive_group(required=False)
    runtime.add_argument("--runtime-config-json")
    runtime.add_argument("--runtime-profile", type=Path)
    parser.add_argument("--backbone-provider")
    parser.add_argument("--timeout", type=int, default=7200)
    parser.add_argument("--evaluator-timeout", type=int, default=900)
    parser.add_argument("--doctor", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    config_value = (
        json.loads(args.runtime_config_json)
        if args.runtime_config_json is not None
        else None
    )
    report = doctor(
        gdbench_root=args.gdbench_root,
        agent_workspace=args.agent_workspace,
        private_task_source=args.private_task_source,
        instruction_file=args.instruction_file,
    )
    if args.doctor or args.dry_run:
        print(json.dumps({**report, "mode": "dry-run" if args.dry_run else "doctor"}, indent=2))
        return 0 if report["ok"] else 2
    config = (
        load_runtime_config(config_value)
        if config_value is not None
        else (
            load_pinned_runtime_profile(args.runtime_profile)
            if args.runtime_profile is not None
            else runtime_config_from_environment(
                provider=args.backbone_provider,
                timeout_seconds=args.timeout,
            )
        )
    )
    if config_value is not None:
        config = load_runtime_config(
            {**config.to_dict(), "timeout_seconds": args.timeout}
        )
    return run_bridge(
        runtime=build_runtime(config),
        gdbench_root=args.gdbench_root.expanduser(),
        agent_workspace=args.agent_workspace.expanduser(),
        private_task_source=args.private_task_source.expanduser(),
        task_name=args.task_name,
        instruction_file=args.instruction_file.expanduser(),
        output_manifest=args.output_manifest.expanduser(),
        evaluator_timeout=args.evaluator_timeout,
    )


def _copy_hidden_validation(source: Path, target: Path) -> None:
    for relative in ("scripts/test.gd", "scripts/test.gd.uid", "scenes/test.tscn"):
        original = source / relative
        if original.is_file():
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, destination)
    config = source / "task_config.json"
    if config.is_file():
        shutil.copy2(config, target / "task_config.json")


def _copy_public_artifact(source: Path, target: Path) -> None:
    blocked = {"scripts/test.gd", "scripts/test.gd.uid", "scenes/test.tscn", "task_config.json"}
    for path in source.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(source).as_posix()
        if relative in blocked or relative.startswith(".godot/"):
            continue
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)


def _official_validation_worker(runner: object, task_name: str, result_queue: mp.Queue) -> None:
    try:
        result_queue.put({"ok": True, "result": runner.run_benchmark(task_name)})
    except BaseException as exc:
        result_queue.put({"ok": False, "error": str(exc)})


def _run_official_validation_with_timeout(
    *,
    runner: object,
    task_name: str,
    timeout_seconds: int,
) -> dict[str, object]:
    context = mp.get_context("fork") if hasattr(mp, "get_context") else mp
    result_queue: mp.Queue = context.Queue()
    process = context.Process(
        target=_official_validation_worker,
        args=(runner, task_name, result_queue),
    )
    process.start()
    process.join(timeout_seconds)
    if process.is_alive():
        process.terminate()
        process.join(10)
        if process.is_alive():
            process.kill()
            process.join(5)
        return {
            "task_name": task_name,
            "success": False,
            "message": f"Validation timed out after {timeout_seconds}s",
        }
    try:
        payload = result_queue.get_nowait()
    except queue.Empty:
        return {
            "task_name": task_name,
            "success": False,
            "message": "Validation ended without a result",
        }
    if payload.get("ok"):
        result = payload.get("result")
        return result if isinstance(result, dict) else {
            "task_name": task_name,
            "success": False,
            "message": "Validation returned a non-object result",
        }
    return {
        "task_name": task_name,
        "success": False,
        "message": f"Error running validation: {payload.get('error', 'unknown error')}",
    }


if __name__ == "__main__":
    raise SystemExit(main())
