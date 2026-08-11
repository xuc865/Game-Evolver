#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, List


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"{path}: invalid JSON: {exc}") from exc


def validate_keypoint_dir(path: Path) -> List[str]:
    issues: List[str] = []
    result_path = path / "result.json"
    config_path = path / "test_config.json"
    test_result_path = path / "test_result.json"
    script_ok = (path / "test_script.mjs").exists() or (path / "test_script.js").exists()

    for required in (result_path, config_path, test_result_path):
        if not required.exists():
            issues.append(f"{path}: missing {required.name}")

    if not script_ok:
        issues.append(f"{path}: missing test_script.mjs/.js")

    if result_path.exists():
        result = load_json(result_path)
        if not isinstance(result, dict):
            issues.append(f"{result_path}: expected JSON object")
        elif str(result.get("status", result.get("result", ""))).strip().upper() not in {"PASS", "FAIL", "INCOMPLETE"}:
            issues.append(f"{result_path}: missing PASS/FAIL/INCOMPLETE status")

    if config_path.exists():
        config = load_json(config_path)
        if not isinstance(config, dict):
            issues.append(f"{config_path}: expected JSON object")
        elif "game_url" not in config:
            issues.append(f"{config_path}: missing game_url")

    if test_result_path.exists():
        test_result = load_json(test_result_path)
        if not isinstance(test_result, dict):
            issues.append(f"{test_result_path}: expected JSON object")

    return issues


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate normal keypoint run artifacts.")
    parser.add_argument("--run-root")
    parser.add_argument("--repo-root")
    parser.add_argument("--game-name")
    parser.add_argument("--run-id")
    parser.add_argument("--test-mode", choices=["normal"], required=True)
    parser.add_argument("--expected-count", type=int, default=0)
    parser.add_argument("--expected-keypoint-count", type=int, default=0)
    parser.add_argument("--json-output")
    args = parser.parse_args()

    if args.run_root:
        run_root = Path(args.run_root)
    elif args.repo_root and args.game_name and args.run_id:
        run_root = Path(args.repo_root) / "runs" / args.game_name / args.run_id
    else:
        parser.error(
            "provide --run-root or all of --repo-root, --game-name, and --run-id"
        )
    expected_count = args.expected_count or args.expected_keypoint_count
    if not run_root.exists():
        print(f"ERROR: run root not found: {run_root}")
        return 1

    keypoint_dirs = sorted(path for path in run_root.glob("keypoint_*") if path.is_dir())
    issues: List[str] = []
    if expected_count and len(keypoint_dirs) < expected_count:
        issues.append(f"{run_root}: expected at least {expected_count} keypoint dirs, found {len(keypoint_dirs)}")
    if not keypoint_dirs:
        issues.append(f"{run_root}: no keypoint_* directories found")

    for keypoint_dir in keypoint_dirs:
        issues.extend(validate_keypoint_dir(keypoint_dir))

    report = {
        "status": "FAIL" if issues else "PASS",
        "run_root": str(run_root.resolve()),
        "expected_count": expected_count,
        "validated_count": len(keypoint_dirs),
        "issues": issues,
    }
    if args.json_output:
        output = Path(args.json_output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    if issues:
        for issue in issues:
            print(f"ERROR: {issue}")
        return 1
    print(f"PASS: validated {len(keypoint_dirs)} keypoint artifact directories")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
