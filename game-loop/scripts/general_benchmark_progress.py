"""Append deduplicated per-task progress notices for general benchmarks."""
from __future__ import annotations

import fcntl
import json
import math
import os
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10+ is standard here.
    try:
        import tomli as tomllib
    except ModuleNotFoundError:  # pragma: no cover - compatibility fallback.
        tomllib = None


DEFAULT_PROGRESS_FILE = Path("/Users/wangxucong/Desktop/workspace/progress.txt")
TERMINALBENCH_TASKS = Path(__file__).resolve().parents[1] / "third_party" / "terminal-bench-2"


def _read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _latest_manifests(runs: Path, prefix: str, bench: str) -> dict[str, Path]:
    manifest_name = f"{bench}_execution.json"
    latest: dict[str, Path] = {}
    for root in runs.glob(f"{prefix}_{bench}-resume-*"):
        if not root.is_dir():
            continue
        for path in root.glob(f"*/generation_*/candidate_*/{manifest_name}"):
            run_id = path.relative_to(root).parts[0]
            previous = latest.get(run_id)
            if previous is None or path.stat().st_mtime_ns > previous.stat().st_mtime_ns:
                latest[run_id] = path
    return latest


def cumulative_accuracy(runs: Path, prefix: str, bench: str) -> tuple[int, int]:
    """Return (passed, valid), using the same validity rules as the monitor."""
    manifests = _latest_manifests(runs, prefix, bench)
    passed = valid = 0
    if bench == "taubench":
        for manifest_path in manifests.values():
            manifest = _read_json(manifest_path)
            if manifest.get("status") != "completed":
                continue
            result_path = Path(str(manifest.get("result_path") or ""))
            candidates = [result_path] if result_path.is_file() else []
            candidates.extend(manifest_path.parent.glob("tau2_*/results.json"))
            result = _read_json(candidates[-1]) if candidates else {}
            for simulation in result.get("simulations", []):
                if (
                    not isinstance(simulation, dict)
                    or simulation.get("termination_reason") == "infrastructure_error"
                ):
                    continue
                reward_info = simulation.get("reward_info")
                reward = _number(reward_info.get("reward")) if isinstance(reward_info, dict) else None
                if reward is None:
                    continue
                valid += 1
                passed += int(reward == 1.0)
        return passed, valid

    for path in manifests.values():
        manifest = _read_json(path)
        if manifest.get("infrastructure_error") is not False:
            continue
        if bench == "nl2repo":
            if not str(manifest.get("artifact_ref") or "").strip():
                continue
            score = _number(manifest.get("reward"))
            if score is None:
                score = _number(manifest.get("score"))
            if score is None:
                continue
            valid += 1
            passed += int(score == 1.0)
        elif bench == "terminalbench":
            parsed_passed = manifest.get("passed")
            reward = _number(manifest.get("reward"))
            if not isinstance(parsed_passed, bool) or reward is None:
                continue
            valid += 1
            passed += int(parsed_passed is True)
    return passed, valid


def terminalbench_difficulty_stats(runs: Path, prefix: str) -> dict[str, dict[str, int | float | None]]:
    """Group canonical TerminalBench results by official task difficulty."""
    stats = {
        level: {"valid": 0, "passed": 0, "infra": 0, "accuracy": None}
        for level in ("easy", "medium", "hard")
    }
    manifests = _latest_manifests(runs, prefix, "terminalbench")
    for run_id, manifest_path in manifests.items():
        task_name = run_id.removeprefix(f"{prefix}_terminalbench_")
        task_file = TERMINALBENCH_TASKS / task_name / "task.toml"
        try:
            task_text = task_file.read_text(encoding="utf-8")
            if tomllib is not None:
                metadata = tomllib.loads(task_text).get("metadata", {})
                level = metadata.get("difficulty")
            else:
                level = next(
                    line.split("=", 1)[1].strip().strip('"')
                    for line in task_text.splitlines()
                    if line.strip().startswith("difficulty =")
                )
        except (OSError, ValueError, TypeError):
            continue
        if level not in stats:
            continue
        bucket = stats[level]
        manifest = _read_json(manifest_path)
        if manifest.get("infrastructure_error") is True:
            bucket["infra"] += 1
            continue
        if manifest.get("infrastructure_error") is not False:
            continue
        passed = manifest.get("passed")
        reward = _number(manifest.get("reward"))
        if not isinstance(passed, bool) or reward is None:
            continue
        bucket["valid"] += 1
        bucket["passed"] += int(passed is True)
    for bucket in stats.values():
        if bucket["valid"]:
            bucket["accuracy"] = bucket["passed"] / bucket["valid"]
    return stats


def notice_key(model: str, bench: str, run_id: str, completed_at: str) -> str:
    return "|".join((model, bench, run_id, completed_at))


def seen_notice_keys(runs: Path) -> set[str]:
    checkpoint = runs / "progress_notice_checkpoint.json"
    lock_path = runs / ".progress_notice.lock"
    runs.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_SH)
        return set(_read_json(checkpoint).get("seen", []))


def mark_notices_seen(runs: Path, keys: list[str]) -> int:
    """Add an initial batch to the checkpoint without emitting notices."""
    checkpoint = runs / "progress_notice_checkpoint.json"
    lock_path = runs / ".progress_notice.lock"
    runs.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        state = _read_json(checkpoint)
        seen = set(state.get("seen", []))
        before = len(seen)
        seen.update(keys)
        checkpoint.write_text(
            json.dumps({"schema_version": 1, "seen": sorted(seen)}, indent=2) + "\n",
            encoding="utf-8",
        )
        return len(seen) - before


def record_task_notice(
    *,
    runs: Path,
    prefix: str,
    model: str,
    bench: str,
    task_name: str,
    run_id: str,
    completed_at: str,
    status: str,
    progress_file: Path | None = None,
    emit: bool = True,
) -> bool:
    """Record one task once. O_APPEND and flock make concurrent queues safe."""
    progress_file = progress_file or Path(
        os.environ.get("GENERAL_BENCH_PROGRESS_FILE", str(DEFAULT_PROGRESS_FILE))
    )
    checkpoint = runs / "progress_notice_checkpoint.json"
    lock_path = runs / ".progress_notice.lock"
    runs.mkdir(parents=True, exist_ok=True)
    key = notice_key(model, bench, run_id, completed_at)

    with lock_path.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        state = _read_json(checkpoint)
        seen = set(state.get("seen", []))
        if key in seen:
            return False
        if emit:
            passed, valid = cumulative_accuracy(runs, prefix, bench)
            accuracy = f"{passed / valid:.2%}" if valid else "N/A"
            progress_file.parent.mkdir(parents=True, exist_ok=True)
            line = (
                f"{completed_at} | task={task_name} | model={model} | bench={bench} | "
                f"status={status} | cumulative_accuracy={accuracy} ({passed}/{valid})\n"
            )
            fd = os.open(progress_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
            try:
                os.write(fd, line.encode("utf-8"))
            finally:
                os.close(fd)
        seen.add(key)
        checkpoint.write_text(
            json.dumps({"schema_version": 1, "seen": sorted(seen)}, indent=2) + "\n",
            encoding="utf-8",
        )
        return True
