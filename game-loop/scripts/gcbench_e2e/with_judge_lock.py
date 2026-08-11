#!/usr/bin/env python3
"""Run one public verifier while holding the shared local judge lock."""

from __future__ import annotations

import fcntl
import os
import subprocess
import sys
import time
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
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as lock_file:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    print(
                        f"[judge-lock] timeout after {timeout:.0f}s: {lock_path}",
                        file=sys.stderr,
                    )
                    # The caller treats this as an infrastructure failure.
                    return 75
                time.sleep(min(1.0, max(0.05, deadline - time.monotonic())))
        return subprocess.call(command)


if __name__ == "__main__":
    raise SystemExit(main())
