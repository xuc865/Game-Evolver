# DeepSeek Harness maker runtime

The evolution controller can start each frozen-harness episode with either the
legacy OpenGame SDK runtime or the official DeepSeek Harness JSON-RPC SDK. The
choice changes the maker implementation only. Benchmark preparation, frozen
parent artifacts, probes, official evaluation, paired replay, admission, and
inner/outer harness archives retain the same contracts.

## Install

```bash
python -m pip install -e '.[deepseek-harness]'
```

DeepSeek Harness is a developer preview. The optional dependency is pinned to
`deepseek-harness-sdk==0.1.0rc7`; pin the matching `dsh-v0.1.0-rc.7` runtime
checkout and preserve it with the run manifest.

## Profile

Start from
`experiments/inner-agent/deepseek-harness-profile.example.json`. Formal runs
should use the repository-owned
`experiments/inner-agent/deepseek-harness.cordis.yml`, which enables filesystem
skill discovery under the isolated episode workspace and treats `max-tokens`
as failure. Credentials must remain in the process environment; they are
rejected when embedded in the profile.

The runtime selector is explicit:

```json
{
  "runtime_type": "deepseek-harness",
  "provider": "deepseek-official",
  "model": "deepseek-v4-flash",
  "backbone_provider": "deepseek"
}
```

Profiles without `runtime_type` remain OpenGame profiles for backward
compatibility.

Run one episode or inspect readiness with the shared CLI:

```bash
python -m game_loop.inner_loop doctor \
  --profile experiments/inner-agent/deepseek-harness-profile.local.json

python -m game_loop.inner_loop run \
  --profile experiments/inner-agent/deepseek-harness-profile.local.json \
  --benchmark verigame \
  --task-source /path/to/task \
  --seed-artifact /path/to/seed \
  --prompt-file /path/to/instruction.md \
  --run-dir /path/to/episode
```

Benchmark bridges accept the same profile JSON through their existing
`--runtime-config-json` or `--runtime-profile` options. For bridges that build a
profile from environment, set `GAME_LOOP_MAKER_RUNTIME=dsh`; optional settings
include `DSH_PROVIDER`, `DSH_MODEL`, `DSH_MAX_TOKENS`, `DSH_CORDIS_CONFIG`,
`DSH_RUNTIME_BIN`, and `DSH_RUNTIME_CWD`.

The generic maker bridges currently cover GameCraftBench, GameDevBench,
VeriGame, V-GameGym, NL2Repo, and the maker-runtime route in TerminalBench.
Benchmark-native agent stacks such as TauBench are intentionally not replaced:
they do not originate from the OpenGame maker path and retain their own agent
protocols.

For a full L4 or AgentX nested run, pin the profile in the experiment config so
it participates in the config fingerprint and every paired replay receives the
same runtime:

```json
{
  "backend": {
    "runtime_profile": "experiments/inner-agent/deepseek-harness-profile.local.json"
  }
}
```

Relative profile paths resolve from `backend.cwd`. The profile and referenced
Cordis, skills, system-prompt, and runtime-binary contents are hashed into the
`AppConfig` fingerprint. Before each backend starts, those captured inputs are
verified and materialized into a content-addressed candidate-local snapshot.
The bridge receives that snapshot plus its hash, never the mutable source
profile. Bridge CLI timeout defaults do not overwrite a pinned profile timeout.

## Evolution mapping

The two frameworks expose different extension surfaces, so compatibility is a
mapping rather than a field-for-field translation:

| Evolved game-loop surface | DeepSeek Harness realization |
| --- | --- |
| Active modules and context compiler | Frozen episode instruction assembled before the SDK prompt |
| Skill elements / `skills_source` | Materialized under `.agents/skills`, then catalogued and loaded by DSH |
| Tool, MCP, workflow, recovery elements | Pinned Cordis composition and its plugins |
| `subagent` prototype elements | Separate `fork_agent_*` tools over one fixed fork-context provider |
| Agent trajectory | JSON-RPC session events and notifications normalized into `trajectory.jsonl` |
| Model usage and finish state | Folded from SDK events into `GameSubmission` |
| Paired replay and admission | Existing AgentX/game-loop evaluator-side logic, unchanged |

DeepSeek Harness adds its own progressive `AGENTS.md` context loading, skill
catalog disclosure, compaction, checkpoint, workflow, and subagent plugins.
Those are additional loading/execution modes; progressive disclosure is not the
only harness behavior. A formal comparison must pin the Cordis composition so
that plugin changes occur only through the declared outer harness evolution.

Subagent prototypes evolve child behavior, not the delegation mechanism. HPA may
add, modify, or merge a prototype `persona` from epoch evidence. The normal HPA
contract exposes no fork configuration fields. Every prototype in the current
audited HPA library is compiled into its own DSH subagent tool; GOA does not
evolve a redundant enablement bit.
The root agent still chooses a tool and creates the concrete task at call time. Provider choice,
context inheritance, foreground/background mode, communication, and recursion
depth are fixed runtime policy and are rejected if they appear in a prototype
genome. Prototype capacity follows the audited HPA library size rather than a
source-defined team width or role roster.

Each episode receives a copied workspace, isolated `HOME`, `DSH_HOME`, session
root, and cleaned `.agents/skills` roster. The DSH subprocess receives only a
small system-variable allowlist, explicit non-secret profile environment, and
the selected backbone credential; unrelated launcher secrets are not inherited.
Only configured successful finish reasons (default: `completed`) are accepted,
and a pre-existing seed artifact must have changed during the episode. The
full turn has a wall-clock watchdog that closes and reaps the SDK runtime.
Root and descendant session usage is deduplicated and aggregated.

Production GameCraftBench L4 commands select this maker bridge whenever a
runtime profile is pinned, then call the existing official verifier command.
TerminalBench L4 configs explicitly select `--solver maker`; their generated
workspace is retained and collected as the candidate artifact rather than
being replaced by verifier logs.
