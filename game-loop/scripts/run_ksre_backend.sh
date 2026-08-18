#!/usr/bin/env bash
set -euo pipefail

CANDIDATE_WORKSPACE="${1:?candidate_workspace required}"
INSTRUCTION_FILE="${2:?instruction_file required}"
OUTPUT_MANIFEST="${3:?output_manifest required}"
EVALUATION_PATH="${4:?evaluation_path required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PYTHON="${PYTHON:-python3}"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/provider_env.sh"

if ! game_loop_should_stub_agent; then
  game_loop_validate_agent_env
  instruction="$(cat "$INSTRUCTION_FILE")"
  GAME_LOOP_CHAT_MAX_TURNS="${GAME_LOOP_CHAT_MAX_TURNS:-60}" \
  GAME_LOOP_REQUIRE_WORKSPACE_EDIT="${GAME_LOOP_REQUIRE_WORKSPACE_EDIT:-1}" \
  GAME_LOOP_WORKSPACE_EDIT_GATE_TURN="${GAME_LOOP_WORKSPACE_EDIT_GATE_TURN:-16}" \
    bash "$ROOT_DIR/scripts/run_chat_agent_direct.sh" \
      --instruction "$instruction" \
      --workspace "$CANDIDATE_WORKSPACE"
fi

"$PYTHON" "$ROOT_DIR/scripts/evaluate_ksre_pxt_director.py" \
  --artifact "$CANDIDATE_WORKSPACE" \
  --output "$EVALUATION_PATH" \
  --renpy-bin "${RENPY_BIN:-$ROOT_DIR/third_party/renpy-8.5.3-sdk/renpy.sh}"

"$PYTHON" - "$CANDIDATE_WORKSPACE" "$EVALUATION_PATH" "$OUTPUT_MANIFEST" <<'PY'
import json
import sys
from pathlib import Path

artifact, evaluation, manifest = map(Path, sys.argv[1:])
payload = {
    "schema_version": "benchmark-execution-v1",
    "benchmark": "ksre",
    "status": "completed",
    "artifact_path": str(artifact.resolve()),
    "evaluation_path": str(evaluation.resolve()),
}
manifest.parent.mkdir(parents=True, exist_ok=True)
manifest.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY
