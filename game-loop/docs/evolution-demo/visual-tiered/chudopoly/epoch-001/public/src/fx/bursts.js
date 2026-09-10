// fx/bursts.js — the emitter vocabulary. Each function is one recognisable
// shape; fx/index.js decides WHICH shape a cue gets and HOW MUCH of it.
//
// Speeds are px/s in viewport space, sizes are CSS px, lives are seconds.
// Gravity is px/s² and is positive DOWN, because this is screen space and the
// table is a table — everything settles.

import { TAU } from '../core/math.js';
import { SP, spDefaults, spawn, KIND, COL, rnd, rndRange } from './particles.js';

/**
 * Spark dots thrown out of a point.
 * @param {number} x @param {number} y @param {number} count
 * @param {number} col palette index
 * @param {{speed?:number, life?:number, size?:number, grav?:number, spread?:number,
 *          dir?:number, drag?:number, alpha?:number}} [o]
 */
export function sparks(x, y, count, col, o = {}) {
  const speed = o.speed || 180;
  const life = o.life || 0.36;
  const size = o.size || 8;
  const grav = o.grav == null ? 340 : o.grav;
  const spread = o.spread == null ? TAU : o.spread;
  const dir = o.dir || 0;
  for (let i = 0; i < count; i++) {
    spDefaults();
    const a = dir + (spread >= TAU ? rnd() * TAU : (rnd() - 0.5) * spread);
    const v = speed * (0.55 + rnd() * 0.65);
    SP.kind = KIND.DOT; SP.col = col;
    SP.x = x + rndRange(-2, 2); SP.y = y + rndRange(-2, 2);
    SP.vx = Math.cos(a) * v; SP.vy = Math.sin(a) * v;
    SP.life = life * (0.75 + rnd() * 0.5);
    SP.size0 = size * (0.7 + rnd() * 0.6);
    SP.size1 = SP.size0 * 0.3;
    SP.grav = grav;
    SP.drag = o.drag == null ? 3.4 : o.drag;
    SP.alpha = o.alpha == null ? 1 : o.alpha;
    // 1.6, not 2: at fade² a spark is below 30% alpha at 45% of its life and a
    // burst that is supposed to read for 300ms reads for 120.
    SP.fade = 1.6;
    spawn();
  }
}

/**
 * The shockwave. One hard-edged stroked circle, r0 → r1 over `life`.
 * @param {number} lineW stroke at birth; particles.js thins it as it expands
 */
export function ring(x, y, r0, r1, col, life, lineW = 2.5, alpha = 0.95) {
  spDefaults();
  SP.kind = KIND.RING; SP.col = col;
  SP.x = x; SP.y = y;
  SP.size0 = r0; SP.size1 = r1;
  SP.life = life;
  SP.alpha = alpha;
  // 1.15, not 2: a squared fade puts a ring below 25% alpha at the halfway
  // point of a travel whose whole job is to reach the far radius visibly.
  SP.fade = 1.15;
  SP.lineW = lineW;
  SP.drag = 0;
  return spawn();
}

/** Card-corner catches of light — slow, small, rotating. */
export function glints(x, y, count, col, o = {}) {
  const spread = o.radius == null ? 22 : o.radius;
  for (let i = 0; i < count; i++) {
    spDefaults();
    const a = rnd() * TAU;
    const r = spread * Math.sqrt(rnd());
    SP.kind = KIND.GLINT; SP.col = col;
    SP.x = x + Math.cos(a) * r;
    SP.y = y + Math.sin(a) * r;
    SP.vx = Math.cos(a) * (o.speed || 26);
    SP.vy = Math.sin(a) * (o.speed || 26) - (o.rise || 18);
    SP.life = (o.life || 0.6) * (0.7 + rnd() * 0.6);
    SP.size0 = (o.size || 26) * (0.6 + rnd() * 0.7);
    SP.size1 = SP.size0 * 0.15;
    SP.rot = rnd() * TAU;
    SP.rotVel = rndRange(-2.2, 2.2);
    SP.drag = 2.4;
    SP.grav = 40;
    SP.fade = 2;
    SP.alpha = o.alpha == null ? 1 : o.alpha;
    spawn();
  }
}

/**
 * One stationary starburst at the epicentre. Measured: a ring plus scattered
 * glints reads as "something happened somewhere near here"; adding a single
 * flare at the exact point is what makes it read as "HERE".
 */
export function flare(x, y, size, col, life = 0.34, alpha = 1) {
  spDefaults();
  SP.kind = KIND.GLINT; SP.col = col;
  SP.x = x; SP.y = y;
  SP.life = life;
  SP.size0 = size; SP.size1 = size * 0.25;
  SP.rot = rnd() * TAU;
  SP.rotVel = 1.1;
  SP.drag = 0; SP.grav = 0;
  SP.alpha = alpha;
  SP.fade = 2;
  return spawn();
}

/** Dissipating volume — a play that went nowhere. */
export function puff(x, y, count, col, o = {}) {
  for (let i = 0; i < count; i++) {
    spDefaults();
    const a = rnd() * TAU;
    SP.kind = KIND.PUFF; SP.col = col;
    SP.x = x + rndRange(-8, 8); SP.y = y + rndRange(-6, 6);
    SP.vx = Math.cos(a) * rndRange(14, 48);
    SP.vy = Math.sin(a) * rndRange(10, 36) - (o.rise || 22);
    SP.life = (o.life || 0.5) * (0.75 + rnd() * 0.5);
    SP.size0 = o.size0 || 14;
    SP.size1 = o.size1 || 44;
    SP.drag = 3.2;
    SP.grav = o.grav == null ? -12 : o.grav;
    SP.alpha = o.alpha == null ? 0.26 : o.alpha;
    SP.fade = 2;
    spawn();
  }
}

/**
 * A metallic cross — two orthogonal fans. The OPSEC signature: two things met
 * at right angles and neither of them bent.
 */
export function sparkCross(x, y, perArm, col, o = {}) {
  const base = o.rot == null ? Math.PI * 0.25 : o.rot;
  for (let arm = 0; arm < 4; arm++) {
    sparks(x, y, perArm, col, {
      speed: o.speed || 340, life: o.life || 0.34, size: o.size || 7.5,
      alpha: o.alpha == null ? 1 : o.alpha,
      grav: 180, drag: 6.5, spread: 0.42, dir: base + arm * (Math.PI / 2),
    });
  }
}

/** Chips scattered along a path — a payment caravan that actually cost something. */
export function chipTrail(x0, y0, x1, y1, count, col) {
  for (let i = 0; i < count; i++) {
    const u = (i + rnd() * 0.6) / count;
    spDefaults();
    SP.kind = KIND.DOT; SP.col = col;
    SP.x = x0 + (x1 - x0) * u + rndRange(-9, 9);
    SP.y = y0 + (y1 - y0) * u + rndRange(-9, 9);
    SP.vx = rndRange(-34, 34);
    SP.vy = rndRange(-70, -18);
    SP.life = 0.42 + rnd() * 0.2;
    SP.size0 = 9 * (0.7 + rnd() * 0.6);
    SP.size1 = SP.size0 * 0.3;
    SP.grav = 420;
    SP.drag = 2.2;
    SP.fade = 2;
    spawn();
  }
}

/**
 * The win cannon. Paper, not gravel: heavy drag, low gravity, a per-piece
 * tumble that drives a per-piece sideways scull (see particles.update).
 * Fired from the top edge across the full width — a cone from one point reads
 * as a firework, and this beat is a ceremony, not an explosion.
 */
const CONFETTI_COLS = [COL.GOLD, COL.GOLD_HI, COL.STEEL, COL.WHITE, COL.GOLD, COL.GREEN];

export function confetti(w, h, count, o = {}) {
  const spread = o.spread == null ? 0.86 : o.spread;   // fraction of width used
  const x0 = w * (0.5 - spread / 2);
  for (let i = 0; i < count; i++) {
    spDefaults();
    SP.kind = KIND.CONFETTI;
    SP.col = o.col == null ? CONFETTI_COLS[(rnd() * CONFETTI_COLS.length) | 0] : o.col;
    SP.x = x0 + rnd() * w * spread;
    // Staggered above the fold so the field arrives as a fall, not a curtain.
    //
    // 1.35 screen-heights was arithmetic against a speed the pieces never
    // reach: grav 210 / drag 0.85 gives a TERMINAL velocity of 247px/s, not the
    // 300 the old comment assumed, so the top of the stagger needed
    // 1.35×720/247 = 3.9s to enter frame against a life of 2.3–3.7s. Measured
    // on the win captures: 24–35% of the field expired above the fold and the
    // celebration was a third emptier than the count says.
    //
    // 0.5 screen-heights = 1.46s of arrival spread, inside the SHORTEST life
    // (3.2 × 0.72 = 2.3s) with 0.8s of visible fall left over. Re-measured by
    // integrating this exact update loop over the spawn ranges at 720px:
    //   headroom 1.35 → 23.8% of a 3.2s field and 37.5% of a 2.6s field die
    //                   above the fold
    //   headroom 0.50 → 0.0% and 0.0%
    SP.y = -rnd() * h * 0.5 - 12;
    SP.vx = rndRange(-70, 70);
    SP.vy = rndRange(190, 330);
    SP.life = (o.life || 3.2) * (0.72 + rnd() * 0.45);
    SP.size0 = rndRange(4.5, 8.5);
    SP.size1 = SP.size0;
    SP.aspect = rndRange(1.15, 2.0);
    SP.grav = 210;
    SP.drag = 0.85;
    SP.rot = rnd() * TAU;
    SP.rotVel = rndRange(-3.4, 3.4);
    SP.tumble = rnd() * TAU;
    SP.tumVel = rndRange(4.5, 11);
    SP.flutter = rndRange(120, 320);
    SP.alpha = 1;
    SP.fade = 3;                                     // ~opaque until the last 18%
    if (!spawn()) return i;                          // pool full: drop the rest
  }
  return count;
}

/** The stalemate: nothing won, the dust just settles. */
export function settle(w, h, count) {
  for (let i = 0; i < count; i++) {
    spDefaults();
    SP.kind = KIND.PUFF; SP.col = COL.GRAY;
    SP.x = rnd() * w;
    SP.y = h * rndRange(0.12, 0.62);
    SP.vx = rndRange(-10, 10);
    SP.vy = rndRange(6, 26);
    SP.life = rndRange(1.0, 1.8);
    SP.size0 = rndRange(10, 26);
    SP.size1 = SP.size0 * 1.7;
    SP.drag = 1.4;
    SP.grav = 8;
    SP.alpha = 0.14;
    SP.fade = 2;
    if (!spawn()) return i;
  }
  return count;
}
