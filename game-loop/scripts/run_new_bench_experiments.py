#!/usr/bin/env python3
"""
run_new_bench_experiments.py — Runner for 16 queues: 4 benchmarks × 4 models.

Benchmarks: swebench, nl2repo, terminalbench, weavebench
Models:     kimi, qwen3.6-27b, glm5.2, deepseek_v4

Usage:
  python3 run_new_bench_experiments.py --queue kimi_swebench
  python3 run_new_bench_experiments.py --launch-all
  python3 run_new_bench_experiments.py --dry-run
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / ".baseline-agent-runs"
PYTHON = sys.executable
CFG_DIR = ROOT / "experiments" / "configs-v4"

BENCHES = ["swebench", "nl2repo", "terminalbench", "weavebench"]
MODELS = ["kimi", "qwen3.6-27b", "glm5.2", "deepseek_v4"]

TASK_SOURCES = {
    "swebench": Path("/Users/wangxucong/Desktop/workspace/harness-game/game-loop/.baseline-agent-runs/swebench_tasks"),
    "nl2repo": Path("/Users/wangxucong/Desktop/workspace/harness-game/third_party/NL2RepoBench/test_files"),
    "terminalbench": Path("/Users/wangxucong/Desktop/workspace/harness-game/third_party/terminal-bench/original-tasks"),
    "weavebench": Path("/Users/wangxucong/Desktop/workspace/harness-game/third_party/WeaveBench/cache/tasks"),
}

MODEL_CONFIG_SUFFIX = {
    "kimi": "kimi",
    "qwen3.6-27b": "qwen",
    "glm5.2": "glm",
    "deepseek_v4": "deepseek",
}


def config_for(bench: str, model: str) -> Path:
    primary = CFG_DIR / f"{bench}-L4_{model}.json"
    if primary.is_file():
        return primary
    return CFG_DIR / f"{bench}-L4.json"


def queue_id(model: str, bench: str) -> str:
    return f"{model}_{bench}"


def discover_tasks(bench: str) -> list[Path]:
    src = TASK_SOURCES.get(bench)
    if not src or not src.is_dir():
        return []
    tasks: list[Path] = []
    if bench == "swebench":
        for d in sorted(src.iterdir()):
            if d.is_dir() and (d / "task.json").is_file():
                tasks.append(d)
    elif bench == "nl2repo":
        for d in sorted(src.iterdir()):
            if d.is_dir() and not d.name.startswith("."):
                tasks.append(d)
    elif bench == "terminalbench":
        for d in sorted(src.iterdir()):
            if d.is_dir() and not d.name.startswith("."):
                tasks.append(d)
    elif bench == "weavebench":
        cache = src.parent / "task_dirs"
        if cache.is_dir():
            for domain_dir in sorted(cache.iterdir()):
                if not domain_dir.is_dir():
                    continue
                for task_dir in sorted(domain_dir.iterdir()):
                    if task_dir.is_dir() and (task_dir / "task.md").is_file():
                        tasks.append(task_dir)
        if not tasks:
            for d in sorted(src.iterdir()):
                if d.is_dir() and not d.name.startswith("."):
                    tasks.append(d)
    return tasks


def load_done_ids(out_dir: Path) -> set[str]:
    done: set[str] = set()
    summary_path = out_dir / "summary.json"
    if summary_path.is_file():
        try:
            s = json.loads(summary_path.read_text())
            for c in s.get("cases", []):
                if c.get("status") == "completed":
                    done.add(c.get("run_id", ""))
        except Exception:
            pass
    return done


def _case_is_solidly_done(case: dict) -> bool:
    if case.get("status") != "completed":
        return False
    stop = str(case.get("stop_reason") or "").lower()
    if "infrastructure" in stop:
        return False
    return True


def rj(p: Path) -> dict:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def run_to_log(cmd: list, log_path: Path, append: bool = True) -> int:
    mode = "a" if append else "w"
    with log_path.open(mode, encoding="utf-8") as log:
        log.write("\n$ " + " ".join(map(str, cmd)) + "\n")
        log.flush()
        p = subprocess.Popen(list(map(str, cmd)), cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        rc = p.wait()
        log.write(f"\n[returncode] {rc}\n")
        log.flush()
        return rc


def run_queue(model: str, bench: str) -> None:
    qid = queue_id(model, bench)
    cfg = config_for(bench, model)
    if not cfg.is_file():
        print(f"  SKIP {qid}: missing config {cfg}")
        return

    prefix = f"new_bench_{MODEL_CONFIG_SUFFIX[model]}"
    ts = time.strftime("%Y%m%d-%H%M%S")
    out_dir = RUNS / f"{prefix}_{bench}-resume-{ts}"
    out_dir.mkdir(parents=True, exist_ok=True)

    tasks = discover_tasks(bench)
    done_ids = load_done_ids(out_dir)
    # also check previous run dirs
    for d in RUNS.iterdir():
        if d.is_dir() and d.name.startswith(f"{prefix}_{bench}-resume-"):
            done_ids |= load_done_ids(d)

    queue_list = []
    for task in tasks:
        task_name = task.name if task.is_dir() else task.stem
        run_id = f"{prefix}_{bench}_{task_name}"
        if run_id not in done_ids:
            queue_list.append((task, run_id))

    print(f"[{qid}] {len(queue_list)} tasks remaining (of {len(tasks)} total) -> {out_dir}")
    if not queue_list:
        print(f"[{qid}] nothing to run")
        return

    summary = {
        "schema_version": "1.0",
        "kind": f"{prefix}_{bench}",
        "model": model,
        "bench": bench,
        "config": str(cfg),
        "out_dir": str(out_dir),
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "planned_count": len(queue_list),
        "planned_cases": [{"task": str(t), "run_id": rid} for t, rid in queue_list],
        "cases": [],
    }
    (out_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n"
    )
    (out_dir / "runner.log").write_text(
        f"{prefix}_{bench} OUT={out_dir}\nMODEL={model}\nCONFIG={cfg}\n"
        f"PLANNED_COUNT={len(queue_list)}\n"
        f"SKIP_LOOP_EVOLVE={os.environ.get('SKIP_LOOP_EVOLVE', '0')}\n",
        encoding="utf-8",
    )

    for idx, (task, run_id) in enumerate(queue_list, 1):
        if (out_dir / "STOP").exists():
            break
        run_dir = out_dir / run_id
        log_path = out_dir / f"{run_id}.log"
        started = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        with (out_dir / "runner.log").open("a", encoding="utf-8") as rl:
            rl.write(f"\n===== CASE {idx}/{len(queue_list)} {qid} {task.name} =====\n")

        rcs = {"init_rc": None, "bench_rc": None}
        try:
            need_init = not (run_dir / "state.json").is_file()
            if need_init:
                rcs["init_rc"] = run_to_log(
                    [PYTHON, "-m", "game_loop", "init",
                     "--run-dir", run_dir, "--task-source", str(task),
                     "--cold-start", "--seed-score", "0",
                     "--config", str(cfg), "--run-id", run_id],
                    log_path, append=False,
                )
            rcs["bench_rc"] = run_to_log(
                [PYTHON, "-m", "game_loop", "evolve",
                 "--run-dir", run_dir, "--config", str(cfg)],
                log_path, append=True,
            )
        except Exception as exc:
            with log_path.open("a", encoding="utf-8") as log:
                log.write(f"\n[runner_exception] {exc}\n")

        completed = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        st = rj(run_dir / "state.json")
        cr = st.get("champion_result") or st.get("champion_evaluation") or {}
        stop_reason = st.get("stop_reason")
        run_status = st.get("status")

        if rcs.get("bench_rc") == 0 and "infrastructure" not in str(stop_reason or "").lower():
            status = "completed"
        else:
            status = "failed"

        item = {
            "run_id": run_id,
            "task": str(task),
            "task_name": task.name,
            "bench": bench,
            "model": model,
            "status": status,
            "started_at": started,
            "completed_at": completed,
            "returncodes": rcs,
            "champion_score": cr.get("primary_score"),
            "stop_reason": stop_reason,
            "run_status": run_status,
            "model_calls": st.get("model_calls", 0),
            "evaluator_queries": st.get("evaluator_queries", 0),
        }
        summary["cases"].append(item)
        summary["completed_count"] = sum(1 for c in summary["cases"] if _case_is_solidly_done(c))
        (out_dir / "summary.json").write_text(
            json.dumps(summary, indent=2, ensure_ascii=False) + "\n"
        )
        with (out_dir / "runner.log").open("a", encoding="utf-8") as rl:
            rl.write(f"CASE_SUMMARY={json.dumps({'run_id': run_id, 'status': status, 'score': cr.get('primary_score'), 'stop_reason': stop_reason}, ensure_ascii=False)}\n")

    summary["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    summary["completed_count"] = sum(1 for c in summary["cases"] if _case_is_solidly_done(c))
    (out_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n"
    )
    print(f"[{qid}] finished: done={summary['completed_count']}, queued={len(queue_list)}")


def launch_all() -> None:
    """Launch all 16 queues in parallel as background processes."""
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["SKIP_LOOP_EVOLVE"] = env.get("SKIP_LOOP_EVOLVE", "1")
    pids: list[tuple[str, int]] = []
    for model in MODELS:
        for bench in BENCHES:
            qid = queue_id(model, bench)
            cfg = config_for(bench, model)
            if not cfg.is_file():
                print(f"  SKIP {qid}: missing config")
                continue
            log_file = RUNS / f"new_bench_{MODEL_CONFIG_SUFFIX[model]}_{bench}-launcher.log"
            proc = subprocess.Popen(
                [sys.executable, "-u", str(__file__), "--queue", qid],
                stdout=open(log_file, "a"),
                stderr=subprocess.STDOUT,
                start_new_session=True,
                env=env,
            )
            pids.append((qid, proc.pid))
            print(f"  Launched {qid} (PID {proc.pid}) -> {log_file}")
            time.sleep(1.5)
    print(f"\nLaunched {len(pids)} queues.")


def dry_run() -> None:
    for model in MODELS:
        for bench in BENCHES:
            qid = queue_id(model, bench)
            cfg = config_for(bench, model)
            tasks = discover_tasks(bench)
            prefix = f"new_bench_{MODEL_CONFIG_SUFFIX[model]}"
            done: set[str] = set()
            for d in RUNS.iterdir():
                if d.is_dir() and d.name.startswith(f"{prefix}_{bench}-resume-"):
                    done |= load_done_ids(d)
            planned = {f"{prefix}_{bench}_{t.name if t.is_dir() else t.stem}" for t in tasks}
            remaining = len(planned - done)
            cfg_status = "OK" if cfg.is_file() else "MISSING"
            print(f"  {qid}: {len(tasks)} total, {remaining} remaining  cfg={cfg_status}")


def main(argv: list[str] | None = None) -> int:
    import argparse
    parser = argparse.ArgumentParser(description="New benchmark experiment runner (4×4)")
    parser.add_argument("--queue", type=str, default=None,
                        help="Queue ID: {model}_{bench} e.g. kimi_swebench")
    parser.add_argument("--launch-all", action="store_true",
                        help="Launch all 16 queues as background processes")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    if args.dry_run:
        dry_run()
        return 0

    if args.launch_all:
        launch_all()
        return 0

    if args.queue:
        # parse queue ID: {model}_{bench}
        parts = args.queue.split("_", 1)
        if len(parts) != 2:
            print(f"Invalid queue ID: {args.queue}. Expected format: {{model}}_{{bench}}")
            return 1
        model, bench = parts
        if model not in MODELS:
            print(f"Unknown model: {model}. Available: {MODELS}")
            return 1
        if bench not in BENCHES:
            print(f"Unknown benchmark: {bench}. Available: {BENCHES}")
            return 1
        os.environ.setdefault("SKIP_LOOP_EVOLVE", "1")
        run_queue(model, bench)
        return 0

    print(__doc__)
    print(f"\nAvailable models: {MODELS}")
    print(f"Available benchmarks: {BENCHES}")
    print(f"\nQueue IDs: {[queue_id(m, b) for m in MODELS for b in BENCHES]}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
