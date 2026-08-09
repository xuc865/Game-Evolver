#!/usr/bin/env bash
# Shared judge configuration for local GameCraftBench verification.
# Real scoring uses the openai-compatible backend by default. Text-only
# endpoints can set GAMECRAFT_BENCH_JUDGE_INPUT_MODE=text to avoid image_url.
# Set GAMECRAFT_BENCH_JUDGE=stub explicitly for pipeline smoke tests only.

if [[ "${GAMECRAFT_BENCH_JUDGE:-}" == "stub" ]]; then
  export GAMECRAFT_BENCH_JUDGE_MODEL="${GAMECRAFT_BENCH_JUDGE_MODEL:-1.0}"
  return 0 2>/dev/null || exit 0
fi

export GAMECRAFT_BENCH_JUDGE="${GAMECRAFT_BENCH_JUDGE:-openai}"

judge_key="${GAMECRAFT_BENCH_JUDGE_OPENAI_API_KEY:-${OPENAI_API_KEY:-}}"
if [[ -z "$judge_key" ]]; then
  judge_key="${DEEPSEEK_API_KEY:-${CODEX_API_KEY:-}}"
fi
if [[ -n "$judge_key" ]]; then
  export OPENAI_API_KEY="$judge_key"
  export GAMECRAFT_BENCH_JUDGE_OPENAI_API_KEY="${GAMECRAFT_BENCH_JUDGE_OPENAI_API_KEY:-$judge_key}"
fi

judge_base="${GAMECRAFT_BENCH_JUDGE_OPENAI_BASE_URL:-${OPENAI_BASE_URL:-}}"
if [[ -z "$judge_base" ]]; then
  judge_base="${DEEPSEEK_API_BASE:-${CODEX_API_BASE:-https://api.deepseek.com}}"
fi
export OPENAI_BASE_URL="$judge_base"
export GAMECRAFT_BENCH_JUDGE_OPENAI_BASE_URL="${GAMECRAFT_BENCH_JUDGE_OPENAI_BASE_URL:-$judge_base}"

export GAMECRAFT_BENCH_JUDGE_MODEL="${GAMECRAFT_BENCH_JUDGE_MODEL:-${DEEPSEEK_JUDGE_MODEL:-${DEEPSEEK_MODEL:-deepseek-v4-flash}}}"

if [[ "${GAME_LOOP_TEXT_ONLY:-0}" == "1" ]]; then
  export GAMECRAFT_BENCH_JUDGE_INPUT_MODE="text"
elif [[ -z "${GAMECRAFT_BENCH_JUDGE_INPUT_MODE:-}" ]]; then
  judge_model_lower="$(printf '%s' "$GAMECRAFT_BENCH_JUDGE_MODEL" | tr '[:upper:]' '[:lower:]')"
  case "$judge_model_lower" in
    deepseek-v4-flash) export GAMECRAFT_BENCH_JUDGE_INPUT_MODE="text" ;;
    *) export GAMECRAFT_BENCH_JUDGE_INPUT_MODE="vision" ;;
  esac
  unset judge_model_lower
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "[gcbench_judge] ERROR: real judge (${GAMECRAFT_BENCH_JUDGE}) requires OPENAI_API_KEY, DEEPSEEK_API_KEY, or CODEX_API_KEY" >&2
  echo "[gcbench_judge] Set GAMECRAFT_BENCH_JUDGE=stub only for offline pipeline smoke tests." >&2
  return 1 2>/dev/null || exit 1
fi
