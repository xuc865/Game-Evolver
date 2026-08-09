# loop-evolver

AgentX-style two-timescale harness evolution for game-making agents (OpenGame backbone) across four benchmarks:

- **GameCraftBench** (`gcbench/`)
- **GameDevBench** (`third_party/gamedevbench/`, symlinked as `gdbench/`)
- **VGameGym** (`game-loop/third_party/SKYLENAGE-GameCodeGym/`)
- **VeriGame / GameGen-Verifier** (`game-loop/third_party/GameGen-Verifier/`)

## Layout

| Path | Purpose |
|------|---------|
| `game-loop/` | Main Python package: L0–L4 loop, AgentX nested evolution, benchmark bridges, smoke tests |
| `gcbench/` | Pinned [GameCraftBench](https://github.com/FreedomIntelligence/gamecraft-bench) checkout |
| `third_party/OpenGame/` | OpenGame SDK (build with `npm install && npm run build`) |
| `third_party/gamedevbench/` | GameDevBench source; task zips are not in git — download separately |

## Quick start

```bash
cd game-loop

# OpenGame SDK
cd ../third_party/OpenGame && npm ci && npm run build && cd ../../game-loop

# GameCraftBench Docker environment (macOS / Python < 3.12)
bash scripts/gcbench_e2e/setup_local.sh

# GameDevBench tasks (not tracked in git)
# Clone or copy task zips into third_party/gamedevbench/tasks/

# VGameGym dataset
export HF_TOKEN=...   # optional for public dataset
python3 scripts/download_vgamegym_dataset.py

# Backbone credentials (example)
export DEEPSEEK_API_KEY=...
export GODOT_EXEC_PATH="$PWD/scripts/gdbench_e2e/godot_docker.sh"

# Comprehensive smoke
PYTHONPATH=. python3 scripts/run_comprehensive_smoke.py --provider deepseek --quick
```

## Backbone providers

Configured in `game-loop/game_loop/runtime/providers.py`:

| Provider | Model | Endpoint |
|----------|-------|----------|
| deepseek | deepseek-v4-flash | `https://api.deepseek.com` |
| kimi | Kimi-K2.7-Code | `http://29.116.237.135:8080/v1` |
| glm | GLM-5.2-W4AFP8-node6 | `http://29.116.237.5:8080/v1` |
| qwen | Qwen3.6-27B | `http://29.116.237.141:8080/v1` |

## AgentX nested evolution

```bash
PYTHONPATH=. python3 -m game_loop agentx-nested-init \
  --run-dir /tmp/agentx-run --config experiments/configs-v4/gcbench-L4_kimi.json

PYTHONPATH=. python3 -m game_loop agentx-nested-epoch \
  --run-dir /tmp/agentx-run \
  --config experiments/configs-v4/gcbench-L4_kimi.json \
  --epoch 1 \
  --task-source /path/to/task \
  --seed-artifact /path/to/seed
```

## Tests

```bash
cd game-loop
PYTHONPATH=. python3 -m unittest discover -s tests -q
PYTHONPATH=. python3 experiments/generate_all_configs.py
```
