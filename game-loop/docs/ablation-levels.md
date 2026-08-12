# Harness Evolution Ablations

The current ablation ladder uses `experiment.ablation_level` to identify four
cumulative variants. All variants execute through the production L4 controller;
`method.level` therefore remains `L4` and is not the ablation label.

| Level | Harness evolution capability |
| --- | --- |
| L0 | No Harness evolution. The shared epoch-0 Harness is frozen. |
| L1 | Text-only evolution. Context, protocol, and textual module changes are allowed; executable element, tool-interface, recovery, and validation changes are frozen. Long-term memory is disabled. |
| L2 | Executable evolution. L1 plus skill, MCP, tool, workflow, tool-interface, recovery, and validation changes. Long-term memory is disabled. |
| L3 | Full method. L2 plus accepted/rejected history and cross-epoch proposer context. |

The epoch-0 Harness is identical across all four levels, including its seeded
modules, executable elements, and tool interfaces. The L1 restriction applies
to mutations after initialization, so the comparison does not confound the
starting Harness with the capability being ablated.

The following controls must remain identical across levels: benchmark and
evaluator, three paired admission cases, hard-item and soft-total monotonicity,
rubric/infrastructure exclusion, model, task order, seed, budgets, and
`max_generations=1`.

Primary comparisons are `L1-L0` for textual adaptation, `L2-L1` for executable
Harness evolution, `L3-L2` for long-term memory, and `L3-L0` for the full method.
