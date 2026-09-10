from pathlib import Path
import json
from textwrap import dedent

ROOT = Path('/Users/wangxucong/Desktop/workspace/harness-game/game-loop')
RUNS = ROOT / 'experiments/open-source-games/runs'
OUT = ROOT / 'docs/evolution-demo'

CASES = {
    'canvas-vampire-survivors': [
        ('dual-track-open-candidates-20260906-v2', 6),
        ('dual-track-open-candidates-20260906-v2', 13),
        ('codex-100-epoch-continuation-20260908', 17),
        ('dual-track-open-candidates-20260906-v2', 21),
    ],
    'iron-breakout-fps': [
        ('dual-track-open-candidates-20260906-v3-deep-probes', 2),
        ('dual-track-open-candidates-20260906-v3-deep-probes', 8),
        ('dual-track-open-candidates-20260906-v3-deep-probes', 12),
        ('codex-100-epoch-continuation-20260908', 15),
    ],
    'polybranch': [
        ('dual-track-open-candidates-20260906-v3-deep-probes', 2),
        ('dual-track-open-candidates-20260906-v2', 13),
        ('dual-track-open-candidates-20260906-v2', 17),
        ('codex-100-epoch-continuation-20260908/polybranch-remediated', 19),
    ],
}

def proof_path(run, game, epoch):
    if run.endswith('/polybranch-remediated'):
        return RUNS / run / f'epoch_{epoch:03d}' / 'pair' / 'paired-proof.json'
    return RUNS / run / game / f'epoch_{epoch:03d}' / 'pair' / 'paired-proof.json'

def profile_path(proof):
    return next(proof.parent.glob('candidate-profile-snapshot/profile-*.json'), None)

def labels(profile, game, epoch):
    if profile is None:
        return ['Seed task', 'Root agent', 'Direct edit', 'Basic smoke']
    x = json.loads(profile.read_text())
    protos = x.get('active_subagent_prototypes', [])
    proto = protos[0] if protos else {}
    text = (proto.get('description', '') + ' ' + proto.get('persona', '')).lower()
    if 'write manifest' in text or 'exhaustive' in text:
        worker = ['Fork worker', 'write manifest']
    elif 'change manifest' in text or 'evidence handoff' in text:
        worker = ['Worker handoff', 'evidence report']
    elif 'native multi-agent' in text:
        worker = ['Native worker', 'bounded slice']
    else:
        worker = ['Root-only edit', 'bounded change']
    if 'remediated' in str(profile.parent.parent.parent):
        return ['Remediation task', 'deterministic hooks', 'single bounded probe', 'paired promotion']
    if 'deep-probes' in str(profile):
        return ['Deep-probe task', worker[0], 'runtime evidence', 'quality gate']
    return ['Evolution task', worker[0], worker[1], 'paired artifact gate']

def workflow_for(game, epoch, prof):
    if game == 'canvas-vampire-survivors':
        if epoch == 17:
            return [('Root', 'Codex native'), ('Combat', 'child slice'), ('Progression', 'child slice'), ('Browser run', 'visual evidence'), ('Balance check', 'state evidence'), ('Manifest', 'handoff'), ('Quality gate', 'promote')], 'Canvas: combat/progression branches feed visual and state evidence before promotion'
        if epoch == 21:
            return [('Root', 'bounded task'), ('Combat / VFX', 'worker'), ('Progression / HUD', 'worker'), ('Browser run', 'probe'), ('Input replay', 'probe'), ('Evidence merge', 'audit'), ('Quality gate', 'accept/reject')], 'Canvas: combat feedback and progression probes merge into one audit'
        if epoch == 13:
            return [('Root', 'survivor task'), ('Combat', 'worker'), ('Progression', 'worker'), ('Combat FX', 'evidence'), ('HUD / XP', 'evidence'), ('Merge', 'root gate')], 'Canvas: two domain branches produce separate visual evidence'
        return [('Root', 'survivor task'), ('Combat', 'worker'), ('Smoke', 'slice check'), ('Integrate', 'root')], 'Canvas: first bounded combat slice and local smoke check'
    if game == 'iron-breakout-fps':
        if epoch == 15:
            return [('Root', 'Codex native'), ('Weapon slice', 'child'), ('Arena slice', 'child'), ('Input replay', 'evidence'), ('Hit geometry', 'evidence'), ('Scene readability', 'evidence'), ('Manifest', 'handoff'), ('FPS gate', 'promote')], 'Iron: weapon/arena children converge through input, geometry, and readability evidence'
        if epoch == 12:
            return [('Root', 'deep-probe task'), ('Weapon', 'worker'), ('Arena', 'worker'), ('Input trace', 'probe'), ('Projectile path', 'probe'), ('Spatial read', 'probe'), ('Evidence', 'merge'), ('Gate', 'promote')], 'Iron: input, projectile path, and spatial readability become independent probes'
        if epoch == 8:
            return [('Root', 'FPS task'), ('Weapon / fire', 'worker'), ('Arena / cover', 'worker'), ('Aim input', 'probe'), ('Collision', 'probe'), ('Merge', 'root')], 'Iron: weapon timing and arena collision become coupled checks'
        return [('Root', 'FPS task'), ('Weapon', 'worker'), ('Hit check', 'evidence'), ('Deliver', 'root')], 'Iron: focused weapon slice and hit check'
    if game == 'polybranch':
        if epoch == 19:
            return [('Remediation root', 'Codex native'), ('Score hook', 'child slice'), ('Popup hook', 'child slice'), ('180s probe', 'deterministic'), ('Failure log', 'diagnose'), ('Fix branch', 'rerun'), ('Paired proof', 'audit'), ('Promotion', 'gate')], 'PolyBranch: deterministic probe loops from diagnosis back into a fix branch before promotion'
        if epoch == 17:
            return [('Root', 'branch task'), ('Branch A', 'worker'), ('Branch B', 'worker'), ('Ledger', 'retained/disclaimed'), ('Topology check', 'probe'), ('Interface adapt', 'root'), ('Whole verify', 'gate')], 'PolyBranch: topology is checked after the write-ledger handoff'
        if epoch == 13:
            return [('Root', 'branch task'), ('Branch A', 'worker + ledger'), ('Branch B', 'worker + ledger'), ('Write ledger', 'audit'), ('Interface adapt', 'root'), ('Whole verify', 'gate')], 'PolyBranch: split branches classify every write before integration'
        return [('Root', 'branch task'), ('Branch slice', 'worker'), ('Local check', 'evidence'), ('Integrate', 'root')], 'PolyBranch: one bounded branch slice returns local evidence'
    return [('Root', ''), ('Worker', ''), ('Evidence', ''), ('Gate', '')], 'Observed profile'

def svg(title, game, epoch, status, prof, nodes, caption):
    layouts = {
        'canvas-vampire-survivors': {
            0: [(40, 120, 150, 58), (230, 120, 150, 58), (420, 120, 150, 58), (610, 120, 150, 58)],
            1: [(40, 110, 150, 58), (250, 62, 150, 58), (250, 158, 150, 58), (470, 110, 150, 58)],
            2: [(40, 110, 150, 58), (250, 48, 150, 58), (250, 172, 150, 58), (470, 110, 150, 58)],
            3: [(30, 106, 145, 58), (210, 40, 145, 58), (210, 150, 145, 58), (400, 40, 145, 58), (590, 106, 160, 58)],
        },
        'iron-breakout-fps': {
            0: [(40, 52, 150, 58), (230, 120, 150, 58), (420, 52, 150, 58), (610, 120, 150, 58)],
            1: [(40, 120, 150, 58), (250, 48, 150, 58), (250, 192, 150, 58), (470, 120, 150, 58)],
            2: [(40, 120, 150, 58), (250, 48, 150, 58), (250, 192, 150, 58), (470, 120, 150, 58)],
            3: [(30, 120, 145, 58), (205, 35, 145, 58), (205, 205, 145, 58), (395, 120, 145, 58), (585, 120, 165, 58)],
        },
        'polybranch': {
            0: [(40, 120, 150, 58), (250, 54, 150, 58), (250, 186, 150, 58), (470, 120, 150, 58)],
            1: [(40, 120, 150, 58), (245, 48, 150, 58), (245, 192, 150, 58), (470, 120, 150, 58)],
            2: [(30, 120, 145, 58), (205, 40, 150, 58), (205, 200, 150, 58), (420, 120, 150, 58)],
            3: [(25, 120, 145, 58), (195, 35, 150, 58), (195, 205, 150, 58), (405, 120, 150, 58), (600, 120, 170, 58)],
        },
    }
    stage = {2: 0, 8: 1, 12: 2, 13: 1, 15: 3, 17: 2, 19: 3, 21: 3}.get(epoch, 0)
    positions = [(28 + (i % 4) * 195, 72 + (i // 4) * 105, 155, 58) for i in range(len(nodes))]
    if game == 'iron-breakout-fps':
        positions = [(28 + (i % 4) * 195, 42 + (i // 4) * 150, 155, 58) for i in range(len(nodes))]
    elif game == 'polybranch':
        positions = [(28 + (i % 4) * 195, 92 + (i // 4) * 105, 155, 58) for i in range(len(nodes))]
    colors = ['#f8e8c7','#d8eeee','#e5edd9','#ede0f4','#f6d8d3']
    boxes = ''.join(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{colors[i%len(colors)]}"/>' for i,(x,y,w,h) in enumerate(positions))
    texts = ''.join(f'<text x="{x+w/2}" y="{y+24}"><tspan x="{x+w/2}" dy="0">{n[0]}</tspan><tspan x="{x+w/2}" dy="16">{n[1]}</tspan></text>' for (x,y,w,h),n in zip(positions,nodes))
    arrows = []
    edge_map = {
        ('canvas-vampire-survivors', 6): [(0,1),(1,2),(2,3)],
        ('canvas-vampire-survivors', 13): [(0,1),(0,2),(1,3),(2,4),(3,5),(4,5)],
        ('canvas-vampire-survivors', 17): [(0,1),(0,2),(1,3),(2,4),(3,5),(4,5),(5,6)],
        ('canvas-vampire-survivors', 21): [(0,1),(0,2),(1,3),(1,4),(2,3),(2,4),(3,5),(4,5),(5,6)],
        ('iron-breakout-fps', 2): [(0,1),(1,2),(2,3)],
        ('iron-breakout-fps', 8): [(0,1),(0,2),(1,3),(1,4),(2,4),(3,5),(4,5)],
        ('iron-breakout-fps', 12): [(0,1),(0,2),(1,3),(1,4),(2,5),(3,6),(4,6),(5,6),(6,7)],
        ('iron-breakout-fps', 15): [(0,1),(0,2),(1,3),(1,4),(2,4),(2,5),(3,6),(4,6),(5,6),(6,7)],
        ('polybranch', 2): [(0,1),(1,2),(2,3)],
        ('polybranch', 13): [(0,1),(0,2),(1,3),(2,3),(3,4),(4,5)],
        ('polybranch', 17): [(0,1),(0,2),(1,3),(2,3),(3,4),(4,5),(5,6)],
        ('polybranch', 19): [(0,1),(0,2),(1,3),(2,3),(3,4),(4,5),(5,3),(4,6),(6,7)],
    }
    edges = edge_map[(game, epoch)]
    for i,j in edges:
        x,y,w,h=positions[i]; nx,ny,nw,nh=positions[i+1]
        nx,ny,nw,nh=positions[j]
        if ny > y+h or ny+nh < y:
            arrows.append(f'<path d="M{x+w} {y+h/2} L{nx} {ny+nh/2}"/>')
        else:
            arrows.append(f'<path d="M{x+w} {y+h/2} H{nx}"/>')
    arrows = ''.join(arrows)
    return dedent(f'''<svg xmlns="http://www.w3.org/2000/svg" width="820" height="320" viewBox="0 0 820 320">
<rect width="820" height="320" fill="#f7f3ec"/><defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#2b8c8c"/></marker></defs>
<text x="24" y="30" font-family="Arial" font-size="19" font-weight="700" fill="#24313a">{title}</text>
<text x="24" y="52" font-family="Arial" font-size="12" fill="#65757d">Epoch {epoch} · {status} · profile {prof}</text>
<g stroke="#24313a" stroke-width="1.2">{boxes}</g><g font-family="Arial" font-size="11" text-anchor="middle" fill="#24313a">{texts}</g>
<g stroke="#2b8c8c" stroke-width="2" marker-end="url(#a)">{arrows}</g>
<text x="24" y="278" font-family="Arial" font-size="11" fill="#65757d">{caption}</text><text x="24" y="295" font-family="Arial" font-size="11" fill="#65757d">Observed profile snapshot: {prof}</text></svg>\n''')

def run_script(title, artifact, entry, epoch):
    return dedent(f'''#!/usr/bin/env bash
set -euo pipefail
ARTIFACT='{artifact}'
ENTRY='{entry}'
PORT=$((9400 + {epoch}))
[[ -f "$ARTIFACT/$ENTRY" ]] || {{ echo "Artifact entrypoint missing: $ARTIFACT/$ENTRY" >&2; exit 1; }}
echo "Launching {title} epoch {epoch}: http://127.0.0.1:$PORT/$ENTRY"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ARTIFACT" >/tmp/evolution-distinct-{epoch}.log 2>&1 &
PID=$!; trap 'kill "$PID" 2>/dev/null || true' EXIT INT TERM
sleep .5; open "http://127.0.0.1:$PORT/$ENTRY" 2>/dev/null || true; wait "$PID"
''')

def main():
    for game, cases in CASES.items():
        title = game.replace('-', ' ').title()
        entry = 'public/index.html' if game == 'chudopoly' else 'index.html'
        lines = [f'## {title} · Distinct Harness Anchors', '', '这些锚点来自不同的真实 candidate profile snapshot；profile hash 改变才计为 harness 变化。', '']
        target = OUT / game; target.mkdir(parents=True, exist_ok=True)
        for run, epoch in cases:
            p = proof_path(run, game, epoch)
            if not p.exists(): continue
            proof = json.loads(p.read_text())
            profile = profile_path(p)
            ph = profile.stem.replace('profile-', '')[:12] if profile else 'none'
            status = 'ACCEPT' if proof.get('accepted') else ('INFRA' if not proof.get('infrastructure_ok', False) else 'REJECT')
            artifact = proof.get('candidate', {}).get('artifact_ref')
            if not artifact: continue
            nodes, caption = workflow_for(game, epoch, ph)
            svg_name = f'distinct-{epoch:03d}-harness.svg'; run_name = f'distinct-{epoch:03d}-run.sh'
            (target/svg_name).write_text(svg(title, game, epoch, status, ph, nodes, caption), encoding='utf-8')
            (target/run_name).write_text(run_script(title, artifact, entry, epoch), encoding='utf-8'); (target/run_name).chmod(0o755)
            lines.append(f'- Epoch {epoch}: `{status}` · profile `{ph}` · [distinct workflow SVG](./{game}/{svg_name}) · `{game}/{run_name}`')
        readme = OUT / 'README.md'
        existing = readme.read_text(encoding='utf-8')
        marker = f'## {title} · Distinct Harness Anchors'
        block = '\n'.join(lines) + '\n\n'
        if marker in existing:
            before = existing.split(marker, 1)[0].rstrip() + '\n\n'
            after = existing.split(marker, 1)[1]
            next_heading = after.find('\n## ')
            if next_heading >= 0:
                after = after[next_heading + 1:]
                existing = before + block + after
            else:
                existing = before + block
        else:
            existing = existing.rstrip() + '\n\n' + block
        readme.write_text(existing, encoding='utf-8')

if __name__ == '__main__': main()
