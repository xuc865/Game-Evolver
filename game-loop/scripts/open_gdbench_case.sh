#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "usage: $0 task_0077 [task_0132 ...]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GDBENCH_ROOT="${GDBENCH_ROOT:-$PROJECT_ROOT/third_party/gamedevbench}"
TASK_COLLECTION="${GDBENCH_TASK_COLLECTION:-tasks}"
VIEW_ROOT="${GDBENCH_VIEW_ROOT:-$PROJECT_ROOT/.tmp/gdbench-view}"

TASK_NAME="$1"
TASK_DIR="$(
  python "$SCRIPT_DIR/gdbench_prepare_task.py" \
    --gdbench-root "$GDBENCH_ROOT" \
    --task-collection "$TASK_COLLECTION" \
    --task-name "$TASK_NAME" \
    --output-dir "$VIEW_ROOT/$TASK_NAME"
)"

GODOT_BIN="$("$SCRIPT_DIR/setup_godot.sh")"
echo "opening $TASK_NAME from $TASK_DIR"
exec "$GODOT_BIN" --editor --path "$TASK_DIR"
