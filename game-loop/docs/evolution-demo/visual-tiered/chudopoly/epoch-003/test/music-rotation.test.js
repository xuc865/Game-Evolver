// The match-bed rotation, held in pure Node (audio/music.js's __rotation runs
// the REAL pickMatchTrack over a key list without touching live state).
//
// Why this exists next to tools/audiotest.mjs assertion 12: the browser gate
// runs 4000 keys per verify; this one runs 40,000 in ~100ms and is what the
// tolerance there was derived from. It also caught the gate's own key
// generator emitting 32 distinct codes while claiming 400 rooms — a picker
// gate is only as honest as the key population it feeds, so the population is
// asserted here too.
//
// Proven to fail: `r() * r()` in pickMatchTrack reads 41.2/34.6/18.5/5.8%
// against the 25±2% band below (the same mutation reads 40.5/34.6/18.9/5.9
// through audiotest assertion 12); a pool typo that drops match4 fails the
// reachability check; a removed no-repeat filter fails the repeat check
// (fair-coin repeats over 4 beds ≈ 25% of picks).

const test = require('node:test');
const assert = require('node:assert/strict');

let rotation;
let makeRng;

test.before(async () => {
  ({ __rotation: rotation } = await import('../public/src/audio/music.js'));
  ({ makeRng } = await import('../public/src/core/rng.js'));
});

const BEDS = ['match1', 'match2', 'match3', 'match4'];
const N = 40000;

/** Keys shaped like the live ones (`${roomCode}#${gamesSeen}`): random 4-char
 *  room codes, 1–4 consecutive games per room, seeded so the run is exact. */
function makeKeys(n) {
  const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = makeRng('music-rotation-test-keys');
  const keys = [];
  while (keys.length < n) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CH[Math.floor(r() * CH.length)];
    const games = 1 + Math.floor(r() * 4);
    for (let g = 0; g < games && keys.length < n; g++) keys.push(`${code}#${g}`);
  }
  return keys;
}

test('the key population is real before anything is measured over it', () => {
  const keys = makeKeys(N);
  const distinct = new Set(keys).size;
  // 1-in-32^4 collisions leave ~39.2k distinct in 40k; anything far below that
  // means the generator collapsed and every assertion after this is theatre.
  assert.ok(distinct > N * 0.9, `${distinct} distinct keys in ${N} — the generator collapsed`);
});

test('every bed is reachable and no pick repeats back to back', () => {
  const seq = rotation(makeKeys(N));
  assert.equal(seq.length, N);
  const seen = new Set(seq);
  for (const b of BEDS) assert.ok(seen.has(b), `${b} never chosen in ${N} rooms`);
  for (let i = 1; i < seq.length; i++) {
    assert.notEqual(seq[i], seq[i - 1], `back-to-back repeat of ${seq[i]} at #${i}`);
  }
});

test('long-run selection is uniform across the four beds', () => {
  const seq = rotation(makeKeys(N));
  const counts = Object.create(null);
  for (const k of seq) counts[k] = (counts[k] || 0) + 1;
  // Measured on the shipped picker: 24.82/25.07/25.09/25.01% (chi-square 0.77
  // against uniform, 3 dof). sd per share at N=40k is ~0.22 points, so ±2
  // points is ~9σ: this cannot flake, and the seeded keys cannot move.
  for (const b of BEDS) {
    const share = (counts[b] || 0) / seq.length;
    assert.ok(share > 0.23 && share < 0.27,
      `${b} holds ${(100 * share).toFixed(2)}% of ${N} rooms — outside 25±2%`);
  }
  const exp = seq.length / 4;
  let chi = 0;
  for (const b of BEDS) chi += ((counts[b] || 0) - exp) ** 2 / exp;
  assert.ok(chi < 16.27, `chi-square ${chi.toFixed(2)} vs uniform exceeds the 99.9% critical value`);
});

test('the pick is deterministic per key — same room, same bed, every client', () => {
  const keys = makeKeys(64);
  assert.deepEqual(rotation(keys), rotation(keys));
});
