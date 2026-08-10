#!/usr/bin/env python3
"""Reclassify historical provider outages in one formal VGameGym output root."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from game_loop.utils import atomic_write_json, utc_now


MODELS = ("kimi", "qwen", "glm", "deepseek")
MARKERS = (
    "[api error:",
    "insufficient balance",
    "connection error",
    "502 terminated",
    "503 service unavailable",
    "504 gateway",
    "empty response text",
    "model stream ended with empty response",
)


def _read(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _submission_text(task: Path) -> str:
    chunks = []
    for path in (task / "submission.json", task / "generation" / "submission.json"):
        value = _read(path)
        chunks.extend(str(value.get(key, "")) for key in ("result_text", "error"))
        diagnostics = value.get("diagnostics", [])
        if isinstance(diagnostics, list):
            chunks.extend(str(item) for item in diagnostics)
    error = _read(task / "generation_error.json")
    chunks.append(str(error.get("error", "")))
    return " ".join(chunks).casefold()


def migrate(root: Path) -> dict[str, int]:
    counts = {model: 0 for model in MODELS}
    for model in MODELS:
        for task in sorted((root / model).glob("task_*")):
            status_path = task / "status.json"
            if not status_path.is_file():
                continue
            status = _read(status_path)
            if status.get("status") != "generation_failed":
                continue
            text = _submission_text(task)
            if not any(marker in text for marker in MARKERS):
                continue
            status.update({
                "status": "provider_infrastructure_failure",
                "generation_status": "generation_failed",
                "generation_failure_kind": "provider_infrastructure_failure",
                "generation_attempts_total": 0,
                "provider_failure_migrated_at": utc_now(),
            })
            atomic_write_json(status_path, status)
            counts[model] += 1
    atomic_write_json(root / "provider_failure_migration.json", {
        "models": counts, "total": sum(counts.values()), "updated_at": utc_now()
    })
    return counts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(migrate(args.output_root.resolve()), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
