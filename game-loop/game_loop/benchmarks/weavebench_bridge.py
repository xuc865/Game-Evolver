from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run one WeaveBench task from a loop overlay"
    )
    parser.add_argument("--tasks-root", type=Path, required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--output-manifest", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--timeout", type=int, default=1800)
    args = parser.parse_args(argv)

    tasks_root = args.tasks_root.resolve()

    # Copy task .md to temp directory and inject directive
    temp_dir = Path(tempfile.mkdtemp(prefix="weavebench-"))
    temp_tasks = temp_dir / "tasks"
    temp_tasks.mkdir(parents=True)

    task_md = tasks_root / f"{args.task_id}.md"
    if not task_md.is_file():
        md_files = list(tasks_root.glob("*.md"))
        if md_files:
            task_md = md_files[0]

    if task_md.is_file():
        content = task_md.read_text(encoding="utf-8")
        # Directive is already injected by adapter prepare; just copy
        dest = temp_tasks / task_md.name
        dest.write_text(content, encoding="utf-8")
    else:
        shutil.copytree(tasks_root, temp_tasks, dirs_exist_ok=True)

    result_dir = temp_dir / "results"
    result_dir.mkdir(parents=True, exist_ok=True)
    result_json = result_dir / "result.json"

    # Run weavebench evaluation
    cmd = [
        sys.executable, "-m", "weavebench",
        "--tasks_root", str(temp_tasks),
        "--task_id", args.task_id,
        "--model", args.model,
        "--output_dir", str(result_dir),
    ]

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

    # Parse result
    passed = False
    errors_list: list[str] = []

    if result_json.is_file():
        try:
            result_data = json.loads(result_json.read_text(encoding="utf-8"))
            passed = bool(result_data.get("passed", False))
            errors_list = [str(e) for e in result_data.get("errors", []) if str(e).strip()]
        except (json.JSONDecodeError, OSError):
            pass
    else:
        passed = return_code == 0

    # Copy result back to permanent location
    permanent_result_dir = tasks_root.parent / "weavebench_results"
    permanent_result_dir.mkdir(parents=True, exist_ok=True)
    if result_json.is_file():
        shutil.copy2(result_json, permanent_result_dir / "result.json")

    payload = {
        "passed": passed,
        "task_id": args.task_id,
        "errors": errors_list[:10],
        "result_dir": str(permanent_result_dir),
        "return_code": return_code,
    }
    args.output_manifest.parent.mkdir(parents=True, exist_ok=True)
    args.output_manifest.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    # Cleanup temp
    shutil.rmtree(temp_dir, ignore_errors=True)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
