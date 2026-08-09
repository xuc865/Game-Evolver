from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run one NL2RepoBench task from a loop overlay"
    )
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--task-file", type=Path, required=True)
    parser.add_argument("--output-manifest", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--use-openhands", action="store_true",
                        help="Use OpenHands instead of plain pytest")
    args = parser.parse_args(argv)

    repo_root = args.repo_root.resolve()
    task_file = args.task_file.resolve()

    # Ensure start.md is in repo/ directory
    start_md = repo_root / "start.md"
    if not start_md.is_file() and task_file.is_file():
        start_md.write_text(task_file.read_text(encoding="utf-8"), encoding="utf-8")

    result_dir = repo_root.parent / "nl2repo_results"
    result_dir.mkdir(parents=True, exist_ok=True)
    result_json = result_dir / "result.json"

    if args.use_openhands:
        cmd = [
            "python", "-m", "openhands.runtime",
            "--repo", str(repo_root),
            "--task-file", str(start_md),
            "--model", args.model,
            "--timeout", str(args.timeout),
        ]
    else:
        cmd = [
            sys.executable, "-m", "pytest",
            str(repo_root),
            "--json-report",
            f"--json-report-file={result_json}",
            "-v",
        ]

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=args.timeout,
            cwd=str(repo_root),
        )
        return_code = proc.returncode
    except subprocess.TimeoutExpired:
        return_code = -1
    except FileNotFoundError:
        return_code = -2

    # Parse pytest JSON report
    passed = False
    total = 0
    failures = 0
    errors_list: list[str] = []

    if result_json.is_file():
        try:
            report = json.loads(result_json.read_text(encoding="utf-8"))
            summary = report.get("summary", {})
            total = int(summary.get("total", 0))
            failures = int(summary.get("failed", 0))
            errors_count = int(summary.get("error", 0))
            passed = total > 0 and failures == 0 and errors_count == 0
            for test in report.get("tests", []):
                if test.get("outcome") in ("failed", "error"):
                    errors_list.append(str(test.get("nodeid", "")))
        except (json.JSONDecodeError, OSError):
            pass
    else:
        # Fallback: use exit code
        passed = return_code == 0

    payload = {
        "passed": passed,
        "total": total,
        "failures": failures,
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
