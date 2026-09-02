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

配对、评分、fork 归因、HPA library 演化、接受门槛和基础设施处理逻辑不变。接续模式只改变 seed 选择和目标上下文。若某轮发生基础设施失败，状态推进但不会替换 `current_artifact`；下一轮继续使用最近一次成功的 candidate 产物。

状态文件新增 `evolution_mode` 和 `current_artifact` 字段，保证可恢复运行时不会悄悄切换模式。已有旧状态文件可按从头模式继续；恢复为接续模式时需显式传入 `--evolution-mode continuation`。

`--design-charter` 指向一份简洁的 Markdown 规范。运行器会把它放入本轮公开任务上下文，GOA/HPA 和 DeepSeek rubric judge 使用同一份冻结背景；它不是 agent 可修改的测试文件。规范描述核心循环、状态正确的 UI 位置、改进优先级和反模式。当前开源游戏示例位于 `experiments/open-source-games/design-charters/`。
