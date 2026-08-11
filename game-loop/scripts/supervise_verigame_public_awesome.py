#!/usr/bin/env python3
"""Keep the four VeriGame public-test workers attached to one supervisor."""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


PROVIDERS = ("kimi", "qwen", "glm", "deepseek")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--log-root", type=Path, required=True)
    parser.add_argument("--generation-timeout", type=int, default=1800)
    parser.add_argument("--evaluation-timeout", type=int, default=14400)
    parser.add_argument("--only-keypoints", default="")
    parser.add_argument("--provider", action="append", choices=PROVIDERS)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    args.log_root.mkdir(parents=True, exist_ok=True)
    children: list[subprocess.Popen] = []

    def stop(_signum, _frame):
        for child in children:
            if child.poll() is None:
                child.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    for provider in args.provider or PROVIDERS:
        log = (args.log_root / f"verigame-public-awesome-{provider}.log").open("a", encoding="utf-8")
        child = subprocess.Popen(
            [
                sys.executable,
                "-u",
                str(root / "scripts" / "run_verigame_public_awesome.py"),
                "--provider",
                provider,
                "--output-root",
                str(args.output_root.resolve()),
                "--generation-timeout",
                str(args.generation_timeout),
                "--evaluation-timeout",
                str(args.evaluation_timeout),
                *(["--only-keypoints", args.only_keypoints] if args.only_keypoints else []),
            ],
            cwd=root,
            stdout=log,
            stderr=subprocess.STDOUT,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        children.append(child)
        print(f"{provider} pid={child.pid}", flush=True)
    (args.output_root / "supervisor.pid").parent.mkdir(parents=True, exist_ok=True)
    (args.output_root / "supervisor.pid").write_text(f"{os.getpid()}\n", encoding="utf-8")
    exit_codes: list[int] = []
    while children:
        for child in list(children):
            return_code = child.poll()
            if return_code is not None:
                exit_codes.append(return_code)
                children.remove(child)
        if children:
            time.sleep(5)
    return 0 if all(code == 0 for code in exit_codes) else 1


if __name__ == "__main__":
    raise SystemExit(main())
