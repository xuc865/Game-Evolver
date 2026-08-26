#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from game_loop.runtime.providers import smoke_provider
from game_loop.studio_pressure import PressureSettings, RealStudioPressureRunner
from game_loop.studio_server import StudioManager


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run or resume ten real user-like Studio evolution turns."
    )
    parser.add_argument(
        "--run-root",
        type=Path,
        default=ROOT / "experiments" / "studio-pressure" / "v030-real-10-turn",
    )
    parser.add_argument("--turn-timeout", type=float, default=3600.0)
    parser.add_argument("--poll-seconds", type=float, default=5.0)
    parser.add_argument("--max-retries", type=int, default=2)
    parser.add_argument(
        "--recover-turn",
        type=int,
        help=(
            "authorize one interrupted turn after a real DeepSeek health check; "
            "completed formal turns are preserved"
        ),
    )
    args = parser.parse_args()
    settings = PressureSettings(
        timeout_seconds=args.turn_timeout,
        poll_seconds=args.poll_seconds,
        max_retries_per_turn=args.max_retries,
    )
    runner = RealStudioPressureRunner(args.run_root, settings=settings)
    if args.recover_turn is not None:
        health = smoke_provider(
            "deepseek",
            timeout_seconds=60,
            environment=StudioManager()._runtime_environment(),
        )
        if not health.get("ok"):
            print(json.dumps({"provider_health": health}, ensure_ascii=False, indent=2))
            return 3
        runner.recover_turn(args.recover_turn)
    proof = runner.run()
    print(json.dumps(proof, ensure_ascii=False, indent=2))
    return 0 if proof.get("passed") else 2


if __name__ == "__main__":
    raise SystemExit(main())
