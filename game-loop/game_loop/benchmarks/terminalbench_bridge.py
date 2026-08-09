from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run one TerminalBench task from a loop overlay"
    )
    parser.add_argument("--task-root", type=Path, required=True)
    parser.add_argument("--output-manifest", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--container-image", default=None,
                        help="Override container image for tb run")
    args = parser.parse_args(argv)

    task_root = args.task_root.resolve()

    # Backup terminus.txt, inject directive (already done by adapter prepare),
    # run tb, then restore
    terminus_path = task_root / "terminus.txt"
    backup_path = task_root / "terminus.txt.bak"

    if terminus_path.is_file():
        shutil.copy2(terminus_path, backup_path)

    result_dir = task_root.parent / "terminalbench_results"
    result_dir.mkdir(parents=True, exist_ok=True)
    result_json = result_dir / "result.json"

    # Build tb run command
    cmd = [
        "tb", "run",
        "--agent", "terminus",
        "--model", args.model,
        "--task-path", str(task_root),
        "--output-dir", str(result_dir),
    ]
    if args.container_image:
        cmd.extend(["--container-image", args.container_image])

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=args.timeout,
        )
        return_code = proc.returncode
    except subprocess.TimeoutExpired:
        return_code = -1
    except FileNotFoundError:
        return_code = -2

    # Restore original terminus.txt
    if backup_path.is_file():
        shutil.copy2(backup_path, terminus_path)
        backup_path.unlink()

    # Parse result
    passed = False
    task_id = task_root.name
    errors_list: list[str] = []

    if result_json.is_file():
        try:
            result_data = json.loads(result_json.read_text(encoding="utf-8"))
            passed = bool(result_data.get("passed", False))
            task_id = str(result_data.get("task_id", task_id))
            errors_list = [str(e) for e in result_data.get("errors", []) if str(e).strip()]
        except (json.JSONDecodeError, OSError):
            pass
    else:
        passed = return_code == 0

    payload = {
        "passed": passed,
        "task_id": task_id,
        "errors": errors_list[:10],
        "result_dir": str(result_dir),
        "return_code": return_code,
    }
    args.output_manifest.parent.mkdir(parents=True, exist_ok=True)
    args.output_manifest.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
