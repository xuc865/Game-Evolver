// core/rng.js — the ONLY sanctioned randomness in the client (checkClient bans
// Math.random in table/). Presentational determinism: a discard card's rotation
// must be the same on every machine and in every screenshot run, so it is a
// function of the card id, not of when the card happened to land.

export function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

export function sfc32(a, b, c, d) {
  return function () {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function makeRng(seed) {
  const h = xmur3(String(seed));
  const rand = sfc32(h(), h(), h(), h());
  for (let i = 0; i < 15; i++) rand();
  return rand;
}

const cache = new Map();

/**
 * Stable [0,1) for a (key, salt) pair. Cached because the discard pile asks for
 * the same card's rotation on every reconcile and a fresh sfc32 warm-up per
 * query showed up as 0.4ms per reconcile with 50 discard cards.
 */
export function stable01(key, salt = 0) {
  const k = `${key}#${salt}`;
  let v = cache.get(k);
  if (v === undefined) {
    v = makeRng(k)();
    cache.set(k, v);
  }
  return v;
}

/** Stable value in [-range, range] — the discard-pile rotation primitive. */
export function stableSpread(key, range, salt = 0) {
  return (stable01(key, salt) * 2 - 1) * range;
}
