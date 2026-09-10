// test/bot-cardcount.test.js — angle 1 of the card-awareness round: counting the
// counter-cards that are PUBLIC (discard pile + every table + own hand) and acting on
// what cannot come any more.
//
// The honest-information rule (round 11): bots may count how many copies of a kind
// remain UNSEEN (deck + opponents' hands, one undifferentiated pool), but must never
// read an opponent's actual hand or the deck order. unseenCounts() is recomputed from
// visible state each call, so a reshuffle returning discarded OPSEC to the pool is
// handled by construction.
//
// Measured on pre-fix HEAD (400 four-player games, seed aware-base, every rotation of
// every 4-subset):
//   - aggressive declined to OPSEC 43 big charges (>= 4M) while ZERO hard breakers
//     (Inspector General / CHUD) remained unseen — saving the shield for a threat that
//     could no longer exist;
//   - conservative sat on an Inspector General at 75 decision points (neutral 36) while
//     every OPSEC in the deck was visible — an unblockable set-steal left in hand.

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');
const Bot = require('../bot');

const { decideBotPlay, shouldPlayOpsecDecision, unseenCounts, setRng } = Bot._internal;

/* ── helpers (same shape as bot-economy.test.js) ─────────────────────── */

function build(seats = 3) {
  const players = Array.from({ length: seats }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  const state = G.createGame(players, { seed: 'cardcount' });
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
function money(state, value) { return take(state, c => c.type === 'money' && c.value === value); }
function action(state, name) { return take(state, c => c.action === name); }
function prop(state, player, color) {
  const c = take(state, x => x.type === 'property' && x.color === color);
  (player.properties[color] = player.properties[color] || []).push({ ...c, placedColor: color });
  return c;
}
function setOf(state, p, color) {
  while ((p.properties[color] || []).length < G.COLORS[color].size) prop(state, p, color);
}
function discardAll(state, kind, n) {
  for (let i = 0; i < n; i++) state.discardPile.push(action(state, kind));
}
function always(v) { setRng(() => v); }
test.afterEach(() => setRng(null));

/* ── the counter itself is honest ────────────────────────────────────── */

test('unseenCounts reads discard, tables and own hand — never an opponent hand', () => {
  const state = build(3);
  const [me, p2, p3] = state.players;
  // one OPSEC in the discard, one banked on an opponent table, one in an OPPONENT HAND
  state.discardPile.push(action(state, 'opsec'));
  p2.bank.push(action(state, 'opsec'));
  p3.hand.push(action(state, 'opsec'));

  const u = unseenCounts(state, me);
  // the copy in p3's hand is hidden information: it must still count as UNSEEN
  assert.equal(u.opsec, 1);

  // and swapping the hidden hand for entirely different cards changes nothing the
  // counter can see — peeking would show up as a moved number here
  p3.hand = [money(state, 1), money(state, 2)];
  assert.equal(unseenCounts(state, me).opsec, 1);

  // own hand IS counted: holding the last copy ourselves means none can be played on us
  me.hand.push(p3.hand.pop(), action(state, 'inspector_general'));
  const u2 = unseenCounts(state, me);
  assert.equal(u2.breakers, 2 + 1);   // 2 CHUD unseen + 1 IG unseen (the other IG is ours)
});

/* ── blocked: the save-it-for-the-big-one economy, priced by the pool ── */

test('aggressive blocks a 5M demand once every hard breaker is accounted for', () => {
  const state = build(3);
  const me = state.players[0];
  // all four hard breakers visible: 2 IG + 2 CHUD in the discard
  discardAll(state, 'inspector_general', 2);
  discardAll(state, 'chud', 2);
  me.hand.push(action(state, 'opsec'));
  state.pendingAction = {
    type: 'payment', action: 'finance_office', sourceId: 'p2', amount: 5,
    targets: [{ id: 'p1', depth: 0, responderId: 'p1' }],
  };
  always(0);   // aware, and every personality roll low
  assert.equal(shouldPlayOpsecDecision(state, state.pendingAction, 'aggressive', 'p1'), true);
});

test('guard: with breakers still unseen, aggressive keeps saving the shield', () => {
  const state = build(3);
  const me = state.players[0];
  me.hand.push(action(state, 'opsec'));
  state.pendingAction = {
    type: 'payment', action: 'finance_office', sourceId: 'p2', amount: 5,
    targets: [{ id: 'p1', depth: 0, responderId: 'p1' }],
  };
  always(0);
  assert.equal(shouldPlayOpsecDecision(state, state.pendingAction, 'aggressive', 'p1'), false);
});

/* ── fired: a breaker nobody can answer does not wait ────────────────── */

test('conservative fires Inspector General the moment no OPSEC can answer it', () => {
  const state = build(3);
  const [me, p2] = state.players;
  discardAll(state, 'opsec', 3);            // every OPSEC in the deck is visible
  setOf(state, p2, 'brown');                // a complete set to take (p2 is NOT a 2-set threat)
  me.hand.push(action(state, 'inspector_general'));
  // an ordinary build play the old plan would prefer
  me.hand.push(take(state, c => c.type === 'property' && c.color === 'lightblue'));

  always(0);   // aware; all personality rolls low
  const a = decideBotPlay(state, 'p1', 'conservative');
  assert.ok(a, 'expected a play');
  assert.equal(a.type, 'play_action');
  assert.equal(me.hand[a.cardIndex].action, 'inspector_general',
    'an unblockable IG outranks ordinary building');
  assert.equal(a.targetId, 'p2');
});

test('guard: with an OPSEC still unseen, conservative builds as before', () => {
  const state = build(3);
  const [me, p2] = state.players;
  discardAll(state, 'opsec', 2);            // one OPSEC still out there
  setOf(state, p2, 'brown');
  me.hand.push(action(state, 'inspector_general'));
  me.hand.push(take(state, c => c.type === 'property' && c.color === 'lightblue'));

  always(0);
  const a = decideBotPlay(state, 'p1', 'conservative');
  assert.ok(a, 'expected a play');
  assert.equal(a.type, 'play_property',
    'no free shot: the personality plan (build first) stands');
});

test('guard: a guaranteed CHUD is not wasted on a worthless orphan', () => {
  const state = build(3);
  const [me, p2] = state.players;
  discardAll(state, 'opsec', 3);
  prop(state, p2, 'brown');                 // a lone 1M property, no set of ours to finish
  me.hand.push(action(state, 'chud'));
  me.hand.push(money(state, 2));

  always(0);
  const a = decideBotPlay(state, 'p1', 'conservative');
  if (a && a.type === 'play_action') {
    assert.notEqual(me.hand[a.cardIndex].action, 'chud',
      'CHUD holds unless the steal completes a set of ours or breaks a complete set');
  }
});

/* ── random stays blind ──────────────────────────────────────────────── */

test('random never counts: a guaranteed IG shot does not change its decision mix', () => {
  const state = build(3);
  const [me, p2] = state.players;
  discardAll(state, 'opsec', 3);
  setOf(state, p2, 'brown');
  me.hand.push(action(state, 'inspector_general'));
  me.hand.push(take(state, c => c.type === 'property' && c.color === 'lightblue'));

  // rnd() = 0.99: for an aware mode the awareness roll would fail too, so drive it at 0
  // through a mode that has zero awareness — the branch must not even be reachable.
  always(0);
  const a = decideBotPlay(state, 'p1', 'random');
  // random at rnd()=0 plays properties first (60% branch); the point is it did NOT
  // detect the free IG shot
  assert.ok(!a || a.type !== 'play_action' || me.hand[a.cardIndex].action !== 'inspector_general');
});

/* ── angle 2: the deck-cycle clock ───────────────────────────────────── */
//
// §3.11 ends the game on points after DECK_CYCLE_LIMIT reshuffles, and shuffleCount is
// public (every shuffle is a table event). Measured on pre-fix HEAD (500 five-player
// games, seed aware-base5): in the last quarter of the cycle budget every personality
// passed ~90 times per 500 games WITH playable cards in hand — the human-like holdback
// saving plays for a "later" the attrition clock was about to adjudicate away. Points
// endings were won nearly uniformly across modes (random 12 of 37 — more than any
// planner): nobody was playing the points game.

test('conservative stops holding back once the attrition clock is running', () => {
  const state = build(3);
  const me = state.players[0];
  state.shuffleCount = G.DECK_CYCLE_LIMIT - 4;   // the endgame window opens
  state.playsRemaining = 2;                      // played >= 1, holdback territory
  me.hand.push(money(state, 2));
  always(0);   // rnd 0 < holdChance 0.08 — on pre-fix code this pass fires
  const a = decideBotPlay(state, 'p1', 'conservative');
  assert.ok(a, 'no play may be held back while the game is racing the cycle cap');
  assert.equal(a.type, 'play_money');
});

test('guard: with the deck young, the same roll still holds back', () => {
  const state = build(3);
  const me = state.players[0];
  state.shuffleCount = 0;
  state.playsRemaining = 2;
  me.hand.push(money(state, 2));
  always(0);
  assert.equal(decideBotPlay(state, 'p1', 'conservative'), null,
    'the holdback is character; only the endgame clock overrides it');
});

test('guard: random ignores the clock entirely', () => {
  const state = build(3);
  const me = state.players[0];
  state.shuffleCount = G.DECK_CYCLE_LIMIT - 4;
  state.playsRemaining = 2;
  me.hand.push(money(state, 2));
  always(0);
  assert.equal(decideBotPlay(state, 'p1', 'random'), null);
});

/* ── angle 4: target focus — steal from the player in front ─────────── */
//
// chooseRentTarget, findFinanceTarget and the §3.10 break branch are already leader- and
// payability-aware (round 7). The one measured blind spot: the steal finders'
// "advance our set" loop walked opponents in SEAT ORDER and took cards[0] from the
// matching zone. Measured on pre-fix HEAD (400 4p games): 22 (conservative) / 29
// (neutral) / 46 (aggressive) steals took the colour from a non-leader while the
// leader offered the same card legally — feeding the win to whoever sat first.

test('a requisition that advances our set comes from the LEADER when both offer it', () => {
  const state = build(3);
  const [me, p2, p3] = state.players;
  prop(state, me, 'red');                    // we are building red
  prop(state, p2, 'red');                    // seat-first non-leader has a red
  prop(state, p3, 'red');                    // the leader has one too
  setOf(state, p3, 'brown');                 // p3 leads on completed sets
  me.hand.push(action(state, 'midnight_requisition'));

  always(0);
  const a = decideBotPlay(state, 'p1', 'aggressive');
  assert.ok(a && a.type === 'play_action');
  assert.equal(me.hand[a.cardIndex].action, 'midnight_requisition');
  assert.equal(a.targetId, 'p3', 'same steal, taken from the player in front');
});

test('a CHUD steal takes the most valuable card in the matching zone, not cards[0]', () => {
  const state = build(3);
  const [me, p2] = state.players;
  // §3.10c (round 12) — the fixture now gives us a completed set first. This test pins
  // TARGETING ("take the 3M, not the 0M wild"), and the breaker escrow added a separate,
  // earlier question: whether a CHUD may be spent on a completion at all. It may, from
  // setsToWin - 1 - BREAKER_SELF_MARGIN sets upward; below that the completion is Midnight
  // Requisition's job and the CHUD is held. One completed set puts us over that bar so the
  // targeting assertion below is still asking what it was written to ask.
  prop(state, me, 'brown'); prop(state, me, 'brown');   // a complete set — 2 cards
  prop(state, me, 'red'); prop(state, me, 'red');   // building red, 2/3
  // p2's red zone: a 0M rainbow wild FIRST, a 3M real red behind it
  const w = take(state, c => c.type === 'wild_property' && c.colors[0] === 'any');
  (p2.properties.red = p2.properties.red || []).push({ ...w, placedColor: 'red' });
  prop(state, p2, 'red');
  me.hand.push(action(state, 'chud'));

  always(0);
  const a = decideBotPlay(state, 'p1', 'aggressive');
  assert.ok(a && a.type === 'play_action');
  assert.equal(me.hand[a.cardIndex].action, 'chud');
  const chosen = p2.properties.red.find(c => c.id === a.targetCardId);
  assert.equal(chosen.value, 3, 'both cards advance our set equally; take the 3M, not the 0M wild');
});
