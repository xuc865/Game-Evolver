#!/usr/bin/env python3
"""
run_new_bench_experiments.py — Runner for the public general-benchmark baseline matrix.

Benchmarks: terminalbench (Terminal-Bench 2.1), taubench, nl2repo
Models:     kimi, qwen3.6-27b, glm5.2, claude, gpt55, deepseek_v4

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
# The public benchmark bridges enforce the repository's project sandbox under
# experiments/. Keep this matrix there so the safety boundary remains active.
RUNS = ROOT / "experiments" / "general-baseline-runs"
PYTHON = sys.executable
CFG_DIR = ROOT / "experiments" / "configs-v4"
SEED_ARTIFACTS = {
    "terminalbench": ROOT / "experiments" / "general-baseline" / "seed_terminalbench",
    "nl2repo": ROOT / "experiments" / "general-baseline" / "seed_nl2repo",
    "taubench": ROOT / "experiments" / "general-baseline" / "seed_taubench",
}

BENCHES = ["terminalbench", "taubench", "nl2repo"]
MODELS = ["kimi", "qwen3.6-27b", "glm5.2", "claude", "gpt55", "deepseek_v4"]

TASK_SOURCES = {
    "nl2repo": ROOT / "third_party" / "NL2RepoBench" / "NL2RepoBench_src" / "test_files",
    "terminalbench": ROOT / "third_party" / "terminal-bench-2",
    # Tau2 creates its official task set internally; this file is the public
    # instruction anchor required by the evolution engine.
    "taubench": ROOT / "experiments" / "general-baseline" / "taubench-instruction.md",
}

MODEL_CONFIG_SUFFIX = {
    "kimi": "kimi",
    "qwen3.6-27b": "qwen",
    "glm5.2": "glm",
    "deepseek_v4": "deepseek",
    "claude": "claude",
    "gpt55": "gpt55",
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
    if not src or (not src.is_dir() and not src.is_file()):
        return []
    tasks: list[Path] = []
    if bench == "taubench":
        return [src]
    if bench == "nl2repo":
        for d in sorted(src.iterdir()):
            if d.is_dir() and (d / "start.md").is_file() and not d.name.startswith("."):
                tasks.append(d)
    elif bench == "terminalbench":
        for d in sorted(src.iterdir()):
            if d.is_dir() and (d / "instruction.md").is_file() and not d.name.startswith("."):
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


def historical_run_dir(prefix: str, bench: str, run_id: str) -> Path | None:
    candidates = sorted(
        (
            run_root / run_id
            for run_root in RUNS.glob(f"{prefix}_{bench}-resume-*")
            if (run_root / run_id).is_dir()
        ),
        key=lambda path: path.parent.name,
        reverse=True,
    )
    for candidate in candidates:
        state = rj(candidate / "state.json")
        if state.get("status") in {"initialized", "running"}:
            return candidate
    return None


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

    effective_cfg = out_dir / "config.json"
    config_value = json.loads(cfg.read_text(encoding="utf-8"))
    evolution = config_value.setdefault("evolution", {})
    evolution["max_generations"] = 1
    evolution["candidates_per_generation"] = 1
    effective_cfg.write_text(
        json.dumps(config_value, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

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
        run_dir = historical_run_dir(prefix, bench, run_id) or (out_dir / run_id)
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
                     "--seed-artifact", str(SEED_ARTIFACTS[bench]),
                     "--config", str(effective_cfg), "--run-id", run_id],
                    log_path, append=False,
                )
            rcs["bench_rc"] = run_to_log(
                [PYTHON, "-m", "game_loop", "evolve",
                 "--run-dir", run_dir, "--config", str(effective_cfg)],
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
    """Launch all 18 queues in parallel as background processes."""
    RUNS.mkdir(parents=True, exist_ok=True)
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
    parser = argparse.ArgumentParser(description="General benchmark baseline runner (6×3)")
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
        # Parse from the benchmark suffix because deepseek_v4 contains an
        # underscore and cannot be split at the first underscore.
        bench = next((b for b in BENCHES if args.queue.endswith("_" + b)), None)
        model = args.queue[:-(len(bench) + 1)] if bench else ""
        if not bench or model not in MODELS:
            print(f"Invalid queue ID: {args.queue}. Expected one of the configured model/benchmark pairs")
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
