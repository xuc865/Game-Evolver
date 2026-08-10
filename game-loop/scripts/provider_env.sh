#!/usr/bin/env bash
# Shared provider policy for game-loop launchers.
#
# Keyless OpenAI-compatible endpoints are valid.  Stub execution must always be
# an explicit operator choice; it must never be inferred from a missing key.

game_loop_should_stub_agent() {
  [[ "${GAME_LOOP_STUB_AGENT:-0}" == "1" ]]
}

game_loop_resolve_agent_api_key() {
  case "${CODEX_PROVIDER:-}" in
    claude)
      printf '%s' "${CODEX_API_KEY_CLAUDE:-${ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}}"
      ;;
    gpt55|gpt-5.5)
      printf '%s' "${CODEX_API_KEY_GPT55:-${OPENAI_API_KEY:-}}"
      ;;
    *)
      printf '%s' "${CODEX_API_KEY:-${OPENAI_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}}}"
      ;;
  esac
}

game_loop_validate_agent_env() {
  if [[ -z "${CODEX_API_BASE:-}" ]]; then
    echo "ERROR: CODEX_API_BASE is required" >&2
    return 1
  fi
  if [[ -z "${CODEX_MODEL:-}" ]]; then
    echo "ERROR: CODEX_MODEL is required" >&2
    return 1
  fi
  if [[ "${GAME_LOOP_AGENT_REQUIRES_API_KEY:-0}" == "1" && -z "$(game_loop_resolve_agent_api_key)" ]]; then
    echo "ERROR: CODEX_API_KEY is required for this provider" >&2
    return 1
  fi
}
