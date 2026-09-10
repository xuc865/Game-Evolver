// fx/shake.js — trauma-model camera shake, and the screen flash plate.
//
// ── THE TRANSFORM SUBSTRATE (the decision, and why it is safe) ─────────────
//
// The shake is written as an inline `transform` on `#table` — the felt element
// only. Not the viewport, not `#screen-game`: the HUD, the prompt bar, the hand
// dock and the side panel (log + chat) are SIBLINGS of #table inside
// #screen-game, and shaking them makes a rent demand unreadable at the exact
// moment the player has to answer it.
//
// #table is safe to write because nothing else writes it. Verified on
// revamp/card-table:
//   • `grep -rn "transform" public/src --include=*.js` — every hit is either a
//     comment about the card transform contract, or a write of --fx/--fy/--fs/
//     --tilt/--flip on a `.card` node (anim/flight.js, interact/drag.js).
//     Nothing writes `style.transform` on any element at all.
//   • `grep -n "transform" public/style/table.css` — the only transform
//     declarations are `.card` (line 506, the §5 contract), `.pile-label`
//     (337) and `text-transform`. `.table` itself declares none.
//   • table/index.js touches #table exactly twice: layout.mount() and a
//     setClass('deck-empty'). Neither reads or writes transform.
//
// Two hazards a transform on an ancestor normally creates, and why neither
// bites here:
//
//   1. It becomes the containing block for `position:fixed` descendants. #table
//      has none — every fixed element in the client (.sheet, .win-overlay,
//      .toast, .emotes, and fx's own #fx-root) is a child of #app or <body>,
//      outside #table.
//   2. It creates a stacking context, which would trap .card.is-dragging
//      (z-index 60) inside #table. Avoided structurally: the property is
//      REMOVED entirely (not set to `none`) whenever trauma reaches 0, so at
//      rest the stacking tree is byte-identical to a build without fx/. The
//      only frames with a stacking context are frames the table is visibly
//      shaking on.
//
// FLIP is unaffected. table/moveCard measures → reparents → measures → launches
// inside ONE synchronous task, so both rects carry the same shake offset and the
// delta cancels exactly. (This is also why the shake is translate+rotate with
// no scale: a scale would NOT cancel, it would scale the delta.)
//
// Edge reveal: #table is `overflow:hidden` over `#screen-game { background:
// var(--void) }`. Translating it exposes at most 8px of --void (#04080f)
// beside --felt-edge (#040c18) — a 4-unit difference in one channel — which is
// why no overscan scale is needed to hide it. An overscan scale would also be
// the one thing that breaks the FLIP cancellation above: a translate delta
// cancels exactly, a scale delta does not.
//
// ── THE MODEL ─────────────────────────────────────────────────────────────
// trauma ∈ [0, CAP], decays linearly at DECAY/s, and the displacement is
// trauma² so a small trauma is genuinely small (the difference between "juice"
// and "nausea"). Three decorrelated value-noise channels — x, y, rotation —
// because a single channel reads as a slider being dragged.

import { hash1, clamp } from '../core/math.js';
import * as overlay from './overlay.js';

const DECAY = 1.5;        // trauma/s (gatecrash camera rig sheds 1.45/s)
// Cap 0.75, not 1.0. trauma² × MAX_X at the cap is 8.4px of translate and
// 0.62° of rotation. Measured against the 0.58em micro-labels on the property
// columns at 1280×720: 8px still reads frame-to-frame, and the cap is only
// reachable by stacking (a CHUD steal landing inside the same 300ms as a set
// completing). The single loudest event on its own is the win at 0.60 → 5.4px.
//
// The squared curve is what makes the small values honestly small: the 0.10
// that action_blocked adds is 0.15px, i.e. nothing, which is correct — it is
// there so that FOUR blocked actions in a row are felt and one is not.
const CAP = 0.75;
const MAX_X = 15;         // px at trauma 1
const MAX_Y = 11;
const MAX_R = 1.1;        // degrees at trauma 1
const FREQ = 26;          // Hz — below ~18 it reads as a wobble, above ~34 as noise

// PERCEPTUAL FLOOR (P7 round 1). tick() quantises the write to 0.1px, so a
// trauma whose peak displacement is under ~0.3px is three quantisation steps of
// nothing: it holds a transform and a stacking context on #table, runs the
// clock, and cannot be seen. Measured across ten shake triggers, SIX were under
// it — set_completed 0.22px/80ms, steal-not-victim 0.10px/53ms,
// approach_broken 0.10px/53ms, action_blocked 0.15px, win-not-mine 0.22px.
//
// sqrt(0.30/15) = 0.141. Anything below that is refused here rather than
// silently rendered as stillness, so "this shake does nothing" is a fact the
// call site has to deal with instead of a comment claiming it is deliberate.
const MIN_TRAUMA = 0.141;

let trauma = 0;
let clock = 0;
let el = null;
let written = false;
let wx = 0, wy = 0, wr = 0;
let reduced = false;

/** Smooth value noise in [0,1). Pure function of t — no allocation, no state. */
function noise1(t) {
  const i = Math.floor(t);
  const f = t - i;
  const s = f * f * (3 - 2 * f);
  const a = hash1(i);
  const b = hash1(i + 1);
  return a + (b - a) * s;
}

export function setReduced(on) {
  reduced = !!on;
  if (reduced) { trauma = 0; release(); }
}

/**
 * Add trauma. Values are the tuning table in fx/index.js.
 * Amounts below MIN_TRAUMA are refused unless something is ALREADY shaking —
 * stacking is the one case where a sub-floor contribution is honest (four
 * blocked actions inside a second really should build).
 */
export function add(amount) {
  if (reduced || !(amount > 0)) return false;
  if (amount < MIN_TRAUMA && trauma <= 0) return false;
  trauma = clamp(trauma + amount, 0, CAP);
  return true;
}
export function minTrauma() { return MIN_TRAUMA; }

export function active() { return trauma > 0.0005; }
export function level() { return trauma; }

function target() {
  if (el && el.isConnected) return el;
  el = document.getElementById('table');
  return el;
}

function release() {
  const node = target();
  if (node && written) {
    node.style.removeProperty('transform');
    node.style.removeProperty('will-change');
    written = false;
    wx = wy = wr = 0;
  }
}

export function tick(dt) {
  if (trauma <= 0) { release(); return false; }
  clock += dt;
  trauma -= DECAY * dt;
  if (trauma <= 0) { trauma = 0; release(); return false; }

  const node = target();
  if (!node) return true;

  const tr = trauma * trauma;
  const t = clock * FREQ;
  // +31.3 / +77.1 keep the three channels out of phase with each other; equal
  // seeds put x and y on the same line and the shake reads as a single diagonal.
  const x = Math.round((noise1(t) * 2 - 1) * tr * MAX_X * 10) / 10;
  const y = Math.round((noise1(t + 31.3) * 2 - 1) * tr * MAX_Y * 10) / 10;
  const r = Math.round((noise1(t + 77.1) * 2 - 1) * tr * MAX_R * 100) / 100;

  if (x !== wx || y !== wy || r !== wr) {
    wx = x; wy = y; wr = r;
    if (!written) { node.style.setProperty('will-change', 'transform'); written = true; }
    node.style.setProperty('transform', `translate3d(${x}px,${y}px,0) rotate(${r}deg)`);
  }
  return true;
}

/* ── flash plate ────────────────────────────────────────────────────────── */
//
// One full-viewport div on `mix-blend-mode: screen`, opacity spiked and decayed
// on the clock. Screen-blend rather than a plain overlay because a gold wash at
// 0.3 alpha over navy felt is a grey wash; screen keeps the felt's own value
// structure and only lifts it.

const TONE = {
  gold: 'radial-gradient(60% 46% at 50% 44%, rgba(255,234,180,.95) 0%, rgba(232,185,85,.55) 42%, rgba(232,185,85,0) 78%)',
  red: 'radial-gradient(66% 52% at 50% 46%, rgba(255,145,132,.9) 0%, rgba(208,52,44,.5) 40%, rgba(208,52,44,0) 76%)',
  steel: 'radial-gradient(60% 46% at 50% 46%, rgba(238,243,251,.7) 0%, rgba(143,160,186,.32) 44%, rgba(143,160,186,0) 78%)',
  amber: 'radial-gradient(78% 62% at 50% 46%, rgba(255,190,120,.75) 0%, rgba(208,110,40,.42) 38%, rgba(208,110,40,0) 74%)',
};

let peak = 0;
let flashT = 0;
let flashDur = 0;
let lastAlpha = -1;

/**
 * @param {number} strength peak opacity
 * @param {'gold'|'red'|'steel'|'amber'} tone
 * @param {number} dur seconds
 * @param {{x:number,y:number}|null} at optional focus — the gradient centres here
 */
export function flash(strength, tone, dur, at) {
  const plate = overlay.flashEl();
  if (!plate) return;
  const g = TONE[tone] || TONE.gold;
  if (at && overlay.width() > 0) {
    const cx = Math.round((at.x / overlay.width()) * 100);
    const cy = Math.round((at.y / overlay.height()) * 100);
    plate.style.setProperty('background', g.replace('at 50% 44%', `at ${cx}% ${cy}%`)
      .replace('at 50% 46%', `at ${cx}% ${cy}%`));
  } else {
    plate.style.setProperty('background', g);
  }
  // Under reduced motion the flash IS the cue (§0.9 collapses motion, not
  // signal), so it is kept — softened to 55% and stretched, which reads as a
  // light coming up rather than a hit.
  peak = Math.max(peak, reduced ? strength * 0.55 : strength);
  flashDur = Math.max(flashDur - flashT, reduced ? dur * 1.6 : dur);
  flashT = 0;
}

export function flashActive() { return flashDur > 0; }

export function tickFlash(dt) {
  if (flashDur <= 0) return false;
  const plate = overlay.flashEl();
  flashT += dt;
  const u = flashT / flashDur;
  if (u >= 1) {
    flashDur = 0; peak = 0; flashT = 0;
    if (plate && lastAlpha !== 0) { plate.style.setProperty('opacity', '0'); lastAlpha = 0; }
    return false;
  }
  // Attack in the first 8% then a squared release: an instant-on flash on a
  // 60Hz panel is one frame of white and reads as a dropped frame.
  const k = u < 0.08 ? u / 0.08 : (1 - (u - 0.08) / 0.92) ** 2;
  const a = Math.round(peak * k * 100) / 100;
  if (a !== lastAlpha && plate) { plate.style.setProperty('opacity', String(a)); lastAlpha = a; }
  return true;
}

export function reset() {
  trauma = 0;
  flashDur = 0; peak = 0; flashT = 0;
  release();
  const plate = overlay.flashEl();
  if (plate && lastAlpha !== 0) { plate.style.setProperty('opacity', '0'); lastAlpha = 0; }
}
