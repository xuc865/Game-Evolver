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

ARTIFACT="$(cd "$ARTIFACT" && pwd)"
OUTPUT="$(cd "$OUTPUT" && mkdir -p "$OUTPUT" && cd "$OUTPUT" && pwd)"
RUBRIC="$(cd "$GAMECRAFT_ROOT/tasks/$TASK/tests" && pwd)/rubric.json"

if [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c "import gamecraft_bench.verifier" >/dev/null 2>&1; then
  export GAMECRAFT_BENCH_JUDGE="${GAMECRAFT_BENCH_JUDGE:-stub}"
  export GAMECRAFT_BENCH_JUDGE_MODEL="${GAMECRAFT_BENCH_JUDGE_MODEL:-1.0}"
  export GAMECRAFT_BENCH_GODOT_BIN="${GAMECRAFT_BENCH_GODOT_BIN:-godot}"
  export PYTHONPATH="$GAMECRAFT_ROOT${PYTHONPATH:+:$PYTHONPATH}"
  "$VENV/bin/python" -m gamecraft_bench.verifier \
    --project "$ARTIFACT" \
    --rubric "$RUBRIC" \
    --output "$OUTPUT" \
    --judge "$GAMECRAFT_BENCH_JUDGE" \
    --judge-model "$GAMECRAFT_BENCH_JUDGE_MODEL"
else
  bash "$SCRIPT_DIR/run_official_verifier.sh" \
    --task "$TASK" \
    --artifact "$ARTIFACT" \
    --output "$OUTPUT"
fi

test -s "$OUTPUT/breakdown.json"
test -s "$OUTPUT/reward.txt"
echo "Official GameCraftBench verifier: OK ($OUTPUT/breakdown.json)"
