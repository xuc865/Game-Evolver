#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GAMECRAFT_ROOT="${GAMECRAFT_ROOT:-$PROJECT_ROOT/../gcbench}"
GAMECRAFT_COMMIT="21028dfa726b10e340f102961aba21ca8016499b"
VENV="${GAMECRAFT_VENV:-$PROJECT_ROOT/.venvs/gamecraft-bench}"
IMAGE="${GAMECRAFT_IMAGE:-harness-game/gamecraft-bench-e2e:21028df}"
MODE="local"

command -v git >/dev/null || { echo "git is required" >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 2; }

if [ ! -d "$GAMECRAFT_ROOT/.git" ]; then
  bash "$SCRIPT_DIR/setup.sh"
fi
test -d "$GAMECRAFT_ROOT/.git"
test "$(git -C "$GAMECRAFT_ROOT" rev-parse HEAD)" = "$GAMECRAFT_COMMIT"
test -f "$GAMECRAFT_ROOT/gamecraft_bench/verifier/cli.py"

PY312=""
for candidate in python3.12 python3.13 uv; do
  if [ "$candidate" = "uv" ] && command -v uv >/dev/null 2>&1; then
    uv python install 3.12 >/dev/null 2>&1 || true
    PY312="$(uv python find 3.12 2>/dev/null || true)"
    [ -n "$PY312" ] && break
  elif command -v "$candidate" >/dev/null 2>&1; then
    version="$("$candidate" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
    major="${version%%.*}"
    minor="${version#*.}"
    if [ "$major" -ge 3 ] && [ "$minor" -ge 12 ]; then
      PY312="$(command -v "$candidate")"
      break
    fi
  fi
done

if [ -n "$PY312" ]; then
  mkdir -p "$(dirname "$VENV")"
  if [ ! -x "$VENV/bin/python" ]; then
    "$PY312" -m venv "$VENV"
  fi
  "$VENV/bin/python" -m pip install --upgrade pip wheel >/dev/null
  if "$VENV/bin/python" -m pip install -e "$GAMECRAFT_ROOT" 'harbor==0.7.1' >/dev/null 2>&1; then
    "$VENV/bin/python" -m pip install 'openai>=1.55.0' >/dev/null 2>&1 || true
    "$VENV/bin/python" -c "import gamecraft_bench.verifier, harbor"
    MODE="local"
  else
    MODE="docker"
  fi
else
  MODE="docker"
fi

if [ "$MODE" = "docker" ]; then
  command -v docker >/dev/null || { echo "docker is required for GameCraftBench on Python <3.12" >&2; exit 2; }
  docker info >/dev/null
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    bash "$SCRIPT_DIR/setup.sh"
  fi
  docker run --rm --platform linux/amd64 "$IMAGE" python -c "import harbor, gamecraft_bench.verifier"
fi

echo "GAMECRAFT_MODE=$MODE"
echo "GAMECRAFT_VENV=$VENV"
echo "GAMECRAFT_ROOT=$GAMECRAFT_ROOT"
echo "GAMECRAFT_COMMIT=$GAMECRAFT_COMMIT"
echo "GAMECRAFT_IMAGE=$IMAGE"
echo "GameCraftBench official environment doctor: OK"
