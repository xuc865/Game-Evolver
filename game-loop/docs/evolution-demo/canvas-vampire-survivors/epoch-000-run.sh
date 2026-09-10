#!/usr/bin/env bash
set -euo pipefail
ARTIFACT='/Users/wangxucong/Desktop/workspace/harness-game/work/open-source-games-candidates/canvas-vampire-survivors'
ENTRY='index.html'
PORT='9322'
[[ -f "$ARTIFACT/$ENTRY" ]] || { echo "Artifact entrypoint missing: $ARTIFACT/$ENTRY" >&2; exit 1; }
echo "Launching Canvas Vampire Survivors / epoch 0"
echo "Artifact: $ARTIFACT"
echo "Open: http://127.0.0.1:$PORT/$ENTRY"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ARTIFACT" >/tmp/evolution-demo-0.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM
sleep 0.5
open "http://127.0.0.1:$PORT/$ENTRY" 2>/dev/null || true
wait "$SERVER_PID"
