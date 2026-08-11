#!/usr/bin/env python3
"""Run one public verifier while holding the shared local judge lock."""

from __future__ import annotations

import fcntl
import subprocess
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: with_judge_lock.py LOCK_PATH COMMAND [ARG ...]", file=sys.stderr)
        return 2
    lock_path = Path(sys.argv[1])
    command = sys.argv[2:]
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        return subprocess.call(command)


if __name__ == "__main__":
    raise SystemExit(main())
