#!/usr/bin/env bash
# run_chat_agent_with_skills.sh — Launch LocalChatAgent with Awesome Skills.
#
# Sets GAME_LOOP_SKILLS_INDEX to awesome-gamedev-skills-index.txt and then
# delegates to run_chat_agent_direct.sh.
#
# Usage:
#   CODEX_API_BASE=http://29.116.237.135:8080/v1 \
#   CODEX_MODEL=Kimi-K2.7-Code \
#   CODEX_API_KEY=sk-xxx \
#   ./scripts/run_chat_agent_with_skills.sh --instruction "Create a card game" --workspace /tmp/game

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── pin the real upstream skills checkout and generated index ──
export GAME_LOOP_SKILLS_ROOT="${GAME_LOOP_SKILLS_ROOT:-$ROOT_DIR/third_party/awesome-gamedev-agent-skills}"
export GAME_LOOP_SKILLS_INDEX="${GAME_LOOP_SKILLS_INDEX:-$ROOT_DIR/experiments/baselines/awesome-gamedev-agent-skills-index.md}"

if [[ ! -f "$GAME_LOOP_SKILLS_INDEX" ]]; then
  echo "WARNING: skills index file not found at $GAME_LOOP_SKILLS_INDEX" >&2
fi
if [[ ! -f "$GAME_LOOP_SKILLS_ROOT/router/SKILL.md" ]]; then
  echo "WARNING: skills checkout not found at $GAME_LOOP_SKILLS_ROOT" >&2
fi

# ── delegate to direct runner ──
exec "$SCRIPT_DIR/run_chat_agent_direct.sh" "$@"
