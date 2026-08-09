#!/usr/bin/env bash
set -euo pipefail

IMAGE="${GAMECRAFT_IMAGE:-harness-game/gamecraft-bench-e2e:21028df}"
MOUNTS=()
WORKDIR=""
REWRITTEN=()
args=("$@")
index=0

while [ "$index" -lt "${#args[@]}" ]; do
  arg="${args[$index]}"
  if [ "$arg" = "--path" ] && [ $((index + 1)) -lt "${#args[@]}" ]; then
    path="${args[$((index + 1))]}"
    abs="$(cd "$path" && pwd)"
    parent="$(dirname "$abs")"
    base="$(basename "$abs")"
    mount="/mnt/task_$(echo "$abs" | shasum | awk '{print $1}')"
    MOUNTS+=("-v" "$parent:$mount")
    REWRITTEN+=("--path" "$mount/$base")
    WORKDIR="$mount/$base"
    index=$((index + 2))
    continue
  fi
  REWRITTEN+=("$arg")
  index=$((index + 1))
done

if [ "${#MOUNTS[@]}" -eq 0 ]; then
  exec docker run --rm --platform linux/amd64 "$IMAGE" godot "${REWRITTEN[@]}"
fi

exec docker run --rm --platform linux/amd64 "${MOUNTS[@]}" -w "$WORKDIR" "$IMAGE" godot "${REWRITTEN[@]}"
