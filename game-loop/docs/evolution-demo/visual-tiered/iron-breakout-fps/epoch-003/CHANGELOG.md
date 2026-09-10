# Changelog — `game`

Release notes and reviewer entry point for this artifact.

## [Unreleased] — kill score floats (击杀得分漂浮)

### Added
- **击杀得分漂浮**（`#scoreNumbers`）：击杀的得分此前只在左上角击杀播报里
  以文字逐条出现，战场上只能看到红色“-X 击杀”伤害数字，“这一杀到底赚
  了几分”要转头看右侧读数才确认。现在敌人被击杀的瞬间，击杀点会浮现一枚
  白色“+得分”数值（如 `+100`），爆头击杀为金色 `+100 爆头`（与击杀播报
  爆头徽章同色）；数值与 `killEnemy` 本帧写入累计分数的 `killScore`
  （100 × 当前威胁等级）完全同源、也与击杀播报条目的得分同源，读数不会
  撒谎。1.05 秒内上浮 0.85 世界单位并淡出，每枚生成时带 ±10px 随机水平
  偏移避免叠压；锚点在胸口高度，与头顶的红色伤害数字明确分层。纯反馈层：
  不参与命中判定、伤害、计分与连杀结算；由主循环逐帧驱动，真·暂停时在半
  空冻结（既不推进也不淡出），返回菜单立即清除，死亡结算 / 重开等其余状态
  按 TTL 自然淡出，无跨局残留。
- `probe-evidence/verify-kill-score.mjs`：无头浏览器探针，真实点击菜单进入
  无尽地图 0，十阶段断言：BOOT 菜单与引擎就绪、覆盖层存在且为空；GAME_START
  8 敌进入战斗；FRESH 空池零残留；KILL_BODY 真实 `damageEnemy` 躯干击杀：
  分数增量恰为 100、击杀播报顶条 `+100` 且徽章隐藏、屏幕出现普通 “+100”
  漂浮且带真实投影坐标（截图 `kill-score-body.png`，同帧可见死亡火花与
  白色 +100）；HEADSHOT_KILL 第二名敌人爆头击杀：分数增量 100、播报徽章
  可见、金色 “+100 爆头” 漂浮（截图 `kill-score-headshot.png`，金色漂浮与
  信息流“连杀 x2 伤害加成 +20%”同帧可见）；PAUSE_FREEZE 第三次击杀生成在
  场数值后真·暂停：所有可见数值的 transform / opacity 逐位冻结（截图
  `kill-score-paused.png`）；RESUME 恢复后数值继续推进；FADE 第四次击杀保
  证在场数值，TTL 内全部淡至 opacity 0 且对象池保留复用（DOM 不无限增长）；
  RESTART 真实 `damagePlayer(9999)` 致死结算后真实 `R` 重开：分数归零、新
  对局无可见得分漂浮（截图 `kill-score-restarted.png`）；MENU 返回菜单数值
  立即清除零残留。输出 `KILL_SCORE_PROBE_PASSED`，`CONSOLE_ERRORS` 为空，
  `PAGE_ERRORS` 仅含与既往各 epoch 一致的 2× headless 指针锁定噪声
  （WrongDocumentError）。

### Changed
- `js/combat.js`：命中伤害数字段之后新增击杀得分漂浮段——
  `spawnScoreNumber()` / `updateScoreNumbers()` / `clearScoreNumbers()`，
  投影使用专用暂存向量 `scoreNumberWorld`（不共享全局 `tempVector`，避免
  与血条 / 敌人 AI 的投影互相干扰）；`killEnemy()` 在 `score += killScore`
  之后立即调用 `spawnScoreNumber()`，实参即本帧真实 `killScore` 与
  `headshot` 标记。
- `js/core.js`：新增 `scoreNumbersHost` DOM 引用与 `scoreNumbers` 对象池及
  `SCORE_NUMBER_TTL = 1.05` / `SCORE_NUMBER_POOL_MAX = 16`（池满时抢占生命
  周期最短的节点，激烈交火下 DOM 元素上限 16 个）。
- `js/main.js`：主循环在 `updateDamageNumbers(delta)` 之后新增
  `updateScoreNumbers(delta)`（同一帧顺序，位于真·暂停门控之后故随帧
  冻结）；`showModeMenu()` 在 `clearDamageNumbers()` 之后新增
  `clearScoreNumbers()`，上一局数值不残留进菜单。
- `index.html` / `css/game.css`：新增覆盖层 DOM 与样式（与伤害数字覆盖层
  同一约定：绝对定位 + JS 每帧驱动；基础白色冷光，`.score-head` 爆头变体
  与击杀播报徽章同金）。

### Verification evidence on record (this epoch)
- `node probe-evidence/verify-kill-score.mjs` → `KILL_SCORE_PROBE_PASSED`
  （十阶段全过，见上）。
- `node probe-evidence/verify.mjs` → 全阶段通过（BOOT / GAME_START /
  HOTKEYS 五武器 / COMBAT 1 杀 100 分 / STREAK_EXPIRY / EMERGENCY_RELOAD /
  BEST_PERSIST / DANGER_SYSTEM.passed / RESTART / AUDIO_SYSTEM.passed），
  核心循环、热键、连杀、换弹、濒死警告与音效无回归。
- 回归套件：`verify-pause-freeze` → `PAUSE_FREEZE_PROBE_PASSED`（首跑曾在
  RESUME_SUPPLY_LIVE 撞上供应倒计时阈值——恢复后 1.3 秒挂钟内 SwiftShader
  慢渲染只推进了 0.45 秒，2.05 未低于 2.0；以本 epoch 三处调用点回退的
  休眠基线重跑复现同样失败（2.0000000000000018，浮点 epsilon 之差），
  确证属环境性计时 flake 而非本改动回归；恢复改动后重跑通过，
  PAGE_ERRORS 为空）；`verify-weapon-hotbar` → `WEAPON_HOTBAR_PROBE_PASSED`
  （重开路径与击杀结算链路无回归）。
- `node --check` 全部 `js/*.js` 语法通过；`css/game.css` 花括号配平。

---

## [Unreleased] — enemy fire tracers (敌人枪口曳光)

### Added
- **敌人枪口曳光**：此前敌人开火时玩家只有空间化枪声与枪口闪光可依据，
  “哪一枪从哪个方向来、打在哪”不可见；现在敌人每次开火（命中或偏射）都会
  从枪口到弹着点画一条橙色细光束——命中时终点取视点前 0.35 米（光束不穿进
  视线，登记先于伤害结算，若此枪致命，结算屏的清理路径经
  `clearEnemyTracers()` 一并熄灭、无残留）；偏射打墙时终点取墙面火花落点
  （沿面法线外移 0.03 米，光束与火花视觉上连成一线）；射线未触及任何表面
  时按完整射距画到射线尽头（沿散布后方向），方向不丢失。光束为 5 段开放
  圆柱，半径 0.024 米，加法混合、不写深度，基础不透明度 0.78，0.13 秒全
  生命周期前 0.08 秒满亮、最后 0.05 秒线性淡出——够快不刷屏、够慢可读。
  与敌人开火空间化音效（听声辨位）、受击方向弧线（受击后的方位提示）互补。
  纯反馈层：不参与命中判定、伤害、计分与重生，数据源与空间化枪声同源的
  `enemyShotOrigin` / `enemyShotDirection`，无独立随机方向。由主循环逐帧驱动
  （`updateEnemyTracers(delta)`），真·暂停时随帧冻结（既不推进也不淡出）；
  在场上限 14 枚、满池替换最老的一枚，多敌连射也不无限追加；圆柱几何全池
  共享（不随单枚释放），材质逐枚克隆以独立控制不透明度、到期即 dispose。
  死亡当帧（结算屏）与开局 / 过关 / 返回菜单（经 `clearEnemiesAndEffects()`）
  统一清除，光束不跨局残留。
- `probe-evidence/verify-enemy-tracer.mjs`：无头浏览器探针，真实点击菜单进入
  无尽地图 0，十阶段断言：BOOT 菜单与引擎在位、场景无在场曳光；GAME_START
  真实点击开局 8 敌、生命 100、无残留；SHOT_TRACER 真实走 `enemyShoot` 路径
  开火一发：恰好新增一枚曳光（不透明度 > 0.7）、起点距枪口 ≤ 0.2 米，命中时
  终点距视点 0.35 ± 0.06 米、偏射时距视点 > 1 米（截图 `enemy-tracer-live.png`，
  另有 3 发真实连射后截取，光束在空中清晰可见）；TRACER_FADE 在场曳光在
  生命周期内自然走完满亮→淡出，池与场景网格双双归零；MISS_TRACER 以
  `Math.random()=0.999` 强制命中判定失败：生命不变、终点落在墙面火花落点
  （> 1 米）与 `spawnImpact` 同源；POOL_CAP 连续直接生成 20 枚，在场峰值
  ≤ 14（替换最老），确定性 `updateEnemyTracers(0.2)` 衰减后池归零；
  PAUSE_FROZEN 真·暂停后在场曳光的 from/to 坐标与不透明度在 600ms 暂停帧内
  逐字节不变（截图 `enemy-tracer-paused.png`）；PAUSE_RESUME 恢复指针锁定后
  曳光走完剩余淡出并清空；DEATH_CLEAR 致命一击当帧结算屏与在场曳光同步清除
  （截图 `enemy-tracer-death.png`）；RESTART 真实 `R` 重开：满血、45/180 弹药、
  机枪、8 敌、无残留曳光，核心循环完好。输出 `ENEMY_TRACER_PROBE_PASSED`，
  `CONSOLE_ERRORS` 为空，`PAGE_ERRORS` 仅 2× headless 指针锁定噪声
  （WrongDocumentError），与既往各 epoch 一致。

### Changed
- `js/combat.js`：新增敌人枪口曳光区块（常量 `ENEMY_TRACER_LIFETIME = 0.13` /
  `ENEMY_TRACER_FADE = 0.05` / `ENEMY_TRACER_BASE_OPACITY = 0.78` /
  `ENEMY_TRACER_POOL_MAX = 14`、共享 `enemyTracerGeometry`、
  `spawnEnemyTracer(from, to)` / `updateEnemyTracers(delta)` /
  `clearEnemyTracers()`，置于特效区块之后）。
- `js/enemies.js`：`enemyShoot()` 三处接入 `spawnEnemyTracer()`——命中分支
  （登记先于 `damagePlayer`，终点 = 视点前 0.35 米）、打墙偏射分支
  （`spawnImpact` 之后，终点 = 火花落点沿面法线 + 0.03 米）、无墙偏射分支
  （终点 = 散布后方向的完整射距）；数据源与空间化枪声同源
  （`enemyShotOrigin` / `enemyShotDirection`）。
- `js/main.js`：`animate()` 在 `updateEffects(delta)` 之后同帧调用
  `updateEnemyTracers(delta)`；`clearEnemiesAndEffects()`（覆盖开局 / 过关 /
  返回菜单路径）与 `showGameOver()`（死亡当帧）各新增 `clearEnemyTracers()`。

## [Unreleased] — damage-taken numbers (受击伤害数值)

### Added
- **受击伤害数值**：此前被敌人枪弹或近战命中后，玩家要移开视线看右侧生命读数
  才能判断这一击掉了多少；现在屏幕中下方（准星下方安全区，视口高度 63.5% 处，
  水平 ±90px 随机散布避免多枚完全重叠）会浮现一枚红色数值（如 `-8`），直接显示
  当前聚合窗口内实际受到的伤害，数值上浮 46px、0.85 秒内淡出，不看右侧读数也能
  立刻判断这一击的代价、是否该撤退找血包。近战是逐帧连续 tick
  （`damagePlayer(damage * delta)`），逐帧生成会刷屏，因此按 0.35 秒窗口聚合：
  窗口累计 ≥ 1 才生成一枚，数值为窗口内真实伤害之和（四舍五入），每窗口至多一枚，
  不足 1 不出现——不刷屏也不漏显。与伤害数字（锚定敌人世界坐标）不同，受击数值
  锚定屏幕本身，盲区方向受到的伤害同样可见、不会飘到屏幕外。纯反馈层：不参与
  命中判定、伤害、计分与连杀结算；累计入口与低血量威胁横幅共用
  `damagePlayer()` 数据源，方向不会撒谎。由主循环逐帧驱动
  （`updateDamageTakenNumbers`），真·暂停时在半空冻结（既不推进也不淡出）；
  节点池上限 8 枚、优先复用到期节点，持续受击也不无限追加 DOM。死亡当帧、
  过关结算、重开与返回菜单时经 `clearDamageTakenNumbers()` 统一清除在场数值与
  窗口累计，无旧数值残留。
- `probe-evidence/verify-damage-taken-number.mjs`：无头浏览器探针，真实点击菜单
  进入无尽地图 0，十一阶段断言：BOOT 菜单与引擎与受击宿主均在位且无可见数值；
  GAME_START 真实点击开局 8 敌、生命 100、无残留数值；SINGLE_HIT 真实
  `damagePlayer(7, enemy)` 单发命中：恰一枚 `-7`，数值与真实掉血同源对账
  （100 → 93），位置独立复算（x 偏离屏幕中心 ≤ 100px、y 与 63.5% 锚点偏差
  ≤ 60px，截图 `damage-taken-live.png`）；AGGREGATE_LIT 一窗内 4 × 0.4 近战式
  tick 只生成恰好一枚 `-2`（窗口求和、四舍五入），pending 归零、生命 98.4 同
  源对账；AGGREGATE_NO_RESPAWN 窗口耗尽与数值生命周期双双过期后无第二枚自行
  生成；SUPPRESS 单帧 0.4 tick 窗口总和不足 1：99.6 同源对账通过且 1.2 秒内
  不出现任何数值（pending 留在 0.4 等后续累加，不漏显）；PAUSE_FROZEN 真·
  暂停后在场 `-3` 数值的 `transform` 与 `opacity` 在 600ms 暂停帧内逐字节不变
  （截图 `damage-taken-paused.png`）；PAUSE_RESUME_FADED 恢复指针锁定后数值
  走完剩余淡出、宿主清空；DEATH_CLEAR 致命一击当帧（`damagePlayer(9999)`）
  结算屏与在场数值、pending 累计同步清除（截图 `damage-taken-death.png`）；
  RESTART 真实 `R` 重开：满血、零分数、无残留数值与 pending，再受击时 `-5`
  照常浮现且掉血同源对账通过（截图 `damage-taken-restart.png`），核心循环完好。
  输出 `DAMAGE_TAKEN_NUMBER_PROBE_PASSED`，`CONSOLE_ERRORS` 为空，
  `PAGE_ERRORS` 仅 2× headless 指针锁定噪声（WrongDocumentError），与既往
  各 epoch 一致。

### Changed
- `index.html`：`#damageNumbers` 之后新增 `#damageTakenNumbers` 容器（含中文
  注释），不改变既有 HUD 结构。
- `css/game.css`：新增 `#damageTakenNumbers` 全屏锚定层（`pointer-events: none`、
  `overflow: hidden`）与 `.damage-taken-number` 样式（红色 `#ff6a5a`、22px
  Rajdhani，位置由 JS 以 transform 驱动，无 CSS 动画以便真·暂停精确冻结）。
- `js/core.js`：新增 DOM 引用 `damageTakenNumbersHost`，状态
  `damageTakenNumbers[]` / `damageTakenPending` / `damageTakenWindowTimer` 与
  常量 `DAMAGE_TAKEN_NUMBER_TTL = 0.85` / `DAMAGE_TAKEN_NUMBER_POOL_MAX = 8` /
  `DAMAGE_TAKEN_WINDOW = 0.35`。
- `js/combat.js`：新增受击伤害数值区块（`createDamageTakenNumberElement` /
  `acquireDamageTakenNumber` / `spawnDamageTakenNumber` /
  `updateDamageTakenNumbers(delta)` / `clearDamageTakenNumbers()`，置于伤害数字
  区块之后）；`damagePlayer()` 在 `recordDamageTaken(amount)` 之后累加
  `damageTakenPending += amount`（与低血量威胁横幅同源）。
- `js/main.js`：`animate()` 在 `updateDamageNumbers(delta)` 之后同拍调用
  `updateDamageTakenNumbers(delta)`；`resetPlayer()` / `showGameOver()` /
  `completeCurrentLevel()` / `showModeMenu()` 四条清理路径各追加
  `clearDamageTakenNumbers()`。

## [Unreleased] — supply direction guide (补给指引)

### Added
- **补给指引**：此前玩家被提示“备弹耗尽 · 寻找蓝色弹药包”或“立即撤退寻找医疗包”时，
  只能靠小地图逐个找图标；现在屏幕边缘会出现一枚指向最近同类补给的箭头——
  弹药耗尽（弹匣与备弹同时为空，与换弹提示同口径、只看当前武器）时青色菱形指向
  最近的蓝色弹药包，生命值危急（与红色濒死横幅同一阈值触发/解除）时绿色十字指向
  最近的血包，箭头旁标注实际距离（如 `33m`）。颜色与小地图战术图标一致
  （青 = 弹药包、绿 = 血包），与红色威胁箭头（三角 + 距离）形状、颜色明确区分；
  两种指引可同屏共存。0.2 秒游戏时基刷新（与威胁标记同节奏），指向最近同类补给，
  被拾取后熄灭或改指次近目标，地图上无该类型补给时箭头熄灭（横幅/提示仍在，
  由补给抵达预告给出 ETA）。纯反馈层：不参与命中判定、伤害、计分与重生逻辑；
  方位角与威胁指示共用 `relativeAngleTo`，数据源与小地图 / 补给投放共用
  `pickups` 列表，方向与距离不会撒谎。真·暂停整帧冻结并在暂停瞬间熄灭、
  恢复后按当前补给数据源重新点亮；死亡当帧、重开与返回菜单时经
  `hideSupplyGuide()` 统一清除，无旧方向残留。
- `probe-evidence/verify-supply-guide.mjs`：无头浏览器探针，真实点击菜单进入
  无尽地图 0，十一阶段断言：BOOT 菜单与引擎与两枚指引均存在且隐藏；GAME_START
  新对局 8 敌且地图上确有弹药包与血包；BASELINE 满弹 + 满血下两枚指引保持
  熄灭；AMMO 把当前武器弹药置 0/0 并走真实 `updateAmmoUI()`：青色菱形点亮，
  其 `rotate()` 方位与探针独立复算的最近弹药包方位角差 < 0.15 rad、距离读数
  与真实距离误差 ≤ 1 m，同时换弹提示恰为“备弹耗尽 · 寻找蓝色弹药包”
  （同口径共证，截图 `supply-guide-ammo.png`）；PICKUP 真实 `collectPickup()`
  拾取弹药包补满全部远程弹药后指引下一拍熄灭；HEALTH 把生命值置 25 触发
  濒死横幅：绿色十字点亮，方位/距离同口径对账通过且横幅可见
  （截图 `supply-guide-health.png`）；NO_PICKUP 从 `pickups` 摘除全部血包后
  箭头熄灭而横幅保留（截图 `supply-guide-none.png`）；RESPAWN 真实
  `spawnPickup("血包")` 投放后箭头按新目标重新点亮；PAUSE 真·暂停两枚指引
  同步熄灭（截图 `supply-guide-paused.png`），恢复后按活体数据源重新点亮且
  方位与独立复算一致；DEATH 真实 `damagePlayer(9999)` 致死当帧两枚指引与结算
  屏同步熄灭（截图 `supply-guide-death.png`）；RESTART 真实 `R` 重开：满弹
  满血、零分数、两枚指引无残留，再置 0/0 弹药指引照常点亮且方位对账通过
  （截图 `supply-guide-restart.png`）。输出 `SUPPLY_GUIDE_PROBE_PASSED`，
  `CONSOLE_ERRORS` 为空，`PAGE_ERRORS` 仅 2× headless 指针锁定噪声
  （WrongDocumentError），与既往各 epoch 一致。

### Changed
- `index.html`：`#threatMarkersPanel` 之后新增 `#supplyGuide` 容器与
  `#ammoGuide` / `#healthGuide` 两枚指引元素（箭头 + 距离标签），
  不改变既有 HUD 结构。
- `css/game.css`：新增 `#supplyGuide` 样式块——与威胁标记同构的屏幕中心锚点
  + `rotate` 定位；青色菱形（`clip-path` 四边菱形）与绿色十字（`clip-path`
  十二点十字）两种箭头形态，1.1 秒 `supply-guide-pulse` 缩放脉冲；
  `pointer-events: none`，z-index 与威胁标记层一致。
- `js/core.js`：新增 DOM 引用（`supplyGuidePanel` / `ammoGuideElement` /
  `healthGuideElement`）、常量 `SUPPLY_GUIDE_INTERVAL = 0.2` 与刷新时钟
  `supplyGuideTimer`。
- `js/combat.js`：新增 `bindSupplyGuide()` / `nearestPickupOfType()` /
  `setSupplyGuide()` / `hideSupplyGuide()` 与 `updateSupplyGuide(delta)`
  （`gameState !== "战斗"` 时统一熄灭；弹药口径 = 当前武器弹匣 ≤ 0 且备弹 ≤ 0，
  健康口径 = `lowHealthActive` 且未死亡）；`updateVisualUI()` 在
  `updateLowHealthWarning(delta)` 之后调用，随真·暂停整帧冻结。
- `js/main.js`：重开复位路径在清空威胁标记后追加 `supplyGuideTimer = 0` 与
  `hideSupplyGuide()`；真·暂停入口在 `clearTargetRange()` 之后追加
  `hideSupplyGuide()`，恢复后由主循环按当前补给数据源重新点亮。

### Verified
- `node probe-evidence/verify-supply-guide.mjs` → `SUPPLY_GUIDE_PROBE_PASSED`
  （十一阶段全过，见上；`PAGE_ERRORS` 仅 2× headless 噪声）。
- `node probe-evidence/verify.mjs` → 主回归套件全过（BOOT / HOTKEYS / COMBAT /
  AFTER_FIRE / STREAK_EXPIRY / EMERGENCY_RELOAD / BEST_PERSIST / DANGER_SYSTEM
  passed=true / RESTART / AUDIO_SYSTEM passed=true），退出码 0，`PAGE_ERRORS`
  仅 2× headless 噪声。
- `node probe-evidence/verify-pause-freeze.mjs` → `PAUSE_FREEZE_PROBE_PASSED`
  （暂停 7.2 s 全部计时器逐位冻结、读数熄灭、恢复按暂停时长补偿）。
- `node probe-evidence/verify-reload-prompt.mjs` → `RELOAD_PROMPT_PROBE_PASSED`
  （换弹提示各状态、暂停冻结与重开复位不受本 epoch 影响）。
- `node probe-evidence/verify-target-range.mjs` → `TARGET_RANGE_PROBE_PASSED`
  （上一 epoch 的准星目标距离读数回归全过）。

## [Unreleased] — crosshair target range readout (准星目标距离读数)

### Added
- **准星目标距离读数**：十字线射线命中活体敌人时，准星下方（`top: calc(50% + 36px)`）
  显示到命中点的实际距离（`toFixed(1)` + " m"，如 `13.7 m`），按距离带分色——
  ≤20 米近程绿 `#9fe8b8`、20–45 米中程金 `#ffd76a`（`.range-mid`）、>45 米
  远程红 `#ff8f8f`（`.range-far`），让玩家开火前就能读出提前量与命中难度，
  狙击镜下尤其有用。射线以 12.5 Hz 游戏时基时钟驱动（`TARGET_RANGE_TICK=0.08`，
  `far` 上限 160 米），目标集为 `raycastWorld` + 活体敌人 `hitMeshes`，成本与
  一发命中扫描同量级；距离取 `hits[0].point` 到相机位置，墙体 / 地面遮挡或
  指向空地时熄灭（仅活体敌人点亮，死亡当帧不再显示）。显示元素是
  `#crosshair` 的独立兄弟节点：狙击镜（Q）准星隐藏时仍可见，`z-index: 19`
  压在狙击镜遮罩（18）之上、落在镜片圆内，`pointer-events: none` 不挡输入。
  纯反馈层：不进入命中判定、伤害、计分与重生逻辑；真·暂停整帧冻结随之冻结，
  暂停瞬间 / 死亡结算 / 过关结算 / 返回菜单 / 重开共 5 条路径由
  `clearTargetRange()` 立即熄灭，不让旧距离残留；恢复后按实时距离重新点亮。
- `probe-evidence/verify-target-range.mjs`：无头浏览器探针，真实点击菜单进入
  无尽地图 0（出生点 (20,47) 朝 +Z，西侧 yard 走廊 z=47 沿 −X 开放用于
  staging），用一个速度 / 探测 / 射程全清零的活体非塔顶假人做静态目标（经
  `findNearestSafePosition` 传送），以 `player.yaw/pitch` 直接摆位瞄准，
  11 阶段断言：BOOT 预战标签 opacity 0（CSS 默认）；GAME_START 新对局 8 敌；
  AIM_NEAR 13.7 m 近程绿、AIM_MID 31.7 m `.range-mid`、AIM_FAR 47.7 m
  `.range-far`——每段都与页内独立射线（同一相机 + 同一目标集）对账一致；
  SCOPE 开镜后 `#crosshair` 隐藏而标签仍按 47.7 m 点亮；AIM_BEHIND 转向
  身后空地熄灭且与独立射线一致；PAUSE_CLEAR 真·暂停即熄灭；RESUME 恢复后
  重新点亮 13.7 m；GAME_OVER 致死当帧熄灭；RESTART_WORKS 真实 R 重开干净、
  重摆目标后再点亮。输出 `TARGET_RANGE_PROBE_PASSED`，截图
  `target-range-near/mid/far/scope/paused/death/restart.png` 存
  `probe-evidence/`。

### Changed
- `index.html`：`#hitMarker` 之后新增 `<div id="targetRangeLabel"></div>`
  （`#crosshair` 的同级兄弟，HUD 层内）。
- `css/game.css`：`#targetRangeLabel` 定位 / 字体 / 默认近程绿 / 90ms opacity
  过渡，及 `.range-mid` / `.range-far` 两个距离带配色。
- `js/core.js`：`hitZoneLabel` 之后新增
  `const targetRangeLabel = document.getElementById("targetRangeLabel")`。
- `js/combat.js`：新增 `TARGET_RANGE_TICK` / `TARGET_RANGE_FAR` /
  `TARGET_RANGE_MID` / `TARGET_RANGE_FAR_BAND` 常量、预分配
  `targetRangeRaycaster` / `targetRangeScreenCenter`、`updateTargetRange(delta)`
  （仅 `gameState === "战斗"` 且指针锁定时按 12.5 Hz 时基做屏中心射线，活体
  敌人命中则写距离 + 距离带类名并点亮，否则熄灭）与 `clearTargetRange()`
  （复位时基 + 熄灭 + 清文本 / 类名）；`updateTargetRange(delta)` 紧跟
  `hitZoneLabel` 块之后在 `updateVisualUI()` 中调用，真·暂停帧冻结自动覆盖。
- `js/main.js`：`resetPlayer()`、`completeCurrentLevel()`、`showGameOver()`、
  `showModeMenu()` 与 `onPointerLockChange()` 暂停分支共 5 条复位 / 退出路径
  各加一行 `clearTargetRange()`。

### Verification evidence on record (this epoch)
- `node probe-evidence/verify-target-range.mjs` →
  `TARGET_RANGE_PROBE_PASSED`（11 阶段全过，近 / 中 / 远三段距离与页内独立
  射线逐一对账；`CONSOLE_ERRORS` 为空，`PAGE_ERRORS` 仅 2× headless 指针锁定
  噪声 WrongDocumentError，与既往各 epoch 一致）。
- `node probe-evidence/verify.mjs` → 全阶段与既往基线同构（BOOT 菜单就绪 /
  GAME_START 8 敌 / HOTKEYS 五武器 / COMBAT 击杀 score 0→100 / AFTER_FIRE /
  STREAK_EXPIRY 1→0 / EMERGENCY_RELOAD 可见 / BEST_PERSIST 100 /
  DANGER_SYSTEM passed=true / RESTART 失败→战斗 8 敌满血 / AUDIO_SYSTEM
  passed=true；本局 `enemyShotEvents` 0），退出码 0，`PAGE_ERRORS` 仅 2×
  headless 噪声。
- `node probe-evidence/verify-pause-freeze.mjs` → `PAUSE_FREEZE_PROBE_PASSED`
  （暂停 6.3 s 全部计时器逐位冻结、`readoutsExtinguished=true` 覆盖本 epoch
  新增读数、恢复后按暂停时长补偿）。
- `node probe-evidence/verify-kill-feed.mjs` → `KILL_FEED_PROBE_PASSED`
  （击杀条目 / 爆头徽章 / 5 条上限 / 暂停冻结 / 重开清空全过，覆盖本 epoch
  改动的复位路径）。

## [Unreleased] — spatialized enemy gunfire (敌人开火空间化音效)

### Added
- **敌人开火空间化音效**：敌人开火现在会发出枪声，并带上空间信息——立体声像按枪口相对
  玩家朝向的方位计算（`enemies.js` 用相机前向 × 枪口方位的叉/点积求方位角正弦，
  直接喂给 `SFX.enemyShot(weaponName, pan, distance)`），距离按 5 米满音量 →
  46 米完全衰减的线性 falloff 缩放音量、同时把带通滤波亮度从 100% 压到 45%
  （远处更闷）。音色复用 `WEAPON_SOUNDS` 音色表：塔顶守卫按"狙击枪"（低频长
  衰减），其余敌人按"机枪"，与玩家自己的 `shot()` 同源可辨。此前敌人开火在
  听感上完全无声，玩家只能靠命中瞬间的受击方向弧线与红色低血量警报事后定位
  威胁；现在枪声提前给出"谁在哪个方向开枪"。纯反馈层：不进入命中判定、
  伤害、计分与重生逻辑；`enemyShoot()` 只在真实战斗帧执行（updateEnemyAI 在
  真·暂停 / 结算 / 菜单 / 指针未锁定时整体冻结），音效随之冻结。每次敌人开火
  计 1 个 SFX 事件（与 `shot()` 同口径），并单独累计 `enemyShotEvents`、
  记录 `lastEnemyShot {weapon, pan, distance, gain}`，供探针把异步敌人枪声
  与玩家动作触发的声音分开断言。
- `probe-evidence/verify-enemy-shot-spatial.mjs`：无头浏览器探针，真实点击菜单
  进入无尽地图 0，九阶段断言：BOOT 菜单与引擎与 SFX 就绪；GAME_START 新对局
  8 敌、事件基线可读；LEFT_SHOT 经 `enemyCanSeePlayer()` 选定的 LOS 走廊把活体
  非塔顶敌人传送到玩家左侧 12 米（地图 0 出生点 (20,47) 朝向 +Z，左侧走廊
  270°），真实 `enemyShoot()`：SFX 事件 +1、`enemyShotEvents +1`、
  `pan ≈ -1.0`（左）、12 米增益 0.7–0.95、枪口闪光同步点亮，命中时额外 +1
  次既有 `hurt()` 事件（按血量差精确对账）（截图 `enemy-shot-spatial.png`
  于 RIGHT 阶段截取）；RIGHT_SHOT 出生点右侧 90° 被墙体封死，改经几何标定
  的右前 75° 走廊（dx 3 / dz 10）同口径断言 `pan ≈ +1.0`、增益同区间
  （无 LOS 时回退到自然站位且方位 > 0.6 的敌人）；FAR_SHOT 经 SFX API 55 米
  开火：`gain === 0`（超出 46 米衰减范围）但事件仍计 1；PAUSE_FREEZE 真·暂停
  2.5 秒：`enemyShotEvents` 逐位不变（AI 帧冻结）；LIVE_SHOT 把敌人传送到后方
  10 米（150–210° 开放象限）并预置追击 / 清冷却，真实 `updateEnemyAI()` 循环
  在 12 秒内自发放枪：事件到达且 `lastEnemyShot` 的 pan/gain/weapon 均在合法
  区间（本次 pan 0.0——正后方开火）；DEATH_RESTART 真实 `damagePlayer(9999)`
  致死当帧进入结算，真实 `R` 重开：新对局机枪满弹 45/180、无状态残留。
  输出 `ENEMY_SHOT_SPATIAL_PROBE_PASSED`，`CONSOLE_ERRORS` 为空，`PAGE_ERRORS`
  仅含与既往各 epoch 一致的 2× headless 指针锁定噪声（WrongDocumentError）。

### Changed
- `js/audio.js`：新增 `enemyShotEvents` / `lastEnemyShot` 状态与
  `ENEMY_SHOT_FULL_DIST` / `ENEMY_SHOT_FALLOFF_DIST` 常量、`enemyShotGain()`
  距离 falloff、`connectPanner()`（`StereoPannerNode` 可用时插入声像，否则
  直通，headless stub 环境安全）、`playPosNoise()` / `playPosTone()`（带声像
  版噪声 / 音调）与 `sfx.enemyShot(weaponName, pan, distance)`（静音门 /
  `emit()` 口径与既有方法一致）；`getStats()` 增加 `enemyShotEvents` 与
  `lastEnemyShot`。既有方法的节点图与音色参数逐位不变。
- `js/enemies.js`：新增 `enemyShotPanForward` / `enemyShotPanSource` 预分配
  向量；`enemyShoot()` 在枪口闪光置位后、命中/未命中判定前计算方位 pan
  （前向 × 源向叉积 z 分量 / 点积 → `sin(atan2)` 即方位角正弦，右为正）与
  枪口→相机距离，调用 `SFX.enemyShot()`；命中结算（`damagePlayer`）、散布、
  弹道射线、火花与冷却语义全部保持原样。
- `probe-evidence/verify-record-chase.mjs`：破纪录"不再次庆祝"窗口的严格
  SFX 断言（120 毫秒真实时间窗）现在减去 `enemyShotEvents` 增量——异步敌人
  枪声（本 epoch 新增）不再污染"破纪录逻辑不得再发声"的原断言语义；其余
  断言逐条不变。
- `probe-evidence/audio-selftest.mjs`：stub AudioContext 上新增
  `enemyShot` 覆盖——计数（`enemyShotEvents` 与总事件双增）、近距满增益
  元数据、25.5 米中程 falloff ≈ 0.5、60 米增益归零、静音门同时锁住
  `enemyShotEvents`。

### Verification evidence on record (this epoch)
- `node probe-evidence/verify-enemy-shot-spatial.mjs` →
  `ENEMY_SHOT_SPATIAL_PROBE_PASSED`（九阶段全过：LEFT pan -0.996 /
  gain 0.828、RIGHT pan +0.981 / gain 0.873、FAR gain 0、PAUSE 冻结、
  LIVE 真实 AI 自发、RESTART 干净重开，见上）。
- `node probe-evidence/verify.mjs` → 全阶段与既往基线同构（BOOT /
  GAME_START 8 敌 / HOTKEYS 五武器 / COMBAT 击杀 score 0→100 / AFTER_FIRE /
  STREAK_EXPIRY / EMERGENCY_RELOAD / BEST_PERSIST / DANGER_SYSTEM
  passed=true / RESTART 失败→战斗 / AUDIO_SYSTEM passed=true，相对口径
  断言全部通过；本局随机性下事件计数 73→80→88，音频阶段 `passed=true`，
  本局敌人未开火故 `enemyShotEvents` 为 0——无敌人枪声时既有路径零变化）。
- `node probe-evidence/verify-dry-fire.mjs` → `DRY_FIRE_PROBE_PASSED`
  （九阶段全过；各严格 SFX 增量均在同一段同步脚本内测量，AI 帧无法插入，
  敌人枪声不进入窗口，探针无需改动）。
- `node probe-evidence/verify-record-chase.mjs` → `RECORD_CHASE_PROBE_PASSED`
  （破纪录庆祝 / 二次不响 / 结算对比行 / 重开与菜单复位 / 关卡模式不显示
  全部通过；二次窗口断言已扣除异步敌人枪声）。
- `node probe-evidence/audio-selftest.mjs` → `AUDIO_SELFTEST_OK`
  （新增 enemyShot 五项检查全过，mute gates enemyShot 通过）。

## [Unreleased] — dry-fire feedback (空仓干火反馈)

### Added
- **空仓干火反馈**：弹匣为空时扣扳机（含自动换弹进行中连扣）现在给出明确
  的"扳机已扣下但未发射"反馈——一声极短高滤波的空膛机械双响（`SFX.dryFire()`，
  音色比切枪声更尖更脆，可区分），同时第一人称枪身做一次小幅点动（
  `weaponRecoil +0.05`，小于任何实弹后坐，经既有 `damp(17)` 自然衰减）。
  此前空仓扣扳机完全无声无动：玩家在换弹窗口内或备弹耗尽时连续扣扳机，
  无法区分"没扣响"与"没扣下"，只能靠右侧读数与准星提示间接推断。
  按住扳机时反馈按 0.16 秒节奏门限触发（`DRY_FIRE_INTERVAL`），防止连扣
  造成点击噪声刷屏；自动换弹进行中不重复启动换弹，无备弹时保留原有
  "弹药耗尽：寻找蓝色弹药包"播报（1.2 秒节流不变）。真·暂停 / 结算 / 菜单
  下 `shoot()` 提前返回，干火反馈不会在冻结期触发。
- `probe-evidence/verify-dry-fire.mjs`：无头浏览器探针，真实点击菜单进入
  无尽地图 0，九阶段断言：BOOT 菜单与引擎与 SFX 就绪；GAME_START 新对局
  8 敌、SFX 上下文已建且未静音；NORMAL_SHOT 满弹匣手枪真实 `shoot()`：
  弹匣 15→14、`shotsFired +1`、SFX 事件 +1（实弹路径无回归，近垂直瞄准
  避免误伤）；DRY_EMPTY_RESERVE 空仓有备弹：`reloadingWeapon="手枪"`（自动
  换弹启动）、SFX 事件恰 +2（干火 + 换弹）、`weaponRecoil>0`（枪身点动）、
  换弹指示器可见（截图 `dry-fire-reload.png`）；DRY_RATE_LIMIT 同一同步块内
  首次扣扳机（距上次点击 >0.16 秒，计 1 次）后连扣 25 发：SFX 事件总增量
  恰为 1、快扣增量为 0（0.16 秒门限生效）；RELOAD_DONE 换弹完成弹匣回满
  15 / 备弹 60；DRY_NO_RESERVE 弹匣与备弹双空：SFX 事件恰 +1（仅干火点击、
  无换弹启动）、`reloadingWeapon=null`、播报"弹药耗尽：寻找蓝色弹药包"、
  准星提示 `prompt-out` 态"备弹耗尽 · 寻找蓝色弹药包"、紧随第二扣增量为 0
  （截图 `dry-fire-out.png` 可见红色提示与播报同帧）；PAUSE 真·暂停下
  `shoot()` 完全无效（SFX 增量 0、`weaponRecoil` 逐位不变，整帧冻结路径
  不受干扰，截图 `dry-fire-paused.png`）；DEATH_RESTART 真实
  `damagePlayer(9999)` 致死当帧进入结算，真实 `R` 重开：新对局机枪满弹
  45/180、无换弹残留、提示清空（截图 `dry-fire-restarted.png`）。
  输出 `DRY_FIRE_PROBE_PASSED`，`CONSOLE_ERRORS` 为空，`PAGE_ERRORS` 仅含
  与既往各 epoch 一致的 2× headless 指针锁定噪声（WrongDocumentError）。

### Changed
- `js/audio.js`：新增 `SFX.dryFire()`——两段 28/24ms 高滤波（2400/3100Hz，
  Q=4）短噪声，第二段延迟 42ms，构成"咔-咔"空膛双响；沿用 `reload()` 的
  setTimeout 双段模式与统一静音门 / `emit()` 计数。
- `js/core.js`：新增 `lastDryFireTime`（初始 -Infinity），与
  `lastEmptyAmmoNotice` 同为干火 / 播报节奏限制器。
- `js/combat.js`：新增 `DRY_FIRE_INTERVAL` / `DRY_FIRE_RECOIL_KICK` 常量与
  `playDryFire()`；`shoot()` 头部重排——空仓判定先于 `reloadingWeapon` 提前
  返回，使"换弹进行中空仓连扣"也能得到干火反馈（原路径在此完全静默），
  且不再对已在进行的换弹重复调用 `startReload`；无备弹播报逻辑与实弹路径
  （冷却、散布、后坐、弹道）逐行保持原语义。
- `js/main.js`：`resetPlayer()` 复位 `lastDryFireTime`，干火节奏不跨局残留。

### Verification evidence on record (this epoch)
- `node probe-evidence/verify-dry-fire.mjs` → `DRY_FIRE_PROBE_PASSED`
  （九阶段全过，见上；NORMAL_SHOT 同时守护了重排后实弹路径）。
- `node probe-evidence/verify.mjs` → 全阶段输出与改动前基线一致
  （BOOT / GAME_START / HOTKEYS 五武器 / COMBAT 1 击杀 score 0→100 /
  AFTER_FIRE 打空自动换弹 / STREAK_EXPIRY / EMERGENCY_RELOAD / BEST_PERSIST /
  DANGER_SYSTEM passed=true / RESTART 失败→战斗 / AUDIO_SYSTEM passed=true，
  音效事件计数 69→76→87 与既往口径一致），核心循环、重开路径与音频系统
  无回归。

## [Unreleased] — kill feed (击杀播报)

### Added
- **击杀播报**：左上角（生命值面板下方）逐次播报每次击杀——击杀武器名、
  本击得分与爆头徽章。此前击杀只混在左下角通用战斗信息流里（与补给、
  残血预警、连杀结算同列），得分来源需要玩家自行心算；现在每条播报的
  得分与 `killEnemy` 写入 HUD 累计分数完全同源（100 × 当前威胁等级），
  爆头击杀带金色徽章与金色左边框，一眼可辨武器与收益。武器取致死一击
  的来源：hitscan / 近战取 `currentWeapon`，火箭弹等延迟命中在弹道发射
  时记录武器名（`projectile.weapon`），落点结算不随玩家切枪漂移。最新
  一条置顶，最多 5 条，4.2 秒窗口内 0.6 秒淡出。纯视觉层：不进入命中
  判定、计分与重生逻辑；真·暂停期间 `updateVisualUI` 不执行，条目倒计时
  随之冻结（探针 PAUSE_FREEZE 断言逐位相等）；死亡当帧（`showGameOver`）、
  重开（`resetPlayer`）与返回菜单（`showModeMenu`）三条路径均经
  `clearKillFeed()` 整列清除，不残留进下一局。
- `probe-evidence/verify-kill-feed.mjs`：无头浏览器探针，真实点击菜单进入
  无尽地图 0，九阶段断言：BOOT 菜单与引擎就绪、`#killFeed` 容器存在；
  GAME_START 新对局零条目；KILL_TORSO 真实 `damageEnemy(…, "torso",
  "手枪")`：1 条、武器“手枪”、`+100`、无徽章、HUD 分数与 `scoreText`
  同为 100（同源断言）；KILL_HEADSHOT 真实 `damageEnemy(…, "head",
  "机枪")`：新条目置顶、`headshot` 类 + 徽章可见、旧条目在下、
  `hitZoneHeadshotKills === 1`（截图 `kill-feed-headshot.png`）；
  FEED_CAP 连杀 7 名：条目封顶 5、最旧“手枪”条目被移除（截图
  `kill-feed-paused.png` 可见 5 条“狙击枪 +100”与 700 分同帧冻结）；
  PAUSE_FREEZE 真·暂停 3 秒：条目数与逐条剩余时间逐位不变；
  RESUME_DECAY 恢复后轮询至 TTL 归零、DOM 与状态双双清空；
  GAME_OVER 真实 `damagePlayer(9999)` 致死当帧整列清除；RESTART 真实
  `R` 重开：新对局 8 敌、分数归零、击杀播报零残留（截图
  `kill-feed-restarted.png`）。输出 `KILL_FEED_PROBE_PASSED`，
  `CONSOLE_ERRORS` 为空，`PAGE_ERRORS` 仅含与既往各 epoch 一致的 2×
  headless 指针锁定噪声（WrongDocumentError）。

### Changed
- `index.html`：`#hud` 内 `#combatLog` 之后新增 `<div id="killFeed">`
  容器。
- `js/core.js`：新增 `killFeed` 元素引用。
- `js/combat.js`：新增 `KILL_FEED_TTL` / `KILL_FEED_FADE` /
  `KILL_FEED_MAX` 常量与 `killFeedEntries` 状态；新增
  `registerKillFeed()` / `updateKillFeed()` / `clearKillFeed()`；
  `damageEnemy()` 增加可选第 4 参 `weaponName` 并刷新
  `enemy.lastHitWeapon`（向后兼容，原 3 参调用不变），致死帧以
  `killEnemy(enemy, zone === "head")` 传入爆头标记；`killEnemy()` 增参
  `headshot`，得分 `100 × stats.tier` 先存入 `killScore` 再累加并同步
  播报；`createPlayerProjectile()` 的弹道记录新增 `weapon: currentWeapon`；
  `explodeRocket()` 增参 `weaponName` 并透传至 `damageEnemy`（溅射伤害
  部位按躯干口径，与原 `zone` 缺省行为一致）；`updateVisualUI()` 末尾
  调用 `updateKillFeed(delta)`，与信息流同为战斗帧驱动。
- `js/main.js`：`resetPlayer()`（重开）、`showGameOver()`（死亡当帧）与
  `showModeMenu()`（返回菜单）三条复位路径均调用 `clearKillFeed()`。
- `css/game.css`：新增 `#killFeed` 样式——左上角 270px 列、最新置顶、
  160ms 滑入 / 0.6s 滑出、武器名浅蓝、得分绿、爆头条目金色边框 +
  金色徽章；`pointer-events: none` 不拦截输入。

### Verification evidence on record (this epoch)
- `node probe-evidence/verify-kill-feed.mjs` →
  `KILL_FEED_PROBE_PASSED`（九阶段全过，见上）。
- `node probe-evidence/verify.mjs` → 全阶段输出与改动前基线一致
  （BOOT / GAME_START / HOTKEYS 五武器 / COMBAT 1 击杀 score 0→100 /
  STREAK_EXPIRY / EMERGENCY_RELOAD / BEST_PERSIST / DANGER_SYSTEM
  passed=true / RESTART 失败→战斗 / AUDIO_SYSTEM passed=true），
  核心循环与重开路径无回归。

## [Unreleased] — epoch_015: enemy health bars (敌人血条)

### Added
- **敌人血条**：敌人血量首次低于满值时，头顶出现一条常驻 sprite 血条
  （深灰背景 + 填充段，宽 0.95 / 高 0.085 世界单位，位于头顶 2.24 处，
  随距离自然衰减）。此前敌人生命随威胁等级从 88 一路成长，玩家对“还要
  打几枪”完全无感知，只能靠反复试射；现在填充宽度 = 满宽 × 当前血量比，
  颜色 HSL 色相从 0.33（绿）线性降到 0（红），残血目标一眼可辨。血条为
  左端固定的经典收缩观感：填充段默认中心锚点，每帧取相机世界 X 轴（含
  抖动 roll）算出屏幕右方向，把左锚偏移换回敌人组局部坐标，敌人组 yaw
  旋转不影响锚点。纯视觉层：不加入 `hitMeshes` / `raycastWorld`，玩家
  命中判定与敌人弹道均不受影响；满血隐藏，死亡当帧熄灭，死亡爆裂 /
  收缩动画播放期间不显示残条。
- `probe-evidence/verify-enemy-hp-bar.mjs`：无头浏览器探针，真实点击菜单
  进入无尽地图 0，九阶段断言：BOOT 菜单与引擎就绪；GAME_START 8 名敌人
  全部带有 `hpBarFill` / `hpBarBackground` 与 `maxHealth`；START_FRESH
  满血阶段零血条（无残留）；DAMAGE 真实 `damageEnemy` 打至 70%：血条
  出现、填充 0.665（= 0.95 × 0.7）、色相 0.231（绿系）、**其余 7 名敌人
  血条全部保持隐藏（隔离断言）**（截图 `enemy-hp-bar-damaged.png`，
  同帧可见敌人头顶绿条）；LOW 打至约 19.6%：填充 0.186、色相 0.065
  （红系），且左下角战斗信息流出现“目标残血 18 HP　补一枪即可击杀”
  （截图 `enemy-hp-bar-low.png`，残血红条 + 残血播报同帧可见）；
  PAUSE_FREEZE 真·暂停期间再注入伤害：血条宽度与可见性逐位冻结、
  血量数值照常变化（截图 `enemy-hp-bar-paused.png`）；RESUME 恢复后
  血条同步到新比例；DEATH 爆头击杀：逻辑当帧移出 `enemies`、血条熄灭、
  死亡动画 1 条，轮询至动画清理归零（无 sprite 泄漏）；RESTART 真实
  `damagePlayer(9999)` 致死结算后真实 `R` 重开，新对局 8 敌全部满血
  且血条零残留、分数归零。输出 `ENEMY_HP_BAR_PROBE_PASSED`，
  `CONSOLE_ERRORS` 为空，`PAGE_ERRORS` 仅含与既往各 epoch 一致的 2×
  headless 指针锁定噪声（WrongDocumentError）。

### Changed
- `js/enemies.js`：新增 `ENEMY_HP_BAR_WIDTH` / `ENEMY_HP_BAR_HEIGHT` /
  `ENEMY_HP_BAR_Y` 常量与两个世界坐标暂存向量；`createEnemy()` 的敌人
  对象新增 `maxHealth: stats.health` 字段，构建完成时调用
  `createEnemyHealthBar()` 挂两段 sprite（renderOrder 990/991，
  `depthWrite: false` 避免互相深度冲突）；新增
  `createEnemyHealthBar()` / `updateEnemyHealthBar()`；`disposeEnemyMaterials()`
  增加两段血条材质 dispose（`clearEnemiesAndEffects`、死亡动画清理与
  `clearDeathAnimations` 均走该入口，重开无泄漏）；`updateEnemyAI()`
  逐敌循环在闪白衰减之后调用 `updateEnemyHealthBar()`，与 AI 共用
  `gameState === "战斗"` + 指针锁定的门控，真·暂停整帧冻结、恢复后继续。
- `js/combat.js`：`killEnemy()` 在 `alive = false` 当帧熄灭该敌人血条。
- 顺带修复：`damageEnemy()` 的残血预警阈值 `enemy.maxHealth * 0.35`
  此前引用了从未赋值的 `maxHealth`（恒为 `NaN`，比较恒假），README 宣称的
  “左下角战斗信息流实时播报残血目标”实际从未触发；`maxHealth` 字段落地后
  该播报按 35% 阈值正常生效（LOW 阶段截图同帧可见，探针已断言）。

### Verification evidence on record (this epoch)
- `node probe-evidence/verify-enemy-hp-bar.mjs` →
  `ENEMY_HP_BAR_PROBE_PASSED`（九阶段全过，见上）。
- `node probe-evidence/verify.mjs` → 全阶段输出与改动前基线逐位一致
  （BOOT / GAME_START / HOTKEYS 五武器 / EMERGENCY_RELOAD /
  DANGER_SYSTEM.passed=true / RESTART 失败→战斗 / AUDIO_SYSTEM.passed）；
  其中 COMBAT 阶段在本机 headless SwiftShader（约 8× 慢于挂钟）下
  改动前后均为 0 击杀，属环境性打靶失稳，与本次改动无关（基线对照运行
  已复核）。
- 回归套件：`verify-pause-freeze` → `PAUSE_FREEZE_PROBE_PASSED`
  （血条挂在 AI 门控内，真·暂停整帧冻结语义不受影响，PAGE_ERRORS 为空）；
  `verify-weapon-hotbar` → `WEAPON_HOTBAR_PROBE_PASSED`（重开路径与
  击杀结算链路无回归）。
- `node --check` 全部 `js/*.js` 语法通过。

---

## [Unreleased] — epoch_014: weapon hotbar (武器快捷栏)

### Added
- **武器快捷栏**（`#weaponHotbar`，屏幕底部中央、准星堆栈下方）：此前五把
  武器只有右侧信息面板的「当前武器 + 弹匣/备弹」两行，非当前武器的余量
  完全不可见，1-5 按键映射只能靠记忆；现在五格常驻底部，每格显示热键数字、
  武器名与弹匣余量（匕首为 ∞ 并带 `melee` 样式），状态语义：
  - `selected`：当前武器槽琥珀描边 + 亮底（与 `weaponText` 同源）；
  - `low`：弹匣 ≤ 25% 且**未满弹**时琥珀红脉冲（与右侧 `#ammoText.low`
    同阈值；满弹永不判低弹——火箭弹弹匣容量 1 若不排除满弹态，25% 阈值
    为 1，满弹 1 发也会常亮低弹脉冲，本栏已修正该边界，右侧面板保持
    既往行为未动）；
  - `empty`：0 弹匣红色脉冲（与 `low` 互斥）；
  - `reloading`：换弹进行中的槽整槽变暗 + 琥珀描边脉冲，换弹完成/取消/
    切枪即清除。
  全部状态由 `updateAmmoUI()` 单点驱动（切枪、扣弹、换弹、拾取、重置均
  经过它），真·暂停期间不写 DOM（无独立计时器，天然随暂停冻结）；弹匣
  文本仅在数值变化时写 DOM。
- `probe-evidence/verify-weapon-hotbar.mjs`：无头浏览器探针，真实点击菜单
  进入无尽地图 0，八阶段断言：BOOT 五格热键序 1-5 与名称/满弹数字
  （45/15/5/∞/1）正确、仅机枪 `selected`、匕首 `melee`、无残留
  low/empty/reloading（截图无）；GAME_START 进入战斗后栏位不变；
  SWITCH_3 / SWITCH_4 真实 `Digit3` / `Digit4` 按键使 `selected` 恰好
  迁移一格；LOW 手枪 3 发（25% 阈值）仅该槽 `low`（隔离断言机枪槽干净）；
  EMPTY 0 发转 `empty` 且 `low` 清除；RELOAD 真实 `Digit1` 切回机枪、
  10 发状态真实 `startReload(false)` 后该槽 `reloading`，真实游戏循环
  完成（45/145）后类清除且槽位回到 `selected` 满弹（截图
  `weapon-hotbar-live.png`，可见琥珀选中槽与红色空弹手枪同帧）；
  PAUSE 真·暂停 1.2 s 栏位逐位冻结、恢复原样；DEATH/RESTART 真实
  `damagePlayer(999)` 致死结算后真实 `R` 重开，五格回满弹、机枪选中、
  无残留类（截图 `weapon-hotbar-restart.png`）。输出
  `WEAPON_HOTBAR_PROBE_PASSED`，`PAGE_ERRORS` / `CONSOLE_ERRORS` 均为空。
- 补充证据 `weapon-hotbar-low.png`：手枪选中且 3/75 时，快捷栏该槽
  琥珀高亮 + 红色 3，与右侧红色读数及准星下方「弹匣偏低 · 建议按 R
  换弹」提示同帧一致。

### Changed
- `index.html`：`#hud` 内 `#reloadPrompt` 之后新增
  `<div id="weaponHotbar"></div>`（槽位由 JS 构建，保持热键映射单一数据源）。
- `js/weapons.js`：新增 `weaponHotkeyOrder`（由 `hotkeyByWeaponName` 按
  数字升序推导）、`buildWeaponHotbar()` / `updateWeaponHotbarUI()`；
  `updateAmmoUI()` 开头统一调用后者（含无弹药武器的早退路径），文件尾部
  首次 `resetAllAmmo()` 前完成建栏。
- `js/main.js`：删除与 `weapons.js` 重复的 `weaponHotkeyOrder` 声明
  （内容相同的五元数组），`selectWeaponByHotkey` 改用 `weapons.js` 的
  全局推导值，按键映射不再两处维护。
- `css/game.css`：新增 `#weaponHotbar` 槽位样式（92 px 等宽五格、底部
  22 px 居中，与 80 px 起的准星下方提示堆栈不重叠；选中琥珀描边、
  低弹/空弹复用 `ammoPulse` 关键帧、换弹 `hotbarReloadPulse`、
  `melee` 去辉光）。

### Verification evidence on record (this epoch)
- `node probe-evidence/verify-weapon-hotbar.mjs` →
  `WEAPON_HOTBAR_PROBE_PASSED`（无头 Chromium，真实页面与真实游戏循环、
  真实菜单点击与真实 `Digit` / `R` 按键；`PAGE_ERRORS` / `CONSOLE_ERRORS`
  均为空；`weapon-hotbar-live.png` 可见选中机枪琥珀槽 + 空弹手枪红 0 +
  右侧 45/145 同帧，`weapon-hotbar-restart.png` 为重开后的满弹栏）。
- `node probe-evidence/verify.mjs` → 全阶段通过（BOOT / GAME_START /
  HOTKEYS 五武器切换 / COMBAT 真实击杀计分 / STREAK_EXPIRY /
  EMERGENCY_RELOAD / BEST_PERSIST / DANGER_SYSTEM.passed / RESTART
  失败→战斗 / AUDIO_SYSTEM.passed），核心循环、热键（含去重后的
  `weaponHotkeyOrder`）、重开路径与音频无回归；`PAGE_ERRORS` 仅含已知
  headless 指针锁定噪声（2× WrongDocumentError，与既往各 epoch 一致）。
- 回归套件：`verify-reload-progress` → `RELOAD_PROGRESS_PROBE_PASSED`；
  `verify-reload-prompt` → `RELOAD_PROMPT_PROBE_PASSED`；
  `verify-pause-freeze` → `PAUSE_FREEZE_PROBE_PASSED`（新增栏位无独立
  计时器，真·暂停整帧冻结不受影响）。
- `node --check` 全部 `js/*.js` 语法通过。

---

## [Unreleased] — epoch_013: enemy hit flash and death effect (敌人命中闪白与死亡特效)

### Added
- **敌人命中闪白**：`damageEnemy()` 命中时置 `enemy.hitFlash = 1`，
  `updateEnemyAI()` 按 `ENEMY_HIT_FLASH_TTL`（0.18 s）逐帧衰减并写入暖白
  `emissive`（实测约 `0.614, 0.553, 0.503`）。每个敌人在 `createEnemy()` 时
  克隆独立的身体 / 头部 / 四肢 / 皮肤材质（基础材质为全体敌人共享，不克隆
  会把闪光串到所有敌人），实测其他敌人最大 emissive 为 0（完全隔离）。
  衰减挂在 `updateEnemyAI()` 的真实战斗门控之后，真·暂停时整帧冻结，
  恢复后继续衰减（逐位冻结已验证）。
- **敌人死亡爆裂**：`killEnemy()` 不再立即 `scene.remove`，改为先由
  `spawnEnemyDeathBurst()` 生成爆裂（18 枚加色混合橙色火花，复用战斗场景
  的 `sparkGeometry` + 1 个 `PointLight`，生命周期 0.55 s，进入全局
  `effects` 更新链），再进入 `beginEnemyDeathAnimation()`：模型 0.24 s
  （`ENEMY_DEATH_ANIM_TTL`）内原地缩小到 0，结束后连同克隆材质与爆裂灯光
  一起 dispose 并移出场景。击杀数、分数、小地图与重生计时仍在死亡当帧
  照常结算（逻辑层立即从 `enemies` 摘除）——纯视觉层，不改动任何玩法
  参数。
- `probe-evidence/verify-hit-death-fx.mjs`：无头浏览器探针，真实进入无尽
  模式并以真实鼠标输入射击，十阶段断言：BOOT 页面加载与新增 API 存在；
  GAME_START 真实战斗 8 敌人且逐敌独立材质就位；HIT_FLASH 真实命门射击后
  目标 `hitFlash≈0.72`、暖白 emissive 升起、其他敌人最大 emissive 为 0
  （截图 `hit-death-flash.png`，同帧可见 `-24` 伤害浮字）；FLASH_DECAY
  闪光衰减至 0 且 emissive 归零；PAUSE_FREEZE 真·暂停期间闪光值与
  emissive 逐位冻结（截图 `hit-death-paused.png`）；RESUME_DECAY 恢复后
  衰减继续并归零；DEATH 击杀目标：`kills` +1、逻辑层当帧移除、死亡动画
  列表 1 条、模型仍在场景且 scale≈0.58、爆裂特效 1 枚（截图
  `hit-death-burst.png`，可见橙色火花与地面光，小地图对应红点消失）；
  DEATH_CLEANUP 动画列表与场景残留为 0；RESTART 结算界面按 R，死亡动画
  与特效全部清零、新对局 8 敌人就位。输出
  `HIT_DEATH_FX_PROBE_PASSED`，`PAGE_ERRORS` / `CONSOLE_ERRORS` 均为空。

### Changed
- `js/enemies.js`：新增 `ENEMY_HIT_FLASH_TTL` / `ENEMY_DEATH_ANIM_TTL` /
  `deathAnimations`；`createEnemy()` 为每个敌人克隆
  `bodyMaterial` / `limbMaterial` / `skinMaterial` 并挂 `hitFlash` 状态；
  `updateEnemyAI()` 衰减 `hitFlash` 并写入克隆材质的 emissive；新增
  `disposeEnemyMaterials()` / `spawnEnemyDeathBurst()` /
  `beginEnemyDeathAnimation()` / `updateDeathAnimations()` /
  `clearDeathAnimations()`。
- `js/combat.js`：`damageEnemy()` 置 `hitFlash = 1`；`killEnemy()` 将
  “立即 `scene.remove(enemy.group)`”替换为“爆裂 + 0.24 s 缩小后
  dispose”（`enemies` 数组仍在当帧 splice，逻辑层结算不变）。
- `js/main.js`：`clearEnemiesAndEffects()` 增加逐敌克隆材质 dispose 与
  `clearDeathAnimations()` 清理；`animate()` 在 `updateEffects(delta)` 之后
  调用 `updateDeathAnimations(delta)`。

### Verification evidence on record (this epoch)
- `node probe-evidence/verify-hit-death-fx.mjs` →
  `HIT_DEATH_FX_PROBE_PASSED`（无头 Chromium，真实页面与真实游戏循环、
  真实鼠标输入；`PAGE_ERRORS` / `CONSOLE_ERRORS` 均为空；
  `hit-death-flash.png` 可见目标全身暖白闪白与伤害浮字同帧，
  `hit-death-paused.png` 可见暂停屏背后闪光逐位冻结，
  `hit-death-burst.png` 可见死亡爆裂火花 + 地面光与小地图红点消失）。
- `node probe-evidence/verify.mjs` → 全阶段通过（BOOT / GAME_START /
  HOTKEYS 五武器切换 / COMBAT / AFTER_FIRE / STREAK_EXPIRY /
  EMERGENCY_RELOAD / BEST_PERSIST / DANGER_SYSTEM.passed / RESTART
  失败→战斗 / AUDIO_SYSTEM.passed）；`PAGE_ERRORS` 仅含已知 headless
  指针锁定噪声（2× WrongDocumentError，与既往各 epoch 一致）。
- 回归套件：`verify-pause-freeze` → `PAUSE_FREEZE_PROBE_PASSED`（真·暂停
  整帧冻结保持，恢复补偿正常——死亡动画与闪光衰减均未引入暂停期推进
  路径）。
- `node --check` 通过于 `js/enemies.js` / `js/combat.js` / `js/main.js`。

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
