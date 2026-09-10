// fx/floaters.js — pooled floating text: money deltas and the two labels that
// deserve a shout ("CHUD!", "OPSEC!").
//
// DOM, not canvas: this is real text at real sizes, it has to inherit the
// system font stack (§6 — no webfonts) and it has to stay crisp on a DPR3
// phone, which a 2× canvas does not. Twelve nodes, created on first use and
// never destroyed; a thirteenth simultaneous float recycles the oldest, which
// on the seeded playtest never happened (worst case measured: 3 live).
//
// KEEP-OUT. A "-9M" that lands on top of the bank counter it is describing is
// worse than no float at all, so every spawn is clamped into the band between
// the HUD's bottom edge and the hand dock's top edge, offset UPWARD from the
// beat by RISE so the number ends its life clear of the thing it came from.

import { clamp } from '../core/math.js';
import * as overlay from './overlay.js';

const POOL = 12;
const RISE = 46;          // px travelled over LIFE
// Two floats within this many px of each other on Y are stacked instead of
// overlapped. Measured on the win capture: a "+4M" and a "+7M" from two
// payments 40ms apart landed on the same pixel and read as one broken glyph.
// 44, not 30: at 1.5rem the glyphs are 24px tall and 30px of separation still
// let a rising float clip the one above it.
const STACK = 44;
const EDGE = 8;           // px kept between a float's glyphs and the viewport
const LIFE = 0.9;         // §7's 900ms
const TONE = {
  gold: '#ffeab4',
  red: '#ff9184',
  steel: '#dbe6f6',
  green: '#7ff0b0',
};

const nodes = [];
const live = [];          // records, dense
const free = [];

let reduced = false;
export function setReduced(on) { reduced = !!on; }

function build() {
  if (nodes.length) return;
  const host = overlay.floatEl();
  for (let i = 0; i < POOL; i++) {
    const node = document.createElement('div');
    node.className = 'fx-text';
    host.appendChild(node);
    nodes.push(node);
    free.push({ node, x: 0, y: 0, t: 0, dur: LIFE, rise: RISE, wt: -1, wa: -1 });
  }
}

/** Vertical band the text is allowed to occupy. One layout read per spawn. */
function band(out) {
  const h = overlay.height();
  const hud = document.getElementById('hud');
  const dock = document.getElementById('hand-dock');
  const top = hud ? hud.getBoundingClientRect().bottom + 14 : 12;
  const bottom = dock ? dock.getBoundingClientRect().top - 46 : h - 60;
  out[0] = top;
  out[1] = bottom > top + 24 ? bottom : top + 24;
  return out;
}

const _band = [0, 0];

/**
 * @param {string} text
 * @param {number} x viewport px — the beat
 * @param {number} y viewport px
 * @param {'gold'|'red'|'steel'|'green'} tone
 * @param {number} [scale] 1 = the default 1.5rem; labels use 1.35
 */
export function spawn(text, x, y, tone, scale = 1) {
  if (!text) return false;
  // The victory dialog is a full-screen modal that owns the moment. A "+7M"
  // from the last payment of the game landing across its results table is the
  // one place a money delta is pure noise.
  const win = document.getElementById('win-overlay');
  if (win && !win.hidden) return false;
  overlay.ensure();
  build();
  const rec = free.pop() || live.shift();
  if (!rec) return false;

  band(_band);
  const w = overlay.width();
  const rise = reduced ? 0 : RISE;
  // 62px was a guess at half the widest float, and it was wrong for the two
  // that are WORDS rather than numbers. MEASURED: "OPSEC!" is anchored on the
  // discard pile at x≈88, is centred with translateX(-50%), and at 1.35 scale
  // (2.02rem) measures ~124px — so its first glyph rendered at x = 88 − 62 =
  // 26px … minus the 62px the clamp thought was enough, i.e. off the left edge
  // of the viewport at the single most dramatic beat in the game.
  //
  // The half-width is now MEASURED off the node, not assumed. One layout read
  // per spawn, and a spawn is a beat (§0.8) — floaters peak at 3 live on the
  // seeded playtest. The text is written below, so the measurement is taken
  // there and the x is clamped after it.
  rec.x = clamp(x, 62, Math.max(64, w - 62));
  // Start low enough that the whole RISE stays inside the band.
  let ty = clamp(y - 10, _band[0] + rise, _band[1]);
  for (let guard = 0; guard < POOL; guard++) {
    let hit = false;
    for (let i = 0; i < live.length; i++) {
      const o = live[i];
      if (Math.abs(o.y - ty) < STACK && Math.abs(o.x - rec.x) < 120) { hit = true; break; }
    }
    if (!hit) break;
    ty -= STACK;
    if (ty < _band[0] + rise) { ty = _band[1]; break; }
  }
  rec.y = ty;
  rec.rise = rise;
  rec.dur = reduced ? 0.75 : LIFE;
  rec.t = 0;
  rec.wt = -1; rec.wa = -1;

  const node = rec.node;
  node.textContent = text;                         // text as text (§0.4)
  node.style.setProperty('color', TONE[tone] || TONE.steel);
  node.style.setProperty('font-size', scale === 1 ? '' : `${(1.5 * scale).toFixed(2)}rem`);
  // A scaled float is one of the two SHOUTS, and a shout lands on an opponent
  // board rather than on felt — see .fx-text.is-label in fx/overlay.js.
  node.classList.toggle('is-label', scale !== 1);
  // Now that the glyphs are in, clamp against what they actually measure. The
  // node is already positioned off-screen from its last life, so this reads a
  // width, never a position — and a float that has to move to stay on screen is
  // still a float that says the right thing in the right half of the table.
  const half = Math.ceil(node.offsetWidth / 2) + EDGE;
  if (half > 62) rec.x = clamp(rec.x, half, Math.max(half, w - half));
  live.push(rec);
  return true;
}

export function active() { return live.length > 0; }
export function count() { return live.length; }

export function tick(dt) {
  if (live.length === 0) return false;
  let i = 0;
  while (i < live.length) {
    const rec = live[i];
    rec.t += dt;
    const u = rec.t / rec.dur;
    if (u >= 1) {
      if (rec.wa !== 0) { rec.node.style.setProperty('opacity', '0'); rec.wa = 0; }
      live.splice(i, 1);
      free.push(rec);
      continue;
    }
    // Ease-out travel with a fade that holds for the first 45% — the number has
    // to be READ, and a linear fade over 900ms is legible for about 300ms of it.
    const e = 1 - (1 - u) * (1 - u) * (1 - u);
    const dy = Math.round(-rec.rise * e);
    const a = u < 0.1 ? Math.round((u / 0.1) * 100) / 100
      : u < 0.45 ? 1
        : Math.round((1 - (u - 0.45) / 0.55) ** 1.4 * 100) / 100;
    const ty = rec.y + dy;
    if (dy !== rec.wt) {
      rec.wt = dy;
      rec.node.style.setProperty('transform', `translate3d(${rec.x}px,${ty}px,0) translateX(-50%)`);
    }
    if (a !== rec.wa) { rec.wa = a; rec.node.style.setProperty('opacity', String(a)); }
    i++;
  }
  return live.length > 0;
}

export function reset() {
  while (live.length) {
    const rec = live.pop();
    rec.node.style.setProperty('opacity', '0');
    rec.wa = 0;
    free.push(rec);
  }
}
