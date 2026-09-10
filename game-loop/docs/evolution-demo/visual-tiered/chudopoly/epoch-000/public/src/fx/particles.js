// fx/particles.js — ONE pooled particle system for the whole game.
//
// Ported discipline (not code) from /Users/hunter/src/games/gatecrash/src/fx/
// particles.js and confetti.js:
//
//   • fixed capacity, preallocated at module load. A spawn on a full pool is
//     DROPPED, never queued. A queue turns a burst you cannot see into frames
//     you can feel.
//   • zero allocation in update() and draw(). Storage is a struct-of-arrays of
//     typed arrays; the spawn descriptor is one module-scope object (SP) so a
//     spawn call passes no object either. Every colour string a frame can need
//     is built once at ensureSprites().
//   • death is swap-with-last, so the live range stays dense at [0, n) and the
//     draw loop is a straight walk with no holes and no compaction pass.
//   • integration is a pure function of the dt handed down by core/clock (§0.6),
//     so a paused/backgrounded tab freezes the effect instead of teleporting it.
//
// CAPACITY. 600. A win throws 380 confetti; the largest non-win beat measured
// on the seeded playtest (a 5-card payment landing while a set completed) was
// 26 live. 600 leaves the win moment 220 spare for whatever lands on top of it.

import { TAU } from '../core/math.js';
import * as overlay from './overlay.js';

export const CAP = 600;

/* ── sprite vocabulary ──────────────────────────────────────────────────── */

export const KIND = Object.freeze({ DOT: 0, GLINT: 1, PUFF: 2, RING: 3, CONFETTI: 4 });

/** Palette indices. Colours are §6 tokens — gold is foil, steel is chrome. */
export const COL = Object.freeze({
  GOLD: 0, GOLD_HI: 1, STEEL: 2, WHITE: 3, RED: 4, GRAY: 5, GREEN: 6,
});

const HEX = ['#e8b955', '#ffeab4', '#aec4e2', '#eef3fb', '#ff6b58', '#7f8ea6', '#45d78a'];
const RGB = [
  [232, 185, 85], [255, 234, 180], [174, 196, 226],
  [238, 243, 251], [255, 107, 88], [127, 142, 166], [69, 215, 138],
];

// Confetti darkening ramp. The grazing phase of a tumble has to go DARK or the
// piece reads as a glowing chip instead of paper: gatecrash lights its confetti
// with |N·L| in the shader and mixes 0.34→1.35. There is no lighting here, so
// the same curve is baked into 8 pre-built strings per colour and indexed by
// the tumble angle. 8 steps: at 6px tall the banding is sub-pixel.
const SHADE_STEPS = 8;
const SHADE_MIN = 0.34;
const SHADE_MAX = 1.18;
const SHADE = [];

let sprites = null;       // [kind][colour] → offscreen canvas, built once

function tintCanvas(px, draw) {
  const c = document.createElement('canvas');
  c.width = px; c.height = px;
  const g = c.getContext('2d');
  g.translate(px / 2, px / 2);
  draw(g, px / 2);
  return c;
}

function stopsOf(grad, list, r, gb, b) {
  for (let i = 0; i < list.length; i++) {
    grad.addColorStop(list[i][0], `rgba(${r},${gb},${b},${list[i][1]})`);
  }
  return grad;
}

/**
 * Build every sprite in code (§0.3 — zero binary assets). 3 shapes × 7 colours
 * = 21 offscreen canvases, ≤64px each, ~180KB of backing store total, built on
 * the first effect and never rebuilt.
 */
function ensureSprites() {
  if (sprites) return;
  sprites = [[], [], []];
  for (let c = 0; c < RGB.length; c++) {
    const [r, g, b] = RGB[c];

    // DOT — spark/chip. A PLATEAU core, not a gaussian. Measured on the
    // 1280×720 capture: with the first shoulder at 0.16 the visible core of an
    // 8px dot was ~2px and the burst simply did not exist against the felt
    // grain. Holding full alpha out to 0.30 of the radius is the difference
    // between a spark and a smudge.
    sprites[KIND.DOT][c] = tintCanvas(32, (x, rad) => {
      x.fillStyle = stopsOf(x.createRadialGradient(0, 0, 0, 0, 0, rad * 0.98),
        [[0, 1], [0.30, 1], [0.52, 0.58], [0.80, 0.1], [1, 0]], r, g, b);
      x.fillRect(-rad, -rad, rad * 2, rad * 2);
    });

    // GLINT — the card-corner catch of light: a small core with two crossed
    // bars. Drawn rotated per particle so a set of glints does not read as a
    // grid of plus signs.
    sprites[KIND.GLINT][c] = tintCanvas(48, (x, rad) => {
      x.globalCompositeOperation = 'lighter';
      x.fillStyle = stopsOf(x.createRadialGradient(0, 0, 0, 0, 0, rad * 0.34),
        [[0, 1], [0.3, 0.85], [1, 0]], r, g, b);
      x.fillRect(-rad, -rad, rad * 2, rad * 2);
      // Bars at 0.20 of the radius, not 0.14: at the 26px draw size the thinner
      // bar was 1.8 device px on desktop and antialiased itself away.
      for (let axis = 0; axis < 2; axis++) {
        const lg = x.createLinearGradient(-rad, 0, rad, 0);
        stopsOf(lg, [[0, 0], [0.3, 0.2], [0.5, 1], [0.7, 0.2], [1, 0]], r, g, b);
        x.save();
        if (axis) x.rotate(Math.PI / 2);
        x.fillStyle = lg;
        x.fillRect(-rad, -rad * 0.1, rad * 2, rad * 0.2);
        x.restore();
      }
    });

    // PUFF — volume, not glow. Flat plateau so a dissipating puff reads as
    // smoke rather than as a big soft spark.
    sprites[KIND.PUFF][c] = tintCanvas(64, (x, rad) => {
      x.fillStyle = stopsOf(x.createRadialGradient(0, 0, 0, 0, 0, rad * 0.98),
        [[0, 0.82], [0.46, 0.76], [0.7, 0.38], [0.9, 0.06], [1, 0]], r, g, b);
      x.fillRect(-rad, -rad, rad * 2, rad * 2);
    });

    const ramp = new Array(SHADE_STEPS);
    for (let s = 0; s < SHADE_STEPS; s++) {
      const k = SHADE_MIN + (SHADE_MAX - SHADE_MIN) * (s / (SHADE_STEPS - 1));
      ramp[s] = `rgb(${Math.min(255, r * k) | 0},${Math.min(255, g * k) | 0},${Math.min(255, b * k) | 0})`;
    }
    SHADE[c] = ramp;
  }
}

/* ── storage ────────────────────────────────────────────────────────────── */

const px = new Float32Array(CAP);
const py = new Float32Array(CAP);
const vx = new Float32Array(CAP);
const vy = new Float32Array(CAP);
const life = new Float32Array(CAP);
const maxLife = new Float32Array(CAP);
const sz0 = new Float32Array(CAP);
const sz1 = new Float32Array(CAP);
const drag = new Float32Array(CAP);
const grav = new Float32Array(CAP);
const rot = new Float32Array(CAP);
const rotVel = new Float32Array(CAP);
const alpha0 = new Float32Array(CAP);
const tumble = new Float32Array(CAP);      // confetti: current tumble angle
const tumVel = new Float32Array(CAP);      // confetti: tumble rate
const flut = new Float32Array(CAP);        // confetti: sideways scull amplitude
const aspect = new Float32Array(CAP);      // confetti: h/w
const kind = new Uint8Array(CAP);
const colr = new Uint8Array(CAP);
const fade = new Uint8Array(CAP);          // alpha exponent: 1, 2 or 3
const lineW = new Float32Array(CAP);       // ring only: stroke width at birth

let n = 0;
let peak = 0;

export function count() { return n; }
export function peakCount() { return peak; }
export function full() { return n >= CAP; }
export function clear() { n = 0; }

/* ── spawn ──────────────────────────────────────────────────────────────── */

/** The one spawn descriptor. Fill it, call spawn(). No arguments, no objects. */
export const SP = {
  x: 0, y: 0, vx: 0, vy: 0, life: 0.4, size0: 3, size1: 1,
  drag: 3, grav: 0, rot: 0, rotVel: 0, alpha: 1, fade: 2,
  kind: KIND.DOT, col: COL.WHITE, tumble: 0, tumVel: 0, flutter: 0,
  aspect: 1.6, lineW: 2.5,
};

export function spDefaults() {
  SP.x = 0; SP.y = 0; SP.vx = 0; SP.vy = 0;
  SP.life = 0.4; SP.size0 = 3; SP.size1 = 1;
  SP.drag = 3; SP.grav = 0; SP.rot = 0; SP.rotVel = 0;
  SP.alpha = 1; SP.fade = 2; SP.kind = KIND.DOT; SP.col = COL.WHITE;
  SP.tumble = 0; SP.tumVel = 0; SP.flutter = 0; SP.aspect = 1.6; SP.lineW = 2.5;
}

/** @returns {boolean} false when the pool is saturated — the spawn is dropped. */
export function spawn() {
  if (n >= CAP) return false;
  ensureSprites();
  const i = n++;
  if (n > peak) peak = n;
  px[i] = SP.x; py[i] = SP.y; vx[i] = SP.vx; vy[i] = SP.vy;
  life[i] = 0;
  maxLife[i] = SP.life > 0.001 ? SP.life : 0.001;
  sz0[i] = SP.size0; sz1[i] = SP.size1;
  drag[i] = SP.drag; grav[i] = SP.grav;
  rot[i] = SP.rot; rotVel[i] = SP.rotVel;
  alpha0[i] = SP.alpha; fade[i] = SP.fade;
  kind[i] = SP.kind; colr[i] = SP.col;
  tumble[i] = SP.tumble; tumVel[i] = SP.tumVel;
  flut[i] = SP.flutter; aspect[i] = SP.aspect;
  lineW[i] = SP.lineW;
  return true;
}

function kill(i) {
  const last = --n;
  if (i === last) return;
  px[i] = px[last]; py[i] = py[last]; vx[i] = vx[last]; vy[i] = vy[last];
  life[i] = life[last]; maxLife[i] = maxLife[last];
  sz0[i] = sz0[last]; sz1[i] = sz1[last];
  drag[i] = drag[last]; grav[i] = grav[last];
  rot[i] = rot[last]; rotVel[i] = rotVel[last];
  alpha0[i] = alpha0[last]; fade[i] = fade[last];
  kind[i] = kind[last]; colr[i] = colr[last];
  tumble[i] = tumble[last]; tumVel[i] = tumVel[last];
  flut[i] = flut[last]; aspect[i] = aspect[last];
  lineW[i] = lineW[last];
}

/* ── integrate ──────────────────────────────────────────────────────────── */

let t = 0;

export function update(dt) {
  if (n === 0) return;
  t += dt;
  let i = 0;
  while (i < n) {
    const l = life[i] + dt;
    if (l >= maxLife[i]) { kill(i); continue; }
    life[i] = l;

    let f = 1 - drag[i] * dt;
    if (f < 0) f = 0;
    let ux = vx[i] * f;
    let uy = (vy[i] + grav[i] * dt) * f;

    if (kind[i] === KIND.CONFETTI) {
      // Flutter: paper sculls sideways because the falling face keeps stalling.
      // Driving it off the tumble angle rather than an independent sine ties
      // the sideways kick to the moment the piece is edge-on, which is what
      // makes a field of confetti look like paper instead of like snow.
      tumble[i] += tumVel[i] * dt;
      ux += Math.cos(tumble[i]) * flut[i] * dt;
    }
    vx[i] = ux; vy[i] = uy;
    px[i] += ux * dt; py[i] += uy * dt;
    rot[i] += rotVel[i] * dt;
    i++;
  }
}

/* ── draw ───────────────────────────────────────────────────────────────── */

/**
 * Two passes over the live range so `globalCompositeOperation` is set exactly
 * twice per frame instead of once per particle: opaque things (confetti, puffs)
 * under, additive things (sparks, glints, rings) over. Toggling the composite
 * op per particle cost 0.9ms/frame at 380 pieces on the DPR2 desktop capture.
 */
export function draw(g) {
  if (n === 0) return;
  const d = overlay.scale();

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  for (let i = 0; i < n; i++) {
    const k = kind[i];
    if (k !== KIND.CONFETTI && k !== KIND.PUFF) continue;
    const u = life[i] / maxLife[i];
    const a = alpha0[i] * fadeOf(1 - u, fade[i]);
    if (a <= 0.004) continue;
    g.globalAlpha = a > 1 ? 1 : a;

    if (k === KIND.PUFF) {
      const s = (sz0[i] + (sz1[i] - sz0[i]) * u) * d;
      g.drawImage(sprites[KIND.PUFF][colr[i]], px[i] * d - s / 2, py[i] * d - s / 2, s, s);
      continue;
    }

    // Confetti: a real rect, foreshortened by the tumble and shaded by it.
    const c = Math.cos(tumble[i]);
    const ac = c < 0 ? -c : c;
    const w = sz0[i] * d;
    const h = w * aspect[i] * (0.1 + 0.9 * ac);
    const sh = SHADE[colr[i]];
    // smoothstep on |cos| — the same curve gatecrash mixes with, so the piece
    // spends most of its tumble bright and snaps dark through the grazing pass.
    const smooth = ac * ac * (3 - 2 * ac);
    let si = (smooth * (SHADE_STEPS - 1) + 0.5) | 0;
    if (si > SHADE_STEPS - 1) si = SHADE_STEPS - 1;
    g.fillStyle = sh[si];
    const cs = Math.cos(rot[i]), sn = Math.sin(rot[i]);
    g.setTransform(cs, sn, -sn, cs, px[i] * d, py[i] * d);
    g.fillRect(-w / 2, -h / 2, w, h);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const k = kind[i];
    if (k === KIND.CONFETTI || k === KIND.PUFF) continue;
    const u = life[i] / maxLife[i];
    const a = alpha0[i] * fadeOf(1 - u, fade[i]);
    if (a <= 0.004) continue;
    g.globalAlpha = a > 1 ? 1 : a;

    if (k === KIND.RING) {
      // THE HARD EDGE. gatecrash learned this the expensive way: a shockwave
      // drawn as a soft radial smear carries ~0.1 alpha over a third of its
      // area and vanishes against any busy surface — here, navy felt with
      // grain. A STROKED annulus puts its contrast at the edge, which reads on
      // any background and matches the flat, hard-edged drawing language of
      // the cards.
      //
      // Two strokes, not one. First capture: a single 2.5px stroke fading as
      // (1-u)² was invisible past the halfway point of its travel. The band
      // (wide, 45% alpha) carries the energy and the filament (1.6px, full
      // alpha) carries the edge — additively they read as a bright wire inside
      // a glow, which is what a shockwave looks like and what a smear does not.
      const r = (sz0[i] + (sz1[i] - sz0[i]) * u) * d;
      if (r <= 0.5) continue;
      g.strokeStyle = HEX[colr[i]];
      g.globalAlpha = (a > 1 ? 1 : a) * 0.45;
      g.lineWidth = Math.max(1.5, lineW[i] * (1 - 0.35 * u)) * d;
      g.beginPath();
      g.arc(px[i] * d, py[i] * d, r, 0, TAU);
      g.stroke();
      g.globalAlpha = a > 1 ? 1 : a;
      g.lineWidth = 1.6 * d;
      g.beginPath();
      g.arc(px[i] * d, py[i] * d, r, 0, TAU);
      g.stroke();
      continue;
    }

    const s = (sz0[i] + (sz1[i] - sz0[i]) * u) * d;
    const sprite = sprites[k][colr[i]];
    if (k === KIND.GLINT && rot[i] !== 0) {
      const cs = Math.cos(rot[i]), sn = Math.sin(rot[i]);
      g.setTransform(cs, sn, -sn, cs, px[i] * d, py[i] * d);
      g.drawImage(sprite, -s / 2, -s / 2, s, s);
      g.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      g.drawImage(sprite, px[i] * d - s / 2, py[i] * d - s / 2, s, s);
    }
  }

  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

function fadeOf(k, p) {
  if (p === 1) return k;
  if (p === 2) return k * k;
  if (p === 3) return k * k * k;
  return Math.pow(k, p);
}

/* ── deterministic jitter ───────────────────────────────────────────────── */

// core/rng.js is the game's seeded RNG and belongs to state that must replay.
// Particle jitter must NOT consume from it (a spark would then change the deck),
// so fx keeps its own counter-driven hash. Same seed → same burst, and the
// harness screenshots reproduce.
let seedN = 0;
export function rnd() {
  seedN = (seedN + 1) | 0;
  let h = Math.imul(seedN, 374761393);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function rndRange(a, b) { return a + (b - a) * rnd(); }
export function resetJitter() { seedN = 0; }
