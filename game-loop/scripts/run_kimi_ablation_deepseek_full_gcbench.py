#!/usr/bin/env python3
"""Run frozen Kimi-ablation champions over the full public GCbench task set."""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from game_loop.utils import atomic_write_json
from scripts.launch_kimi_champion_deepseek_eval import prepare_level


TASK_ROOT = ROOT.parent / "gcbench" / "tasks"
SEED = ROOT / "experiments" / "seed_artifacts" / "puzzle-sokoban-scaffold"
LEVELS = ("L0", "L1", "L2", "L3")
MAX_INFRA_ATTEMPTS = 6


def level_run_dir(level: str) -> Path:
    return ROOT / "experiments" / "runs" / f"gcbench-ablation-kimi-{level.lower()}-5epoch-v2"


def matrix_dir(level: str) -> Path:
    return level_run_dir(level) / "public_eval_deepseek_full_v2"


def screen_name(level: str) -> str:
    return f"gcbench-kimi-{level.lower()}-deepseek-v2-full-public"


def tasks() -> list[Path]:
    return sorted(
        path
        for path in TASK_ROOT.iterdir()
        if path.is_dir() and not path.name.startswith(".") and path.name != "example"
    )


def _read_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _valid_result(path: Path) -> dict | None:
    value = _read_json(path)
    return value if value.get("infrastructure_ok") is True else None


def _task_result(task_dir: Path) -> tuple[dict | None, int, list[dict]]:
    attempts: list[dict] = []
    for attempt in range(1, MAX_INFRA_ATTEMPTS + 1):
        result_path = task_dir / f"attempt_{attempt:03d}" / "public_eval.json"
        value = _read_json(result_path)
        if not value:
            continue
        attempts.append(
            {
                "attempt": attempt,
                "infrastructure_ok": value.get("infrastructure_ok"),
                "official_score": value.get("official_score"),
                "result": str(result_path),
            }
        )
        if value.get("infrastructure_ok") is True:
            return value, attempt, attempts
    return None, 0, attempts


def _initial_summary(level: str, champion_id: str, task_list: list[Path]) -> dict:
    return {
        "schema_version": "kimi-ablation-deepseek-full-gcbench.v1",
        "level": level,
        "champion_harness_id": champion_id,
        "model": "deepseek-v4-flash",
        "base_url": "https://api.deepseek.com",
        "planned_count": len(task_list),
        "planned_tasks": [task.name for task in task_list],
        "completed_count": 0,
        "cases": [],
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


def _upsert_case(summary: dict, case: dict) -> None:
    cases = [item for item in summary.get("cases", []) if item.get("task") != case["task"]]
    cases.append(case)
    summary["cases"] = sorted(cases, key=lambda item: str(item.get("task", "")))
    valid = [item for item in cases if item.get("status") == "completed"]
    summary["completed_count"] = len(valid)
    scores = [float(item["official_score"]) for item in valid]
    summary["mean_score"] = sum(scores) / len(scores) if scores else None
    summary["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")


def run_level(level: str) -> int:
    prepare_level(level)
    run_dir = level_run_dir(level)
    output = matrix_dir(level)
    output.mkdir(parents=True, exist_ok=True)
    champion_id = _read_json(run_dir / "harness_archive" / "champion.json")["harness_id"]
    profile = run_dir / "harness_archive" / "profiles" / f"{champion_id}.json"
    config = run_dir / "public_eval_deepseek_control" / "config.deepseek.json"
    task_list = tasks()
    summary_path = output / "summary.json"
    summary = _read_json(summary_path) or _initial_summary(level, champion_id, task_list)
    summary["planned_count"] = len(task_list)
    summary["planned_tasks"] = [task.name for task in task_list]
    atomic_write_json(summary_path, summary)

    for index, task in enumerate(task_list, 1):
        if (output / "STOP").is_file():
            return 2
        task_dir = output / "tasks" / task.name
        task_dir.mkdir(parents=True, exist_ok=True)
        valid, valid_attempt, attempt_records = _task_result(task_dir)
        if valid is not None:
            _upsert_case(
                summary,
                {
                    "index": index,
                    "task": task.name,
                    "status": "completed",
                    "official_score": valid.get("official_score"),
                    "infrastructure_ok": True,
                    "attempt": valid_attempt,
                    "attempts": attempt_records,
                },
            )
            atomic_write_json(summary_path, summary)
            continue

        for attempt in range(1, MAX_INFRA_ATTEMPTS + 1):
            attempt_dir = task_dir / f"attempt_{attempt:03d}"
            result_path = attempt_dir / "public_eval.json"
            existing = _read_json(result_path)
            if existing:
                if existing.get("infrastructure_ok") is True:
                    valid, valid_attempt = existing, attempt
                    break
                continue

            atomic_write_json(
                output / "current.json",
                {
                    "level": level,
                    "task": task.name,
                    "index": index,
                    "total": len(task_list),
                    "attempt": attempt,
                    "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                },
            )
            attempt_dir.mkdir(parents=True, exist_ok=True)
            log_path = task_dir / f"attempt_{attempt:03d}.log"
            with log_path.open("a", encoding="utf-8") as log:
                command = [
                    sys.executable,
                    "-m",
                    "game_loop.cli",
                    "harness-eval-public",
                    "--config",
                    str(config),
                    "--harness-profile",
                    str(profile),
                    "--task-source",
                    str(task),
                    "--seed-artifact",
                    str(SEED),
                    "--run-dir",
                    str(attempt_dir),
                    "--run-id-prefix",
                    f"kimi-{level.lower()}-deepseek-full-{task.name}-",
                ]
                log.write("\n$ " + " ".join(command) + "\n")
                log.flush()
                subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=False)
            value = _valid_result(result_path)
            if value is not None:
                valid, valid_attempt = value, attempt
                break

        _, _, attempt_records = _task_result(task_dir)
        if valid is not None:
            case = {
                "index": index,
                "task": task.name,
                "status": "completed",
                "official_score": valid.get("official_score"),
                "infrastructure_ok": True,
                "attempt": valid_attempt,
                "attempts": attempt_records,
            }
        else:
            case = {
                "index": index,
                "task": task.name,
                "status": "infra_exhausted",
                "official_score": None,
                "infrastructure_ok": False,
                "attempt": None,
                "attempts": attempt_records,
            }
        _upsert_case(summary, case)
        atomic_write_json(summary_path, summary)

    (output / "current.json").unlink(missing_ok=True)
    if int(summary.get("completed_count", 0)) == len(task_list):
        (output / "matrix.done").touch()
        return 0
    (output / "matrix.exhausted").touch()
    return 1


def launch() -> None:
    sessions = subprocess.run(
        ["/usr/bin/screen", "-ls"], capture_output=True, text=True, check=False
    ).stdout
    for level in LEVELS:
        prepare_level(level)
        if (matrix_dir(level) / "matrix.done").is_file():
            continue
        if f".{screen_name(level)}" in sessions:
            continue
        subprocess.run(
            [
                "/usr/bin/screen",
                "-dmS",
                screen_name(level),
                "/bin/bash",
                "-lc",
                (
                    f"cd {shlex.quote(str(ROOT))} || exit 1; set -a; "
                    "[[ ! -f .env.local ]] || source .env.local; "
                    "[[ ! -f experiments/.env ]] || source experiments/.env; "
                    "set +a; export CODEX_API_KEY=\"${DEEPSEEK_API_KEY:?}\"; "
                    "unset CODEX_CACHE_KEY CODEX_CACHE_KEY_HEADER CODEX_CACHE_KEY_MODE; exec "
                    f"{shlex.quote(sys.executable)} -u "
                    f"{shlex.quote(str(Path(__file__).resolve()))} watchdog {level}"
                ),
            ],
            cwd=ROOT,
            check=True,
        )


def status() -> dict:
    levels: dict[str, dict] = {}
    for level in LEVELS:
        output = matrix_dir(level)
        summary = _read_json(output / "summary.json")
        cases = summary.get("cases", [])
        failures = [case for case in cases if case.get("status") == "infra_exhausted"]
        levels[level] = {
            "champion_harness_id": summary.get("champion_harness_id"),
            "completed_count": summary.get("completed_count", 0),
            "planned_count": summary.get("planned_count", len(tasks())),
            "mean_score": summary.get("mean_score"),
            "current": _read_json(output / "current.json") or None,
            "infra_exhausted": [case.get("task") for case in failures],
            "done": (output / "matrix.done").is_file(),
        }
    return {"task_count": len(tasks()), "levels": levels}


def watchdog(level: str) -> int:
    output = matrix_dir(level)
    while not (output / "matrix.done").is_file() and not (output / "matrix.exhausted").is_file():
        run_level(level)
        if not (output / "matrix.done").is_file() and not (output / "matrix.exhausted").is_file():
            time.sleep(30)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("launch", "status", "run", "watchdog"), nargs="?", default="status")
    parser.add_argument("level", choices=LEVELS, nargs="?")
    args = parser.parse_args()
    if args.command == "launch":
        launch()
    elif args.command in {"run", "watchdog"}:
        if args.level is None:
            parser.error(f"{args.command} requires LEVEL")
        return run_level(args.level) if args.command == "run" else watchdog(args.level)
    print(json.dumps(status(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
