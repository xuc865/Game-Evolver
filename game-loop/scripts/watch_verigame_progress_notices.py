#!/usr/bin/env python3
"""Backfill live-run progress notices until workers load the integrated writer."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from run_verigame_public_awesome import (
    PROVIDERS,
    append_progress_notice,
    prune_rebuildable_dependencies,
    read_json,
    write_json,
)


def case_key(item: dict) -> str:
    return str(item.get("attempt_root") or f"{item.get('run_id')}|{item.get('finished_at')}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    args = parser.parse_args()
    checkpoint_path = args.output_root / "progress_notice_watcher.json"
    checkpoint = read_json(checkpoint_path)
    seen = {str(value) for value in checkpoint.get("seen", [])}

    if not checkpoint_path.is_file():
        for provider in PROVIDERS:
            summary = read_json(args.output_root / provider / "summary.json")
            seen.update(case_key(item) for item in summary.get("cases", []))
        write_json(checkpoint_path, {"seen": sorted(seen)})

    while True:
        changed = False
        for provider in PROVIDERS:
            summary = read_json(args.output_root / provider / "summary.json")
            cases = summary.get("cases", [])
            attempted = int(summary.get("attempted_count") or len(cases))
            completed = int(
                summary.get("officially_completed_count")
                or sum(item.get("status") == "completed" for item in cases)
            )
            for item in cases:
                key = case_key(item)
                if key in seen:
                    continue
                append_progress_notice(
                    item,
                    attempted_count=attempted,
                    completed_count=completed,
                )
                prune_rebuildable_dependencies(Path(str(item.get("attempt_root", ""))))
                seen.add(key)
                changed = True
        if changed:
            write_json(checkpoint_path, {"seen": sorted(seen)})
        time.sleep(args.poll_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
