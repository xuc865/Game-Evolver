# 分层实现路线

Game Loop 按 L0→L4 递增实现。L0-L3 保留为观测与诊断层；新的主实验口径在 L4 聚焦
Agent/engine Harness，不再把产物谱系继承作为被测方法。

## L0：Evaluator-Only Evolution（已实现）

L0 只允许两类 observation：

1. benchmark 原生 evaluator 返回的分数、约束与允许披露的 diagnostics；
2. 强制产物有效性门禁，例如路径逃逸、测试泄漏、项目文件缺失和提交格式错误。

第二类门禁只判断产物能否安全进入 benchmark，不增加玩法、视觉或任务质量评价，因此不视为
L1 performance probe。

L0 的通用协议为：

```text
immutable parent
  -> normalized evaluator observation
  -> benchmark-independent MutationIntent
  -> frozen agent mutation
  -> mandatory validity gate
  -> original benchmark evaluation
  -> champion comparison
  -> accept or rollback
```

当前通用 Mutation Intent：

- `RepairConstraint`
- `ImproveObjective`
- `ImprovePrimaryScore`
- `CoverUnverifiedRequirement`
- `ExploreAlternative`

`BLACKBOX / OBJECTIVES / DIAGNOSTICS` 是 L0 内部的反馈披露等级，与 L1–L4 方法层级无关。

具体 benchmark 不选择策略，只把 intent 和统一 feedback 编译进自己的隔离任务环境。

L0 已实现的审计不变量：

- model call 和 adapter 报告的 evaluator query 分开计数，评价失败也不能靠缺失分数逃逸预算；
- seed evaluation 不占进化预算，并在 manifest 明示；
- 达到任一预算后不得再启动外部 Agent；
- 同代候选从固定父代生成，但与当前冠军比较；
- 二值 benchmark 达到 terminal success 后立即终止；
- 连续 benchmark 使用增益阈值和目标退化保护；
- L0–L4 的 observation contract 都由配置层严格校验，不能把低层 run 误标成高层方法。

## L1：Fixed-Probe Evolution（已实现）

L1 增加不可自适应的固定 probe provider、固定 anchor suite、独立 probe budget 和父代/候选同条件
对照。它保留 L0 的 benchmark 分数选择，不把 probe 伪装成新的 benchmark 总分。

```text
immutable parent
  -> stage disposable parent probe copy
  -> run frozen fixed suite
  -> evaluator + fixed-probe feedback
  -> frozen agent mutation
  -> mandatory validity gate
  -> stage disposable candidate probe copy
  -> run the identical frozen suite
  -> original benchmark score + paired probe comparison
  -> accept or rollback
```

当前 probe 是通用 command spec，不知道 GCBench、GDBench 或 Godot：

- `exit_code` parser 把退出码变成 pass/score；
- `json_stdout` parser 接收任意工具输出的 `passed`、`score`、`diagnostics`；
- `required` 要求候选通过，即使父代失败也允许候选修复；
- `regression_anchor` 只在父代已通过或父代数值更高时阻止退化；
- parent/candidate 使用同一个配置对象，配置指纹阻止运行中改写；
- probe 在一次性副本上运行，Godot import 缓存不会污染父代或 lineage；
- probe command 调用单独计数，预算不足一整个 parent/candidate pair 时不启动 Agent；
- probe infrastructure failure 与游戏质量失败分开记录，不消耗 model call（若发生在父代阶段）。

两个 L1 示例使用相同的公开 Godot import 与 30-frame headless smoke suite；差异仍只存在于 adapter
如何清洗/物化游戏产物。L1 明确禁止根据本轮结果新增、删除或改写 probe。

## L2：Active-Probe Evolution（已实现）

L2 保留一个初始化时冻结并进入配置指纹的 probe catalog，但每轮只选择有预算的子集：

```text
frozen probe catalog + paired history + current MutationIntent
  -> deterministic active priority
  -> required probes + top-K informative probes
  -> identical parent/candidate execution
  -> persist selection provenance and observations
```

当前通用优先级由五类信号构成：

1. `coverage`：运行次数越少，补覆盖优先级越高；
2. `regression_yield`：历史上更常发现候选回归的 probe 更值得复查；
3. `uncertainty`：Beta-smoothed 回归率越不确定，信息价值越高；
4. `intent_affinity`：probe tags 与通用 Mutation Intent kind/target 匹配；
5. `recency`：长期未选择的 probe 获得恢复机会。

`min_observations_per_probe` 的 warmup deficit 使用高优先级先覆盖 catalog，避免策略过早锁死在少数
probe。每轮的分项值、总 priority、被选理由和 policy version 都写入 `probe_selection.json`。选择器
不读取 adapter 名称，不读取隐藏测试，也不生成新命令；父代和候选仍运行完全相同的被选子集。

GCBench 和 GDBench 的 L2 示例共享同一个公开 Godot catalog：一个始终运行的 import probe，加上
短、中、长三种 runtime anchor；在每轮有限槽位中主动选择。probe 只扩展 search oracle，最终
benchmark report oracle 保持不变。

## L3：Game–Probe Coevolution（已实现）

L3 不允许任意生成可执行测试，而是预注册参数化 `ProbeFamily`：

- command template 与 parser 冻结；
- 只有一个显式整数 gene 可以变异；
- `minimum/maximum/step` 约束搜索边界；
- `difficulty_direction` 声明哪个方向更难；
- family archive capacity 限制种群规模。

每次父代/候选配对后，系统更新三个互相独立的持久化对象：

1. `game_archive.json`：内容寻址游戏、父代、benchmark 分数、接受状态和 component hash；
2. `probe_archive.json`：probe gene、谱系、出生 attempt、trial、分离度、回归发现、fitness 和活跃状态；
3. `interaction_matrix.json`：真实 game–probe observations 与 paired events。

Probe fitness 使用平滑回归发现率、父代可用率和父候选分离度。父代和候选都通过时向更难方向产生
后代；父代无法通过时向更容易方向回退。新值必须在预注册边界内且不能与历史 specimen 重复。

Archive 淘汰首先保留发现过真实回归的 `protected` specimen，再按 fitness 和新颖性保留有限种群。
被淘汰 specimen 只标记 inactive，谱系和历史不会删除。

L3 的三分 oracle 协议为：

```text
game search oracle  = benchmark feedback + selected probe observations
probe fitness oracle = paired failure discovery over archived games
final report oracle = original frozen benchmark evaluator only
```

因此 probe 可以随游戏变强而形成 curriculum，但不能篡改 benchmark 分数或 final report。

## L4：Two-Timescale Agent/Engine Harness Evolution（已实现核心协议）

L4 允许 Agent/engine Harness 进化，但在完整 benchmark episode 内冻结 Harness：

```text
episode：固定 H，从同一 seed/任务产生并评价候选输出
外环：从多个 episode 轨迹提出 H'，再让 H 与 H' 成对重放完整 episode
```

新主实验 arm `L4_agent` 会冻结 artifact parent：每次候选都从同一个 seed/任务起跑，只用历史反馈
改变 Agent 行为和 Harness 上下文，不把上一代游戏文件作为下一代父代。候选 Harness 只有在相同任务、
seed、模型与预算上的 paired replay 证明其跨任务增益后才能晋升。单个输出成功不能直接晋升 Harness，
Harness 自评也不是 fitness。

当前代码已经实现 episode 冻结、内容寻址 profile、语义梯度输入、自动 paired replay、预算一致性检查、
退化保护和 epoch archive。Context compiler、基础设施 recovery 与 validation repair 已经是可执行的
genome 字段；workflow modules 覆盖 agent planning 与 engine tooling 先验。后续 controller graph、
长期 memory、Godot/MCP 工具策略与 budget scheduler 继续共享同一外环晋升协议。

继续冻结：benchmark task、hidden tests、rubric、judge、report oracle、总预算和反泄漏 gate。
`L4_agent_no_harness_evolve` 使用相同执行协议但始终采用 seed Harness。
