#!/usr/bin/env python3
"""Watch runner summaries so already-running queues also emit progress notices."""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

try:
    from scripts.general_benchmark_progress import (
        mark_notices_seen,
        notice_key,
        record_task_notice,
        seen_notice_keys,
    )
except ModuleNotFoundError:
    from general_benchmark_progress import (
        mark_notices_seen,
        notice_key,
        record_task_notice,
        seen_notice_keys,
    )


ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "experiments" / "general-baseline-runs"


def scan(*, emit: bool) -> int:
    recorded = 0
    baseline_keys: list[str] = []
    seen = seen_notice_keys(RUNS) if emit else set()
    for summary_path in RUNS.glob("new_bench_*-resume-*/summary.json"):
        try:
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        model = str(summary.get("model") or "")
        bench = str(summary.get("bench") or "")
        prefix = str(summary.get("kind") or "").removesuffix(f"_{bench}")
        if not model or not bench or not prefix:
            continue
        for case in summary.get("cases", []):
            if not isinstance(case, dict) or not case.get("completed_at"):
                continue
            key = notice_key(
                model,
                bench,
                str(case.get("run_id") or "unknown"),
                str(case["completed_at"]),
            )
            if not emit:
                baseline_keys.append(key)
                continue
            if key in seen:
                continue
            recorded += int(record_task_notice(
                runs=RUNS,
                prefix=prefix,
                model=model,
                bench=bench,
                task_name=str(case.get("task_name") or Path(str(case.get("task") or "unknown")).name),
                run_id=str(case.get("run_id") or "unknown"),
                completed_at=str(case["completed_at"]),
                status=str(case.get("status") or "unknown"),
                emit=emit,
            ))
    return mark_notices_seen(RUNS, baseline_keys) if not emit else recorded


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--poll-seconds", type=float, default=5.0)
    parser.add_argument("--baseline-existing", action="store_true")
    args = parser.parse_args()
    if args.baseline_existing:
        scan(emit=False)
    while True:
        scan(emit=True)
        time.sleep(max(args.poll_seconds, 1.0))


if __name__ == "__main__":
    raise SystemExit(main())
