#!/usr/bin/env python3
"""Launch isolated Kimi L0-L3 evolution, then evaluate each champion publicly."""

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


def level_run_dir(level: str) -> Path:
    return RUN_ROOT / f"gcbench-ablation-kimi-{level.lower()}-5epoch-v2"


def screen_name(level: str) -> str:
    return f"gcbench-ablation-kimi-{level.lower()}-5epoch-v2"


def _write(path: Path, content: str, *, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    if executable:
        path.chmod(0o755)


def prepare_level(level: str) -> Path:
    run_dir = level_run_dir(level)
    run_dir.mkdir(parents=True, exist_ok=True)
    config = (CONFIG_ROOT / f"gcbench-{level}_ablation_kimi.json").resolve()
    if not config.is_file():
        raise FileNotFoundError(config)
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
export CODEX_API_BASE=http://29.116.237.135:8080/v1
export CODEX_MODEL=Kimi-K2.7-Code
export CODEX_API_KEY="${{CODEX_API_KEY:-EMPTY}}"
export GAME_LOOP_BACKBONE_PROVIDER=kimi
export GAME_LOOP_LLM_HARNESS_PROPOSER=1
export GAME_LOOP_HARNESS_PROPOSER_TIMEOUT_SECONDS=90
export GAME_LOOP_HARNESS_PROPOSER_ATTEMPTS=2
export GAME_LOOP_MAX_EPOCH_RETRIES=2
export GAME_LOOP_CHAT_MAX_TURNS=45
export GAME_LOOP_TARGET_TURNS=30
export GAME_LOOP_TEXT_ONLY=1
export GAME_LOOP_REQUIRE_GCB_DEMOS=1
if [[ ! -f "$RUN_DIR/harness_archive/champion.json" ]]; then
  python3 -m game_loop.cli harness-outer-init --outer-dir "$RUN_DIR" --config "$CONFIG"
fi
python3 -m game_loop.cli harness-self-supervise \
  --outer-dir "$RUN_DIR" --config "$CONFIG" \
  --task-source {str(TASK)!r} --seed-artifact {str(SEED)!r} \
  --fixed-admission-task-pool {str(POOL)!r} --evaluate-seed \
  --start-epoch 1 --max-epochs 5 --cases 3 --max-epoch-retries 2 \
  --run-id-prefix "abl-{level.lower()}" --heartbeat-seconds 30
champion_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["harness_id"])' "$RUN_DIR/harness_archive/champion.json")"
profile="$RUN_DIR/harness_archive/profiles/$champion_id.json"
mkdir -p "$RUN_DIR/public_eval"
python3 -m game_loop.cli harness-eval-public \
  --config "$CONFIG" --harness-profile "$profile" \
  --task-source {str(TASK)!r} --seed-artifact {str(SEED)!r} \
  --run-dir "$RUN_DIR/public_eval" --run-id-prefix "abl-{level.lower()}-public"
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
    for level in LEVELS:
        run_dir = prepare_level(level)
        if sys.platform == "darwin" and Path("/usr/bin/screen").is_file():
            sessions = subprocess.run(
                ["/usr/bin/screen", "-ls"],
                capture_output=True,
                text=True,
                check=False,
            ).stdout
            if f".{screen_name(level)}" in sessions:
                continue
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
            subprocess.run(
                ["bash", str(run_dir / "watchdog.sh")],
                cwd=ROOT,
                check=True,
            )


def status() -> dict[str, object]:
    levels: dict[str, object] = {}
    for level in LEVELS:
        run_dir = level_run_dir(level)
        epochs_path = run_dir / "harness_archive" / "epochs.json"
        failures_path = run_dir / "epoch_failures.json"
        items = json.loads(epochs_path.read_text()).get("items", []) if epochs_path.is_file() else []
        failures = (
            json.loads(failures_path.read_text()).get("items", [])
            if failures_path.is_file()
            else []
        )
        heartbeat = (
            json.loads((run_dir / ".supervisor_heartbeat.json").read_text())
            if (run_dir / ".supervisor_heartbeat.json").is_file()
            else {}
        )
        levels[level] = {
            "completed_epochs": len(items),
            "decisions": ["ACCEPT" if item.get("accepted") else "REJECT" for item in items],
            "failed_infra": [item.get("epoch") for item in failures],
            "heartbeat": heartbeat,
            "public_eval_complete": (run_dir / "public_eval" / "public_eval.json").is_file(),
            "pipeline_done": (run_dir / "pipeline.done").is_file(),
        }
    return {
        "run_pattern": str(RUN_ROOT / "gcbench-ablation-kimi-l[0-3]-5epoch-v2"),
        "model": "Kimi-K2.7-Code",
        "levels": levels,
    }


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
