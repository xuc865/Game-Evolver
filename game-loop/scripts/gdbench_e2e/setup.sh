#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GDBENCH_ROOT="${GDBENCH_ROOT:-$PROJECT_ROOT/../third_party/gamedevbench}"
GODOT_WRAPPER="$SCRIPT_DIR/godot_docker.sh"
IMAGE="${GAMECRAFT_IMAGE:-harness-game/gamecraft-bench-e2e:21028df}"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }
docker info >/dev/null
test -f "$GDBENCH_ROOT/gamedevbench/src/benchmark_runner.py"
test -x "$GODOT_WRAPPER" || chmod +x "$GODOT_WRAPPER"
python3 -m pip install --user 'pyyaml>=6.0' >/dev/null 2>&1 || python3 -m pip install 'pyyaml>=6.0' >/dev/null
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  bash "$PROJECT_ROOT/scripts/gcbench_e2e/setup.sh"
fi
"$GODOT_WRAPPER" --version >/dev/null

echo "GDBENCH_ROOT=$GDBENCH_ROOT"
echo "GODOT_EXEC_PATH=$GODOT_WRAPPER"
echo "GameDevBench docker-backed environment: OK"
