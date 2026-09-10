# Multi-epoch Evolution Demo

真实历史锚点：每个游戏 4 个 case。SVG 使用每路独立的有向 workflow graph，节点和边对应该游戏的工作切片与验证路径；相邻 case 不复用同一拓扑。

Workflow 变化的判读：Angry Aliens 沿 level geometry、material damage、bird abilities、chain reactions、physics state 和 destruction evidence 复杂化；HexGL 沿 vehicle handling、track hazards、camera/HUD feedback、lap/checkpoint state 和 deterministic race evidence 复杂化；Iron Breakout FPS 沿 input trace、weapon timing、projectile geometry、collision 和 spatial readability 复杂化；PolyBranch 沿 branch topology、score/popup hooks、deterministic bounded probe、failure diagnosis 和 rerun promotion 复杂化。


## Angry Aliens



- 选择理由：The workflow grows from a one-shot physics seed into richer destruction puzzles with birds, mixed-material structures, explosive reactions, and browser-visible evidence.
- 锚点：10, 20, 50, 100

- epoch10: `SEED` · [workflow SVG](./angry-aliens/epoch10-harness.svg) · artifact: `/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/runs/manual-visual-variants-20260909/angry-aliens/epoch_001`
- epoch20: `ACCEPT` · [workflow SVG](./angry-aliens/epoch20-harness.svg) · artifact: `/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/runs/manual-visual-variants-20260909/angry-aliens/epoch_002`
- epoch50: `ACCEPT` · [workflow SVG](./angry-aliens/epoch50-harness.svg) · artifact: `/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/runs/manual-visual-variants-20260909/angry-aliens/epoch_003`
- epoch100: `ACCEPT` · [workflow SVG](./angry-aliens/epoch100-harness.svg) · artifact: `/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/runs/manual-visual-variants-20260909/angry-aliens/epoch_004`

## HexGL

- 选择理由：The workflow grows from a runnable 3D race seed into a richer hovercraft, track, camera, HUD, and replayable lap experience.
- 锚点：10, 20, 50, 100

- epoch10: `SEED` · [workflow SVG](./hexgl/epoch10-harness.svg) · artifact: `/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/runs/manual-visual-variants-20260909/hexgl/epoch_001`
- epoch20: `ACCEPT` · [workflow SVG](./hexgl/epoch20-harness.svg) · artifact: `/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/runs/manual-visual-variants-20260909/hexgl/epoch_002`
- epoch50: `ACCEPT` · [workflow SVG](./hexgl/epoch50-harness.svg) · artifact: `/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/runs/manual-visual-variants-20260909/hexgl/epoch_003`
- epoch100: `ACCEPT` · [workflow SVG](./hexgl/epoch100-harness.svg) · artifact: `/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/runs/manual-visual-variants-20260909/hexgl/epoch_004`

## Iron Breakout FPS

- 选择理由：The FPS moves from a minimal playable shell toward clearer combat readability, stronger scene dressing, and richer feedback.
- 锚点：10, 20, 50, 100

- epoch10: `SEED` · [workflow SVG](./iron-breakout-fps/epoch10-harness.svg) · `iron-breakout-fps/epoch10-run.sh` · artifact: `/Users/wangxucong/Desktop/workspace/harness-game/work/open-source-games-candidates/iron-breakout-fps`
- epoch20: `ACCEPT` · [workflow SVG](./iron-breakout-fps/epoch20-harness.svg) · `iron-breakout-fps/epoch20-run.sh` · artifact: `/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/runs/codex-100-epoch-continuation-20260908/iron-breakout-fps/epoch_003/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact`
- epoch50: `ACCEPT` · [workflow SVG](./iron-breakout-fps/epoch50-harness.svg) · `iron-breakout-fps/epoch50-run.sh` · artifact: `/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/runs/codex-100-epoch-continuation-20260908/iron-breakout-fps/epoch_010/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact`
- epoch100: `ACCEPT` · [workflow SVG](./iron-breakout-fps/epoch100-harness.svg) · `iron-breakout-fps/epoch100-run.sh` · artifact: `/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/runs/codex-100-epoch-continuation-20260908/iron-breakout-fps/epoch_015/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact`

## PolyBranch Remediated

- 选择理由：After the probe remediation, the workflow produces a stable continuation chain and progressively richer tunnel, HUD, and feedback presentation.
- 锚点：10, 20, 50, 100

- epoch10: `SEED` · [workflow SVG](./polybranch-remediated/epoch10-harness.svg) · `polybranch-remediated/epoch10-run.sh` · artifact: `/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/seeds/polybranch-remediated-20260908`
- epoch20: `ACCEPT` · [workflow SVG](./polybranch-remediated/epoch20-harness.svg) · `polybranch-remediated/epoch20-run.sh` · artifact: `/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/runs/codex-100-epoch-continuation-20260908/polybranch-remediated/epoch_011/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact`
- epoch50: `ACCEPT` · [workflow SVG](./polybranch-remediated/epoch50-harness.svg) · `polybranch-remediated/epoch50-run.sh` · artifact: `/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/runs/codex-100-epoch-continuation-20260908/polybranch-remediated/epoch_014/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact`
- epoch100: `ACCEPT` · [workflow SVG](./polybranch-remediated/epoch100-harness.svg) · `polybranch-remediated/epoch100-run.sh` · artifact: `/Users/wangxucong/Desktop/workspace/harness-game/game-loop/experiments/open-source-games/runs/codex-100-epoch-continuation-20260908/polybranch-remediated/epoch_019/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact`
