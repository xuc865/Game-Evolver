#!/usr/bin/env python3
"""Evaluate frozen Kimi-ablation champions with the GLM backbone."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUN_ROOT = ROOT / "experiments" / "runs"
CONFIG_ROOT = ROOT / "experiments" / "configs-ablation"
TASK = ROOT.parent / "gcbench" / "tasks" / "puzzle-sokoban-dungeon"
SEED = ROOT / "experiments" / "seed_artifacts" / "puzzle-sokoban-scaffold"
LEVELS = ("L0", "L1", "L2", "L3")
API_BASE = "http://11.213.4.72:80/v1"
MODEL = "GLM-5.2-W4AFP8"
MAX_INFRA_ATTEMPTS = 6


def level_run_dir(level: str) -> Path:
    return RUN_ROOT / f"gcbench-ablation-kimi-{level.lower()}-5epoch-v2"


def control_dir(level: str) -> Path:
    return level_run_dir(level) / "public_eval_glm_control"


def result_dir(level: str) -> Path:
    return level_run_dir(level) / "public_eval_glm"


def screen_name(level: str) -> str:
    return f"gcbench-kimi-{level.lower()}-champion-glm-eval"


def _write(path: Path, content: str, *, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    if executable:
        path.chmod(0o755)


def prepare_level(level: str) -> None:
    run_dir = level_run_dir(level)
    champion_path = run_dir / "harness_archive" / "champion.json"
    champion_id = json.loads(champion_path.read_text(encoding="utf-8"))["harness_id"]
    profile = run_dir / "harness_archive" / "profiles" / f"{champion_id}.json"
    if not profile.is_file():
        raise FileNotFoundError(profile)

    payload = json.loads(
        (CONFIG_ROOT / f"gcbench-{level}_ablation_kimi.json").read_text(encoding="utf-8")
    )
    backend = payload["backend"]
    backend["timeout_seconds"] = 2400
    backend["inactivity_timeout_seconds"] = 420
    backend["env"] = {
        "CODEX_API_BASE": API_BASE,
        "CODEX_MODEL": MODEL,
        "CODEX_LLM_SERVICE": "openai",
        "CODEX_MULTIMODAL": "false",
        "CODEX_CACHE_KEY_HEADER": "X-Cache-Key",
        "CODEX_CACHE_KEY_MODE": "random",
        "GAME_LOOP_BACKBONE_PROVIDER": "glm",
        "GAME_LOOP_CHAT_MAX_TURNS": "45",
        "GAME_LOOP_CHAT_MAX_OUTPUT_TOKENS": "8192",
        "GAME_LOOP_CHAT_API_MAX_RETRIES": "4",
        "GAME_LOOP_CHAT_API_TIMEOUT_SECONDS": "60",
        "GAME_LOOP_CHAT_API_TOTAL_TIMEOUT_SECONDS": "300",
        "GAME_LOOP_CHAT_TEMPERATURE": "0",
        "GAME_LOOP_TEXT_ONLY": "1",
        "GAME_LOOP_REQUIRE_GCB_DEMOS": "1",
    }

    ctl = control_dir(level)
    results = result_dir(level)
    ctl.mkdir(parents=True, exist_ok=True)
    results.mkdir(parents=True, exist_ok=True)
    config = ctl / "config.glm.json"
    _write(config, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

    _write(
        ctl / "run_eval.sh",
        f"""#!/usr/bin/env bash
set -euo pipefail
ROOT={str(ROOT)!r}
CONTROL={str(ctl)!r}
RESULTS={str(results)!r}
CONFIG={str(config)!r}
PROFILE={str(profile)!r}
cd "$ROOT"
set -a
[[ ! -f "$ROOT/.env.local" ]] || source "$ROOT/.env.local"
[[ ! -f "$ROOT/experiments/.env" ]] || source "$ROOT/experiments/.env"
set +a
export PYTHONPATH="$ROOT"
export PYTHONUNBUFFERED=1
export CODEX_API_BASE={API_BASE!r}
export CODEX_MODEL={MODEL!r}
export CODEX_API_KEY="${{CODEX_API_KEY:-EMPTY}}"
export CODEX_LLM_SERVICE=openai
export CODEX_MULTIMODAL=false
export CODEX_CACHE_KEY_HEADER=X-Cache-Key
export CODEX_CACHE_KEY_MODE=random
unset CODEX_CACHE_KEY
export GAME_LOOP_BACKBONE_PROVIDER=glm
for attempt in $(seq 1 {MAX_INFRA_ATTEMPTS}); do
  attempt_dir="$RESULTS/attempt_$(printf '%03d' "$attempt")"
  result="$attempt_dir/public_eval.json"
  if [[ -f "$result" ]]; then
    if python3 -c 'import json,sys; raise SystemExit(0 if json.load(open(sys.argv[1])).get("infrastructure_ok") else 1)' "$result"; then
      cp "$result" "$RESULTS/public_eval.json"
      touch "$CONTROL/eval.done"
      exit 0
    fi
    continue
  fi
  mkdir -p "$attempt_dir"
  echo "[glm-eval] level={level} champion={champion_id} attempt=$attempt" 
  python3 -m game_loop.cli harness-eval-public \
    --config "$CONFIG" --harness-profile "$PROFILE" \
    --task-source {str(TASK)!r} --seed-artifact {str(SEED)!r} \
    --run-dir "$attempt_dir" --run-id-prefix "kimi-{level.lower()}-champion-glm"
  if [[ -f "$result" ]] && python3 -c 'import json,sys; raise SystemExit(0 if json.load(open(sys.argv[1])).get("infrastructure_ok") else 1)' "$result"; then
    cp "$result" "$RESULTS/public_eval.json"
    touch "$CONTROL/eval.done"
    exit 0
  fi
done
touch "$CONTROL/eval.exhausted"
exit 1
""",
        executable=True,
    )
    _write(
        ctl / "watchdog.sh",
        f"""#!/usr/bin/env bash
set -euo pipefail
CONTROL={str(ctl)!r}
while [[ ! -f "$CONTROL/eval.done" && ! -f "$CONTROL/eval.exhausted" ]]; do
  bash "$CONTROL/run_eval.sh" >> "$CONTROL/eval.log" 2>&1 || true
  sleep 30
done
""",
        executable=True,
    )


def launch() -> None:
    sessions = ""
    if sys.platform == "darwin" and Path("/usr/bin/screen").is_file():
        sessions = subprocess.run(
            ["/usr/bin/screen", "-ls"], capture_output=True, text=True, check=False
        ).stdout
    for level in LEVELS:
        prepare_level(level)
        if (control_dir(level) / "eval.done").is_file():
            continue
        if sessions and f".{screen_name(level)}" in sessions:
            continue
        subprocess.run(
            [
                "/usr/bin/screen",
                "-dmS",
                screen_name(level),
                "/bin/bash",
                str(control_dir(level) / "watchdog.sh"),
            ],
            cwd=ROOT,
            check=True,
        )


def status() -> dict[str, object]:
    levels: dict[str, object] = {}
    for level in LEVELS:
        run_dir = level_run_dir(level)
        champion_id = json.loads(
            (run_dir / "harness_archive" / "champion.json").read_text(encoding="utf-8")
        )["harness_id"]
        attempts = sorted(
            path for path in result_dir(level).glob("attempt_*") if path.is_dir()
        )
        completed = []
        for attempt in attempts:
            result = attempt / "public_eval.json"
            if result.is_file():
                payload = json.loads(result.read_text(encoding="utf-8"))
                completed.append(
                    {
                        "attempt": attempt.name,
                        "official_score": payload.get("official_score"),
                        "infrastructure_ok": payload.get("infrastructure_ok"),
                    }
                )
        levels[level] = {
            "champion_harness_id": champion_id,
            "attempts": completed,
            "current_attempt": (
                None
                if (control_dir(level) / "eval.done").is_file()
                else (attempts[-1].name if attempts else None)
            ),
            "complete": (control_dir(level) / "eval.done").is_file(),
            "exhausted": (control_dir(level) / "eval.exhausted").is_file(),
            "result": str(result_dir(level) / "public_eval.json"),
        }
    return {"model": MODEL, "base_url": API_BASE, "levels": levels}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("launch", "status"), nargs="?", default="status")
    args = parser.parse_args()
    if args.command == "launch":
        launch()
    print(json.dumps(status(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
