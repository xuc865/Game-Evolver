#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GAMECRAFT_ROOT="${GAMECRAFT_ROOT:-$PROJECT_ROOT/../gcbench}"
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
test -f "$GAMECRAFT_ROOT/tasks/$TASK/tests/rubric.json" || {
  echo "unknown task or missing official rubric: $TASK" >&2; exit 2;
}
test -n "$OUTPUT" || { echo "--output is required" >&2; exit 2; }
mkdir -p "$OUTPUT"

ARTIFACT="$(cd "$ARTIFACT" && pwd)"
OUTPUT="$(cd "$OUTPUT" && pwd)"
RUBRIC="$(cd "$GAMECRAFT_ROOT/tasks/$TASK/tests" && pwd)/rubric.json"

docker run --rm --platform linux/amd64 \
  -e GAMECRAFT_BENCH_JUDGE=stub \
  -e GAMECRAFT_BENCH_JUDGE_MODEL=1.0 \
  -e GAMECRAFT_BENCH_GODOT_BIN=/usr/local/bin/godot \
  -v "$ARTIFACT:/workspace/game" \
  -v "$RUBRIC:/tests/rubric.json:ro" \
  -v "$OUTPUT:/logs/verifier" \
  "$IMAGE" \
  python -m gamecraft_bench.verifier \
    --project /workspace/game \
    --rubric /tests/rubric.json \
    --output /logs/verifier \
    --judge stub \
    --judge-model 1.0

test -s "$OUTPUT/breakdown.json"
test -s "$OUTPUT/reward.txt"
find "$OUTPUT/demos" -name '*.mp4' -type f -size +0c | grep -q .

