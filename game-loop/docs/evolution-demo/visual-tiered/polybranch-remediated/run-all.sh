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

kill_port 9390
(cd /Users/wangxucong/Desktop/workspace/harness-game/game-loop/docs/evolution-demo/visual-tiered/polybranch-remediated/epoch-000 && python3 -m http.server 9390 --bind 127.0.0.1) &
PIDS+=("$!")
open "http://127.0.0.1:9390/index.html" 2>/dev/null || true
kill_port 9391
(cd /Users/wangxucong/Desktop/workspace/harness-game/game-loop/docs/evolution-demo/visual-tiered/polybranch-remediated/epoch-001 && python3 -m http.server 9391 --bind 127.0.0.1) &
PIDS+=("$!")
open "http://127.0.0.1:9391/index.html" 2>/dev/null || true
kill_port 9392
(cd /Users/wangxucong/Desktop/workspace/harness-game/game-loop/docs/evolution-demo/visual-tiered/polybranch-remediated/epoch-002 && python3 -m http.server 9392 --bind 127.0.0.1) &
PIDS+=("$!")
open "http://127.0.0.1:9392/index.html" 2>/dev/null || true
kill_port 9393
(cd /Users/wangxucong/Desktop/workspace/harness-game/game-loop/docs/evolution-demo/visual-tiered/polybranch-remediated/epoch-003 && python3 -m http.server 9393 --bind 127.0.0.1) &
PIDS+=("$!")
open "http://127.0.0.1:9393/index.html" 2>/dev/null || true

echo "All four visual tiers are running. Press Ctrl-C to stop them."
wait
