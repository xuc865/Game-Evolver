#!/usr/bin/env bash
set -u
cd /Users/wangxucong/Desktop/workspace/harness-game/game-loop
export PYTHONPATH=/Users/wangxucong/Desktop/workspace/harness-game/game-loop
export PYTHONUNBUFFERED=1
export GAME_LOOP_USE_AWESOME_GAMEDEV_SKILLS=1
exec /Library/Developer/CommandLineTools/usr/bin/python3 -u scripts/supervise_verigame_public_awesome.py \
  --output-root .baseline-agent-runs/verigame-public-awesome \
  --log-root experiments/full-matrix-launch \
  --timeout 900
