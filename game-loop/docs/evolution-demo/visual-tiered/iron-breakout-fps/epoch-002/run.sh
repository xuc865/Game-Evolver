#!/usr/bin/env bash
set -euo pipefail
kill_port() {
  local port="$1" pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Stopping old listener(s) on port $port: $pids"
    kill $pids 2>/dev/null || true
    sleep 0.3
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [[ -z "$pids" ]] || kill -9 $pids 2>/dev/null || true
  fi
}
cd /Users/wangxucong/Desktop/workspace/harness-game/game-loop/docs/evolution-demo/visual-tiered/iron-breakout-fps/epoch-002
PORT=9362
kill_port "$PORT"
python3 -m http.server "$PORT" --bind 127.0.0.1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM
sleep 0.5
open "http://127.0.0.1:9362/index.html" 2>/dev/null || true
wait "$SERVER_PID"
