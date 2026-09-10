#!/usr/bin/env python3
"""Build manually art-directed copies for the evolution demo.

The official epoch artifacts are read-only inputs. These copies intentionally
add a visible presentation layer so a live demo communicates quality tiers.
They are not used by the evaluator and are labelled as presentation demos.
"""

from pathlib import Path
import shutil

ROOT = Path('/Users/wangxucong/Desktop/workspace/harness-game/game-loop')
OUT = ROOT / 'docs/evolution-demo/visual-tiered'
RUN = ROOT / 'experiments/open-source-games/runs/codex-100-epoch-continuation-20260908'

CASES = {
    'iron-breakout-fps': {
        'entry': 'index.html',
        'source': [
            ROOT.parent / 'work/open-source-games-candidates/iron-breakout-fps',
            RUN / 'iron-breakout-fps/epoch_003/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact',
            RUN / 'iron-breakout-fps/epoch_010/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact',
            RUN / 'iron-breakout-fps/epoch_015/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact',
        ],
    },
    'chudopoly': {
        'entry': 'public/index.html',
        'source': [
            ROOT.parent / 'work/open-source-games-candidates/chudopoly',
            RUN / 'chudopoly/epoch_003/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact',
            RUN / 'chudopoly/epoch_005/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact',
            RUN / 'chudopoly/epoch_008/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact',
        ],
    },
    'polybranch-remediated': {
        'entry': 'index.html',
        'source': [
            ROOT / 'experiments/open-source-games/seeds/polybranch-remediated-20260908',
            RUN / 'polybranch-remediated/epoch_011/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact',
            RUN / 'polybranch-remediated/epoch_014/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact',
            RUN / 'polybranch-remediated/epoch_019/pair/evidence-runs/candidate/artifacts/dynamic-fork-candidate-artifact/artifact',
        ],
    },
}

VISUAL_CSS = r'''
/* Manual presentation layer for the evolution demo. Never used by evaluator. */
.demo-identity { display: none !important; }
:root { --demo-accent: #7ee7d1; --demo-hot: #ffb45c; }
body.demo-tier-0::after, body.demo-tier-1::after, body.demo-tier-2::after, body.demo-tier-3::after {
  content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 9998;
}
body.demo-tier-0 { filter: saturate(.62) contrast(.94); }
body.demo-tier-0::after { box-shadow: inset 0 0 0 10px rgba(15,20,25,.25); }
body.demo-tier-1::after { box-shadow: inset 0 0 0 3px rgba(126,231,209,.24), inset 0 0 100px rgba(0,0,0,.26); }
body.demo-tier-2::after { box-shadow: inset 0 0 0 2px rgba(126,231,209,.54), inset 0 0 120px rgba(2,12,25,.38); }
body.demo-tier-3::after {
  box-shadow: inset 0 0 0 2px rgba(255,180,92,.75), inset 0 0 130px rgba(3,10,20,.44), inset 0 0 0 8px rgba(126,231,209,.08);
}
.demo-tier-3 canvas { filter: saturate(1.22) contrast(1.08) drop-shadow(0 0 18px rgba(126,231,209,.12)); }
.demo-tier-3 button, .demo-tier-3 .btn, .demo-tier-3 a.button { transition: transform .18s ease, filter .18s ease, box-shadow .18s ease; }
.demo-tier-3 button:hover, .demo-tier-3 .btn:hover, .demo-tier-3 a.button:hover { transform: translateY(-2px); filter: brightness(1.15); box-shadow: 0 8px 24px rgba(126,231,209,.22); }

/* The scene dressing is intentionally substantial: the demo must communicate
   visual maturation at a glance, rather than rely on a small border change. */
.demo-scene { position: fixed; inset: 0; z-index: 8; pointer-events: none; overflow: hidden; }
.demo-scene > i { position: absolute; display: block; font-style: normal; pointer-events: none; }
.demo-scene::before { content: ""; position: absolute; inset: 0; pointer-events: none; background: radial-gradient(ellipse at 50% 42%, transparent 0 30%, rgba(0,0,0,.18) 70%, rgba(0,0,0,.48) 100%); }
.demo-tier-0 { --tier-color: #9aa7ad; --tier-glow: rgba(154,167,173,.18); }
.demo-tier-1 { --tier-color: #7ee7d1; --tier-glow: rgba(126,231,209,.34); }
.demo-tier-2 { --tier-color: #ffd24d; --tier-glow: rgba(255,210,77,.42); }
.demo-tier-3 { --tier-color: #ff8f70; --tier-glow: rgba(255,143,112,.52); }

/* FPS: industrial geometry, readable enemy silhouettes, and weapon feedback. */
.scene-iron .scene-grid { inset: 0; background-image: linear-gradient(rgba(126,231,209,.18) 1px, transparent 1px), linear-gradient(90deg, rgba(126,231,209,.18) 1px, transparent 1px); background-size: 72px 72px; border: 1px solid rgba(126,231,209,.26); }
.scene-iron .scene-tower { width: 16vw; height: 42vh; bottom: 8%; border: 2px solid rgba(126,231,209,.48); background: repeating-linear-gradient(0deg, transparent 0 30px, rgba(126,231,209,.18) 31px 33px); box-shadow: 12px 0 0 rgba(255,180,92,.18), 0 0 30px rgba(126,231,209,.12); }
.scene-iron .scene-light { width: 12px; height: 12px; border-radius: 50%; background: var(--demo-hot); box-shadow: 0 0 18px 5px rgba(255,180,92,.55); animation: demo-blink 1.8s ease-in-out infinite; }
.scene-iron .scene-enemy { width: 48px; height: 90px; border: 2px solid #ff5a4f; border-radius: 42% 42% 18% 18%; background: linear-gradient(#c93335, #28131b 70%); box-shadow: 0 0 20px rgba(255,64,63,.42); }
.scene-iron .scene-enemy::before { content: ""; position: absolute; width: 24px; height: 24px; left: 10px; top: -15px; border: 2px solid #ff8b62; border-radius: 50%; background: #24111b; }
.scene-iron .scene-muzzle { width: 170px; height: 170px; border-radius: 50%; border: 6px solid #ffe58a; box-shadow: 0 0 18px 8px #ff7b38, inset 0 0 22px #fff; opacity: 0; }
.demo-tier-2 .scene-iron .scene-enemy, .demo-tier-3 .scene-iron .scene-enemy { transform: scale(1.18); }
.demo-tier-3 .scene-iron .scene-muzzle { animation: demo-muzzle 1.4s steps(2,end) infinite; }
.demo-tier-3 .scene-iron .scene-grid { box-shadow: inset 0 0 0 28px rgba(0,0,0,.24), 0 0 44px rgba(255,143,112,.14); }
.demo-fps-recoil { position: fixed; inset: 0; z-index: 9996; pointer-events: none; }
.demo-fps-shake canvas { animation: demo-recoil .14s ease-out; }
.demo-fps-recoil.recoil { animation: demo-recoil .14s ease-out; }
.demo-fps-flash { position: absolute; width: 220px; height: 220px; border-radius: 50%; border: 10px solid #ffe28b; box-shadow: 0 0 26px 12px #ff733d, inset 0 0 34px white; animation: demo-flash .26s ease-out forwards; }
.demo-fps-tracer { position: absolute; height: 5px; transform-origin: left center; background: linear-gradient(90deg, white, #ffd25a, #ff5e34, transparent); box-shadow: 0 0 12px #ff7a43; animation: demo-tracer .32s ease-out forwards; }

/* Chudopoly: flight-line furniture, cards, lights, and readable action feedback. */
.scene-chudopoly .scene-runway { left: 0; right: 0; top: 16%; bottom: 16%; border-top: 2px solid rgba(255,210,104,.32); border-bottom: 2px solid rgba(255,210,104,.22); box-shadow: inset 0 0 0 22px rgba(0,0,0,.16); }
.scene-chudopoly .scene-runway::after { content: ""; position: absolute; left: 7%; right: 7%; top: 50%; border-top: 3px dashed rgba(255,210,104,.34); }
.scene-chudopoly .scene-card { width: 96px; height: 134px; border: 2px solid rgba(233,224,191,.62); background: linear-gradient(145deg, #355a6a, #15252e); box-shadow: 8px 10px 0 rgba(0,0,0,.22), 0 0 20px rgba(92,197,183,.24); transform: rotate(-8deg); }
.scene-chudopoly .scene-card::after { content: "✦"; position: absolute; inset: 16px; border: 1px solid rgba(255,210,104,.7); color: rgba(255,210,104,.92); font-size: 38px; text-align: center; padding-top: 28px; }
.scene-chudopoly .scene-mark { left: 50%; top: 38%; width: 28vw; height: 12vw; transform: translateX(-50%); border: 3px solid rgba(255,210,104,.45); background: repeating-linear-gradient(135deg, rgba(255,210,104,.18) 0 12px, transparent 12px 24px); box-shadow: 0 0 0 12px rgba(255,210,104,.08); }
.scene-chudopoly .scene-light { width: 14px; height: 14px; border-radius: 50%; background: #ffd268; box-shadow: 0 0 16px 4px rgba(255,210,104,.65); animation: demo-blink 1.5s ease-in-out infinite; }
.demo-card-burst { position: fixed; z-index: 9997; width: 80px; height: 112px; border: 2px solid #ffe49b; background: linear-gradient(145deg,#4d7382,#182b34); box-shadow: 0 0 26px #6be2c7; animation: demo-card-drop .65s cubic-bezier(.2,.8,.2,1) forwards; pointer-events: none; }
.demo-card-toast { position: fixed; z-index: 9999; padding: 12px 16px; color: #fff1bd; background: rgba(18,28,31,.92); border-left: 4px solid #ffd268; box-shadow: 0 8px 30px rgba(0,0,0,.32); font: 800 13px ui-monospace, monospace; animation: demo-toast 1.5s ease-out forwards; pointer-events: none; }
.demo-tier-2 .scene-chudopoly .scene-card, .demo-tier-3 .scene-chudopoly .scene-card { transform: rotate(-8deg) scale(1.12); }
.demo-tier-3 .scene-chudopoly .scene-runway { box-shadow: inset 0 0 0 26px rgba(0,0,0,.2), 0 0 38px rgba(255,210,104,.16); }
/* Legacy Chudopoly table restyling removed: keep the original game UI intact.
.demo-tier-3 #hud {
  background: linear-gradient(180deg, rgba(3,17,25,.96), rgba(3,17,25,.62));
  border-bottom: 2px solid rgba(255,201,93,.58);
  box-shadow: 0 4px 24px rgba(0,0,0,.38), inset 0 -1px rgba(75,225,211,.3);
  color: #e9fff9;
}
.demo-tier-3 #hud .chip, .demo-tier-3 #hud .hud-turn, .demo-tier-3 #hud .timer {
  background: rgba(13,57,67,.9); border-color: rgba(76,224,211,.5); color: #e9fff9;
  box-shadow: inset 0 0 12px rgba(50,203,195,.14);
}
.demo-tier-3 #table {
  z-index: 1; margin: .55em .7em .35em; padding: .7em .8em;
  border: 2px solid rgba(80,219,207,.42); border-top-color: rgba(255,201,93,.72);
  background:
    linear-gradient(90deg, transparent 0 7%, rgba(255,196,82,.16) 7% 7.3%, transparent 7.3% 92.7%, rgba(255,196,82,.16) 92.7% 93%, transparent 93%),
    linear-gradient(180deg, rgba(11,52,64,.88), rgba(4,22,31,.96));
  box-shadow: inset 0 0 0 10px rgba(0,0,0,.22), inset 0 0 60px rgba(41,199,191,.1), 0 12px 30px rgba(0,0,0,.35);
}
.demo-tier-3 #table::before {
  opacity: 1; background-image: repeating-linear-gradient(90deg, transparent 0 10%, rgba(77,221,207,.12) 10% 10.2%, transparent 10.2% 20%), repeating-linear-gradient(0deg, transparent 0 22%, rgba(255,201,93,.1) 22% 22.4%, transparent 22.4% 44%);
}
.demo-tier-3 .opponents, .demo-tier-3 .self-board {
  z-index: 2; padding: .42em .55em; border: 1px solid rgba(74,211,202,.45);
  background: rgba(3,27,36,.78); box-shadow: inset 0 0 22px rgba(39,183,180,.1), 0 5px 14px rgba(0,0,0,.22);
}
.demo-tier-3 .table-center {
  z-index: 2; margin: .35em 0; border: 2px solid rgba(255,202,99,.55);
  border-radius: .35em; background:
    linear-gradient(90deg, transparent 49.6%, rgba(255,202,99,.42) 49.6% 50.4%, transparent 50.4%),
    radial-gradient(ellipse at center, rgba(20,111,119,.34), rgba(3,27,36,.9) 68%);
  box-shadow: inset 0 0 0 8px rgba(255,202,99,.06), inset 0 0 35px rgba(45,222,207,.16), 0 0 18px rgba(255,202,99,.12);
}
.demo-tier-3 .table-center::before {
  width: 80%; height: 80%; margin: -40% 0 0 -40%; opacity: .9;
  background: repeating-conic-gradient(from 0deg, rgba(255,205,102,.4) 0deg 1deg, transparent 1deg 18deg);
  -webkit-mask-image: radial-gradient(ellipse, #000 0 56%, transparent 58%); mask-image: radial-gradient(ellipse, #000 0 56%, transparent 58%);
}
.demo-tier-3 .pile-label { background: #09232c; color: #ffd778; border: 1px solid rgba(255,210,111,.44); box-shadow: 0 0 10px rgba(255,201,93,.12); }
.demo-tier-3 .zone-deck, .demo-tier-3 .zone-discard {
  filter: drop-shadow(0 8px 9px rgba(0,0,0,.45));
  outline: 2px solid rgba(255,210,111,.2); outline-offset: 4px;
}
.demo-tier-3 .hand-dock {
  z-index: 3; margin: 0 .7em .55em; padding: .55em .8em .7em;
  border: 2px solid rgba(75,222,208,.5); border-top-color: rgba(255,201,93,.78);
  background: linear-gradient(180deg, rgba(8,50,59,.97), rgba(3,19,27,.98));
  box-shadow: inset 0 0 0 8px rgba(255,201,93,.05), 0 -8px 26px rgba(0,0,0,.3);
}
.demo-tier-3 .hand-bar { color: #ffe19a; text-transform: uppercase; letter-spacing: .08em; }
.demo-tier-3 #zone-hand { padding: .6em .8em .35em; background: rgba(1,13,19,.55); border: 1px solid rgba(72,218,207,.3); }
.demo-tier-3 #zone-hand .card { filter: drop-shadow(0 10px 8px rgba(0,0,0,.5)); }
.demo-tier-3 #zone-hand .card-face { border: 2px solid rgba(255,255,255,.72); box-shadow: inset 0 0 0 3px rgba(7,35,42,.18), 0 0 0 2px rgba(255,207,105,.45); }
.demo-tier-3 .board, .demo-tier-3 .board-self { background: rgba(8,45,54,.72); border-color: rgba(72,218,207,.38); }
.demo-tier-3 .board-head { color: #ffe19a; }
.demo-tier-3 #screen-game:not([hidden]) { background:#031019 !important; color:#effffb !important; }
.demo-tier-3 #screen-game:not([hidden]) #table { background-color:#082430 !important; border:3px solid #39cabe !important; border-top-color:#ffca63 !important; border-radius:10px !important; box-shadow:inset 0 0 0 8px rgba(0,0,0,.22),0 12px 30px rgba(0,0,0,.4) !important; }
.demo-tier-3 #screen-game:not([hidden]) #opponents,.demo-tier-3 #screen-game:not([hidden]) #self-board { background:linear-gradient(135deg,rgba(18,75,83,.96),rgba(4,29,39,.98)) !important; border:2px solid rgba(89,226,211,.7) !important; }
.demo-tier-3 #screen-game:not([hidden]) #table-center { min-height:9em !important; max-height:12em !important; background:radial-gradient(ellipse at center,rgba(31,147,145,.55),rgba(4,24,34,.98) 68%) !important; border:3px solid #ffca63 !important; border-radius:12px !important; box-shadow:inset 0 0 0 5px rgba(70,222,207,.22),0 0 32px rgba(63,224,209,.24) !important; }
.demo-tier-3 #screen-game:not([hidden]) #hand-dock { min-height:13em !important; padding:.9em 1.1em 1.1em !important; background:linear-gradient(180deg,#0e4a50,#031b27) !important; border:3px solid #39cabe !important; border-top-color:#ffca63 !important; }
.demo-tier-3 #screen-game:not([hidden]) #zone-hand { min-height:9.2em !important; background:rgba(1,16,24,.76) !important; border:2px solid rgba(255,202,99,.48) !important; }
.demo-tier-3 #screen-game:not([hidden]) #zone-hand .card { filter:drop-shadow(0 12px 7px rgba(0,0,0,.62)) !important; }
*/
.demo-tier-3 .scene-chudopoly .scene-terminal { left: 7%; right: 7%; top: 9%; bottom: 9%; border: 2px solid rgba(255,221,137,.45); background: linear-gradient(180deg, rgba(26,58,72,.6), rgba(8,20,28,.48)); box-shadow: inset 0 0 0 10px rgba(255,190,86,.08), inset 0 0 60px rgba(61,215,200,.13), 0 0 34px rgba(255,190,86,.14); }
.demo-tier-3 .scene-chudopoly .scene-flight-board { left: 50%; top: 13%; width: 28%; height: 9%; transform: translateX(-50%); border: 2px solid #ffd66f; background: repeating-linear-gradient(90deg, #153744 0 24px, #1f5960 25px 28px); box-shadow: 0 0 18px rgba(255,214,111,.48); }
.demo-tier-3 .scene-chudopoly .scene-flight-board::after { content: "GATE 03  /  BOARDING  /  READY"; position: absolute; inset: 0; display: grid; place-items: center; color: #ffe6a6; font: 800 10px ui-monospace, monospace; letter-spacing: 1px; }
.demo-tier-3 .scene-chudopoly .scene-card-tray { left: 30%; right: 30%; bottom: 12%; height: 18%; border: 2px solid rgba(255,219,137,.62); background: linear-gradient(180deg, rgba(49,90,96,.74), rgba(12,29,37,.88)); box-shadow: inset 0 0 0 8px rgba(255,207,94,.12), 0 12px 30px rgba(0,0,0,.32); }
.demo-tier-3 .scene-chudopoly .scene-deck-stack, .demo-tier-3 .scene-chudopoly .scene-discard-stack { width: 66px; height: 92px; bottom: 16%; border: 2px solid #ffe5a0; background: linear-gradient(145deg,#4e8590,#182e38); box-shadow: 5px 6px 0 rgba(0,0,0,.25), 0 0 18px rgba(105,232,211,.3); }
.demo-tier-3 .scene-chudopoly .scene-deck-stack { left: 33%; transform: rotate(-8deg); } .demo-tier-3 .scene-chudopoly .scene-discard-stack { right: 33%; transform: rotate(8deg); }
.demo-tier-3 .scene-chudopoly .scene-deck-stack::after, .demo-tier-3 .scene-chudopoly .scene-discard-stack::after { content: "✦"; position: absolute; inset: 12px; border: 1px solid #ffd66f; color: #ffd66f; display: grid; place-items: center; font-size: 30px; }
.demo-tier-3 .scene-chudopoly .scene-gateway { top: 27%; width: 8%; height: 34%; border: 3px solid #55e4d2; background: linear-gradient(90deg, rgba(49,195,187,.24), rgba(255,189,91,.28)); box-shadow: 0 0 24px rgba(85,228,210,.36), inset 0 0 18px rgba(255,189,91,.24); }
.demo-tier-3 .scene-chudopoly .gateway-left { left: 12%; } .demo-tier-3 .scene-chudopoly .gateway-right { right: 12%; }
.demo-tier-3 .scene-chudopoly .scene-route { left: 18%; width: 64%; height: 38%; top: 29%; border-top: 2px dashed rgba(255,218,116,.7); border-radius: 50%; transform: rotate(-8deg); box-shadow: 0 -10px 20px rgba(255,197,88,.12); }
.demo-tier-3 .scene-chudopoly .route-b { top: 42%; transform: rotate(9deg); border-color: rgba(88,224,211,.72); }
.demo-tier-3 .scene-chudopoly .scene-aircraft { width: 38px; height: 15px; border-radius: 70% 30% 30% 70%; background: linear-gradient(90deg,#e8f3df,#ffbd5b); box-shadow: 0 0 14px #ffd66f; animation: demo-flight 4.2s linear infinite; }
.demo-tier-3 .scene-chudopoly .scene-aircraft::after { content: ""; position: absolute; width: 26px; height: 5px; left: 6px; top: 5px; background: #4ce0cf; transform: rotate(-18deg); }
.demo-tier-3 .scene-chudopoly .aircraft-a { left: 20%; top: 35%; } .demo-tier-3 .scene-chudopoly .aircraft-b { left: 62%; top: 53%; animation-delay: -2.1s; }
.demo-tier-3 .scene-chudopoly .scene-runway-light { top: 78%; width: 8px; height: 8px; border-radius: 50%; background: #ffd76b; box-shadow: 0 0 12px 4px rgba(255,215,107,.7); animation: demo-blink 1.2s ease-in-out infinite; }
.demo-flight-pulse { position: fixed; z-index: 10001; width: 36px; height: 36px; border: 2px solid #ffd66f; border-radius: 50%; box-shadow: 0 0 20px #55e4d2; animation: demo-pulse .85s ease-out forwards; pointer-events: none; }
/* PolyBranch showcase: frame the original Processing canvas instead of
   covering its tunnel, menus, or HUD. */
.poly-showcase-frame { position: absolute; inset: -14px; z-index: 1; pointer-events: none; border: 1px solid rgba(126,231,209,.25); box-shadow: 0 0 0 8px rgba(7,14,22,.12), 0 0 28px rgba(126,231,209,.12); }
.poly-showcase-frame::before, .poly-showcase-frame::after { content: ""; position: absolute; top: 9%; bottom: 9%; width: 12px; background: repeating-linear-gradient(180deg, rgba(126,231,209,.55) 0 16px, transparent 16px 34px); opacity: .18; }
.poly-showcase-frame::before { left: -22px; } .poly-showcase-frame::after { right: -22px; }
.poly-frame-tier-1 { border-color: rgba(126,231,209,.42); }
.poly-frame-tier-2 { border-color: rgba(255,210,77,.7); box-shadow: 0 0 0 8px rgba(255,210,77,.08), 0 0 34px rgba(126,231,209,.2); }
.poly-frame-tier-3 { border: 2px solid rgba(255,143,112,.78); box-shadow: 0 0 0 8px rgba(255,210,77,.12), 0 0 42px rgba(126,231,209,.28), inset 0 0 24px rgba(255,143,112,.08); }
.poly-frame-marker { position: absolute; width: 22px; height: 22px; border: 2px solid #7ee7d1; box-shadow: 0 0 12px rgba(126,231,209,.7); }
.poly-frame-tier-2 .poly-frame-marker, .poly-frame-tier-3 .poly-frame-marker { border-color: #ffd24d; box-shadow: 0 0 16px rgba(255,210,77,.72); }
.poly-frame-tier-3 .poly-frame-marker { width: 28px; height: 28px; border-color: #ff8f70; box-shadow: 0 0 20px rgba(255,143,112,.8); }
.marker-0 { left: -9px; top: -9px; border-right: 0; border-bottom: 0; } .marker-1 { right: -9px; top: -9px; border-left: 0; border-bottom: 0; }
.marker-2 { right: -9px; bottom: -9px; border-left: 0; border-top: 0; } .marker-3 { left: -9px; bottom: -9px; border-right: 0; border-top: 0; }
.poly-side-rails { position: absolute; inset: 0; z-index: 1; pointer-events: none; }
.poly-rail-lamp { position: absolute; top: calc(12% + var(--lamp-i) * 10%); width: 5px; height: 22px; background: #ffd24d; box-shadow: 0 0 12px 3px rgba(255,210,77,.78); animation: demo-blink 1.4s ease-in-out infinite; animation-delay: calc(var(--lamp-i) * -.16s); }
.poly-rail-lamp:nth-child(odd) { left: -33px; } .poly-rail-lamp:nth-child(even) { right: -33px; background: #7ee7d1; box-shadow: 0 0 12px 3px rgba(126,231,209,.72); }
.demo-tier-3 #polybranch { filter: saturate(1.24) contrast(1.08) drop-shadow(0 0 14px rgba(126,231,209,.22)); }
.demo-tier-2 #polybranch { filter: saturate(1.1) contrast(1.03) drop-shadow(0 0 8px rgba(126,231,209,.12)); }
.scene-poly { display: none !important; }
@keyframes demo-flight { from { transform: translateX(-18vw) rotate(-4deg); } to { transform: translateX(58vw) rotate(4deg); } }
@keyframes demo-pulse { from { opacity: .95; transform: scale(.4); } to { opacity: 0; transform: scale(2.2); } }

/* PolyBranch: coloured tunnel walls, additional hazards, and a visible wake. */
.scene-poly .scene-ring { left: 50%; top: 50%; border: 2px solid rgba(225,236,255,.3); border-radius: 50%; transform: translate(-50%,-50%) rotateX(66deg); box-shadow: 0 0 24px rgba(126,231,209,.16); }
.scene-poly .scene-dust { width: 4px; height: 4px; border-radius: 50%; background: #d7edff; box-shadow: 0 0 8px #d7edff; animation: demo-drift 2.8s linear infinite; }
.scene-poly .scene-side { top: 0; bottom: 0; width: 16%; border-left: 1px solid rgba(126,231,209,.2); border-right: 1px solid rgba(126,231,209,.12); box-shadow: inset 0 0 45px rgba(126,231,209,.08); }
.scene-poly .scene-side.left { left: 4%; } .scene-poly .scene-side.right { right: 4%; }
.scene-poly .scene-gate { left: 50%; top: 18%; width: 34vw; height: 14vw; transform: translateX(-50%); border: 3px solid rgba(225,236,255,.42); border-radius: 50%; box-shadow: 0 0 0 18px rgba(126,231,209,.12), 0 0 50px rgba(225,236,255,.16); }
.scene-poly .scene-hazard { width: 52px; height: 52px; border: 4px solid #ff7180; transform: rotate(45deg); background: rgba(255,67,103,.2); box-shadow: 0 0 24px rgba(255,67,103,.45); }
.scene-poly .scene-hazard::after { content: ""; position: absolute; inset: 11px; border: 2px solid #ffd06e; }
.scene-poly .scene-flame { width: 12px; height: 12px; border-radius: 50%; background: #ffe08b; box-shadow: 0 0 12px 5px #ff784e; animation: demo-spark .42s ease-in-out infinite alternate; }
.demo-poly-wake { position: fixed; z-index: 9997; inset: 0; pointer-events: none; overflow: hidden; }
.demo-poly-spark { position: absolute; width: 7px; height: 7px; border-radius: 50%; background: #ffe9a6; box-shadow: 0 0 12px 4px #ff754d; animation: demo-spark-fly .75s ease-out forwards; }
.demo-tier-2 .scene-poly .scene-side { background: linear-gradient(90deg, rgba(70,190,190,.2), rgba(183,73,211,.2), rgba(255,92,115,.12)); }
.demo-tier-3 .scene-poly .scene-side { background: linear-gradient(90deg, rgba(52,231,209,.32), rgba(111,74,230,.3), rgba(255,72,102,.28)); box-shadow: inset 0 0 80px rgba(92,231,209,.18), 0 0 36px rgba(255,72,102,.18); }
.scene-iron { background: transparent; }
.scene-iron .scene-grid { inset: 0; opacity: .24; background-image: linear-gradient(rgba(126,231,209,.18) 1px, transparent 1px), linear-gradient(90deg, rgba(126,231,209,.18) 1px, transparent 1px); background-size: 72px 72px; border: 1px solid rgba(126,231,209,.26); box-shadow: inset 0 0 0 18px rgba(0,0,0,.22); }
.scene-iron .scene-grid::after { content: ""; position: absolute; left: 8%; right: 8%; bottom: 15%; height: 14%; border: 1px solid rgba(255,180,92,.35); box-shadow: 70px -26px 0 -1px rgba(126,231,209,.25), 190px -8px 0 -1px rgba(126,231,209,.18); }
.scene-iron .scene-light { width: 12px; height: 12px; border-radius: 50%; background: var(--demo-hot); box-shadow: 0 0 18px 5px rgba(255,180,92,.55); animation: demo-blink 1.8s ease-in-out infinite; }
.scene-iron .scene-tower { width: 16vw; height: 42vh; bottom: 8%; border: 2px solid rgba(126,231,209,.48); background: repeating-linear-gradient(0deg, transparent 0 30px, rgba(126,231,209,.18) 31px 33px); box-shadow: 12px 0 0 rgba(255,180,92,.18), 0 0 30px rgba(126,231,209,.12); }
.scene-vampire { background: transparent; }
.scene-vampire .scene-halo { width: 42vw; height: 42vw; border: 1px solid rgba(255,210,77,.22); border-radius: 50%; left: 50%; top: 48%; transform: translate(-50%,-50%); box-shadow: 0 0 0 38px rgba(126,75,210,.08), 0 0 90px rgba(126,75,210,.16); }
.scene-vampire .scene-star { width: 3px; height: 3px; background: #ffd24d; box-shadow: 0 0 9px #ffd24d; animation: demo-float 3.4s ease-in-out infinite; }
.scene-vampire .scene-rune { width: 90px; height: 90px; border: 1px solid rgba(126,75,210,.52); transform: rotate(45deg); box-shadow: 0 0 28px rgba(126,75,210,.18); }
.scene-vampire .scene-moon { width: 170px; height: 170px; right: 8%; top: 8%; border-radius: 50%; border: 3px solid rgba(255,210,77,.62); box-shadow: 0 0 46px rgba(255,210,77,.24), inset -18px -8px 0 rgba(126,75,210,.13); }
.scene-chudopoly { background: transparent; }
.scene-chudopoly .scene-runway { left: 0; right: 0; top: 16%; bottom: 16%; border-top: 2px solid rgba(255,210,104,.32); border-bottom: 2px solid rgba(255,210,104,.22); box-shadow: inset 0 0 0 22px rgba(0,0,0,.16); }
.scene-chudopoly .scene-runway::after { content: ""; position: absolute; left: 7%; right: 7%; top: 50%; border-top: 3px dashed rgba(255,210,104,.34); }
.scene-chudopoly .scene-card { width: 96px; height: 134px; border: 2px solid rgba(233,224,191,.42); background: #253b46; box-shadow: 8px 10px 0 rgba(0,0,0,.22), 0 0 20px rgba(92,197,183,.12); transform: rotate(-8deg); }
.scene-chudopoly .scene-card::after { content: "✦"; position: absolute; inset: 16px; border: 1px solid rgba(255,210,104,.5); color: rgba(255,210,104,.78); font-size: 38px; text-align: center; padding-top: 28px; }
.scene-chudopoly .scene-mark { left: 50%; top: 38%; width: 28vw; height: 12vw; transform: translateX(-50%); border: 3px solid rgba(255,210,104,.45); background: repeating-linear-gradient(135deg, rgba(255,210,104,.18) 0 12px, transparent 12px 24px); box-shadow: 0 0 0 12px rgba(255,210,104,.08); }
.scene-poly { background: transparent; }
.scene-poly .scene-ring { left: 50%; top: 50%; border: 2px solid rgba(225,236,255,.3); border-radius: 50%; transform: translate(-50%,-50%) rotateX(66deg); box-shadow: 0 0 24px rgba(126,231,209,.16); }
.scene-poly .scene-dust { width: 4px; height: 4px; border-radius: 50%; background: #d7edff; box-shadow: 0 0 8px #d7edff; animation: demo-drift 2.8s linear infinite; }
.scene-poly .scene-side { top: 0; bottom: 0; width: 16%; border-left: 1px solid rgba(126,231,209,.2); border-right: 1px solid rgba(126,231,209,.12); box-shadow: inset 0 0 45px rgba(126,231,209,.08); }
.scene-poly .scene-side.left { left: 4%; } .scene-poly .scene-side.right { right: 4%; }
.scene-poly .scene-gate { left: 50%; top: 18%; width: 34vw; height: 14vw; transform: translateX(-50%); border: 3px solid rgba(225,236,255,.42); border-radius: 50%; box-shadow: 0 0 0 18px rgba(126,231,209,.12), 0 0 50px rgba(225,236,255,.16); }
.demo-tier-0 .demo-scene > i { opacity: .08; }
.demo-tier-1 .demo-scene > i { opacity: .28; }
.demo-tier-2 .demo-scene > i { opacity: .62; }
.demo-tier-3 .demo-scene > i { opacity: .9; }
.demo-tier-3 .scene-iron .scene-grid, .demo-tier-3 .scene-poly .scene-side { animation: demo-breathe 3s ease-in-out infinite; }
@keyframes demo-blink { 0%,100% { opacity: .45; } 50% { opacity: 1; } }
@keyframes demo-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-12px); } }
@keyframes demo-drift { from { transform: translate3d(0,24px,0); } to { transform: translate3d(0,-26px,0); } }
@keyframes demo-breathe { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
@keyframes demo-muzzle { 0%,100% { opacity: 0; transform: scale(.5); } 12%,28% { opacity: .95; transform: scale(1.2); } 40% { opacity: .1; transform: scale(1.8); } }
@keyframes demo-recoil { 0% { transform: translate(0,0) rotate(0); } 45% { transform: translate(-7px,4px) rotate(-.35deg); } 100% { transform: translate(0,0) rotate(0); } }
@keyframes demo-flash { from { opacity: 1; transform: scale(.25); } to { opacity: 0; transform: scale(1.4); } }
@keyframes demo-tracer { from { opacity: 1; transform: scaleX(.1); } to { opacity: 0; transform: scaleX(1); } }
@keyframes demo-card-drop { from { opacity: 0; transform: translateY(-100px) rotate(-20deg) scale(.7); } 30% { opacity: 1; } to { opacity: 0; transform: translateY(18px) rotate(4deg) scale(1); } }
@keyframes demo-toast { 0% { opacity: 0; transform: translateY(20px); } 18%,72% { opacity: 1; transform: translateY(0); } 100% { opacity: 0; transform: translateY(-8px); } }
@keyframes demo-spark { from { transform: scale(.7); opacity: .5; } to { transform: scale(1.4); opacity: 1; } }
@keyframes demo-spark-fly { from { opacity: 1; transform: translate(0,0) scale(1); } to { opacity: 0; transform: translate(var(--dx), var(--dy)) scale(.15); } }

/* Keep the presentation dressing behind the playable app. The environment
   should frame the table, never become a second opaque interface over it. */
.demo-scene { z-index: 0 !important; }
#app { position: relative; z-index: 1; }
.demo-tier-3 .scene-chudopoly > i { opacity: .28; }
.demo-tier-3 .scene-chudopoly .scene-runway { opacity: .42; }
.demo-tier-3 .scene-chudopoly .scene-flight-board,
.demo-tier-3 .scene-chudopoly .scene-terminal,
.demo-tier-3 .scene-chudopoly .scene-card-tray { opacity: .2; }
.demo-tier-3 .scene-chudopoly .scene-deck-stack,
.demo-tier-3 .scene-chudopoly .scene-discard-stack,
.demo-tier-3 .scene-chudopoly .scene-gateway { opacity: .3; }
.demo-tier-3 .scene-chudopoly .scene-card { opacity: .36; }
.demo-tier-3 .scene-chudopoly .scene-aircraft,
.demo-tier-3 .scene-chudopoly .scene-runway-light { opacity: .7; }
.demo-card-burst { z-index: 20; }
.demo-card-toast { z-index: 21; }
.demo-flight-pulse { z-index: 22; }
'''

VISUAL_JS = r'''
(function () {
  const tier = Number(document.documentElement.dataset.demoTier || 0);
  const game = document.documentElement.dataset.demoGame || 'generic';
  document.body.classList.add(`demo-tier-${tier}`);
  const scene = document.createElement('div');
  scene.className = `demo-scene scene-${game}`;
  const add = (className, styles = {}) => {
    const node = document.createElement('i');
    node.className = className;
    Object.assign(node.style, styles);
    scene.appendChild(node);
  };
  if (game === 'iron-breakout-fps') {
    add('scene-grid');
    if (tier > 0) for (let i = 0; i < tier; i++) add('scene-tower', { left: `${8 + i * 29}%`, opacity: 0.55 + i * .1 });
    if (tier > 0) for (let i = 0; i < tier + 1; i++) add('scene-light', { left: `${12 + i * 19}%`, top: `${22 + (i % 3) * 23}%` });
    if (tier > 1) for (let i = 0; i < tier - 1; i++) add('scene-enemy', { left: `${26 + i * 28}%`, top: `${31 + (i % 2) * 28}%` });
    if (tier > 1) add('scene-muzzle', { left: '58%', top: '43%' });
  } else if (game === 'chudopoly') {
    add('scene-runway');
    if (tier > 0) add('scene-mark');
    if (tier > 0) for (let i = 0; i < tier; i++) add('scene-card', { left: `${10 + i * 27}%`, top: `${22 + (i % 2) * 48}%`, transform: `rotate(${i % 2 ? 7 : -8}deg)` });
    if (tier > 1) for (let i = 0; i < tier + 1; i++) add('scene-light', { left: `${12 + i * 22}%`, top: `${18 + (i % 2) * 64}%` });
    if (tier >= 3) {
      add('scene-terminal'); add('scene-flight-board'); add('scene-card-tray');
      add('scene-deck-stack'); add('scene-discard-stack');
      add('scene-gateway gateway-left'); add('scene-gateway gateway-right');
      add('scene-route route-a'); add('scene-route route-b');
      add('scene-aircraft aircraft-a'); add('scene-aircraft aircraft-b');
      for (let i = 0; i < 9; i++) add('scene-runway-light', { left: `${12 + i * 9}%` });
    }
  } else if (game === 'polybranch-remediated') {
    add('scene-side left'); add('scene-side right');
    if (tier > 0) add('scene-gate');
    if (tier > 0) for (let i = 0; i < tier + 1; i++) add('scene-ring', { width: `${120 + i * 160}px`, height: `${48 + i * 26}px` });
    if (tier > 0) for (let i = 0; i < tier * 6; i++) add('scene-dust', { left: `${8 + (i * 19) % 84}%`, top: `${16 + (i * 31) % 72}%`, animationDelay: `${i * -.18}s` });
    if (tier > 1) for (let i = 0; i < tier; i++) add('scene-hazard', { left: `${20 + i * 27}%`, top: `${28 + (i % 2) * 34}%`, transform: `rotate(45deg) scale(${.7 + tier * .12})` });
    if (tier > 1) for (let i = 0; i < tier * 2; i++) add('scene-flame', { left: `${38 + (i * 9) % 24}%`, top: `${66 + (i % 3) * 5}%` });
  }
  document.body.appendChild(scene);
  if (game === 'polybranch-remediated') {
    const wrapper = document.getElementById('game-wrapper');
    if (wrapper) {
      const frame = document.createElement('div');
      frame.className = `poly-showcase-frame poly-frame-tier-${tier}`;
      frame.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 4; i++) {
        const marker = document.createElement('i');
        marker.className = `poly-frame-marker marker-${i}`;
        frame.appendChild(marker);
      }
      wrapper.appendChild(frame);
      if (tier >= 2) {
        const rail = document.createElement('div');
        rail.className = 'poly-side-rails';
        rail.setAttribute('aria-hidden', 'true');
        for (let i = 0; i < (tier === 3 ? 8 : 4); i++) {
          const lamp = document.createElement('i');
          lamp.className = 'poly-rail-lamp';
          lamp.style.setProperty('--lamp-i', i);
          rail.appendChild(lamp);
        }
        wrapper.appendChild(rail);
      }
    }
  }
  if (game === 'iron-breakout-fps' && tier >= 2) {
    const recoil = document.createElement('div');
    recoil.className = 'demo-fps-recoil';
    document.body.appendChild(recoil);
    const gameCanvas = document.querySelector('body > canvas');
    const viewport = () => ({
      width: document.documentElement.clientWidth || window.innerWidth || 1,
      height: document.documentElement.clientHeight || window.innerHeight || 1
    });
    const fire = (event) => {
      if (event.type === 'mousedown' && gameCanvas && event.target !== gameCanvas) return;
      const { width, height } = viewport();
      const canvasRect = gameCanvas && gameCanvas.getBoundingClientRect();
      const centerX = canvasRect ? canvasRect.left + canvasRect.width / 2 : width / 2;
      const centerY = canvasRect ? canvasRect.top + canvasRect.height / 2 : height / 2;
      // The game ray and crosshair are center-screen; muzzle feedback must use the same anchor.
      const x = centerX;
      const y = centerY;
      document.body.classList.remove('demo-fps-shake'); void document.body.offsetWidth; document.body.classList.add('demo-fps-shake');
      recoil.classList.remove('recoil'); void recoil.offsetWidth; recoil.classList.add('recoil');
      const flash = document.createElement('i');
      flash.className = 'demo-fps-flash'; flash.style.left = `${x - 110}px`; flash.style.top = `${y - 110}px`;
      recoil.appendChild(flash);
      const tracer = document.createElement('i');
      tracer.className = 'demo-fps-tracer'; tracer.style.left = `${centerX}px`; tracer.style.top = `${centerY}px`;
      tracer.style.width = `${Math.hypot(x - centerX, y - centerY)}px`;
      tracer.style.transform = `rotate(${Math.atan2(y - centerY, x - centerX)}rad)`;
      recoil.appendChild(tracer);
      setTimeout(() => { flash.remove(); tracer.remove(); }, 360);
    };
    document.addEventListener('mousedown', fire);
    document.addEventListener('keydown', (event) => { if (['1', '2', '3', 'q', 'e'].includes(event.key.toLowerCase())) fire(event); });
  }
  if (game === 'chudopoly' && tier >= 1) {
    const nameInput = document.getElementById('name-input');
    if (tier >= 3 && nameInput && !nameInput.value.trim()) nameInput.value = 'Demo Pilot';
    document.addEventListener('click', (event) => {
      const card = document.createElement('i');
      card.className = 'demo-card-burst';
      card.style.left = `${event.clientX - 40}px`; card.style.top = `${event.clientY - 56}px`;
      document.body.appendChild(card);
      const toast = document.createElement('i');
      toast.className = 'demo-card-toast';
      toast.textContent = tier >= 3 ? 'CARD PLAY RESOLVED  /  AIRCRAFT READY' : 'CARD PLAY  /  ACTION CONFIRMED';
      toast.style.left = `${Math.min(event.clientX + 18, innerWidth - 330)}px`;
      toast.style.top = `${Math.max(event.clientY - 34, 28)}px`;
      document.body.appendChild(toast);
      setTimeout(() => { card.remove(); toast.remove(); }, 1600);
    });
    if (tier >= 3) {
      document.addEventListener('click', (event) => {
        const pulse = document.createElement('i');
        pulse.className = 'demo-flight-pulse';
        pulse.style.left = `${event.clientX - 18}px`;
        pulse.style.top = `${event.clientY - 18}px`;
        document.body.appendChild(pulse);
        setTimeout(() => pulse.remove(), 900);
      });
    }
  }
  if (game === 'polybranch-remediated' && tier >= 2) {
    const wake = document.createElement('div');
    wake.className = 'demo-poly-wake';
    document.body.appendChild(wake);
    const burst = (x, y) => {
      for (let i = 0; i < 5 + tier * 2; i++) {
        const spark = document.createElement('i');
        spark.className = 'demo-poly-spark'; spark.style.left = `${x}px`; spark.style.top = `${y}px`;
        spark.style.setProperty('--dx', `${(Math.random() - .5) * 150}px`);
        spark.style.setProperty('--dy', `${40 + Math.random() * 120}px`);
        wake.appendChild(spark); setTimeout(() => spark.remove(), 820);
      }
    };
    let lastX = innerWidth * .5, lastY = innerHeight * .72;
    document.addEventListener('mousemove', (event) => { if (Math.hypot(event.clientX - lastX, event.clientY - lastY) > 28) { burst(lastX, lastY); lastX = event.clientX; lastY = event.clientY; } });
    setInterval(() => burst(innerWidth * .5, innerHeight * .72), tier === 3 ? 620 : 1000);
  }
}());
'''


def ignore(path: str, names: list[str]) -> set[str]:
    return {name for name in names if name in {'.git', 'node_modules', 'probe-evidence', 'logs', '__pycache__'}}


def build_one(game: str, index: int, source: Path) -> None:
    target = OUT / game / f'epoch-{index:03d}'
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target, ignore=ignore, symlinks=True)
    node_modules = source / 'node_modules'
    if node_modules.exists() and not (target / 'node_modules').exists():
        (target / 'node_modules').symlink_to(node_modules, target_is_directory=True)
    html = target / CASES[game]['entry']
    if game == 'iron-breakout-fps':
        patch_iron_runtime(target, index)
    asset_dir = html.parent
    text = html.read_text(encoding='utf-8')
    text = text.replace('<html', f'<html data-demo-tier="{index}" data-demo-game="{game}"', 1)
    text = text.replace('</head>', f'<link rel="stylesheet" href="/demo-visual-tier.css?v=showcase-v5-{index}"></head>', 1)
    text = text.replace('</body>', f'<script src="/demo-visual-tier.js?v=showcase-v5-{index}"></script></body>', 1)
    html.write_text(text, encoding='utf-8')
    (asset_dir / 'demo-visual-tier.css').write_text(VISUAL_CSS, encoding='utf-8')
    (asset_dir / 'demo-visual-tier.js').write_text(VISUAL_JS, encoding='utf-8')


def patch_iron_runtime(target: Path, tier: int) -> None:
    """Add real Three.js scene dressing to the FPS presentation copy."""
    # Apply the scene pass after main.js has built the initial map. The map
    # builders reset background, fog, and light values during startup.
    core = target / 'js/main.js'
    enemies = target / 'js/enemies.js'
    index = target / 'index.html'
    index_text = index.read_text(encoding='utf-8')
    index_text = index_text.replace(
        '<script src="js/main.js"></script>',
        f'<script src="js/main.js?v=iron-presentation-r4-tier-{tier}"></script>',
    )
    index.write_text(index_text, encoding='utf-8')
    if tier >= 3:
        palette_bg, palette_fog, ambient, exposure = '0x142636', '0x142636', 1.45, 2.25
        fog_near, fog_far, sun_intensity = 18, 135, 2.6
    elif tier >= 2:
        palette_bg, palette_fog, ambient, exposure = '0x172530', '0x172530', 1.2, 1.95
        fog_near, fog_far, sun_intensity = 16, 120, 2.2
    elif tier >= 1:
        palette_bg, palette_fog, ambient, exposure = '0x172027', '0x172027', 1.0, 1.75
        fog_near, fog_far, sun_intensity = 16, 110, 1.9
    else:
        palette_bg, palette_fog, ambient, exposure = '0x111820', '0x111820', .95, 1.58
        fog_near, fog_far, sun_intensity = 18, 105, 1.9
    core_text = core.read_text(encoding='utf-8')
    core_text += f'''

// Manual FPS presentation dressing. This file belongs only to visual-tiered demos.
(function () {{
  const tier = {tier};
  if (typeof THREE === "undefined" || typeof scene === "undefined") return;
  const oldPresentation = scene.getObjectByName("presentation-industrial-dressing");
  if (oldPresentation) scene.remove(oldPresentation);
  const dressing = new THREE.Group();
  dressing.name = "presentation-industrial-dressing";
  scene.add(dressing);
  const placeDressingAtSpawn = () => {{
    // The FPS spawn faces +Z. Keep the authored set in front of the player
    // for every map, whose spawn z coordinate is different.
    // The authored set is centered around local z=17. Move that center to
    // world z=40: between the first-map spawn at z=31 and its outer wall.
    // This keeps the structures in the player's +Z view and inside the map.
    dressing.position.z = 23;
  }};
  placeDressingAtSpawn();
  const palette = tier >= 3
    ? {{ bg: 0x142636, fog: 0x142636, ambient: 1.45, exposure: 2.25, cyan: 0x39e6ff, amber: 0xffa23a }}
    : tier >= 2
      ? {{ bg: 0x172530, fog: 0x172530, ambient: 1.2, exposure: 1.95, cyan: 0x42cbe0, amber: 0xffa34b }}
      : tier >= 1
        ? {{ bg: 0x172027, fog: 0x172027, ambient: 1.0, exposure: 1.75, cyan: 0x4ba6b8, amber: 0xe59448 }}
        : {{ bg: 0x111820, fog: 0x111820, ambient: .95, exposure: 1.58, cyan: 0x5c7f88, amber: 0xb47743 }};
  scene.background = new THREE.Color(palette.bg);
  if (scene.fog) {{
    scene.fog.color.setHex(palette.fog);
    scene.fog.near = tier >= 3 ? 10 : 16;
    scene.fog.far = tier >= 3 ? 145 : 110;
  }}
  hemisphere.intensity = Math.max(hemisphere.intensity, palette.ambient);
  sun.intensity = Math.max(sun.intensity, tier >= 3 ? 2.6 : 1.9);
  renderer.toneMappingExposure = palette.exposure;

  const metal = new THREE.MeshStandardMaterial({{ color: 0x66808a, emissive: 0x233b46, emissiveIntensity: .7, roughness: .28, metalness: .78 }});
  const darkMetal = new THREE.MeshStandardMaterial({{ color: 0x263c46, emissive: 0x102b37, emissiveIntensity: .9, roughness: .38, metalness: .72 }});
  const floorMetal = new THREE.MeshStandardMaterial({{ color: 0x52636a, emissive: 0x172c34, emissiveIntensity: .45, roughness: .62, metalness: .48 }});
  const wallMetal = new THREE.MeshStandardMaterial({{ color: 0x3b4f58, emissive: 0x162d36, emissiveIntensity: .65, roughness: .5, metalness: .62 }});
  const crateMetal = new THREE.MeshStandardMaterial({{ color: 0x8a5a36, emissive: 0x2f1b0e, emissiveIntensity: .55, roughness: .72, metalness: .28 }});
  const cyan = new THREE.MeshBasicMaterial({{ color: palette.cyan }});
  const amber = new THREE.MeshBasicMaterial({{ color: palette.amber }});
  const emissive = new THREE.MeshStandardMaterial({{ color: 0x253741, emissive: palette.cyan, emissiveIntensity: tier >= 3 ? 2.5 : tier >= 2 ? 1.4 : .55, roughness: .3, metalness: .6 }});
  const box = (w, h, d, material, x, y, z) => {{
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; dressing.add(mesh); return mesh;
  }};
  const beam = (x, y, z, length, color, horizontal = true) => {{
    const mesh = box(horizontal ? length : .12, .12, horizontal ? .12 : length, color, x, y, z);
    return mesh;
  }};
  const lamp = (x, y, z, color, intensity, distance) => {{
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(.18, 12, 8), color);
    bulb.position.set(x, y, z); dressing.add(bulb);
    const light = new THREE.PointLight(color.color, intensity, distance, 2);
    light.position.set(x, y, z);
    light.castShadow = tier >= 3;
    light.shadow.mapSize.set(512, 512);
    light.shadow.bias = -0.002;
    dressing.add(light);
  }};
  const pipe = (x, y, z, length, radius, material, horizontal = false) => {{
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, length, 14),
      material
    );
    mesh.position.set(x, y, z);
    if (horizontal) mesh.rotation.x = Math.PI / 2;
    mesh.castShadow = true; mesh.receiveShadow = true; dressing.add(mesh);
    return mesh;
  }};
  const spotlight = (x, y, z, color, targetX, targetY, targetZ, intensity) => {{
    const light = new THREE.SpotLight(color, intensity, 34, Math.PI / 5, .48, 1.4);
    light.position.set(x, y, z);
    light.target.position.set(targetX, targetY, targetZ);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.bias = -0.003;
    dressing.add(light); dressing.add(light.target);
  }};

  // Keep the dressing close to the default spawn (z=29, looking toward -z)
  // so the visual change is visible on the first combat frame.
  if (tier >= 1 && tier < 3) {{
    for (const x of [-7.5, 7.5]) {{
      box(2.8, 5.8, 2.4, darkMetal, x, 2.9, 17);
      box(3.3, .22, 2.9, emissive, x, 5.9, 17);
      for (let y = 1.1; y < 5.4; y += 1.1) beam(x, y, 15.72, 1.9, cyan);
    }}
    beam(0, 7.2, 17, 20, metal);
    for (const x of [-8, -4, 0, 4, 8]) lamp(x, 6.9, 16.2, x % 8 ? cyan : amber, tier >= 3 ? 8 : 4.5, 16);
    beam(-4.2, .08, 21, 13, cyan, false);
    beam(4.2, .08, 21, 13, amber, false);
  }}
  if (tier >= 2 && tier < 3) {{
    for (const x of [-13, 13]) {{
      box(3.2, 8.5, 3.2, metal, x, 4.25, 4);
      box(3.8, .16, 3.8, emissive, x, 8.65, 4);
      for (let y = 1.2; y < 8; y += 1.35) beam(x, y, 2.28, 2.6, amber);
    }}
    for (const z of [13, 8, 3, -2]) {{
      beam(0, .1, z, 21, z % 10 ? amber : cyan);
      beam(0, 3.4, z, 21, darkMetal);
    }}
    lamp(-10, 4.6, 8, amber, 12, 23);
    lamp(10, 4.6, 8, cyan, 12, 23);
  }}
  if (tier >= 3) {{
    // Keep the original map readable. Tier 3 adds only a few side props and
    // distant lights; the playable map remains the dominant geometry.
    for (const x of [-22, 22]) {{
      box(3.2, 5.5, 3.2, darkMetal, x, 2.75, 4);
      box(3.6, .18, 3.6, emissive, x, 5.65, 4);
      pipe(x, 4.8, 10, 9, .28, metal, true);
    }}
    for (const x of [-18, 18]) {{
      box(4.2, 2.1, 4.2, crateMetal, x, 1.05, 12);
    }}
    for (const x of [-13, 13]) {{
      box(.8, 6.5, .8, metal, x, 3.25, -4);
    }}
    beam(0, 6.4, -4, 26, metal);
    beam(0, 5.9, -4, 24, emissive);
    const rim = new THREE.DirectionalLight(palette.cyan, 1.7);
    rim.position.set(-22, 18, 18); dressing.add(rim);
    rim.castShadow = true;
    rim.shadow.mapSize.set(1024, 1024);
    const warm = new THREE.DirectionalLight(palette.amber, 1.35);
    warm.position.set(25, 10, 4); dressing.add(warm);
    warm.castShadow = true;
    warm.shadow.mapSize.set(1024, 1024);
    for (const x of [-16, -8, 8, 16]) lamp(x, 5.2, 12, x < 0 ? cyan : amber, 14, 28);
    spotlight(-11, 9, 19, palette.cyan, 0, 1, 9, 34);
    spotlight(11, 8, 18, palette.amber, 0, 1, 7, 32);
    spotlight(0, 11, 4, 0xffe0a2, 0, 0, 14, 28);
    scene.fog.near = 18; scene.fog.far = 135;
  }}
}}());

'''
    core.write_text(core_text, encoding='utf-8')

    enemy_text = enemies.read_text(encoding='utf-8')
    enemy_text += f'''

// Manual enemy readability pass for the FPS presentation copy.
(function () {{
  const tier = {tier};
  if (typeof enemyBodyMaterial === "undefined") return;
  enemyBodyMaterial.color.setHex(tier >= 3 ? 0x9f2634 : tier >= 2 ? 0x762b35 : 0x4c3038);
  enemyBodyMaterial.emissive.setHex(tier >= 2 ? 0x3c0d16 : 0x12090d);
  enemyBodyMaterial.emissiveIntensity = tier >= 3 ? 1.6 : tier >= 2 ? .8 : .15;
  enemyLimbMaterial.color.setHex(tier >= 3 ? 0x435a67 : 0x303e47);
  enemySkinMaterial.color.setHex(tier >= 3 ? 0xffb07c : 0xb87962);
}}());
'''
    enemies.write_text(enemy_text, encoding='utf-8')


def write_launchers() -> None:
    lines = [
        '# Visual-tiered presentation demos',
        '',
        'These are manually art-directed presentation copies, separate from official epoch artifacts.',
        'Each game has four runnable visual tiers: `epoch-000` through `epoch-003`.',
        '',
    ]
    ports = {'iron-breakout-fps': 9360, 'canvas-vampire-survivors': 9370, 'chudopoly': 9380, 'polybranch-remediated': 9390}
    for game, spec in CASES.items():
        lines += [f'## {game}', '']
        all_script = OUT / game / 'run-all.sh'
        all_lines = [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            'kill_port() {',
            '  local port="$1" pids',
            '  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"',
            '  if [[ -n "$pids" ]]; then',
            '    echo "Stopping old listener(s) on port $port: $pids"',
            '    kill $pids 2>/dev/null || true',
            '    sleep 0.3',
            '    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"',
            '    [[ -z "$pids" ]] || kill -9 $pids 2>/dev/null || true',
            '  fi',
            '}',
            'PIDS=()',
            'cleanup() { for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done; }',
            "trap cleanup EXIT INT TERM",
            '',
        ]
        for index in range(4):
            target = OUT / game / f'epoch-{index:03d}'
            script = target / 'run.sh'
            if game == 'chudopoly':
                body = f"""#!/usr/bin/env bash
set -euo pipefail
kill_port() {{
  local port="$1" pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Stopping old listener(s) on port $port: $pids"
    kill $pids 2>/dev/null || true
    sleep 0.3
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [[ -z "$pids" ]] || kill -9 $pids 2>/dev/null || true
  fi
}}
cd {target!s}
kill_port {ports[game] + index}
PORT={ports[game] + index} node --no-warnings server.js &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM
sleep 0.8
open "http://127.0.0.1:{ports[game] + index}/" 2>/dev/null || true
wait "$SERVER_PID"
"""
            else:
                body = f"""#!/usr/bin/env bash
set -euo pipefail
kill_port() {{
  local port="$1" pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Stopping old listener(s) on port $port: $pids"
    kill $pids 2>/dev/null || true
    sleep 0.3
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [[ -z "$pids" ]] || kill -9 $pids 2>/dev/null || true
  fi
}}
cd {target!s}
PORT={ports[game] + index}
kill_port "$PORT"
python3 -m http.server "$PORT" --bind 127.0.0.1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM
sleep 0.5
open "http://127.0.0.1:{ports[game] + index}/{spec["entry"]}" 2>/dev/null || true
wait "$SERVER_PID"
"""
            script.write_text(body, encoding='utf-8')
            script.chmod(0o755)
            lines.append(f'- Tier {index + 1}: `{script}`')
            port = ports[game] + index
            all_lines += [f'kill_port {port}']
            if game == 'chudopoly':
                all_lines += [f'(cd {target!s} && PORT={port} node --no-warnings server.js) &', 'PIDS+=("$!")']
            else:
                all_lines += [f'(cd {target!s} && python3 -m http.server {port} --bind 127.0.0.1) &', 'PIDS+=("$!")']
            url_path = '/' if game == 'chudopoly' else f'/{spec["entry"]}'
            all_lines += [f'open "http://127.0.0.1:{port}{url_path}" 2>/dev/null || true']
        all_lines += ['', 'echo "All four visual tiers are running. Press Ctrl-C to stop them."', 'wait']
        all_script.write_text('\n'.join(all_lines) + '\n', encoding='utf-8')
        all_script.chmod(0o755)
        lines.append(f'- All four tiers: `{all_script}`')
        lines.append('')
    (OUT / 'README.md').write_text('\n'.join(lines), encoding='utf-8')


def main() -> None:
    for stale in (OUT / 'canvas-vampire-survivors',):
        if stale.exists():
            shutil.rmtree(stale)
    for game, spec in CASES.items():
        for index, source in enumerate(spec['source']):
            if not source.exists():
                raise FileNotFoundError(source)
            build_one(game, index, source)
    write_launchers()
    print(f'Built {sum(len(s["source"]) for s in CASES.values())} visual-tiered demo artifacts under {OUT}')


if __name__ == '__main__':
    main()
