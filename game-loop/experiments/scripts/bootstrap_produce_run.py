#!/usr/bin/env python3
"""Bootstrap an isolated gcbench harness produce run directory."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNS = ROOT / "experiments" / "runs"
CONFIGS = ROOT / "experiments" / "configs-v4"
SEED = ROOT / "experiments" / "seed_artifacts" / "puzzle-sokoban-scaffold"

MODELS: dict[str, dict[str, str]] = {
    "deepseek": {
        "run_name": "gcbench-produce-deepseek",
        "config": "gcbench-L4_deepseek_v4_produce.json",
        "codex_api_base": "https://api.deepseek.com",
        "codex_model": "deepseek-v4-flash",
        "api_key_var": "DEEPSEEK_API_KEY",
        "api_key_required": "1",
        "max_output_tokens": "8192",
        "api_retries": "10",
        "api_timeout_seconds": "180",
        "tool_read_max_chars": "8000",
        "tool_stdout_max_chars": "8000",
        "tool_stderr_max_chars": "4000",
        "run_id_prefix": "gds",
    },
    "kimi": {
        "run_name": "gcbench-produce-kimi",
        "config": "gcbench-L4_kimi_produce.json",
        "codex_api_base": "http://29.116.237.135:8080/v1",
        "codex_model": "Kimi-K2.7-Code",
        "api_key_var": "CODEX_API_KEY",
        "api_key_required": "0",
        "max_output_tokens": "8192",
        "api_retries": "10",
        "api_timeout_seconds": "180",
        "tool_read_max_chars": "8000",
        "tool_stdout_max_chars": "8000",
        "tool_stderr_max_chars": "4000",
        "run_id_prefix": "gkm",
    },
    "qwen": {
        "run_name": "gcbench-produce-qwen",
        "config": "gcbench-L4_qwen3.6-27b_produce.json",
        "codex_api_base": "http://29.163.228.59:8080/v1",
        "codex_model": "Qwen3.6-27B",
        "api_key_var": "CODEX_API_KEY",
        "api_key_required": "0",
        "max_output_tokens": "512",
        "api_retries": "10",
        "api_timeout_seconds": "90",
        "tool_read_max_chars": "2500",
        "tool_stdout_max_chars": "2500",
        "tool_stderr_max_chars": "1200",
        "tool_call_history_content_chars": "128",
        "max_history_messages": "16",
        "stop_after_gcb_demos_turn": "45",
        "run_id_prefix": "gqw",
    },
    "glm": {
        "run_name": "gcbench-produce-glm",
        "config": "gcbench-L4_glm5.2_produce.json",
        "codex_api_base": "http://29.116.237.75:8080/v1",
        "codex_model": "GLM-5.2-W4AFP8-node1",
        "api_key_var": "CODEX_API_KEY",
        "api_key_required": "0",
        "max_output_tokens": "8192",
        "api_retries": "4",
        "api_timeout_seconds": "60",
        "tool_read_max_chars": "2500",
        "tool_stdout_max_chars": "2500",
        "tool_stderr_max_chars": "1200",
        "run_id_prefix": "ggl",
    },
}

def build_task_pool() -> list[dict[str, object]]:
    """Build the admission pool from every locally installed public GCB task.

    ``sample_task_pool`` deterministically draws three distinct entries per
    epoch, so harness admission measures cross-task behavior instead of replaying
    the same Sokoban task three times.
    """

    tasks_root = ROOT.parent / "gcbench" / "tasks"
    entries: list[dict[str, object]] = []
    for task_dir in sorted(tasks_root.iterdir() if tasks_root.is_dir() else ()):
        if task_dir.name == "example" or not task_dir.is_dir():
            continue
        if not (task_dir / "instruction.md").is_file():
            continue
        if not (task_dir / "tests" / "rubric.json").is_file():
            continue
        entries.append({
            "task_ref": f"../../../../gcbench/tasks/{task_dir.name}",
            "seed_artifact_ref": "../../seed_artifacts/puzzle-sokoban-scaffold",
            "seed_score": 0.0,
        })
    if len(entries) < 3:
        raise RuntimeError(
            f"GameCraftBench task pool requires at least 3 installed tasks; found {len(entries)}"
        )
    return entries


def _write_executable(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def ensure_produce_config(model_key: str, spec: dict[str, str]) -> Path:
    src_name = spec["config"].replace("_produce.json", ".json")
    src = CONFIGS / src_name
    if not src.is_file():
        raise FileNotFoundError(f"missing base config: {src}")
    dst = CONFIGS / spec["config"]
    cfg = json.loads(src.read_text(encoding="utf-8"))
    cfg["backend"]["timeout_seconds"] = 3600
    cfg["backend"].setdefault("env", {})
    cfg["backend"]["env"]["CODEX_API_BASE"] = spec["codex_api_base"]
    cfg["backend"]["env"]["CODEX_MODEL"] = spec["codex_model"]
    cfg["backend"]["env"]["GAME_LOOP_CHAT_MAX_TURNS"] = "60"
    cfg["backend"]["env"]["GAME_LOOP_CHAT_MAX_OUTPUT_TOKENS"] = spec["max_output_tokens"]
    cfg["backend"]["env"]["GAME_LOOP_CHAT_API_MAX_RETRIES"] = spec["api_retries"]
    cfg["backend"]["env"]["GAME_LOOP_CHAT_API_TIMEOUT_SECONDS"] = spec["api_timeout_seconds"]
    cfg["backend"]["env"]["GAME_LOOP_CHAT_TEMPERATURE"] = "0"
    cfg["backend"]["env"]["GAME_LOOP_TOOL_READ_MAX_CHARS"] = spec["tool_read_max_chars"]
    cfg["backend"]["env"]["GAME_LOOP_TOOL_STDOUT_MAX_CHARS"] = spec["tool_stdout_max_chars"]
    cfg["backend"]["env"]["GAME_LOOP_TOOL_STDERR_MAX_CHARS"] = spec["tool_stderr_max_chars"]
    if "tool_call_history_content_chars" in spec:
        cfg["backend"]["env"]["GAME_LOOP_TOOL_CALL_HISTORY_CONTENT_CHARS"] = spec["tool_call_history_content_chars"]
    if "max_history_messages" in spec:
        cfg["backend"]["env"]["GAME_LOOP_CHAT_MAX_HISTORY_MESSAGES"] = spec["max_history_messages"]
    if "stop_after_gcb_demos_turn" in spec:
        cfg["backend"]["env"]["GAME_LOOP_STOP_AFTER_GCB_DEMOS_TURN"] = spec["stop_after_gcb_demos_turn"]
    cfg["backend"]["env"]["GAME_LOOP_REQUIRE_GCB_DEMOS"] = "1"
    cfg["backend"]["env"]["GAME_LOOP_LLM_HARNESS_PROPOSER"] = "1"
    cfg["backend"]["env"]["GAME_LOOP_HARNESS_PROPOSER_TIMEOUT_SECONDS"] = "120"
    cfg["backend"]["env"]["GAME_LOOP_HARNESS_PROPOSER_ATTEMPTS"] = "4"
    text_only = os.environ.get("GAME_LOOP_TEXT_ONLY", "1").strip().lower() not in {
        "0", "false", "no", "off",
    }
    cfg["backend"]["env"]["GAME_LOOP_TEXT_ONLY"] = "1" if text_only else "0"
    if text_only:
        _disable_visual_harness(cfg)
    method = cfg.get("method", {})
    harness = method.get("harness_evolution", {}) if isinstance(method, dict) else {}
    if isinstance(harness, dict):
        harness["rubric_judge_timeout_seconds"] = 45
    cfg["evolution"] = {
        "max_generations": 3,
        "candidates_per_generation": 1,
        "max_model_calls": 3,
        "max_evaluator_queries": 3,
    }
    dst.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return dst


def _is_visual_entry(entry: dict[str, object]) -> bool:
    searchable = " ".join([
        str(entry.get("id", "")),
        str(entry.get("instruction", "")),
        str(entry.get("description", "")),
        " ".join(str(tag) for tag in entry.get("tags", []) if tag is not None),
    ]).casefold()
    return any(token in searchable for token in ("visual", "screenshot", "image", "video"))


def _disable_visual_harness(cfg: dict[str, object]) -> None:
    """Remove visual-only genome paths for text-only backbone experiments."""

    method = cfg.get("method", {})
    harness = method.get("harness_evolution", {}) if isinstance(method, dict) else {}
    if not isinstance(harness, dict):
        return
    modules = [item for item in harness.get("modules", []) if not _is_visual_entry(item)]
    interfaces = [item for item in harness.get("tool_interfaces", []) if not _is_visual_entry(item)]
    elements = [item for item in harness.get("element_catalog", []) if not _is_visual_entry(item)]
    module_ids = {str(item["id"]) for item in modules}
    interface_ids = {str(item["id"]) for item in interfaces}
    element_ids = {str(item["id"]) for item in elements}
    harness["modules"] = modules
    harness["tool_interfaces"] = interfaces
    harness["element_catalog"] = elements
    harness["seed_modules"] = [
        item for item in harness.get("seed_modules", []) if str(item) in module_ids
    ]
    harness["seed_tool_interfaces"] = [
        item for item in harness.get("seed_tool_interfaces", []) if str(item) in interface_ids
    ]
    seed_elements = harness.get("seed_elements", {})
    if isinstance(seed_elements, dict):
        harness["seed_elements"] = {
            str(category): [item for item in values if str(item) in element_ids]
            for category, values in seed_elements.items()
        }
    harness["max_active_modules"] = min(
        int(harness.get("max_active_modules", len(modules))), len(modules)
    )
    harness["max_active_tool_interfaces"] = min(
        int(harness.get("max_active_tool_interfaces", len(interfaces))), len(interfaces)
    )


def bootstrap(model_key: str, *, reset: bool = True) -> Path:
    spec = MODELS[model_key]
    run_dir = RUNS / spec["run_name"]
    config_path = ensure_produce_config(model_key, spec)

    if reset and run_dir.exists():
        backup = RUNS / f"{spec['run_name']}.bak-{__import__('datetime').datetime.now().strftime('%Y%m%d-%H%M%S')}"
        run_dir.rename(backup)
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "admission_runs").mkdir(exist_ok=True)

    (run_dir / "run.env").write_text(
        "\n".join(
            [
                f"RUN_NAME={spec['run_name']}",
                f"CONFIG={config_path}",
                f"CODEX_API_BASE={spec['codex_api_base']}",
                f"CODEX_MODEL={spec['codex_model']}",
                f"RUN_ID_PREFIX={spec['run_id_prefix']}",
                f"AGENT_API_KEY_VAR={spec['api_key_var']}",
                f"GAME_LOOP_AGENT_REQUIRES_API_KEY={spec['api_key_required']}",
                "GAME_LOOP_CHAT_MAX_TURNS=60",
                f"GAME_LOOP_CHAT_MAX_OUTPUT_TOKENS={spec['max_output_tokens']}",
                f"GAME_LOOP_CHAT_API_MAX_RETRIES={spec['api_retries']}",
                f"GAME_LOOP_CHAT_API_TIMEOUT_SECONDS={spec['api_timeout_seconds']}",
                "GAME_LOOP_CHAT_TEMPERATURE=0",
                f"GAME_LOOP_TOOL_READ_MAX_CHARS={spec['tool_read_max_chars']}",
                f"GAME_LOOP_TOOL_STDOUT_MAX_CHARS={spec['tool_stdout_max_chars']}",
                f"GAME_LOOP_TOOL_STDERR_MAX_CHARS={spec['tool_stderr_max_chars']}",
                *(
                    [f"GAME_LOOP_TOOL_CALL_HISTORY_CONTENT_CHARS={spec['tool_call_history_content_chars']}"]
                    if "tool_call_history_content_chars" in spec
                    else []
                ),
                *(
                    [f"GAME_LOOP_CHAT_MAX_HISTORY_MESSAGES={spec['max_history_messages']}"]
                    if "max_history_messages" in spec
                    else []
                ),
                *(
                    [f"GAME_LOOP_STOP_AFTER_GCB_DEMOS_TURN={spec['stop_after_gcb_demos_turn']}"]
                    if "stop_after_gcb_demos_turn" in spec
                    else []
                ),
                "GAME_LOOP_TEXT_ONLY=1",
                "GAME_LOOP_REQUIRE_GCB_DEMOS=1",
                "GAME_LOOP_LLM_HARNESS_PROPOSER=1",
                "GAME_LOOP_HARNESS_PROPOSER_TIMEOUT_SECONDS=120",
                "GAME_LOOP_HARNESS_PROPOSER_ATTEMPTS=4",
                f"SEED_ARTIFACT={SEED}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (run_dir / "task_pool_gcbench.json").write_text(
        json.dumps(build_task_pool(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    env_local = run_dir / ".env.local"
    root_env = ROOT / ".env.local"
    root_lines: list[str] = []
    if root_env.is_file():
        root_lines = [
            line.strip()
            for line in root_env.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
    if not env_local.is_file():
        lines: list[str] = []
        if spec["api_key_var"] == "DEEPSEEK_API_KEY":
            for item in root_lines:
                if item.startswith("DEEPSEEK_") or item.startswith("OPENAI_"):
                    lines.append(item)
        else:
            for item in root_lines:
                if (
                    item.startswith("DEEPSEEK_")
                    or item.startswith("OPENAI_")
                    or item.startswith("DASHSCOPE_")
                    or item.startswith("QWEN_")
                ):
                    lines.append(item)
        env_local.write_text("\n".join(lines) + "\n", encoding="utf-8")

    _write_executable(run_dir / "start_supervisor.sh", START_SUPERVISOR_SH)
    _write_executable(run_dir / "watchdog.sh", WATCHDOG_SH)
    shutil.copy2(ROOT / "experiments/scripts/run_experiment_daemon.py", run_dir / "run_experiment_daemon.py")

    if reset:
        archive = run_dir / "harness_archive"
        if archive.exists():
            shutil.rmtree(archive)
        for plan in run_dir.glob("harness_self_evolution_plan_*.json"):
            plan.unlink()

    return run_dir


START_SUPERVISOR_SH = r'''#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "$RUN_DIR/run.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$RUN_DIR/run.env"
  set +a
fi

CONFIG="${CONFIG:-$ROOT/experiments/configs-v4/gcbench-L4_deepseek_v4_produce.json}"
RUN_ID_PREFIX="${RUN_ID_PREFIX:-gcb}"
AGENT_API_KEY_VAR="${AGENT_API_KEY_VAR:-CODEX_API_KEY}"

_log_signal() {
  local label="$1"
  local sig="${2:-EXIT}"
  printf '[%s] %s signal=%s pid=%s at %s\n' \
    "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    "$label" \
    "$sig" \
    "$$" >> "$RUN_DIR/supervisor.log"
}

if [[ "${1:-}" != "--foreground" && "${1:-}" != "--watch" ]]; then
  mkdir -p "$RUN_DIR"
  if [[ -f "$RUN_DIR/supervisor.pid" ]]; then
    existing_pid="$(cat "$RUN_DIR/supervisor.pid" 2>/dev/null || true)"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
      echo "[supervisor] already running PID=$existing_pid (not starting another)"
      exit 0
    fi
  fi
  if [[ -f "$RUN_DIR/.supervisor.pid" ]]; then
    business_pid="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pid", ""))' "$RUN_DIR/.supervisor.pid" 2>/dev/null || true)"
    if [[ -n "$business_pid" ]] && kill -0 "$business_pid" 2>/dev/null; then
      echo "[supervisor] already running business PID=$business_pid (not starting another)"
      exit 0
    fi
  fi
  nohup bash "$0" --watch >> "$RUN_DIR/supervisor.log" 2>&1 < /dev/null &
  supervisor_pid=$!
  echo "$supervisor_pid" > "$RUN_DIR/supervisor.pid"
  disown -h "$supervisor_pid" 2>/dev/null || true
  echo "[supervisor] detached PID=$supervisor_pid run=$RUN_DIR"
  exit 0
fi

if [[ "${1:-}" == "--watch" ]]; then
  trap '_log_signal supervisor_watch EXIT' EXIT
  trap '_log_signal supervisor_watch SIGTERM; exit 143' TERM
  trap '_log_signal supervisor_watch SIGINT; exit 130' INT
  trap '_log_signal supervisor_watch SIGHUP; exit 129' HUP
  while true; do
    if bash "$0" --foreground; then
      echo "[supervisor] completed all epochs"
      break
    fi
    rc=$?
    echo "[supervisor] harness-self-supervise exited rc=$rc; restarting in 10s" >&2
    sleep 10
  done
  exit 0
fi

trap '_log_signal supervisor_foreground EXIT' EXIT
trap '_log_signal supervisor_foreground SIGTERM; exit 143' TERM
trap '_log_signal supervisor_foreground SIGINT; exit 130' INT
trap '_log_signal supervisor_foreground SIGHUP; exit 129' HUP

cd "$ROOT"
for secrets_file in "$RUN_DIR/.env.local" "$ROOT/.env.local"; do
  if [[ -f "$secrets_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$secrets_file"
    set +a
  fi
done

agent_key="${!AGENT_API_KEY_VAR:-}"
if [[ "${GAME_LOOP_AGENT_REQUIRES_API_KEY:-0}" == "1" && -z "$agent_key" ]]; then
  echo "missing agent API key (set $AGENT_API_KEY_VAR or CODEX_API_KEY in $RUN_DIR/.env.local)" >&2
  exit 1
fi

export PYTHONPATH="$ROOT"
export PYTHONUNBUFFERED=1
export GAME_LOOP_STUB_AGENT=0
export GAME_LOOP_CHAT_MAX_TURNS="${GAME_LOOP_CHAT_MAX_TURNS:-60}"
if [[ -n "$agent_key" ]]; then
  export CODEX_API_KEY="$agent_key"
elif [[ "${GAME_LOOP_AGENT_REQUIRES_API_KEY:-0}" == "1" ]]; then
  unset CODEX_API_KEY
else
  export CODEX_API_KEY="${CODEX_API_KEY:-EMPTY}"
fi
export CODEX_API_BASE="${CODEX_API_BASE:-https://api.deepseek.com}"
export CODEX_MODEL="${CODEX_MODEL:-deepseek-v4-flash}"

export GAMECRAFT_BENCH_JUDGE="${GAMECRAFT_BENCH_JUDGE:-openai}"
export GAMECRAFT_BENCH_JUDGE_MODEL="${GAMECRAFT_BENCH_JUDGE_MODEL:-${DEEPSEEK_JUDGE_MODEL:-deepseek-v4-flash}}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-${DEEPSEEK_API_KEY:-}}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-${DEEPSEEK_API_BASE:-https://api.deepseek.com}}"
export GAMECRAFT_USE_LOCAL_VERIFIER="${GAMECRAFT_USE_LOCAL_VERIFIER:-1}"

if [[ -z "${GODOT_EXEC_PATH:-}" && -x "$ROOT/scripts/setup_godot.sh" ]]; then
  GODOT_EXEC_PATH="$("$ROOT/scripts/setup_godot.sh" 2>/dev/null || true)"
  export GODOT_EXEC_PATH
fi
export GODOT_BIN="${GODOT_BIN:-${GODOT_EXEC_PATH:-}}"
export GAMECRAFT_BENCH_GODOT_BIN="${GAMECRAFT_BENCH_GODOT_BIN:-${GODOT_EXEC_PATH:-${GODOT_BIN:-}}}"

mkdir -p "$RUN_DIR"
if [[ ! -f "$RUN_DIR/harness_archive/champion.json" ]]; then
  python3 -m game_loop.cli harness-outer-init \
    --outer-dir "$RUN_DIR" \
    --config "$CONFIG"
fi

SEED_ARTIFACT="${SEED_ARTIFACT:-$ROOT/experiments/seed_artifacts/puzzle-sokoban-scaffold}"

exec python3 -m game_loop.cli harness-self-supervise \
  --outer-dir "$RUN_DIR" \
  --config "$CONFIG" \
  --task-source "$ROOT/../gcbench/tasks/puzzle-sokoban-dungeon" \
  --seed-artifact "$SEED_ARTIFACT" \
  --task-pool "$RUN_DIR/task_pool_gcbench.json" \
  --evaluate-seed \
  --start-epoch 1 \
  --max-epochs 20 \
  --cases 3 \
  --run-id-prefix "$RUN_ID_PREFIX" \
  --heartbeat-seconds 30
'''

WATCHDOG_SH = r'''#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL="${WATCHDOG_INTERVAL_SECONDS:-30}"
STALE_HEARTBEAT="${WATCHDOG_STALE_HEARTBEAT_SECONDS:-180}"

_log_signal() {
  local sig="${1:-EXIT}"
  printf '[watchdog] foreground ending signal=%s pid=%s at %s\n' \
    "$sig" "$$" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> "$RUN_DIR/watchdog.log"
}

if [[ "${1:-}" != "--foreground" ]]; then
  mkdir -p "$RUN_DIR"
  if [[ -f "$RUN_DIR/watchdog.pid" ]]; then
    existing_pid="$(cat "$RUN_DIR/watchdog.pid" 2>/dev/null || true)"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
      echo "[watchdog] already running PID=$existing_pid"
      exit 0
    fi
  fi
  nohup bash "$0" --foreground >> "$RUN_DIR/watchdog.log" 2>&1 < /dev/null &
  watchdog_pid=$!
  echo "$watchdog_pid" > "$RUN_DIR/watchdog.pid"
  disown -h "$watchdog_pid" 2>/dev/null || true
  echo "[watchdog] detached PID=$watchdog_pid run=$RUN_DIR"
  exit 0
fi

cd "$ROOT"
export PYTHONPATH="$ROOT"
trap '_log_signal EXIT' EXIT
trap '_log_signal SIGTERM; exit 143' TERM
trap '_log_signal SIGINT; exit 130' INT
trap '_log_signal SIGHUP; exit 129' HUP

echo "[watchdog] PID=$$ run=$RUN_DIR interval=${INTERVAL}s"
while true; do
  python3 -m game_loop.experiment_watchdog \
    --run-dir "$RUN_DIR" \
    --start-script "$RUN_DIR/start_supervisor.sh" \
    --status-json "$RUN_DIR/.watchdog_status.json" \
    --stale-heartbeat-seconds "$STALE_HEARTBEAT" \
    >> "$RUN_DIR/watchdog.log" 2>&1 || true
  sleep "$INTERVAL"
done
'''


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("models", nargs="*", choices=list(MODELS.keys()))
    parser.add_argument("--no-reset", action="store_true")
    args = parser.parse_args()
    models = args.models or list(MODELS.keys())
    created: list[Path] = []
    for key in models:
        path = bootstrap(key, reset=not args.no_reset)
        created.append(path)
        print(f"bootstrapped {key}: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
