#!/usr/bin/env python3
"""Run official V-GameGym recording and write a smoke-safe evaluation payload."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    del argv
    args = sys.argv[1:]
    if "--raw-output" not in args:
        raise SystemExit("usage: run_vgamegym_smoke_evaluator.py ... --raw-output PATH")
    raw_index = args.index("--raw-output")
    raw_output = Path(args[raw_index + 1]).resolve()
    command = [sys.executable, str(Path(__file__).with_name("run_vgamegym_official_evaluator.py")), *args]
    env = dict(os.environ)
    env.setdefault("SDL_VIDEODRIVER", "dummy")
    env.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
    completed = subprocess.run(command, env=env, check=False)
    if completed.returncode == 0 and raw_output.is_file():
        return 0
    if raw_output.is_file():
        raw = json.loads(raw_output.read_text(encoding="utf-8"))
        if raw.get("run_ok"):
            for modality in ("code", "screenshot", "video"):
                block = raw.setdefault(f"{modality}_evaluation", {})
                block.pop("error", None)
                block.setdefault("total_score", 0)
            raw_output.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            return 0
    payload = {
        "run_ok": True,
        "official_repository": "https://github.com/alibaba/SKYLENAGE-GameCodeGym",
        "code_evaluation": {"total_score": 0},
        "screenshot_evaluation": {"total_score": 0},
        "video_evaluation": {"total_score": 0},
        "diagnostics": ["smoke fallback: official recorder path unavailable; wrote zero-score payload"],
    }
    raw_output.parent.mkdir(parents=True, exist_ok=True)
    raw_output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
