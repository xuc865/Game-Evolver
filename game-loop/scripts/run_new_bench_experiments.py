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
import signal
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

try:
    from scripts.general_benchmark_progress import record_task_notice
except ModuleNotFoundError:
    from general_benchmark_progress import record_task_notice

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


def load_env_local() -> None:
    """Load the repository-local model credentials without logging values."""
    env_file = ROOT / ".env.local"
    if not env_file.is_file():
        return
    completed = subprocess.run(
        [
            "/bin/zsh",
            "-lc",
            f"set -a; source {shlex.quote(str(env_file))}; set +a; env -0",
        ],
        check=True,
        capture_output=True,
    )
    for item in completed.stdout.split(b"\0"):
        if b"=" not in item:
            continue
        key, value = item.split(b"=", 1)
        os.environ[key.decode("utf-8")] = value.decode("utf-8")


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
            bench = s.get("bench")
            for c in s.get("cases", []):
                run_id = c.get("run_id", "")
                if c.get("status") != "completed" or not run_id:
                    continue
                if bench == "nl2repo":
                    manifests = sorted(
                        (out_dir / run_id).glob(
                            "generation_*/candidate_*/nl2repo_execution.json"
                        )
                    )
                    if not any(
                        str(rj(path).get("artifact_ref", "")).strip()
                        for path in manifests
                    ):
                        continue
                if bench == "taubench":
                    manifests = sorted(
                        (out_dir / run_id).glob(
                            "generation_*/candidate_*/taubench_execution.json"
                        ),
                        key=lambda path: path.stat().st_mtime,
                        reverse=True,
                    )
                    if not manifests or rj(manifests[0]).get("status") != "completed":
                        continue
                    batches = list(
                        (out_dir / run_id).glob(
                            "generation_*/candidate_*/tau2_*/results.json"
                        )
                    )
                    if max(
                        (
                            len(rj(path).get("simulations", []))
                            for path in batches
                            if isinstance(rj(path).get("simulations"), list)
                        ),
                        default=0,
                    ) < 50:
                        continue
                done.add(run_id)
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


def _process_tree_rss_kib(root_pid: int) -> int:
    """Return RSS for root_pid and descendants without adding a dependency."""
    completed = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,rss="],
        capture_output=True,
        text=True,
        check=False,
    )
    children: dict[int, list[int]] = {}
    rss: dict[int, int] = {}
    for line in completed.stdout.splitlines():
        try:
            pid_text, ppid_text, rss_text = line.split()
            pid, ppid = int(pid_text), int(ppid_text)
            rss[pid] = int(rss_text)
            children.setdefault(ppid, []).append(pid)
        except (TypeError, ValueError):
            continue
    pending = [root_pid]
    seen: set[int] = set()
    total = 0
    while pending:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.add(pid)
        total += rss.get(pid, 0)
        pending.extend(children.get(pid, ()))
    return total


def _terminate_owned_process_group(process: subprocess.Popen) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=15)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


def run_to_log(
    cmd: list,
    log_path: Path,
    append: bool = True,
    *,
    memory_limit_gib: float | None = None,
) -> int:
    mode = "a" if append else "w"
    with log_path.open(mode, encoding="utf-8") as log:
        log.write("\n$ " + " ".join(map(str, cmd)) + "\n")
        log.flush()
        p = subprocess.Popen(
            list(map(str, cmd)),
            cwd=ROOT,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        limit_kib = None if memory_limit_gib is None else int(memory_limit_gib * 1024 * 1024)
        rc = None
        while rc is None:
            try:
                rc = p.wait(timeout=2)
            except subprocess.TimeoutExpired:
                if limit_kib is None:
                    continue
                rss_kib = _process_tree_rss_kib(p.pid)
                if rss_kib <= limit_kib:
                    continue
                log.write(
                    "\n[infrastructure_error] owned process tree exceeded "
                    f"{memory_limit_gib:g} GiB (RSS={rss_kib / 1024 / 1024:.2f} GiB)\n"
                )
                log.flush()
                _terminate_owned_process_group(p)
                rc = 75
        log.write(f"\n[returncode] {rc}\n")
        log.flush()
        return rc


def terminalbench_docker_ready() -> tuple[bool, str]:
    docker = shutil.which("docker")
    if not docker:
        return False, "docker CLI is not installed"
    configured = os.environ.get("TERMINALBENCH_DOCKER_HOST")
    dedicated_socket = Path.home() / ".colima" / "terminalbench" / "docker.sock"
    candidates = [configured, os.environ.get("DOCKER_HOST")]
    if dedicated_socket.exists():
        candidates.append(f"unix://{dedicated_socket}")
    candidates.append(None)
    checked: set[str | None] = set()
    for host in candidates:
        if host in checked:
            continue
        checked.add(host)
        env = dict(os.environ)
        if host:
            env["DOCKER_HOST"] = host
        else:
            env.pop("DOCKER_HOST", None)
        try:
            completed = subprocess.run(
                [docker, "info"],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if completed.returncode == 0:
            if host:
                os.environ["DOCKER_HOST"] = host
            return True, ""
    return False, "Docker daemon is not running"


def run_queue(model: str, bench: str) -> None:
    qid = queue_id(model, bench)
    cfg = config_for(bench, model)
    if not cfg.is_file():
        print(f"  SKIP {qid}: missing config {cfg}")
        return
    if bench == "terminalbench":
        ready, reason = terminalbench_docker_ready()
        if not ready:
            print(f"[{qid}] BLOCKED: {reason}; no tasks were started")
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
                log_path,
                append=True,
                memory_limit_gib=(
                    float(os.environ.get("NL2REPO_TASK_MEMORY_LIMIT_GIB", "12"))
                    if bench == "nl2repo"
                    else None
                ),
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
        try:
            record_task_notice(
                runs=RUNS,
                prefix=prefix,
                model=model,
                bench=bench,
                task_name=task.name,
                run_id=run_id,
                completed_at=completed,
                status=status,
            )
        except Exception as exc:
            with (out_dir / "runner.log").open("a", encoding="utf-8") as rl:
                rl.write(f"PROGRESS_NOTICE_ERROR={exc}\n")

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
    load_env_local()
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
