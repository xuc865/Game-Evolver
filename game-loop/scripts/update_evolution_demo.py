from pathlib import Path
from textwrap import dedent

ROOT = Path('/Users/wangxucong/Desktop/workspace/harness-game/game-loop')
RUN = ROOT / 'experiments/open-source-games/runs/codex-100-epoch-continuation-20260908'
OUT = ROOT / 'docs/evolution-demo'

CASES = {
    'chudopoly': {
        'title': 'Chudopoly', 'entry': 'public/index.html',
        'anchors': [(0, 'SEED', 'task-seed/game', 'seed'), (3, 'ACCEPT', 'epoch_003/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact', 'accepted'), (5, 'ACCEPT', 'epoch_005/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact', 'accepted'), (9, 'ACCEPT', 'epoch_009/pair/candidate-runtime/workspace/game', 'accepted')],
        'caption': 'The workflow grows from a playable seed into a more explicit multiplayer product with server authority, replay, and UI contracts.'},
    'canvas-vampire-survivors': {
        'title': 'Canvas Vampire Survivors', 'entry': 'index.html',
        'anchors': [(0, 'SEED', 'epoch_001/pair/task-seed/game', 'seed'), (5, 'ACCEPT', 'epoch_005/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact', 'accepted'), (11, 'ACCEPT', 'epoch_011/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact', 'accepted'), (17, 'ACCEPT', 'epoch_017/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact', 'accepted')],
        'caption': 'The survivor loop accumulates stronger combat feedback, progression clarity, and a fuller visual treatment while remaining runnable.'},
    'iron-breakout-fps': {
        'title': 'Iron Breakout FPS', 'entry': 'index.html',
        'anchors': [(0, 'SEED', 'epoch_001/pair/task-seed/game', 'seed'), (3, 'ACCEPT', 'epoch_003/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact', 'accepted'), (10, 'ACCEPT', 'epoch_010/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact', 'accepted'), (15, 'ACCEPT', 'epoch_015/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact', 'accepted')],
        'caption': 'The FPS moves from a minimal playable shell toward clearer combat readability, stronger scene dressing, and richer feedback.'},
    'polybranch-remediated': {
        'title': 'PolyBranch Remediated', 'entry': 'index.html',
        'anchors': [(0, 'SEED', 'epoch_001/pair/task-seed/game', 'seed'), (11, 'ACCEPT', 'epoch_011/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact', 'accepted'), (14, 'ACCEPT', 'epoch_014/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact', 'accepted'), (19, 'ACCEPT', 'epoch_019/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact', 'accepted')],
        'caption': 'After the probe remediation, the workflow produces a stable continuation chain and progressively richer tunnel, HUD, and feedback presentation.'},
}

def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def workflow_nodes(game, epoch):
    graphs = {
        'chudopoly': {
            0: ([('Read rules', 'board + turn'), ('Edit', 'player-visible'), ('Smoke', 'start/restart')], [(0, 1), (1, 2)], 'Chudopoly seed: board rules -> visible edit -> restart smoke'),
            3: ([('Map task', 'turn loop'), ('Server state', 'authority'), ('Client UI', 'roll / buy'), ('Reconnect', 'resume turn'), ('Proof', 'paired verdict')], [(0,1),(0,2),(1,3),(2,3),(3,4)], 'Chudopoly: server authority and client UI converge through reconnect'),
            5: ([('Multiplayer charter', 'turn + reconnect'), ('Server authority', 'state owner'), ('Client affordance', 'buy / roll'), ('Replay log', 'event order'), ('Reconnect probe', 'resume'), ('Evidence audit', 'screens + logs'), ('Paired gate', '>= parent')], [(0,1),(0,2),(1,3),(2,3),(3,4),(4,5),(5,6)], 'Chudopoly: replay ordering and reconnect are first-class workflow branches'),
            9: ([('Parent baseline', 'accepted game'), ('Server slice', 'authority'), ('UI slice', 'affordances'), ('Replay slice', 'deterministic'), ('Reconnect', 'probe'), ('Client/server', 'state diff'), ('Evidence', 'audit'), ('Promote', 'next epoch')], [(0,1),(0,2),(0,3),(1,4),(2,4),(3,5),(4,6),(5,6),(6,7)], 'Chudopoly: three multiplayer slices feed state-diff evidence before promotion')},
        'canvas-vampire-survivors': {
            0: ([('Read loop', 'canvas + input'), ('Edit', 'player-visible'), ('Smoke', 'spawn / restart')], [(0,1),(1,2)], 'Canvas Survivors seed: render loop -> visible edit -> spawn smoke'),
            5: ([('Survivor task', 'movement + waves'), ('Combat slice', 'auto-fire'), ('Progression slice', 'XP / level'), ('Visual probe', 'damage feedback'), ('Gate', 'playable')], [(0,1),(0,2),(1,3),(2,3),(3,4)], 'Canvas: combat and progression meet at readable damage feedback'),
            11: ([('Parent game', 'wave baseline'), ('Enemy pressure', 'spawn pacing'), ('Weapon feedback', 'projectile / hit'), ('XP state', 'level-up'), ('Browser visual', 'HUD + effects'), ('Input replay', 'movement'), ('Quality audit', 'combat + growth')], [(0,1),(0,2),(0,3),(1,4),(2,4),(3,4),(4,5),(5,6)], 'Canvas: wave pacing, combat feedback, and XP state are audited together'),
            17: ([('Accepted parent', 'survivor loop'), ('Combat child', 'VFX + hit'), ('Progression child', 'XP + unlock'), ('Browser run', 'visual evidence'), ('State check', 'level / wave'), ('Balance note', 'numbers'), ('Evidence merge', 'visual + state'), ('Promote', 'next epoch')], [(0,1),(0,2),(1,3),(2,4),(1,5),(2,5),(3,6),(4,6),(5,6),(6,7)], 'Canvas: independent combat/progression children merge visual and state evidence')},
        'iron-breakout-fps': {
            0: ([('Read scene', 'input + camera'), ('Edit', 'player-visible'), ('Smoke', 'load / aim')], [(0,1),(1,2)], 'Iron FPS seed: scene/input read -> visible edit -> aim smoke'),
            3: ([('FPS task', 'aim + fire'), ('Weapon slice', 'projectile'), ('Arena slice', 'cover'), ('Hit probe', 'collision'), ('Gate', 'playable')], [(0,1),(0,2),(1,3),(2,3),(3,4)], 'Iron: weapon projectile and arena cover converge at collision'),
            10: ([('Parent arena', 'baseline'), ('Input trace', 'mouse / keys'), ('Weapon timing', 'fire cadence'), ('Projectile path', 'ray / hit'), ('Cover read', 'depth / contrast'), ('Browser capture', 'combat frame'), ('FPS audit', 'input + space')], [(0,1),(0,2),(1,3),(2,3),(0,4),(3,5),(4,5),(5,6)], 'Iron: input, projectile geometry, and spatial readability are separate probes'),
            15: ([('Accepted parent', 'combat loop'), ('Weapon child', 'fire feedback'), ('Arena child', 'cover + lights'), ('Input replay', 'aim trace'), ('Hit geometry', 'collision proof'), ('Scene readability', 'depth proof'), ('Evidence merge', 'FPS evidence'), ('Promote', 'next epoch')], [(0,1),(0,2),(1,3),(1,4),(2,4),(2,5),(3,6),(4,6),(5,6),(6,7)], 'Iron: weapon and arena children converge through input, geometry, and depth evidence')},
        'polybranch-remediated': {
            0: ([('Read tunnel', 'branch map'), ('Edit', 'visible change'), ('Smoke', 'load / input')], [(0,1),(1,2)], 'PolyBranch seed: branch map -> visible edit -> input smoke'),
            11: ([('Probe failure', 'score / popup'), ('Find hook', 'page context'), ('Patch hook', 'deterministic'), ('Bounded run', '34 checks'), ('Paired gate', 'continue if >=')], [(0,1),(1,2),(2,3),(3,4)], 'PolyBranch remediation begins with a failing observable contract'),
            14: ([('Parent probe', 'known failure'), ('Score hook', 'deterministic'), ('Popup hook', 'deterministic'), ('180s browser run', 'bounded'), ('Evidence check', 'score + popup'), ('Paired gate', 'quality >= parent'), ('Continue', 'next epoch')], [(0,1),(0,2),(1,3),(2,3),(3,4),(4,5),(5,6)], 'PolyBranch: score and popup hooks are independently repaired before paired promotion'),
            19: ([('Remediation root', 'Codex native'), ('Score hook', 'child slice'), ('Popup hook', 'child slice'), ('180s probe', 'deterministic'), ('Failure log', 'diagnose'), ('Fix branch', 'rerun'), ('Paired proof', 'audit'), ('Promotion', 'gate')], [(0,1),(0,2),(1,3),(2,3),(3,4),(4,5),(5,3),(4,6),(6,7)], 'PolyBranch: deterministic failure diagnosis loops back into a fix branch before promotion')},
    }
    return graphs[game][epoch]

def svg(title, epoch, status, caption, game):
    nodes, edges, note = workflow_nodes(game, epoch)
    positions = [(24 + (i % 4) * 184, 78 + (i // 4) * 112) for i in range(len(nodes))]
    boxes = []
    texts = []
    for i, (pos, labels) in enumerate(zip(positions, nodes)):
        x, y = pos
        fill = ['#f8e8c7', '#d8eeee', '#e5edd9', '#ede0f4', '#f6d8d3'][i % 5]
        boxes.append(f'<rect x="{x}" y="{y}" width="130" height="52" rx="8" fill="{fill}"/>')
        texts.append(f'<text x="{x+65}" y="{y+22}">{esc(labels[0])}</text><text x="{x+65}" y="{y+38}">{esc(labels[1])}</text>')
    arrows = ''.join(f'<path d="M{positions[i][0]+65} {positions[i][1]+26} L{positions[j][0]+65} {positions[j][1]+26}"/>' for i, j in edges)
    return dedent(f'''\
    <svg xmlns="http://www.w3.org/2000/svg" width="760" height="360" viewBox="0 0 760 360">
      <rect width="760" height="300" fill="#f7f3ec"/>
      <text x="24" y="30" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#24313a">{esc(title)}</text>
      <text x="24" y="51" font-family="Arial, sans-serif" font-size="12" fill="#65757d">Epoch {epoch} · {status} · Codex game-evolver workflow</text>
      <text x="24" y="344" font-family="Arial, sans-serif" font-size="11" fill="#65757d">{esc(caption)}</text>
      <defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#2b8c8c"/></marker></defs>
      <g stroke="#24313a" stroke-width="1.2">{''.join(boxes)}</g>
      <g font-family="Arial, sans-serif" font-size="11" text-anchor="middle" fill="#24313a">{''.join(texts)}</g>
      <g stroke="#2b8c8c" stroke-width="2" marker-end="url(#a)">{arrows}</g>
      <text x="380" y="48" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#65757d">{esc(note)}</text>
    </svg>\n''')

def run_script(title, epoch, artifact, entry, port):
    return dedent(f'''\
    #!/usr/bin/env bash
    set -euo pipefail
    ARTIFACT='{artifact}'
    ENTRY='{entry}'
    PORT='{port}'
    [[ -f "$ARTIFACT/$ENTRY" ]] || {{ echo "Artifact entrypoint missing: $ARTIFACT/$ENTRY" >&2; exit 1; }}
    echo "Launching {title} / epoch {epoch}"
    echo "Artifact: $ARTIFACT"
    echo "Open: http://127.0.0.1:$PORT/$ENTRY"
    python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ARTIFACT" >/tmp/evolution-demo-{epoch}.log 2>&1 &
    SERVER_PID=$!
    trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM
    sleep 0.5
    open "http://127.0.0.1:$PORT/$ENTRY" 2>/dev/null || true
    wait "$SERVER_PID"
''')

def artifact_path(game, rel):
    if rel == 'seed':
        if game == 'polybranch-remediated': return str(ROOT / 'experiments/open-source-games/seeds/polybranch-remediated-20260908')
        return str(ROOT / 'work/../work/open-source-games-candidates' / ('PolyBranch' if game == 'polybranch-remediated' else game))
    return str(RUN / game / rel)

def main():
    lines = ['# Multi-epoch Evolution Demo', '', '真实历史锚点：每个游戏 4 个 case。SVG 使用每路独立的有向 workflow graph，节点和边对应该游戏的工作切片与验证路径；相邻 case 不复用同一拓扑。', '', 'Workflow 变化的判读：Chudopoly 沿 server authority、client affordance、replay ordering、reconnect 和 state-diff 复杂化；Canvas Vampire Survivors 沿 wave pacing、combat feedback、XP/HUD state、browser visual 和 balance evidence 复杂化；Iron Breakout FPS 沿 input trace、weapon timing、projectile geometry、collision 和 spatial readability 复杂化；PolyBranch 沿 branch topology、score/popup hooks、deterministic bounded probe、failure diagnosis 和 rerun promotion 复杂化。', '', '']
    for game, spec in CASES.items():
        target = OUT / game; target.mkdir(parents=True, exist_ok=True)
        lines += [f'## {spec["title"]}', '', f'- 选择理由：{spec["caption"]}', f'- 锚点：{", ".join(str(a[0]) for a in spec["anchors"])}', '']
        for i, (epoch, status, rel, kind) in enumerate(spec['anchors']):
            if kind == 'seed':
                if game == 'chudopoly': art = '/Users/wangxucong/Desktop/workspace/harness-game/work/open-source-games-candidates/chudopoly'
                elif game == 'canvas-vampire-survivors': art = '/Users/wangxucong/Desktop/workspace/harness-game/work/open-source-games-candidates/canvas-vampire-survivors'
                elif game == 'iron-breakout-fps': art = '/Users/wangxucong/Desktop/workspace/harness-game/work/open-source-games-candidates/iron-breakout-fps'
                else: art = str(ROOT / 'experiments/open-source-games/seeds/polybranch-remediated-20260908')
            else: art = artifact_path(game, rel)
            svg_name = f'epoch-{epoch:03d}-harness.svg'; run_name = f'epoch-{epoch:03d}-run.sh'
            (target / svg_name).write_text(svg(spec['title'], epoch, status, spec['caption'], game), encoding='utf-8')
            (target / run_name).write_text(run_script(spec['title'], epoch, art, spec['entry'], 9300 + i + len(lines)), encoding='utf-8')
            (target / run_name).chmod(0o755)
            lines.append(f'- Epoch {epoch}: `{status}` · [workflow SVG](./{game}/{svg_name}) · `{game}/{run_name}` · artifact: `{art}`')
        lines.append('')
    (OUT / 'README.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')

if __name__ == '__main__': main()
