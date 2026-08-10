#!/usr/bin/env python3
"""Reap only stale VGameGym generation processes.

Workers can outlive their Node bridge when the bridge spawns a detached CLI.
This process-level guard keeps one bad task from holding a formal shard forever.
It never scans or kills processes outside the VGameGym output root.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import shutil
import subprocess
import time
import re
from datetime import datetime
from pathlib import Path


def _elapsed_seconds(value: str) -> int:
    parts = [int(item) for item in value.strip().split(":")]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return parts[0]


def _processes(output_root: Path) -> list[tuple[int, int, str]]:
    value = subprocess.check_output(["ps", "-axo", "pid=,etime=,command="], text=True)
    marker = str(output_root.resolve())
    rows: list[tuple[int, int, str]] = []
    for line in value.splitlines():
        line = line.strip()
        if marker not in line:
            continue
        try:
            pid_text, elapsed_text, command = line.split(None, 2)
            rows.append((int(pid_text), _elapsed_seconds(elapsed_text), command))
        except (ValueError, IndexError):
            continue
    return rows


def _owned_processes(output_root: Path, kind: str) -> list[tuple[int, int, str]]:
    rows = _processes(output_root)
    return [row for row in rows if kind in row[2]]


def _kill_tree(pid: int) -> None:
    try:
        descendants = subprocess.check_output(["pgrep", "-P", str(pid)], text=True).split()
    except subprocess.CalledProcessError:
        descendants = []
    for child in descendants:
        _kill_tree(int(child))
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    time.sleep(0.2)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _task_from_command(command: str, root: Path) -> Path | None:
    marker = f"{root}/"
    start = command.find(marker)
    if start < 0:
        return None
    suffix = command[start + len(marker):]
    parts = suffix.split("/")
    if len(parts) < 3 or not parts[1].startswith("task_"):
        return None
    return root / parts[0] / parts[1]


def _bridge_tasks(root: Path) -> set[Path]:
    return {
        task
        for _, _, command in _owned_processes(root, "opengame_bridge.mjs")
        if (task := _task_from_command(command, root)) is not None
    }


def _evaluator_tasks(root: Path) -> set[Path]:
    return {
        task
        for _, _, command in _owned_processes(root, "run_vgamegym_official_evaluator.py")
        if (task := _task_from_command(command, root)) is not None
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=int, default=1500)
    args = parser.parse_args()
    root = args.output_root.resolve()
    now = time.time()
    running: dict[str, float] = {}
    running_status: dict[Path, Path] = {}
    for path in root.glob("*/task_*/status.json"):
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if value.get("status") == "running":
                started = value.get("started_at")
                if started:
                    task = path.parent.resolve()
                    running[str(task)] = now - datetime.fromisoformat(started).timestamp()
                    running_status[task] = path
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
    stale_tasks: set[Path] = set()
    for pid, process_age, command in _owned_processes(root, "opengame_bridge.mjs"):
        match = re.search(r"(/[^ ]+/experiments/vgamegym-full-awesome/[^/]+/task_[^/]+)/generation/", command)
        task_root = str(Path(match.group(1)).resolve()) if match else ""
        age = running.get(task_root)
        if process_age > args.timeout_seconds or (age is not None and age > args.timeout_seconds):
            _kill_tree(pid)
            if task_root:
                stale_tasks.add(Path(task_root))

    # The official evaluator can stall inside a visual-judge request after
    # generation has already completed. Reap only evaluator processes under
    # this benchmark root so the worker can record an infrastructure failure
    # and move on to its configured retry.
    for pid, process_age, command in _owned_processes(root, "run_vgamegym_official_evaluator.py"):
        match = re.search(r"(/[^ ]+/experiments/vgamegym-full-awesome/[^/]+/task_[^/]+)/", command)
        task_root = str(Path(match.group(1)).resolve()) if match else ""
        age = running.get(task_root)
        # Evaluator age is authoritative. The task status timestamp can be
        # from generation, so using it here would kill a freshly started
        # evaluator for an already-generated artifact.
        if process_age > args.timeout_seconds:
            _kill_tree(pid)
            if task_root:
                stale_tasks.add(Path(task_root))

    # A bridge may already have disappeared while its worker still holds the
    # task lock. Requeue only stale tasks in this benchmark's own output root;
    # no other experiment can be affected by this recovery path.
    bridge_tasks = _bridge_tasks(root)
    evaluator_tasks = _evaluator_tasks(root)
    for task, status_path in running_status.items():
        age = running.get(str(task), 0)
        if age <= args.timeout_seconds or task in bridge_tasks or task in evaluator_tasks:
            continue
        lock = task / ".worker.lock"
        owner = lock / "owner.json"
        try:
            owner_pid = int(json.loads(owner.read_text(encoding="utf-8")).get("pid", 0))
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            owner_pid = 0
        # The worker may still be waiting for a child we just reaped. Let it
        # observe the child exit and finalize the task itself; removing its
        # lock here could cause duplicate work in the same shard.
        if _pid_alive(owner_pid):
            continue
        if lock.is_dir():
            shutil.rmtree(lock, ignore_errors=True)
        value = json.loads(status_path.read_text(encoding="utf-8"))
        artifact_exists = any(
            path.is_file()
            for path in (task / "generation" / "workspace").rglob("*.py")
        ) if (task / "generation" / "workspace").is_dir() else False
        value.update({
            "status": "evaluator_infrastructure_failure" if artifact_exists else "generation_failed",
            "generation_status": "generated" if artifact_exists else "generation_failed",
            "reaped": True,
            "reaped_reason": (
                f"stale VGameGym evaluator exceeded {args.timeout_seconds}s"
                if artifact_exists else
                f"stale VGameGym generation exceeded {args.timeout_seconds}s"
            ),
            "updated_at": datetime.now().astimezone().isoformat(),
        })
        status_path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
