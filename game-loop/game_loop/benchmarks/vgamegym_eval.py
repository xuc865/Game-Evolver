from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path
from typing import Any

from game_loop.utils import atomic_write_json, read_json


MODALITIES = ("code", "screenshot", "video")


def normalize_official_result(raw: dict[str, Any], *, raw_result_ref: Path) -> dict[str, Any]:
    diagnostics = [str(item) for item in raw.get("diagnostics", [])]
    execution = raw.get("execution", {}) if isinstance(raw.get("execution"), dict) else {}
    run_ok = bool(raw.get("run_ok", execution.get("success", False)))
    objectives: dict[str, float] = {}
    for modality in MODALITIES:
        value = raw.get(f"{modality}_evaluation")
        if not isinstance(value, dict):
            return infrastructure_failure(
                f"V-GameGym {modality} evaluator result is missing",
                raw_result_ref=raw_result_ref,
            )
        error = str(value.get("error", "")).strip()
        if error and error not in {"No screenshots found", "Video file does not exist"}:
            return infrastructure_failure(
                f"V-GameGym {modality} judge failed: {error}",
                raw_result_ref=raw_result_ref,
            )
        if value.get("total_score") is None:
            return infrastructure_failure(
                f"V-GameGym {modality} total_score is missing",
                raw_result_ref=raw_result_ref,
            )
        score = float(value["total_score"])
        if score < 0 or score > 100:
            return infrastructure_failure(
                f"V-GameGym {modality} score is outside 0-100",
                raw_result_ref=raw_result_ref,
            )
        objectives[modality] = score / 100.0
        if error:
            diagnostics.append(f"{modality}: {error}")
    if not run_ok:
        diagnostics.append("generated Pygame artifact did not execute successfully")
    primary = sum(objectives.values()) / len(objectives)
    return {
        "schema_version": "vgamegym-evaluation-v1",
        "status": "completed",
        "primary_score": primary,
        "objectives": objectives,
        "constraints": {
            "game_runnable": run_ok,
            "code_judge_complete": True,
            "screenshot_judge_complete": True,
            "video_judge_complete": True,
        },
        "diagnostics": diagnostics,
        "raw_result_ref": str(raw_result_ref.resolve()),
        "evaluator": {
            "name": "V-GameGym code/image/video evaluator contract",
            "raw_score_scale": "0-100",
        },
    }


def infrastructure_failure(message: str, *, raw_result_ref: Path | None = None) -> dict[str, Any]:
    return {
        "schema_version": "vgamegym-evaluation-v1",
        "status": "infrastructure_failure",
        "primary_score": None,
        "objectives": {},
        "constraints": {
            "game_runnable": False,
            "code_judge_complete": False,
            "screenshot_judge_complete": False,
            "video_judge_complete": False,
        },
        "diagnostics": [message],
        "raw_result_ref": None if raw_result_ref is None else str(raw_result_ref.resolve()),
        "evaluator": {"name": "V-GameGym code/image/video evaluator contract"},
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Invoke and normalize a V-GameGym code/image/video evaluator"
    )
    parser.add_argument("--task-root", type=Path, required=True)
    parser.add_argument("--candidate-workspace", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--raw-output", type=Path, required=True)
    parser.add_argument(
        "--evaluator-command-json",
        default=os.environ.get("VGAMEGYM_EVALUATOR_COMMAND_JSON", ""),
        help=(
            "JSON argv for the pinned V-GameGym evaluator; supports task_root, "
            "artifact_dir, and raw_output placeholders"
        ),
    )
    parser.add_argument("--evaluator-cwd", type=Path, default=Path.cwd())
    parser.add_argument("--timeout", type=int, default=1800)
    args = parser.parse_args(argv)

    result: dict[str, Any]
    try:
        raw_command = json.loads(args.evaluator_command_json) if args.evaluator_command_json else []
        if not isinstance(raw_command, list) or not raw_command or not all(
            isinstance(item, str) for item in raw_command
        ):
            raise ValueError("V-GameGym evaluator command is not configured")
        context = {
            "task_root": str(args.task_root.resolve()),
            "artifact_dir": str(args.candidate_workspace.resolve()),
            "raw_output": str(args.raw_output.resolve()),
        }
        args.raw_output.resolve().parent.mkdir(parents=True, exist_ok=True)
        command = [item.format_map(context) for item in raw_command]
        process = subprocess.run(
            command,
            cwd=args.evaluator_cwd.resolve(),
            capture_output=True,
            text=True,
            timeout=args.timeout,
            check=False,
        )
        if process.returncode != 0:
            detail = (process.stderr or process.stdout).strip()[-1000:]
            raise RuntimeError(
                f"V-GameGym evaluator exited {process.returncode}: {detail}"
            )
        if not args.raw_output.is_file():
            raise RuntimeError("V-GameGym evaluator did not write its raw result")
        result = normalize_official_result(
            read_json(args.raw_output.resolve()), raw_result_ref=args.raw_output.resolve()
        )
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        result = infrastructure_failure(str(exc), raw_result_ref=args.raw_output)
    atomic_write_json(args.output.resolve(), result)
    return 0 if result["status"] == "completed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
