#!/usr/bin/env zsh
set -e
cd /Users/wangxucong/Desktop/workspace/harness-game/game-loop
exec env GAMECRAFT_BENCH_JUDGE_OPENAI_BASE_URL=http://29.116.237.141:8080/v1 GAMECRAFT_BENCH_JUDGE_OPENAI_API_KEY=EMPTY GAMECRAFT_BENCH_JUDGE_MODEL=Qwen3.8-27B-node1 .venv/bin/python -u scripts/run_v030_complex_10_epochs.py "$@"
