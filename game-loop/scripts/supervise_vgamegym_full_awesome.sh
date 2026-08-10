#!/bin/zsh

# Keep the real, resumable full-dataset VGameGym workers alive.  A worker pass
# processes one shard and exits; subsequent passes are needed to retry saved
# artifacts whose evaluator suffered an infrastructure failure.

set -u
ROOT="/Users/wangxucong/Desktop/workspace/harness-game/game-loop"
PYTHON="/Users/wangxucong/Desktop/workspace/harness-game/.venv/bin/python"
OUTPUT="$ROOT/experiments/vgamegym-full-awesome"
MODELS=(kimi qwen glm deepseek)
SHARD_COUNT=4

has_screen() {
  screen -ls 2>/dev/null | rg -q "\.$1[[:space:]]"
}

has_worker() {
  ps -axo command= 2>/dev/null | rg -q \
    "(^|/)Python[^ ]* scripts/run_vgamegym_full_awesome\.py.*--model[ =]$1.*--output-root[ =]$OUTPUT.*--shard-index[ =]$2.*--shard-count[ =]$3"
}

while true; do
  "$ROOT/../.venv/bin/python" "$ROOT/scripts/reap_vgamegym_stale.py" --output-root "$OUTPUT" --timeout-seconds 750 >/dev/null 2>&1 || true
  all_done=1
  for model in $MODELS; do
    status_count=$(find "$OUTPUT/$model" -name status.json -type f 2>/dev/null | wc -l | tr -d ' ')
    running_count=$(find "$OUTPUT/$model" -name status.json -type f -print0 2>/dev/null | xargs -0 -r jq -r '.status // "unknown"' | rg -c '^running$' || true)
    if [[ "$status_count" -lt 2218 || "$running_count" -gt 0 ]]; then
      all_done=0
    fi
    shard_count=$SHARD_COUNT
    for shard in $(seq 0 $((shard_count - 1))); do
      session="vgg-final-$model-$shard"
      if has_screen "$session" && ! has_worker "$model" "$shard" "$shard_count"; then
        # A detached screen can outlive its Python process after a crash.
        # Remove only this named VGameGym session so it can be restarted.
        screen -S "$session" -X quit >/dev/null 2>&1 || true
      fi
      if ! has_screen "$session"; then
        screen -dmS "$session" /bin/zsh -lc "cd '$ROOT'; set -a; source .env.local; set +a; exec '$PYTHON' scripts/run_vgamegym_full_awesome.py --model '$model' --output-root '$OUTPUT' --shard-index '$shard' --shard-count '$shard_count' --evaluator-timeout 1800 --evaluator-retries 3 --retry-generation >> '$OUTPUT/$model-final-shard$shard.log' 2>&1"
      fi
    done
  done
  if [[ "$all_done" -eq 1 ]]; then
    exit 0
  fi
  sleep 60
done
