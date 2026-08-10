#!/usr/bin/env python3
"""Clear a formal VGameGym provider circuit breaker after a real probe."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from game_loop.runtime.providers import smoke_provider


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--block-file", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=int, default=30)
    args = parser.parse_args()
    result = smoke_provider(args.model, timeout_seconds=args.timeout_seconds)
    if not result.get("ok"):
        return 1
    args.block_file.resolve().unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
