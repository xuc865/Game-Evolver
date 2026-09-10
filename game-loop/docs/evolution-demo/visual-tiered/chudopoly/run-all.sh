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
PIDS=()
cleanup() { for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

kill_port 9380
(cd /Users/wangxucong/Desktop/workspace/harness-game/game-loop/docs/evolution-demo/visual-tiered/chudopoly/epoch-000 && PORT=9380 node --no-warnings server.js) &
PIDS+=("$!")
open "http://127.0.0.1:9380/" 2>/dev/null || true
kill_port 9381
(cd /Users/wangxucong/Desktop/workspace/harness-game/game-loop/docs/evolution-demo/visual-tiered/chudopoly/epoch-001 && PORT=9381 node --no-warnings server.js) &
PIDS+=("$!")
open "http://127.0.0.1:9381/" 2>/dev/null || true
kill_port 9382
(cd /Users/wangxucong/Desktop/workspace/harness-game/game-loop/docs/evolution-demo/visual-tiered/chudopoly/epoch-002 && PORT=9382 node --no-warnings server.js) &
PIDS+=("$!")
open "http://127.0.0.1:9382/" 2>/dev/null || true
kill_port 9383
(cd /Users/wangxucong/Desktop/workspace/harness-game/game-loop/docs/evolution-demo/visual-tiered/chudopoly/epoch-003 && PORT=9383 node --no-warnings server.js) &
PIDS+=("$!")
open "http://127.0.0.1:9383/" 2>/dev/null || true

echo "All four visual tiers are running. Press Ctrl-C to stop them."
wait
