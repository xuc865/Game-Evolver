# Maker-runtime inner-agent benchmark entry points

These examples run the inner loop only. OpenGame is the backward-compatible
default maker runtime, and DeepSeek Harness is selectable with the same bridge
contracts. Benchmark-native code is invoked only after submission, as an evaluator.
They do not enable harness evolution or modify the existing evolution configs.

The same pipeline can instead use the official DeepSeek Harness JSON-RPC SDK.
See `deepseek-harness-profile.example.json` and
`docs/deepseek-harness-runtime.md`. Runtime selection affects only the maker;
benchmark-owned evaluation and harness admission remain outside both runtimes.

Copy either `opengame-profile.example.json` or
`deepseek-harness-profile.example.json`, replace its local runtime paths and
model settings, and keep the resulting profile outside benchmark task trees.
The commands below use the OpenGame example only as the default; substituting a
DeepSeek Harness profile selects that runtime without changing evaluation.

## GameCraftBench

The evaluator command is intentionally supplied by the operator. Clone the
official GameCraftBench implementation, check out and record a specific commit,
install its locked dependencies, then replace the illustrative command in
`gamecraftbench-evaluator-command.example.json` with that checkout's official
verifier entry point. Do not point this bridge at an unpinned branch or at a
custom scoring substitute.

The command supports four substitutions: `{artifact}`, `{workspace}`,
`{breakdown_path}`, and `{output_dir}`. It must write the official normalized
breakdown to `{breakdown_path}`. The public `instruction.md` should be passed as
the instruction file; `tests/rubric.json` must never be copied into `WORKSPACE`.

```sh
python3 -m game_loop.benchmarks.gcbench_bridge \
  --workspace /ABSOLUTE/PREPARED/PUBLIC/WORKSPACE \
  --instruction-file /ABSOLUTE/PUBLIC/instruction.md \
  --output-manifest /ABSOLUTE/RUN/gcbench_execution.json \
  --breakdown-path /ABSOLUTE/RUN/breakdown.json \
  --runtime-profile experiments/inner-agent/opengame-profile.example.json \
  --evaluator-command-file experiments/inner-agent/gamecraftbench-evaluator-command.example.json \
  --doctor
```

Run once without `--doctor` after every check reports `true`. `--dry-run` is an
alias for validation with a distinct mode label; neither flag calls a maker runtime or
the evaluator. The retained game artifact includes `demo_outputs/` traces.

## GameDevBench

`AGENT_WORKSPACE` must be the prepared public project: it must not contain
`task_config.json`, `scripts/test.gd`, or `scenes/test.tscn`.
`PRIVATE_TASK_SOURCE` remains evaluator-side. After the single maker run, the
bridge creates a temporary evaluation copy, injects those hidden files there,
and calls the official `GodotBenchmarkRunner` with `agent=None`. Validation
output is normalized and hidden material is not retained or fed back.

```sh
python3 -m game_loop.benchmarks.gdbench_bridge \
  --gdbench-root /ABSOLUTE/PINNED/gamedevbench \
  --agent-workspace /ABSOLUTE/PREPARED/PUBLIC/TASK \
  --private-task-source /ABSOLUTE/PRIVATE/task_0001 \
  --task-name task_0001 \
  --instruction-file /ABSOLUTE/RUN/gdbench_instruction.txt \
  --output-manifest /ABSOLUTE/RUN/gdbench_execution.json \
  --runtime-profile experiments/inner-agent/opengame-profile.example.json \
  --doctor
```

Run without `--doctor` only after all checks pass. Pin the GameDevBench checkout
and dependencies as part of the experiment provenance.

## VGameGym

Prepare a public task directory containing only `requirement.md` (or
`public_task.json` with `id` and `requirement`). Reference code, evaluator
outputs, and any benchmark-private metadata must remain outside both
`PUBLIC_TASK` and `AGENT_WORKSPACE`. The instruction file must include the
public requirement and must ask for a runnable Pygame game whose core mechanics
are demonstrated autonomously during the fixed recording horizon.

The bridge calls the selected maker runtime exactly once and then invokes an operator-supplied,
pinned VGameGym evaluator. `--evaluator-command-json` is a JSON argv list with
the substitutions `{task_root}`, `{artifact_dir}`, and `{raw_output}`. The
evaluator must write this raw JSON object to `{raw_output}`:

```json
{
  "run_ok": true,
  "code_evaluation": {"total_score": 0},
  "screenshot_evaluation": {"total_score": 0},
  "video_evaluation": {"total_score": 0}
}
```

Each `total_score` is on VGameGym's 0–100 scale. The adapter normalizes the
three values to 0–1 and averages them. A missing modality, missing score,
evaluator error, timeout, or invalid output is an `infrastructure_failure` with
`primary_score: null`; it is never converted into a zero-quality game score.

```sh
RUNTIME_CONFIG_JSON="$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))' \
  experiments/inner-agent/opengame-profile.example.json)"

python3 -m game_loop.benchmarks.vgamegym_bridge \
  --agent-workspace /ABSOLUTE/PREPARED/AGENT_WORKSPACE \
  --instruction-file /ABSOLUTE/PREPARED/evolution_directive.md \
  --task-root /ABSOLUTE/PREPARED/PUBLIC_TASK \
  --output-manifest /ABSOLUTE/RUN/vgamegym_execution.json \
  --runtime-config-json "$RUNTIME_CONFIG_JSON" \
  --evaluator-command-json '["python3","/ABSOLUTE/PINNED/VGAMEGYM/evaluate.py","--task","{task_root}","--artifact","{artifact_dir}","--output","{raw_output}"]'
```

The evaluator command above is an interface example, not a substitute
evaluator. Replace it with the pinned VGameGym checkout's actual code, image,
and video evaluation entry point and record that checkout in run provenance.

## VeriGame / GameGen-Verifier

`PUBLIC_TASK` contains only `specification.md`; hidden keypoints, judge prompts,
runtime traces, and evaluator output remain evaluator-side. The selected runtime
is the sole maker. Its web artifact must expose sufficient runtime state control
for evaluator-side entity creation/removal, gameplay value and flag updates,
and bounded interactions.

There is no bundled claim of the official GameGen-Verifier implementation.
This repository exposes a paper-compatible plugin contract identified as
`paper-compatible-plugin-contract-not-official-code`. A worker is a command
that reads one `ggv-worker-v1` JSON request from stdin and writes one JSON
object to stdout. It must implement these operations:

- `extract_keypoints`: return non-empty `specification_elements` and
  `keypoints`; every keypoint identifies its specification elements and has a
  precondition, bounded interaction, and postcondition.
- `ground_units`: return non-empty `verification_units` with a keypoint id,
  non-empty injected state, bounded interaction, and expected outcome; every
  keypoint must be grounded.
- `execute_unit`: inject state and perform only the bounded interaction in the
  supplied isolated `runtime_dir`; return successful injection/interaction
  flags and non-empty `evidence_refs`.
- `judge_evidence`: return the matching unit id, `verdict` (`pass` or `fail`),
  and a non-empty rationale.

The request includes `operation` plus operation-specific fields at the top
level, including absolute specification/artifact paths. The bridge aggregates
unit verdicts by keypoint and specification element. A missing worker, malformed
response, incomplete evidence, missing judge, timeout, or crashed command is an
`infrastructure_failure` with `primary_score: null`; no positive fallback is
allowed.

```sh
RUNTIME_CONFIG_JSON="$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))' \
  experiments/inner-agent/opengame-profile.example.json)"

python3 -m game_loop.benchmarks.verigame_bridge \
  --agent-workspace /ABSOLUTE/PREPARED/AGENT_WORKSPACE \
  --instruction-file /ABSOLUTE/PREPARED/instruction.md \
  --task-root /ABSOLUTE/PREPARED/PUBLIC_TASK \
  --output-manifest /ABSOLUTE/RUN/verigame_execution.json \
  --runtime-config-json "$RUNTIME_CONFIG_JSON" \
  --worker-command-json '["python3","/ABSOLUTE/PINNED/ggv_worker.py"]'
```

Keep the worker and its model/runtime configuration pinned and record them as
experiment provenance. Evaluator evidence and verdicts are written under the
bridge evaluation directory, never into the submitted game artifact.
