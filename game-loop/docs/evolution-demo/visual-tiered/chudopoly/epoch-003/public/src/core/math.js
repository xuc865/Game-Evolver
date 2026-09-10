// core/math.js — allocation-free math. Hot-path safe; no object returns.
// Ported from /Users/hunter/src/games/gatecrash/src/core/math.js.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function invLerp(a, b, v) { return b === a ? 0 : (v - a) / (b - a); }

export function smoothstep(a, b, v) {
  const t = clamp01(invLerp(a, b, v));
  return t * t * (3 - 2 * t);
}

/** Framerate-independent exponential approach. `lambda` ≈ how much closer per second. */
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/**
 * Critically-damped-ish spring step. Returns the new value and writes the new
 * velocity into out[0] — the caller owns the array, so no allocation per frame.
 */
export function spring(current, target, vel, stiffness, damping, dt, out) {
  const f = -stiffness * (current - target) - damping * vel;
  const v = vel + f * dt;
  out[0] = v;
  return current + v * dt;
}

export function easeOutBack(t, s = 1.70158) {
  const u = t - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
}

export function easeOutCubic(t) { const u = 1 - t; return 1 - u * u * u; }
export function easeInCubic(t) { return t * t * t; }

export function easeOutQuint(t) {
  const u = 1 - t;
  return 1 - u * u * u * u * u;
}

export function easeOutElastic(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const p = 0.35;
  return Math.pow(2, -10 * t) * Math.sin(((t - p / 4) * TAU) / p) + 1;
}

/** Deterministic 1D hash in [0,1). Pure function of n — not an RNG. */
export function hash1(n) {
  let h = Math.imul(n | 0, 374761393);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function round(v, d = 3) {
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}
