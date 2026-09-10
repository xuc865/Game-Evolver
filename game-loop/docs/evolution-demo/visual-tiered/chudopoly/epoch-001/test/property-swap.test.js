// test/property-swap.test.js — §3.5's atomic two-card exchange, engine vs client.
//
// THE DEFECT, MEASURED. §3.5 caps a colour zone at `set size`. Nobody noticed
// what that implies until it was probed: a TRUE SWAP IS IMPOSSIBLE. Darkblue 2/2
// holding a green/darkblue wild, green 3/3 holding a rainbow — each card is legal
// in the other's zone, and moveProperty() refuses BOTH directions, because
// neither can transit through an overfull zone:
//
//   moveProperty(p1, rainbow,  'darkblue') → 'Command already holds a full set (2)'
//   moveProperty(p1, pairWild, 'green')    → 'Elite Programs already holds a full set (3)'
//
// Owner ruling 2026-08-07 (ARCHITECTURE §3.5): add the missing move rather than
// weaken the rule. Rejected — a transient overfull state (the invariant is worth
// having because it holds CONTINUOUSLY) and MD's second-set rule (a cross-cutting
// rewrite that reopens the armour exploit §3.5 exists to kill).
//
// This file pins six things, and every one of them is a measurement rather than a
// restatement of the implementation:
//   1. the blocker is real, and the new command is the only thing that clears it
//   2. atomic means atomic — an illegal half leaves the board byte-identical
//   3. the cost is TWO rearranges, and the budget is checked before anything else
//   4. the general rule COLLAPSES to wilds-only, probed over every fixed property
//   5. no zone count and no set completion ever changes, over a matrix
//   6. the client offers a subset of what the engine accepts, never a superset
//
// public/src/ is native ESM (§0.2 — no build step) and this suite is CommonJS, so
// the client modules load through a dynamic import(), the same way
// test/wild-rearrange.test.js does.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

const G = require('../game.js');
const { validateMessage } = require('../server/protocol.js');

const url = (p) => pathToFileURL(join(__dirname, '..', p)).href;
const loadStore = () => import(url('public/src/state/store.js'));
const loadSel = () => import(url('public/src/state/selectors.js'));

const COLOR_KEYS = Object.keys(G.COLORS);

/* ── fixtures ──────────────────────────────────────────────────────────── */

function fresh(seed = 'swap') {
  const state = G.createGame(
    [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }],
    { seed },
  );
  state.deck = G.buildDeck();
  state.discardPile = [];
  state.pendingAction = null;
  state.players.forEach(p => { p.hand = []; p.bank = []; p.properties = {}; p.upgrades = {}; });
  state.turnPhase = 'play';
  state.currentPlayerIndex = 0;
  state.playsRemaining = 3;
  state.cardTotal = null;
  state._handSnapshot = 0;
  return state;
}

function take(state, predicate) {
  const i = state.deck.findIndex(predicate);
  assert.notEqual(i, -1, 'expected card in deck');
  return state.deck.splice(i, 1)[0];
}

function putProperty(state, player, color) {
  const card = take(state, c => c.type === 'property' && c.color === color);
  (player.properties[color] ||= []).push({ ...card, placedColor: color });
  return card;
}

function putWild(state, player, color, pick) {
  const card = take(state, c => c.type === 'wild_property' && pick(c));
  (player.properties[color] ||= []).push({ ...card, placedColor: color });
  return card;
}

const anyWild = (c) => c.colors[0] === 'any';
const pairWild = (a, b) => (c) => c.colors[0] !== 'any'
  && c.colors.includes(a) && c.colors.includes(b);

/**
 * THE RULING'S OWN BOARD. Darkblue is size 2 and green is size 3, so both zones
 * are exactly full and each holds one wild that is legal in the other's colour.
 * @returns {{state, a, rainbow, pair}}
 */
function deadlocked(seed = 'swap') {
  const state = fresh(seed);
  const [a] = state.players;
  putProperty(state, a, 'darkblue');
  const pair = putWild(state, a, 'darkblue', pairWild('green', 'darkblue'));
  putProperty(state, a, 'green');
  putProperty(state, a, 'green');
  const rainbow = putWild(state, a, 'green', anyWild);
  return { state, a, rainbow, pair };
}

/** The resolved ruleset, on the state AND on every seat: game.js zoneIsSet()
 *  reads `rulesOf(player)`, which is `player._rules`, not `state.rules`. */
function setRules(state, opts) {
  const rules = G.resolveRules(opts);
  state.rules = rules;
  for (const p of state.players) p._rules = rules;
  return rules;
}

/** Zone counts as a plain object, for before/after comparison. */
const counts = (p) => Object.fromEntries(
  Object.entries(p.properties).map(([c, cards]) => [c, cards.length]));

const zoneIds = (p) => Object.fromEntries(
  Object.entries(p.properties).map(([c, cards]) => [c, cards.map(x => x.id).sort()]));

/* ── 1. the blocker is real, and the swap is what clears it ────────────── */

test('§3.5 deadlock: moveProperty refuses BOTH directions, swapProperties takes it', () => {
  const { state, a, rainbow, pair } = deadlocked();

  assert.deepEqual(counts(a), { darkblue: 2, green: 3 }, 'fixture: both zones exactly full');

  // Each direction probed on its own clone, so no probe can change the board for
  // the next one. This is the measurement the ruling was written from.
  const probeA = JSON.parse(JSON.stringify(state));
  const probeB = JSON.parse(JSON.stringify(state));
  assert.equal(G.moveProperty(probeA, 'p1', rainbow.id, 'darkblue').error,
    'Command already holds a full set (2)');
  assert.equal(G.moveProperty(probeB, 'p1', pair.id, 'green').error,
    'Elite Programs already holds a full set (3)');

  // And there is no third ordering. Each card CAN move (a rainbow can go to any
  // empty zone) — what it cannot do is reach the ONE zone this exchange is
  // about, in either direction, ever, from any starting order.
  for (const [card, target] of [[rainbow, 'darkblue'], [pair, 'green']]) {
    const clone = JSON.parse(JSON.stringify(state));
    assert.ok(G.moveProperty(clone, 'p1', card.id, target).error,
      `${card.name} → ${target} is refused, and it is the only move that would help`);
  }

  assert.deepEqual(G.validateState(state), { ok: true }, 'valid BEFORE');
  assert.deepEqual(G.swapProperties(state, 'p1', rainbow.id, pair.id), { ok: true });
  assert.deepEqual(G.validateState(state), { ok: true }, 'valid AFTER');

  assert.deepEqual(counts(a), { darkblue: 2, green: 3 }, 'no zone count moved');
  assert.ok(a.properties.darkblue.some(c => c.id === rainbow.id), 'the rainbow crossed');
  assert.ok(a.properties.green.some(c => c.id === pair.id), 'and so did the pair wild');
  assert.equal(a.properties.darkblue.find(c => c.id === rainbow.id).placedColor, 'darkblue',
    'placedColor follows the card, or receiveProperty re-homes it wrongly later');
  assert.equal(a.properties.green.find(c => c.id === pair.id).placedColor, 'green');
});

test('the swap works in either argument order, and is its own inverse', () => {
  for (const flip of [false, true]) {
    const { state, a, rainbow, pair } = deadlocked();
    const before = zoneIds(a);
    const args = flip ? [pair.id, rainbow.id] : [rainbow.id, pair.id];
    assert.deepEqual(G.swapProperties(state, 'p1', ...args), { ok: true },
      `argument order ${flip ? 'B,A' : 'A,B'}`);
    assert.notDeepEqual(zoneIds(a), before);
    // Twice is a no-op. The budget allows it (12 ≥ 4) and the board must return.
    assert.deepEqual(G.swapProperties(state, 'p1', ...args), { ok: true });
    assert.deepEqual(zoneIds(a), before, 'swapping back restores the board exactly');
  }
});

/* ── 2. atomic means atomic ────────────────────────────────────────────── */

test('an illegal half moves NOTHING — not the board, not the budget, not the log', () => {
  // Half A is legal ON ITS OWN: a rainbow in red may move to a darkblue that has
  // room. Half B is not: the green/darkblue wild may not go to red. So the only
  // thing standing between this board and a half-applied swap is the ordering of
  // the checks, which is the thing being measured.
  const state = fresh();
  const [a] = state.players;
  const pair = putWild(state, a, 'darkblue', pairWild('green', 'darkblue'));
  const rainbow = putWild(state, a, 'red', anyWild);

  const boardBefore = JSON.stringify(a.properties);
  const budgetBefore = state.rearrangesRemaining;
  const logBefore = state.log.length;
  const eventsBefore = state.events.length;

  // The rainbow may go to darkblue; the pair wild may NOT go to red.
  const res = G.swapProperties(state, 'p1', rainbow.id, pair.id);
  assert.match(res.error, /cannot go on/, 'the refusal names the half that failed');
  assert.equal(JSON.stringify(a.properties), boardBefore, 'board untouched');
  assert.equal(state.rearrangesRemaining, budgetBefore, 'a refused swap is free');
  assert.equal(state.log.length, logBefore, 'and silent');
  assert.equal(state.events.length, eventsBefore, 'and emits nothing');

  // Prove the fixture is non-trivial: half A really is legal on its own.
  const clone = JSON.parse(JSON.stringify(state));
  assert.deepEqual(G.moveProperty(clone, 'p1', rainbow.id, 'darkblue'), { ok: true },
    'fixture assumption: the OTHER half of that swap is a legal move by itself');
});

test('every refusal is checked before any mutation, over the whole refusal set', () => {
  const cases = [
    ['same card twice', (s, f) => [f.rainbow.id, f.rainbow.id], /Pick two different cards/],
    ['a card that is not mine', (s, f) => {
      // The deck holds exactly one green/darkblue wild and deadlocked() has it,
      // so the opponent gets the base/green one — also legal on green.
      const theirs = putWild(s, s.players[1], 'darkblue', pairWild('base', 'green'));
      return [f.rainbow.id, theirs.id];
    }, /not found in your properties/],
    ['a card that does not exist', (s, f) => [f.rainbow.id, 999], /not found in your properties/],
    ['two cards in the SAME zone', (s, f) => {
      // Swap the fixed Pentagon out for the second rainbow, so darkblue holds
      // two wilds and stays at its 2-card cap.
      const zone = s.players[0].properties.darkblue;
      const fixed = zone.find(c => c.type === 'property');
      zone.splice(zone.indexOf(fixed), 1);
      const second = putWild(s, s.players[0], 'darkblue', anyWild);
      return [f.pair.id, second.id];
    }, /already in the same set/],
    ['an Upgrade', (s, f) => {
      const up = take(s, c => c.type === 'action' && c.action === 'upgrade');
      (s.players[0].upgrades.darkblue ||= []).push(
        { ...up, upgradeType: 'house', placedColor: 'darkblue' });
      return [f.rainbow.id, up.id];
    }, /An Upgrade moves on its own/],
    ['not my turn', (s, f) => { s.currentPlayerIndex = 1; return [f.rainbow.id, f.pair.id]; },
      /Not your turn/],
    ['not the play phase', (s, f) => { s.turnPhase = 'action_response'; return [f.rainbow.id, f.pair.id]; },
      /Cannot rearrange now/],
    ['a finished game', (s, f) => { s.phase = 'finished'; return [f.rainbow.id, f.pair.id]; },
      /finished/],
    ['no budget at all', (s, f) => { s.rearrangesRemaining = 0; return [f.rainbow.id, f.pair.id]; },
      /No free rearranges left/],
    ['one rearrange left, and a swap costs two', (s, f) => {
      s.rearrangesRemaining = 1; return [f.rainbow.id, f.pair.id];
    }, /costs two free rearranges and you have one left/],
  ];

  for (const [name, arrange, re] of cases) {
    const fixture = deadlocked();
    const { state, a } = fixture;
    const args = arrange(state, fixture);
    const board = JSON.stringify(state.players.map(p => p.properties));
    const budget = state.rearrangesRemaining;
    const res = G.swapProperties(state, 'p1', ...args);
    assert.ok(res.error, `${name}: expected a refusal`);
    assert.match(res.error, re, name);
    assert.equal(JSON.stringify(state.players.map(p => p.properties)), board,
      `${name}: a refusal must not touch the board`);
    assert.equal(state.rearrangesRemaining, budget, `${name}: a refusal must not cost budget`);
    assert.deepEqual(G.validateState(state), { ok: true }, `${name}: state still valid`);
  }
  assert.equal(cases.length, 10, 'a gate that measured nothing must not pass (§8)');
});

/* ── 3. the cost is TWO ────────────────────────────────────────────────── */

test('a swap draws TWO from the same budget a move draws one from', () => {
  const { state, rainbow, pair } = deadlocked();
  assert.equal(G.SWAP_COST, 2);
  assert.equal(state.rearrangesRemaining, G.REARRANGE_BUDGET);

  assert.deepEqual(G.swapProperties(state, 'p1', rainbow.id, pair.id), { ok: true });
  assert.equal(state.rearrangesRemaining, G.REARRANGE_BUDGET - G.SWAP_COST);

  // §3.8 still holds: it is a REARRANGE, not a play.
  assert.equal(state.playsRemaining, 3, 'a swap costs no play');
  assert.equal(G.currentPlayer(state).id, 'p1', 'and does not end the turn');
});

test('the budget bound is the same bound however the moves are spent', () => {
  // THE REASON THE COST IS TWO. The budget exists to bound ACCEPTED board changes
  // per turn (see the note over REARRANGE_BUDGET — 60 moves over a socket
  // returned 785KB to one seat). If a swap cost one, a player could buy 24 card
  // movements with a budget of 12, and the ceiling the budget imposes would
  // silently double. At two, six swaps is exactly twelve movements.
  const { state, rainbow, pair } = deadlocked();
  let accepted = 0;
  for (let i = 0; i < 100; i++) {
    if (G.swapProperties(state, 'p1', rainbow.id, pair.id).ok) accepted++;
  }
  assert.equal(accepted, G.REARRANGE_BUDGET / G.SWAP_COST, '6 swaps, not 12');
  assert.equal(state.events.filter(e => e.t === 'move_property').length,
    accepted * 2, 'and exactly twelve card movements — the same ceiling a move buys');
  assert.equal(state.rearrangesRemaining, 0);
  assert.match(G.swapProperties(state, 'p1', rainbow.id, pair.id).error,
    /No free rearranges left/);
});

test('a swap and two moves cost the same, so the swap adds reach and not economy', () => {
  // Two zones with ROOM, where both orderings are legal. The swap must not be a
  // discount on what moveProperty could already do.
  const build = () => {
    const s = fresh();
    const [a] = s.players;
    const w1 = putWild(s, a, 'green', pairWild('green', 'darkblue'));
    const w2 = putWild(s, a, 'darkblue', anyWild);
    return { s, a, w1, w2 };
  };
  const viaMoves = build();
  assert.deepEqual(G.moveProperty(viaMoves.s, 'p1', viaMoves.w1.id, 'darkblue'), { ok: true });
  assert.deepEqual(G.moveProperty(viaMoves.s, 'p1', viaMoves.w2.id, 'green'), { ok: true });

  const viaSwap = build();
  assert.deepEqual(G.swapProperties(viaSwap.s, 'p1', viaSwap.w1.id, viaSwap.w2.id), { ok: true });

  assert.equal(viaSwap.s.rearrangesRemaining, viaMoves.s.rearrangesRemaining,
    'same board, same price');
  assert.deepEqual(zoneIds(viaSwap.a), zoneIds(viaMoves.a), 'and the same resulting board');
});

/* ── 4. the general rule collapses to wilds-only ───────────────────────── */

test('WILDS ONLY, and by consequence rather than by fiat', () => {
  // The engine runs the GENERAL rule: each card must be legal in the other's
  // destination. legalColorsFor() gives a fixed property exactly one colour, and
  // that colour is the zone it is already sitting in — so a fixed property is
  // never legal anywhere else and can never be either half. Probed over every
  // distinct fixed property in the deck rather than asserted.
  const deck = G.buildDeck();
  const fixedColors = [...new Set(deck.filter(c => c.type === 'property').map(c => c.color))];
  assert.ok(fixedColors.length >= 8, `only ${fixedColors.length} fixed colours probed`);

  let probed = 0;
  for (const color of fixedColors) {
    const state = fresh(`fixed-${color}`);
    const [a] = state.players;
    const fixed = putProperty(state, a, color);
    // A rainbow parked in a colour the fixed card is not — the most permissive
    // possible partner. If even THIS cannot swap, nothing fixed ever can.
    const other = COLOR_KEYS.find(c => c !== color);
    const rainbow = putWild(state, a, other, anyWild);

    const res = G.swapProperties(state, 'p1', fixed.id, rainbow.id);
    assert.match(res.error, /Only wild properties can move between sets/,
      `${color}: a fixed property must never be half of a swap`);
    assert.match(G.swapProperties(state, 'p1', rainbow.id, fixed.id).error,
      /Only wild properties can move between sets/, `${color}: and not in the other order either`);
    probed++;
  }
  assert.equal(probed, fixedColors.length);
});

test('upgrades are out of scope and say so (§3.1b owns them)', () => {
  const state = fresh();
  const [a] = state.players;
  putProperty(state, a, 'darkblue');
  putProperty(state, a, 'darkblue');
  putProperty(state, a, 'intel');
  putProperty(state, a, 'intel');
  const house = take(state, c => c.type === 'action' && c.action === 'upgrade');
  const house2 = take(state, c => c.type === 'action' && c.action === 'upgrade');
  (a.upgrades.darkblue ||= []).push({ ...house, upgradeType: 'house', placedColor: 'darkblue' });
  (a.upgrades.intel ||= []).push({ ...house2, upgradeType: 'house', placedColor: 'intel' });

  assert.match(G.swapProperties(state, 'p1', house.id, house2.id).error,
    /An Upgrade moves on its own/);

  // And nothing is lost by refusing. An Upgrade contributes to a set through its
  // KIND alone (calcRent adds +3 for a house, +4 for an FOC — game.js), so two
  // Houses are interchangeable and trading them changes nothing observable. The
  // rents below differ only because the two colours have different ladders; what
  // matters is that swapping the cards would leave both numbers exactly as they are.
  const rents = ['darkblue', 'intel'].map(c => G.calcRent(a, c));
  const tmp = a.upgrades.darkblue[0];
  a.upgrades.darkblue[0] = a.upgrades.intel[0];
  a.upgrades.intel[0] = tmp;
  assert.deepEqual(['darkblue', 'intel'].map(c => G.calcRent(a, c)), rents,
    'hand-swapping two Houses is a no-op — there is no deadlock here to relieve');
});

/* ── 5. the two structural invariants ──────────────────────────────────── */

test('no zone count and no set completion EVER changes, over a matrix', () => {
  // Both properties are what make the swap safe rather than merely convenient
  // (see the note over game.js swapProperties). Neither is asserted from the
  // implementation — both are measured over boards that stress them.
  const boards = {
    'the ruling\'s deadlock': (s, a) => {
      putProperty(s, a, 'darkblue');
      const pair = putWild(s, a, 'darkblue', pairWild('green', 'darkblue'));
      putProperty(s, a, 'green'); putProperty(s, a, 'green');
      return [putWild(s, a, 'green', anyWild).id, pair.id];
    },
    'a 2-card set trading with a 4-card set': (s, a) => {
      putProperty(s, a, 'darkblue');
      const w1 = putWild(s, a, 'darkblue', anyWild);            // darkblue 2/2
      putProperty(s, a, 'base'); putProperty(s, a, 'base'); putProperty(s, a, 'base');
      const w2 = putWild(s, a, 'base', anyWild);                // base 4/4
      return [w1.id, w2.id];
    },
    'two zones with room to spare': (s, a) => {
      const w1 = putWild(s, a, 'green', pairWild('green', 'darkblue'));
      return [w1.id, putWild(s, a, 'darkblue', anyWild).id];
    },
    'TWO all-wild zones (pureSetRequired\'s edge)': (s, a) => {
      // Neither zone is a SET under pureSetRequired (no real property in it) and
      // both are full. A wild-for-wild trade cannot change that in either
      // direction, which is exactly the claim being measured.
      const w1 = putWild(s, a, 'darkblue', anyWild);
      putWild(s, a, 'darkblue', pairWild('green', 'darkblue'));  // darkblue 2/2, all wild
      const w2 = putWild(s, a, 'intel', anyWild);
      putWild(s, a, 'intel', pairWild('base', 'intel'));         // intel 2/2, all wild
      return [w1.id, w2.id];
    },
    'a zone carrying an Upgrade + FOC': (s, a) => {
      putProperty(s, a, 'darkblue');
      const w1 = putWild(s, a, 'darkblue', pairWild('green', 'darkblue'));
      putProperty(s, a, 'green'); putProperty(s, a, 'green');
      const w2 = putWild(s, a, 'green', anyWild);
      const up = take(s, c => c.type === 'action' && c.action === 'upgrade');
      const foc = take(s, c => c.type === 'action' && c.action === 'foc');
      (a.upgrades.darkblue ||= []).push({ ...up, upgradeType: 'house', placedColor: 'darkblue' });
      a.upgrades.darkblue.push({ ...foc, upgradeType: 'hotel', placedColor: 'darkblue' });
      return [w1.id, w2.id];
    },
  };

  let checked = 0;
  for (const [name, build] of Object.entries(boards)) {
    for (const pureSetRequired of [false, true]) {
      const state = fresh(`${name}-${pureSetRequired}`);
      setRules(state, { pureSetRequired });
      const [a] = state.players;
      const [idA, idB] = build(state, a);

      const beforeCounts = counts(a);
      const beforeSets = G.completedSets(a);
      const beforeUpgrades = JSON.stringify(a.upgrades);
      const beforeBank = a.bank.length;

      const res = G.swapProperties(state, 'p1', idA, idB);
      assert.deepEqual(res, { ok: true }, `${name} @ pure=${pureSetRequired}`);

      assert.deepEqual(counts(a), beforeCounts, `${name}: zone counts are invariant`);
      assert.equal(G.completedSets(a), beforeSets, `${name}: completion is invariant`);
      assert.equal(JSON.stringify(a.upgrades), beforeUpgrades,
        `${name}: no upgrade was banked — nothing broke`);
      assert.equal(a.bank.length, beforeBank);
      assert.deepEqual(G.validateState(state), { ok: true }, `${name}: still valid`);
      assert.equal(state.events.some(e => e.t === 'upgrade_banked'), false,
        `${name}: bankUpgrades() is a no-op on this operation`);
      checked++;
    }
  }
  assert.equal(checked, Object.keys(boards).length * 2);
  assert.ok(checked >= 10, `only ${checked} boards checked`);
});

test('the §3.5 cap is never exceeded in any snapshot a client could receive', () => {
  const { state, rainbow, pair } = deadlocked();
  const seen = [];
  for (const id of ['p1', 'p2']) seen.push(G.getPlayerView(state, id));
  assert.deepEqual(G.swapProperties(state, 'p1', rainbow.id, pair.id), { ok: true });
  for (const id of ['p1', 'p2']) seen.push(G.getPlayerView(state, id));

  // There is no third snapshot. The operation is one synchronous call with no
  // yield inside it, so "before" and "after" are the only states that exist —
  // which is exactly why a transient overfull state was rejected as the fix.
  for (const view of seen) {
    for (const player of view.players) {
      for (const [color, cards] of Object.entries(player.properties || {})) {
        assert.ok(cards.length <= G.COLORS[color].size,
          `${color} holds ${cards.length}/${G.COLORS[color].size} in a broadcast view`);
      }
    }
  }
  assert.equal(seen.length, 4);
});

/* ── 6. the event channel (§4) ─────────────────────────────────────────── */

test('a swap emits TWO move_property events, tagged as one beat', () => {
  const { state, rainbow, pair } = deadlocked();
  const before = state.events.length;
  assert.deepEqual(G.swapProperties(state, 'p1', rainbow.id, pair.id), { ok: true });
  const fired = state.events.slice(before);

  assert.equal(fired.length, 2, 'two cards moved, so two moves are reported');
  assert.ok(fired.every(e => e.t === 'move_property'),
    'the existing row is reused — the choreographer, sfx map, journal and feed '
    + 'all already render it, so BOTH cards fly under FLIP with no anim/ change');

  const [first, second] = fired;
  assert.equal(first.card.id, rainbow.id);
  assert.equal(second.card.id, pair.id);
  // The tag: each half names its partner, so a consumer that wants one beat can
  // fly them together instead of sequencing two unrelated moves.
  assert.equal(first.swapWith, pair.id);
  assert.equal(second.swapWith, rainbow.id);
  assert.equal(first.swapHalf, 0);
  assert.equal(second.swapHalf, 1);
  // The halves are exact inverses — that is what makes it an exchange.
  assert.equal(first.from, second.to);
  assert.equal(first.to, second.from);
  assert.notEqual(first.from, first.to);
  // §4 redaction: a card becoming public carries the full public object, and
  // nothing beyond it. These were already on the actor's own visible board, so
  // nothing new is revealed either way.
  const onBoard = (id) => [...state.players[0].properties.darkblue,
    ...state.players[0].properties.green].find(c => c.id === id);
  for (const e of fired) {
    assert.deepEqual(e.card, G.publicCard(onBoard(e.card.id)));
    assert.equal(e.actor, 'p1');
  }
  assert.ok(monotonic(state.events), 'seq stays monotonic across both halves');
});

function monotonic(events) {
  for (let i = 1; i < events.length; i++) if (events[i].seq <= events[i - 1].seq) return false;
  return true;
}

test('a plain move still emits an UNTAGGED move_property', () => {
  // The tag must be the thing that distinguishes a swap half, or a consumer
  // grouping by `swapWith` would pair up two ordinary rearranges.
  const state = fresh();
  const [a] = state.players;
  const wild = putWild(state, a, 'green', pairWild('green', 'darkblue'));
  assert.deepEqual(G.moveProperty(state, 'p1', wild.id, 'darkblue'), { ok: true });
  const ev = state.events.filter(e => e.t === 'move_property').pop();
  assert.equal(ev.swapWith, undefined);
  assert.equal(ev.swapHalf, undefined);
});

test('one player action writes ONE line to the mission log', () => {
  const { state, rainbow, pair } = deadlocked();
  const before = state.log.length;
  G.swapProperties(state, 'p1', rainbow.id, pair.id);
  assert.equal(state.log.length - before, 1);
  assert.match(state.log[state.log.length - 1],
    /^P1 swapped .+ and .+ between .+ and .+$/);
});

/* ── 7. the wire (§0.1) ────────────────────────────────────────────────── */

test('server/protocol.js validates swap_property by SHAPE and refuses the rest', () => {
  const ok = (m) => validateMessage(m).ok;
  assert.equal(ok({ type: 'swap_property', cardId: 3, withCardId: 7 }), true);
  assert.equal(ok({ type: 'swap_property', cardId: 0, withCardId: 1000 }), true);

  assert.equal(ok({ type: 'swap_property', cardId: 3 }), false, 'missing partner');
  assert.equal(ok({ type: 'swap_property', withCardId: 3 }), false, 'missing card');
  assert.equal(ok({ type: 'swap_property', cardId: '3', withCardId: 7 }), false, 'string id');
  assert.equal(ok({ type: 'swap_property', cardId: 3.5, withCardId: 7 }), false, 'non-integer');
  assert.equal(ok({ type: 'swap_property', cardId: -1, withCardId: 7 }), false, 'negative');
  assert.equal(ok({ type: 'swap_property', cardId: 3, withCardId: 100000 }), false, 'out of range');
  assert.equal(ok({ type: 'swap_property', cardId: 3, withCardId: 3 }), false, 'the same card twice');
  assert.equal(ok({ type: 'swap_property', cardId: 3, withCardId: null }), false);
  assert.equal(ok({ type: 'swap_property', cardId: 3, withCardId: [7] }), false);

  // NO COLOUR ON THE WIRE. The destinations are determined by where the cards
  // already are; a client that could name them could name a pair that disagrees
  // with the board, and the engine would have to decide which it believed.
  const src = readFileSync(join(__dirname, '..', 'server/protocol.js'), 'utf8');
  const block = src.slice(src.indexOf("case 'swap_property'"));
  assert.doesNotMatch(block.slice(0, block.indexOf('break;')), /toColor|COLORS\.has/);
});

test('server/handlers.js routes swap_property to the engine and nowhere else', () => {
  const src = readFileSync(join(__dirname, '..', 'server/handlers.js'), 'utf8');
  const block = src.slice(src.indexOf("case 'swap_property'"));
  const body = block.slice(0, block.indexOf("case 'play_action'"));
  assert.match(body, /G\.swapProperties\(room\.state, playerId, msg\.cardId, msg\.withCardId\)/);
  // §0.1: an illegal request costs one error frame and NO rebroadcast.
  assert.match(body, /if \(res\.error\)[\s\S]*type: 'error'[\s\S]*break;/);
  assert.match(body, /broadcast\.broadcastAndScheduleBot\(room\)/);
  // The seat is the SOCKET's, never the message's — the same discipline as
  // move_property. A `playerId` read off msg would be seat forgery.
  assert.doesNotMatch(body, /msg\.playerId/);
});

/* ── 8. the client offers a SUBSET of what the engine accepts ──────────── */

async function stage(state, selfId = 'p1') {
  const { store } = await loadStore();
  store.self = { id: selfId, name: 'P1' };
  store.snapshot = G.getPlayerView(state, selfId);
  return store.snapshot;
}

/** Every (colour, partner) pair game.js will actually take, probed one at a time
 *  on a clone so no probe leaves the board changed for the next. */
function engineSwapsFor(state, cardId) {
  const out = [];
  const me = state.players[0];
  for (const color of COLOR_KEYS) {
    for (const partner of me.properties[color] || []) {
      const clone = JSON.parse(JSON.stringify(state));
      if (G.swapProperties(clone, 'p1', cardId, partner.id).ok) out.push(`${color}:${partner.id}`);
    }
  }
  return out.sort();
}

test('swapPartners()/swapColors() never offer a swap the engine would refuse', async () => {
  const sel = await loadSel();

  const boards = {
    'the ruling\'s deadlock, from the rainbow': (s, a) => {
      putProperty(s, a, 'darkblue');
      putWild(s, a, 'darkblue', pairWild('green', 'darkblue'));
      putProperty(s, a, 'green'); putProperty(s, a, 'green');
      return putWild(s, a, 'green', anyWild).id;
    },
    'the ruling\'s deadlock, from the pair wild': (s, a) => {
      putProperty(s, a, 'darkblue');
      const pair = putWild(s, a, 'darkblue', pairWild('green', 'darkblue'));
      putProperty(s, a, 'green'); putProperty(s, a, 'green');
      putWild(s, a, 'green', anyWild);
      return pair.id;
    },
    'a full zone holding only FIXED properties (no partner)': (s, a) => {
      const w = putWild(s, a, 'green', pairWild('green', 'darkblue'));
      putProperty(s, a, 'darkblue'); putProperty(s, a, 'darkblue');
      return w.id;
    },
    'a full zone whose wild cannot come back': (s, a) => {
      // A brown/lightblue wild sitting in a full darkblue: the rainbow may go
      // there, but that wild may not come back to green, so it is not a swap.
      const w = putWild(s, a, 'green', anyWild);
      putProperty(s, a, 'darkblue');
      putWild(s, a, 'darkblue', pairWild('brown', 'lightblue'));
      return w.id;
    },
    'TWO partners in one full zone': (s, a) => {
      const w = putWild(s, a, 'darkblue', anyWild);
      putProperty(s, a, 'darkblue');
      putProperty(s, a, 'green');
      putWild(s, a, 'green', anyWild);
      putWild(s, a, 'green', pairWild('green', 'darkblue'));
      return w.id;
    },
    'a rainbow with several full zones around it': (s, a) => {
      const w = putWild(s, a, 'base', anyWild);
      putProperty(s, a, 'darkblue');
      putWild(s, a, 'darkblue', anyWild);
      putProperty(s, a, 'intel');
      putWild(s, a, 'intel', pairWild('intel', 'base'));
      putProperty(s, a, 'brown');                     // 1/2 — room, so a plain MOVE
      return w.id;
    },
  };

  let compared = 0;
  let nonEmpty = 0;
  for (const [name, build] of Object.entries(boards)) {
    for (const plays of [3, 0]) {
      const state = fresh(`offer-${name}`);
      const cardId = build(state, state.players[0]);
      state.playsRemaining = plays;
      await stage(state);

      const engine = engineSwapsFor(state, cardId);
      const client = [];
      for (const color of sel.swapColors(cardId)) {
        for (const partner of sel.swapPartners(cardId, color)) client.push(`${color}:${partner.id}`);
      }
      client.sort();

      // OFFER ⊆ ACCEPT is the direction §0.1 requires. It is not equality on
      // purpose: the engine will also swap into a zone with room to spare, and
      // the client deliberately does not offer that (a mat must mean one thing,
      // and where there is room the MOVE is the better command — one rearrange
      // instead of two, one card instead of two).
      for (const offer of client) {
        assert.ok(engine.includes(offer),
          `${name} @ ${plays} plays — client offered ${offer}, engine refuses it`);
      }
      // And every offer the client withholds is withheld for that one reason.
      for (const accepted of engine) {
        const color = accepted.split(':')[0];
        if (client.includes(accepted)) continue;
        assert.ok(!G.zoneFull(state.players[0], color),
          `${name}: client withheld ${accepted} from a FULL zone — that is a real gap`);
      }
      if (client.length) nonEmpty++;
      compared++;
    }
  }
  assert.equal(compared, Object.keys(boards).length * 2);
  assert.ok(nonEmpty >= 6, `only ${nonEmpty} boards produced an offer — the comparison is empty`);
});

test('the deadlocked board is exactly where the client turns a refusal into a target', async () => {
  const sel = await loadSel();
  const { state, rainbow, pair } = deadlocked();
  await stage(state);

  // The mat this exchange is about was, and still is, unreachable by a MOVE.
  const fromRainbow = sel.boardMoveTarget(rainbow.id);
  assert.equal(fromRainbow.colors.includes('darkblue'), false,
    'moveProperty offers no route into the full darkblue');
  assert.deepEqual(fromRainbow.swap, ['darkblue'], 'and the swap is exactly that one mat');
  assert.ok(fromRainbow.targets.includes('darkblue'),
    'so the union the mats are marked from now reaches it');
  assert.deepEqual(sel.swapPartners(rainbow.id, 'darkblue').map(c => c.id), [pair.id]);
  assert.equal(sel.canSwap(), true);

  // And from the other side, symmetrically. The pair wild's only two colours are
  // green and darkblue, so before this it had nowhere at all to go.
  const fromPair = sel.boardMoveTarget(pair.id);
  assert.deepEqual(fromPair.colors, [], 'the pair wild had NO legal move whatsoever');
  assert.deepEqual(fromPair.swap, ['green']);
  assert.deepEqual(sel.swapPartners(pair.id, 'green').map(c => c.id), [rainbow.id]);
});

test('the client refuses a swap it cannot afford, in the engine\'s own words', async () => {
  const sel = await loadSel();
  for (const [left, re] of [[1, /costs two free rearranges and you have one left/],
    [0, /No free rearranges left/]]) {
    const { state, rainbow, pair } = deadlocked();
    state.rearrangesRemaining = left;
    await stage(state);
    assert.equal(sel.canSwap(), false, `budget ${left}`);
    assert.match(sel.cannotSwapReason(), re);
    assert.match(G.swapProperties(state, 'p1', rainbow.id, pair.id).error, re,
      'and it is the sentence the server would have sent');
  }
});

test('upgrades carry no swap offer on the client either', async () => {
  const sel = await loadSel();
  const state = fresh();
  const [a] = state.players;
  putProperty(state, a, 'darkblue'); putProperty(state, a, 'darkblue');
  putProperty(state, a, 'intel'); putProperty(state, a, 'intel');
  const up = take(state, c => c.type === 'action' && c.action === 'upgrade');
  (a.upgrades.darkblue ||= []).push({ ...up, upgradeType: 'house', placedColor: 'darkblue' });
  await stage(state);
  const found = sel.boardMoveTarget(up.id);
  assert.equal(found.isUpgrade, true);
  assert.deepEqual(found.swap, []);
  assert.deepEqual(found.targets, found.colors);
});

/* ── 9. the mats say it, and the BEST mark does not lie ────────────────── */

test('a swap mat carries TRADE, keeps its rung, and can never be BEST', async () => {
  const sel = await loadSel();
  const state = fresh();
  const [a] = state.players;
  // A rainbow in a 1/2 brown, a FULL darkblue holding a swappable wild.
  const w = putWild(state, a, 'brown', anyWild);
  putProperty(state, a, 'darkblue');
  putWild(state, a, 'darkblue', anyWild);
  await stage(state);

  const found = sel.boardMoveTarget(w.id);
  assert.ok(found.colors.length, 'plain moves exist on this board');
  assert.deepEqual(found.swap, ['darkblue']);

  const rows = sel.placementAdvice(found.card, found.targets, 'place', found.swap);
  const swapRow = rows.find(r => r.color === 'darkblue');
  assert.equal(swapRow.kind, 'swap');
  assert.equal(swapRow.next, swapRow.count, 'a trade does not change the count');
  assert.equal(swapRow.gain, 0, 'nor the rent');
  assert.equal(swapRow.completes, false);
  assert.equal(swapRow.best, false, 'BEST is a rent-gain claim and a swap gains no rent');
  assert.match(sel.adviceSentence(swapRow), /trade places/);

  // BEST still lands somewhere real.
  assert.equal(rows.filter(r => r.best).length, 1);
  assert.notEqual(rows.find(r => r.best).color, 'darkblue');

  // And a plain-move row is untouched by the new argument.
  const plain = rows.find(r => r.kind === 'place');
  assert.equal(plain.next, plain.count + 1);
});

/* ── 10. neither route may invent a command the other does not have ────── */

test('tap and drag reach the swap through the SAME fork', () => {
  const src = readFileSync(join(__dirname, '..', 'public/src/interact/index.js'), 'utf8');

  // The fork lives in pick(), which is the one place a target is recorded — so
  // the drag cannot decide a mat means something the tap thinks it does not.
  const pickFn = src.slice(src.indexOf('export function pick(step, value)'));
  const pickBody = pickFn.slice(0, pickFn.indexOf('\nfunction handleTargetTap'));
  assert.match(pickBody, /sel\.swapPartners\(mode\.cardId, value\)/,
    'the myColor step is where a FULL mat becomes a swap');
  assert.match(pickBody, /mode\.needs\.splice\(1, 0, 'swapCard'\)/,
    'a full mat with a partner in it gets a step, never a silent pick');

  // The drag route ships the same drop kind for both, so it does not decide.
  const planFn = src.slice(src.indexOf('export function dragPlan'));
  const branchStart = planFn.indexOf("cand.source === 'board'");
  const boardBranch = planFn.slice(branchStart, planFn.indexOf('// `reason` is', branchStart));
  assert.match(boardBranch, /offeredColors\(sel\.boardMoveTarget\(cardId\)\)/);
  assert.match(boardBranch, /kind: 'move'/);
  assert.doesNotMatch(boardBranch, /kind: 'swap'/,
    'a swap is not a second drop kind — pick() forks, not the drag');

  // And the command is chosen from what was ANSWERED, never guessed.
  const dispatchFn = src.slice(src.indexOf('function dispatch()'));
  const dispatchBody = dispatchFn.slice(0, dispatchFn.indexOf('\n}\n'));
  assert.match(dispatchBody, /mode\.picks\.withCardId != null[\s\S]*send\.swapProperty/);
  assert.match(dispatchBody, /else send\.moveProperty/);
});

/* ── 10b. CONSENT: choosing the mat must not be what chooses the swap ─────
 *
 * THE DEFECT, reported live after d05d523 shipped and after ccea2c4 fixed the
 * OTHER half of it. Owner: "im trying to add a wild to one that has a dual color
 * one and they are just getting swapped over and over."
 *
 * ccea2c4 made the OFFER correct — swapPartners() requires `zoneFull`, so a swap
 * is only ever proposed where a plain move is illegal — and that was not this
 * bug. This one is underneath it: where a swap IS legal, `pick('myColor')` took
 * a single partner without asking, under this file's standing rule that you
 * never prompt for a decision with one answer.
 *
 * The rule is right and it was answering the wrong question. "Which partner?"
 * has one answer. "Did you want a swap at all?" has two, on every full mat in
 * the game, because the gesture that chose the destination is byte-for-byte
 * identical for a move and for a swap — and they are not the same move: one
 * relocates one card for one rearrange, the other relocates two for two.
 *
 * The d05d523 matrix ran 48 real-CDP combinations over this exact code and
 * missed it, because every one of them was a board where the swap was what the
 * player wanted. A gate written from the implementation's own intent cannot see
 * an intent mismatch. So what is pinned here is the SHAPE — no assignment of
 * `withCardId` outside the step whose only job is to collect it — and the
 * behaviour is measured under real input by tools/dragtest.mjs §A/§A′, which
 * stages §3.5's deadlocked board through engine calls and reads sentLog.
 */
test('the myColor step can never dispatch a swap on its own', () => {
  const src = readFileSync(join(__dirname, '..', 'public/src/interact/index.js'), 'utf8');
  const pickFn = src.slice(src.indexOf('export function pick(step, value)'));
  const pickBody = pickFn.slice(0, pickFn.indexOf('\nfunction handleTargetTap'));

  // The colour branch, in isolation: it may ARM the step and may not ANSWER it.
  const colorBranch = pickBody.slice(pickBody.indexOf("case 'myColor':"),
    pickBody.indexOf("case 'swapCard':"));
  assert.doesNotMatch(colorBranch, /withCardId/,
    'choosing the destination must not also choose the partner — that is the whole defect');
  assert.match(colorBranch, /mode\.needs\.splice\(1, 0, 'swapCard'\)/);
  assert.doesNotMatch(colorBranch, /length === 1|length > 1/,
    'the step is unconditional on how many partners there are: it buys CONSENT, not information');

  // …and across the whole file there is exactly ONE place `withCardId` is set,
  // in the step the player answers by pointing at a card. dispatch() reads it.
  const assignments = [...src.matchAll(/mode\.picks\.withCardId\s*=/g)];
  assert.equal(assignments.length, 1,
    `withCardId is assigned in ${assignments.length} places — a swap must have one door`);
  const swapStep = pickBody.slice(pickBody.indexOf("case 'swapCard':"));
  assert.match(swapStep, /mode\.picks\.withCardId = value/);

  // The consequence dispatch() draws from it is unchanged: no answer, no swap.
  const dispatchFn = src.slice(src.indexOf('function dispatch()'));
  const dispatchBody = dispatchFn.slice(0, dispatchFn.indexOf('\n}\n'));
  assert.match(dispatchBody, /mode\.picks\.withCardId != null[\s\S]*send\.swapProperty/);
});

test('the swapCard step says what it costs, and the mats say it before the tap', () => {
  const src = readFileSync(join(__dirname, '..', 'public/src/interact/index.js'), 'utf8');

  // §3.9: the step's own prompt names the thing that makes a swap different
  // from the move it is standing in for — both cards move.
  const hints = src.slice(src.indexOf('const HINTS'), src.indexOf('function changed()'));
  assert.match(hints, /swapCard:.*TRADE/,
    'the swapCard prompt must name the trade, or the step is a mystery tap');

  // And the DRAG route paints the same TRADE chit the tap route has always had.
  // Before this round it painted nothing at all: applyMarks() only ran its
  // advice branch for `mode.kind === 'target'`, and a drag never enters that
  // mode until the finger is up — so mid-drag a swap mat carried exactly
  // `data-droppable="1"` and `is-drop-hover`, the same two marks as every
  // ordinary move target. tools/dragtest.mjs §A′ reads the chit mid-gesture.
  const marks = src.slice(src.indexOf('export function applyMarks'));
  assert.match(marks, /drag\.heldCardId\(\)/,
    'applyMarks must know what is under the finger to answer for the mat');
  assert.match(marks, /paintAdvice\(found\.card/,
    'a live board drag paints the same chits as the tap route');
});

test('a full mat that CAN trade is a target, not a refusal', () => {
  const src = readFileSync(join(__dirname, '..', 'public/src/interact/index.js'), 'utf8');
  const fn = src.slice(src.indexOf('export function dropRefusal'));
  const body = fn.slice(0, fn.indexOf('\n/* ── marks'));
  // The full-set sentence is now guarded by "is there a partner?", so the mat
  // that a swap is FOR no longer answers with the sentence that hid it.
  const guard = body.indexOf('sel.swapPartners(cardId, color)');
  const sentence = body.indexOf('`${name} already holds a full set');
  assert.ok(guard > 0 && sentence > 0);
  assert.ok(guard < sentence, 'the swap check must precede the full-set refusal');
  assert.match(body, /sel\.canSwap\(\) \? '' : sel\.cannotSwapReason\(\)/);
});

test('net/send.js is still the only door to the socket', () => {
  const send = readFileSync(join(__dirname, '..', 'public/src/net/send.js'), 'utf8');
  assert.match(send, /type: 'swap_property', cardId, withCardId/);
  const interact = readFileSync(join(__dirname, '..', 'public/src/interact/index.js'), 'utf8');
  assert.doesNotMatch(interact, /'swap_property'/,
    'interact/ must not hand-roll a payload — net/send.js owns every message');
});

/* ── 11. the inherited line: plays are gone, rearranging is not ────────── */

test('at playsRemaining 0 the bar says rearranging is still free — when it is', async () => {
  const sel = await loadSel();
  const prompt = readFileSync(join(__dirname, '..', 'public/src/ui/prompt.js'), 'utf8');
  assert.match(prompt, /rearranging your board is still free/);
  assert.match(prompt, /sel\.rearrangeableCards\(\)/,
    'the claim is counted, not assumed');

  // TRUE on a board with a movable wild…
  {
    const state = fresh();
    const [a] = state.players;
    const wild = putWild(state, a, 'green', pairWild('green', 'darkblue'));
    state.playsRemaining = 0;
    await stage(state);
    assert.equal(sel.canPlay(), false);
    assert.equal(sel.canRearrange(), true);
    assert.deepEqual(sel.rearrangeableCards().map(c => c.id), [wild.id]);
    assert.deepEqual(G.moveProperty(state, 'p1', wild.id, 'darkblue'), { ok: true },
      'and the engine really would take it');
  }
  // …and FALSE on a board with nothing to move, so the bar does not invent one.
  {
    const state = fresh();
    const [a] = state.players;
    putProperty(state, a, 'green');
    state.playsRemaining = 0;
    await stage(state);
    assert.deepEqual(sel.rearrangeableCards(), []);
  }
  // A deadlocked board counts the swap as a live move — that is the whole point.
  {
    const { state, rainbow, pair } = deadlocked();
    state.playsRemaining = 0;
    await stage(state);
    assert.deepEqual(sel.rearrangeableCards().map(c => c.id).sort(),
      [rainbow.id, pair.id].sort());
  }
});
