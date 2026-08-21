from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path

from game_loop.runtime import GameTask, MakerRuntime, build_runtime, load_runtime_config

from .runtime_config import load_pinned_runtime_profile


def doctor(
    *,
    workspace: Path,
    instruction: Path,
    evaluator_command: list[str],
) -> dict[str, object]:
    workspace = workspace.expanduser().resolve()
    instruction = instruction.expanduser().resolve()
    executable = evaluator_command[0] if evaluator_command else ""
    executable_ok = bool(
        executable
        and (
            shutil.which(executable) is not None
            or Path(executable).expanduser().is_file()
        )
    )
    checks = {
        "workspace_exists": workspace.is_dir(),
        "instruction_exists": instruction.is_file(),
        "evaluator_command_nonempty": bool(evaluator_command),
        "evaluator_executable_resolves": executable_ok,
    }
    return {
        "benchmark": "gamecraftbench",
        "ok": all(checks.values()),
        "checks": checks,
        "note": (
            "The evaluator command must invoke a locally pinned checkout of the "
            "official GameCraftBench verifier; this bridge cannot infer its commit."
        ),
    }


def run_bridge(
    *,
    runtime: MakerRuntime,
    workspace: Path,
    instruction: Path,
    output_manifest: Path,
    breakdown: Path,
    evaluator_command: list[str],
) -> int:
    workspace = workspace.resolve()
    instruction = instruction.resolve()
    output_manifest = output_manifest.resolve()
    breakdown = breakdown.resolve()
    output_dir = output_manifest.parent / "gcbench_bridge"
    task = GameTask(
        task_id=output_manifest.parent.name or "gamecraftbench-task",
        benchmark_id="gamecraftbench",
        prompt=instruction.read_text(encoding="utf-8"),
        task_source_ref=str(instruction),
        workspace_seed_ref=str(workspace),
        artifact_relpath="game",
        constraints={"hidden_evaluator": True, "requires_replay_traces": True},
    )
    submission = runtime.run(task, episode_dir=output_dir / "maker_episode")
    artifact = Path(submission.artifact_ref) if submission.artifact_ref else None

    evaluator_rc: int | None = None
    if submission.status == "completed" and artifact is not None:
        context = {
            "artifact": str(artifact),
            "workspace": str(artifact.parent),
            "breakdown_path": str(breakdown),
            "output_dir": str(breakdown.parent),
        }
        command = [part.format_map(context) for part in evaluator_command]
        breakdown.parent.mkdir(parents=True, exist_ok=True)
        with (output_dir / "evaluator.log").open("wb") as log:
            completed = subprocess.run(
                command, stdout=log, stderr=subprocess.STDOUT, check=False
            )
        evaluator_rc = completed.returncode

    payload = {
        "benchmark": "gamecraftbench",
        "artifact_path": "" if artifact is None else str(artifact),
        "breakdown_path": str(breakdown),
        "submission": submission.to_dict(),
        "evaluator_return_code": evaluator_rc,
    }
    output_manifest.parent.mkdir(parents=True, exist_ok=True)
    output_manifest.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return 0 if submission.status == "completed" and breakdown.is_file() else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run one maker runtime, then evaluate a GameCraftBench submission"
    )
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--instruction-file", type=Path, required=True)
    parser.add_argument("--output-manifest", type=Path, required=True)
    parser.add_argument("--breakdown-path", type=Path, required=True)
    runtime = parser.add_mutually_exclusive_group(required=True)
    runtime.add_argument("--runtime-config-json")
    runtime.add_argument("--runtime-profile", type=Path)
    evaluator = parser.add_mutually_exclusive_group(required=True)
    evaluator.add_argument("--evaluator-command-json")
    evaluator.add_argument("--evaluator-command-file", type=Path)
    parser.add_argument("--timeout", type=int, default=7200)
    parser.add_argument("--doctor", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    workspace = args.workspace.expanduser().resolve()
    instruction = args.instruction_file.expanduser().resolve()
    output_manifest = args.output_manifest.expanduser().resolve()
    breakdown = args.breakdown_path.expanduser().resolve()
    config_value = (
        json.loads(args.runtime_config_json)
        if args.runtime_config_json is not None
        else None
    )
    evaluator_value = (
        json.loads(args.evaluator_command_json)
        if args.evaluator_command_json is not None
        else json.loads(args.evaluator_command_file.expanduser().read_text(encoding="utf-8"))
    )
    if not isinstance(evaluator_value, list) or not all(isinstance(item, str) for item in evaluator_value):
        parser.error("evaluator command must be a JSON array of strings")
    report = doctor(
        workspace=workspace,
        instruction=instruction,
        evaluator_command=evaluator_value,
    )
    if args.doctor or args.dry_run:
        print(json.dumps({**report, "mode": "dry-run" if args.dry_run else "doctor"}, indent=2))
        return 0 if report["ok"] else 2
    config = (
        load_runtime_config(config_value)
        if config_value is not None
        else load_pinned_runtime_profile(args.runtime_profile)
    )
    return run_bridge(
        runtime=build_runtime(config),
        workspace=workspace,
        instruction=instruction,
        output_manifest=output_manifest,
        breakdown=breakdown,
        evaluator_command=evaluator_value,
    )


if __name__ == "__main__":
    raise SystemExit(main())
