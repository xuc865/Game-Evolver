#!/usr/bin/env bash
# Bootstrap and start isolated gcbench produce runs in parallel.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export PYTHONPATH="$ROOT"

MODELS=(deepseek kimi qwen glm)
export GAME_LOOP_TEXT_ONLY="${GAME_LOOP_TEXT_ONLY:-1}"

if [[ -f "$ROOT/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.local"
  set +a
fi

preflight_provider() {
  local provider="$1"
  local attempt
  for attempt in 1 2 3 4; do
    if python3 -m game_loop.inner_loop smoke-provider \
      --provider "$provider" --timeout 120 >/dev/null; then
      echo "[parallel] provider preflight passed: $provider (attempt $attempt)"
      return 0
    fi
    sleep "$((attempt * 2))"
  done
  echo "[parallel] provider preflight failed after 4 attempts: $provider" >&2
  return 1
}

stop_run() {
  local run_dir="$1"
  python3 "$ROOT/experiments/scripts/stop_run_processes.py" --run-dir "$run_dir"
}

echo "[parallel] validating all real providers before touching active runs..."
for model in "${MODELS[@]}"; do
  preflight_provider "$model"
done

echo "[parallel] stopping old runs..."
stop_run "$ROOT/experiments/runs/gcbench-harness-evolve"
for model in "${MODELS[@]}"; do
  stop_run "$ROOT/experiments/runs/gcbench-produce-${model}"
done
sleep 2

echo "[parallel] bootstrapping run dirs..."
python3 "$ROOT/experiments/scripts/bootstrap_produce_run.py" "${MODELS[@]}"

echo "[parallel] starting daemons..."
for model in "${MODELS[@]}"; do
  run_dir="$ROOT/experiments/runs/gcbench-produce-${model}"
  python3 "$run_dir/run_experiment_daemon.py" start
  sleep 1
done

sleep 5
echo ""
echo "=== status ==="
for model in "${MODELS[@]}"; do
  run_dir="$ROOT/experiments/runs/gcbench-produce-${model}"
  echo "--- $model ($run_dir) ---"
  python3 "$run_dir/run_experiment_daemon.py" status || true
  pgrep -fl "harness-self-supervise" | grep "gcbench-produce-${model}" | head -1 || echo "orchestrator: pending"
done
