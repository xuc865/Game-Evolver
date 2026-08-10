# General public benchmarks

Official sources are cloned under `third_party/`: `terminal-bench-2` and
`harbor`, `tau2-bench` pinned to v1.0.1, and `NL2RepoBench`.

The verified local source revisions are:

- Terminal-Bench 2.0: `2fd12b88aafdd04a52c298e3940bcb189f9766d6`
- Harbor: `0348989adffbb43bf0b410fd36197333239633f1`
- Tau2Bench: `fc0055dc4e0a316c3f83133267fbd6faaa770992`
- EnvCommons NL2RepoBench: `61d26cc0abd084ece8f5d805dcbd3f806a291f15`
- Official NL2RepoBench source/tasks: `781a1da1ee41fb8edb0bed22f586d69111610edf`

The default solver is always our game-making agent. TerminalBench uses the
official Harbor task container and the custom `GameMakingHarborAgent`; TauBench
uses the official tool/message transport through `GameMakingTauAgent`; NL2Repo
uses `OpenGameRuntime` followed by the official project Docker evaluator.
Benchmark-native code is transport and evaluation only; it is not a second
decision-making agent.

All mutable run state (agent workspaces, logs, manifests, caches, and results)
must live under `experiments/`. Official benchmark sources under `third_party/`
are treated as read-only. The bridges reject mutable paths outside this
project sandbox.

The checked-out Git repository is the official Terminal-Bench 2.0 source. The
current Harbor Hub 2.1 dataset is published as
`terminal-bench/terminal-bench-2-1` (this is the name accepted by Harbor, not
`terminal-bench@2.1`). Pass `--dataset terminal-bench/terminal-bench-2-1` to
`terminalbench_bridge` to run the remote 2.1 dataset through the same custom
agent; omit it for a local checked-out task.

Benchmark Python environments use repository-local `.tools/uv`, `.tools/python`,
and each benchmark's `.venv`; nothing is installed globally by the project.

Run the public command chain with:

```bash
python scripts/run_public_general_benchmarks.py
```

The report preserves commands, return codes, and stderr tails. Nonzero official
runner results are infrastructure failures, not fabricated benchmark scores.
