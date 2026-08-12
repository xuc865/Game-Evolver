#!/usr/bin/env python3
"""Promote a validated merge of rejudged harness elements onto the champion."""

from __future__ import annotations

import argparse
from pathlib import Path

from game_loop.config import AppConfig
from game_loop.core.harness import HarnessActiveElement, HarnessEvolutionEngine
from game_loop.utils import atomic_write_json, read_json, utc_now


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--element", action="append", required=True)
    parser.add_argument("--remove-element", action="append", default=[])
    parser.add_argument("--evidence", action="append", default=[])
    parser.add_argument("--audit-output", type=Path)
    args = parser.parse_args()

    run_dir = args.run_dir.resolve()
    config = AppConfig.load(args.config.resolve())
    harness_config = config.method.harness_evolution
    if harness_config is None:
        raise ValueError("config has no harness_evolution section")

    engine = HarnessEvolutionEngine(run_dir, harness_config)
    parent = engine.champion()
    requested = tuple(dict.fromkeys(str(item) for item in args.element))
    missing = [item for item in requested if item not in engine.elements]
    if missing:
        raise ValueError(f"unknown harness elements: {missing}")

    active_by_id = {item.element_id: item for item in parent.active_elements}
    removed: list[str] = []
    for element_id in dict.fromkeys(str(item) for item in args.remove_element):
        if element_id in active_by_id:
            active_by_id.pop(element_id)
            removed.append(element_id)
    added: list[str] = []
    for element_id in requested:
        if element_id in active_by_id:
            continue
        active_by_id[element_id] = HarnessActiveElement.from_config(
            engine.elements[element_id]
        )
        added.append(element_id)
    if not added and not removed:
        raise ValueError("merge is a no-op; requested profile is already active")

    epochs = read_json(run_dir / "harness_archive" / "epochs.json").get("items", [])
    next_generation = max(
        [parent.generation, *(int(item.get("epoch", 0)) for item in epochs)]
    ) + 1
    rationale = (
        "Manual baseline merge after complete historical rejudging under "
        "frozen-parent-game-quality-v2. Added only deduplicated elements supported "
        f"by infrastructure-clean three-case admissions: {', '.join(added)}."
        + (f" Replaced overlapping elements: {', '.join(removed)}." if removed else "")
    )
    merged = engine._profile(
        parent_id=parent.harness_id,
        modules=parent.active_modules,
        tool_interfaces=parent.active_tool_interfaces,
        active_elements=tuple(active_by_id.values()),
        context_compiler=parent.context_compiler,
        recovery_policy=parent.recovery_policy,
        validation_policy=parent.validation_policy,
        generation=next_generation,
        rationale=rationale,
    )
    engine._validate_profile(merged)
    engine._write_profile(merged)

    promoted_at = utc_now()
    audit = {
        "schema_version": "rejudged-harness-merge.v1",
        "promoted_at": promoted_at,
        "rubric_policy": "frozen-parent-game-quality-v2",
        "previous_champion_harness_id": parent.harness_id,
        "merged_champion_harness_id": merged.harness_id,
        "added_elements": added,
        "removed_elements": removed,
        "requested_elements": list(requested),
        "evidence": list(args.evidence),
        "profile_path": str(
            run_dir / "harness_archive" / "profiles" / f"{merged.harness_id}.json"
        ),
    }
    audit_output = (
        args.audit_output.resolve()
        if args.audit_output
        else run_dir / "harness_archive" / "rejudged_merge_latest.json"
    )
    atomic_write_json(audit_output, audit)
    atomic_write_json(run_dir / "harness_archive" / "champion.json", {
        "harness_id": merged.harness_id,
        "updated_at": promoted_at,
        "promotion_kind": "historical_rejudge_merge",
        "audit_ref": str(audit_output),
    })
    print(merged.harness_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
