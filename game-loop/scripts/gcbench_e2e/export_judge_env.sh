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

judge_key="${GAMECRAFT_BENCH_JUDGE_OPENAI_API_KEY:-}"
if [[ -z "$judge_key" ]]; then
  judge_key="${DEEPSEEK_API_KEY:-${CODEX_API_KEY:-${OPENAI_API_KEY:-}}}"
fi
if [[ -z "$judge_key" && "${GAMECRAFT_BENCH_JUDGE_ALLOW_KEYLESS:-0}" == "1" ]]; then
  judge_key="EMPTY"
fi
if [[ -n "$judge_key" ]]; then
  export OPENAI_API_KEY="$judge_key"
  export GAMECRAFT_BENCH_JUDGE_OPENAI_API_KEY="${GAMECRAFT_BENCH_JUDGE_OPENAI_API_KEY:-$judge_key}"
fi

# Keep the public rubric judge independent from whichever backbone launched the
# verifier. The local GLM deployment is OpenAI-compatible and keyless; callers
# can still override it explicitly for another healthy judge service.
judge_base="${GAMECRAFT_BENCH_JUDGE_OPENAI_BASE_URL:-http://29.116.237.75:8080/v1}"
export OPENAI_BASE_URL="$judge_base"
export GAMECRAFT_BENCH_JUDGE_OPENAI_BASE_URL="${GAMECRAFT_BENCH_JUDGE_OPENAI_BASE_URL:-$judge_base}"

export GAMECRAFT_BENCH_JUDGE_MODEL="${GAMECRAFT_BENCH_JUDGE_MODEL:-GLM-5.2-W4AFP8-node1}"
export GAMECRAFT_BENCH_JUDGE_CONCURRENCY="${GAMECRAFT_BENCH_JUDGE_CONCURRENCY:-6}"

if [[ "${GAME_LOOP_TEXT_ONLY:-0}" == "1" ]]; then
  export GAMECRAFT_BENCH_JUDGE_INPUT_MODE="text"
elif [[ -z "${GAMECRAFT_BENCH_JUDGE_INPUT_MODE:-}" ]]; then
  judge_model_lower="$(printf '%s' "$GAMECRAFT_BENCH_JUDGE_MODEL" | tr '[:upper:]' '[:lower:]')"
  case "$judge_model_lower" in
    deepseek-v4-flash|glm-5.2-w4afp8-node1) export GAMECRAFT_BENCH_JUDGE_INPUT_MODE="text" ;;
    *) export GAMECRAFT_BENCH_JUDGE_INPUT_MODE="vision" ;;
  esac
  unset judge_model_lower
fi

if [[ -z "${OPENAI_API_KEY:-}" && "$judge_base" == "http://29.116.237.75:8080/v1" ]]; then
  export OPENAI_API_KEY="EMPTY"
  export GAMECRAFT_BENCH_JUDGE_OPENAI_API_KEY="EMPTY"
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "[gcbench_judge] ERROR: real judge (${GAMECRAFT_BENCH_JUDGE}) requires OPENAI_API_KEY, DEEPSEEK_API_KEY, or CODEX_API_KEY" >&2
  echo "[gcbench_judge] Set GAMECRAFT_BENCH_JUDGE=stub only for offline pipeline smoke tests." >&2
  return 1 2>/dev/null || exit 1
fi
