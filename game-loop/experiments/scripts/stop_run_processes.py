#!/usr/bin/env python3
"""Stop every process that belongs to one explicit experiment run directory.

Unlike a pidfile-only stop, this also finds orphaned supervisors/workers left by
older launcher versions.  Matching requires both the exact absolute run path
and a known experiment role, so unrelated Python or shell processes are never
selected.
"""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RUNS = (ROOT / "experiments" / "runs").resolve()
ROLE_MARKERS = (
    "watchdog.sh",
    "start_supervisor.sh",
    "harness-self-supervise",
    "run_gcbench_l4_backend.sh",
    "game_loop.chat_agent",
    "gamecraft_bench.verifier",
)


def _process_table() -> dict[int, tuple[int, str]]:
    completed = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,command="],
        check=True,
        text=True,
        capture_output=True,
    )
    result: dict[int, tuple[int, str]] = {}
    for line in completed.stdout.splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) == 3 and fields[0].isdigit() and fields[1].isdigit():
            result[int(fields[0])] = (int(fields[1]), fields[2])
    return result


def matching_process_tree(
    run_dir: Path,
    table: dict[int, tuple[int, str]] | None = None,
) -> list[int]:
    table = _process_table() if table is None else table
    marker = str(run_dir.resolve())
    excluded = {os.getpid(), os.getppid()}
    roots = {
        pid
        for pid, (_ppid, command) in table.items()
        if pid not in excluded
        and marker in command
        and any(role in command for role in ROLE_MARKERS)
    }
    owned = set(roots)
    changed = True
    while changed:
        changed = False
        for pid, (ppid, _command) in table.items():
            if ppid in owned and pid not in owned and pid not in excluded:
                owned.add(pid)
                changed = True

    def depth(pid: int) -> int:
        value = 0
        current = pid
        while current in table and table[current][0] in owned:
            value += 1
            current = table[current][0]
        return value

    return sorted(owned, key=depth, reverse=True)


def stop_run(run_dir: Path, *, timeout_seconds: float = 15.0) -> list[int]:
    run_dir = run_dir.resolve()
    if run_dir.parent != RUNS or not run_dir.name.startswith("gcbench-"):
        raise ValueError(f"refusing unsafe run directory: {run_dir}")
    targets = matching_process_tree(run_dir)
    for pid in targets:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        remaining = [pid for pid in targets if _alive(pid)]
        if not remaining:
            break
        time.sleep(0.2)
    for pid in targets:
        if _alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    for name in ("daemon.pid", "watchdog.pid", "supervisor.pid", ".supervisor.pid"):
        (run_dir / name).unlink(missing_ok=True)
    return targets


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (ProcessLookupError, OSError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", type=Path, required=True)
    args = parser.parse_args()
    stopped = stop_run(args.run_dir)
    print(f"[stop-run] stopped {len(stopped)} matching processes for {args.run_dir.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
