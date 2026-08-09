from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

from game_loop.runtime import GameTask, OpenGameRuntime, OpenGameRuntimeConfig


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
    godot = os.environ.get("GODOT_EXEC_PATH", "godot")
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
        "mode_boundary": "OpenGame maker followed by GodotBenchmarkRunner(agent=None) validation-only",
    }


def run_bridge(
    *,
    runtime: OpenGameRuntime,
    gdbench_root: Path,
    agent_workspace: Path,
    private_task_source: Path,
    task_name: str,
    instruction_file: Path,
    output_manifest: Path,
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
    submission = runtime.run(task, episode_dir=output_root / "opengame_episode")
    artifact = Path(submission.artifact_ref) if submission.artifact_ref else None

    result: dict = {
        "task_name": task_name,
        "success": False,
        "message": "OpenGame failed",
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
                model="opengame",
                debug=False,
                run_name="game-loop-opengame-evaluator",
            )
            # The upstream runner currently hard-codes ``godot`` even though
            # its README documents GODOT_EXEC_PATH.  Honour the documented
            # override here so the validation-only bridge works with a pinned
            # engine that is not globally symlinked.
            runner.godot_path = os.environ.get(
                "GODOT_EXEC_PATH", getattr(runner, "godot_path", "godot")
            )
            runner.tasks_dir = tasks_dir
            runner.results_dir = evaluation_root / "results"
            native = runner.run_benchmark(task_name)
            result.update(native)
            result["solver_success"] = True

    # Retain only the public artifact plus the normalized result.  Hidden tests
    # never cross back into the artifact or future OpenGame context.
    if artifact is not None:
        _copy_public_artifact(artifact, retained)
    (retained / "result.json").write_text(
        json.dumps({"validation": {
            "success": bool(result.get("success", False)),
            "message": str(result.get("message", "")),
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
        description="Run OpenGame once, then use GameDevBench validation-only"
    )
    parser.add_argument("--gdbench-root", type=Path, required=True)
    parser.add_argument("--agent-workspace", type=Path, required=True)
    parser.add_argument("--private-task-source", type=Path, required=True)
    parser.add_argument("--task-name", required=True)
    parser.add_argument("--instruction-file", type=Path, required=True)
    parser.add_argument("--output-manifest", type=Path, required=True)
    runtime = parser.add_mutually_exclusive_group(required=True)
    runtime.add_argument("--runtime-config-json")
    runtime.add_argument("--runtime-profile", type=Path)
    parser.add_argument("--timeout", type=int, default=7200)
    parser.add_argument("--doctor", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    config_value = (
        json.loads(args.runtime_config_json)
        if args.runtime_config_json is not None
        else json.loads(args.runtime_profile.expanduser().read_text(encoding="utf-8"))
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
    config = OpenGameRuntimeConfig.from_dict(config_value)
    config = OpenGameRuntimeConfig.from_dict({**config.to_dict(), "timeout_seconds": args.timeout})
    return run_bridge(
        runtime=OpenGameRuntime(config),
        gdbench_root=args.gdbench_root.expanduser(),
        agent_workspace=args.agent_workspace.expanduser(),
        private_task_source=args.private_task_source.expanduser(),
        task_name=args.task_name,
        instruction_file=args.instruction_file.expanduser(),
        output_manifest=args.output_manifest.expanduser(),
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


if __name__ == "__main__":
    raise SystemExit(main())
