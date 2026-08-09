#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GAMECRAFT_ROOT="${GAMECRAFT_ROOT:-$PROJECT_ROOT/../gcbench}"
GAMECRAFT_REPO="https://github.com/FreedomIntelligence/gamecraft-bench.git"
GAMECRAFT_COMMIT="21028dfa726b10e340f102961aba21ca8016499b"
IMAGE="${GAMECRAFT_IMAGE:-harness-game/gamecraft-bench-e2e:21028df}"

command -v git >/dev/null || { echo "git is required" >&2; exit 2; }
command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }
docker info >/dev/null

mkdir -p "$GAMECRAFT_ROOT"
if [ ! -d "$GAMECRAFT_ROOT/.git" ]; then
  if find "$GAMECRAFT_ROOT" -mindepth 1 -maxdepth 1 | grep -q .; then
    echo "refusing to initialize non-empty non-git directory: $GAMECRAFT_ROOT" >&2
    exit 2
  fi
  git -C "$GAMECRAFT_ROOT" init
  git -C "$GAMECRAFT_ROOT" remote add origin "$GAMECRAFT_REPO"
fi
git -C "$GAMECRAFT_ROOT" fetch --depth 1 origin "$GAMECRAFT_COMMIT"
if [ -n "$(git -C "$GAMECRAFT_ROOT" status --porcelain)" ]; then
  echo "refusing to replace local changes in $GAMECRAFT_ROOT" >&2
  exit 2
fi
git -C "$GAMECRAFT_ROOT" checkout --detach "$GAMECRAFT_COMMIT"

docker build --platform linux/amd64 \
  --label "gamecraft-bench.commit=$GAMECRAFT_COMMIT" \
  -t "$IMAGE" "$SCRIPT_DIR"

echo "GAMECRAFT_ROOT=$GAMECRAFT_ROOT"
echo "GAMECRAFT_COMMIT=$(git -C "$GAMECRAFT_ROOT" rev-parse HEAD)"
echo "GAMECRAFT_IMAGE=$IMAGE"

