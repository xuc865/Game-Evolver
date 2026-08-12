#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="$ROOT_DIR/game-loop/scripts/run_new_model_experiments.py"
LOG_DIR="$ROOT_DIR/game-loop/experiments/full-matrix-launch"
LOCAL_ENV="$ROOT_DIR/game-loop/experiments/.env"
WATCHDOG_LOCK="$LOG_DIR/.awesome-gc-gd-watchdog"

mkdir -p "$LOG_DIR"

if ! mkdir "$WATCHDOG_LOCK" 2>/dev/null; then
  owner_pid="$(cat "$WATCHDOG_LOCK/pid" 2>/dev/null || true)"
  if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
    printf 'watchdog already running (pid=%s)\n' "$owner_pid"
    exit 0
  fi
  rm -f "$WATCHDOG_LOCK/pid"
  rmdir "$WATCHDOG_LOCK" 2>/dev/null || true
  mkdir "$WATCHDOG_LOCK"
fi
printf '%s\n' "$$" > "$WATCHDOG_LOCK/pid"
cleanup_watchdog_lock() {
  rm -f "$WATCHDOG_LOCK/pid"
  rmdir "$WATCHDOG_LOCK" 2>/dev/null || true
}
trap cleanup_watchdog_lock EXIT
trap 'exit 0' INT TERM

queues=(
  "glm5.2_gcbench_awesome:awesome-glm5-gc"
  "glm5.2_gdbench_awesome:awesome-glm5-gd"
  "kimi_gcbench_awesome:awesome-kimi-gc"
  "kimi_gdbench_awesome:awesome-kimi-gd"
  "qwen3.6-27b_gcbench_awesome:awesome-qwen-gc"
  "qwen3.6-27b_gdbench_awesome:awesome-qwen-gd"
  "deepseek_v4_gcbench_awesome:awesome-deepseek-gc"
  "deepseek_v4_gdbench_awesome:awesome-deepseek-gd"
  "claude_gcbench_awesome:awesome-claude-gc"
  "claude_gdbench_awesome:awesome-claude-gd"
  "gpt55_gcbench_awesome:awesome-gpt55-gc"
  "gpt55_gdbench_awesome:awesome-gpt55-gd"
)

screen_is_running() {
  local session="$1"
  local listing
  # screen -ls can return nonzero when stale sockets coexist with live ones.
  # Capture its output independently so pipefail cannot turn that into a
  # false "not running" result.
  listing="$(screen -ls 2>/dev/null || true)"
  grep "\.${session}[[:space:]]" >/dev/null <<< "$listing"
}

launch_one() {
  local spec="$1"
  local queue session log done_file command
  queue="${spec%%:*}"
  session="${spec##*:}"
  done_file="$LOG_DIR/${session}.done"

  if [[ -f "$done_file" ]]; then
    return
  fi
  if screen_is_running "$session"; then
    return
  fi

  log="$LOG_DIR/${session}.log"
  if [[ "$queue" == deepseek_* || "$queue" == claude_* || "$queue" == gpt55_* || "$queue" == qwen3.6-27b_* ]]; then
    if [[ ! -f "$LOCAL_ENV" ]]; then
      printf 'missing local credential file: %s\n' "$LOCAL_ENV" >&2
      return 1
    fi
    command="cd '$ROOT_DIR' && set -a && source '$LOCAL_ENV' && set +a && while true; do env PYTHONPATH=. python3 -u '$RUNNER' --queue '$queue' >> '$log' 2>&1; rc=\$?; if [[ \$rc -eq 0 ]]; then date -u '+%Y-%m-%dT%H:%M:%SZ' > '$done_file'; exit 0; fi; printf '[supervisor] %s exited rc=%s; restarting in 10s\\n' '$queue' \"\$rc\" >> '$log'; sleep 10; done"
  else
    command="cd '$ROOT_DIR' && while true; do env PYTHONPATH=. python3 -u '$RUNNER' --queue '$queue' >> '$log' 2>&1; rc=\$?; if [[ \$rc -eq 0 ]]; then date -u '+%Y-%m-%dT%H:%M:%SZ' > '$done_file'; exit 0; fi; printf '[supervisor] %s exited rc=%s; restarting in 10s\\n' '$queue' \"\$rc\" >> '$log'; sleep 10; done"
  fi
  screen -dmS "$session" /bin/bash -lc "$command"
  printf 'launched: %s (%s)\n' "$session" "$queue"
}

printf 'awesome GC/GD watchdog started (pid=%s)\n' "$$"
while true; do
  pending=0
  for spec in "${queues[@]}"; do
    session="${spec##*:}"
    if [[ ! -f "$LOG_DIR/${session}.done" ]]; then
      pending=$((pending + 1))
      launch_one "$spec"
    fi
  done

  if [[ "$pending" -eq 0 ]]; then
    printf 'all awesome GC/GD queues completed\n'
    break
  fi
  sleep 30
done

screen -ls
