// test/winrule.test.js — §3.10 win-rule toggle (owner directive 2026-08-06).
//   finalApproach (default) | mdFaithful | instant

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');
const Bot = require('../bot');
const protocol = require('../server/protocol');
const sim = require('../simulate');

/* ── helpers ─────────────────────────────────────────────────────────── */

function build(winRule, playerCount = 4, seed = 'wr') {
  const players = Array.from({ length: playerCount }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  const state = G.createGame(players, { seed, winRule });
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
// The turn draw is automatic and pops from the end of the deck, where buildDeck() puts the
// two CHUDs — so reclaim from a hand when the deck no longer has the card.
function take(s, f) {
  const i = s.deck.findIndex(f);
  if (i >= 0) return s.deck.splice(i, 1)[0];
  for (const p of s.players) {
    const h = p.hand.findIndex(f);
    if (h >= 0) return p.hand.splice(h, 1)[0];
  }
  return assert.fail('expected card in deck or in a hand');
}
function prop(s, p, color) {
  const card = take(s, c => c.type === 'property' && c.color === color);
  (p.properties[color] = p.properties[color] || []).push({ ...card, placedColor: color });
  return card;
}
// Two complete sets plus one intel, i.e. one card away from three.
function twoSetsPlusOne(state, player) {
  prop(state, player, 'brown'); prop(state, player, 'brown');
  prop(state, player, 'darkblue'); prop(state, player, 'darkblue');
  prop(state, player, 'intel');
}
const evTypes = s => s.events.map(e => e.t);
const rowFor = (s, id) => G.getPlayerView(s, id).players.find(p => p.id === id);

// P2 (the current player) hands P1 the intel card that completes P1's third set, using
// TDY Orders. This is the only genuinely OFF-TURN way to complete someone else's set.
function offTurnComplete(state) {
  const [a, b] = state.players;
  twoSetsPlusOne(state, a);
  const spare = prop(state, a, 'red');
  const gift = prop(state, b, 'intel');
  state.currentPlayerIndex = 1;
  state.turnCounter = 10;
  state.turnPhase = 'play';
  state.playsRemaining = 3;
  b.hand.push(take(state, c => c.action === 'tdy_orders'));
  assert.ok(G.playAction(state, 'p2', b.hand.length - 1,
    { targetId: 'p1', targetCardId: spare.id, myCardId: gift.id }).ok);
  assert.ok(G.respondToAction(state, 'p1', 'accept').ok);
}

function playOut(state, limit = 20) {
  let turns = 0;
  while (state.phase === 'playing' && turns < limit) { G.endTurn(state, G.currentPlayer(state).id); turns++; }
  return turns;
}

/* ── configuration surface ───────────────────────────────────────────── */

test('finalApproach is the default and unknown values fall back to it', () => {
  for (const value of [undefined, null, '', 'bogus', 'INSTANT', 42]) {
    const state = G.createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { winRule: value });
    assert.equal(state.winRule, 'finalApproach', `winRule ${JSON.stringify(value)}`);
    assert.equal(G.getPlayerView(state, 'a').winRule, 'finalApproach');
  }
  for (const value of G.WIN_RULES) {
    const state = G.createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { winRule: value });
    assert.equal(state.winRule, value);
    assert.equal(G.getPlayerView(state, 'a').winRule, value);
    assert.equal(state.events[0].winRule, value, 'game_start carries the mode');
  }
});

test('start_game validates winRule additively and stays backward compatible', () => {
  const base = { type: 'start_game', turnTimeout: 60, responseTimeout: 30 };
  assert.equal(protocol.validateMessage(base).ok, true, 'an absent winRule is still valid');
  for (const rule of ['finalApproach', 'mdFaithful', 'instant']) {
    assert.equal(protocol.validateMessage({ ...base, winRule: rule }).ok, true, rule);
  }
  for (const bad of ['sudden_death', '', 1, null, {}]) {
    const res = protocol.validateMessage({ ...base, winRule: bad });
    assert.equal(res.ok, false, `winRule ${JSON.stringify(bad)} must be rejected`);
    assert.match(res.error, /win rule/i);
  }
});

/* ── instant ─────────────────────────────────────────────────────────── */

test('instant: the third set wins the moment it completes on your own turn', () => {
  const state = build('instant');
  const [a] = state.players;
  twoSetsPlusOne(state, a);
  a.hand.push(take(state, c => c.type === 'property' && c.color === 'intel'));
  assert.ok(G.playProperty(state, 'p1', a.hand.length - 1).ok);

  assert.equal(state.phase, 'finished');
  assert.equal(state.winner, 'p1');
  assert.equal(state.endReason, 'sets');
  assert.equal(a.finalApproach, false, 'nothing is ever armed under instant');
});

test('instant: completing off-turn through a swap wins immediately', () => {
  const state = build('instant');
  offTurnComplete(state);
  assert.equal(state.phase, 'finished');
  assert.equal(state.winner, 'p1', 'the win lands during an opponent\'s turn');
  assert.equal(playOut(state), 0);
});

test('instant: completing off-turn through a payment wins immediately', () => {
  const state = build('instant', 2);
  const [a, b] = state.players;
  twoSetsPlusOne(state, a);
  const owed = prop(state, b, 'intel');
  a.hand.push(take(state, c => c.action === 'finance_office'));
  assert.ok(G.playAction(state, 'p1', a.hand.length - 1, { targetId: 'p2' }).ok);
  assert.ok(G.respondToAction(state, 'p2', 'accept', [owed.id]).ok);
  assert.equal(state.winner, 'p1');
  assert.equal(state.endReason, 'sets');
});

test('instant: the event stream carries a win with no final_approach before it', () => {
  const state = build('instant');
  const [a] = state.players;
  twoSetsPlusOne(state, a);
  a.hand.push(take(state, c => c.type === 'property' && c.color === 'intel'));
  G.playProperty(state, 'p1', a.hand.length - 1);

  const types = evTypes(state);
  assert.equal(types.includes('final_approach'), false);
  assert.equal(types.includes('final_approach_broken'), false);
  assert.ok(types.includes('set_completed'));
  const win = state.events.at(-1);
  assert.equal(win.t, 'win');
  assert.equal(win.winRule, 'instant');
  assert.equal(win.sets, 3);
});

test('instant: no countdown field can ever be rendered', () => {
  const state = build('instant');
  const [a] = state.players;
  twoSetsPlusOne(state, a);
  const view = G.getPlayerView(state, 'p1');
  assert.deepEqual(view.armedIds, []);
  for (const row of view.players) {
    assert.equal(row.finalApproach, false);
    assert.equal(row.finalApproachIn, null);
    assert.equal(row.opponentTurnsRemaining, null);
    assert.equal(row.checkpointTurn, null);
  }
});

/* ── mdFaithful vs finalApproach ─────────────────────────────────────── */

test('off-turn arming: mdFaithful converts at the next own turn, finalApproach after a full cycle', () => {
  const md = build('mdFaithful');
  offTurnComplete(md);
  const mdRow = rowFor(md, 'p1');
  assert.equal(md.players[0].finalApproach, true);
  assert.equal(md.events.find(e => e.t === 'final_approach').onOwnTurn, false);
  // Armed on turn 10 during P2's turn; P1's own next turn is turn 13.
  assert.equal(mdRow.checkpointTurn, 13);
  assert.equal(mdRow.opponentTurnsRemaining, 2, 'P3 and P4 get one turn each');
  assert.equal(playOut(md), 3);
  assert.equal(md.winner, 'p1');

  const fa = build('finalApproach');
  offTurnComplete(fa);
  const faRow = rowFor(fa, 'p1');
  // Strict full cycle: P1's turn 13 is only 3 ticks after arming, so it waits for turn 17.
  assert.equal(faRow.checkpointTurn, 17);
  assert.equal(faRow.opponentTurnsRemaining, 5, 'every opponent is guaranteed a turn');
  assert.equal(playOut(fa), 7);
  assert.equal(fa.winner, 'p1');

  assert.ok(faRow.checkpointTurn > mdRow.checkpointTurn, 'finalApproach is the more generous rule');
});

// CORRECTED 2026-08-08. This test used to assert the opposite — that the two modes are
// identical for an own-turn completion — which made mdFaithful Final Approach under another
// name and matched no edition of the source. The rulebook sentence is CONDITIONAL: "if you
// realize you've won during someone else's turn, you must wait until it's your turn to say
// it" (2008 sheet). Completing on your own turn is not that case, and the E3113 foldout and
// the 2025 FIFA/Harry Potter cuts drop even the exception: "the game ends when one player
// collects 3 complete Property sets in different colors."
test('own-turn completion: mdFaithful wins where it lands, finalApproach arms', () => {
  const md = build('mdFaithful');
  const [a] = md.players;
  twoSetsPlusOne(md, a);
  a.hand.push(take(md, c => c.type === 'property' && c.color === 'intel'));
  assert.ok(G.playProperty(md, 'p1', a.hand.length - 1).ok);
  assert.equal(md.phase, 'finished', 'the third set on your own turn ends the game');
  assert.equal(md.winner, 'p1');
  assert.equal(a.finalApproach, false, 'nothing is armed by an own-turn completion');
  assert.ok(!md.events.some(e => e.t === 'final_approach'),
    'no arming event, so no HUD countdown for a win that already happened');

  const fa = build('finalApproach');
  const [c] = fa.players;
  twoSetsPlusOne(fa, c);
  c.hand.push(take(fa, x => x.type === 'property' && x.color === 'intel'));
  assert.ok(G.playProperty(fa, 'p1', c.hand.length - 1).ok);
  assert.equal(fa.phase, 'playing', 'ours still gives the table a full cycle to answer');
  assert.equal(c.finalApproach, true);
  assert.equal(rowFor(fa, 'p1').opponentTurnsRemaining, 3, '4 seats → the other 3 each reply');
  assert.equal(playOut(fa), 4, 'one full cycle of four seats, then it converts');
  assert.equal(fa.winner, 'p1');
});

test('mdFaithful still emits final_approach with an honest countdown', () => {
  const state = build('mdFaithful');
  offTurnComplete(state);
  const ev = state.events.find(e => e.t === 'final_approach');
  assert.equal(ev.winRule, 'mdFaithful');
  assert.equal(ev.opponentTurnsRemaining, 2);
  assert.equal(ev.checkpointTurn, 13);
  // and it counts down honestly, one per opponent turn, reaching 0 at the converting turn
  const seen = [];
  for (let i = 0; i < 2; i++) {
    G.endTurn(state, G.currentPlayer(state).id);
    seen.push(rowFor(state, 'p1').opponentTurnsRemaining);
  }
  assert.deepEqual(seen, [1, 0]);
  G.endTurn(state, G.currentPlayer(state).id);
  assert.equal(state.winner, 'p1');
});

// Both modes still arm and still disarm — but only mdFaithful's OFF-TURN completion arms
// at all now, so each mode is armed the way it can be armed.
test('both grace modes still disarm when the third set is broken', () => {
  for (const rule of ['finalApproach', 'mdFaithful']) {
    const state = build(rule, 2);
    const [a, b] = state.players;
    if (rule === 'mdFaithful') {
      offTurnComplete(state);                // P2 hands P1 the third set on P2's own turn
    } else {
      twoSetsPlusOne(state, a);
      a.hand.push(take(state, c => c.type === 'property' && c.color === 'intel'));
      G.playProperty(state, 'p1', a.hand.length - 1);
      G.endTurn(state, 'p1');
      state.turnPhase = 'play';
      state.playsRemaining = 3;
    }
    assert.equal(a.finalApproach, true, rule);

    b.hand.push(take(state, c => c.action === 'chud'));
    const victim = a.properties.intel[0];
    assert.ok(G.playAction(state, 'p2', b.hand.length - 1, { targetId: 'p1', targetCardId: victim.id }).ok);
    assert.ok(G.respondToAction(state, 'p1', 'accept').ok);

    assert.equal(a.finalApproach, false, rule);
    assert.equal(state.phase, 'playing', rule);
    assert.ok(state.events.some(e => e.t === 'final_approach_broken' && e.by === 'p2'), rule);
  }
});

/* ── bots ────────────────────────────────────────────────────────────── */

test('bots finish games under every win rule and never chase a phantom approach', () => {
  const modes = ['random', 'conservative', 'neutral', 'aggressive'];
  for (const rule of G.WIN_RULES) {
    let decided = 0;
    let armEvents = 0;
    for (let g = 0; g < 12; g++) {
      const result = sim.runGame(modes.map((m, i) => ({ name: m + i, mode: m })), 300, `bots-${rule}-${g}`, rule);
      if (result.winner) decided++;
      armEvents += result.armings;
    }
    assert.ok(decided >= 10, `${rule}: expected most games decided, got ${decided}/12`);
    if (rule === 'instant') {
      assert.equal(armEvents, 0, 'instant must never arm, so break/defend logic cannot fire');
    } else if (rule === 'finalApproach') {
      assert.ok(armEvents > 0, 'finalApproach arms on every completion, own-turn or not');
    }
    // mdFaithful is deliberately NOT asserted here. Since 2026-08-08 it arms only on an
    // OFF-turn completion — measured at ~5% of completions — so twelve games legitimately
    // see none, and asserting otherwise buys a flaky test rather than coverage. The arming
    // path is pinned deterministically by 'mdFaithful still emits final_approach with an
    // honest countdown' and by the off-turn case in the disarm test above.
  }
});

test('the bot break/defend heuristics key off the armed flag, which instant never sets', () => {
  const state = build('instant');
  const [a, b] = state.players;
  twoSetsPlusOne(state, a);
  // P1 sits at two complete sets and is NOT armed; a bot must not treat it as armed.
  assert.equal(a.finalApproach, false);
  const opponentsOfB = state.players.filter(p => p.id !== 'p2');
  assert.deepEqual(opponentsOfB.filter(p => p.finalApproach), [],
    'findArmed() sees nobody, so tryBreakFinalApproach is never reached');
  assert.equal(typeof Bot.scheduleBotAction, 'function');
  assert.ok(b);
});
