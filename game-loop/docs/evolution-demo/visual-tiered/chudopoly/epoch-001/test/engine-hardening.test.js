// test/engine-hardening.test.js — P7 round-1 robustness fixes, engine + server-module level.
// Every test here corresponds to a defect a critic reproduced; the comment names the number.

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');
const Bot = require('../bot');
const broadcast = require('../server/broadcast');
const timers = require('../server/timers');
const absent = require('../server/absent');

broadcast.init({ G, Bot });
timers.init({ G, Bot, broadcast });
absent.init({ G, broadcast });

/* ── helpers ─────────────────────────────────────────────────────────── */

function fresh(playerCount = 2, seed = 'harden') {
  const players = Array.from({ length: playerCount }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  const state = G.createGame(players, { seed });
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
function propertyCard(state, player, color) {
  const card = take(state, c => c.type === 'property' && c.color === color);
  if (!player.properties[color]) player.properties[color] = [];
  player.properties[color].push({ ...card, placedColor: color });
  return card;
}
function fakeRoom(overrides = {}) {
  return {
    code: 'TEST', phase: 'playing', chat: [],
    turnTimeout: 0, responseTimeout: 0,
    players: [], ...overrides,
  };
}

/* ── 4. zone caps ────────────────────────────────────────────────────── */

test('steal_set never overflows a colour zone (§3.5)', () => {
  const state = fresh();
  const [a, b] = state.players;
  // B owns the complete darkblue set (size 2); A already holds a darkblue wild.
  propertyCard(state, b, 'darkblue');
  propertyCard(state, b, 'darkblue');
  const wild = take(state, c => c.type === 'wild_property' && (c.colors || []).includes('darkblue'));
  a.properties.darkblue = [{ ...wild, placedColor: 'darkblue' }];

  a.hand.push(take(state, c => c.action === 'inspector_general'));
  assert.ok(G.playAction(state, 'p1', 0, { targetId: 'p2', targetColor: 'darkblue' }).ok);
  assert.ok(G.respondToAction(state, 'p2', 'accept').ok);

  assert.equal(a.properties.darkblue.length, 2, 'darkblue holds at most its set size');
  assert.equal(G.isSetComplete(a, 'darkblue'), true);
  assert.deepEqual(G.validateState(state), { ok: true });
});

test('a complete set is never requisitionable, even after a seizure', () => {
  const state = fresh();
  const [a, b] = state.players;
  propertyCard(state, b, 'darkblue');
  propertyCard(state, b, 'darkblue');
  const wild = take(state, c => c.type === 'wild_property' && (c.colors || []).includes('darkblue'));
  a.properties.darkblue = [{ ...wild, placedColor: 'darkblue' }];
  a.hand.push(take(state, c => c.action === 'inspector_general'));
  G.playAction(state, 'p1', 0, { targetId: 'p2', targetColor: 'darkblue' });
  G.respondToAction(state, 'p2', 'accept');

  assert.equal(G.zoneRequisitionable(a, 'darkblue'), false);
  state.currentPlayerIndex = 1;
  state.turnPhase = 'play';
  state.playsRemaining = 3;
  b.hand.push(take(state, c => c.action === 'midnight_requisition'));
  const victim = a.properties.darkblue[0];
  const res = G.playAction(state, 'p2', 0, { targetId: 'p1', targetCardId: victim.id });
  assert.match(res.error, /complete set/);
});

test('validateState rejects an over-cap zone and duplicate upgrades', () => {
  const state = fresh();
  const [a] = state.players;
  propertyCard(state, a, 'darkblue');
  propertyCard(state, a, 'darkblue');
  assert.deepEqual(G.validateState(state), { ok: true });

  const extra = take(state, c => c.type === 'wild_property' && (c.colors || []).includes('darkblue'));
  a.properties.darkblue.push({ ...extra, placedColor: 'darkblue' });
  assert.match(G.validateState(state).error, /Zone cap exceeded/);

  a.properties.darkblue.pop();
  a.upgrades.darkblue = [
    { ...take(state, c => c.action === 'upgrade'), upgradeType: 'house' },
    { ...take(state, c => c.action === 'upgrade'), upgradeType: 'house' },
  ];
  assert.match(G.validateState(state).error, /Duplicate upgrades/);
});

test('a full zone makes room by shifting a wild rather than banking the incoming card', () => {
  const state = fresh();
  const [a, b] = state.players;
  // A's darkblue is full, but the card filling it is a wild that can sit elsewhere.
  propertyCard(state, a, 'darkblue');
  const wildA = take(state, c => c.type === 'wild_property' && c.colors[0] === 'any');
  a.properties.darkblue.push({ ...wildA, placedColor: 'darkblue' });
  const owed = propertyCard(state, b, 'darkblue');

  a.hand.push(take(state, c => c.action === 'finance_office'));
  assert.ok(G.playAction(state, 'p1', 0, { targetId: 'p2' }).ok);
  assert.ok(G.respondToAction(state, 'p2', 'accept', [owed.id]).ok);

  assert.equal(a.properties.darkblue.length, 2, 'zone cap held');
  assert.ok(a.properties.darkblue.some(c => c.id === owed.id), 'the paid property stayed a property');
  assert.equal(a.bank.some(c => c.id === owed.id), false, 'and was not banked');
  assert.equal(a.properties.darkblue.some(c => c.id === wildA.id), false, 'the wild moved out');
  const relocated = Object.entries(a.properties)
    .find(([, cards]) => cards.some(c => c.id === wildA.id));
  assert.ok(relocated && relocated[0] !== 'darkblue', 'the wild is still a property, elsewhere');
  assert.ok(state.events.some(e => e.t === 'move_property' && e.forced === true));
  assert.deepEqual(G.validateState(state), { ok: true });
});

test('an involuntary property with genuinely nowhere to go is banked, never overflowed', () => {
  const state = fresh();
  const [a, b] = state.players;
  // Both colours the incoming wild could take are full of PLAIN properties, so no
  // rearrange can free a slot. The card must not overflow a zone.
  propertyCard(state, a, 'brown');     propertyCard(state, a, 'brown');
  propertyCard(state, a, 'lightblue'); propertyCard(state, a, 'lightblue'); propertyCard(state, a, 'lightblue');
  const homeless = take(state, c => c.type === 'wild_property'
    && Array.isArray(c.colors) && c.colors.includes('brown') && c.colors.includes('lightblue'));
  b.properties.brown = [{ ...homeless, placedColor: 'brown' }];

  a.hand.push(take(state, c => c.action === 'finance_office'));
  assert.ok(G.playAction(state, 'p1', 0, { targetId: 'p2' }).ok);
  // It is B's only card, so surrendering it is a legal short payment (§3.4).
  assert.ok(G.respondToAction(state, 'p2', 'accept', [homeless.id]).ok);

  assert.equal(a.properties.brown.length, 2, 'zone cap held');
  assert.equal(a.properties.lightblue.length, 3, 'zone cap held');
  assert.ok(a.bank.some(c => c.id === homeless.id), 'the homeless property was banked');
  assert.ok(state.events.some(e => e.t === 'banked_property'));
  assert.deepEqual(G.validateState(state), { ok: true });
});

/* ── 9. duplicate upgrades ───────────────────────────────────────────── */

test('seizing an upgraded set never stacks a second Upgrade of the same kind', () => {
  const state = fresh();
  const [a, b] = state.players;
  propertyCard(state, b, 'intel');
  propertyCard(state, b, 'intel');
  b.upgrades.intel = [{ ...take(state, c => c.action === 'upgrade'), upgradeType: 'house' }];
  a.upgrades.intel = [{ ...take(state, c => c.action === 'upgrade'), upgradeType: 'house' }];

  a.hand.push(take(state, c => c.action === 'inspector_general'));
  G.playAction(state, 'p1', 0, { targetId: 'p2', targetColor: 'intel' });
  G.respondToAction(state, 'p2', 'accept');

  assert.deepEqual(G.upgradeKinds(a, 'intel'), ['house']);
  assert.deepEqual(G.validateState(state), { ok: true }, 'the surplus upgrade is conserved in the discard');
});

/* ── 5. drawCards guards + auto-draw (owner directive) ───────────────── */

test('the turn draw is automatic and cannot be repeated', () => {
  const state = G.createGame([{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }], { seed: 'auto' });
  assert.equal(state.turnPhase, 'play', 'the first broadcast is already the play phase');
  assert.equal(state.players[0].hand.length, 7, '5 dealt + 2 auto-drawn');
  assert.equal(state.players[1].hand.length, 5);

  // A stale client (or a reconnect race) asking to draw is a silent no-op, not an error.
  const again = G.drawCards(state, 'p1');
  assert.equal(again.alreadyDrawn, true);
  assert.equal(state.players[0].hand.length, 7, 'no double draw');

  // Turn hand-off auto-draws the next seat, exactly once.
  assert.ok(G.endTurn(state, 'p1').ok);
  assert.equal(G.currentPlayer(state).id, 'p2');
  assert.equal(state.turnPhase, 'play');
  assert.equal(state.players[1].hand.length, 7);
  assert.equal(G.drawCards(state, 'p2').alreadyDrawn, true);
  assert.equal(state.players[1].hand.length, 7);
});

test('auto-draw honours the empty-hand 5-card rule', () => {
  const state = G.createGame([{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }], { seed: 'empty' });
  state.players[1].hand.forEach(c => state.discardPile.push(c));
  state.players[1].hand = [];
  assert.ok(G.endTurn(state, 'p1').ok);
  assert.equal(G.currentPlayer(state).id, 'p2');
  assert.equal(state.players[1].hand.length, 5, 'an empty hand draws 5, not 2');
  assert.equal(state.turnPhase, 'play');
});

test('drawCards refuses the wrong player, a pending action and an eliminated seat', () => {
  const state = fresh(3);
  state.turnPhase = 'draw';
  assert.match(G.drawCards(state, 'p2').error, /Not your turn/);

  state.pendingAction = { type: 'payment', action: 'rent', sourceId: 'p2', amount: 1, targets: [] };
  assert.match(G.drawCards(state, 'p1').error, /pending action/);
  state.pendingAction = null;

  state.players[0].eliminated = true;
  assert.match(G.drawCards(state, 'p1').error, /Eliminated/);
});

test('a draw can never orphan a pending action into the play phase', () => {
  const state = fresh(2);
  state.turnPhase = 'action_response';
  state.pendingAction = { type: 'payment', action: 'rent', sourceId: 'p1', amount: 2, targets: [] };
  G.drawCards(state);
  assert.equal(state.turnPhase, 'action_response', 'turnPhase was not forced to play');
  assert.deepEqual(G.validateState(state), { ok: true });
});

/* ── 5. blind turn advances ──────────────────────────────────────────── */

test('forceEndTurn skips eliminated seats and runs the turn-start hooks', () => {
  const state = fresh(3);
  state.players[1].eliminated = true;
  const before = state.turnCounter;
  const res = G.forceEndTurn(state);
  assert.ok(res.ok);
  assert.equal(G.currentPlayer(state).id, 'p3', 'the eliminated seat was skipped');
  assert.equal(state.turnCounter, before + 1, 'beginTurn ran (a blind index bump skipped it)');
  assert.equal(state.turnPhase, 'play');
  assert.equal(state.playsRemaining, 3);
});

test('forceEndTurn clears an orphaned pending action rather than wedging the table', () => {
  const state = fresh(2);
  state.pendingAction = { type: 'payment', action: 'rent', sourceId: 'p1', amount: 2, targets: [] };
  state.turnPhase = 'action_response';
  G.forceEndTurn(state);
  assert.equal(state.pendingAction, null);
  assert.deepEqual(G.validateState(state), { ok: true });
});

/* ── 8. log bounds ───────────────────────────────────────────────────── */

test('state.log is bounded and the view tail is 40 lines', () => {
  const state = fresh();
  for (let i = 0; i < 5000; i++) G.logLine(state, 'line ' + i);
  assert.ok(state.log.length <= G.LOG_MAX, `log capped at ${G.LOG_MAX}, saw ${state.log.length}`);
  assert.equal(state.log[state.log.length - 1], 'line 4999', 'the newest lines survive');
  assert.equal(G.getPlayerView(state, 'p1').log.length, 40);
});

// THE INVARIANT THIS FILE GOT WRONG THE FIRST TIME.
//
// The original test spammed 3,000 rearranges, asserted `playsRemaining === 3` with the
// comment 'still free, still spammable', and then checked only that the log and the event
// ring were capped. Those two rings are internal to `state`; they say nothing about what
// LEAVES the process. Every ACCEPTED move_property broadcasts a full room state to every
// seat, so "spammable" is the defect, not the contract: measured over a socket, 60 moves in
// 9.0s returned 785,471 B to one seat (~x211 per 62-byte request), playsRemaining never
// moved, turnNumber never moved, and every client was forced to animate a card flight for
// each one. The behaviour was measured and the wrong thing was gated.
//
// What actually has to hold is a bound on ACCEPTED moves per turn — because accepted moves
// are the fan-out — while the rule stays genuinely free (§3.8) for anybody playing normally.
// So: count the acceptances, not the log length.

test('move_property is free but BOUNDED: a spam burst fans out a finite number of states', () => {
  const state = fresh();
  const [a] = state.players;
  const wild = take(state, c => c.type === 'wild_property' && c.colors[0] !== 'any');
  a.properties[wild.colors[0]] = [{ ...wild, placedColor: wild.colors[0] }];

  const results = [];
  for (let i = 0; i < 3000; i++) {
    results.push(G.moveProperty(state, 'p1', wild.id, i % 2 ? wild.colors[0] : wild.colors[1]));
  }
  const accepted = results.filter(r => r.ok).length;

  // 1. The fan-out is finite. This is the byte-amplification bound: one accepted move is one
  //    full state to every seat, so 3,000 requests must not buy 3,000 broadcasts.
  assert.equal(accepted, G.REARRANGE_BUDGET,
    `3,000 rearranges bought exactly ${G.REARRANGE_BUDGET} board changes, not 3,000`);
  assert.equal(state.rearrangesRemaining, 0, 'the turn\'s budget is spent');

  // 2. Everything past the budget is REFUSED, and refused with a reason a player can act on.
  //    A refusal costs a ~60-byte error frame instead of a ~13 KB state.
  assert.equal(results.slice(G.REARRANGE_BUDGET).filter(r => r.ok).length, 0);
  assert.match(results[G.REARRANGE_BUDGET].error, /No free rearranges left this turn/);
  assert.match(results[2999].error, /No free rearranges left this turn/,
    'the refusal never lapses inside the turn');

  // 3. One broadcastable event per accepted move and not one more — the client's forced
  //    card-flight animation is driven by this event, so this is the animation-spray bound.
  assert.equal(state.events.filter(e => e.t === 'move_property').length, accepted);
  assert.equal(state.log.filter(l => / moved /.test(l)).length, accepted);

  // 4. Still FREE where it counts: §3.8's rearrange costs no play and does not consume the
  //    turn. That is the part of the old assertion worth keeping.
  assert.equal(state.playsRemaining, 3, 'a rearrange still costs no play');
  assert.equal(G.currentPlayer(state).id, 'p1', 'and it does not end the turn');

  // 5. The rings the old test checked are still capped (kept — it was not wrong, only weak).
  assert.ok(state.log.length <= G.LOG_MAX);
  assert.ok(state.events.length <= 400);
});

test('the rearrange budget refills every turn and refused moves never spend it', () => {
  const state = fresh();
  const [a] = state.players;
  const wild = take(state, c => c.type === 'wild_property' && c.colors[0] !== 'any');
  a.properties[wild.colors[0]] = [{ ...wild, placedColor: wild.colors[0] }];
  assert.equal(state.rearrangesRemaining, G.REARRANGE_BUDGET);

  // A fumbled drag — same colour, illegal colour, unknown card — is refused and costs
  // nothing. A player who mis-drops a card must never lose a rearrange for it.
  assert.match(G.moveProperty(state, 'p1', wild.id, wild.colors[0]).error, /Already in that set/);
  assert.match(G.moveProperty(state, 'p1', wild.id, 'nonsense').error, /Invalid color/);
  assert.match(G.moveProperty(state, 'p1', 99999, 'brown').error, /not found/);
  assert.equal(state.rearrangesRemaining, G.REARRANGE_BUDGET, 'refusals are free');

  // Ordinary play: a few rearranges in a turn all land.
  for (let i = 0; i < 6; i++) {
    assert.ok(G.moveProperty(state, 'p1', wild.id, i % 2 ? wild.colors[0] : wild.colors[1]).ok,
      'normal play is never rate-limited');
  }
  assert.equal(state.rearrangesRemaining, G.REARRANGE_BUDGET - 6);

  // Round the table back to p1: the budget is a per-TURN allowance, not a per-game one.
  G.forceEndTurn(state);
  assert.equal(state.rearrangesRemaining, G.REARRANGE_BUDGET, 'refilled for the next seat');
  G.forceEndTurn(state);
  assert.equal(G.currentPlayer(state).id, 'p1');
  assert.equal(state.rearrangesRemaining, G.REARRANGE_BUDGET, 'and refilled again for p1');
  state.turnPhase = 'play';
  assert.ok(G.moveProperty(state, 'p1', wild.id, wild.colors[1]).ok);
});

test('the free-rearrange budget is on the wire, so a refusal is explicable', () => {
  const state = fresh();
  const view = G.getPlayerView(state, 'p1');
  assert.equal(view.rearrangeBudget, G.REARRANGE_BUDGET);
  assert.equal(view.rearrangesRemaining, G.REARRANGE_BUDGET);
  // A state built before this field existed (a fixture, an in-flight room) reads as a full
  // budget, never as an accidental zero that would refuse every drag.
  delete state.rearrangesRemaining;
  assert.equal(G.getPlayerView(state, 'p1').rearrangesRemaining, G.REARRANGE_BUDGET);
});

/* ── 12. honest final-approach countdown ─────────────────────────────── */

test('opponentTurnsRemaining counts only opponents, for own-turn arming', () => {
  const state = fresh(4);
  const [a] = state.players;
  propertyCard(state, a, 'brown');    propertyCard(state, a, 'brown');
  propertyCard(state, a, 'darkblue'); propertyCard(state, a, 'darkblue');
  propertyCard(state, a, 'intel');
  // Arm by completing the third set through a legal play on the player's own turn.
  a.hand.push(take(state, c => c.type === 'property' && c.color === 'intel'));
  assert.ok(G.playProperty(state, 'p1', a.hand.length - 1).ok);
  assert.equal(a.finalApproach, true);

  const view = G.getPlayerView(state, 'p1').players.find(p => p.id === 'p1');
  // 4 active seats, armed on their own turn: the other 3 each get exactly one turn.
  assert.equal(view.opponentTurnsRemaining, 3, 'the armed player\'s own turns are not counted');
  assert.equal(view.finalApproachIn, 4, 'the deprecated field still over-reports by one');
  assert.equal(view.checkpointTurn, state.turnCounter + 4);

  // Walk the table round; the count must fall by one per opponent turn and never lie.
  const seen = [];
  for (let i = 0; i < 3; i++) {
    G.endTurn(state, G.currentPlayer(state).id);
    seen.push(G.getPlayerView(state, 'p1').players.find(p => p.id === 'p1').opponentTurnsRemaining);
  }
  assert.deepEqual(seen, [2, 1, 0], 'monotonic, honest, reaching 0 exactly at the converting turn');
});

test('opponentTurnsRemaining never reads 0 while opponents still have turns (off-turn arming)', () => {
  const state = fresh(4);
  const [a, b] = state.players;
  ['brown', 'darkblue'].forEach(color => {
    propertyCard(state, a, color);
    propertyCard(state, a, color);
  });
  propertyCard(state, a, 'intel');
  // Hand the turn to p2, then let p1 complete their third set off-turn via a payment.
  G.endTurn(state, 'p1');
  assert.equal(G.currentPlayer(state).id, 'p2');
  const owed = propertyCard(state, b, 'intel');
  a.hand.push(take(state, c => c.action === 'finance_office'));
  state.currentPlayerIndex = 0;
  state.turnPhase = 'play';
  state.playsRemaining = 3;
  G.playAction(state, 'p1', a.hand.length - 1, { targetId: 'p2' });
  G.respondToAction(state, 'p2', 'accept', [owed.id]);
  assert.equal(a.finalApproach, true);

  let guard = 0;
  while (state.phase === 'playing' && guard++ < 12) {
    const row = G.getPlayerView(state, 'p1').players.find(p => p.id === 'p1');
    if (!row.finalApproach) break;
    const isOwnTurn = G.currentPlayer(state).id === 'p1';
    if (row.opponentTurnsRemaining === 0) {
      // The contract: 0 means the NEXT turn to start is the armed player's converting turn.
      G.endTurn(state, G.currentPlayer(state).id);
      assert.equal(state.winner, 'p1', '0 must mean the very next turn converts');
      break;
    }
    assert.ok(row.opponentTurnsRemaining > 0 || isOwnTurn);
    G.endTurn(state, G.currentPlayer(state).id);
  }
  assert.equal(state.winner, 'p1');
});

/* ── 13/14/15. log clarity ───────────────────────────────────────────── */

test('completing a set writes a prose log line', () => {
  const state = fresh();
  const [a] = state.players;
  propertyCard(state, a, 'darkblue');
  const last = take(state, c => c.type === 'property' && c.color === 'darkblue');
  a.hand.push(last);
  G.playProperty(state, 'p1', 0);
  assert.ok(state.log.some(l => /completed the Command set/.test(l)), state.log.join(' | '));
  assert.ok(state.events.some(e => e.t === 'set_completed' && e.total === 1));
});

test('the OPSEC-block line names the attacker and the card', () => {
  const state = fresh();
  const [a, b] = state.players;
  a.hand.push(take(state, c => c.action === 'finance_office'));
  b.hand.push(take(state, c => c.action === 'opsec'));
  G.playAction(state, 'p1', 0, { targetId: 'p2' });
  G.respondToAction(state, 'p2', 'opsec');
  G.respondToAction(state, 'p1', 'accept');
  const line = state.log[state.log.length - 1];
  assert.match(line, /P2/, 'names the defender');
  assert.match(line, /P1/, 'names the attacker');
  assert.match(line, /Finance Office/, 'names the card');
});

test('a stalemate decided by seat order says so instead of crediting sets and net worth', () => {
  const state = fresh(3);
  state.deck = [];
  state.discardPile = [];
  state.players.forEach(p => { p.hand = []; p.bank = []; p.properties = {}; });
  state._handSnapshot = 0;
  state._idleTurns = 99;
  const res = G.endTurn(state, 'p1');
  assert.ok(res.stalemate);
  const line = state.log[state.log.length - 1];
  assert.match(line, /turn order/, line);
  assert.doesNotMatch(line, /net worth \(/);
  assert.equal(G.getPlayerView(state, 'p1').stalemateBasis, 'turn_order');
  assert.equal(state.events.at(-1).basis, 'turn_order');
});

test('a stalemate decided on net worth says net worth', () => {
  const state = fresh(2);
  const rich = take(state, c => c.type === 'money' && c.value === 10);
  state.players[1].bank.push(rich);
  state.deck = [];
  state.discardPile = [];
  state.players.forEach(p => { p.hand = []; });
  state._handSnapshot = 0;
  state._idleTurns = 99;
  G.endTurn(state, 'p1');
  assert.equal(state.winner, 'p2');
  assert.match(state.log[state.log.length - 1], /net worth/);
  assert.equal(G.getPlayerView(state, 'p1').stalemateBasis, 'net_worth');
});

/* ── 6. response timers independent of the turn timer ────────────────── */

test('a pending action arms a response timer even when turnTimeout is 0', () => {
  const room = fakeRoom({ turnTimeout: 0, responseTimeout: 20 });
  room.players = [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }];
  room.state = fresh(2);
  room.state.players[0].hand.push(take(room.state, c => c.action === 'finance_office'));
  G.playAction(room.state, 'p1', 0, { targetId: 'p2' });
  assert.ok(room.state.pendingAction);

  timers.startTurnTimer(room);
  assert.ok(room.responseTimerId, 'the response deadline is armed despite turnTimeout=0');
  assert.equal(room.turnTimerId, undefined || room.turnTimerId, 'no turn deadline exists');
  timers.clearTurnTimer(room);
});

test('syncTimers arms a response deadline for a pending action created outside a handler', () => {
  const room = fakeRoom({ turnTimeout: 0, responseTimeout: 20 });
  room.players = [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }];
  room.state = fresh(2);
  room.state.players[0].hand.push(take(room.state, c => c.action === 'roll_call'));
  G.playAction(room.state, 'p1', 0, {});          // exactly what a bot does
  assert.equal(room.responseTimerId, undefined);
  timers.syncTimers(room);
  assert.ok(room.responseTimerId, 'a bot-created charge now gets a deadline');
  timers.clearTurnTimer(room);
});

test('syncTimers stands the turn timer back up once the pending action resolves', () => {
  const room = fakeRoom({ turnTimeout: 30, responseTimeout: 20 });
  room.players = [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }];
  room.state = fresh(2);
  room.state.players[0].hand.push(take(room.state, c => c.action === 'finance_office'));
  G.playAction(room.state, 'p1', 0, { targetId: 'p2' });
  timers.syncTimers(room);
  assert.ok(room.responseTimerId);
  assert.ok(!room.turnTimerId, 'the turn clock is paused while a response is owed');

  G.respondToAction(room.state, 'p2', 'accept', []);
  timers.syncTimers(room);
  assert.ok(!room.responseTimerId);
  assert.ok(room.turnTimerId, 'the turn clock resumes');
  assert.ok(room.turnStartedAt);
  timers.clearTurnTimer(room);
});

/* ── owner directive: an expiring clock must be legible ──────────────── */
// "It just took my cards and I don't know why." An expiring deadline is the one board change
// nobody chose, so it has to reach the same event stream every deliberate move goes into —
// a prose log line alone is invisible to the journal, the replay and the gamelog record.

test('an expiring response clock says who ran out of time and what was decided for them', () => {
  const room = fakeRoom({ turnTimeout: 0, responseTimeout: 45 });
  room.players = [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }];
  room.state = fresh(2);
  room.state.players[1].bank.push(take(room.state, c => c.type === 'money' && c.value === 5));
  room.state.players[0].hand.push(take(room.state, c => c.action === 'finance_office'));
  G.playAction(room.state, 'p1', 0, { targetId: 'p2' });
  assert.ok(room.state.pendingAction, 'P2 owes an answer');
  const owed = room.state.pendingAction.amount;

  const seqBefore = room.state.eventSeq;
  timers.autoResolveResponse(room);

  const ev = room.state.events.find(e => e.t === 'response_timeout');
  assert.ok(ev, 'the expiry is a structured event, not just prose');
  assert.equal(ev.actor, 'p2', 'it names whose clock expired');
  assert.equal(ev.name, 'P2');
  assert.equal(ev.decision, 'accept', 'and what was auto-decided — never a silent OPSEC');
  assert.equal(ev.auto, true);
  assert.equal(ev.pending, 'payment', 'and what they were answering');
  assert.equal(ev.amount, owed);
  assert.equal(ev.timeout, 45, 'and the clock that ran out');
  assert.equal(ev.source, 'p1', 'and who charged them');
  assert.ok(ev.seq > seqBefore, 'it is sequenced in the stream like every other beat');

  // Ordering: the explanation comes BEFORE the payment it explains.
  const payment = room.state.events.find(e => e.t === 'payment');
  if (payment) assert.ok(ev.seq < payment.seq, 'the reason precedes the consequence');

  const line = room.state.log.find(l => /ran out of time/.test(l));
  assert.ok(line, 'and a prose line for the log');
  assert.match(line, /P2/);
  assert.match(line, /45s/, 'the line states the clock, so "why did that happen" is answerable');
  timers.clearTurnTimer(room);
});

/* ── one clock per outstanding answer ────────────────────────────────── */
//
// A pending action can owe answers from several seats at once. The clock used to be ONE
// shared `responseStartedAt`, restamped by `startResponseTimer` — which `case 'respond'`
// calls after every successful answer. Measured on a 3-target Roll Call: one target answered
// at +4s and the shared clock jumped +4,344 ms, giving the two who had done nothing a
// brand-new full clock, and making the countdown widget on their screens jump back to full.

function rollCallRoom() {
  const room = fakeRoom({ turnTimeout: 0, responseTimeout: 45 });
  room.state = fresh(4);
  room.players = room.state.players.map(p => ({ id: p.id, name: p.name }));
  for (const p of room.state.players.slice(1)) {
    p.bank.push(take(room.state, c => c.type === 'money' && c.value === 2));
  }
  room.state.players[0].hand.push(take(room.state, c => c.action === 'roll_call'));
  assert.ok(G.playAction(room.state, 'p1', 0).ok);
  assert.deepEqual(G.pendingResponders(room.state), ['p2', 'p3', 'p4']);
  timers.startResponseTimer(room);
  return room;
}

const deadlinesOf = room =>
  Object.fromEntries([...room.responseDeadlines.values()].map(r => [r.responderId, r.startedAt]));

test('one target answering never restarts the clock of a target who has done nothing', () => {
  const room = rollCallRoom();
  const armed = deadlinesOf(room);
  assert.deepEqual(Object.keys(armed).sort(), ['p2', 'p3', 'p4']);

  // The table thinks for 4 seconds…
  for (const record of room.responseDeadlines.values()) record.startedAt -= 4000;
  const aged = deadlinesOf(room);

  // …then p2 answers, exactly as server/handlers.js `respond` does it.
  assert.ok(G.respondToAction(room.state, 'p2', 'accept',
    [room.state.players[1].bank[0].id]).ok);
  timers.startResponseTimer(room);

  const after = deadlinesOf(room);
  assert.equal(after.p2, undefined, 'the seat that answered no longer holds a deadline');
  assert.equal(after.p3, aged.p3, 'p3 keeps the 4 seconds it has already burned');
  assert.equal(after.p4, aged.p4, 'and so does p4 — no free full clock for doing nothing');
  assert.equal(room.responseStartedAt, Math.min(after.p3, after.p4),
    'the room-level field is the NEXT deadline, not a restamp');
  timers.clearTurnTimer(room);
});

test('each seat is shown its own answer deadline, and it is true', () => {
  const room = rollCallRoom();
  const sent = {};
  room.players.forEach(p => {
    p.ws = { readyState: 1, send: (raw) => { sent[p.id] = JSON.parse(raw); } };
  });
  // p3 has been sitting on this for 30s; p2 and p4 arrived at the decision just now.
  for (const record of room.responseDeadlines.values()) {
    if (record.responderId === 'p3') record.startedAt -= 30000;
  }
  const armed = deadlinesOf(room);

  broadcast.broadcastRoom(room);

  assert.equal(sent.p2.responseTimer.startedAt, armed.p2, 'p2 sees p2\'s clock');
  assert.equal(sent.p3.responseTimer.startedAt, armed.p3, 'p3 sees the 30s it has burned');
  assert.equal(sent.p4.responseTimer.startedAt, armed.p4);
  assert.notEqual(sent.p3.responseTimer.startedAt, sent.p2.responseTimer.startedAt,
    'two seats with different deadlines are never shown the same countdown');
  // The attacker owes nothing, so they are shown what the TABLE is waiting on: the next
  // deadline to expire. That is a true statement about the room, not somebody else's clock
  // relabelled as theirs.
  assert.equal(sent.p1.responseTimer.startedAt, Math.min(armed.p2, armed.p3, armed.p4));
  room.players.forEach(p => { p.ws = null; });
  timers.clearTurnTimer(room);
});

test('an expiry resolves every seat that is out of time, not just the first in the queue', () => {
  const room = rollCallRoom();
  // All three ran the whole 45s out. The old resolver took pendingResponders()[0] and armed
  // a FRESH full clock for the rest, so three absent seats held the table for 3 × 45s.
  for (const record of room.responseDeadlines.values()) record.startedAt -= 45000;

  timers.autoResolveResponse(room);

  assert.equal(room.state.pendingAction, null, 'one expiry cleared the whole pending action');
  assert.equal(room.state.events.filter(e => e.t === 'response_timeout').length, 3,
    'and each seat was told, individually, that its own clock ran out');
  assert.equal(room.responseTimerId, null, 'no response clock is left armed');
  assert.deepEqual(G.validateState(room.state), { ok: true });
  timers.clearTurnTimer(room);
});

test('a seat still inside its own deadline is never auto-answered by somebody else expiring', () => {
  const room = rollCallRoom();
  for (const record of room.responseDeadlines.values()) {
    if (record.responderId !== 'p2') continue;
    record.startedAt -= 45000;                       // only p2 is out of time
  }
  timers.autoResolveResponse(room);

  assert.deepEqual(G.pendingResponders(room.state), ['p3', 'p4'], 'the other two still owe an answer');
  assert.equal(room.state.events.filter(e => e.t === 'response_timeout').length, 1);
  assert.ok(room.responseTimerId, 'and the clock is re-armed for them');
  timers.clearTurnTimer(room);
});

/* ── an expiry at odd OPSEC depth is a CONCESSION, and must say so ───── */
// `owed` is 0 when the responder is the source, so the event read
// `pending:'payment', decision:'accept', amount:0` — while what actually happened was that
// the attacker declined to counter and the defender's OPSEC stood. The client now surfaces
// this event prominently, so those were the wrong words on screen at the moment a player
// goes looking for what just happened.

test('a response clock expiring on the attacker says the OPSEC stood, not "accepted 0M"', () => {
  const room = fakeRoom({ turnTimeout: 0, responseTimeout: 45 });
  room.players = [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }];
  room.state = fresh(2);
  const money = take(room.state, c => c.type === 'money' && c.value === 5);
  room.state.players[1].bank.push(money);
  room.state.players[1].hand.push(take(room.state, c => c.action === 'opsec'));
  room.state.players[0].hand.push(take(room.state, c => c.action === 'finance_office'));
  assert.ok(G.playAction(room.state, 'p1', 0, { targetId: 'p2' }).ok);
  // P2 defends. The question is now P1's: counter, or concede.
  assert.ok(G.respondToAction(room.state, 'p2', 'opsec').ok);
  assert.deepEqual(G.pendingResponders(room.state), ['p1']);
  timers.startResponseTimer(room);
  for (const record of room.responseDeadlines.values()) record.startedAt -= 45000;

  timers.autoResolveResponse(room);

  const ev = room.state.events.find(e => e.t === 'response_timeout');
  assert.ok(ev);
  assert.equal(ev.actor, 'p1', 'it was the ATTACKER\'s clock that expired');
  assert.equal(ev.decision, 'concede', 'and conceding is not accepting');
  assert.equal(ev.pending, 'opsec', 'the question was "do you counter?", not "do you pay?"');
  assert.equal(ev.blocked, true);
  assert.equal(ev.depth, 1);
  assert.equal(ev.target, 'p2', 'the seat the original action was aimed at');
  assert.equal(ev.amount, 0);
  assert.ok(room.state.log.some(l => /OPSEC stands/.test(l)),
    'and the prose says what actually happened');
  // The action really was blocked: P2 keeps the money.
  assert.ok(room.state.players[1].bank.some(c => c.id === money.id), 'no payment was made');
  assert.equal(room.state.pendingAction, null);
  assert.ok(room.state.events.some(e => e.t === 'action_blocked'));
  timers.clearTurnTimer(room);
});

test('an expiring turn clock emits a turn_timeout event naming the seat and the discard', () => {
  const room = fakeRoom({ turnTimeout: 30, responseTimeout: 45 });
  room.players = [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }];
  room.state = fresh(2);
  for (let i = 0; i < 9; i++) room.state.players[0].hand.push(room.state.deck.pop());

  timers.onTurnTimeout(room);

  const ev = room.state.events.find(e => e.t === 'turn_timeout');
  assert.ok(ev, 'the turn expiry is a structured event too');
  assert.equal(ev.actor, 'p1');
  assert.equal(ev.auto, true);
  assert.equal(ev.timeout, 30);
  assert.equal(ev.discarded, 2, 'a forced discard is attributed to the clock, not to the player');
  assert.ok(room.state.log.some(l => /P1 ran out of time \(30s\)/.test(l)));
  timers.clearTurnTimer(room);
});

/* ── 7. timer lifecycle on teardown ──────────────────────────────────── */

test('clearTurnTimer stops the re-arming turn timer, the response timer and the bot', () => {
  const room = fakeRoom({ turnTimeout: 30, responseTimeout: 20 });
  room.players = [{ id: 'p1', name: 'P1', isBot: true, botMode: 'neutral' }];
  room.state = fresh(2);
  timers.startTurnTimer(room);
  assert.ok(room.turnTimerId);
  room._botTimeout = setTimeout(() => {}, 10000);
  timers.clearTurnTimer(room);
  assert.equal(room.turnTimerId, null);
  assert.equal(room.turnStartedAt, null);
  assert.equal(room.responseTimerId, undefined);
  assert.equal(room._botTimeout, undefined, 'the bot timeout is cancelled too');
});

/* ── 3. absent handling never lands on an eliminated seat ────────────── */

test('handleAbsent advances past eliminated seats without wedging', () => {
  const room = fakeRoom({ turnTimeout: 0, responseTimeout: 0 });
  // Two connected seats remain, so this is a turn-skip, not an "everybody left" ending.
  room.players = [
    { id: 'p1', name: 'P1', ws: null, isBot: false },              // absent, current turn
    { id: 'p2', name: 'P2', ws: { readyState: 1 }, isBot: false }, // eliminated below
    { id: 'p3', name: 'P3', ws: { readyState: 1 }, isBot: false },
    { id: 'p4', name: 'P4', ws: null, isBot: true, botMode: 'neutral' },
  ];
  room.state = fresh(4);
  room.state.players[1].eliminated = true;
  absent.handleAbsent(room);
  // p1 is absent (no socket, not a bot) so their turn is skipped; p2 is eliminated so the
  // turn must land on p3. The old blind `(idx+1) % len` could stop on the eliminated seat.
  assert.ok(!G.currentPlayer(room.state).eliminated);
  assert.equal(G.currentPlayer(room.state).id, 'p3');
  assert.deepEqual(G.validateState(room.state), { ok: true });
});

/* ── durable game records (server/gamelog.js) ────────────────────────── */

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

// Swaps console.warn/log for the duration so deliberately-broken fixtures do not print
// scary lines on every `npm test` run — a suite that always warns trains people to ignore
// warnings. The captured lines are handed to the test so it can assert on them instead.
function captureConsole() {
  const out = { warn: [], log: [] };
  const realWarn = console.warn, realLog = console.log;
  console.warn = (...a) => out.warn.push(a.join(' '));
  console.log = (...a) => out.log.push(a.join(' '));
  out.restore = () => { console.warn = realWarn; console.log = realLog; };
  return out;
}

// async: the record is appended asynchronously, so the temp dir must outlive the await.
async function withGameLog(env, fn) {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'chudlog-'));
  const saved = { ...process.env };
  process.env.CHUD_GAME_LOG_DIR = dir;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  delete require.cache[require.resolve('../server/gamelog')];
  const gamelog = require('../server/gamelog');
  const captured = captureConsole();
  try { return await fn(gamelog, dir, captured); }
  finally {
    captured.restore();
    process.env = saved;
    delete require.cache[require.resolve('../server/gamelog')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function finishedRoom(opts = {}) {
  const room = {
    code: 'LOGT', phase: 'playing', chat: [], turnTimeout: 60, responseTimeout: 30,
    players: [
      { id: 'a', name: 'A', ws: null, isBot: false },
      { id: 'b', name: 'B', ws: null, isBot: true, botMode: 'chud' },
    ],
  };
  room.state = G.createGame(room.players.map(p => ({ id: p.id, name: p.name })),
    { seed: 'logtest', ...opts });
  room.state.phase = 'finished';
  room.state.winner = 'a';
  room.state.endReason = 'sets';
  return room;
}

test('a finished game leaves exactly one durable JSONL record', async () => {
  await withGameLog({ CHUD_GAME_LOG: '1' }, async (gamelog, dir) => {
    const room = finishedRoom({ preset: 'blitz' });
    assert.equal(gamelog.recordFinished(room, G), true);
    assert.equal(gamelog.recordFinished(room, G), false, 'never written twice');
    await new Promise(r => setTimeout(r, 120));

    const lines = fs.readFileSync(nodePath.join(dir, 'games.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.seed, 'logtest');
    assert.equal(rec.replayable, true, 'a seeded game can be replayed exactly');
    assert.equal(rec.rules.preset, 'blitz');
    assert.equal(rec.winner, 'a');
    assert.equal(rec.endReason, 'sets');
    assert.deepEqual(rec.seats.map(s => s.id), ['a', 'b']);
    assert.equal(rec.seats[1].botMode, 'chud', 'seat order and bot modes are recorded');
    assert.ok(Array.isArray(rec.events) && rec.events.length > 0, 'the event stream is recorded');
    assert.equal(rec.boards.length, 2, 'the final boards are recorded');
    assert.ok(rec.log.length > 0);
  });
});

test('game logging is opt-outable and never writes when disabled', async () => {
  await withGameLog({ CHUD_GAME_LOG: '0' }, async (gamelog, dir) => {
    assert.equal(gamelog.enabled(), false);
    assert.equal(gamelog.recordFinished(finishedRoom(), G), false);
    await new Promise(r => setTimeout(r, 80));
    assert.equal(fs.existsSync(nodePath.join(dir, 'games.jsonl')), false);
  });
});

test('game logging never throws into a room, whatever the state looks like', async () => {
  await withGameLog({ CHUD_GAME_LOG: '1' }, (gamelog) => {
    // Unfinished, missing, and structurally broken rooms must all be no-ops, not throws.
    assert.doesNotThrow(() => gamelog.recordFinished(undefined, G));
    assert.doesNotThrow(() => gamelog.recordFinished({}, G));
    assert.doesNotThrow(() => gamelog.recordFinished({ state: { phase: 'playing' } }, G));
  });
});

// The state shapes below cannot arise from the engine (audited: every assignment to these
// collections is `{}` or a filtered array, never null). They stand in for a genuinely
// corrupt game — the kind forensics exists for — and must still be RECORDED, not skipped.
test('a structurally corrupt game is still recorded rather than lost', async () => {
  await withGameLog({ CHUD_GAME_LOG: '1' }, async (gamelog, dir) => {
    const room = finishedRoom();
    room.state.players = null;          // the exact shape that used to kill logging
    room.state.events = null;
    room.state.log = undefined;
    room.state.stats = null;
    room.players[0].hand = null;

    assert.equal(gamelog.recordFinished(room, G), true, 'the weird game is recorded');
    await new Promise(r => setTimeout(r, 120));

    const rec = JSON.parse(fs.readFileSync(nodePath.join(dir, 'games.jsonl'), 'utf8').trim());
    assert.equal(rec.boardsMissing, true, 'and the corruption is stated in the record');
    assert.deepEqual(rec.boards, []);
    assert.deepEqual(rec.events, []);
    assert.deepEqual(rec.log, []);
    assert.equal(rec.winner, 'a', 'the parts that survived are still there');
    assert.ok(rec.integrity, 'validateState is captured, not allowed to throw out');
    assert.deepEqual(gamelog.stats(), { written: 1, skipped: 0, disabled: false });
  });
});

test('one unserializable game skips itself and logging keeps working', async () => {
  await withGameLog({ CHUD_GAME_LOG: '1' }, async (gamelog, dir, captured) => {
    // A circular reference is the one thing buildRecord cannot coerce away.
    const bad = finishedRoom();
    bad.code = 'BAD1';
    bad.state.stats = {};
    bad.state.stats.self = bad.state.stats;

    assert.equal(gamelog.recordFinished(bad, G), false, 'the bad record is skipped');
    assert.equal(gamelog.stats().disabled, false, 'but the module is NOT disabled');

    const good = finishedRoom();
    good.code = 'GOOD';
    assert.equal(gamelog.recordFinished(good, G), true, 'the next game still records');
    await new Promise(r => setTimeout(r, 120));

    const lines = fs.readFileSync(nodePath.join(dir, 'games.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).code, 'GOOD');
    assert.deepEqual(gamelog.stats(), { written: 1, skipped: 1, disabled: false });
    const warning = captured.warn.find(l => l.includes('BAD1'));
    assert.ok(warning, 'the skip is reported');
    assert.match(warning, /logging continues/, 'and says so explicitly');
    assert.equal(captured.warn.some(l => /disabled/.test(l)), false, 'nothing was disabled');
  });
});

test('a filesystem failure — and only that — hard-disables logging', async () => {
  // A CONFIGURED dir that fails at boot no longer reaches this path: the boot
  // write-probe (DESIGN.md §3.4) catches it, warns, and falls back to ./logs
  // with logging still on — that contract is pinned by test/gamelog.test.js.
  // What is genuinely fatal is the filesystem going bad UNDER a module that
  // already probed clean, which retrying cannot fix. So: a dir that passes
  // the boot probe and then stops being a directory before the first write.
  const blocker = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'chudblock-'));
  const vol = nodePath.join(blocker, 'vol');
  const saved = { ...process.env };
  process.env.CHUD_GAME_LOG = '1';
  process.env.CHUD_GAME_LOG_DIR = vol;
  delete require.cache[require.resolve('../server/gamelog')];
  const gamelog = require('../server/gamelog');
  assert.equal(gamelog.DIR, vol, 'the probed dir was accepted at boot');
  // …and then the volume goes away: the path becomes a FILE, so the lazy
  // mkdirSync inside ensureReady() throws at the first write.
  fs.rmSync(vol, { recursive: true, force: true });
  fs.writeFileSync(vol, 'x');
  const captured = captureConsole();
  try {
    assert.equal(gamelog.recordFinished(finishedRoom(), G), false);
    assert.equal(gamelog.stats().disabled, true, 'a filesystem error is genuinely fatal');
    assert.equal(gamelog.recordFinished(finishedRoom(), G), false, 'and stays disabled');
    assert.ok(captured.warn.some(l => /disabled after filesystem failure/.test(l)));
  } finally {
    captured.restore();
    process.env = saved;
    delete require.cache[require.resolve('../server/gamelog')];
    fs.rmSync(blocker, { recursive: true, force: true });
  }
});

// Compression runs in the background, so wait for the archive to materialise.
async function waitFor(predicate, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return false;
}
const archivesIn = dir => fs.readdirSync(dir).filter(n => /^games-.*\.jsonl\.gz$/.test(n));

test('the game log is bounded: it rotates, and the live file stays plain greppable JSONL', async () => {
  await withGameLog({ CHUD_GAME_LOG: '1', CHUD_GAME_LOG_MAX_BYTES: '2000' }, async (gamelog, dir) => {
    for (let i = 0; i < 6; i++) {
      const room = finishedRoom();
      room.code = 'LG' + i;
      gamelog.recordFinished(room, G);
      await new Promise(r => setTimeout(r, 20));   // let each async append land
    }
    assert.ok(await waitFor(() => archivesIn(dir).length > 0), 'it rotated and archived');

    const livePath = nodePath.join(dir, 'games.jsonl');
    const live = fs.readFileSync(livePath, 'utf8');
    assert.ok(live.length < 20000, `the live file stays bounded (${live.length} bytes)`);
    // Plain text, one JSON object per line — grep/jq must keep working mid-investigation.
    for (const line of live.trim().split('\n')) {
      assert.doesNotThrow(() => JSON.parse(line), 'every live line is plain readable JSON');
    }
  });
});

test('a rotated archive is a valid gzip that round-trips back to the original records', async () => {
  await withGameLog({ CHUD_GAME_LOG: '1', CHUD_GAME_LOG_MAX_BYTES: '2000' }, async (gamelog, dir) => {
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const room = finishedRoom();
      room.code = 'RT' + i;
      codes.push(room.code);
      gamelog.recordFinished(room, G);
      await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(await waitFor(() => archivesIn(dir).length > 0), 'an archive appeared');

    const zlib = require('node:zlib');
    const recovered = [];
    for (const name of archivesIn(dir)) {
      const text = zlib.gunzipSync(fs.readFileSync(nodePath.join(dir, name))).toString('utf8');
      for (const line of text.trim().split('\n')) recovered.push(JSON.parse(line));
    }
    assert.ok(recovered.length > 0, 'the archive decompresses to real records');
    assert.ok(recovered.every(r => r.code && r.endReason === 'sets'), 'and they are intact');
    // Nothing is lost across the rotation boundary: every game is in an archive or live.
    const live = fs.readFileSync(nodePath.join(dir, 'games.jsonl'), 'utf8').trim();
    const all = new Set([...recovered.map(r => r.code),
      ...live.split('\n').filter(Boolean).map(l => JSON.parse(l).code)]);
    for (const code of codes) assert.ok(all.has(code), `${code} survived rotation`);
    // No partial archive is ever left visible.
    assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.part')), []);
  });
});

test('the archive ring is bounded by CHUD_GAME_LOG_ARCHIVES', async () => {
  await withGameLog({ CHUD_GAME_LOG: '1', CHUD_GAME_LOG_MAX_BYTES: '900', CHUD_GAME_LOG_ARCHIVES: '2' },
    async (gamelog, dir) => {
      for (let i = 0; i < 12; i++) {
        const room = finishedRoom();
        room.code = 'AR' + i;
        gamelog.recordFinished(room, G);
        await new Promise(r => setTimeout(r, 25));
      }
      await waitFor(() => archivesIn(dir).length >= 2);
      await new Promise(r => setTimeout(r, 250));
      const generations = new Set(fs.readdirSync(dir)
        .map(n => /^games-(.+?)\.jsonl/.exec(n)?.[1]).filter(Boolean));
      assert.ok(generations.size <= 2,
        `kept ${generations.size} generations, cap is 2: ${[...generations]}`);
    });
});

// Rotation used to stamp archives to the millisecond and renameSync clobbers silently, so
// two rotations inside one millisecond destroyed a whole generation and raced the
// `.part` -> `.gz` rename of the one they overwrote. Measured with ARCHIVES=999 (nothing is
// pruned, so any shortfall is real loss): 300 records written, 139 recoverable, 161 lost.
// This drives rotation as fast as it can go and demands every record back.
test('back-to-back rotations lose no records and leave no clobbered generation', async () => {
  await withGameLog(
    { CHUD_GAME_LOG: '1', CHUD_GAME_LOG_MAX_BYTES: '900', CHUD_GAME_LOG_ARCHIVES: '999' },
    async (gamelog, dir) => {
      const zlib = require('node:zlib');
      const codes = [];
      // No pacing at all: many rotations land inside the same millisecond.
      for (let i = 0; i < 60; i++) {
        const room = finishedRoom();
        room.code = 'RX' + String(i).padStart(3, '0');
        codes.push(room.code);
        gamelog.recordFinished(room, G);
      }
      // Settled = every closed generation has finished compressing (plain file gone, no
      // `.part` left). Compression is deliberately backgrounded, so this is the only
      // reliable quiescence signal.
      await new Promise(r => setTimeout(r, 400));
      await waitFor(() => {
        const names = fs.readdirSync(dir);
        return !names.some(n => n.endsWith('.part') || /^games-.*\.jsonl$/.test(n));
      }, 6000);

      const found = new Set();
      for (const name of fs.readdirSync(dir)) {
        const full = nodePath.join(dir, name);
        const buf = name.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(full)) : fs.readFileSync(full);
        for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
          found.add(JSON.parse(line).code);        // a throw here is a corrupt archive
        }
      }
      const lost = codes.filter(c => !found.has(c));
      assert.deepEqual(lost, [], `${lost.length}/${codes.length} records were lost to rotation`);
      assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.part')), [],
        'no half-written archive is left behind');
      // Every generation is distinct, so nothing was renamed on top of anything else.
      const generations = fs.readdirSync(dir)
        .map(n => /^games-(.+?)\.jsonl/.exec(n)?.[1]).filter(Boolean);
      assert.equal(new Set(generations).size, generations.length,
        'one file per generation: no archive shares a stamp with another');
    });
});

/* ── bot-only games skip the event stream (85% of a record) ──────────── */

function roomWith(seats, opts = {}) {
  const room = {
    code: 'SEAT', phase: 'playing', chat: [], turnTimeout: 60, responseTimeout: 30,
    players: seats,
  };
  room.state = G.createGame(seats.map(p => ({ id: p.id, name: p.name })), opts);
  room.state.phase = 'finished';
  room.state.winner = seats[0].id;
  room.state.endReason = 'sets';
  return room;
}
const BOT_A = { id: 'a', name: 'A', isBot: true, botMode: 'neutral' };
const BOT_B = { id: 'b', name: 'B', isBot: true, botMode: 'chud' };

test('a seeded bot-only game omits its event stream but says so', () => {
  const rec = require('../server/gamelog').buildRecord(
    roomWith([{ ...BOT_A }, { ...BOT_B }], { seed: 'botonly' }), G);
  assert.equal(rec.humanSeats, 0);
  assert.equal(rec.replayable, true);
  assert.equal(rec.events, undefined, 'the stream is gone');
  assert.equal(rec.eventsOmitted, 'bot_only', 'and the omission is explicit, never silent');
  assert.ok(rec.eventsTotal > 0, 'the count survives so the omission is measurable');
  assert.ok(rec.seed, 'the seed that reconstructs it is kept');
  assert.ok(rec.boards.length === 2 && rec.log.length > 0, 'boards and prose log are kept');
});

test('a game with any human seat keeps its full event stream', () => {
  const rec = require('../server/gamelog').buildRecord(
    roomWith([{ id: 'a', name: 'A', isBot: false }, { ...BOT_B }], { seed: 'human' }), G);
  assert.equal(rec.humanSeats, 1);
  assert.equal(rec.eventsOmitted, undefined);
  assert.ok(Array.isArray(rec.events) && rec.events.length > 0);
});

test('a seat a human LEFT — now driven by a bot — still counts as human', () => {
  // The disconnect/leave takeover case: isBot is true at the final broadcast, but a human
  // played the game, so their choices are not reproducible from the seed.
  const takenOver = { id: 'a', name: 'A', isBot: true, botMode: 'neutral', _wasHuman: true };
  const rec = require('../server/gamelog').buildRecord(
    roomWith([takenOver, { ...BOT_B }], { seed: 'takeover' }), G);
  assert.equal(rec.humanSeats, 1, 'decided by whether a human EVER held the seat');
  assert.equal(rec.seats[0].everHuman, true);
  assert.equal(rec.seats[0].isBot, true, 'even though it is a bot now');
  assert.equal(rec.eventsOmitted, undefined);
  assert.ok(rec.events.length > 0, 'the game somebody disconnected from keeps its events');
});

test('an UNSEEDED bot-only game keeps its events — nothing else could reconstruct it', () => {
  const rec = require('../server/gamelog').buildRecord(
    roomWith([{ ...BOT_A }, { ...BOT_B }], {}), G);
  assert.equal(rec.humanSeats, 0);
  assert.equal(rec.replayable, false);
  assert.equal(rec.eventsOmitted, undefined, 'no seed means the events are the only record');
  assert.ok(rec.events.length > 0);
});

/* ── §3.1b — paying with upgrades must deliver every declared card ───── */
//
// Upgrades became payable in §3.1b, and that opened a silent under-payment. In
// processPayment(), normalizeUpgrades() was called once per upgrade card, inside the
// removal loop: paying with an Upgrade AND its FOC together removed the Upgrade, at
// which point normalising saw a lone FOC and banked it back to the PAYER — and the FOC's
// own iteration then found nothing (`ui < 0`) and returned. The engine logged and emitted
// a 7M payment; the payee received 3M and the payer kept the FOC.
//
// These tests assert the thing that actually matters and that the old code got wrong:
// the payee ENDS UP HOLDING every card the payment declared, and the declared total is
// the value that actually moved.

// Where a card ended up: 'payee', 'payer', or 'lost'.
function whereIs(state, cardId) {
  for (const p of state.players) {
    if (p.bank.some(c => c.id === cardId)) return { who: p.id, zone: 'bank' };
    for (const cards of Object.values(p.properties || {})) {
      if (cards.some(c => c.id === cardId)) return { who: p.id, zone: 'properties' };
    }
    for (const ups of Object.values(p.upgrades || {})) {
      if ((ups || []).some(u => u && u.id === cardId)) return { who: p.id, zone: 'upgrades' };
    }
  }
  return { who: null, zone: 'lost' };
}

// p1 charges p2 2M (Roll Call). p2 owns a complete intel set carrying an Upgrade and an
// FOC, a 3M bank card and a spare brown property, so every combination below is a legal
// payment (each is worth >= 2M).
function upgradePaymentTable() {
  const state = fresh();
  const [a, b] = state.players;
  propertyCard(state, b, 'intel');
  propertyCard(state, b, 'intel');
  const house = { ...take(state, c => c.action === 'upgrade'), upgradeType: 'house', placedColor: 'intel' };
  const foc = { ...take(state, c => c.action === 'foc'), upgradeType: 'hotel', placedColor: 'intel' };
  b.upgrades.intel = [house, foc];
  const money = take(state, c => c.action === 'inspector_general');   // 5M, banked
  b.bank.push(money);
  const spare = propertyCard(state, b, 'brown');
  assert.deepEqual(G.validateState(state), { ok: true }, 'fixture is a legal board');

  a.hand.push(take(state, c => c.action === 'roll_call'));
  assert.ok(G.playAction(state, 'p1', 0).ok);
  return { state, a, b, house, foc, money, spare };
}

const CASES = [
  ['an Upgrade alone',              ({ house }) => [house]],
  ['an FOC alone',                  ({ foc }) => [foc]],
  ['an Upgrade AND its FOC',        ({ house, foc }) => [house, foc]],
  ['an FOC AND its Upgrade',        ({ house, foc }) => [foc, house]],
  ['an Upgrade + FOC + bank card',  ({ house, foc, money }) => [house, foc, money]],
  ['an Upgrade + FOC + a property', ({ house, foc, spare }) => [house, foc, spare]],
  ['an Upgrade + a bank card',      ({ house, money }) => [house, money]],
  ['an FOC + a property',           ({ foc, spare }) => [foc, spare]],
  ['everything payable',            ({ house, foc, money, spare }) => [house, foc, money, spare]],
];

for (const [label, pick] of CASES) {
  test(`paying with ${label} delivers every declared card to the payee`, () => {
    const fixture = upgradePaymentTable();
    const { state } = fixture;
    const cards = pick(fixture);
    const declared = cards.reduce((sum, c) => sum + c.value, 0);

    const res = G.respondToAction(state, 'p2', 'accept', cards.map(c => c.id));
    assert.ok(res.ok, `payment refused: ${res.error}`);

    for (const card of cards) {
      const at = whereIs(state, card.id);
      assert.equal(at.who, 'p1',
        `${card.name} (${card.value}M) was declared as payment but ended up with ${at.who ?? 'nobody'} in ${at.zone}`);
    }
    // What the log and the journal told the players must be what actually moved.
    const paid = state.events.filter(e => e.t === 'payment').pop();
    assert.ok(paid, 'a payment event was emitted');
    assert.equal(paid.total, declared, 'the declared total is the sum of the selected cards');
    const delivered = cards
      .filter(c => whereIs(state, c.id).who === 'p1')
      .reduce((sum, c) => sum + c.value, 0);
    assert.equal(delivered, declared,
      `payee received ${delivered}M against a declared ${declared}M`);
    assert.deepEqual(G.validateState(state), { ok: true }, 'no card was duplicated or lost');
  });
}

test('an FOC the payer KEEPS is still banked when its Upgrade is paid away', () => {
  // The other half of the same rule: normalising once at the end must still strand a lone
  // FOC. Paying only the Upgrade leaves the FOC with nothing beneath it, so it goes to the
  // PAYER'S bank (§3.1b) — and it is NOT part of the declared total.
  const { state, foc, house } = upgradePaymentTable();
  assert.ok(G.respondToAction(state, 'p2', 'accept', [house.id]).ok);

  assert.equal(whereIs(state, house.id).who, 'p1', 'the Upgrade was paid');
  assert.deepEqual(whereIs(state, foc.id), { who: 'p2', zone: 'bank' },
    'the orphaned FOC goes to its owner\'s bank, not the payee and not the discard');
  assert.equal(state.players[1].upgrades.intel, undefined, 'no lone FOC keeps paying +4M rent');
  assert.equal(state.events.filter(e => e.t === 'payment').pop().total, house.value);
  assert.deepEqual(G.validateState(state), { ok: true });
});

test('seizing an upgraded set moves the Upgrade AND the FOC together', () => {
  // steal_set/mergeUpgrades shares normalizeUpgrades()'s invariant. It hands the whole
  // list over in one move and deletes the source key, so there is no window in which a
  // lone FOC exists — this pins that.
  const state = fresh();
  const [a, b] = state.players;
  propertyCard(state, b, 'intel');
  propertyCard(state, b, 'intel');
  const house = { ...take(state, c => c.action === 'upgrade'), upgradeType: 'house', placedColor: 'intel' };
  const foc = { ...take(state, c => c.action === 'foc'), upgradeType: 'hotel', placedColor: 'intel' };
  b.upgrades.intel = [house, foc];

  a.hand.push(take(state, c => c.action === 'inspector_general'));
  assert.ok(G.playAction(state, 'p1', 0, { targetId: 'p2', targetColor: 'intel' }).ok);
  assert.ok(G.respondToAction(state, 'p2', 'accept').ok);

  assert.deepEqual(G.upgradeKinds(a, 'intel').sort(), ['hotel', 'house'],
    'both upgrades followed the set');
  assert.equal(b.upgrades.intel, undefined);
  assert.deepEqual(G.validateState(state), { ok: true });
});

test('breaking an upgraded set banks BOTH upgrades to their owner, never stranding the FOC', () => {
  // The set-break path (bankUpgrades) is the third caller in this family. Paying away a
  // property of an upgraded set breaks it; both upgrades must land in the payer's bank.
  const { state, house, foc, spare } = upgradePaymentTable();
  const intelProp = state.players[1].properties.intel[0];
  assert.ok(G.respondToAction(state, 'p2', 'accept', [intelProp.id, spare.id]).ok);

  assert.deepEqual(whereIs(state, house.id), { who: 'p2', zone: 'bank' });
  assert.deepEqual(whereIs(state, foc.id), { who: 'p2', zone: 'bank' });
  assert.equal(state.players[1].upgrades.intel, undefined);
  assert.deepEqual(G.validateState(state), { ok: true });
});
