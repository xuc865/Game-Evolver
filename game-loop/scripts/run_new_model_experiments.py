#!/usr/bin/env python3
"""
run_new_model_experiments.py — Full-task runner for GC/GD/VeriGame model queues.

Benchmarks: gcbench, gdbench
Models:     glm5.2, deepseek_v4, kimi, qwen3.6-27b, claude, gpt55

Usage:
  python3 run_new_model_experiments.py --queue glm5.2_gcbench
  python3 run_new_model_experiments.py --launch-all
  python3 run_new_model_experiments.py --dry-run
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

import fcntl

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
RUNS = ROOT / ".baseline-agent-runs"
PYTHON = sys.executable
CFG_DIR = ROOT / "experiments" / "configs-v4"
PROGRESS_FILE = Path("/Users/wangxucong/Desktop/workspace/progress.txt")
SEED_ARTIFACTS = {
    "gcbench": ROOT / "experiments" / "seed_artifacts" / "puzzle-sokoban-scaffold",
    "gdbench": ROOT / "experiments" / "seed_artifacts" / "puzzle-sokoban-scaffold",
    "verigame": ROOT / "experiments" / "public_baseline_seeds" / "verigame",
}

BENCHES = ["gcbench", "gdbench"]
MODELS = ["glm5.2", "deepseek_v4", "kimi", "qwen3.6-27b", "claude", "gpt55"]

TASK_SOURCES = {
    "gcbench": ROOT.parent / "gcbench" / "tasks",
    "gdbench": ROOT / "third_party" / "gamedevbench" / "tasks",
    "verigame": ROOT / "third_party" / "GameGen-Verifier" / "spec",
}

MODEL_CONFIG_SUFFIX = {
    "glm5.2": "glm5.2",
    "deepseek_v4": "deepseek_v4",
    "kimi": "kimi",
    "qwen3.6-27b": "qwen3.6-27b",
    "claude": "claude",
    "gpt55": "gpt55",
}


def config_for(bench: str, model: str) -> Path:
    # A missing model-specific config must not silently run another model's
    # harness.  Callers already report missing paths as a queue skip.
    return CFG_DIR / f"{bench}-L4_{model}.json"


def queue_id(model: str, bench: str) -> str:
    return f"{model}_{bench}"


def discover_tasks(bench: str) -> list[Path]:
    src = TASK_SOURCES.get(bench)
    if not src or not src.is_dir():
        return []
    tasks: list[Path] = []
    for d in sorted(src.iterdir()):
        if d.is_dir() and not d.name.startswith(".") and not d.name.endswith(".zip"):
            tasks.append(d)
        elif bench == "verigame" and d.is_file() and d.suffix.casefold() == ".md":
            tasks.append(d)
        elif bench == "gdbench" and d.is_file() and d.suffix == ".zip":
            # Official GD task archives are read-only. Extract each archive
            # into the repository-local run cache before handing it to the
            # game-loop runner; never mutate the checkout under third_party/.
            extracted = RUNS / "task-cache" / "gdbench" / d.stem
            marker = extracted / ".source_archive"
            if not marker.is_file() or marker.read_text(encoding="utf-8") != str(d.resolve()):
                import zipfile
                extracted.mkdir(parents=True, exist_ok=True)
                with zipfile.ZipFile(d) as archive:
                    archive.extractall(extracted)
                marker.write_text(str(d.resolve()), encoding="utf-8")
            # The official archives contain a top-level tasks/<task_name>
            # directory.  game-loop expects the directory that owns
            # task_config.json, not the extraction container.
            nested = extracted / "tasks" / d.stem
            tasks.append(nested if nested.is_dir() else extracted)
    return tasks


def load_done_ids(out_dir: Path) -> set[str]:
    done: set[str] = set()
    summary_path = out_dir / "summary.json"
    if summary_path.is_file():
        try:
            s = json.loads(summary_path.read_text())
            for c in s.get("cases", []):
                if _case_is_solidly_done(c):
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
    return candidates[0] if candidates else None


@contextmanager
def model_queue_lock(model: str):
    lock_dir = RUNS / "provider-queue-locks" / model
    queue_dir = RUNS / "provider-queue-waiters" / model
    lock_dir.parent.mkdir(parents=True, exist_ok=True)
    queue_dir.mkdir(parents=True, exist_ok=True)
    waiter = queue_dir / f"{time.time_ns():020d}-{os.getpid():010d}.json"
    waiter.write_text(
        json.dumps({"pid": os.getpid(), "created_at": time.time()}) + "\n",
        encoding="utf-8",
    )
    acquired = False
    try:
        while True:
            for candidate in queue_dir.glob("*.json"):
                pid = int(rj(candidate).get("pid", 0) or 0)
                try:
                    os.kill(pid, 0)
                except OSError:
                    candidate.unlink(missing_ok=True)
            waiters = sorted(queue_dir.glob("*.json"), key=lambda path: path.name)
            if waiters and waiters[0] == waiter:
                try:
                    lock_dir.mkdir()
                    (lock_dir / "owner.json").write_text(
                        json.dumps({"pid": os.getpid(), "created_at": time.time()}) + "\n",
                        encoding="utf-8",
                    )
                    acquired = True
                    waiter.unlink(missing_ok=True)
                    break
                except FileExistsError:
                    owner = rj(lock_dir / "owner.json")
                    pid = int(owner.get("pid", 0) or 0)
                    try:
                        os.kill(pid, 0)
                    except OSError:
                        import shutil
                        shutil.rmtree(lock_dir, ignore_errors=True)
                        continue
            time.sleep(0.5)
        yield
    finally:
        waiter.unlink(missing_ok=True)
        if acquired:
            owner = rj(lock_dir / "owner.json")
            if int(owner.get("pid", 0) or 0) == os.getpid():
                import shutil
                shutil.rmtree(lock_dir, ignore_errors=True)


def _case_is_solidly_done(case: dict) -> bool:
    if case.get("status") != "completed":
        return False
    stop = str(case.get("stop_reason") or "").lower()
    if "infrastructure" in stop:
        return False
    try:
        evaluator_queries = int(case.get("evaluator_queries", 0) or 0)
    except (TypeError, ValueError):
        return False
    return evaluator_queries > 0 and case.get("champion_score") is not None


def _classify_case(bench_rc: int | None, state: dict) -> str:
    stop = str(state.get("stop_reason") or "").lower()
    champion = state.get("champion_result") or state.get("champion_evaluation") or {}
    try:
        evaluator_queries = int(state.get("evaluator_queries", 0) or 0)
    except (TypeError, ValueError):
        evaluator_queries = 0
    evaluated = evaluator_queries > 0 and champion.get("primary_score") is not None
    if bench_rc == 0 and "infrastructure" not in stop and evaluated:
        return "completed"
    return "failed"


def _recover_paused_gdbench_state(run_dir: Path, state: dict) -> dict | None:
    """Normalize a retained official GD result that was misclassified as infra."""
    if state.get("status") != "paused_infrastructure":
        return None
    attempts = state.get("attempts") or []
    if not attempts:
        return None
    candidate_dir = Path(str(attempts[-1].get("candidate_dir") or ""))
    result_path = candidate_dir / "gdbench_result" / "result.json"
    if not candidate_dir.is_dir() or not result_path.is_file():
        return None

    from game_loop.benchmarks.gdbench import GameDevBenchAdapter

    evaluation = GameDevBenchAdapter({}).parse_evaluation(result_path)
    if not evaluation.feasible:
        return None
    recovered = dict(state)
    recovered["status"] = "completed"
    recovered["stop_reason"] = (
        "official GameDevBench evaluator completed; normalized retained result "
        "without another model call"
    )
    recovered["evaluator_queries"] = max(
        1, int(recovered.get("evaluator_queries", 0) or 0)
    )
    recovered["champion_result"] = evaluation.to_dict()
    recovered["champion_evaluation"] = evaluation.to_dict()
    return recovered


def _select_resume_run_dir(
    prefix: str,
    bench: str,
    run_id: str,
    out_dir: Path,
    config_fingerprint: str | None = None,
) -> tuple[Path, dict | None]:
    historical = historical_run_dir(prefix, bench, run_id)
    if historical is None:
        return out_dir / run_id, None
    state = rj(historical / "state.json")
    recovered = (
        _recover_paused_gdbench_state(historical, state)
        if bench == "gdbench"
        else None
    )
    manifest_fingerprint = str(
        rj(historical / "manifest.json").get("config_fingerprint") or ""
    )
    if (
        recovered is None
        and state.get("status") != "completed"
        and config_fingerprint
        and manifest_fingerprint != config_fingerprint
    ):
        # A nonterminal run cannot be resumed under changed experimental
        # semantics. Keep the old directory as evidence and initialize a new
        # comparable run in the current root.
        return out_dir / run_id, None
    if state.get("status") == "paused_infrastructure":
        # A retained normal evaluator result can be normalized without another
        # model call. Any genuinely incomplete infrastructure episode is
        # immutable evidence, so retry it in this run root instead of calling
        # evolve on a state that intentionally returns unchanged forever.
        return (historical, recovered) if recovered is not None else (out_dir / run_id, None)
    return historical, recovered


def rj(p: Path) -> dict:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _preferred_case(current: dict | None, candidate: dict) -> dict:
    if current is None:
        return candidate
    current_completed = current.get("status") == "completed"
    candidate_completed = candidate.get("status") == "completed"
    if candidate_completed != current_completed:
        return candidate if candidate_completed else current
    if str(candidate.get("completed_at") or "") >= str(current.get("completed_at") or ""):
        return candidate
    return current


def cumulative_accuracy(prefix: str, bench: str, current_item: dict) -> tuple[float, int]:
    """Return mean primary score across unique finished tasks; failures score zero."""
    by_run_id: dict[str, dict] = {}
    for run_root in RUNS.glob(f"{prefix}_{bench}-resume-*"):
        summary = rj(run_root / "summary.json")
        for case in summary.get("cases", []):
            run_id = str(case.get("run_id") or "")
            if run_id:
                by_run_id[run_id] = _preferred_case(by_run_id.get(run_id), case)

    current_run_id = str(current_item.get("run_id") or "")
    if current_run_id:
        by_run_id[current_run_id] = _preferred_case(
            by_run_id.get(current_run_id), current_item
        )

    total = 0.0
    for case in by_run_id.values():
        if case.get("status") != "completed":
            continue
        try:
            score = float(case.get("champion_score") or 0.0)
        except (TypeError, ValueError):
            score = 0.0
        if math.isfinite(score):
            total += score
    count = len(by_run_id)
    return (total / count if count else 0.0), count


def append_progress_notice(prefix: str, item: dict) -> None:
    PROGRESS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with PROGRESS_FILE.open("a", encoding="utf-8") as progress:
        fcntl.flock(progress.fileno(), fcntl.LOCK_EX)
        try:
            accuracy, task_count = cumulative_accuracy(prefix, str(item["bench"]), item)
            try:
                score = float(item.get("champion_score") or 0.0)
            except (TypeError, ValueError):
                score = 0.0
            if not math.isfinite(score):
                score = 0.0
            progress.write(
                f"[{item['completed_at']}] task={item['task_name']} "
                f"model={item['model']} bench={item['bench']} status={item['status']} "
                f"score={score:.6f} cumulative_accuracy={accuracy * 100:.4f}% "
                f"mean_score={accuracy:.6f} unique_tasks={task_count}\n"
            )
            progress.flush()
        finally:
            fcntl.flock(progress.fileno(), fcntl.LOCK_UN)


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


def run_queue(model: str, bench: str, *, awesome_skills: bool = False) -> None:
    qid = queue_id(model, bench)
    cfg = config_for(bench, model)
    if not cfg.is_file():
        print(f"  SKIP {qid}: missing config {cfg}")
        return

    arm = "awesome" if awesome_skills else "baseline"
    prefix = f"new_model_{arm}_{MODEL_CONFIG_SUFFIX[model]}"
    ts = time.strftime("%Y%m%d-%H%M%S")
    out_dir = RUNS / f"{prefix}_{bench}-resume-{ts}"
    out_dir.mkdir(parents=True, exist_ok=True)

    seed_artifact = SEED_ARTIFACTS[bench]
    if not seed_artifact.is_dir():
        raise FileNotFoundError(f"shared seed artifact does not exist: {seed_artifact}")

    # L4 is run as one bounded generation per public task in this matrix.  The
    # checked-in configs are also used by multi-generation evolution jobs, so
    # create an isolated effective config instead of mutating those files.
    effective_cfg = out_dir / "config.json"
    config_value = json.loads(cfg.read_text(encoding="utf-8"))
    if awesome_skills:
        config_value.setdefault("backend", {}).setdefault("env", {})[
            "GAME_LOOP_USE_AWESOME_GAMEDEV_SKILLS"
        ] = "1"
    else:
        config_value.setdefault("backend", {}).setdefault("env", {}).pop(
            "GAME_LOOP_USE_AWESOME_GAMEDEV_SKILLS", None
        )
    evolution = config_value.setdefault("evolution", {})
    evolution["max_generations"] = 1
    evolution["candidates_per_generation"] = 1
    if bench == "gdbench":
        # Official GD validation can exceed the historical 180s smoke budget
        # even when the model successfully produced a runnable artifact.
        # Keep this override local to the matrix run and preserve checked-in
        # configs used by shorter smoke jobs.
        config_value.setdefault("backend", {})["timeout_seconds"] = 900
        command = config_value["backend"].get("command", [])
        for index, value in enumerate(command[:-1]):
            if value == "--evaluator-timeout" and command[index + 1] == "180":
                command[index + 1] = "600"
                break
    # Bridge commands otherwise fall back to the SDK's 7200s default.  Keep
    # a bounded per-task session so a dead/stalled model endpoint cannot hold a
    # full-matrix queue indefinitely.
    command = config_value["backend"].get("command", [])
    if bench in {"gdbench", "verigame"} and "--timeout" not in command:
        command.extend(["--timeout", "900"])
    effective_cfg.write_text(
        json.dumps(config_value, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    from game_loop.config import AppConfig

    config_fingerprint = AppConfig.load(effective_cfg).fingerprint

    tasks = discover_tasks(bench)
    done_ids = load_done_ids(out_dir)
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
        f"{prefix}_{bench} OUT={out_dir}\nMODEL={model}\nARM={arm}\nCONFIG={cfg}\n"
        f"PLANNED_COUNT={len(queue_list)}\n"
        f"SKIP_LOOP_EVOLVE={os.environ.get('SKIP_LOOP_EVOLVE', '0')}\n",
        encoding="utf-8",
    )

    for idx, (task, run_id) in enumerate(queue_list, 1):
        if (out_dir / "STOP").exists():
            break
        run_dir, recovered_state = _select_resume_run_dir(
            prefix, bench, run_id, out_dir, config_fingerprint
        )
        state_path = run_dir / "state.json"
        state_mtime_before = state_path.stat().st_mtime_ns if state_path.is_file() else None
        log_path = out_dir / f"{run_id}.log"
        started = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        with (out_dir / "runner.log").open("a", encoding="utf-8") as rl:
            rl.write(f"\n===== CASE {idx}/{len(queue_list)} {qid} {task.name} =====\n")

        rcs = {"init_rc": None, "bench_rc": None}
        try:
            need_init = not state_path.is_file()
            if need_init:
                rcs["init_rc"] = run_to_log(
                    [PYTHON, "-m", "game_loop", "init",
                     "--run-dir", run_dir, "--task-source", str(task),
                     "--cold-start", "--seed-score", "0",
                     "--seed-artifact", str(seed_artifact),
                     "--config", str(effective_cfg), "--run-id", run_id],
                    log_path, append=False,
                )
            if (
                recovered_state is None
                and bench == "gdbench"
                and state_path.is_file()
            ):
                recovered_state = _recover_paused_gdbench_state(
                    run_dir, rj(state_path)
                )
            if recovered_state is not None:
                rcs["bench_rc"] = 0
                with log_path.open("a", encoding="utf-8") as log:
                    log.write(
                        "\n[recovery] normalized retained official evaluator result "
                        "without another model call\n"
                    )
            else:
                with model_queue_lock(model):
                    rcs["bench_rc"] = run_to_log(
                        [PYTHON, "-m", "game_loop", "evolve",
                         "--run-dir", run_dir, "--config", str(effective_cfg)],
                        log_path, append=True,
                    )
        except Exception as exc:
            with log_path.open("a", encoding="utf-8") as log:
                log.write(f"\n[runner_exception] {exc}\n")

        completed = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        st = recovered_state or rj(run_dir / "state.json")
        cr = st.get("champion_result") or st.get("champion_evaluation") or {}
        stop_reason = st.get("stop_reason")
        run_status = st.get("status")

        status = _classify_case(rcs.get("bench_rc"), st)

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
        state_mtime_after = state_path.stat().st_mtime_ns if state_path.is_file() else None
        executed_this_run = (
            need_init
            or recovered_state is not None
            or state_mtime_after != state_mtime_before
        )
        try:
            if executed_this_run:
                append_progress_notice(prefix, item)
        except Exception as exc:
            with (out_dir / "runner.log").open("a", encoding="utf-8") as rl:
                rl.write(f"PROGRESS_NOTICE_ERROR={exc}\n")

    summary["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    summary["completed_count"] = sum(1 for c in summary["cases"] if _case_is_solidly_done(c))
    (out_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n"
    )
    print(f"[{qid}] finished: done={summary['completed_count']}, queued={len(queue_list)}")


def launch_all(*, models: list[str], awesome_skills: bool = False) -> None:
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["SKIP_LOOP_EVOLVE"] = env.get("SKIP_LOOP_EVOLVE", "1")
    pids: list[tuple[str, int]] = []
    arm = "awesome" if awesome_skills else "baseline"
    for model in models:
        for bench in BENCHES:
            qid = queue_id(model, bench)
            cfg = config_for(bench, model)
            if not cfg.is_file():
                print(f"  SKIP {qid}: missing config")
                continue
            log_file = RUNS / f"new_model_{arm}_{MODEL_CONFIG_SUFFIX[model]}_{bench}-launcher.log"
            queue_arg = f"{model}_{bench}" + ("_awesome" if awesome_skills else "")
            proc = subprocess.Popen(
                [sys.executable, "-u", str(__file__), "--queue", queue_arg],
                stdout=open(log_file, "a"),
                stderr=subprocess.STDOUT,
                start_new_session=True,
                env=env,
            )
            pids.append((qid, proc.pid))
            print(f"  Launched {qid} (PID {proc.pid}) -> {log_file}")
            time.sleep(1.5)
    print(f"\nLaunched {len(pids)} queues.")


def dry_run(*, models: list[str], awesome_skills: bool = False) -> None:
    arm = "awesome" if awesome_skills else "baseline"
    for model in models:
        for bench in BENCHES:
            qid = queue_id(model, bench)
            cfg = config_for(bench, model)
            tasks = discover_tasks(bench)
            prefix = f"new_model_{arm}_{MODEL_CONFIG_SUFFIX[model]}"
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
    parser = argparse.ArgumentParser(
        description="Full-task model experiment runner (GC/GD/VeriGame × configured models)"
    )
    parser.add_argument("--queue", type=str, default=None,
                        help="Queue ID: {model}_{bench} e.g. glm5.2_gcbench")
    parser.add_argument("--launch-all", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--model", action="append", dest="models", choices=MODELS)
    parser.add_argument("--awesome-skills", action="store_true")
    args = parser.parse_args(argv)

    if args.dry_run:
        dry_run(models=args.models or MODELS, awesome_skills=args.awesome_skills)
        return 0

    if args.launch_all:
        launch_all(models=args.models or MODELS, awesome_skills=args.awesome_skills)
        return 0

    if args.queue:
        queue_awesome = args.queue.endswith("_awesome")
        queue_value = args.queue[:-len("_awesome")] if queue_awesome else args.queue
        bench = next((candidate for candidate in BENCHES if queue_value.endswith(f"_{candidate}")), None)
        model = queue_value[:-(len(bench) + 1)] if bench else ""
        if not model or not bench:
            print(f"Invalid queue ID: {args.queue}. Expected format: {{model}}_{{bench}}")
            return 1
        if model not in MODELS:
            print(f"Unknown model: {model}. Available: {MODELS}")
            return 1
        if bench not in BENCHES:
            print(f"Unknown benchmark: {bench}. Available: {BENCHES}")
            return 1
        os.environ.setdefault("SKIP_LOOP_EVOLVE", "1")
        run_queue(model, bench, awesome_skills=args.awesome_skills or queue_awesome)
        return 0

    print(__doc__)
    print(f"\nAvailable models: {MODELS}")
    print(f"Available benchmarks: {BENCHES}")
    print(f"\nQueue IDs: {[queue_id(m, b) for m in MODELS for b in BENCHES]}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
