// test/finalapproach-race.test.js — the armed-player race, over seeded batches.
//
// Context: a player reported "I had 3 sets before Phantom but he won instead of me".
// Diagnosis (P0, 2026-08-06): the engine is correct. The proposed invariant "the player who
// armed EARLIEST always wins first" is FALSE BY DESIGN under both grace modes, because the
// checkpoint is anchored to YOUR NEXT OWN TURN, not to a global clock. These tests pin the
// invariants that must actually hold, and pin the overtake itself so nobody "fixes" it.

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');
const sim = require('../simulate');

/* ── helpers ─────────────────────────────────────────────────────────── */

function build(winRule, seats = 3) {
  const players = Array.from({ length: seats }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  const state = G.createGame(players, { seed: 'race', winRule });
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
function prop(state, player, color) {
  const c = take(state, x => x.type === 'property' && x.color === color);
  (player.properties[color] = player.properties[color] || []).push({ ...c, placedColor: color });
  return c;
}
const setOf = (s, p, color) => {
  while ((p.properties[color] || []).length < G.COLORS[color].size) prop(s, p, color);
};

/* ── the overtake is legitimate, and the two modes invert who it hurts ── */

// P1 completes their third set ON THEIR OWN TURN; one turn later P3 is handed their third
// set OFF-TURN by a TDY swap, immediately before P3's own turn.
function armOwnThenOffTurn(winRule) {
  const state = build(winRule, 3);
  const [p1, p2, p3] = state.players;

  setOf(state, p1, 'brown');
  setOf(state, p1, 'darkblue');
  prop(state, p1, 'intel');
  setOf(state, p3, 'lightblue');
  setOf(state, p3, 'pink');
  prop(state, p3, 'orange'); prop(state, p3, 'orange');   // 2 of 3
  prop(state, p3, 'red');                                 // a spare P2 can take
  const gift = prop(state, p2, 'orange');                 // the card that completes P3

  // P1 arms on their own turn.
  p1.hand.push(take(state, c => c.type === 'property' && c.color === 'intel'));
  assert.ok(G.playProperty(state, 'p1', p1.hand.length - 1).ok);
  assert.equal(p1.finalApproach, true);
  const p1Forecast = G.checkpointForecast(state, p1);

  // P2's turn: P2 gives P3 the completing orange, arming P3 off-turn.
  assert.ok(G.endTurn(state, 'p1').ok);
  assert.equal(G.currentPlayer(state).id, 'p2');
  state.turnPhase = 'play';
  state.playsRemaining = 3;
  p2.hand.push(take(state, c => c.action === 'tdy_orders'));
  assert.ok(G.playAction(state, 'p2', p2.hand.length - 1, {
    targetId: 'p3', targetCardId: p3.properties.red[0].id, myCardId: gift.id,
  }).ok);
  assert.ok(G.respondToAction(state, 'p3', 'accept').ok);
  assert.equal(p3.finalApproach, true, 'P3 armed off-turn');
  assert.ok(p3.armedAtTurn > p1.armedAtTurn, 'P3 armed LATER than P1');

  return { state, p1, p3, p1Forecast, p3Forecast: G.checkpointForecast(state, p3) };
}

// REPLACED 2026-08-08. This used to assert that under mdFaithful the LATER, off-turn arm
// overtakes P1's earlier own-turn arm. That whole race was an artefact of making an
// own-turn completion wait a lap, which no edition of Monopoly Deal does: the 2008 sheet
// only defers a win you noticed on someone else's turn, and every printing since 2017 says
// the game simply ends. So under mdFaithful the scenario cannot start — P1 has already won
// before P3 can be handed anything. The overtake itself still exists and is still pinned,
// under finalApproach, by the test below.
test('mdFaithful: an own-turn completion ends the game, so the race never starts', () => {
  const state = build('mdFaithful', 3);
  const [p1] = state.players;
  setOf(state, p1, 'brown');
  setOf(state, p1, 'darkblue');
  prop(state, p1, 'intel');
  p1.hand.push(take(state, c => c.type === 'property' && c.color === 'intel'));
  assert.ok(G.playProperty(state, 'p1', p1.hand.length - 1).ok);
  assert.equal(state.phase, 'finished', 'the third set on your own turn IS the win');
  assert.equal(state.winner, 'p1');
  assert.equal(p1.finalApproach, false, 'and nothing was ever armed for anyone to overtake');
  assert.equal(G.checkpointForecast(state, p1), null);
});

test('finalApproach: the strict full cycle inverts it — the off-turn arm is the one penalised', () => {
  const { p1, p3, p1Forecast, p3Forecast } = armOwnThenOffTurn('finalApproach');
  // The same off-turn arm now has to skip its immediate next own turn and wait a whole
  // extra lap, so the earlier own-turn arm converts first.
  assert.ok(p1Forecast.turn < p3Forecast.turn,
    `own-turn arm should convert first: P1 T${p1Forecast.turn} vs P3 T${p3Forecast.turn}`);
  assert.ok(p3.armedAtTurn > p1.armedAtTurn);
});

test('an armed player whose turn starts without converting is told so, not left in silence', () => {
  const { state, p3 } = armOwnThenOffTurn('finalApproach');
  const before = state.events.length;
  // Run turns until P3's own turn begins; under the strict rule it must NOT convert.
  let guard = 0;
  while (G.currentPlayer(state).id !== 'p3' && state.phase === 'playing' && guard++ < 6) {
    G.endTurn(state, G.currentPlayer(state).id);
  }
  assert.equal(state.phase, 'playing', 'P3 does not win at this turn');
  const pending = state.events.slice(before).filter(e => e.t === 'final_approach_pending');
  assert.ok(pending.length >= 1, 'the engine announces that the win has not locked in yet');
  const ev = pending.find(e => e.actor === 'p3');
  assert.ok(ev, 'and names the player it is about');
  assert.equal(typeof ev.checkpointTurn, 'number');
  assert.ok(state.log.some(l => /still on FINAL APPROACH/.test(l)), state.log.slice(-4).join(' | '));
  assert.ok(p3.finalApproach);
});

/* ── batch invariants over seeded games ──────────────────────────────── */

// Wraps the engine so every mutation can be inspected, runs a batch of seeded bot games and
// returns the violations of the invariants that MUST hold.
function auditBatch({ winRule, games, seats }) {
  const wrapped = ['playAction', 'respondToAction', 'endTurn', 'scoop', 'playProperty', 'moveProperty', 'drawCards'];
  const originals = {};
  const found = { missedCheckpoint: [], forecastMismatch: [], armedAfterScoop: [], armedUnderInstant: [] };
  const MODES = sim.BOT_MODES;

  const inspect = (state, via) => {
    if (!state || !state.players) return;
    if (state.winRule === 'instant' && state.players.some(p => p.finalApproach)) {
      found.armedUnderInstant.push(via);
    }
    if (state.phase !== 'playing') return;
    // INVARIANT: a checkpoint is never silently skipped. If the seat whose turn it is has
    // reached its checkpoint while still armed, the game must already be over.
    const cur = G.currentPlayer(state);
    if (cur && cur.finalApproach && !cur.eliminated && G.checkpointReached(state, cur)) {
      found.missedCheckpoint.push(`${via}: ${cur.id} armed@${cur.armedAtTurn} at turn ${state.turnCounter}`);
    }
    // INVARIANT: an eliminated player is never left armed.
    for (const p of state.players) {
      if (p.eliminated && p.finalApproach) found.armedAfterScoop.push(`${via}: ${p.id}`);
    }
  };

  for (const fn of wrapped) {
    originals[fn] = G[fn];
    G[fn] = function (state, ...rest) {
      const res = originals[fn].call(this, state, ...rest);
      inspect(state, fn);
      // INVARIANT: the forecast the HUD is given must equal the turn the win actually
      // resolves on. Checked at the moment of the win.
      if (state && state.phase === 'finished' && state.endReason === 'sets' && !state._forecastChecked) {
        state._forecastChecked = true;
        if (state._lastForecast && state._lastForecast.id === state.winner
          && state._lastForecast.turn !== state.turnCounter) {
          found.forecastMismatch.push(
            `${state.winner} forecast T${state._lastForecast.turn} but won on T${state.turnCounter}`);
        }
      }
      // Remember the winner-to-be's most recent forecast — and FORGET it the moment that
      // seat stops being armed. Added 2026-08-08 with the mdFaithful correction: a broken
      // approach can now be followed by an INLINE own-turn win, which has no forecast at
      // all, and the stale figure from the earlier arming was being compared against it
      // ("p1 forecast T22 but won on T34"). The engine was right both times; the harness
      // was remembering a prediction that had been withdrawn. Note runGame() does not seed
      // bot.js's RNG (only runMatches() does), so this batch is not reproducible run to
      // run — a harness bug like this one surfaces intermittently rather than never.
      if (state && state.phase === 'playing') {
        if (state._lastForecast) {
          const prev = state.players.find(p => p.id === state._lastForecast.id);
          if (!prev || !prev.finalApproach || prev.eliminated) state._lastForecast = null;
        }
        for (const p of state.players) {
          if (p.finalApproach && !p.eliminated) {
            const f = G.checkpointForecast(state, p);
            if (f) state._lastForecast = { id: p.id, turn: f.turn };
          }
        }
      }
      return res;
    };
  }
  try {
    for (let g = 0; g < games; g++) {
      const configs = Array.from({ length: seats }, (_, i) => ({ name: 'p' + i, mode: MODES[(g + i) % MODES.length] }));
      sim.runGame(configs, 400, `race:${winRule}:${g}`, { winRule });
    }
  } finally {
    for (const fn of wrapped) G[fn] = originals[fn];
  }
  return found;
}

for (const winRule of ['finalApproach', 'mdFaithful']) {
  test(`${winRule}: no checkpoint is ever skipped across a batch of seeded games`, () => {
    for (const seats of [3, 4]) {
      const found = auditBatch({ winRule, games: 40, seats });
      assert.deepEqual(found.missedCheckpoint.slice(0, 3), [],
        `${seats} seats: ${found.missedCheckpoint.length} skipped checkpoint(s)`);
      assert.deepEqual(found.armedAfterScoop.slice(0, 3), [],
        `${seats} seats: an eliminated player was left armed`);
      assert.deepEqual(found.forecastMismatch.slice(0, 3), [],
        `${seats} seats: the HUD forecast disagreed with the actual winning turn`);
    }
  });
}

test('instant: nothing is ever armed across a batch of seeded games', () => {
  const found = auditBatch({ winRule: 'instant', games: 40, seats: 4 });
  assert.deepEqual(found.armedUnderInstant.slice(0, 3), []);
});

test('scooping while armed always emits final_approach_broken (no phantom live arm)', () => {
  const state = build('finalApproach', 3);
  const [p1] = state.players;
  setOf(state, p1, 'brown');
  setOf(state, p1, 'darkblue');
  prop(state, p1, 'intel');
  p1.hand.push(take(state, c => c.type === 'property' && c.color === 'intel'));
  G.playProperty(state, 'p1', p1.hand.length - 1);
  assert.equal(p1.finalApproach, true);

  const before = state.events.length;
  assert.ok(G.scoop(state, 'p1').ok);
  const fresh = state.events.slice(before);
  assert.ok(fresh.some(e => e.t === 'final_approach_broken' && e.actor === 'p1'),
    'the event stream must not leave a phantom armed player behind');
  assert.equal(p1.finalApproach, false);
  assert.deepEqual(G.armedPlayers(state), []);
});
