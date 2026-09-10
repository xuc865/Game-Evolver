// test/bot-discard-completer.test.js — a bot must never throw away the card that finishes its
// own set.
//
// This is NOT the sandbag (test/bot-sandbag.test.js, SANDBAG_ENABLED = false). It is the
// escrow-class comparator bug that sandbag's §3.7 describes, and it is BROADER than that spec
// records: the spec attributes it to `humanlike`'s new comparator, but it is present in every
// planner comparator on this tree, for its own reason each time.
//
//   neutral      — OPSEC last, hard breakers next, then purely `a.value - b.value`. Brown,
//                  lightblue and intel properties print 1M, so a completer is the FIRST card
//                  out of the hand.
//   conservative — properties sort late as a GROUP, but between two properties it falls through
//                  to face value, so the cheap completer goes before an expensive orphan.
//   aggressive   — money first, then `a.type === 'action'` after property; between two
//                  properties it too falls through to face value.
//   humanlike    — added a property-late group of its own, and falls through to face value
//                  between two properties exactly like the other three.
//
// Verified against the pre-fix tree with the fixture below — brown one short, and a hand with
// no money and no action cards, so the comparator is FORCED to choose between properties:
//
//   hand: brown/1M(completes) green/4M darkblue/4M yellow/3M red/3M green/4M darkblue/4M yellow/3M
//   humanlike LOST THE COMPLETER · neutral LOST · conservative LOST · aggressive LOST
//
// THE DISCRIMINATION, and it is the point of the fixture's shape. The trap this project has
// hit three times is a fixture where some OTHER existing rule produces the same answer. Here
// every card in hand is a property, so:
//   * the OPSEC tier cannot fire (no OPSEC),
//   * the hard-breaker tier cannot fire (no breakers),
//   * isNeverDiscarded cannot fire (no CHUD),
//   * conservative's and humanlike's property-late grouping is a TIE across the whole hand,
//   * aggressive's money-first and action-late clauses are both vacuous,
// and every comparator therefore falls through to `a.value - b.value` — which ranks the 1M
// completer BELOW the 3M and 4M orphans it is being asked to protect. The completer is also
// the CHEAPEST card in the hand, so "keeps the completer" cannot be produced by any
// value-based rule; only "does this finish a zone" can produce it.
//
// AND IT IS UNCONDITIONAL. Discarding the property that completes your own set is wrong
// whether or not sandbagging ever ships, so the property-vs-property half of the tier is NOT
// gated on SANDBAG_ENABLED. The flag still gates the ABSOLUTE tier (a completer kept ahead of
// money, action cards and the shield) — that is the sandbag's business and it is pinned in
// test/bot-sandbag.test.js. What is pinned here is the narrow, always-live half, and the last
// two tests pin its BOUNDARIES: it must not reach chud and random (whose `shuffle` is what
// keeps their seeded streams byte-identical), and it must not reach past property-vs-property
// while the flag is off.
//
// Measured cost of shipping it live: `node tools/simbalance.mjs --games 900 --seed r12base` is
// byte-identical (14.2 / 28.2 / 31.7 / 37.9 / 13.1, avg 33.0 turns, stalemates 0.11%) — the
// reorder never once reaches the discard boundary on that seed. Across 9,000 games on three
// other seeds it changes the discarded card 14 times, and all 14 are a completer saved.

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');
const Bot = require('../bot');

const I = Bot._internal;
const { chooseDiscards, setRng } = I;

function build(seats = 3) {
  const players = Array.from({ length: seats }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  const state = G.createGame(players, { seed: 'discard-completer' });
  state.deck = G.buildDeck(state.rules.deck);
  state.discardPile = [];
  state.players.forEach(p => { p.hand = []; p.bank = []; p.properties = {}; p.upgrades = {}; });
  return state;
}
function take(state, predicate) {
  const i = state.deck.findIndex(predicate);
  assert.notEqual(i, -1, 'expected card in deck');
  return state.deck.splice(i, 1)[0];
}
function propCard(state, color) { return take(state, c => c.type === 'property' && c.color === color); }
function money(state, value) { return take(state, c => c.type === 'money' && c.value === value); }
function prop(state, player, color) {
  const c = propCard(state, color);
  (player.properties[color] = player.properties[color] || []).push({ ...c, placedColor: color });
  return c;
}

test.afterEach(() => { setRng(null); if (typeof I.setSandbag === 'function') I.setSandbag(null); });

// The forced property-vs-property choice. Eight cards, one over the limit, none of them money,
// none of them an action, and the only thing separating the 1M brown from the rest is that it
// finishes a zone.
function forcedPropertyChoice() {
  const state = build(3);
  const me = state.players[0];
  prop(state, me, 'brown');                          // 1 of 2 — one short
  const completer = propCard(state, 'brown');        // 1M, and the cheapest card in the hand
  me.hand.push(completer);
  for (const color of ['green', 'darkblue', 'yellow', 'red', 'green', 'darkblue', 'yellow']) {
    me.hand.push(propCard(state, color));            // 4M / 4M / 3M / 3M / 4M / 4M / 3M
  }
  assert.equal(me.hand.length, G.HAND_LIMIT + 1, 'fixture: exactly one over the hand limit');
  assert.equal(me.hand.filter(c => I.completesASet(me, c)).length, 1,
    'fixture: exactly ONE card in hand finishes a zone — no second cause for the assertion');
  assert.equal(Math.min(...me.hand.map(c => c.value)), completer.value,
    'fixture: the completer is the CHEAPEST card, so no value rule can produce "keep it"');
  return { state, me, completer };
}

for (const mode of ['neutral', 'conservative', 'aggressive', 'humanlike']) {
  test(`${mode} does not discard the card that finishes its own set — flag OFF`, () => {
    const { me, completer } = forcedPropertyChoice();
    assert.equal(I.sandbagConfig().enabled, false, 'this fix is live with the sandbag flag OFF');

    setRng(() => 0);
    const ids = chooseDiscards(me, me.hand.length - G.HAND_LIMIT, mode);
    setRng(null);

    assert.equal(ids.length, 1, 'the hand limit still has to be met — endTurn refuses a short list');
    assert.ok(!ids.includes(completer.id),
      `${mode} discarded a third of a set to keep a property it does not need`);
    const shed = me.hand.find(c => c.id === ids[0]);
    assert.ok(shed && shed.value > completer.value,
      'the card that went is a more expensive orphan — the comparator paid MORE to keep less');
  });
}

test('the protection still yields: a hand of nothing but completers still meets the limit', () => {
  // Why the fix is a TIER and not isNeverDiscarded-style pool removal. `endTurn` refuses a
  // short discard list and the turn wedges, so chooseDiscards(...).length === excess must hold
  // even when EVERY card in hand is protected. A ranking can always yield; an absolute rule
  // needs an arithmetic escape, and a second absolute class multiplies the ways that escape is
  // reached. Green today only because the tier never had a chance to overrun anything.
  const state = build(3);
  const me = state.players[0];
  const colors = ['brown', 'lightblue', 'pink', 'orange', 'red', 'yellow', 'darkblue', 'intel'];
  for (const color of colors) {
    while ((me.properties[color] || []).length < G.COLORS[color].size - 1) prop(state, me, color);
    me.hand.push(propCard(state, color));
  }
  assert.equal(me.hand.filter(c => I.completesASet(me, c)).length, 8,
    'fixture: every card in hand finishes a set');

  for (const mode of ['neutral', 'conservative', 'aggressive', 'humanlike', 'chud', 'random']) {
    setRng(() => 0);
    const ids = chooseDiscards(me, me.hand.length - G.HAND_LIMIT, mode);
    setRng(null);
    assert.equal(ids.length, 1, `${mode}: protection is a preference, never a licence to overrun`);
  }
});

test('GUARD: it does not reach chud or random — their shuffle is what keeps their streams', () => {
  // The chaotic two discard by `shuffle`, and a shuffle cannot be asked politely to spare
  // something. Their byte-identical RNG streams are the only thing that lets simbalance and
  // botaudit be run paired against b54420f, which is the same reasoning behind BREAKER_BAR:
  // null, BAIT_PATIENCE: 0 and CUSHION_PRESSURE: 0. Green today, and it must stay that way:
  // it goes red the moment somebody applies the tier outside the switch without excluding them.
  //
  // The rng matters here and is chosen, not arbitrary. `shuffle` is Fisher-Yates with
  // `j = floor(rnd() * (i + 1))`, so an rng pinned just below 1 gives j === i on every step —
  // every swap is a no-op and the shuffle is the IDENTITY permutation. The completer is first
  // in hand, so an untouched chud discards exactly it. That is what makes this discriminating:
  // if the tier reached the chaotic two it would push the completer to the back and something
  // else would go instead.
  for (const mode of ['chud', 'random']) {
    const { me, completer } = forcedPropertyChoice();
    setRng(() => 0.999999);
    const ids = chooseDiscards(me, me.hand.length - G.HAND_LIMIT, mode);
    setRng(null);
    assert.equal(ids.length, 1);
    assert.deepEqual(ids, [completer.id],
      `${mode} must be untouched: an identity shuffle sheds hand[0], completer or not`);
  }
});

test('GUARD: with the flag OFF the unconditional half stops at property-vs-property', () => {
  // The boundary of what ships unconditionally. Between a property and a BANKNOTE the fix does
  // not fire: a 1M completer still loses to a 10M note under neutral's face-value sort, exactly
  // as it did before. That is deliberate and it is what keeps the sandbag's own "flag OFF ⇒
  // byte-identical" guard honest — the absolute tier (completer ahead of money, actions and the
  // shield) is the sandbag's business and stays behind SANDBAG_ENABLED.
  const state = build(3);
  const me = state.players[0];
  prop(state, me, 'brown');
  const completer = propCard(state, 'brown');
  me.hand.push(completer, money(state, 10));

  setRng(() => 0);
  assert.deepEqual(chooseDiscards(me, 1, 'neutral'), [completer.id],
    'flag OFF: neutral sheds by face value between a property and a note, as it always has');
  setRng(null);

  // …and the same hand behind the flag keeps it. This leg is the sandbag's contract, restated
  // here so the two halves of the tier are visible in one place.
  I.setSandbag({ enabled: true, weights: { neutral: 0.20 } });
  setRng(() => 0);
  const ids = chooseDiscards(me, 1, 'neutral');
  setRng(null);
  assert.ok(!ids.includes(completer.id), 'flag ON: the absolute tier outranks a 10M note');
});
