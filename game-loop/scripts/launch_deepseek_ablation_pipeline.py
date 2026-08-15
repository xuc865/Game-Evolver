#!/usr/bin/env python3
"""Launch isolated DeepSeek L0-L3 harness ablations and final public evaluations."""

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
POOL = ROOT / "experiments" / "fixed-admission-gcbench-balanced.json"
LEVELS = ("L0", "L1", "L2", "L3")
TARGET_EPOCHS = 30
MODEL = "deepseek-v4-flash"
API_BASE = "https://api.deepseek.com"


def level_run_dir(level: str) -> Path:
    return RUN_ROOT / f"gcbench-ablation-deepseek-{level.lower()}-30epoch-v2"


def screen_name(level: str) -> str:
    return f"gcbench-ablation-deepseek-{level.lower()}-30epoch-v2"


def _write(path: Path, content: str, *, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    if executable:
        path.chmod(0o755)


def prepare_config(level: str, run_dir: Path) -> Path:
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
        "GAME_LOOP_LLM_HARNESS_PROPOSER": "1",
        "GAME_LOOP_HARNESS_PROPOSER_TIMEOUT_SECONDS": "120",
        "GAME_LOOP_HARNESS_PROPOSER_ATTEMPTS": "4",
        "GAME_LOOP_TEXT_ONLY": "1",
    }
    config = run_dir / "config.deepseek.json"
    _write(config, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    return config


def prepare_level(level: str) -> Path:
    run_dir = level_run_dir(level)
    run_dir.mkdir(parents=True, exist_ok=True)
    config = prepare_config(level, run_dir)
    _write(
        run_dir / "start_supervisor.sh",
        f"""#!/usr/bin/env bash
set -euo pipefail
ROOT={str(ROOT)!r}
RUN_DIR={str(run_dir)!r}
CONFIG={str(config)!r}
if [[ "${{1:-}}" != "--foreground" ]]; then
  if [[ -f "$RUN_DIR/pipeline.pid" ]] && kill -0 "$(cat "$RUN_DIR/pipeline.pid")" 2>/dev/null; then
    exit 0
  fi
  nohup bash "$0" --foreground >> "$RUN_DIR/pipeline.log" 2>&1 < /dev/null &
  echo $! > "$RUN_DIR/pipeline.pid"
  exit 0
fi
cd "$ROOT"
set -a
[[ ! -f "$ROOT/.env.local" ]] || source "$ROOT/.env.local"
[[ ! -f "$ROOT/experiments/.env" ]] || source "$ROOT/experiments/.env"
set +a
export PYTHONPATH="$ROOT"
export PYTHONUNBUFFERED=1
export CODEX_API_BASE={API_BASE!r}
export CODEX_MODEL={MODEL!r}
export CODEX_API_KEY="${{DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY is required}}"
export CODEX_LLM_SERVICE=openai
export CODEX_MULTIMODAL=false
unset CODEX_CACHE_KEY CODEX_CACHE_KEY_HEADER CODEX_CACHE_KEY_MODE
export GAME_LOOP_BACKBONE_PROVIDER=deepseek
export GAME_LOOP_LLM_HARNESS_PROPOSER=1
export GAME_LOOP_HARNESS_PROPOSER_TIMEOUT_SECONDS=120
export GAME_LOOP_HARNESS_PROPOSER_ATTEMPTS=4
export GAME_LOOP_MAX_EPOCH_RETRIES=2
export GAME_LOOP_CHAT_MAX_TURNS=45
export GAME_LOOP_TARGET_TURNS=30
export GAME_LOOP_CHAT_MAX_OUTPUT_TOKENS=8192
export GAME_LOOP_CHAT_API_MAX_RETRIES=4
export GAME_LOOP_CHAT_API_TIMEOUT_SECONDS=180
export GAME_LOOP_CHAT_API_TOTAL_TIMEOUT_SECONDS=600
export GAME_LOOP_CHAT_FALLBACK_API_BASE=https://openrouter.ai/api/v1
export GAME_LOOP_CHAT_FALLBACK_MODEL=deepseek/deepseek-v4-flash
export GAME_LOOP_CHAT_FALLBACK_API_KEY_ENV=OPENROUTER_API_KEY
export GAME_LOOP_TEXT_ONLY=1
export GAME_LOOP_REQUIRE_GCB_DEMOS=1
if [[ ! -f "$RUN_DIR/harness_archive/champion.json" ]]; then
  python3 -m game_loop.cli harness-outer-init --outer-dir "$RUN_DIR" --config "$CONFIG"
fi
python3 -m game_loop.cli harness-self-supervise \
  --outer-dir "$RUN_DIR" --config "$CONFIG" \
  --task-source {str(TASK)!r} --seed-artifact {str(SEED)!r} \
  --fixed-admission-task-pool {str(POOL)!r} --evaluate-seed \
  --start-epoch 1 --max-epochs {TARGET_EPOCHS} --cases 3 --max-epoch-retries 2 \
  --run-id-prefix "abl-deepseek-{level.lower()}" --heartbeat-seconds 30
champion_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["harness_id"])' "$RUN_DIR/harness_archive/champion.json")"
profile="$RUN_DIR/harness_archive/profiles/$champion_id.json"
mkdir -p "$RUN_DIR/public_eval"
python3 -m game_loop.cli harness-eval-public \
  --config "$CONFIG" --harness-profile "$profile" \
  --task-source {str(TASK)!r} --seed-artifact {str(SEED)!r} \
  --run-dir "$RUN_DIR/public_eval" --run-id-prefix "abl-deepseek-{level.lower()}-public"
touch "$RUN_DIR/pipeline.done"
""",
        executable=True,
    )
    _write(
        run_dir / "watchdog.sh",
        f"""#!/usr/bin/env bash
set -euo pipefail
ROOT={str(ROOT)!r}
RUN_DIR={str(run_dir)!r}
if [[ "${{1:-}}" != "--foreground" ]]; then
  if [[ -f "$RUN_DIR/watchdog.pid" ]] && kill -0 "$(cat "$RUN_DIR/watchdog.pid")" 2>/dev/null; then
    exit 0
  fi
  nohup bash "$0" --foreground >> "$RUN_DIR/watchdog.log" 2>&1 < /dev/null &
  echo $! > "$RUN_DIR/watchdog.pid"
  exit 0
fi
cd "$ROOT"
while [[ ! -f "$RUN_DIR/pipeline.done" ]]; do
  python3 -m game_loop.experiment_watchdog \
    --run-dir "$RUN_DIR" --start-script "$RUN_DIR/start_supervisor.sh" \
    --status-json "$RUN_DIR/.watchdog_status.json" \
    --stale-heartbeat-seconds 900 || true
  sleep 30
done
""",
        executable=True,
    )
    return run_dir


def launch() -> None:
    RUN_ROOT.mkdir(parents=True, exist_ok=True)
    sessions = ""
    if sys.platform == "darwin" and Path("/usr/bin/screen").is_file():
        sessions = subprocess.run(
            ["/usr/bin/screen", "-ls"], capture_output=True, text=True, check=False
        ).stdout
    for level in LEVELS:
        run_dir = prepare_level(level)
        if (run_dir / "pipeline.done").is_file():
            continue
        if sessions and f".{screen_name(level)}" in sessions:
            continue
        if sys.platform == "darwin" and Path("/usr/bin/screen").is_file():
            subprocess.run(
                [
                    "/usr/bin/screen",
                    "-dmS",
                    screen_name(level),
                    "/bin/bash",
                    str(run_dir / "watchdog.sh"),
                    "--foreground",
                ],
                cwd=ROOT,
                check=True,
            )
        else:
            subprocess.run(["bash", str(run_dir / "watchdog.sh")], cwd=ROOT, check=True)


def status() -> dict[str, object]:
    levels: dict[str, object] = {}
    for level in LEVELS:
        run_dir = level_run_dir(level)
        epochs_path = run_dir / "harness_archive" / "epochs.json"
        failures_path = run_dir / "epoch_failures.json"
        items = json.loads(epochs_path.read_text()).get("items", []) if epochs_path.is_file() else []
        failures = json.loads(failures_path.read_text()).get("items", []) if failures_path.is_file() else []
        heartbeat_path = run_dir / ".supervisor_heartbeat.json"
        heartbeat = json.loads(heartbeat_path.read_text()) if heartbeat_path.is_file() else {}
        champion_path = run_dir / "harness_archive" / "champion.json"
        champion = json.loads(champion_path.read_text()).get("harness_id") if champion_path.is_file() else None
        levels[level] = {
            "completed_epochs": len(items),
            "decisions": ["ACCEPT" if item.get("accepted") else "REJECT" for item in items],
            "failed_infra": [item.get("epoch") for item in failures],
            "heartbeat": heartbeat,
            "champion_harness_id": champion,
            "public_eval_complete": (run_dir / "public_eval" / "public_eval.json").is_file(),
            "pipeline_done": (run_dir / "pipeline.done").is_file(),
        }
    return {
        "run_pattern": str(RUN_ROOT / "gcbench-ablation-deepseek-l[0-3]-30epoch-v2"),
        "target_epochs": TARGET_EPOCHS,
        "model": MODEL,
        "levels": levels,
    }


def candidate(level: str, epoch: int) -> dict[str, object]:
    run_dir = level_run_dir(level)
    epochs_path = run_dir / "harness_archive" / "epochs.json"
    items = json.loads(epochs_path.read_text()).get("items", [])
    item = next((value for value in items if value.get("epoch") == epoch), None)
    if item is None:
        raise SystemExit(f"no completed candidate for {level} epoch {epoch}")
    candidate_id = item["candidate_harness_id"]
    profile = run_dir / "harness_archive" / "profiles" / f"{candidate_id}.json"
    return {
        "level": level,
        "epoch": epoch,
        "accepted": bool(item.get("accepted")),
        "candidate_harness_id": candidate_id,
        "profile": str(profile),
        "profile_exists": profile.is_file(),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("launch", "status", "candidate"), nargs="?", default="status")
    parser.add_argument("level", choices=LEVELS, nargs="?")
    parser.add_argument("epoch", type=int, nargs="?")
    args = parser.parse_args()
    if args.command == "launch":
        launch()
    elif args.command == "candidate":
        if args.level is None or args.epoch is None:
            parser.error("candidate requires LEVEL and EPOCH")
        print(json.dumps(candidate(args.level, args.epoch), ensure_ascii=False, indent=2))
        return 0
    print(json.dumps(status(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
