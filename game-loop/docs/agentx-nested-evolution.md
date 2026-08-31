# AgentX-style nested harness evolution

The project uses one terminology consistently:

- **inner loop** evolves the harness used by the game-making agent;
- **outer loop** evolves the harness used by the agent that proposes inner-loop changes.

`AgentXNestedEvolution` coordinates these two archives. It does not implement a model
transport and it does not treat a simulated score as a real-model result. Real proposers and
benchmark replay runners are injected through `InnerGradientProposer`,
`OuterGradientProposer`, and `NestedReplayOracle`.

## Epoch contract

One nested epoch is deliberately sequential:

1. Freeze the current outer champion.
2. Use it to produce one trace-grounded semantic gradient for the inner champion.
3. Mutate exactly one inner harness dimension and run matched parent/candidate replays.
4. Admit the inner candidate only if replay cases, allocated budgets, feasibility, score
   availability, median improvement, and per-case regression constraints all pass.
5. Freeze the resulting inner champion.
6. Diagnose the completed inner epoch and propose one outer-harness mutation.
7. Run a separate matched replay for outer parent/candidate while holding the inner target fixed.
8. Apply the same admission rules to the outer archive.

The mutation width is required to be one at both levels, which keeps attribution local. A
candidate is never promoted from self-assessment or from one generated game.

## Genome and records

Each `HarnessProfile` is content-addressed and can evolve one of these harness dimensions:

- active instruction modules;
- tool/interface specifications and their safety scopes;
- context compilation policy;
- infrastructure recovery policy;
- deterministic validation/repair policy.
- evidence-evolved fork-target prototypes for dynamic child agents.

Fork-target evolution does not replace the singleton GOA with a fixed circuit.
HPA owns a library of behavior-only child prototypes. Every prototype in its
current audited library is automatically exposed by DSH as a separate fork
tool; per-prototype enablement is not an evolutionary gene. The root chooses
which tool to call for each concrete task at runtime.
The normal HPA contract asks only for the child `persona`. New HPA proposals
write five labeled clauses inside that one string: `Use when:`, `Scope:`,
`Deliverable:`, `Done when:`, and `Return:`. This makes a child job legible and
independently verifiable while keeping it reusable across tasks; proposals must
not name a benchmark, product, game, task instance, source file, fixed team role,
or topology. Fork creation, mounting, communication, and lifecycle remain
invisible runtime policy.
The parent generates the actual child task dynamically and remains responsible
for workspace ownership and delivery. Mechanism switches such as fork enablement,
communication mode, context inheritance, and recursion depth are deliberately
outside the evolutionary genome.

Each inner and outer engine writes its own immutable profile archive, manifest, epoch ledger,
and champion pointer. The coordinator additionally writes `nested_evolution.json`, including
both semantic gradients, frozen cross-loop harness IDs, paired outcomes/deltas, admission
reasons, and timestamps.

## Using real execution

```python
from game_loop.core import AgentXNestedEvolution

coordinator = AgentXNestedEvolution(
    run_dir=nested_run_dir,
    inner_engine=inner_harness_engine,
    outer_engine=outer_harness_engine,
    inner_gradient_proposer=real_inner_proposer,
    outer_gradient_proposer=real_outer_proposer,
    replay_oracle=official_benchmark_replay_oracle,
)
coordinator.initialize()
result = coordinator.run_epoch(
    epoch=1,
    report=trace_attribution_report,
    inner_cases=frozen_inner_cases,
    outer_cases=frozen_outer_cases,
)
```

The replay oracle is responsible for calling the unified OpenGame pipeline and official
benchmark evaluators with equal allocated budgets. Infrastructure-failed pairs are excluded as
quality evidence. The deterministic test oracle in `tests/test_agentx_nested.py` is explicitly an
offline protocol smoke only; it is not evidence of model or benchmark performance.

## Rubric-gated admission

After paired replay, each harness mutation is validated on randomly sampled tasks
(default: 3 for inner, 2 for outer) using deep in-game probes plus an LLM judge:

- **hard rubrics (0/1):** candidate must be greater than or equal to parent on every hard rubric;
- **soft rubrics (0..1):** candidate soft weighted total must be greater than or equal to parent.

Rejected harnesses append structured lessons to `rejection_experience.jsonl` and are
injected into the next inner/outer gradient proposer context.

Inner and outer harness catalogs are split via `experiments/agentx/inner_harness_*.json`
and `experiments/agentx/outer_harness.json`. Task sampling uses
`experiments/agentx/task_pool_smoke.json` for smoke runs.

## Smoke and verification

```bash
python -m unittest tests.test_agentx_nested -v
python -m unittest discover -s tests -q
python -m compileall -q game_loop
```

The nested smoke verifies independent inner/outer promotion, frozen cross-loop identities,
paired budget enforcement through the shared admission engine, persistent audit records, and
rejection of mutation widths greater than one.
