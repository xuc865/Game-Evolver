#!/bin/zsh

set -u
ROOT="/Users/wangxucong/Desktop/workspace/harness-game/game-loop"
PYTHON="$ROOT/../.venv/bin/python"
VGG_BASELINE="$ROOT/experiments/vgamegym-full-baseline"
VGG_AWESOME="$ROOT/experiments/vgamegym-full-claude-gpt-awesome"
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
        --evaluator-retries 3 --retry-generation >> "$LOG" 2>&1
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
  for bench in gcbench gdbench verigame; do
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

# One provider request at a time. Every invocation is a full queue; the
# runner discovers prior task state and resumes it instead of using smoke data.
run_vgg claude "$VGG_BASELINE" baseline
run_vgg gpt55 "$VGG_BASELINE" baseline
run_vgg claude "$VGG_AWESOME" awesome
run_vgg gpt55 "$VGG_AWESOME" awesome
run_matrix claude baseline
run_matrix gpt55 baseline
run_matrix claude awesome
run_matrix gpt55 awesome
print -r -- "[$(date '+%F %T')] supervisor finished" >> "$LOG"
