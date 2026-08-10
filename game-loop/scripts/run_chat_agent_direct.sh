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

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi
if [[ -f "$ROOT_DIR/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env.local"
  set +a
fi

# DashScope is OpenAI-compatible but its native credential name is
# DASHSCOPE_API_KEY. Normalize it before the common launcher validates inputs.
if [[ "${CODEX_API_BASE:-}" == "https://dashscope.aliyuncs.com/compatible-mode/v1" \
  && -z "${CODEX_API_KEY:-}" && -n "${DASHSCOPE_API_KEY:-}" ]]; then
  export CODEX_API_KEY="$DASHSCOPE_API_KEY"
fi

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
if [[ "${GAME_LOOP_USE_AWESOME_GAMEDEV_SKILLS:-0}" == "1" ]]; then
  export GAME_LOOP_SKILLS_ROOT="${GAME_LOOP_SKILLS_ROOT:-$ROOT_DIR/third_party/awesome-gamedev-agent-skills}"
  export GAME_LOOP_SKILLS_INDEX="${GAME_LOOP_SKILLS_INDEX:-$ROOT_DIR/experiments/baselines/awesome-gamedev-agent-skills-index.md}"
  if [[ ! -f "$GAME_LOOP_SKILLS_ROOT/router/SKILL.md" ]]; then
    echo "ERROR: awesome-gamedev-agent-skills checkout missing at $GAME_LOOP_SKILLS_ROOT" >&2
    exit 1
  fi
  if [[ ! -f "$GAME_LOOP_SKILLS_INDEX" ]]; then
    echo "ERROR: awesome-gamedev skills index missing at $GAME_LOOP_SKILLS_INDEX" >&2
    exit 1
  fi
fi
if [[ -n "${GAME_LOOP_SKILLS_INDEX:-}" ]]; then
  export GAME_LOOP_SKILLS_INDEX
fi
if [[ -n "${GAME_LOOP_SKILLS_ROOT:-}" ]]; then
  export GAME_LOOP_SKILLS_ROOT
fi

# ── run the agent ──
cd "$ROOT_DIR"
exec "$PYTHON" -m game_loop.chat_agent "$@"
