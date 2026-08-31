#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <combat|ai|economy|objectives|hud|replay>" >&2
  exit 2
fi

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
exec "$ROOT/tools/godot" --headless --path "$ROOT/game" \
  --script "$ROOT/game/tests/module_contract_check.gd" -- --module "$1"
