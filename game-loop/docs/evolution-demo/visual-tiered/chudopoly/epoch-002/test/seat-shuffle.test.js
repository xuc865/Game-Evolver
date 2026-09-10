'use strict';
/**
 * test/seat-shuffle.test.js — createGame's opt-in seat shuffle (owner
 * directive 2026-08-07: turn order must not always be the same).
 *
 * The flag is OPT-IN because simulate.js seats personalities deliberately —
 * simbalance's first-player-advantage figure is a measurement of seat order —
 * and because a shuffle-by-default would have silently reordered every
 * existing test board.
 */
const test = require('node:test');
const assert = require('node:assert');
const G = require('../game.js');

const FOUR = () => [
  { id: 'a', name: 'A' }, { id: 'b', name: 'B' },
  { id: 'c', name: 'C' }, { id: 'd', name: 'D' },
];
const order = (state) => state.players.map((p) => p.id).join('');

test('default createGame preserves the given seat order', () => {
  for (const seed of ['x', 'y', 'z']) {
    assert.equal(order(G.createGame(FOUR(), { seed })), 'abcd');
  }
});

test('shuffleSeats is deterministic under a seed and seats everyone exactly once', () => {
  for (const seed of ['s1', 's2', 's3', 's4']) {
    const one = G.createGame(FOUR(), { seed, shuffleSeats: true });
    const two = G.createGame(FOUR(), { seed, shuffleSeats: true });
    assert.equal(order(one), order(two), `seed ${seed} not reproducible`);
    assert.equal(order(one).split('').sort().join(''), 'abcd', `seed ${seed} lost or duplicated a seat`);
    assert.notEqual(G.validateState(one).ok, false, `seed ${seed} produced an invalid state`);
  }
});

test('shuffleSeats actually shuffles: across seeds, order varies and every seat can lead', () => {
  const leaders = new Set();
  const orders = new Set();
  for (let i = 0; i < 40; i++) {
    const s = G.createGame(FOUR(), { seed: `vary-${i}`, shuffleSeats: true });
    leaders.add(s.players[0].id);
    orders.add(order(s));
  }
  // 40 seeded shuffles of 4 seats: a fixed or near-fixed order means the flag
  // is decorative. Every seat leading at least once is the owner's actual ask.
  assert.ok(orders.size >= 5, `only ${orders.size} distinct order(s) in 40 seeded games`);
  assert.equal(leaders.size, 4, `only [${[...leaders]}] ever led in 40 seeded games`);
});
