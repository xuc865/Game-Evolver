#!/usr/bin/env python3
"""Audit and report completed full-dataset VGameGym experiments."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from statistics import mean
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from game_loop.utils import atomic_write_json, read_json, utc_now


DATASET = ROOT / "third_party" / "SKYLENAGE-GameCodeGym" / "gamegym_testset" / "pygame_seeds_2500_filtered.jsonl"
DEFAULT_OUTPUT_ROOT = ROOT / "experiments" / "vgamegym-full-awesome"
MODELS = ("kimi", "qwen", "glm", "deepseek")
TERMINAL_STATUSES = {
    "completed",
    "generation_failed",
    "candidate_execution_failure",
    "evaluator_infrastructure_failure",
}


def _dataset_ids(path: Path) -> list[str]:
    values = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    ids = [str(value["id"]) for value in values]
    if len(ids) != len(set(ids)):
        raise ValueError("VGameGym dataset contains duplicate task IDs")
    return ids


def _model_report(root: Path, model: str, dataset_ids: list[str]) -> dict[str, Any]:
    model_root = root / model
    dataset_set = set(dataset_ids)
    task_dirs = {path.name.removeprefix("task_"): path for path in model_root.glob("task_*") if path.is_dir()}
    missing = sorted(dataset_set - set(task_dirs))
    extra = sorted(set(task_dirs) - dataset_set)
    statuses: Counter[str] = Counter()
    failure_kinds: Counter[str] = Counter()
    incomplete: list[str] = []
    scored: list[dict[str, float]] = []

    for task_id in dataset_ids:
        task_dir = task_dirs.get(task_id)
        if task_dir is None:
            continue
        status_path = task_dir / "status.json"
        if not status_path.is_file():
            incomplete.append(task_id)
            continue
        status = str(read_json(status_path).get("status", "unknown"))
        failure_kind = str(read_json(status_path).get("generation_failure_kind", ""))
        statuses[status] += 1
        if failure_kind:
            failure_kinds[failure_kind] += 1
        if status not in TERMINAL_STATUSES:
            incomplete.append(task_id)
            continue
        if status != "completed":
            continue
        result_path = task_dir / "evaluation" / "result.json"
        if not result_path.is_file():
            incomplete.append(task_id)
            continue
        result = read_json(result_path)
        objectives = result.get("objectives", {})
        constraints = result.get("constraints", {})
        if (
            result.get("status") != "completed"
            or not constraints.get("game_runnable", False)
            or not all(constraints.get(f"{name}_judge_complete", False) for name in ("code", "screenshot", "video"))
            or not all(name in objectives for name in ("code", "screenshot", "video"))
        ):
            incomplete.append(task_id)
            continue
        scored.append({name: float(objectives[name]) * 100.0 for name in ("code", "screenshot", "video")})

    attempted = len(task_dirs) - len(extra)
    complete = not missing and not extra and not incomplete and attempted == len(dataset_ids)
    denominator = attempted
    sums = {name: sum(item[name] for item in scored) for name in ("code", "screenshot", "video")}
    scores = {name: (sums[name] / denominator if denominator else 0.0) for name in sums}
    final_score = mean(scores.values())
    return {
        "model": model,
        "complete": complete,
        "dataset_tasks": len(dataset_ids),
        "attempted_tasks": attempted,
        "valid_scored_tasks": len(scored),
        "status_counts": dict(sorted(statuses.items())),
        "generation_failure_kinds": dict(sorted(failure_kinds.items())),
        "missing_task_ids": missing,
        "extra_task_ids": extra,
        "incomplete_task_ids": sorted(set(incomplete)),
        "Final Score": round(final_score, 4),
        "Code": round(scores["code"], 4),
        "Screenshot": round(scores["screenshot"], 4),
        "Video": round(scores["video"], 4),
    }


def build_report(output_root: Path, dataset: Path) -> dict[str, Any]:
    ids = _dataset_ids(dataset.resolve())
    models = [_model_report(output_root.resolve(), model, ids) for model in MODELS]
    complete = all(model["complete"] for model in models)
    return {
        "schema_version": "vgamegym-full-awesome-final-v1",
        "complete": complete,
        "dataset": str(dataset.resolve()),
        "dataset_tasks": len(ids),
        "denominator": "attempted_tasks; every terminal failed attempt contributes zero",
        "score_scales": {"Final Score": "0-50", "Code": "0-100", "Screenshot": "0-25", "Video": "0-25"},
        "evaluation_note": (
            "Released VGameGym evaluator structure with local judges: Code uses Kimi-K2.7-Code; "
            "Screenshot and Video use Qwen3.6-27B. This is paper-scale compatible, not an exact "
            "reproduction of the paper's judge models."
        ),
        "models": models,
        "created_at": utc_now(),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--dataset", type=Path, default=DATASET)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--allow-incomplete", action="store_true")
    args = parser.parse_args(argv)
    report = build_report(args.output_root, args.dataset)
    if args.output is not None:
        atomic_write_json(args.output.resolve(), report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not report["complete"] and not args.allow_incomplete:
        print("refusing final report: full 2218-task coverage is incomplete", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
