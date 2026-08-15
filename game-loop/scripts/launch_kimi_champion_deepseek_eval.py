#!/usr/bin/env python3
"""Prepare and run frozen Kimi champions with the DeepSeek backbone."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUN_ROOT = ROOT / "experiments" / "runs"
CONFIG_ROOT = ROOT / "experiments" / "configs-ablation"
TASK = ROOT.parent / "gcbench" / "tasks" / "puzzle-sokoban-dungeon"
SEED = ROOT / "experiments" / "seed_artifacts" / "puzzle-sokoban-scaffold"
LEVELS = ("L0", "L1", "L2", "L3")
MODEL = "deepseek-v4-flash"
API_BASE = "https://api.deepseek.com"


def level_run_dir(level: str) -> Path:
    return RUN_ROOT / f"gcbench-ablation-kimi-{level.lower()}-5epoch-v2"


def control_dir(level: str) -> Path:
    return level_run_dir(level) / "public_eval_deepseek_control"


def _write(path: Path, content: str, *, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    if executable:
        path.chmod(0o755)


def prepare_level(level: str) -> Path:
    run_dir = level_run_dir(level)
    champion_path = run_dir / "harness_archive" / "champion.json"
    champion_id = json.loads(champion_path.read_text(encoding="utf-8"))["harness_id"]
    source = CONFIG_ROOT / f"gcbench-{level}_ablation_kimi.json"
    payload = json.loads(source.read_text(encoding="utf-8"))
    backend = payload["backend"]
    backend["timeout_seconds"] = 2400
    backend["inactivity_timeout_seconds"] = 600
    backend["env"] = {
        "CODEX_API_BASE": API_BASE,
        "CODEX_MODEL": MODEL,
        "CODEX_LLM_SERVICE": "openai",
        "CODEX_MULTIMODAL": "false",
        "GAME_LOOP_BACKBONE_PROVIDER": "deepseek",
        "GAME_LOOP_CHAT_MAX_TURNS": "45",
        "GAME_LOOP_CHAT_MAX_OUTPUT_TOKENS": "8192",
        "GAME_LOOP_CHAT_API_MAX_RETRIES": "4",
        "GAME_LOOP_CHAT_API_TIMEOUT_SECONDS": "180",
        "GAME_LOOP_CHAT_API_TOTAL_TIMEOUT_SECONDS": "600",
        "GAME_LOOP_CHAT_FALLBACK_API_BASE": "https://openrouter.ai/api/v1",
        "GAME_LOOP_CHAT_FALLBACK_MODEL": "deepseek/deepseek-v4-flash",
        "GAME_LOOP_CHAT_FALLBACK_API_KEY_ENV": "OPENROUTER_API_KEY",
        "GAME_LOOP_CHAT_TEMPERATURE": "0",
        "GAME_LOOP_TOOL_READ_MAX_CHARS": "2500",
        "GAME_LOOP_TOOL_STDOUT_MAX_CHARS": "2500",
        "GAME_LOOP_TOOL_STDERR_MAX_CHARS": "1200",
        "GAME_LOOP_REQUIRE_GCB_DEMOS": "1",
        "GAME_LOOP_TEXT_ONLY": "1",
    }
    output = control_dir(level)
    config = output / "config.deepseek.json"
    _write(config, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    _write(output / "champion.txt", champion_id + "\n")
    return config


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("prepare",), nargs="?", default="prepare")
    parser.add_argument("level", choices=LEVELS, nargs="?")
    args = parser.parse_args()
    levels = (args.level,) if args.level else LEVELS
    for level in levels:
        print(prepare_level(level))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
