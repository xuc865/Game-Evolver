#!/usr/bin/env bash
set -euo pipefail

ARTIFACT='/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/runs/codex-100-epoch-continuation-20260908/iron-breakout-fps/epoch_005/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact'
ENTRY='index.html'
PORT=8852

if [[ ! -f "$ARTIFACT/$ENTRY" ]]; then
  echo "Artifact entrypoint missing: $ARTIFACT/$ENTRY" >&2
  exit 1
fi

echo "Launching Iron Breakout FPS / epoch 5"
echo "Artifact: $ARTIFACT"
echo "Open: http://127.0.0.1:$PORT/$ENTRY"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ARTIFACT" >/tmp/evolution-demo-iron-breakout-fps-5.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM
sleep 0.5
open "http://127.0.0.1:$PORT/$ENTRY"
wait "$SERVER_PID"
