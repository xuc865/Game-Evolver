from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from game_loop.utils import atomic_write_json

from .ggv_contract import CommandGGVWorker, run_paper_compatible_ggv


def _specification_path(task_root: Path) -> Path:
    for name in ("specification.md", "task.md", "README.md", "instruction.md"):
        candidate = task_root / name
        if candidate.is_file():
            return candidate
    raise FileNotFoundError("VeriGame specification file is missing")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Run a paper-compatible GameGen-Verifier plugin chain. "
            "This is not the unreleased official implementation."
        )
    )
    parser.add_argument("--task-root", type=Path, required=True)
    parser.add_argument("--candidate-workspace", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument(
        "--worker-command-json",
        default=os.environ.get("GAMEGEN_VERIFIER_WORKER_COMMAND_JSON", ""),
        help="JSON argv for a worker implementing the ggv-worker-v1 stdin/stdout contract",
    )
    parser.add_argument("--worker-cwd", type=Path, default=Path.cwd())
    parser.add_argument("--worker-timeout", type=int, default=600)
    args = parser.parse_args(argv)

    try:
        raw_command = json.loads(args.worker_command_json) if args.worker_command_json else []
        if not isinstance(raw_command, list) or not all(isinstance(item, str) for item in raw_command):
            raise ValueError("worker command must be a JSON string list")
        specification = _specification_path(args.task_root.resolve())
        worker = CommandGGVWorker(
            tuple(raw_command), args.worker_cwd.resolve(), args.worker_timeout
        )
        result = run_paper_compatible_ggv(
            specification_path=specification,
            artifact_dir=args.candidate_workspace.resolve(),
            work_dir=args.work_dir.resolve(),
            worker=worker,
        )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        result = {
            "schema_version": "ggv-paper-compatible-v1",
            "implementation": "paper-compatible-plugin-contract-not-official-code",
            "status": "infrastructure_failure",
            "primary_score": None,
            "objectives": {},
            "constraints": {"judge_complete": False},
            "evidence_refs": [],
            "diagnostics": [str(exc)],
        }
    atomic_write_json(args.output.resolve(), result)
    return 0 if result["status"] == "completed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
