#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from game_loop.benchmarks.gdbench_bridge import (
    _copy_hidden_validation,
    _default_godot_path,
    _godot_backend_error,
)
from game_loop.utils import atomic_write_json, read_json, utc_now


BAD_MESSAGE = "No validation result found in output"
BACKUP_SUFFIX = ".pre-gdbench-rejudge"


def _backup(path: Path) -> None:
    backup = path.with_name(path.name + BACKUP_SUFFIX)
    if path.is_file() and not backup.exists():
        shutil.copy2(path, backup)


def evaluate(artifact: Path, task_source: Path, godot: str, timeout: int) -> dict:
    backend_error = _godot_backend_error(godot)
    if backend_error:
        return {"success": False, "message": backend_error, "infrastructure_error": True}
    with tempfile.TemporaryDirectory(prefix="gdbench-rejudge-") as td:
        task = Path(td) / task_source.name
        shutil.copytree(artifact, task)
        _copy_hidden_validation(task_source, task)
        try:
            imported = subprocess.run(
                [godot, "--headless", "--import", "--quit", "--path", str(task)],
                capture_output=True, text=True, timeout=timeout, check=False,
            )
        except subprocess.TimeoutExpired:
            return {"success": False, "message": "Godot import timed out",
                    "infrastructure_error": True}
        try:
            validated = subprocess.run(
                [godot, "--headless", "--path", str(task), "res://scenes/test.tscn"],
                capture_output=True, text=True, timeout=timeout, check=False,
            )
        except subprocess.TimeoutExpired:
            return {"success": False, "message": "Official validation timed out",
                    "infrastructure_error": True}
    output = validated.stdout + validated.stderr
    marker = next(
        (line.strip() for line in output.splitlines()
         if "VALIDATION_PASSED" in line or "VALIDATION_FAILED" in line),
        None,
    )
    if marker is None:
        detail = (output or imported.stdout + imported.stderr).strip()[-2000:]
        return {
            "success": False,
            "message": "Official validator emitted no result marker",
            "infrastructure_error": True,
            "details": detail,
        }
    return {
        "success": "VALIDATION_PASSED" in marker,
        "message": marker.split(":", 1)[1].strip() if ":" in marker else marker,
        "infrastructure_error": False,
        "marker": marker,
    }


def _evaluation(result_path: Path, validation: dict) -> dict:
    success = bool(validation["success"])
    return {
        "primary_score": 1.0 if success else 0.0,
        "feasible": not validation["infrastructure_error"],
        "objectives": {"task_correctness": 1.0 if success else 0.0},
        "constraints": {"project_loadable": not validation["infrastructure_error"],
                        "hidden_validation": success},
        "diagnostics": [] if success else [validation["message"]],
        "evaluator": {"name": "GameDevBench hidden validation",
                      "infrastructure_failure": validation["infrastructure_error"]},
        "uncertainty": {}, "cost": {"agent_usd": 0.0},
        "terminal_success": success, "raw_result_ref": str(result_path.resolve()),
    }


def rejudge_manifest(manifest_path: Path, godot: str, timeout: int) -> dict:
    manifest = read_json(manifest_path)
    if str(manifest.get("result", {}).get("message", "")) != BAD_MESSAGE:
        return {"status": "skipped"}
    task_name = str(manifest["result"]["task_name"])
    candidate = manifest_path.parent
    artifact = Path(manifest["submission"]["artifact_ref"])
    run_dir = candidate.parents[1]
    run_root = run_dir.parent
    task_source = run_root.parent / "task-cache" / "gdbench" / task_name / "tasks" / task_name
    validation = evaluate(artifact, task_source, godot, timeout)
    result_path = candidate / "gdbench_result" / "result.json"
    normalized = _evaluation(result_path, validation)

    for path in (manifest_path, result_path, candidate / "evaluation.json",
                 candidate / "selection.json", run_dir / "state.json"):
        _backup(path)
    manifest["result"].update(validation)
    manifest["result"]["rejudged_at"] = utc_now()
    atomic_write_json(manifest_path, manifest)
    atomic_write_json(result_path, {"validation": validation, "solver": {"success": True}})
    atomic_write_json(candidate / "evaluation.json", normalized)

    selection_path = candidate / "selection.json"
    selection = read_json(selection_path) if selection_path.is_file() else {}
    selection.update({"primary_score": normalized["primary_score"],
                      "objectives": normalized["objectives"],
                      "diagnostics": normalized["diagnostics"]})
    if validation["success"]:
        selection.update({"status": "accepted", "accepted": True,
                          "reasons": ["official GameDevBench validation passed on evaluator-only rejudge"]})
    atomic_write_json(selection_path, selection)

    state_path = run_dir / "state.json"
    state = read_json(state_path)
    if state.get("attempts"):
        state["attempts"][-1].update(selection)
    if validation["success"]:
        state["champion_artifact_id"] = selection.get("artifact_id")
        state["champion_evaluation"] = normalized
    elif validation["infrastructure_error"]:
        state["status"] = "paused_infrastructure"
        state["stop_reason"] = validation["message"]
        state["infrastructure_failures"] = int(state.get("infrastructure_failures", 0)) + 1
    state["updated_at"] = utc_now()
    atomic_write_json(state_path, state)
    return {"status": "pass" if validation["success"] else
                      "infra" if validation["infrastructure_error"] else "fail",
            "run_id": run_dir.name, "score": normalized["primary_score"],
            "message": validation["message"]}


def update_summary(run_root: Path, outcomes: dict[str, dict]) -> None:
    path = run_root / "summary.json"
    if not path.is_file():
        return
    _backup(path)
    summary = read_json(path)
    by_run_id = dict(outcomes)
    for manifest_path in run_root.glob("*/generation_*/candidate_*/gdbench_execution.json"):
        manifest = read_json(manifest_path)
        result = manifest.get("result", {})
        run_id = manifest_path.parents[2].name
        if result.get("infrastructure_error"):
            status = "infra"
        elif result.get("success"):
            status = "pass"
        elif result.get("marker") or "VALIDATION_FAILED" in str(result.get("message", "")):
            status = "fail"
        else:
            continue
        by_run_id[run_id] = {
            "status": status,
            "score": 1.0 if status == "pass" else 0.0,
            "message": str(result.get("message", "")),
        }
    for case in summary.get("cases", []):
        outcome = by_run_id.get(str(case.get("run_id")))
        if not outcome:
            continue
        case["status"] = "failed" if outcome["status"] == "infra" else "completed"
        case["champion_score"] = None if outcome["status"] == "infra" else outcome["score"]
        case["official_validation"] = outcome["status"]
        case["official_message"] = outcome["message"]
    summary["completed_count"] = sum(
        1 for case in summary.get("cases", []) if case.get("official_validation") in {"pass", "fail"}
    )
    summary["official_pass_count"] = sum(
        1 for case in summary.get("cases", []) if case.get("official_validation") == "pass"
    )
    summary["rejudged_at"] = utc_now()
    atomic_write_json(path, summary)


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluator-only repair for GDBench marker-loss runs")
    parser.add_argument("run_roots", nargs="+", type=Path)
    parser.add_argument("--godot-bin")
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    godot = args.godot_bin or _default_godot_path(Path.cwd())
    totals = {"pass": 0, "fail": 0, "infra": 0, "skipped": 0}
    for root in args.run_roots:
        outcomes = {}
        for manifest in sorted(root.resolve().glob("*/generation_*/candidate_*/gdbench_execution.json")):
            outcome = rejudge_manifest(manifest, godot, args.timeout)
            totals[outcome["status"]] += 1
            if outcome.get("run_id"):
                outcomes[outcome["run_id"]] = outcome
            print(json.dumps(outcome, ensure_ascii=False), flush=True)
        update_summary(root.resolve(), outcomes)
    print(json.dumps({"totals": totals, "godot": godot}, ensure_ascii=False))
    return 2 if totals["infra"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
