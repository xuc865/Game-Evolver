#!/usr/bin/env python3
"""Run one public verifier while holding a shared local judge slot."""

from __future__ import annotations

import fcntl
import os
import subprocess
import sys
import time
from contextlib import ExitStack
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: with_judge_lock.py LOCK_PATH COMMAND [ARG ...]", file=sys.stderr)
        return 2
    lock_path = Path(sys.argv[1])
    command = sys.argv[2:]
    try:
        timeout = float(os.environ.get("GAMECRAFT_BENCH_JUDGE_LOCK_TIMEOUT_SECONDS", "900"))
    except ValueError:
        timeout = 900.0
    if timeout < 0:
        timeout = 0.0
    try:
        command_timeout = float(
            os.environ.get("GAMECRAFT_BENCH_JUDGE_COMMAND_TIMEOUT_SECONDS", "1200")
        )
    except ValueError:
        command_timeout = 1200.0
    if command_timeout < 1:
        command_timeout = 1.0
    try:
        concurrency = int(os.environ.get("GAMECRAFT_BENCH_JUDGE_CONCURRENCY", "1"))
    except ValueError:
        concurrency = 1
    concurrency = max(1, min(concurrency, 64))

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    # Slot zero deliberately remains the legacy lock path. Existing single-slot
    # processes therefore continue to count against the concurrency limit while
    # a deployment transitions to multiple slots.
    slot_paths = [lock_path]
    slot_paths.extend(Path(f"{lock_path}.slot-{index}") for index in range(1, concurrency))

    with ExitStack() as stack:
        lock_files = [stack.enter_context(path.open("a+")) for path in slot_paths]
        deadline = time.monotonic() + timeout
        first_slot = os.getpid() % concurrency
        selected_slot = None
        while True:
            for offset in range(concurrency):
                slot = (first_slot + offset) % concurrency
                try:
                    fcntl.flock(lock_files[slot].fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    continue
                selected_slot = slot
                break
            if selected_slot is not None:
                break
            if time.monotonic() >= deadline:
                print(
                    f"[judge-lock] timeout after {timeout:.0f}s waiting for "
                    f"one of {concurrency} slots: {lock_path}",
                    file=sys.stderr,
                )
                # The caller treats this as an infrastructure failure.
                return 75
            first_slot = (first_slot + 1) % concurrency
            time.sleep(min(0.2, max(0.05, deadline - time.monotonic())))
        print(
            f"[judge-lock] acquired slot {selected_slot + 1}/{concurrency}: "
            f"{slot_paths[selected_slot]}",
            file=sys.stderr,
        )
        try:
            return subprocess.run(command, timeout=command_timeout, check=False).returncode
        except subprocess.TimeoutExpired:
            print(
                f"[judge-lock] command timeout after {command_timeout:.0f}s",
                file=sys.stderr,
            )
            # The verifier's nonzero exit is translated by the caller into an
            # infrastructure failure; releasing the lock is essential so the
            # next formal admission can make progress.
            return 124


if __name__ == "__main__":
    raise SystemExit(main())
