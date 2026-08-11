#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="$ROOT_DIR/game-loop/scripts/run_new_model_experiments.py"
LOG_DIR="$ROOT_DIR/game-loop/experiments/full-matrix-launch"
LOCAL_ENV="$ROOT_DIR/game-loop/experiments/.env"

mkdir -p "$LOG_DIR"

queues=(
  "glm5.2_gcbench_awesome:awesome-glm5-gc"
  "glm5.2_gdbench_awesome:awesome-glm5-gd"
  "kimi_gcbench_awesome:awesome-kimi-gc"
  "kimi_gdbench_awesome:awesome-kimi-gd"
  "qwen3.6-27b_gcbench_awesome:awesome-qwen-gc"
  "qwen3.6-27b_gdbench_awesome:awesome-qwen-gd"
  "claude_gcbench_awesome:awesome-claude-gc"
  "claude_gdbench_awesome:awesome-claude-gd"
  "gpt55_gcbench_awesome:awesome-gpt55-gc"
  "gpt55_gdbench_awesome:awesome-gpt55-gd"
)

for spec in "${queues[@]}"; do
  queue="${spec%%:*}"
  session="${spec##*:}"
  if screen -ls 2>/dev/null | grep -q "\.${session}[[:space:]]"; then
    printf 'already running: %s\n' "$session"
    continue
  fi

  log="$LOG_DIR/${session}.log"
  if [[ "$queue" == claude_* ]]; then
    if [[ ! -f "$LOCAL_ENV" ]]; then
      printf 'missing local credential file: %s\n' "$LOCAL_ENV" >&2
      exit 1
    fi
    command="cd '$ROOT_DIR' && set -a && source '$LOCAL_ENV' && set +a && exec env PYTHONPATH=. python3 -u '$RUNNER' --queue '$queue' >> '$log' 2>&1"
  else
    command="cd '$ROOT_DIR' && exec env PYTHONPATH=. python3 -u '$RUNNER' --queue '$queue' >> '$log' 2>&1"
  fi
  screen -dmS "$session" /bin/bash -lc "$command"
  printf 'launched: %s (%s)\n' "$session" "$queue"
done

screen -ls
