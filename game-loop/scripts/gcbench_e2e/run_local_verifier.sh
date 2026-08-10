#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GAMECRAFT_ROOT="${GAMECRAFT_ROOT:-$PROJECT_ROOT/../gcbench}"
VENV="${GAMECRAFT_VENV:-$PROJECT_ROOT/.venvs/gamecraft-bench}"
IMAGE="${GAMECRAFT_IMAGE:-harness-game/gamecraft-bench-e2e:21028df}"
TASK=""
ARTIFACT=""
OUTPUT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --task) TASK="$2"; shift 2 ;;
    --artifact) ARTIFACT="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

test -n "$TASK" || { echo "--task is required" >&2; exit 2; }
test -d "$ARTIFACT" || { echo "--artifact must be a project directory" >&2; exit 2; }
test -n "$OUTPUT" || { echo "--output is required" >&2; exit 2; }

mkdir -p "$OUTPUT"
ARTIFACT="$(cd "$ARTIFACT" && pwd)"
OUTPUT="$(cd "$OUTPUT" && pwd)"
RUBRIC="$(cd "$GAMECRAFT_ROOT/tasks/$TASK/tests" && pwd)/rubric.json"
# Never let a failed invocation appear successful because artifacts from an
# earlier attempt still exist in the same candidate output directory.
rm -f "$OUTPUT/breakdown.json" "$OUTPUT/reward.txt" "$OUTPUT/judge_log.json" "$OUTPUT/ctrf.json"

_setup_verifier_home() {
  local verifier_home="$OUTPUT/.godot-home"
  local verifier_config="$OUTPUT/.xdg-config"
  local verifier_cache="$OUTPUT/.xdg-cache"
  local verifier_data="$OUTPUT/.xdg-data"
  mkdir -p "$verifier_home" "$verifier_config" "$verifier_cache" "$verifier_data"
  export HOME="$verifier_home"
  export USERPROFILE="$verifier_home"
  export XDG_CONFIG_HOME="$verifier_config"
  export XDG_CACHE_HOME="$verifier_cache"
  export XDG_DATA_HOME="$verifier_data"
}

_setup_godot_env() {
  if [[ -z "${GODOT_EXEC_PATH:-}" && -x "$PROJECT_ROOT/scripts/setup_godot.sh" ]]; then
    GODOT_EXEC_PATH="$("$PROJECT_ROOT/scripts/setup_godot.sh" 2>/dev/null || true)"
    export GODOT_EXEC_PATH
  fi
  export GAMECRAFT_BENCH_GODOT_BIN="${GAMECRAFT_BENCH_GODOT_BIN:-${GODOT_EXEC_PATH:-${GODOT_BIN:-}}}"
  if [[ -n "${GAMECRAFT_BENCH_GODOT_BIN:-}" && -x "${GAMECRAFT_BENCH_GODOT_BIN}" ]]; then
    export GODOT_BIN="${GODOT_BIN:-$GAMECRAFT_BENCH_GODOT_BIN}"
    export PATH="$(dirname "$GAMECRAFT_BENCH_GODOT_BIN"):$PATH"
  fi
}

_can_replay_locally() {
  command -v ffmpeg >/dev/null 2>&1 || return 1
  command -v xdotool >/dev/null 2>&1 || return 1
  command -v Xvfb >/dev/null 2>&1 || return 1
  return 0
}

_has_demo_traces() {
  compgen -G "$ARTIFACT/demo_outputs/"'*.json' >/dev/null 2>&1
}

_setup_godot_env
_setup_verifier_home
# Resolve the judge mode before choosing local versus Docker execution.  In
# particular, DeepSeek's text-only mode has no Xvfb/xdotool/ffmpeg dependency
# and must not be routed through the visual replay fallback merely because the
# mode had not been derived yet.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/export_judge_env.sh"

use_local=0
if [ "${GAMECRAFT_USE_LOCAL_VERIFIER:-0}" = "1" ]; then
  if [ -x "$VENV/bin/python" ] && [ -n "${GAMECRAFT_BENCH_GODOT_BIN:-}" ] && [ -x "${GAMECRAFT_BENCH_GODOT_BIN}" ]; then
    if GAMECRAFT_ROOT="$GAMECRAFT_ROOT" PYTHONPATH="$GAMECRAFT_ROOT${PYTHONPATH:+:$PYTHONPATH}" \
        "$VENV/bin/python" -c "import gamecraft_bench.verifier" >/dev/null 2>&1; then
      if [[ "${GAMECRAFT_BENCH_JUDGE_INPUT_MODE:-vision}" == "text" ]] || \
          _can_replay_locally || ! _has_demo_traces; then
        use_local=1
      else
        echo "[run_local_verifier] demo traces present but Xvfb unavailable; using docker verifier" >&2
      fi
    fi
  fi
fi

if [ "$use_local" = "1" ]; then
  export PYTHONPATH="$GAMECRAFT_ROOT${PYTHONPATH:+:$PYTHONPATH}"
  judge="${GAMECRAFT_BENCH_JUDGE:-openai}"
  judge_model="${GAMECRAFT_BENCH_JUDGE_MODEL:-}"
  judge_input_mode="${GAMECRAFT_BENCH_JUDGE_INPUT_MODE:-vision}"
  judge_args=(--judge "$judge" --judge-input-mode "$judge_input_mode")
  if [ -n "$judge_model" ]; then
    judge_args+=(--judge-model "$judge_model")
  fi
  set +e
  "$VENV/bin/python" -m gamecraft_bench.verifier \
    --project "$ARTIFACT" \
    --rubric "$RUBRIC" \
    --output "$OUTPUT" \
    "${judge_args[@]}"
  verifier_rc=$?
  set -e
else
  set +e
  bash "$SCRIPT_DIR/run_official_verifier.sh" \
    --task "$TASK" \
    --artifact "$ARTIFACT" \
    --output "$OUTPUT"
  verifier_rc=$?
  set -e
fi

test -s "$OUTPUT/breakdown.json"
test -s "$OUTPUT/reward.txt"
echo "Official GameCraftBench verifier: completed rc=$verifier_rc ($OUTPUT/breakdown.json)"
exit "$verifier_rc"
