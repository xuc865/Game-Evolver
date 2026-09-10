#!/usr/bin/env python3
"""Build presentation assets for real multi-epoch open-source game runs."""

from pathlib import Path
from html import escape

ROOT = Path("/Users/wangxucong/Desktop/workspace/harness-game/game-loop")
RUN_ROOT = ROOT / "experiments/open-source-games/runs/codex-100-epoch-continuation-20260908"
OUT = ROOT / "docs/evolution-demo"

CASES = {
    "iron-breakout-fps": {
        "title": "Iron Breakout FPS",
        "epochs": [0, 5, 10, 14],
        "available": {0: "epoch_001/pair/task-seed/game", 5: "epoch_005/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact", 10: "epoch_010/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact", 14: "epoch_014/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact"},
        "entry": "index.html",
        "notes": {
            0: "Seed game with baseline implementation loop",
            5: "Combat feedback, pause/restart, reload and HUD probes",
            10: "Integrated combat state, threat tiers and survival readouts",
            14: "Latest completed candidate artifact in this archived continuation",
        },
    },
    "canvas-vampire-survivors": {
        "title": "Canvas Vampire Survivors",
        "epochs": [0, 5, 10, 15],
        "available": {0: "epoch_001/pair/task-seed/game", 5: "epoch_005/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact", 10: "epoch_010/pair/task-seed/game", 15: "epoch_015/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact"},
        "entry": "index.html",
        "notes": {
            0: "Seed game before the continuation loop",
            5: "Survivor loop with persistent progression and runtime QA",
            10: "This epoch was not a completed paired candidate; seed retained",
            15: "Expanded effects, stages, achievements and live QA evidence",
        },
    },
    "chudopoly": {
        "title": "Chudopoly",
        "epochs": [0, 3, 5, 8],
        "available": {0: "epoch_001/pair/task-seed/game", 3: "epoch_003/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact", 5: "epoch_005/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact", 8: "epoch_008/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact"},
        "entry": "public/index.html",
        "notes": {
            0: "Seed multiplayer board-game shell",
            5: "Bot strategy, reconnect handling, rules and replay evidence",
            3: "Board rules and bot sequencing become explicit",
            8: "Richer web product with server authority and UI contracts",
        },
    },
    "polybranch-remediated": {
        "title": "Polybranch Remediated",
        "epochs": [0, 11, 13, 14],
        "available": {0: "epoch_011/pair/task-seed/game", 11: "epoch_011/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact", 13: "epoch_013/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact", 14: "epoch_014/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact"},
        "entry": "index.html",
        "notes": {
            0: "Pre-remediation seed view",
            11: "First completed checkpoint after infrastructure remediation",
            13: "Probe-driven refinement and carried harness worker",
            14: "Latest completed artifact before the next incomplete epoch",
        },
    },
}

COLORS = {
    "ink": "#24313a",
    "muted": "#65757d",
    "paper": "#f7f3ec",
    "teal": "#2b8c8c",
    "teal_light": "#d8eeee",
    "gold": "#e5ad52",
    "gold_light": "#f8e8c7",
    "coral": "#d56a5e",
    "coral_light": "#f6d8d3",
    "slate_light": "#e3eaf0",
    "olive_light": "#e5edd9",
    "plum_light": "#ede0f4",
}

FRAMESETS = {
    "iron-breakout-fps": {
        0: {
            "subhead": "Seed shell with a single smoke check",
            "note": "Single root loop; no delegated slice or probe library",
            "top": [
                ("Task brief\n+ constraints", "gold_light"),
                ("Root agent\nimplementation", "teal_light"),
                ("Game artifact", "gold_light"),
            ],
            "bottom": [
                ("Basic smoke check\nmanual completion signal", "coral_light"),
            ],
            "footer": "One root loop; validation is just a quick smoke pass",
        },
        5: {
            "subhead": "Pause screen gains a live status strip",
            "note": "Pause now snapshots combat state instead of hiding the HUD",
            "top": [
                ("Task brief\n+ constraints", "gold_light"),
                ("Root plan\nand inspect", "teal_light"),
                ("Implementation\nworker slice", "teal_light"),
                ("Pause-state\nsnapshot hook", "coral_light"),
            ],
            "bottom": [
                ("HUD sync\nscore / ammo / objective", "slate_light"),
                ("Paired gate\nA/B evidence", "coral_light"),
            ],
            "footer": "Delegation + live pause evidence + paired quality gate",
        },
        10: {
            "subhead": "Combat feedback and survival readouts become explicit",
            "note": "The run now exposes threat tiers and long-horizon state",
            "top": [
                ("Task brief\n+ constraints", "gold_light"),
                ("Root plan\nand inspect", "teal_light"),
                ("Combat-state\nworker slice", "teal_light"),
                ("Threat-tier\nbalance probe", "plum_light"),
            ],
            "bottom": [
                ("Runtime artifact\nlive playtest", "gold_light"),
                ("Regression replay\nstability check", "slate_light"),
                ("Paired gate\nACCEPT / REJECT", "coral_light"),
            ],
            "footer": "The harness grows from status display to survival-readout verification",
        },
        14: {
            "subhead": "Final continuation checkpoint integrates the full HUD",
            "note": "Objective, ammo, survival, and replay evidence all align",
            "top": [
                ("Task brief\n+ constraints", "gold_light"),
                ("Root plan\nand inspect", "teal_light"),
                ("Implementation\nworker slice", "teal_light"),
                ("HUD / ammo /\nobjective sync", "olive_light"),
            ],
            "bottom": [
                ("Artifact runtime\nfull playthrough", "gold_light"),
                ("Probe matrix\nscreenshots + trace", "coral_light"),
                ("Paired gate\nfinal decision", "coral_light"),
            ],
            "footer": "The later epoch adds more concrete checks, not the same skeleton",
        },
    },
    "canvas-vampire-survivors": {
        0: {
            "subhead": "Seed before continuation",
            "note": "Baseline survivor loop without the richer progression layer",
            "top": [
                ("Task brief\n+ constraints", "gold_light"),
                ("Seed game\nimplementation", "teal_light"),
                ("Playable artifact", "gold_light"),
            ],
            "bottom": [
                ("Basic smoke check", "coral_light"),
            ],
            "footer": "Seed loop only; no layered progression surface yet",
        },
        5: {
            "subhead": "Progression ledger and pause-state visibility",
            "note": "Visible run state starts to matter during longer sessions",
            "top": [
                ("Task brief\n+ constraints", "gold_light"),
                ("Root plan\n+ inspect", "teal_light"),
                ("Survivor loop\nworker slice", "teal_light"),
                ("Progression\nledger hook", "olive_light"),
            ],
            "bottom": [
                ("Runtime artifact\nlong-run playtest", "gold_light"),
                ("State-check probe\nfeedback clarity", "slate_light"),
            ],
            "footer": "The harness starts to measure progression, not just launch success",
        },
        10: {
            "subhead": "Seed retained because the candidate was incomplete",
            "note": "This checkpoint exposes the boundary where the chain refused to promote",
            "top": [
                ("Task brief\n+ constraints", "gold_light"),
                ("Seed artifact\nretained", "slate_light"),
                ("Coverage gap\nreview", "coral_light"),
                ("No promotion\ncandidate", "coral_light"),
            ],
            "bottom": [
                ("Verification\ndid not close", "coral_light"),
            ],
            "footer": "A useful contrast case: the structure stays thin when the candidate is incomplete",
        },
        15: {
            "subhead": "Expanded effects, stages, and achievements",
            "note": "The later epoch is visibly more comprehensive and better instrumented",
            "top": [
                ("Task brief\n+ constraints", "gold_light"),
                ("Root plan\nand inspect", "teal_light"),
                ("Implementation\nworker slice", "teal_light"),
                ("Stages /\neffects /\nachievements", "olive_light"),
            ],
            "bottom": [
                ("Artifact runtime\nlive trace", "gold_light"),
                ("Probe matrix\nplaytest evidence", "plum_light"),
                ("Paired gate\nfinal check", "coral_light"),
            ],
            "footer": "The later epoch visibly adds more game systems to validate",
        },
    },
    "chudopoly": {
        0: {
            "subhead": "Seed multiplayer shell",
            "note": "Core loop only; no explicit reconnect or authority surface yet",
            "top": [
                ("Task brief\n+ constraints", "gold_light"),
                ("Root agent\nimplementation", "teal_light"),
                ("Board-game\nartifact", "gold_light"),
            ],
            "bottom": [
                ("Basic smoke check", "coral_light"),
            ],
            "footer": "The initial shell is thin and mostly proves the loop runs",
        },
        3: {
            "subhead": "Board rules and bot sequencing become explicit",
            "note": "More of the multiplayer contract is visible to the player",
            "top": [
                ("Task brief\n+ constraints", "gold_light"),
                ("Root plan\nand inspect", "teal_light"),
                ("Rules / bot\nworker slice", "teal_light"),
                ("Reconnect\nhandling", "coral_light"),
            ],
            "bottom": [
                ("Replay trace\nand server check", "slate_light"),
                ("Paired gate\nA/B evidence", "coral_light"),
            ],
            "footer": "Now the workflow has explicit multiplayer and replay checks",
        },
        5: {
            "subhead": "Bot strategy and reconnect logic deepen",
            "note": "This epoch makes the bot and reconnect surface easier to inspect",
            "top": [
                ("Task brief\n+ constraints", "gold_light"),
                ("Root plan\nand inspect", "teal_light"),
                ("Bot strategy\nworker slice", "teal_light"),
                ("Reconnect / replay\nprobe", "plum_light"),
            ],
            "bottom": [
                ("Artifact runtime\nmultiplayer session", "gold_light"),
                ("Authority check\nserver-side state", "slate_light"),
                ("Paired gate\naccept / reject", "coral_light"),
            ],
            "footer": "The harness now reaches deeper into game authority and recovery",
        },
        8: {
            "subhead": "Server authority and UI contracts are explicit",
            "note": "The final checkpoint reads like a fuller product, not a thin shell",
            "top": [
                ("Task brief\n+ constraints", "gold_light"),
                ("Root plan\nand inspect", "teal_light"),
                ("Server authority\nworker slice", "teal_light"),
                ("UI contract /\nmultiplayer replay", "olive_light"),
            ],
            "bottom": [
                ("Artifact runtime\nend-to-end play", "gold_light"),
                ("Probe matrix\nreconnect + replay", "plum_light"),
                ("Paired gate\nfinal verdict", "coral_light"),
            ],
            "footer": "By this epoch the harness is checking a more complete multiplayer product",
        },
    },
    "polybranch-remediated": {
        0: {
            "subhead": "Pre-remediation seed view",
            "note": "Baseline before the later repair work and probe hooks",
            "top": [
                ("Task brief\n+ constraints", "gold_light"),
                ("Root agent\nimplementation", "teal_light"),
                ("Game artifact", "gold_light"),
            ],
            "bottom": [
                ("Smoke check\nmanual pass", "coral_light"),
            ],
            "footer": "The first checkpoint is just the seed path",
        },
        11: {
            "subhead": "Baseline repairs plus boot-probe validation",
            "note": "Repair work is verified before the later visual polish lands",
            "top": [
                ("Task brief\n+ constraints", "gold_light"),
                ("Baseline repair\nworker slice", "teal_light"),
                ("Boot probe\ncheck", "coral_light"),
                ("Transpile\nverification", "slate_light"),
            ],
            "bottom": [
                ("Artifact runtime\npost-repair", "gold_light"),
                ("Regression gate\nfocused static checks", "coral_light"),
            ],
            "footer": "The workflow now includes repair + probe + transpile checks",
        },
        13: {
            "subhead": "Speed streaks and probe hooks appear",
            "note": "The runtime feedback layer is visibly richer than the seed",
            "top": [
                ("Task brief\n+ constraints", "gold_light"),
                ("Root plan\nand inspect", "teal_light"),
                ("Speed-streak\nrenderer", "olive_light"),
                ("Probe hooks\nfor streaks", "plum_light"),
            ],
            "bottom": [
                ("Pause / crash\nguard", "coral_light"),
                ("Runtime feedback\nverification", "gold_light"),
                ("Paired gate\naccept / reject", "coral_light"),
            ],
            "footer": "The later epoch adds visible motion logic and probeable controls",
        },
        14: {
            "subhead": "Speed intensity and final verification",
            "note": "The last checkpoint layers the intensity logic onto the repair path",
            "top": [
                ("Task brief\n+ constraints", "gold_light"),
                ("Root plan\nand inspect", "teal_light"),
                ("Speed intensity\nworker slice", "olive_light"),
                ("Pause / crash\nverification", "plum_light"),
            ],
            "bottom": [
                ("Artifact runtime\nfull trace", "gold_light"),
                ("Probe matrix\nfinal replay", "coral_light"),
                ("Paired gate\nfinal verdict", "coral_light"),
            ],
            "footer": "This epoch looks broader because the runtime and verification both grew",
        },
    },
}


def epoch_status(case, epoch):
    if epoch == 0:
        return "SEED"
    p = RUN_ROOT / case / f"epoch_{epoch:03d}/pair/paired-proof.json"
    if not p.exists():
        return "UNAVAILABLE"
    text = p.read_text()
    if '"status": "FAILED_INFRA"' in text:
        return "FAILED_INFRA"
    if '"accepted": true' in text:
        return "ACCEPT"
    if '"accepted": false' in text:
        return "REJECT"
    return "RECORDED"


def node(x, y, w, h, label, fill, stroke=COLORS["ink"], fs=9):
    lines = label.split("\n")
    line_h = 12
    start_y = y + h / 2 - (len(lines) - 1) * line_h / 2 + 3
    text = "".join(
        f'<text x="{x+w/2}" y="{start_y+i*line_h}" text-anchor="middle" '
        f'font-family="Arial,Helvetica,sans-serif" font-size="{fs}" fill="{COLORS["ink"]}">{escape(line)}</text>'
        for i, line in enumerate(lines)
    )
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.2"/>{text}'


def arrow(x1, y1, x2, y2):
    return (
        f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{COLORS["teal"]}" '
        'stroke-width="1.6" marker-end="url(#arrow)"/>'
    )


def color(name):
    return COLORS[name]


def build_story_svg(case, epoch, title, status):
    frame = FRAMESETS[case][epoch]
    w, h = 400, 300
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">',
        f'<rect width="{w}" height="{h}" fill="{COLORS["paper"]}"/>',
        f'<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="{COLORS["teal"]}"/></marker></defs>',
        f'<text x="20" y="24" font-family="Arial,Helvetica,sans-serif" font-size="15" font-weight="700" fill="{COLORS["ink"]}">{escape(title)}</text>',
        f'<text x="20" y="42" font-family="Arial,Helvetica,sans-serif" font-size="10" fill="{COLORS["muted"]}">Epoch {epoch} · {escape(status)}</text>',
        f'<text x="20" y="58" font-family="Arial,Helvetica,sans-serif" font-size="9" fill="{COLORS["muted"]}">{escape(frame["subhead"])}</text>',
        f'<text x="20" y="272" font-family="Arial,Helvetica,sans-serif" font-size="9" fill="{COLORS["muted"]}">{escape(frame["note"])}</text>',
    ]
    top = frame["top"]
    bottom = frame["bottom"]
    max_top = max(len(top), 1)
    top_w = 360 / max_top - 8
    top_xs = []
    for i, (label, fill_key) in enumerate(top):
        x = 20 + i * (360 / max_top)
        top_xs.append((x, top_w))
        parts.append(node(x, 86, top_w, 34, label, COLORS[fill_key], fs=8))
    if len(top) > 1:
        for i in range(len(top) - 1):
            x1, w1 = top_xs[i]
            x2, w2 = top_xs[i + 1]
            parts.append(arrow(x1 + w1, 103, x2, 103))
    bottom_y = 170
    bottom_h = 36 if len(bottom) <= 2 else 34
    bottom_w = 360 / max(len(bottom), 1) - 8
    bottom_xs = []
    for i, (label, fill_key) in enumerate(bottom):
        x = 20 + i * (360 / max(len(bottom), 1))
        bottom_xs.append((x, bottom_w))
        parts.append(node(x, bottom_y, bottom_w, bottom_h, label, COLORS[fill_key], fs=8))
    if len(bottom) > 1:
        for i in range(len(bottom) - 1):
            x1, w1 = bottom_xs[i]
            x2, w2 = bottom_xs[i + 1]
            parts.append(arrow(x1 + w1, bottom_y + bottom_h / 2, x2, bottom_y + bottom_h / 2))
    if top and bottom:
        parts.append(arrow(top_xs[-1][0] + top_xs[-1][1] / 2, 120, bottom_xs[0][0] + bottom_xs[0][1] / 2, bottom_y))
    if len(bottom) >= 2:
        parts.append(arrow(bottom_xs[-1][0] + bottom_xs[-1][1] / 2, bottom_y, bottom_xs[-1][0] + bottom_xs[-1][1] / 2, 150))
    parts.append(f'<text x="200" y="245" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="9" fill="{COLORS["muted"]}">{escape(frame["footer"])}</text>')
    parts.append("</svg>")
    return "".join(parts)


def launcher(case, epoch, rel, entry, title):
    artifact = RUN_ROOT / case / rel
    port = 8700 + (abs(hash(f"{case}:{epoch}")) % 700)
    artifact_q = "'" + str(artifact).replace("'", "'\"'\"'") + "'"
    entry_q = "'" + entry.replace("'", "'\"'\"'") + "'"
    return f"""#!/usr/bin/env bash
set -euo pipefail

ARTIFACT={artifact_q}
ENTRY={entry_q}
PORT={port}

if [[ ! -f "$ARTIFACT/$ENTRY" ]]; then
  echo "Artifact entrypoint missing: $ARTIFACT/$ENTRY" >&2
  exit 1
fi

echo "Launching {title} / epoch {epoch}"
echo "Artifact: $ARTIFACT"
echo "Open: http://127.0.0.1:$PORT/$ENTRY"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ARTIFACT" >/tmp/evolution-demo-{case}-{epoch}.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM
sleep 0.5
open "http://127.0.0.1:$PORT/$ENTRY"
wait "$SERVER_PID"
"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    index = ["# Multi-epoch Evolution Demo", "", "Generated from real archived runs on 2026-09-08.", "",
             "The original Verigame/GDBench Space Invaders, Alto's Adventure, task_0015 and visual-novel folders had empty `epochs.json` files or only one generation, so they are not presented as fake 0/20/40/60/80 histories here.", "",
             "## Real multi-epoch cases"]
    for case, cfg in CASES.items():
        case_dir = OUT / case
        case_dir.mkdir(exist_ok=True)
        index += [f"### {cfg['title']}", f"- Real checkpoints: {', '.join(map(str, cfg['epochs']))}"]
        for epoch in cfg["epochs"]:
            rel = cfg["available"][epoch]
            artifact = RUN_ROOT / case / rel
            status = epoch_status(case, epoch)
            svg = build_story_svg(case, epoch, cfg["title"], status)
            (case_dir / f"epoch-{epoch:03d}-harness.svg").write_text(svg)
            script = launcher(case, epoch, rel, cfg["entry"], cfg["title"])
            launch_path = case_dir / f"epoch-{epoch:03d}-run.sh"
            launch_path.write_text(script)
            launch_path.chmod(0o755)
            index += [f"- Epoch {epoch}: `{status}` · [harness SVG](./{case}/epoch-{epoch:03d}-harness.svg) · `{case}/epoch-{epoch:03d}-run.sh` · artifact exists: `{artifact.exists()}`"]
        index.append("")
    (OUT / "README.md").write_text("\n".join(index) + "\n")


if __name__ == "__main__":
    main()
