#!/usr/bin/env bash
set -euo pipefail

ARTIFACT='/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/runs/codex-100-epoch-continuation-20260908/canvas-vampire-survivors/epoch_015/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact'
ENTRY='index.html'
PORT=8758

if [[ ! -f "$ARTIFACT/$ENTRY" ]]; then
  echo "Artifact entrypoint missing: $ARTIFACT/$ENTRY" >&2
  exit 1
fi

echo "Launching Canvas Vampire Survivors / epoch 15"
echo "Artifact: $ARTIFACT"
echo "Open: http://127.0.0.1:$PORT/$ENTRY"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ARTIFACT" >/tmp/evolution-demo-canvas-vampire-survivors-15.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM
sleep 0.5
open "http://127.0.0.1:$PORT/$ENTRY"
wait "$SERVER_PID"
