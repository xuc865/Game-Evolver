#!/usr/bin/env bash
# run_codex_gpt_5_5.sh — Codex CLI WebSocket agent (historical, retained for reference).
#
# NOTE: This script uses the Codex CLI WebSocket agent which is NOT compatible
#       with Kimi models. It is kept for historical reference and for models
#       that support the Codex WebSocket protocol (e.g. GPT-5.5).
#
# Usage:
#   CODEX_API_BASE=ws://... CODEX_MODEL=gpt-5.5 \
#   ./scripts/run_codex_gpt_5_5.sh --instruction "..." --workspace /tmp/game

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── validate environment ──
if [[ -z "${CODEX_API_BASE:-}" ]]; then
  echo "ERROR: CODEX_API_BASE is required (WebSocket URL)" >&2
  exit 1
fi
if [[ -z "${CODEX_MODEL:-}" ]]; then
  echo "ERROR: CODEX_MODEL is required" >&2
  exit 1
fi

# ── warn about Kimi incompatibility ──
if [[ "$CODEX_MODEL" == *"kimi"* || "$CODEX_MODEL" == *"Kimi"* ]]; then
  echo "WARNING: Codex CLI WebSocket agent is NOT compatible with Kimi models." >&2
  echo "         Use run_chat_agent_direct.sh instead." >&2
  exit 1
fi

# ── determine Python executable ──
PYTHON="${PYTHON:-python3}"

# ── run via Codex CLI WebSocket protocol ──
cd "$ROOT_DIR"
exec codex --websocket "$CODEX_API_BASE" --model "$CODEX_MODEL" \
  ${CODEX_API_KEY:+--api-key "$CODEX_API_KEY"} \
  "$@"
