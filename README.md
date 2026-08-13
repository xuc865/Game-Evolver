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

## Linux quick deploy for NL2Repo

This is the shortest path for a Linux worker that only needs to connect the
codebase and run the public `nl2repo` queue.

### 1. Clone and create the Python environment

```bash
git clone git@github.com:xuc865/loop-evolver.git harness-game
cd harness-game
git submodule update --init --recursive

cd game-loop
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip wheel
python -m pip install -e .
```

If the machine does not have Python 3.11, install it first. The package metadata
requires Python `>=3.11`.

### 2. Install system dependencies

`nl2repo` uses Docker to run the official project evaluators, so the Linux host
must have a working Docker daemon and enough disk space for benchmark images.

```bash
docker info
python - <<'PY'
import sys
print(sys.version)
PY
```

The runner keeps mutable state under `game-loop/experiments/`. Do not run it
from inside `third_party/` or another read-only benchmark checkout.

### 3. Put NL2RepoBench in the expected location

`NL2RepoBench` is not tracked by this repository. The bridge expects official
tasks at:

```text
game-loop/third_party/NL2RepoBench/NL2RepoBench_src/test_files/
```

On the Linux worker, either copy an existing verified checkout to that path, or
clone the source mirror used by the project and check out the verified revision:

```bash
mkdir -p third_party
git clone https://github.com/EnvCommons/NL2RepoBench.git third_party/NL2RepoBench
cd third_party/NL2RepoBench
git checkout 61d26cc0abd084ece8f5d805dcbd3f806a291f15
cd ../../

test -d third_party/NL2RepoBench/NL2RepoBench_src/test_files
test -f experiments/general-baseline/seed_nl2repo/start.md
```

If you copy the directory from another machine, preserve
`NL2RepoBench_src/test_files/*/start.md`, `test_commands.json`,
`test_files.json`, and `test_case_count.txt`.

### 4. Rewrite local absolute paths in nl2repo configs

The checked-in `nl2repo-L4_*.json` files may contain the original development
machine path. Rewrite `benchmark.options.root` to the Linux checkout's
`game-loop` directory before launching:

```bash
python - <<'PY'
import json
from pathlib import Path

root = Path.cwd().resolve()
for path in Path("experiments/configs-v4").glob("nl2repo-L4*.json"):
    value = json.loads(path.read_text(encoding="utf-8"))
    value.setdefault("benchmark", {}).setdefault("options", {})["root"] = str(root)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("updated", path)
PY
```

### 5. Configure model credentials or local endpoints

The queue runner loads `game-loop/.env.local` if it exists. Keep secrets there
or export them in the shell. Examples:

```bash
# Keyless/internal OpenAI-compatible endpoints can be set in the config JSON.
# For hosted providers, export only the key you need:
export DEEPSEEK_API_KEY=...
export CODEX_API_KEY_CLAUDE=...
export CODEX_API_KEY_GPT55=...

# Optional progress log location:
export GENERAL_BENCH_PROGRESS_FILE="$PWD/experiments/general-baseline-runs/progress.txt"
```

Do not commit `.env.local` or run output directories.

### 6. Smoke-check and launch nl2repo

From `game-loop/`:

```bash
source .venv/bin/activate
export PYTHONPATH="$PWD"

# Show discovered tasks and available queues.
python scripts/run_new_bench_experiments.py --dry-run

# Run one model's NL2Repo queue. Replace the model prefix as needed:
python -u scripts/run_new_bench_experiments.py --queue deepseek_v4_nl2repo
# Other valid nl2repo queues include:
#   kimi_nl2repo
#   qwen3.6-27b_nl2repo
#   glm5.2_nl2repo
#   claude_nl2repo
#   gpt55_nl2repo
```

Outputs are written under:

```text
game-loop/experiments/general-baseline-runs/new_bench_<model>_nl2repo-resume-*/
```

Each case has a per-task log and, once the bridge reaches official evaluation,
an `nl2repo_execution.json` manifest under the candidate directory. A quick
health check is:

```bash
find experiments/general-baseline-runs -path '*nl2repo_execution.json' | tail
```

If Docker is missing, the official NL2Repo evaluator will fail with an
infrastructure error rather than a benchmark score. If no tasks are discovered,
check the `third_party/NL2RepoBench/NL2RepoBench_src/test_files` path.

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
