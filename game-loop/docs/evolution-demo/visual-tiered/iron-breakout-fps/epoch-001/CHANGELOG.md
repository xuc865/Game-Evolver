# Changelog — `game`

Release notes and reviewer entry point for this artifact.

## [Unreleased] — epoch_012: survival time readout (存活时间)

### Added
- **存活时间读数**（`#survivalTimeText`，右侧信息面板与累计分数同列）：
  此前无尽模式只有分数、威胁等级与纪录追踪，玩家缺少“我还撑了多久”这一
  最直观的进度参照；关卡模式也没有通关总时长口径。现在主循环在有效战斗帧
  累加 `survivalSeconds`（真·暂停整帧冻结不计入、结算 / 菜单状态不计入），
  HUD 以 `m:ss` 每秒刷新（仅秒位变化时写 DOM），死亡结算与过关 / 通关结算
  均给出终局时长。关卡模式与累计分数同口径跨关累计（`startCurrentLevel`
  不重置）；开新对局（`startGame`）与返回菜单（`showModeMenu`）归零，
  上一局的残读数不带入新对局。
- `probe-evidence/verify-survival-clock.mjs`：无头浏览器探针，真实进入无尽
  模式（地图 0，敌人停场），十阶段断言：BOOT 任何对局之前读数 `0:00` 且
  内部计数器为 0；GAME_START 进入战斗后计数从近零起步；TICK 真实游戏循环
  下 2.4 s 墙钟累加 ≥1.2 s（软渲染 delta 钳制 50 ms/帧，按帧累加口径断言）
  且读数 `m:ss` 与内部计数器 ±1.5 s 内一致（截图 `survival-clock-live.png`）；
  PAUSE_FREEZE 真·暂停期间计数器与读数文本逐位冻结（1.2 s 无漂移，截图
  `survival-clock-paused.png`）；RESUME 恢复后累加继续且严格大于冻结值；
  LEVEL_CARRYOVER 调用 `startCurrentLevel()` 计数器与累计分数不变（与分数
  同口径跨关）；DEFEAT 死亡结算界面给出「存活时间 M:SS」且与冻结的内部
  计数器一致（截图 `survival-clock-result.png`）；RESTART 结算界面按 R，
  同步帧内计数器、分数与读数全为 0，新对局时钟重新走动；MENU 返回菜单后
  计数器为 0、读数 `0:00`。输出 `SURVIVAL_CLOCK_PROBE_PASSED`，
  `PAGE_ERRORS` / `CONSOLE_ERRORS` 均为空。

### Changed
- `index.html`：`#gameInfo` 信息面板在累计分数之后新增一行
  `<div>存活时间：<span id="survivalTimeText">0:00</span></div>`。
- `js/core.js`：新增 `survivalTimeText` DOM 引用与 `survivalSeconds` /
  `survivalTimeShown` 对局状态。
- `js/combat.js`：新增 `formatSurvivalTime()` / `updateSurvivalClockUI()`
  （仅秒位变化时写 DOM）/ `resetSurvivalClock()`；`updateVisualUI()` 在
  其他读数的同一链路调用 `updateSurvivalClockUI()`。
- `js/main.js`：`animate()` 在真·暂停早退之后按 `gameState === "战斗"`
  累加 `delta`；`startGame()` 与 `showModeMenu()` 调用
  `resetSurvivalClock()`；`showGameOver()` 与 `completeCurrentLevel()`
  两个分支的结算摘要追加「存活时间 M:SS」。

### Verification evidence on record (this epoch)
- `node probe-evidence/verify-survival-clock.mjs` →
  `SURVIVAL_CLOCK_PROBE_PASSED`（无头 Chromium，真实页面与真实游戏循环；
  `PAGE_ERRORS` / `CONSOLE_ERRORS` 均为空；`survival-clock-live.png` 可见
  实机战斗读数 `0:02` 与内部计数器同帧，`survival-clock-paused.png` 可见
  暂停屏背后读数冻结在 `0:02`，`survival-clock-result.png` 可见死亡结算
  「存活时间 0:03」）。
- 实机输入证据 `survival-clock-live-combat.png`：真实 `mousedown` 连射机枪
  15 发（45/180 → 30/180，命中率行同帧显示发射 15），存活时间读数 `0:05`
  与右侧信息面板同帧出现，非脚本置态。
- `node probe-evidence/verify.mjs` → 全阶段通过（BOOT / GAME_START /
  HOTKEYS 五武器切换 / COMBAT 真实击杀计分 0→200 / STREAK_EXPIRY /
  EMERGENCY_RELOAD / BEST_PERSIST / DANGER_SYSTEM.passed / RESTART
  失败→战斗 / AUDIO_SYSTEM.passed）；`PAGE_ERRORS` 仅含已知 headless
  指针锁定噪声（2× WrongDocumentError，与既往各 epoch 一致）。
- 回归套件：`verify-pause-freeze` → `PAUSE_FREEZE_PROBE_PASSED`（真·暂停
  整帧冻结含新增读数，恢复补偿正常）；`verify-reload-prompt` →
  `RELOAD_PROMPT_PROBE_PASSED`。
- `node --check` 全部 `js/*.js` 语法通过。
- 已知环境噪声（与本改动无关）：无头 SwiftShader 帧率约 12 fps，逐帧
  `delta` 50 ms 钳制使时钟按墙钟约 0.75× 速度累加；探针按墙钟不变量断言
  累加率与一致性，实机 60 fps 浏览器下与真实时间一致。

## [Unreleased] — epoch_011: crosshair reload prompt (换弹提示)

### Added
- **换弹提示**（`#reloadPrompt`，准星下方、与换弹框同一位置）：此前判断"现在
  该不该换弹"的唯一线索是右侧 HUD 弹药读数的低弹匣脉冲（`#ammoText.low`），
  离玩家视线焦点太远；弹匣打空后又要靠扣扳机触发自动换弹才发现断档。现在
  `updateAmmoUI()` 会在弹药进入决策区间时，于准星下方给出一句与状态对应的
  提示，三级语义：
  - 弹匣 ≤ 25%（阈值与右侧读数 `.low` 脉冲完全同源）且备弹 > 0 →
    「弹匣偏低 · 建议按 R 换弹」（琥珀，与默认框体同色）；
  - 弹匣 0 且备弹 > 0 →「弹匣已空 · 按 R 立即换弹」（`prompt-empty`，
    橙红描边）；
  - 弹匣与备弹同时耗尽 →「备弹耗尽 · 寻找蓝色弹药包」（`prompt-out`，
    红色脉冲；备弹耗尽但弹匣尚有余弹时则显示「备弹耗尽 · 谨慎使用余弹」）。
  提示与右侧弹药读数共用 `updateAmmoUI()` 单点数据源，切枪、拾取弹药包
  （`refillAllAmmo`）、重开（`resetAllAmmo`）与返回菜单时随同一入口自动
  复位；换弹进行中提示让位给换弹框（两者不再叠在同一位置）；死亡结算
  （`showGameOver`）与过关结算（`completeCurrentLevel`）显式清除，残提示
  不会带入新对局。无弹药武器（匕首）永不显示。真·暂停期间主循环跳过
  `updateWeapon`，提示状态与换弹计时一并冻结，恢复后原样继续。
- `probe-evidence/verify-reload-prompt.mjs`：无头浏览器探针，真实进入无尽
  模式（地图 0，敌人停场），十二阶段断言：FULL 满弹匣（45/180）不显示；
  BOUNDARY_ABOVE 12 发（阈值 11 之上）不误报；LOW 11 发精确进入
  「弹匣偏低」且无严重度类（截图 `reload-prompt-low.png`）；EMPTY 0/180
  进入 `prompt-empty`；RELOAD_TAKEOVER 真实 `startReload(false)` 后提示
  让位、换弹框接管，真实游戏循环完成换弹（0→45、备弹 180→135）后两者
  同隐；DRY 0/0 进入 `prompt-out`（截图 `reload-prompt-out.png`）；
  REFILL `refillAllAmmo()` 清提示并回满 45/180；SWITCH_LOW 手枪阈值 3
  随当前武器联动、匕首（无限弹药）恒隐藏、切回手枪提示恢复；
  PAUSE_FREEZE 真·暂停期间文本/类/可见性 900 ms 无漂移，恢复后原样
  保持；RESTART 死亡结算时提示清除、按 R 重开后满弹匣且无残留。输出
  `RELOAD_PROMPT_PROBE_PASSED`，`PAGE_ERRORS` 为空。

### Changed
- `index.html`：`#reloadIndicator` 之后新增 `<div id="reloadPrompt"></div>`
  （初始无类、透明度 0，由 JS 驱动）。
- `js/core.js`：新增 `reloadPrompt` DOM 引用。
- `js/weapons.js`：`updateAmmoUI()` 把低弹匣阈值提取为 `lowThreshold`
  复用于 `.low` 类与提示判断；新增 `updateReloadPrompt()`（状态机：
  无弹药武器/换弹中/健康弹匣 → 隐藏；三级文案与严重度类）与
  `hideReloadPrompt()`（幂等清除类与文案，避免幽灵文本）；无限弹药分支
  的早退路径同步隐藏提示。
- `js/main.js`：`showGameOver()` 与 `completeCurrentLevel()` 追加
  `hideReloadPrompt()`，结算界面不携带上一秒的残提示。
- `css/game.css`：新增 `#reloadPrompt`（与 `#reloadIndicator` 同规格：
  准星下方 80 px、12 px 加粗、3 px 字距、100 ms 透明度过渡），
  `#reloadPrompt.visible` 与 `#reloadPrompt.prompt-empty` /
  `.prompt-out`（红色脉冲 `@keyframes reloadPromptOutPulse`）严重度变体。

### Verification evidence on record (this epoch)
- `node probe-evidence/verify-reload-prompt.mjs` →
  `RELOAD_PROMPT_PROBE_PASSED`（无头 Chromium，真实页面与真实游戏循环；
  `PAGE_ERRORS` / `PAGE_CONSOLE_ERRORS` 均为空；`reload-prompt-low.png`
  可见准星下方琥珀色「弹匣偏低 · 建议按 R 换弹」与右侧红色 11/180 同帧
  出现，`reload-prompt-out.png` 可见红色脉冲「备弹耗尽 · 寻找蓝色弹药包」
  与 0/0 同帧出现）。
- 实机输入证据 `reload-prompt-live-combat.png`：真实 `mousedown` 连射
  机枪（15 发弹匣打到 10/8，`shotsFired` 7、音效事件 7 同帧计数），
  提示由真实射击逐发扣弹自然触发，非脚本置态。
- `node probe-evidence/verify.mjs` → 全阶段通过（BOOT / GAME_START /
  HOTKEYS 五武器切换 / COMBAT 真实击杀计分 / STREAK_EXPIRY /
  EMERGENCY_RELOAD（打空自动换弹期间提示正确让位换弹框）/ BEST_PERSIST /
  DANGER_SYSTEM.passed / RESTART 失败→战斗 / AUDIO_SYSTEM.passed）；
  `PAGE_ERRORS` 仅含已知 headless 指针锁定噪声。
- 回归套件：`verify-reload-progress` → `RELOAD_PROGRESS_PROBE_PASSED`；
  `verify-pause-freeze` → `PAUSE_FREEZE_PROBE_PASSED`；
  `verify-streak-window` → `STREAK_WINDOW_PROBE_PASSED`；
  `verify-damage-direction` → `DAMAGE_DIRECTION_PROBE_PASSED`。
- `node --check` 全部 `js/*.js` 语法通过。
- 已知环境噪声（与本改动无关）：无头 SwiftShader 合成器把 100 ms 的
  透明度过渡拖长到约 0.5 s 墙钟（旧换弹框截图同现，实机浏览器 60 fps
  下约 2 帧完成），探针截图前等待 900 ms 以固定证据帧。

---

## [Unreleased] — epoch_010: reload progress bar (换弹进度条)

### Added
- **换弹进度条**（`#reloadBar`，位于准星下方 `#reloadIndicator` 提示框内）：
  此前换弹只有一行数字倒计时（“正在换弹 2.2 秒”），玩家需要心算剩余比例才
  知道“还要等多久”；现在提示框内多了一条 4 px 细进度条，宽度 =
  `1 - reloadTimer / reloadDuration`，与倒计时文字共用同一数据源（两者不会
  互相撒谎），换弹期间逐帧真实填充，琥珀渐变 + 辉光与框体配色一致。条由
  与倒计时相同的 `updateAmmoUI()` 驱动，真·暂停时主循环跳过
  `updateWeapon`，进度条随换弹计时一起冻结、恢复后继续；切枪
  （`cancelReload`）、拾取弹药包（`refillAllAmmo`）、死亡结算与重开时随提示
  框一起隐藏并把条宽归零，上一局/上一次换弹的残条不会带入新状态。
- `probe-evidence/verify-reload-progress.mjs`：无头浏览器探针，真实进入
  无尽模式（地图 0），七阶段断言：INITIAL 无换弹时框隐藏、条宽为 0；
  START 真实 `startReload()` 后框可见、倒计时文本就位、条宽从 0 起步；
  LOCKSTEP 在真实游戏循环下采样 7 次，条宽与
  `(1 - reloadTimer / reloadDuration)` 严格同相（±2%）、单调不降、秒数标注
  与计时器误差不超 0.2 s（软渲染 delta 钳制 50 ms/帧，故按游戏时间不变量
  断言），条首次显著增长时截图 `reload-progress-mid.png`；COMPLETE 真实循环
  完成换弹 → 弹匣 12→45、备弹 180→147（恰好补满 33 发）、框隐藏、条宽归
  0；CANCEL 换弹进行到 15.6% 时切手枪 → 条隐藏、半成品弹匣原样保留
  （20/180）、手枪弹药不受影响、条宽归 0；RESTART_RESET 真实
  `refillAllAmmo()` 拾取路径取消进行中的换弹，框隐藏、条宽为 0；
  PAUSE_FREEZE 真·暂停期间条宽与计时器逐位冻结（900 ms 无漂移）、恢复后
  继续增长。输出 `RELOAD_PROGRESS_PROBE_PASSED`，`PAGE_ERRORS` 为空。

### Changed
- `index.html`：`#reloadIndicator` 由单文本节点改为
  `<span id="reloadIndicatorText">` + `#reloadBar`（内含 fill）结构；原有
  静态文案“正在换弹”移入 span。
- `js/core.js`：新增 `reloadIndicatorText` / `reloadBarFill` DOM 引用。
- `js/weapons.js`：`updateAmmoUI()` 改为向 `#reloadIndicatorText` 写倒计时
  文本，换弹进行中同步设置 `#reloadBarFill` 宽度（与文字同源）；
  `cancelReload()` 追加把条宽复位为 0%。
- `css/game.css`：新增 `#reloadBar`（4 px 轨道、低饱和琥珀底色）与
  `#reloadBarFill`（琥珀渐变 + 辉光；宽度逐帧由 JS 驱动，不加 CSS
  transition，避免视觉与数据源脱节）。

### Verification evidence on record (this epoch)
- `node probe-evidence/verify-reload-progress.mjs` →
  `RELOAD_PROGRESS_PROBE_PASSED`（无头 Chromium，真实页面与真实游戏循环；
  `PAGE_ERRORS` 为空；截图 `reload-progress-mid.png` 可见准星下方换弹框内
  “正在换弹 2.0 秒”与约 11% 填充的琥珀色进度条，与剩余 2.0/2.25 s 精确
  对应）。
- `node probe-evidence/verify.mjs` → 全阶段通过（BOOT / GAME_START /
  HOTKEYS 五武器切换 / COMBAT / STREAK_EXPIRY / EMERGENCY_RELOAD /
  BEST_PERSIST / DANGER_SYSTEM.passed / RESTART 失败→战斗 /
  AUDIO_SYSTEM.passed），核心循环、武器热键、紧急换弹与重开路径无回归；
  `PAGE_ERRORS` 仅含已知 headless 指针锁定噪声。
- `node probe-evidence/verify-pause-freeze.mjs` →
  `PAUSE_FREEZE_PROBE_PASSED`（新增进度条随 `updateWeapon` 在暂停期间冻
  结、恢复后继续，无回归）。
- 回归套件：`verify-streak-window` → `STREAK_WINDOW_PROBE_PASSED`；
  `verify-damage-direction` → `DAMAGE_DIRECTION_PROBE_PASSED`；
  `verify-bearings` → `BEARING_PROBE_PASSED`；`verify-intake-readout` →
  `INTAKE_PROBE_PASSED`；`verify-supply-readout` →
  `SUPPLY_READOUT_PROBE_PASSED`；`verify-threat-tier` →
  `THREAT_TIER_PROBE_PASSED`；`verify-record-chase` →
  `RECORD_CHASE_PROBE_PASSED`；`audio-selftest` → `AUDIO_SELFTEST_OK`。
- 已知预存 flake（与本改动无关，改动前后同频出现）：
  `verify-accuracy.mjs` 瞄准阶段偶发整轮 0 命中（guard=60、
  `ACCURACY_TELEMETRY_PASSED false`，约 1/3 概率，重跑即恢复），源于探针
  瞄准点依赖存活敌人实时站位与视线；且该探针长期把 headless 指针锁定
  pageerror 计入硬性失败，即使通过也总是退出码 1（`PASSED true` 行才是
  真实信号）。本 epoch 未引入、未修改这两个问题。
- `node --check` 全部 `js/*.js` 语法通过。

---

## [Unreleased] — epoch_009: killstreak window countdown (连杀窗口倒计时)

### Added
- **连杀窗口倒计时条**（`#streakTrack`，右侧 HUD“连杀加成”行正下方的细
  进度条）：此前 4.5 秒连杀判定窗口（`STREAK_WINDOW`）没有任何可视化——
  玩家只能看到当前的加成倍率，窗口悄悄耗尽后加成瞬间归零，既不知道还要
  多久不打断连杀，也不知道距离“白打”还剩几秒。现在每次击杀窗口回满、
  进度条随之回到 100%（数据源与连杀计时完全共用：条宽 =
  `killStreakTimer / STREAK_WINDOW`，中央标注剩余秒数，读数不会撒谎）；
  窗口随真实战斗计时逐帧衰减；剩余不足 1 秒进入 `streak-critical`
  警示脉冲，提示玩家尽快完成下一次击杀；窗口耗尽时条随
  `resetKillStreak()` 一起结算隐藏。条配色随连杀层级与 `streakText`
  同步（琥珀 → 炽热橙 x3 → 血红 x5），无连杀时整体隐藏，不占视觉
  空间。真·暂停期间 `updateVisualUI` 不执行，本条随连杀计时一起冻结，
  与 epoch_005 暂停语义一致；死亡结算、重开与返回菜单时状态清零，
  上一局的窗口不会带进新对局。
- `probe-evidence/verify-streak-window.mjs`：无头浏览器探针，真实进入
  无尽模式（地图 0），八阶段断言：INITIAL 无连杀时条隐藏；KILL 真实
  `killEnemy()` 击杀后条可见、计时回满、条宽与计时严格同相（±1%）、
  秒数标注正确；DECAY 在真实游戏循环下计时真实衰减且条宽比例、标注
  保持同步（soft 渲染 delta 钳制 50 ms/帧，故按游戏时间不变量断言而非
  挂钟）；CRITICAL 0.8 s 进入警示脉冲 / 1.2 s 退出；TIERS 3 连杀
  `streak-hot`、5 连杀 `streak-blazing`、重置后类全部清除；EXPIRY
  用真实 `updateVisualUI(0.1)` 逐帧驱动窗口耗尽，条自行隐藏、
  连杀文本归 `x1.0（0 连杀）`、2 连杀结算播报出现；DEATH 活动连杀
  在结算屏上被清除（`gameState === "失败"`、条隐藏、计时清零）；
  RESTART 重开回到战斗后条隐藏、计时与计数全零。输出
  `STREAK_WINDOW_PROBE_PASSED` 与截图 `streak-window-full.png` /
  `streak-window-critical.png`。

### Changed
- `js/combat.js`：`setKillStreak(count)` 同步 `#streakTrack` 的
  `hidden` / `streak-hot` / `streak-blazing` 类（阈值与 `streakText`
  一致）；新增 `updateStreakTrack()`（条宽 = 剩余比例、中央秒数标注、
  `streak-critical` 低于 1 秒触发），挂在 `updateVisualUI()` 连杀计时
  衰减之后逐帧驱动。
- `js/core.js`：新增 `streakTrack / streakTrackFill /
  streakTrackLabel` DOM 引用（复用既有 `STREAK_WINDOW` 常量）。
- `index.html`：`#gameInfo` 内“连杀加成”行下新增
  `#streakTrack`（fill + 秒数 label），初始 `hidden`。
- `css/game.css`：新增进度条样式（8 px 细条、琥珀渐变与辉光，随层级
  换色，`streak-critical` 警示脉冲动画，760 px 响应式收窄）。

### Verification evidence on record (this epoch)
- `node probe-evidence/verify-streak-window.mjs` →
  `STREAK_WINDOW_PROBE_PASSED`（无头 Chromium，真实页面与真实游戏
  循环；`PAGE_ERRORS` 为空；`streak-window-full.png` 可见击杀后
  满格金色条 + “4.5s”，`streak-window-critical.png` 可见临近耗尽的
  短条 + “0.8s”）。
- `node probe-evidence/verify.mjs`：基线冒烟全阶段通过（BOOT /
  GAME_START / HOTKEYS 五武器切换 / COMBAT / STREAK_EXPIRY /
  EMERGENCY_RELOAD / BEST_PERSIST / DANGER_SYSTEM.passed / RESTART
  失败→战斗 / AUDIO_SYSTEM.passed），核心循环、热键、重开路径与音频
  未回归；`PAGE_ERRORS` 仅含已知 headless 指针锁定噪声。
- `node probe-evidence/verify-pause-freeze.mjs` →
  `PAUSE_FREEZE_PROBE_PASSED`（暂停期间 `killStreakTimer` 冻结、
  恢复后继续衰减，新增倒计时条随 `updateVisualUI` 冻结，无回归）。
- `node --check` 全部 `js/*.js` 语法通过。

---

## [Unreleased] — epoch_008: damage-direction indicator (受击方向指示)

### Added
- **受击方向指示**（`#damageDirection`，屏幕边缘橙色弧线）：此前玩家被击中
  只有全屏红色晕闪，无法立刻判断火力来自哪个方向；低血量威胁标记又只在
  生命值 ≤ 30 时出现且指向"最近敌人"而非"实际开火者"。现在任何血量下被
  枪弹命中或近战刮蹭后，屏幕边缘都会沿伤害来源在**命中瞬间**的方位亮出
  一段弧线（快 0.08 秒淡入、常亮、0.45 秒尾部淡出，总停留 1.4 秒），
  连续受击自动刷新计时——受击即知威胁方位，无需等濒死。弧线为橙色
  拱形（`border-top` 圆角拱），与低血量威胁标记的红色三角 + 距离文本在
  形状与配色上明确区分，两者可同时出现而不混淆。
- `probe-evidence/verify-damage-direction.mjs`：无头浏览器探针。真实进入
  无尽模式并把玩家保持在满血（`lowHealthActive === false`，证明指示器
  独立于濒死系统）；把一枚测试敌人传送到玩家正前 / 正右 / 正后 / 正左
  12 米的四个基点（其余敌人停放地图外），走真实 `damagePlayer(10, enemy)`
  路径后断言弧线旋转角等于期望方位（0 / +90° / 180° / −90°，±0.15 rad，
  角度差按环绕安全方式比较）且不透明度全亮；随后断言：无新伤害时弧线在
  TTL 内自行淡出到 0（采样序列 1.0×8 → 0.889 → 0.667 → 0.444 → 0.222 →
  0）、无来源的 `damagePlayer(5)` 不触发指示器、致死一击后结算屏上弧线
  已清除（`gameState === "失败"` 且 opacity 0）、`restartSelectedMode()`
  重开回到战斗后计时与弧线均为零且生命 100。输出
  `DAMAGE_DIRECTION_PROBE_PASSED` 与截图 `damage-direction-front.png`。

### Changed
- `js/combat.js`：`damagePlayer(amount)` 扩展为 `damagePlayer(amount,
  source)`（向后兼容，source 可选）并调用新增的
  `registerDamageDirection(source)`（用命中瞬间坐标经既有
  `relativeAngleTo()` 求方位角——复用 epoch_007 修复后的投影公式，
  正前方不会镜像到屏幕下方）；新增 `updateDamageDirection(delta)`（每帧
  驱动淡入/常亮/淡出，挂在 `updateVisualUI` 内，真·暂停时随整个更新链
  冻结，不违反 epoch_005 的暂停语义）与 `clearDamageDirection()`。
- `js/enemies.js`：敌方枪弹命中与近战接触两处 `damagePlayer` 调用传入
  施伤敌人作为来源。
- `js/core.js`：新增 `damageDirection` DOM 引用、`DAMAGE_DIRECTION_TTL /
  _FADE_IN / _FADE_OUT` 常量与 `damageDirectionTimer / damageDirectionAngle`
  状态。
- `js/main.js`：`resetPlayer()`、`showGameOver()`、`showModeMenu()` 各自
  调用 `clearDamageDirection()`——上一局的弧线不会残留到死亡结算、新对局
  或菜单。
- `index.html` / `css/game.css`：新增指示器 DOM（位于 `#hud` 内，
  z-index 12 与威胁标记层一致，暂停/结算屏 z-30 天然覆盖）与拱形弧线
  样式（橙红渐变感、drop-shadow 辉光，半径与威胁标记约 210px 同档）。

### Verification evidence on record (this epoch)
- `node probe-evidence/verify-damage-direction.mjs` →
  `DAMAGE_DIRECTION_PROBE_PASSED`（无头 Chromium，真实页面与真实游戏
  循环；四方位 0 / 1.571 / 3.142 / −1.571 rad 全部命中，满血态
  `lowHealthActive=false`；`PAGE_ERRORS` 为空；截图
  `damage-direction-front.png` 可见正前受击时屏幕上方橙色弧线）。
- `node probe-evidence/verify.mjs`：基线冒烟全阶段通过（BOOT / GAME_START
  / HOTKEYS 五武器切换 / COMBAT / STREAK_EXPIRY / EMERGENCY_RELOAD /
  BEST_PERSIST / DANGER_SYSTEM.passed / RESTART 失败→战斗 /
  AUDIO_SYSTEM.passed），核心循环、热键、重开路径与音频未回归；
  `PAGE_ERRORS` 仅含已知 headless 指针锁定噪声。
- `node probe-evidence/verify-bearings.mjs` → `BEARING_PROBE_PASSED`
  （epoch_007 方位回归在新代码下保持全绿）；
  `node probe-evidence/verify-pause-freeze.mjs` →
  `PAUSE_FREEZE_PROBE_PASSED`（受击指示计时随真·暂停冻结，无回归）。
- `node --check` 全部 `js/*.js` 语法通过。

---

## [Unreleased] — epoch_007: threat-bearing fix (濒死威胁方位修正)

### Added
- `probe-evidence/verify-bearings.mjs`：方位角回归探针。把一枚测试敌人
  传送到玩家正前 / 正右 / 正后 / 正左 12 米的四个基点（其余敌人停放在
  地图外），`player.health = 25` 进入濒死状态，同步强制触发
  `updateThreatMarkers()` 与 `updateLowHealthWarning()` 两条更新路径，
  逐点断言威胁标记 `threatMarkers[].angle` 与危险箭头 `#dangerArrow`
  旋转角等于期望方位（0 / +90° / 180° / −90°，±0.15 rad，角度差按
  环绕安全方式比较，±π 视为相等）。输出 `BEARING_PROBE_PASSED` 与
  截图 `bearing-front.png` / `bearing-back.png`。

### Changed
- **修复濒死威胁方位的前后镜像缺陷**（`js/combat.js` →
  `relativeAngleTo()`，玩家可见行为修复）：旧实现
  `atan2(dx, dz) - player.yaw` 左右方向正确、前后却是镜像（整体
  180° 翻转而非旋转），正前方的敌人会把威胁标记渲染到屏幕**下方**、
  危险箭头上下颠倒——玩家按提示转身 180° 反而背对威胁。根因是
  未把相对位移投影到视角的“右 / 前”轴上直接对世界坐标求角。新实现
  先投影 `screenRight = dx·cos(yaw) − dz·sin(yaw)`、
  `screenForward = −dx·sin(yaw) − dz·cos(yaw)`，再取
  `atan2(screenRight, screenForward)`（0 = 正前方，顺时针为正，与
  既有注释约定一致）。影响面为濒死状态的最近威胁标记与危险方向箭头
  （`updateThreatMarkers` / `scanDangerSurroundings` 仅有的两个调用点），
  不涉及移动、射击、结算等核心循环代码。
- `probe-evidence/verify-accuracy.mjs`：修复探针自身的 MILESTONE 阶段
  预存缺陷（非游戏缺陷，本 epoch 前该探针即无法通过）。原探针把
  `score` 置为 700 后调用 `checkScoreMilestone(700, 800)` 却断言
  `score === 800`——而 `checkScoreMilestone` 是纯播报函数（与
  `killEnemy()` 契约一致：先加分、再检查，本身不改 `score`），
  `crossed` 因此恒定 false。现按 `killEnemy()` 真实顺序先 `score += 100`
  再调用检查，断言恢复可过。游戏代码未动。
- `probe-evidence/verify-intake-readout.mjs`：修复探针自身三处预存缺陷
  （本 epoch 前即 100% 失败）：① 采样竞态——`AFTER_RESTART` 与
  `gameState` 翻转在同一 JS 任务内读取，读数要到下一渲染帧才重新
  显示，现加 400 ms 沉降；② 键名笔误——通过条件误用
  `afterRestart.gameState`，而 `readoutState()` 报告的键是 `state`，
  导致该合取项恒 false；③ 死亡结算采样用固定 250 ms 延时过脆，改为
  对隐藏位轮询（≤1.5 s），并在 `damagePlayer(0)` 后同步捕获
  `gameStateAtDeath`（`showGameOver` 同步置“失败”）。游戏代码未动。

### Verification evidence on record (this epoch)
- `node probe-evidence/verify-bearings.mjs` → `BEARING_PROBE_PASSED`：
  四个基点方位对威胁标记与危险箭头全部精确命中（0 / 1.5708 /
  3.1416 / −1.5708 rad）。
- 阴性对照：修复前同一探针在 front 用例失败（标记角 3.14 vs 期望 0，
  即屏幕下方），证明探针确实检出旧镜像行为；截图
  `bearing-front.png`（“▲ 最近威胁 12 米”，标记居屏幕上方）与
  `bearing-back.png`（“▼”，标记居屏幕下方）为视觉佐证。
- `node probe-evidence/verify.mjs`：基线冒烟全阶段通过（BOOT /
  GAME_START / HOTKEYS 五武器切换 / COMBAT / STREAK_EXPIRY /
  EMERGENCY_RELOAD / BEST_PERSIST / DANGER_SYSTEM / RESTART 失败→
  战斗 / AUDIO_SYSTEM），核心循环、热键、重开路径与音频未回归。
- `node probe-evidence/verify-accuracy.mjs` →
  `ACCURACY_TELEMETRY_PASSED true`（探针修复后；含失误计数、瞄准命中、
  HUD 一致性、里程碑播报、结算命中率行、R 重开遥测归零）。
- `node probe-evidence/verify-intake-readout.mjs` →
  `INTAKE_PROBE_PASSED`（探针修复后；无尽 / 关卡 / 死亡结算 / 回菜单
  各状态读数一致）。
- `node probe-evidence/verify-pause-freeze.mjs` →
  `PAUSE_FREEZE_PROBE_PASSED`；`verify-supply-readout.mjs` →
  `SUPPLY_READOUT_PROBE_PASSED`；`verify-threat-tier.mjs` →
  `THREAT_TIER_PROBE_PASSED`；`verify-record-chase.mjs` →
  `RECORD_CHASE_PROBE_PASSED`；`audio-selftest.mjs` →
  `AUDIO_SELFTEST_OK`。
- `node --check` 全部 `js/*.js` 语法通过；所有探针 `PAGE_ERRORS` 仅含
  已知 headless 指针锁定噪声（WrongDocumentError），无真实页面错误。

---

## [Unreleased] — epoch_005: true pause (真·暂停冻结)

### Added
- **真·暂停：暂停屏期间冻结全部模拟**。此前 Esc 只是“假暂停”：暂停状态
  不改变 `gameState`（仍为“战斗”），各更新函数的 `gameState` 判断都识别
  不了暂停，于是敌人按挂钟计时在暂停屏背后持续重生、补给包照常投放
  （epoch_004 的补给倒计时在暂停期间照样流逝）、换弹照常完成、连杀计时
  照常归零——玩家可能在暂停期间“隐形”失去连杀加成或看到恢复后增援
  集中爆发。现在 `animate()` 在 `isGamePaused()`（`gameState === "战斗"`
  且暂停屏可见）时跳过全部模拟更新、只重绘静态帧：敌人/补给/生命值/
  分数/连杀计时/换弹全部冻结，敌情与补给两条倒计时读数随暂停熄灭
  （与代码注释早已声明的“暂停时隐藏”约定一致）。
- **挂钟重生计时补偿**：`respawnTimers` 存的是挂钟绝对时间，若不做补偿，
  恢复瞬间到期计时器会一次性集中刷怪。现在 `onPointerLockChange` 在暂停
  瞬间记录锚点（`pauseAnchorTime`），恢复时把全部重生计时器整体前移暂停
  时长（`shiftRespawnTimersBy`），增援仍按“有效战斗时间”的约定时刻抵达
  ——不损失时间、也不在恢复瞬间爆发。两条倒计时读数的数据源
  （`getNextEnemyIntakeSeconds` / `getSupplyDropSeconds`）无需改动，
  恢复后自动与补偿后的计时器重新同步，读数不会撒谎。
- `probe-evidence/verify-pause-freeze.mjs`：无头浏览器探针，真实进入无尽
  模式并构造确定性热状态（一次真实击杀产生挂钟重生计时器、一枚 2.5 秒
  在途血包、3.0 秒连杀计时），模拟 Esc 后断言：4 秒暂停期间重生计时器
  数值逐位不变、敌人数/补给数/生命值/分数/连杀计时/补给倒计时全部冻结、
  两条读数熄灭；恢复时重生计时器整体前移量与实测暂停时长一致（±0.8s）
  且全部落在未来（无爆发）；恢复后补给倒计时重新递减、连杀计时重新走、
  敌人重新移动、读数重新点亮。输出 `PAUSE_FREEZE_PROBE_PASSED` 与截图
  `pause-*.png`。

### Changed
- `js/main.js`：新增 `isGamePaused()` / `shiftRespawnTimersBy()` 与
  `pauseAnchorTime` 锚点；`animate()` 暂停分支提前返回（仅渲染）；
  `onPointerLockChange()` 暂停时记录锚点并熄灭两条读数，恢复时补偿
  重生计时器。

### Verification evidence on record (this epoch)
- `node probe-evidence/verify-pause-freeze.mjs` → `PAUSE_FREEZE_PROBE_PASSED`
  （无头 Chromium，真实页面与真实游戏循环；`PAGE_ERRORS` 过滤已知
  headless 指针锁定噪声后为空；截图 `pause-0-paused.png` /
  `pause-1-frozen.png` / `pause-2-resumed.png`）。
- 阴性对照：临时还原 `js/main.js` 补丁后探针在 `PAUSE_ENTER` 失败
  （暂停期间两条读数保持点亮、`isGamePaused` 不存在），证明探针确实
  能检出旧版假暂停行为。
- `node probe-evidence/verify.mjs`：基线冒烟各阶段全绿（含死亡结算 →
  R 重开路径 `RESTART gameStateAfterRestart=战斗`、危险系统、音频、
  最佳分数持久化），核心循环与重开路径未回归。
- `node probe-evidence/verify-supply-readout.mjs` →
  `SUPPLY_READOUT_PROBE_PASSED`：epoch_004 补给读数（含 2.2 秒强制
  倒计时警示态、真实投放播报、R 重开恢复、Esc 回菜单复位）在新暂停
  语义下全部保持。

---

## [Unreleased] — epoch_004: supply-drop readout (补给抵达预告)

### Added
- **补给抵达预告读数**（`#supplyReadout`，位于敌情预告读数下方）：补给
  此前只按随机周期“不定期刷新”，玩家在残血或断弹时无法判断下一次投放
  何时到达、该不该转点。现在顶部 HUD 会实时倒数距离最近一次投放的
  倒计时并标明类型（`下一补给（弹药包）14.2 秒后抵达`），数据源与
  `updatePickups` 的 `pickupRespawnTimers` / `ambientPickupTimers`
  完全共用（`getSupplyDropSeconds()`），因此读数不会撒谎；无在途投放时
  显示“补给已全部在地图上　无在途投放”。
- **临近投放警示态**：倒计时低于 5 秒（`SUPPLY_WARN_SECONDS`）时读数转入
  金色脉冲态（CSS `supplyPulse`），与敌情读数的红色警示区分开；配色取
  小地图物资图例绿色系（`#68e899`），含 760px 响应式。
- **投放播报**：战斗中由刷新计时真正投放物资时，左下角战斗信息流播报
  一条“补给抵达：X 已投放”（`registerSupplyArrival`，kind `supply`）；
  开局铺场（`populateMapPickups`）不播报，避免开局刷屏。
- `probe-evidence/verify-supply-readout.mjs`：无头浏览器探针，真实进入
  无尽模式，断言菜单/结算/暂停态隐藏、HUD 与数据源一致且真实递减、
  2.2 秒强制倒计时进入金色警示态、真实血包投放（6→7）伴随战斗流播报、
  死亡结算瞬间读数熄灭、R 重开后读数以新数据恢复、Esc 回菜单复位，
  输出 `SUPPLY_READOUT_PROBE_PASSED` 与截图 `supply-*.png`。

### Changed
- `js/weapons.js`：新增 `registerSupplyArrival()` / `getSupplyDropSeconds()`
  / `updateSupplyReadout()`；`updatePickups()` 在拾取循环之后、战斗分支
  之前每帧同步读数（保证死亡瞬间立即隐藏），两条计时投放路径接入播报。
- `js/core.js`：新增 `supplyReadout*` DOM 引用、`SUPPLY_WARN_SECONDS` 与
  `supplyEscalating` 状态。
- `js/main.js`：`resetPlayer()` 与 `showModeMenu()` 复位读数警示态，
  上一局的倒计时不得带进新对局或菜单。
- `index.html` / `css/game.css`：新增读数 DOM 与样式（视觉语言与既有
  敌情预告读数一致）。

### Verification evidence on record (this epoch)
- `node probe-evidence/verify-supply-readout.mjs` → `SUPPLY_READOUT_PROBE_PASSED`
  （无头 Chromium，真实页面与真实游戏循环；`PAGE_ERRORS` 为空；截图
  `supply-0-menu.png`、`supply-1-combat.png`、`supply-2-escalating.png`、
  `supply-3-restarted.png`、`supply-4-menu-reset.png`）。
- `node probe-evidence/verify.mjs` → 全部阶段通过（BOOT / GAME_START /
  HOTKEYS / COMBAT / STREAK_EXPIRY / EMERGENCY_RELOAD / BEST_PERSIST /
  DANGER_SYSTEM.passed / RESTART / AUDIO_SYSTEM.passed），确认核心循环、
  武器热键、换弹、濒死警告与音效系统无回归（COMBAT 段的自动瞄准击杀数
  受软渲染帧率影响，另以独立命中检查确认 hitscan 健康：1 杀、100% 命中）。
- `node --check` 通过于全部 `js/*.js`。

## [Unreleased] — epoch_014: threat-tier progress bar

### Added
- **威胁等级进度条**（`#threatTrack`，位于任务进度条下方）：无尽模式中威胁等级
  此前只以一个裸数字出现，玩家无法判断距离下一级还有多远。现在顶部 HUD 会以
  真实百分比显示当前等级内的分数推进（`分数 % 800 / 800`），并标注
  “距离下一级 N 分”。
- **等级提升反馈**：跨过 800 分整数倍时进度条高亮闪烁 0.9 秒（CSS
  `threatTierFlash`），战斗信息流播报一次新等级的实际参数
  （敌兵生命 / 伤害 / 同屏数量），并播放一次等级提示音。同一等级只播报一次，
  同级刷新不会重复闪烁或刷屏。
- `probe-evidence/verify-threat-tier.mjs`：无头浏览器探针，真实进入无尽模式，
  驱动 790→800→900 分的等级跃迁，断言菜单隐藏、98.8% 逼近态、跃迁闪烁、
  播报与提示音、自动熄灭、同级不重复播报、关卡/菜单状态复位，
  并输出 `THREAT_TIER_PROBE_PASSED` 与截图 `tier-*.png`。

### Changed
- `js/combat.js`：新增 `updateThreatTierBar()`，由 `updateGameInfo()`
  （击杀结算与回合刷新的真实调用点）同步驱动；`updateVisualUI()` 中增加高亮
  闪烁的帧递减。
- `js/core.js`：新增 `threatTrack*` DOM 引用、`THREAT_TIER_FLASH_TTL`、
  `threatTierFlashTimer` 与 `threatTierShown` 跃迁检测状态。
- `js/main.js`：`resetPlayer()` 与 `showModeMenu()` 复位等级条状态，
  上一局的等级高亮与播报状态不会带进新对局。
- `index.html` / `css/game.css`：新增进度条 DOM 与样式（含 760px 响应式），
  视觉语言与既有任务进度条一致。

### Verification evidence on record (this epoch)
- `node probe-evidence/verify-threat-tier.mjs` → `THREAT_TIER_PROBE_PASSED`
  （无头 Chromium，真实页面与真实游戏循环，截图 `tier-0-menu.png`、
  `tier-1-combat.png`、`tier-2-flash.png`）。
- `node probe-evidence/verify.mjs` → 全部阶段通过（BOOT / GAME_START /
  HOTKEYS / COMBAT / STREAK_EXPIRY / EMERGENCY_RELOAD / BEST_PERSIST /
  DANGER_SYSTEM.passed / RESTART / AUDIO_SYSTEM.passed），确认核心循环、
  武器热键、连杀、换弹、濒死警告与音效系统无回归。
- `node --check` 通过于全部 `js/*.js`。

## [Unreleased] — hardening pass (replacement session)

### Added
- `CHANGELOG.md` (this file): a single documented entry point describing the
  artifact's runtime surface, shipped verification evidence, and known
  limitations.

### Scope of this change
- Purely additive: no existing file under `game/` was modified, so the working
  seed (`index.html`, `css/game.css`, `js/core.js`, `js/main.js`,
  `js/combat.js`, `js/enemies.js`, `js/maps.js`, `js/weapons.js`, and the
  bundled rendering dependency `js/vendor/three.min.js`) is untouched.
- Docs/assets shipped with the artifact: `README.md`, `LICENSE`, `.gitignore`,
  `assets/readme/gameplay-overview.png`, and the verification bundle in
  `probe-evidence/`.

### Verification evidence on record
- `probe-evidence/verify.mjs` is the probe driver shipped with the artifact.
- `probe-evidence/` also contains captured states: `01-menu.png`,
  `02-combat.png`, `03-restarted.png`, `04-danger.png`, and `deep-probe.png`.
  Their filenames indicate the probe pass reached the menu, entered combat,
  exercised restart, and captured a danger state.

### Known limitations
- The original session was cancelled and its transcript is unavailable to this
  replacement session; file existence and the probe screenshot names above are
  the only directly confirmed facts. Correctness of the JS modules has not
  been re-established here.
- The probe screenshots and `verify.mjs` were not re-inspected or re-run in
  this session; treat them as recorded evidence from the earlier run until a
  fresh `verify.mjs` pass is executed.
