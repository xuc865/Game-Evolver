# L4 实现说明

本文只描述工程映射；方法定义以 `methodology.md` 为准。

## Episode 内冻结

`LoopController` 初始化 L4 run 时导入一个内容寻址的 `HarnessProfile`。同一 run 的所有 generation 和
candidate 都读取该 profile，不在 attempt 内调用 Harness proposer，也不随候选输出更新 Harness。

外环选择的 profile 可以通过 CLI `init --harness-profile` 注入。未提供时使用配置声明的 seed profile。
新主实验 arm `L4_agent` / `L4_agent_no_harness_evolve` 还会把 artifact parent 固定到 seed；候选输出
只作为评分证据和 best-so-far 记录，不形成被测的产物继承链。

## 外环对象

`core/harness.py` 提供：

- `HarnessSemanticGradient`：轨迹诊断及证据引用；
- `HarnessReplayCase`：配对双方共享的任务和 seed/ref artifact；
- `HarnessEpisodeOutcome`：一个完整 benchmark episode 的最终分数、可行性和预算；
- `HarnessEvolutionEngine`：profile、candidate、epoch 和 champion archive；
- `HarnessOuterLoop`：在相同 replay cases 上执行旧/新 Harness 并提交晋升判断；
- `HarnessReplayRunner`：由实验基础设施实现的 episode runner 接口。

## 当前 candidate 表示

当前 profile 已包含三类真实运行策略：

- `context_compiler`：选择历史窗口、接受/拒绝轨迹、诊断长度和 probe 摘要；
- `recovery_policy`：基础设施失败后的有限重试；
- `validation_policy`：Gate 或行为 probe 失败后的定向修复分支。

这些规则在 episode 开始前进入 profile identity，运行时只能触发预先存在的分支。重试和修复会创建
隔离目录并消耗真实模型、evaluator 和 probe 预算。

模块 catalog 继续作为指令层初始先验。尚待加入的可执行组件包括：

- controller graph；
- memory curator；
- engine tool policy，例如 Godot/MCP inspection、import、runtime smoke、scene/resource introspection；
- budget scheduler；
- 更一般的 validation program。

## 轨迹归因与 proposer

`core/attribution.py` 将完成的 run 归一化为失败统计和 evidence refs，并明确排除 infrastructure event
作为质量失败。默认 rule-based proposer 可用于确定性测试；`CommandSemanticGradientProposer` 提供 JSON
stdin/stdout 接口，可替换为任意模型或 Agent 服务。

## 自动 paired replay

`CommandHarnessReplayRunner` 会为旧/新 Harness 创建隔离 episode，调用完整的 `game_loop init` 和
`game_loop evolve`，支持从持久化 state 继续，并将结果归一化为 `HarnessEpisodeOutcome`。CLI 命令：

```text
game-loop harness-attribute
game-loop harness-outer-init
game-loop harness-outer-epoch
```

paired admission 比较双方预分配的预算上限；某个条件分支实际少用预算属于 Harness 行为，不会因为
实际调用数不同而破坏配对，但所有实际消耗仍完整报告。

## 晋升检查

实现层拒绝以下 replay：

- 旧/新两侧 case 集合不同；
- outcome 中的 Harness identity 不匹配；
- 任一侧发生基础设施故障；
- 模型调用或 evaluator 查询预算不一致；
- 输出不可行或缺失最终分数。

有效配对达到最小数量后，使用配对 delta 的中位数和单 case 最大退化共同决定晋升。每个 epoch 的原始
outcome、delta 和拒绝原因写入 append-only archive。

## Benchmark 适配

GCBench 和 GDBench adapter 仍只负责把选定 Harness 投影到各自原生 Agent 接口。它们不实现 Harness
选择，也不能修改外环晋升条件。最终 evaluator、rubric、hidden tests 和报告分数继续冻结。
