# Unified OpenGame inner runtime

This layer runs game-making episodes only. Harness evolution is deliberately out of scope.
The official benchmark evaluator remains outside OpenGame and is invoked after the maker
submission has been frozen.

## Build a pinned OpenGame SDK

`@opengame/sdk` is not assumed to exist on the npm registry. Build the official repository
at a pinned commit and point the profile at its output:

```bash
git clone https://github.com/leigest519/OpenGame.git
cd OpenGame
git checkout c54307efe1dab927e7fc52dbb92af6b3df1d1c66
npm install
npm run build
```

Set these absolute paths in `opengame-profile.json`:

```json
{
  "sdk_module": "/absolute/OpenGame/packages/sdk-typescript/dist/index.mjs",
  "opengame_executable": "/absolute/OpenGame/packages/cli/dist/index.js",
  "system_prompt_path": "/absolute/OpenGame/agent-test/prompts/custom.md",
  "system_prompt_variables": {
    "{TEMPLATES_DIR}": "/absolute/OpenGame/agent-test/templates",
    "{DOCS_DIR}": "/absolute/OpenGame/agent-test/docs"
  }
}
```

Credentials such as `OPENAI_API_KEY` are inherited from the invoking process unless explicitly
configured through a named backbone. Credential-shaped keys are rejected in profile `environment`;
credentials are read only from the invoking process and are never written to requests or manifests.

## Backbone providers

Four OpenAI-compatible provider profiles are included under
`experiments/inner-agent/backbones/`. Set credentials only in the shell:

| Provider | Credential environment | Optional endpoint/model overrides |
| --- | --- | --- |
| DeepSeek (`deepseek-v4-flash`) | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL` |
| Kimi (`Kimi-K2.7-Code`) | not required by deployment | `KIMI_BASE_URL`, `KIMI_MODEL` |
| GLM (`GLM-5.2-W4AFP8-node6`) | not required by deployment | `GLM_BASE_URL`, `GLM_MODEL` |
| Qwen (`Qwen3.6-27B`) | not required by deployment | `QWEN_BASE_URL`, `QWEN_MODEL` |

The configured Kimi, GLM, and Qwen deployments are explicit internal HTTP endpoints. They inject
the non-secret compatibility value `OPENAI_API_KEY=EMPTY` only into the child process. DeepSeek
requires `DEEPSEEK_API_KEY` from the invoking environment.

Provider doctor performs configuration and credential-presence checks without making a model call:

```bash
python -m game_loop.inner_loop doctor-providers
python -m game_loop.inner_loop doctor-providers --provider deepseek
```

This is an offline configuration smoke, not evidence of a successful real-model call. Real-model
E2E must be reported separately and must include its provider response/trajectory.

An explicit real-provider smoke makes one minimal Chat Completions request and labels the result
`real_request: true`; it is never replaced by a fake transport:

```bash
python -m game_loop.inner_loop smoke-provider --provider kimi
```

Verify deployment before an episode:

```bash
python -m game_loop.inner_loop doctor --profile opengame-profile.json
```

## Stable Python API

```python
from game_loop.benchmarks import load_adapter
from game_loop.runtime import (
    GameTask,
    InnerLoopPipeline,
    OpenGameRuntimeConfig,
)

pipeline = InnerLoopPipeline(
    adapter=load_adapter("gcbench", benchmark_options),
    runtime_config=OpenGameRuntimeConfig.from_dict(runtime_profile),
    evaluator_runner=official_evaluator_runner,
)
result = pipeline.run(task, run_dir=run_dir)
```

`maker_runner=` and `evaluator_runner=` are injectable protocols, so offline tests do not
require Node, model APIs, browser services, or an official evaluator installation.

## Stable CLI

Maker-only smoke:

```bash
python -m game_loop.inner_loop run \
  --benchmark gcbench \
  --task-source /absolute/public-task \
  --seed-artifact /absolute/seed-game \
  --run-dir /absolute/run \
  --profile opengame-profile.json \
  --prompt-file /absolute/public-instruction.md
```

Complete adapter → maker → official evaluator pipeline:

```bash
python -m game_loop.inner_loop run \
  --benchmark gcbench \
  --benchmark-options gcbench-options.json \
  --task-source /absolute/public-task \
  --seed-artifact /absolute/seed-game \
  --run-dir /absolute/run \
  --profile opengame-profile.json \
  --evaluator-profile gcbench-evaluator.json \
  --prompt-file /absolute/public-instruction.md
```

The same command accepts `gdbench`, `vgamegym`, and `verigame`; only adapter options,
public task inputs, and the official evaluator command differ. Command evaluator placeholders
are `{benchmark_id}`, `{task_source}`, `{artifact_path}`, `{prepared_root}`, and `{output_dir}`.

## Episode outputs

- `prepared/`: adapter-owned public task overlay;
- `maker/task.json`: `game-agent.task.v1`;
- `maker/trajectory.jsonl`: ordered `game-agent.trajectory-event.v1` events;
- `maker/submission.json`: `game-agent.submission.v1`;
- `evaluation.json`: `game-agent.evaluation.v1`, when an evaluator is configured;
- `inner_loop_manifest.json`: references tying the records together.

Every maker episode receives a fresh HOME, `.qwen` config, chat-session root, XDG roots,
and explicit project Skill snapshot. A non-empty episode directory is rejected to prevent
accidental session reuse.

## Offline four-benchmark smoke

```bash
python -m unittest \
  tests.test_opengame_runtime.OpenGameRuntimeTests.test_four_benchmark_ids_share_one_pipeline_contract -v
```
