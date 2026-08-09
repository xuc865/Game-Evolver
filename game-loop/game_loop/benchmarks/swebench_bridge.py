from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run one SWE-bench instance from a loop overlay"
    )
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--test-patch", type=Path, required=True)
    parser.add_argument("--output-manifest", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--timeout", type=int, default=3600)
    parser.add_argument("--docker-image", default=None,
                        help="Override SWE-bench eval image name")
    args = parser.parse_args(argv)

    repo_root = args.repo_root.resolve()
    test_patch = args.test_patch.resolve()

    # Read evolution directive if present
    directive_path = repo_root / "evolution_directive.md"
    directive_text = ""
    if directive_path.is_file():
        directive_text = directive_path.read_text(encoding="utf-8")

    # Determine eval image
    image = args.docker_image or f"sweb.eval.{args.instance_id}:latest"

    # Run docker-based evaluation
    result_dir = repo_root.parent / "swebench_results" / args.instance_id
    result_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        "docker", "run", "--rm",
        "-v", f"{repo_root}:/repo",
        "-v", f"{test_patch}:/test_patch",
        "-v", f"{result_dir}:/results",
        "-e", f"INSTANCE_ID={args.instance_id}",
        "-e", f"MODEL={args.model}",
        "-e", f"TIMEOUT={args.timeout}",
        image,
        "bash", "-c",
        "cd /repo && "
        "git apply /test_patch && "
        "python -m swebench.harness.run_evaluation "
        f"--instance_id $INSTANCE_ID "
        "--predictions_path /repo/pred.json "
        "--max_workers 1 "
        f"--timeout {args.timeout} "
        "--output_dir /results",
    ]

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=args.timeout + 120,
        )
        return_code = proc.return_code
    except subprocess.TimeoutExpired:
        return_code = -1
    except FileNotFoundError:
        return_code = -2

    # Find result JSON
    result_json_path = result_dir / "result.json"
    resolved = False
    if result_json_path.is_file():
        try:
            result_data = json.loads(result_json_path.read_text(encoding="utf-8"))
            resolved = bool(result_data.get("resolved", False))
        except (json.JSONDecodeError, OSError):
            result_data = {}
    else:
        result_data = {}

    payload = {
        "instance_id": args.instance_id,
        "resolved": resolved,
        "result_dir": str(result_dir),
        "return_code": return_code,
        "directive_injected": bool(directive_text),
    }
    args.output_manifest.parent.mkdir(parents=True, exist_ok=True)
    args.output_manifest.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return 0 if resolved else 1


if __name__ == "__main__":
    raise SystemExit(main())
