#!/usr/bin/env python3
"""Run the synthetic mature inner harness over every public GCbench task."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from game_loop.config import AppConfig
from game_loop.utils import atomic_write_json
from scripts.build_synthetic_mature_gcbench_harness import (
    build_effective_config,
    build_profile,
)
from scripts.run_new_model_experiments import (
    _case_is_solidly_done,
    _classify_case,
    model_queue_lock,
    rj,
    run_to_log,
)

CONFIGS = {
    "glm5.2": ROOT / "experiments/configs-v4/gcbench-L4_glm5.2_produce.json",
    "kimi": ROOT / "experiments/configs-v4/gcbench-L4_kimi_produce.json",
}
TASKS = ROOT.parent / "gcbench/tasks"
SEED = ROOT / "experiments/seed_artifacts/puzzle-sokoban-scaffold"
DEFAULT_OUTPUT = ROOT / "experiments/synthetic-mature-gcbench-v1"


def _done_ids(summary: dict) -> set[str]:
    return {
        str(case["run_id"])
        for case in summary.get("cases", [])
        if case.get("run_id") and _case_is_solidly_done(case)
    }


def run(model: str, output_root: Path) -> int:
    model_root = output_root / model
    model_root.mkdir(parents=True, exist_ok=True)
    effective_config = model_root / "config.json"
    config = build_effective_config(CONFIGS[model], effective_config)
    profile_path = model_root / "synthetic_mature_gcbench_v1.json"
    if not profile_path.is_file():
        profile_path = build_profile(config=config, output_dir=model_root)
    tasks = sorted(path for path in TASKS.iterdir() if path.is_dir() and not path.name.startswith("."))
    summary_path = model_root / "summary.json"
    summary = rj(summary_path)
    if not summary:
        summary = {
            "schema_version": "synthetic-mature-gcbench.v1",
            "model": model,
            "harness_profile": str(profile_path),
            "config": str(effective_config),
            "planned_count": len(tasks),
            "completed_count": 0,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "cases": [],
        }
    done = _done_ids(summary)
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    summary["harness_id"] = profile["harness_id"]
    atomic_write_json(summary_path, summary)

    for index, task in enumerate(tasks, 1):
        run_id = f"synthetic_mature_{model}_gcbench_{task.name}"
        if run_id in done:
            continue
        if (model_root / "STOP").exists():
            break
        run_dir = model_root / "runs" / run_id
        log_path = model_root / "logs" / f"{run_id}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        state_path = run_dir / "state.json"
        started = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        init_rc = None
        evolve_rc = None
        try:
            if not state_path.is_file():
                init_rc = run_to_log(
                    [
                        sys.executable, "-m", "game_loop", "init",
                        "--run-dir", run_dir,
                        "--task-source", task,
                        "--cold-start",
                        "--seed-score", "0",
                        "--seed-artifact", SEED,
                        "--config", effective_config,
                        "--run-id", run_id,
                        "--harness-profile", profile_path,
                    ],
                    log_path,
                    append=False,
                )
            with model_queue_lock(model):
                evolve_rc = run_to_log(
                    [sys.executable, "-m", "game_loop", "evolve", "--run-dir", run_dir, "--config", effective_config],
                    log_path,
                    append=True,
                )
        except Exception as exc:
            with log_path.open("a", encoding="utf-8") as log:
                log.write(f"\n[runner_exception] {exc}\n")
        state = rj(state_path)
        champion = state.get("champion_result") or state.get("champion_evaluation") or {}
        item = {
            "index": index,
            "run_id": run_id,
            "task": task.name,
            "status": _classify_case(evolve_rc, state),
            "init_rc": init_rc,
            "evolve_rc": evolve_rc,
            "champion_score": champion.get("primary_score"),
            "run_status": state.get("status"),
            "stop_reason": state.get("stop_reason"),
            "model_calls": state.get("model_calls", 0),
            "evaluator_queries": state.get("evaluator_queries", 0),
            "started_at": started,
            "completed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        summary["cases"] = [case for case in summary["cases"] if case.get("run_id") != run_id]
        summary["cases"].append(item)
        summary["completed_count"] = len(_done_ids(summary))
        summary["latest_task"] = task.name
        atomic_write_json(summary_path, summary)
        done = _done_ids(summary)

    summary["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    atomic_write_json(summary_path, summary)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=tuple(CONFIGS), required=True)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    return run(args.model, args.output_root.resolve())


if __name__ == "__main__":
    raise SystemExit(main())
