#!/usr/bin/env bash
# run_gcbench_l4_backend.sh — L4 game-loop backend for GameCraftBench.
#
# Placeholders (from GameCraftBenchAdapter.prepare command_context):
#   {candidate_workspace} {instruction_file} {artifact_path}
#   {output_manifest} {task_id} {gcbench_root} {breakdown_path}
#
# Runs LocalChatAgent, then the official/stub verifier, and always writes
# gcbench_execution.json when verification succeeds.

set -euo pipefail

CANDIDATE_WORKSPACE="${1:?candidate_workspace required}"
INSTRUCTION_FILE="${2:?instruction_file required}"
ARTIFACT_PATH="${3:?artifact_path required}"
OUTPUT_MANIFEST="${4:?output_manifest required}"
TASK_ID="${5:?task_id required}"
GCBENCH_ROOT="${6:?gcbench_root required}"
BREAKDOWN_PATH="${7:?breakdown_path required}"
TASK_ROOT="${8:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PYTHON="${PYTHON:-python3}"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/provider_env.sh"

_setup_godot_env() {
  if [[ -z "${GODOT_EXEC_PATH:-}" ]]; then
    if [[ -x "$ROOT_DIR/scripts/setup_godot.sh" ]]; then
      GODOT_EXEC_PATH="$("$ROOT_DIR/scripts/setup_godot.sh" 2>/dev/null || true)"
      export GODOT_EXEC_PATH
    fi
  fi
  if [[ -z "${GODOT_EXEC_PATH:-}" ]]; then
    GODOT_EXEC_PATH="$(command -v godot 2>/dev/null || true)"
    export GODOT_EXEC_PATH
  fi
  if [[ -n "${GODOT_EXEC_PATH:-}" ]]; then
    export GODOT_BIN="${GODOT_BIN:-$GODOT_EXEC_PATH}"
    export PATH="$(dirname "$GODOT_EXEC_PATH"):$PATH"
  fi
}

_run_agent() {
  if game_loop_should_stub_agent; then
    echo "[gcbench_l4_backend] stub agent enabled; leaving workspace unchanged" >&2
    return 0
  fi
  game_loop_validate_agent_env
  _setup_godot_env
  if [[ -z "${GODOT_EXEC_PATH:-}" ]]; then
    echo "[gcbench_l4_backend] warning: GODOT_EXEC_PATH not set; agent should use tools/godot" >&2
  else
    echo "[gcbench_l4_backend] GODOT_EXEC_PATH=$GODOT_EXEC_PATH" >&2
  fi
  export GAME_LOOP_CHAT_MAX_TURNS="${GAME_LOOP_CHAT_MAX_TURNS:-60}"
  local instruction
  instruction="$(cat "$INSTRUCTION_FILE")"
  bash "$ROOT_DIR/scripts/run_chat_agent_direct.sh" \
    --instruction "$instruction" \
    --workspace "$CANDIDATE_WORKSPACE"
}

_resume_agent_after_timeout() {
  local instruction
  instruction="$(cat "$INSTRUCTION_FILE")"
  instruction+=$'\n\n## Infrastructure recovery\nThe previous agent process was interrupted by a backbone API timeout. The workspace preserves all completed edits. Inspect the existing project first, continue from its current state, finish missing gameplay and demo traces, run the headless smoke test, and stop as soon as the deliverables are complete. Do not restart the implementation from scratch.'
  GAME_LOOP_CHAT_MAX_TURNS="${GAME_LOOP_CHAT_RECOVERY_MAX_TURNS:-${GAME_LOOP_CHAT_MAX_TURNS:-60}}" \
  GAME_LOOP_CHAT_MAX_OUTPUT_TOKENS="${GAME_LOOP_CHAT_RECOVERY_MAX_OUTPUT_TOKENS:-2048}" \
  GAME_LOOP_CHAT_API_MAX_RETRIES="${GAME_LOOP_CHAT_RECOVERY_API_MAX_RETRIES:-4}" \
  GAME_LOOP_CHAT_API_TOTAL_TIMEOUT_SECONDS="${GAME_LOOP_CHAT_RECOVERY_API_TOTAL_TIMEOUT_SECONDS:-300}" \
    bash "$ROOT_DIR/scripts/run_chat_agent_direct.sh" \
      --instruction "$instruction" \
      --workspace "$CANDIDATE_WORKSPACE"
}

_setup_judge_env() {
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/gcbench_e2e/export_judge_env.sh"
}

_run_verifier() {
  local verifier_out
  verifier_out="$(dirname "$BREAKDOWN_PATH")"
  mkdir -p "$verifier_out"
  _setup_godot_env
  _setup_judge_env
  GAMECRAFT_ROOT="$GCBENCH_ROOT" \
  GAMECRAFT_BENCH_GODOT_BIN="${GAMECRAFT_BENCH_GODOT_BIN:-${GODOT_EXEC_PATH:-${GODOT_BIN:-godot}}}" \
  GAMECRAFT_USE_LOCAL_VERIFIER="${GAMECRAFT_USE_LOCAL_VERIFIER:-1}" \
    verifier_args=(--task "$TASK_ID" --artifact "$ARTIFACT_PATH" --output "$verifier_out")
    if [[ -n "$TASK_ROOT" ]]; then
      verifier_args+=(--task-root "$TASK_ROOT")
    fi
    bash "$ROOT_DIR/scripts/gcbench_e2e/run_local_verifier.sh" "${verifier_args[@]}"
}

_write_manifest() {
  "$PYTHON" - <<'PY' "$ARTIFACT_PATH" "$BREAKDOWN_PATH" "$OUTPUT_MANIFEST" "$TASK_ID"
import json
import sys
from pathlib import Path

artifact_path, breakdown_path, output_manifest, task_id = sys.argv[1:5]
payload = {
    "benchmark": "gamecraftbench",
    "task_id": task_id,
    "artifact_path": str(Path(artifact_path).resolve()),
    "breakdown_path": str(Path(breakdown_path).resolve()),
}
path = Path(output_manifest)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
}

if [[ -n "${GAME_LOOP_MAKER_RUNTIME_PROFILE:-}" ]]; then
  _setup_godot_env
  _setup_judge_env
  verifier_out="$(dirname "$BREAKDOWN_PATH")"
  mkdir -p "$verifier_out"
  evaluator_args=(bash "$ROOT_DIR/scripts/gcbench_e2e/run_local_verifier.sh" \
    --task "$TASK_ID" --artifact '{artifact}' --output "$verifier_out")
  if [[ -n "$TASK_ROOT" ]]; then
    evaluator_args+=(--task-root "$TASK_ROOT")
  fi
  evaluator_json="$($PYTHON -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "${evaluator_args[@]}")"
  GAMECRAFT_ROOT="$GCBENCH_ROOT" \
  GAMECRAFT_BENCH_GODOT_BIN="${GAMECRAFT_BENCH_GODOT_BIN:-${GODOT_EXEC_PATH:-${GODOT_BIN:-godot}}}" \
  GAMECRAFT_USE_LOCAL_VERIFIER="${GAMECRAFT_USE_LOCAL_VERIFIER:-1}" \
    "$PYTHON" -m game_loop.benchmarks.gcbench_bridge \
      --workspace "$CANDIDATE_WORKSPACE" \
      --instruction-file "$INSTRUCTION_FILE" \
      --output-manifest "$OUTPUT_MANIFEST" \
      --breakdown-path "$BREAKDOWN_PATH" \
      --runtime-profile "$GAME_LOOP_MAKER_RUNTIME_PROFILE" \
      --evaluator-command-json "$evaluator_json"
  exit $?
fi

agent_rc=0
set +e
_run_agent
agent_rc=$?
if [[ "$agent_rc" -eq 75 ]]; then
  echo "[gcbench_l4_backend] backbone API timeout; resuming once in preserved workspace" >&2
  _resume_agent_after_timeout
  agent_rc=$?
fi
set -e
if [[ "$agent_rc" -ne 0 ]]; then
  # A provider/tooling crash is infrastructure failure, not evidence that the
  # partially written game deserves a quality score.  Refuse to create an
  # evaluation manifest so the controller pauses/retries without admitting a
  # misleading zero.
  if [[ "$agent_rc" -eq 75 ]]; then
    echo "[gcbench_l4_backend] backbone_api_timeout after in-workspace recovery; refusing evaluation" >&2
  else
    echo "[gcbench_l4_backend] agent infrastructure failure rc=$agent_rc; refusing evaluation" >&2
  fi
  exit 2
fi

  verifier_rc=0
  set +e
  _run_verifier
  verifier_rc=$?
  set -e
  if [[ "$verifier_rc" -ne 0 ]]; then
    echo "[gcbench_l4_backend] verifier exited with code $verifier_rc" >&2
  fi

  if [[ ! -f "$BREAKDOWN_PATH" ]]; then
    echo "[gcbench_l4_backend] breakdown missing; retrying verifier via docker" >&2
    GAMECRAFT_USE_LOCAL_VERIFIER=0 _run_verifier || verifier_rc=$?
  fi

if [[ -f "$BREAKDOWN_PATH" && "$verifier_rc" -le 1 ]]; then
  _write_manifest
  echo "[gcbench_l4_backend] wrote manifest: $OUTPUT_MANIFEST" >&2
  exit 0
fi

if [[ "$verifier_rc" -ge 2 ]]; then
  echo "[gcbench_l4_backend] infrastructure failure; refusing score admission" >&2
  exit "$verifier_rc"
fi

echo "[gcbench_l4_backend] failed: breakdown missing at $BREAKDOWN_PATH" >&2
exit "${verifier_rc:-1}"
