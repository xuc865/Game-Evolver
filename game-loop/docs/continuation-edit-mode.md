# 接续修改模式

Game Evolver 支持两种 epoch 产物策略：

- `from-scratch`（从头模式，默认）：每个 epoch 都从命令行 `--seed` 复制干净产物。适用于不同游戏/不同独立 case 的比较。
- `continuation`（接续修改模式）：第一个 epoch 从 `--seed` 开始；之后把上一轮已完成 candidate 的 `artifact_ref` 作为下一轮 seed，GOA 和 HPA 在同一游戏产物上持续优化。

## CLI

```text
python scripts/run_v030_complex_10_epochs.py ... --evolution-mode continuation
```

可选地，为具体游戏提供冻结的人类设计规范：

```text
python scripts/run_v030_complex_10_epochs.py ... --design-charter experiments/open-source-games/design-charters/godot-open-rpg.md
```

接续模式会将以下目标注入 GOA 的任务上下文和 HPA 的演化上下文：

> Improve the existing game every epoch: preserve working features, make a concrete quality improvement, and verify the result.

接续模式只改变 seed 选择和目标上下文，不放宽接受门槛。通用开源游戏 runner 必须通过 `--ab-evaluator-profile` 提供同条件的 parent/candidate 成对评估。候选只有同时满足以下条件才会被接受并成为下一轮 seed：

- 存在实质实现或资源改动；
- 父版本与候选版本的评估基础设施均正常；
- 两侧分数均存在，且 `candidate_score - parent_score > --minimum-score-delta`；
- evaluator 明确判定 paired comparison passed；
- 没有玩法、宪章、视觉或可靠性硬回归。

没有 A/B profile、评估失败、分数持平或降低、出现硬回归时一律 `accepted=false`，下一轮继续使用最近一次已接受产物。运行完成和测试通过本身不等于质量提升。

状态文件新增 `evolution_mode` 和 `current_artifact` 字段，保证可恢复运行时不会悄悄切换模式。已有旧状态文件可按从头模式继续；恢复为接续模式时需显式传入 `--evolution-mode continuation`。

`--design-charter` 指向一份简洁的 Markdown 规范。运行器会把它放入本轮公开任务上下文，GOA/HPA 和 DeepSeek rubric judge 使用同一份冻结背景；它不是 agent 可修改的测试文件。规范描述核心循环、状态正确的 UI 位置、改进优先级和反模式。当前开源游戏示例位于 `experiments/open-source-games/design-charters/`。
