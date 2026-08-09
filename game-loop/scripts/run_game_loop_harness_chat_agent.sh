#!/usr/bin/env bash
# run_game_loop_harness_chat_agent.sh — GCBench Harbor runner.
#
# Uses harbor to run the game-loop harness chat agent as a GCBench agent.
#
# Usage:
#   ./scripts/run_game_loop_harness_chat_agent.sh <game_id> [--extra-args ...]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── locate harbor ──
HARBOR="${HARBOR:-harbor}"
if ! command -v "$HARBOR" &>/dev/null; then
  echo "ERROR: harbor not found in PATH" >&2
  exit 1
fi

# ── validate environment ──
if [[ -z "${CODEX_API_BASE:-}" ]]; then
  echo "ERROR: CODEX_API_BASE is required" >&2
  exit 1
fi
if [[ -z "${CODEX_MODEL:-}" ]]; then
  echo "ERROR: CODEX_MODEL is required" >&2
  exit 1
fi

# ── harness text injection ──
HARNESS_TEXT="${HARNESS_TEXT:-You are operating inside a game-loop harness. Follow the harness instructions precisely.}"

# ── set skills index if not already set ──
if [[ -z "${GAME_LOOP_SKILLS_INDEX:-}" ]]; then
  SKILLS_FILE="$ROOT_DIR/awesome-gamedev-skills-index.txt"
  if [[ -f "$SKILLS_FILE" ]]; then
    export GAME_LOOP_SKILLS_INDEX="$SKILLS_FILE"
  fi
fi

# ── run via harbor ──
cd "$ROOT_DIR"
exec "$HARBOR" run \
  --agent-import-path "game_loop.chat_agent:LocalChatAgent" \
  --agent-extra-env "CODEX_API_BASE=$CODEX_API_BASE" \
  --agent-extra-env "CODEX_MODEL=$CODEX_MODEL" \
  ${CODEX_API_KEY:+--agent-extra-env "CODEX_API_KEY=$CODEX_API_KEY"} \
  ${GAME_LOOP_SKILLS_INDEX:+--agent-extra-env "GAME_LOOP_SKILLS_INDEX=$GAME_LOOP_SKILLS_INDEX"} \
  --harness-text "$HARNESS_TEXT" \
  "$@"
