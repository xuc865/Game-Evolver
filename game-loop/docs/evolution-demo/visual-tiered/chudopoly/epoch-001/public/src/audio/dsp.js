// audio/dsp.js — pure DSP helpers. Owner: audio/ (§1).
//
// NOTHING in this file constructs an AudioContext, reads `window`, or has a
// module-level side effect. That is structural, not stylistic: engine.js is
// imported by main.js at boot — long before the page has a user gesture — and a
// module that builds a context on import is exactly how an autoplay violation
// ships (§7, §10 "No AudioContext before gesture").
//
// Every sound in the game is made from these primitives. There are no sample
// files and there can be none (§0.3, enforced by tools/checkAssets.mjs), so a
// card landing on felt is a bandpassed noise burst with a 4ms attack and a
// klaxon is a filtered sawtooth with a gate on it.
//
// Ported from /Users/hunter/src/games/gatecrash/src/audio/dsp.js — same
// primitives, a much smaller room (see makeImpulseResponse).

export const TAU = Math.PI * 2;

/** MIDI note -> Hz (A4 = 69 = 440Hz). */
export function midi(n) { return 440 * Math.pow(2, (n - 69) / 12); }

/** Semitone offset -> frequency ratio. */
export function semis(n) { return Math.pow(2, n / 12); }

/** Decibels -> linear gain. */
export function dbToGain(db) { return Math.pow(10, db / 20); }

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/**
 * AudioParam exponential ramps are undefined at zero, so every "silence" value
 * in the bank is this epsilon instead. -100dB, and high enough never to denormal.
 */
export const EPS = 1e-5;

// ------------------------------------------------------------- the ladder
//
// The set-progress chime (§7: "distinct positive chime ladder for set progress,
// pentatonic, monotonic"). Degrees of C major pentatonic — C E G C' — so the
// four rungs are 523 / 659 / 784 / 1047 Hz.
//
// The gaps are wide on purpose. tools/audiotest.mjs ranks the rendered
// fundamentals with a naive DFT that scans 60–2000Hz in 5Hz steps; the smallest
// step here (784 -> 1047) is 263Hz, i.e. 52 of its bins, so "the ladder
// ascends" cannot fail on measurement noise — only on a real mistake.

export const LADDER_ROOT = 523.25;                       // C5
export const LADDER_DEGREES = Object.freeze([0, 4, 7, 12]);

/** Pentatonic degrees for arpeggios that are not the ladder. */
export const PENT = Object.freeze([0, 2, 4, 7, 9, 12, 14, 16, 19, 21]);

// ---------------------------------------------------------- noise buffers

/**
 * White noise, in place. Uniform rather than gaussian: for short bursts and
 * bandpassed beds the difference is inaudible and uniform costs one rng draw
 * per sample instead of three.
 */
export function fillWhite(data, rng) {
  for (let i = 0; i < data.length; i++) data[i] = rng() * 2 - 1;
  return data;
}

/**
 * Pink noise (-3dB/octave), in place. Paul Kellet's economy filter: three
 * one-poles summed. Pink is the right bed for paper and felt — white reads as
 * "hiss", pink reads as "a surface".
 */
export function fillPink(data, rng) {
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < data.length; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.28;
  }
  return data;
}

/** Brown noise (-6dB/octave), in place. The tension bed's low body. */
export function fillBrown(data, rng) {
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const w = rng() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    data[i] = last * 3.5;
  }
  return data;
}

export function fillNoise(data, rng, kind) {
  if (kind === 'pink') return fillPink(data, rng);
  if (kind === 'brown') return fillBrown(data, rng);
  return fillWhite(data, rng);
}

/**
 * @param {BaseAudioContext} ctx
 * @param {() => number} rng  seeded, from core/rng.js — Math.random is not the
 *   client's randomness (§0.7) and an offline render has to be reproducible.
 */
export function makeNoiseBuffer(ctx, rng, seconds, kind = 'white', channels = 1) {
  const n = Math.max(1, Math.floor(seconds * ctx.sampleRate));
  const buf = ctx.createBuffer(channels, n, ctx.sampleRate);
  for (let c = 0; c < channels; c++) fillNoise(buf.getChannelData(c), rng, kind);
  return buf;
}

/**
 * Procedural convolution reverb impulse: exponentially-decaying noise with a
 * short early-reflection cluster and a slightly different decay per channel, so
 * the tail is wide rather than mono-in-the-middle.
 *
 * §7 asks for a card table, not a hangar. Defaults are 0.55s / decay 4.6, which
 * is roughly a small room with soft furnishings: long enough that a chime has a
 * tail, short enough that a five-card payment does not smear into one wash.
 * (gatecrash used 1.5s / 3.4 for a stadium; that is the whole difference.)
 */
export function makeImpulseResponse(ctx, rng, seconds = 0.55, decay = 4.6) {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.floor(seconds * sr));
  const buf = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const dk = decay * (c === 0 ? 1 : 1.09);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      d[i] = (rng() * 2 - 1) * Math.pow(1 - t, dk);
    }
    // Early reflections inside 3–22ms: a table and two walls, not a cloud.
    for (let k = 0; k < 6; k++) {
      const idx = Math.floor((0.003 + rng() * 0.019) * sr);
      if (idx < n) d[idx] += (rng() * 2 - 1) * (0.45 - k * 0.06);
    }
    // 6ms fade-in so the IR does not add a click of its own.
    const fade = Math.min(n, Math.floor(sr * 0.006));
    for (let i = 0; i < fade; i++) d[i] *= i / fade;
  }
  return buf;
}

// ---------------------------------------------------------------- shaping

/**
 * Soft-clip curve for the master safety stage (§7: "no clipping as a graph
 * invariant").
 *
 * Identity below `knee`, tanh above it. The bound is the entire point: a
 * WaveShaper clamps its INPUT to [-1,1] before the table lookup, so whatever
 * the mix does, the output cannot exceed curve[last] = knee + (1-knee)*tanh(1)
 * ≈ 0.933 at knee 0.7 — that is -0.6 dBFS, and it is why "peak ≤ 0 dBFS" in
 * tools/audiotest.mjs is a property of the graph rather than of the gain
 * staging above it.
 *
 * `oversample` MUST stay 'none' at the call site: 2x/4x resampling filters ring,
 * and ringing overshoots the table maximum, which breaks the bound.
 */
export function softClipCurve(n = 2048, knee = 0.7) {
  const c = new Float32Array(n);
  const span = 1 - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + span * Math.tanh((a - knee) / span);
    c[i] = x < 0 ? -y : y;
  }
  return c;
}

/** Peak magnitude a `softClipCurve` can emit. */
export function softClipCeiling(knee = 0.7) { return knee + (1 - knee) * Math.tanh(1); }

// -------------------------------------------------------------- envelopes

/**
 * Percussive AD envelope on a gain param. Returns the time it finishes.
 * Always ends with an explicit setValueAtTime(0): an exponential ramp only
 * approaches its target, and a gain left at EPS forever is a node that never
 * sleeps.
 */
export function perc(param, t0, peak, attack, decay) {
  const p = Math.max(peak, EPS * 2);
  param.setValueAtTime(EPS, t0);
  param.exponentialRampToValueAtTime(p, t0 + attack);
  param.exponentialRampToValueAtTime(EPS, t0 + attack + decay);
  param.setValueAtTime(0, t0 + attack + decay);
  return t0 + attack + decay;
}

/** Linear attack / exponential release — softer than `perc`, for swells. */
export function swell(param, t0, peak, attack, hold, release) {
  const p = Math.max(peak, EPS * 2);
  param.setValueAtTime(EPS, t0);
  param.linearRampToValueAtTime(p, t0 + attack);
  param.setValueAtTime(p, t0 + attack + hold);
  param.exponentialRampToValueAtTime(EPS, t0 + attack + hold + release);
  param.setValueAtTime(0, t0 + attack + hold + release);
  return t0 + attack + hold + release;
}

/** Exponential glide between two positive values. */
export function glide(param, t0, from, to, dur) {
  param.setValueAtTime(Math.max(from, EPS), t0);
  param.exponentialRampToValueAtTime(Math.max(to, EPS), t0 + dur);
  return t0 + dur;
}

/** Three-point glide: from -> via -> to. For klaxons and sirens. */
export function glide3(param, t0, from, via, to, d1, d2) {
  param.setValueAtTime(Math.max(from, EPS), t0);
  param.exponentialRampToValueAtTime(Math.max(via, EPS), t0 + d1);
  param.exponentialRampToValueAtTime(Math.max(to, EPS), t0 + d1 + d2);
  return t0 + d1 + d2;
}
