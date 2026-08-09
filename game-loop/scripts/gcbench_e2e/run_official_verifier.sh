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

command -v docker >/dev/null 2>&1 || {
  echo "docker is required when local replay tools (Xvfb) are unavailable" >&2
  exit 2
}

# shellcheck disable=SC1091
source "$SCRIPT_DIR/export_judge_env.sh"

mkdir -p "$OUTPUT"
ARTIFACT="$(cd "$ARTIFACT" && pwd)"
OUTPUT="$(cd "$OUTPUT" && pwd)"
RUBRIC="$(cd "$GAMECRAFT_ROOT/tasks/$TASK/tests" && pwd)/rubric.json"
CONTAINER_OUTPUT="/tmp/gcbench_verifier_out"
rm -f "$OUTPUT/breakdown.json" "$OUTPUT/reward.txt" "$OUTPUT/judge_log.json" "$OUTPUT/ctrf.json"

JUDGE="${GAMECRAFT_BENCH_JUDGE:-openai}"
JUDGE_MODEL="${GAMECRAFT_BENCH_JUDGE_MODEL:-}"
JUDGE_INPUT_MODE="${GAMECRAFT_BENCH_JUDGE_INPUT_MODE:-vision}"
DOCKER_ENV=(
  -e "GAMECRAFT_BENCH_JUDGE=$JUDGE"
  -e "GAMECRAFT_BENCH_JUDGE_INPUT_MODE=$JUDGE_INPUT_MODE"
  -e "GAMECRAFT_BENCH_GODOT_BIN=/usr/local/bin/godot"
)
if [ -n "$JUDGE_MODEL" ]; then
  DOCKER_ENV+=(-e "GAMECRAFT_BENCH_JUDGE_MODEL=$JUDGE_MODEL")
fi
if [ -n "${OPENAI_API_KEY:-}" ]; then
  DOCKER_ENV+=(-e "OPENAI_API_KEY=$OPENAI_API_KEY")
fi
if [ -n "${OPENAI_BASE_URL:-}" ]; then
  DOCKER_ENV+=(-e "OPENAI_BASE_URL=$OPENAI_BASE_URL")
fi
if [ -n "${GAMECRAFT_BENCH_JUDGE_OPENAI_API_KEY:-}" ]; then
  DOCKER_ENV+=(-e "GAMECRAFT_BENCH_JUDGE_OPENAI_API_KEY=$GAMECRAFT_BENCH_JUDGE_OPENAI_API_KEY")
fi
if [ -n "${GAMECRAFT_BENCH_JUDGE_OPENAI_BASE_URL:-}" ]; then
  DOCKER_ENV+=(-e "GAMECRAFT_BENCH_JUDGE_OPENAI_BASE_URL=$GAMECRAFT_BENCH_JUDGE_OPENAI_BASE_URL")
fi

JUDGE_ARGS=(--judge "$JUDGE" --judge-input-mode "$JUDGE_INPUT_MODE")
if [ -n "$JUDGE_MODEL" ]; then
  JUDGE_ARGS+=(--judge-model "$JUDGE_MODEL")
fi

CID="$(
  docker create --platform linux/amd64 \
    "${DOCKER_ENV[@]}" \
    -v "$ARTIFACT:/workspace/game" \
    -v "$RUBRIC:/tests/rubric.json:ro" \
    -v "$GAMECRAFT_ROOT/gamecraft_bench:/opt/gamecraft-bench/gamecraft_bench:ro" \
    "$IMAGE" \
    python -m gamecraft_bench.verifier \
      --project /workspace/game \
      --rubric /tests/rubric.json \
      --output "$CONTAINER_OUTPUT" \
      "${JUDGE_ARGS[@]}"
)"

set +e
docker start -a "$CID"
verifier_rc=$?
set -e
docker cp "$CID:$CONTAINER_OUTPUT/." "$OUTPUT/" || {
  echo "docker verifier failed to export artifacts (rc=$verifier_rc)" >&2
  docker rm "$CID" >/dev/null || true
  exit 2
}
docker rm "$CID" >/dev/null

test -s "$OUTPUT/breakdown.json"
test -s "$OUTPUT/reward.txt"
exit "$verifier_rc"
