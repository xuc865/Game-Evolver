#!/usr/bin/env bash
# run_chat_agent_direct.sh — Launch LocalChatAgent directly.
#
# Reads environment variables:
#   CODEX_API_BASE   — API base URL (e.g. http://29.116.237.135:8080/v1)
#   CODEX_MODEL      — model name (e.g. Kimi-K2.7-Code)
#   CODEX_API_KEY    — API key
#   CODEX_THINKING   — "on"/"off"/"medium"/"high"
#   GAME_LOOP_SKILLS_INDEX — (optional) path to skill index file
#
# Usage:
#   CODEX_API_BASE=http://29.116.237.135:8080/v1 \
#   CODEX_MODEL=Kimi-K2.7-Code \
#   CODEX_API_KEY=sk-xxx \
#   ./scripts/run_chat_agent_direct.sh --instruction "Create a platformer game" --workspace /tmp/game

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── validate required environment variables ──
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/provider_env.sh"
game_loop_validate_agent_env

# ── extract --ve parameter from CODEX_MODEL if present ──
# Format: "ModelName --ve some_value" — we strip the --ve part for the actual model name
VE_PARAM=""
CLEAN_MODEL="$CODEX_MODEL"
if [[ "$CODEX_MODEL" == *"--ve"* ]]; then
  VE_PARAM=$(echo "$CODEX_MODEL" | sed -n 's/.*--ve \([^ ]*\).*/\1/p')
  CLEAN_MODEL=$(echo "$CODEX_MODEL" | sed 's/ --ve .*//')
  export CODEX_MODEL="$CLEAN_MODEL"
fi

# ── determine Python executable ──
PYTHON="${PYTHON:-python3}"

# ── export skills index if set ──
if [[ -n "${GAME_LOOP_SKILLS_INDEX:-}" ]]; then
  export GAME_LOOP_SKILLS_INDEX
fi

# ── run the agent ──
cd "$ROOT_DIR"
exec "$PYTHON" -m game_loop.chat_agent "$@"
