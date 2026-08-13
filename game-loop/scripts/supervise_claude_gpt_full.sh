#!/bin/zsh

set -u
ROOT="/Users/wangxucong/Desktop/workspace/harness-game/game-loop"
PYTHON="$ROOT/../.venv/bin/python"
VGG_BASELINE="$ROOT/experiments/vgamegym-claude-gpt-baseline-v1"
VGG_AWESOME="$ROOT/experiments/vgamegym-claude-gpt-awesome-v1"
RUNNER="$ROOT/scripts/run_new_model_experiments.py"
LOCK="$ROOT/experiments/full-matrix-launch/.claude-gpt-full.lock"
LOG="$ROOT/experiments/full-matrix-launch/claude-gpt-full.log"

if ! mkdir "$LOCK" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
print -r -- "[$(date '+%F %T')] supervisor started pid=$$" >> "$LOG"

run_vgg() {
  local model="$1" root="$2" arm="$3"
  mkdir -p "$root"
  [[ "$root" == "$VGG_AWESOME" ]] && print -r -- 8 > "$root/.canonical_shard_count"
  [[ "$root" == "$VGG_BASELINE" ]] && print -r -- 4 > "$root/.canonical_shard_count"
  local shard_count=4
  [[ "$root" == "$VGG_AWESOME" ]] && shard_count=8
  for shard in $(seq 0 $((shard_count - 1))); do
    while true; do
      set -a; source "$ROOT/.env.local"; set +a
      "$PYTHON" "$ROOT/scripts/run_vgamegym_full_awesome.py" \
        --model "$model" --output-root "$root" --shard-index "$shard" \
        --shard-count "$shard_count" --evaluator-timeout 1800 \
        --evaluator-retries 3 --retry-generation \
        $([[ "$arm" == "baseline" ]] && print -- --baseline) >> "$LOG" 2>&1
      local rc=$?
      if [[ "$rc" -eq 0 ]]; then
        break
      fi
      print -r -- "[$(date '+%F %T')] vgg model=$model arm=$arm shard=$shard rc=$rc; retrying after cooldown" >> "$LOG"
      sleep 120
    done
  done
}

run_matrix() {
  local model="$1" arm="$2"
  local flag=""
  [[ "$arm" == "awesome" ]] && flag="--awesome-skills"
  for bench in verigame; do
    while true; do
      set -a; source "$ROOT/.env.local"; set +a
      "$PYTHON" -u "$RUNNER" --queue "${model}_${bench}" $flag >> "$LOG" 2>&1
      local rc=$?
      if [[ "$rc" -eq 0 ]]; then
        break
      fi
      print -r -- "[$(date '+%F %T')] matrix model=$model arm=$arm bench=$bench rc=$rc; retrying after cooldown" >> "$LOG"
      sleep 120
    done
  done
}

# Claude and GPT use independent provider lanes. Within each lane, keep one
# request active at a time; every queue is resumable from retained evidence.
run_model_lane() {
  local model="$1"
  run_vgg "$model" "$VGG_BASELINE" baseline
  run_vgg "$model" "$VGG_AWESOME" awesome
  run_matrix "$model" baseline
  run_matrix "$model" awesome
}

run_model_lane claude &
claude_pid=$!
run_model_lane gpt55 &
gpt55_pid=$!
wait "$claude_pid"
claude_rc=$?
wait "$gpt55_pid"
gpt55_rc=$?
print -r -- "[$(date '+%F %T')] supervisor finished" >> "$LOG"
[[ "$claude_rc" -eq 0 && "$gpt55_rc" -eq 0 ]]
