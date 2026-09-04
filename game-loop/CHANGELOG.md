# Changelog

## 0.7.0

- Added continuation evolution mode so accepted or quality-promoted artifacts
  can seed the next epoch instead of restarting from the original scaffold.
- Split artifact promotion from harness admission: a playable improvement may
  continue on quality evidence while harness genome acceptance still accounts
  for marginal runtime and call cost.
- Made context compaction mandatory in the local chat-agent request path. The
  preflight compactor clears stale large tool results, trims recent oversized
  outputs, folds older middle history, and applies a hard payload budget before
  provider calls while preserving full local logs on disk.
- Preserved baseline runtime CORDIS plugins when evolved harness plugins are
  overlaid, keeping context-efficiency guards active in long MOBA continuations.
- Hardened GLM/Qwen continuation routing and fallback defaults for long
  evaluator and builder runs.

## 0.6.0

- Added material-change detection for generic open-source continuation runs,
  including file-hash comparison and generated-output exclusions.
- Treated evaluator errors and timeouts as infrastructure failures instead of
  formal quality losses.
- Passed output-aware context into paired evaluators so continuation decisions
  can inspect the actual candidate artifact state.

## 0.5.0

- Added dynamic fork-pair evaluation for complex game tasks, including
  quality-only artifact promotion records and net-utility harness admission.
- Removed fork execution as a fixed admission quota; forks are now evidence
  instruments rather than mandatory throughput.
- Improved rubric generation, validation, and probe selection for richer
  multi-agent game-evolution comparisons.

## 0.4.0

- Added early continuation scaffolding for v0.3.x complex-game experiments,
  including epoch state tracking and current-artifact handoff.
- Added source-change and demo-delivery guards to reduce non-material or
  inspection-only candidate sessions.
- Expanded DeepSeek Harness runtime tests around CORDIS plugin propagation,
  finalizer restart behavior, and unchanged-artifact detection.

## 0.3.0

- Added executable Agent Circuits with isolated multi-agent sessions, parallel
  scheduling, typed artifact handoffs, fan-in, and bounded feedback loops.
- Added HPA-managed declarative circuit transformations. HPA can construct role
  rosters and communication graphs that are not predefined in source code.
- Added evidence-linked multi-transformation GOA bundles and persistent
  conditional leave-one-out attribution.
- Added executable HPA transformation-library add, delete, modify, and merge
  transactions with compiler admission and one bounded repair attempt.
- Added cost-aware topology admission and configurable circuit safety budgets.
- Kept infrastructure failures and incomplete attempts outside formal evolution
  history and library statistics.
- Added the graph-first local Studio, GOA/HPA snapshots, responsive layouts,
  one-request CLI mode, doctor checks, and packaged product assets.
- Added interruption-safe journals and resume behavior for nested evolution.
