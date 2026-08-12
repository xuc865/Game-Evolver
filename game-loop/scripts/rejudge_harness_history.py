#!/usr/bin/env python3
"""Rejudge archived harness epochs with the current frozen-parent rubrics."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from game_loop.config import AppConfig
from game_loop.core.harness import HarnessEpisodeOutcome, HarnessProfile
from game_loop.core.harness_rubric_validator import HarnessRubricValidator
from game_loop.utils import atomic_write_json, read_json, utc_now


def _outcomes(items: list[dict[str, Any]]) -> list[HarnessEpisodeOutcome]:
    return [
        HarnessEpisodeOutcome(
            case_id=str(item["case_id"]),
            harness_id=str(item["harness_id"]),
            final_score=(
                None if item.get("final_score") is None else float(item["final_score"])
            ),
            feasible=bool(item.get("feasible", False)),
            model_calls=int(item.get("model_calls", 0)),
            evaluator_queries=int(item.get("evaluator_queries", 0)),
            infrastructure_ok=bool(item.get("infrastructure_ok", True)),
            run_ref=(None if item.get("run_ref") is None else str(item["run_ref"])),
            allocated_model_calls=item.get("allocated_model_calls"),
            allocated_evaluator_queries=item.get("allocated_evaluator_queries"),
            allocated_probe_calls=item.get("allocated_probe_calls"),
        )
        for item in items
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--rejected-only", action="store_true")
    args = parser.parse_args()

    run_dir = args.run_dir.resolve()
    output = (args.output or run_dir / "historical_rejudge_v2.json").resolve()
    config = AppConfig.load(args.config.resolve())
    harness_config = config.method.harness_evolution
    if harness_config is None:
        raise ValueError("config has no harness_evolution section")
    validator = HarnessRubricValidator(harness_config)
    archive = read_json(run_dir / "harness_archive" / "epochs.json")
    existing = read_json(output) if output.is_file() else {"items": []}
    completed = {int(item["epoch"]) for item in existing.get("items", [])}
    results = list(existing.get("items", []))

    for epoch in archive.get("items", []):
        epoch_id = int(epoch["epoch"])
        if epoch_id in completed:
            continue
        if args.rejected_only and bool(epoch.get("accepted")):
            continue
        parent_outcomes = _outcomes(list(epoch.get("parent_outcomes", [])))
        candidate_outcomes = _outcomes(list(epoch.get("candidate_outcomes", [])))
        if not parent_outcomes or not candidate_outcomes:
            continue
        parent_id = str(epoch["parent_harness_id"])
        candidate_id = str(epoch["candidate_harness_id"])
        profiles = run_dir / "harness_archive" / "profiles"
        parent = HarnessProfile.from_dict(read_json(profiles / f"{parent_id}.json"))
        candidate = HarnessProfile.from_dict(read_json(profiles / f"{candidate_id}.json"))
        old_dynamic = epoch.get("rubric_validation", {}).get("dynamic_rubrics", [])
        task_refs = {
            str(item["case_id"]): Path(str(item["task_ref"]))
            for item in old_dynamic
            if item.get("case_id") and item.get("task_ref")
        }
        result = validator.validate_paired_outcomes(
            parent_outcomes=parent_outcomes,
            candidate_outcomes=candidate_outcomes,
            parent_profile=parent,
            candidate_profile=candidate,
            case_task_refs=task_refs,
        )
        item = {
            "epoch": epoch_id,
            "old_accepted": bool(epoch.get("accepted")),
            "new_accepted": result.accepted,
            "infrastructure_ok": result.infrastructure_ok,
            "parent_harness_id": parent_id,
            "candidate_harness_id": candidate_id,
            "validation": result.to_dict(),
            "rejudged_at": utc_now(),
        }
        results.append(item)
        results.sort(key=lambda value: int(value["epoch"]))
        atomic_write_json(output, {
            "schema_version": "historical-harness-rejudge.v2",
            "rubric_policy": "frozen_parent_game_quality_v2",
            "run_dir": str(run_dir),
            "updated_at": utc_now(),
            "items": results,
        })
        print(
            f"epoch={epoch_id} old={item['old_accepted']} new={item['new_accepted']} "
            f"infra={item['infrastructure_ok']}",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
