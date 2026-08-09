#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GAMECRAFT_ROOT="${GAMECRAFT_ROOT:-$PROJECT_ROOT/../gcbench}"
GAMECRAFT_COMMIT="21028dfa726b10e340f102961aba21ca8016499b"
IMAGE="${GAMECRAFT_IMAGE:-harness-game/gamecraft-bench-e2e:21028df}"

command -v docker >/dev/null
docker info >/dev/null
test -d "$GAMECRAFT_ROOT/.git"
test "$(git -C "$GAMECRAFT_ROOT" rev-parse HEAD)" = "$GAMECRAFT_COMMIT"
test -f "$GAMECRAFT_ROOT/gamecraft_bench/verifier/cli.py"
test -f "$GAMECRAFT_ROOT/tasks/platformer-wall-dancer/tests/rubric.json"
test "$(docker image inspect "$IMAGE" --format '{{ index .Config.Labels "gamecraft-bench.commit" }}')" = "$GAMECRAFT_COMMIT"

docker run --rm --platform linux/amd64 "$IMAGE" bash -lc '
  set -euo pipefail
  test "$(git -C /opt/gamecraft-bench rev-parse HEAD)" = "21028dfa726b10e340f102961aba21ca8016499b"
  python -c "import harbor, gamecraft_bench.verifier"
  harbor --version
  test "$(godot --version)" = "4.6.2.stable.official.71f334935"
  command -v Xvfb
  command -v xdotool
  command -v ffmpeg
  python -c "from gamecraft_bench.verifier.judges.stub import StubJudge; assert StubJudge(model=\"1.0\")._fixed_score == 1.0"
'

echo "GameCraftBench official environment doctor: OK"

