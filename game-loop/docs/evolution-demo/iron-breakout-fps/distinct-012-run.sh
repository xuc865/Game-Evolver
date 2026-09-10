#!/usr/bin/env bash
set -euo pipefail
ARTIFACT='/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/runs/dual-track-open-candidates-20260906-v3-deep-probes/iron-breakout-fps/epoch_012/pair/candidate-runtime/workspace/game'
ENTRY='index.html'
PORT=$((9400 + 12))
[[ -f "$ARTIFACT/$ENTRY" ]] || { echo "Artifact entrypoint missing: $ARTIFACT/$ENTRY" >&2; exit 1; }
echo "Launching Iron Breakout Fps epoch 12: http://127.0.0.1:$PORT/$ENTRY"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ARTIFACT" >/tmp/evolution-distinct-12.log 2>&1 &
PID=$!; trap 'kill "$PID" 2>/dev/null || true' EXIT INT TERM
sleep .5; open "http://127.0.0.1:$PORT/$ENTRY" 2>/dev/null || true; wait "$PID"
