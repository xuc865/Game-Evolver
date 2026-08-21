from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path

from game_loop.runtime import GameTask, MakerRuntime, build_runtime, load_runtime_config
from game_loop.utils import atomic_write_json, read_json

from .runtime_config import runtime_config_from_environment
from .vgamegym_eval import infrastructure_failure, normalize_official_result


def run_bridge(
    *,
    runtime: MakerRuntime,
    agent_workspace: Path,
    instruction_file: Path,
    public_task_root: Path,
    output_manifest: Path,
    evaluator_command: list[str],
    evaluator_timeout: int = 1800,
) -> int:
    output_manifest = output_manifest.resolve()
    bridge_root = output_manifest.parent / "vgamegym_bridge"
    task = GameTask(
        task_id=public_task_root.resolve().name or "vgamegym-task",
        benchmark_id="vgamegym",
        prompt=instruction_file.resolve().read_text(encoding="utf-8"),
        task_source_ref=str(public_task_root.resolve()),
        workspace_seed_ref=str(agent_workspace.resolve()),
        artifact_relpath=".",
        constraints={
            "engine": "pygame",
            "autonomous_demo_required": True,
            "evaluation_modalities": ["code", "screenshot", "video"],
            "reference_code_visible": False,
        },
    )
    submission = runtime.run(task, episode_dir=bridge_root / "maker_episode")
    artifact = Path(submission.artifact_ref) if submission.artifact_ref else None
    evaluation_dir = bridge_root / "evaluation"
    raw_path = evaluation_dir / "raw_result.json"
    evaluation_path = evaluation_dir / "result.json"
    evaluator_rc: int | None = None

    if submission.status == "completed" and artifact is not None:
        if evaluator_command:
            raw_path.parent.mkdir(parents=True, exist_ok=True)
            context = {
                "task_root": str(public_task_root.resolve()),
                "artifact_dir": str(artifact.resolve()),
                "raw_output": str(raw_path.resolve()),
            }
            command = [item.format_map(context) for item in evaluator_command]
            try:
                with (evaluation_dir / "evaluator.log").open("wb") as log:
                    process = subprocess.run(
                        command,
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        timeout=evaluator_timeout,
                        check=False,
                    )
                evaluator_rc = process.returncode
                if evaluator_rc == 0 and raw_path.is_file():
                    evaluation = normalize_official_result(
                        read_json(raw_path), raw_result_ref=raw_path
                    )
                else:
                    evaluation = infrastructure_failure(
                        f"V-GameGym evaluator exited {evaluator_rc} without a valid result",
                        raw_result_ref=raw_path,
                    )
            except (OSError, subprocess.TimeoutExpired) as exc:
                evaluator_rc = -1
                evaluation = infrastructure_failure(str(exc), raw_result_ref=raw_path)
        else:
            evaluation = infrastructure_failure("V-GameGym evaluator command is not configured")
    else:
        evaluation = infrastructure_failure("maker runtime did not produce a V-GameGym artifact")
    atomic_write_json(evaluation_path, evaluation)
    status = str(evaluation["status"])
    atomic_write_json(
        output_manifest,
        {
            "schema_version": "benchmark-execution-v1",
            "benchmark": "vgamegym",
            "status": status,
            "artifact_dir": "" if artifact is None else str(artifact.resolve()),
            "evaluation_path": str(evaluation_path),
            "raw_evaluation_path": str(raw_path),
            "submission": submission.to_dict(),
            "evaluator_return_code": evaluator_rc,
        },
    )
    return 0 if status == "completed" else 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run one maker runtime, then evaluate its V-GameGym artifact"
    )
    parser.add_argument("--agent-workspace", type=Path, required=True)
    parser.add_argument("--instruction-file", type=Path, required=True)
    parser.add_argument("--task-root", type=Path, required=True)
    parser.add_argument("--output-manifest", type=Path, required=True)
    parser.add_argument("--runtime-config-json")
    parser.add_argument("--backbone-provider")
    parser.add_argument(
        "--evaluator-command-json",
        default=os.environ.get("VGAMEGYM_EVALUATOR_COMMAND_JSON", "[]"),
    )
    parser.add_argument("--timeout", type=int, default=7200)
    parser.add_argument("--evaluator-timeout", type=int, default=1800)
    args = parser.parse_args(argv)
    config = runtime_config_from_environment(
        provider=args.backbone_provider,
        timeout_seconds=args.timeout,
    )
    if args.runtime_config_json:
        config = load_runtime_config(json.loads(args.runtime_config_json))
        config = load_runtime_config(
            {**config.to_dict(), "timeout_seconds": args.timeout}
        )
    evaluator_command = json.loads(args.evaluator_command_json)
    if not isinstance(evaluator_command, list) or not all(
        isinstance(item, str) for item in evaluator_command
    ):
        raise ValueError("evaluator command must be a JSON string list")
    return run_bridge(
        runtime=build_runtime(config),
        agent_workspace=args.agent_workspace,
        instruction_file=args.instruction_file,
        public_task_root=args.task_root,
        output_manifest=args.output_manifest,
        evaluator_command=evaluator_command,
        evaluator_timeout=args.evaluator_timeout,
    )


if __name__ == "__main__":
    raise SystemExit(main())
