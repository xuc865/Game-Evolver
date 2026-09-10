// test/bot-sequencing.test.js — cluster 2 of the foresight round: TURN SEQUENCING.
//
// Two behaviours, both of them orderings rather than new decisions, both of them living at
// the `decideBotPlay` chokepoint that rounds 8-9 built for exactly this (`findChargeBooster`
// / `findCompletingPlay` / `ORDER_ATTENTION`).
//
//   (a) BAIT THE SHIELD. docs/bot-foresight-research.md §1.3: 16.4% of every fired hard
//       breaker (284 of 1,930 over 400 games) is eaten by an OPSEC, and no bot has ever
//       tried to draw the shield out first with a cheap targeted action it is already
//       holding. The field treats this as the whole skill of the Deal Breaker (§2, row 2).
//       Belief in the shield is built on PUBLIC information only (round 11's honest-
//       information rule): the unseen OPSEC count, the unseen pool size, and the victim's
//       hand SIZE. Never hand contents.
//
//   (b) STEAL -> RENT. §P4: `findChargeBooster` already sequences an Upgrade/FOC/property
//       ahead of the rent it raises, but it does not know a STEAL can be a booster. A CHUD
//       or Midnight Requisition that takes the card completing our colour, followed by rent
//       on that now-complete set, is the largest single-turn swing in the deck — darkblue
//       goes 3M -> 8M on one stolen card. `simulate.js` counts `stealAfterRent`, which is
//       the WRONG ORDER, and that is why the gap has never surfaced in a report.
//
// Every positive assertion below is proven RED on the pre-change tree (§8 / round 8's
// test-first rule). Where a guard would be green on its own it is folded into the same test
// as the positive it guards, so no test in this file can pass by testing nothing.
//
// Everything drives Bot._internal directly — the same entry point server.js and simulate.js
// use — so a pass means the LIVE bot behaves this way.

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');
const Bot = require('../bot');

const { decideBotPlay, applyBotAction, botRespondSync, setRng } = Bot._internal;

/* ── helpers (same shape as bot-economy.test.js / bot-cardcount.test.js) ─ */

function build(seats = 3) {
  const players = Array.from({ length: seats }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  const state = G.createGame(players, { seed: 'botseq' });
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
  return (player.properties[color])[player.properties[color].length - 1];
}
function wildInto(state, player, zone, colors) {
  const c = take(state, x => x.type === 'wild_property'
    && (colors ? colors.every(k => x.colors.includes(k)) : x.colors[0] === 'any'));
  const placed = { ...c, placedColor: zone };
  (player.properties[zone] = player.properties[zone] || []).push(placed);
  return placed;
}
function setOf(state, p, color) {
  while ((p.properties[color] || []).length < G.COLORS[color].size) prop(state, p, color);
}
// darkblue is a 2-card colour and the deck holds exactly two of them, so a board where WE
// hold one and an opponent holds a COMPLETE darkblue set has to finish theirs with the
// green/darkblue pair wild. That is a legal set under every rules toggle (zoneIsSet only
// rejects an all-rainbow zone under pureSetRequired).
function opponentDarkblueSet(state, p) {
  prop(state, p, 'darkblue');
  wildInto(state, p, 'darkblue', ['green', 'darkblue']);
  assert.equal(G.isSetComplete(p, 'darkblue'), true, 'fixture did not build a complete set');
}
function colorRent(state, color) {
  return take(state, c => c.type === 'rent' && c.colors[0] !== 'any' && c.colors.includes(color));
}
// Hand SIZE is public; hand CONTENTS are not. These are filler cards whose only job is to
// make the victim's hand a believable place for an OPSEC to be hiding.
function fillHand(state, p, n) {
  for (let i = 0; i < n; i++) p.hand.push(money(state, 1 + (i % 2)));
}
// The unseen pool is `deck + every other hand`. Shrinking the deck is how a late-game
// board — where the shield belief actually sharpens — is expressed in a bare state.
function shrinkDeck(state, n) { state.deck.length = n; }
function resolvePending(state, mode = 'neutral') {
  let guard = 0;
  while (state.pendingAction && guard++ < 8) {
    const responder = Bot._internal.findResponder(state);
    if (!responder) break;
    botRespondSync(state, responder, mode);
  }
  assert.equal(state.pendingAction, null, 'pending action never resolved');
}
function cardOf(state, plan) {
  return state.players[0].hand[plan.cardIndex];
}
// What the plan is actually playing, named the way the failure message should read: the
// action kind for an action card, the bare card type for a rent or a property.
function kindOf(state, plan) {
  const c = cardOf(state, plan);
  return c ? (c.action || c.type) : 'nothing';
}
function always(v) { setRng(() => v); }
test.afterEach(() => setRng(null));

/* ════════════════════════════════════════════════════════════════════════
   (b) STEAL -> RENT SEQUENCING
   ════════════════════════════════════════════════════════════════════════ */

test('a CHUD that completes the charged colour is played before the rent, and the rent follows at the full ladder', () => {
  // The largest single-turn swing in the deck: darkblue at 1/2 charges 3M; steal the card
  // that finishes it and the same rent card charges 8M. FAILS on the current tree, whose
  // ordering pass (findChargeBooster) only knows Upgrades, FOCs and cards already in hand.
  for (const mode of ['conservative', 'neutral', 'aggressive']) {
    const state = build();
    const bot = state.players[0];
    // One completed set of our own, because §3.10c's escrow owns whether a CHUD may be
    // spent at all: a completing CHUD clears the bar only at `mine + 1 >= setsToWin -
    // BREAKER_SELF_MARGIN`, and a 0-set bot that gains one lands at 1, below the bar. Below
    // it the completion is left to Midnight Requisition, which is not escrowed. So the
    // sequencing question — steal first, then charge — is only ever ASKED of a bot that has
    // already built something, and the fixture has to put it there.
    setOf(state, bot, 'brown');
    prop(state, bot, 'darkblue');                 // 1/2 — rent 3
    opponentDarkblueSet(state, state.players[1]);  // their complete set: only a CHUD reaches it
    state.players[1].bank.push(money(state, 10));
    bot.hand.push(colorRent(state, 'darkblue'));
    bot.hand.push(action(state, 'chud'));
    always(0.99);   // pass every attention roll, defeat every holdback

    const plan = decideBotPlay(state, 'p1', mode);
    assert.ok(plan && plan.type === 'play_action', `${mode} made no action play`);
    assert.equal(kindOf(state, plan), 'chud',
      `${mode} charged 3M rent while holding the card that makes it 8M`);
    assert.equal(plan.targetId, 'p2');
    assert.ok(applyBotAction(state, 'p1', plan).ok, `${mode}: engine refused the steal`);
    resolvePending(state);
    assert.equal(G.calcRent(bot, 'darkblue'), 8, `${mode} did not complete the set`);

    const next = decideBotPlay(state, 'p1', mode);
    assert.ok(next && next.type === 'play_action', `${mode} stole and then never charged`);
    assert.equal(kindOf(state, next), 'rent', `${mode} did not follow through with the rent`);
    setRng(null);
  }
});

test('the cheaper Midnight Requisition is spent before the CHUD when the source zone is not a complete set', () => {
  // Both cards complete the colour; only one of them is the strongest card in the deck.
  // Spending the CHUD here would hand cluster 1's escrow a bill it should not have to pay.
  const state = build();
  const bot = state.players[0];
  setOf(state, bot, 'brown');                     // clears the escrow's self-margin, so the
                                                  // CHUD is genuinely AVAILABLE here and the
                                                  // preference below is a choice, not a veto
  prop(state, bot, 'darkblue');
  prop(state, state.players[1], 'darkblue');      // 1/2 on their side — requisitionable
  state.players[1].bank.push(money(state, 10));
  bot.hand.push(colorRent(state, 'darkblue'));
  bot.hand.push(action(state, 'midnight_requisition'));
  bot.hand.push(action(state, 'chud'));
  always(0.99);

  const plan = decideBotPlay(state, 'p1', 'neutral');
  assert.ok(plan && plan.type === 'play_action');
  assert.equal(kindOf(state, plan), 'midnight_requisition',
    'the booster steal did not prefer the cheap card over the hard breaker');
});

test('Midnight Requisition is never proposed against a complete set — the CHUD is, or the rent fires unboosted', () => {
  // §3.1 / Hasbro FAQ 926, enforced in game.js: a refused play burns the turn, so the pass
  // must check `zoneRequisitionable` exactly as the engine does.
  //
  // A: CHUD in hand -> the CHUD is the only legal booster and it goes first  (RED today)
  const a = build();
  const botA = a.players[0];
  setOf(a, botA, 'brown');                        // clears the escrow's self-margin
  prop(a, botA, 'darkblue');
  opponentDarkblueSet(a, a.players[1]);           // complete: MR may not touch it
  a.players[1].bank.push(money(a, 10));
  botA.hand.push(colorRent(a, 'darkblue'));
  botA.hand.push(action(a, 'midnight_requisition'));
  botA.hand.push(action(a, 'chud'));
  always(0.99);
  const planA = decideBotPlay(a, 'p1', 'neutral');
  assert.ok(planA && planA.type === 'play_action');
  assert.equal(kindOf(a, planA), 'chud',
    'a complete source zone left the CHUD unused');

  // B: no CHUD -> nothing legal boosts the rent, so the rent fires as the planner chose
  const b = build();
  const botB = b.players[0];
  setOf(b, botB, 'brown');
  prop(b, botB, 'darkblue');
  opponentDarkblueSet(b, b.players[1]);
  b.players[1].bank.push(money(b, 10));
  botB.hand.push(colorRent(b, 'darkblue'));
  botB.hand.push(action(b, 'midnight_requisition'));
  always(0.99);
  const planB = decideBotPlay(b, 'p1', 'neutral');
  assert.ok(planB && planB.type === 'play_action');
  assert.equal(kindOf(b, planB), 'rent',
    'proposed a Midnight Requisition the engine would refuse — that burns the turn');
});

test('the steal booster never eats the last play the rent needed', () => {
  // Round 8's guard, inherited: a booster with no play left for the charge trades the
  // charge for a building, which is worse than the mis-order it fixes.
  //
  // A: two plays -> steal first  (RED today)
  const a = build();
  const botA = a.players[0];
  prop(a, botA, 'darkblue');
  prop(a, a.players[1], 'darkblue');
  a.players[1].bank.push(money(a, 10));
  botA.hand.push(colorRent(a, 'darkblue'));
  botA.hand.push(action(a, 'midnight_requisition'));
  a.playsRemaining = 2;
  always(0.99);
  const planA = decideBotPlay(a, 'p1', 'neutral');
  assert.ok(planA && planA.type === 'play_action');
  assert.equal(kindOf(a, planA), 'midnight_requisition', 'two plays left and no steal');

  // B: one play -> the charge the planner chose
  const b = build();
  const botB = b.players[0];
  prop(b, botB, 'darkblue');
  prop(b, b.players[1], 'darkblue');
  b.players[1].bank.push(money(b, 10));
  botB.hand.push(colorRent(b, 'darkblue'));
  botB.hand.push(action(b, 'midnight_requisition'));
  b.playsRemaining = 1;
  always(0.99);
  const planB = decideBotPlay(b, 'p1', 'neutral');
  assert.ok(planB && planB.type === 'play_action');
  assert.equal(kindOf(b, planB), 'rent',
    'burned the last play on a steal instead of the charge it was meant to raise');
});

test('a stolen card only counts as a booster when it will actually land in the charged colour', () => {
  // game.js resolves a steal through `receiveProperty(..., card.placedColor || card.color)`,
  // so the zone the card sat in on the VICTIM's board is the preferred destination. A wild
  // that merely COULD sit in our colour goes back to its own colour on our board and raises
  // nothing — stealing it would spend a play and a card for zero rent.
  //
  // Midnight Requisition rather than the CHUD on both legs, deliberately: MR is not
  // escrowed, so the only thing that can decide these two boards differently is the
  // placed-colour rule itself. Route the same fixture through a CHUD and §3.10c's bar
  // answers first, and the test measures the escrow instead of the thing it names.
  //
  // A: the wild is sitting in their darkblue zone -> it lands in ours  (RED today)
  const a = build();
  const botA = a.players[0];
  prop(a, botA, 'darkblue');
  const inPlace = wildInto(a, a.players[1], 'darkblue', ['green', 'darkblue']);
  a.players[1].bank.push(money(a, 10));
  botA.hand.push(colorRent(a, 'darkblue'));
  botA.hand.push(action(a, 'midnight_requisition'));
  always(0.99);
  const planA = decideBotPlay(a, 'p1', 'neutral');
  assert.ok(planA && planA.type === 'play_action');
  assert.equal(kindOf(a, planA), 'midnight_requisition',
    'a wild already parked in the charged colour was ignored');
  assert.equal(planA.targetCardId, inPlace.id);

  // B: the same wild is sitting in their GREEN zone -> it would land in our green
  const b = build();
  const botB = b.players[0];
  prop(b, botB, 'darkblue');
  wildInto(b, b.players[1], 'green', ['green', 'darkblue']);
  b.players[1].bank.push(money(b, 10));
  botB.hand.push(colorRent(b, 'darkblue'));
  botB.hand.push(action(b, 'midnight_requisition'));
  always(0.99);
  const planB = decideBotPlay(b, 'p1', 'neutral');
  assert.ok(planB && planB.type === 'play_action');
  assert.equal(kindOf(b, planB), 'rent',
    'stole a wild that the engine would have parked in a different colour');
});

/* ════════════════════════════════════════════════════════════════════════
   (a) BAIT THE SHIELD
   ════════════════════════════════════════════════════════════════════════ */

// The bait board: p2 is two complete sets deep (so every planner reaches for the breaker),
// holds one loose property in a requisitionable zone (so a Midnight Requisition is legal
// against them), and sits on a seven-card hand while the unseen pool is small — which is
// the only public evidence a bot is allowed to have that a shield is in there.
function baitBoard({ deck = 20, victimHand = 7, breaker = 'inspector_general' } = {}) {
  const state = build();
  const bot = state.players[0];
  const victim = state.players[1];
  setOf(state, victim, 'brown');
  setOf(state, victim, 'darkblue');
  prop(state, victim, 'red');            // the only zone a Midnight Requisition may touch
  victim.bank.push(money(state, 10));
  bot.hand.push(action(state, breaker));
  bot.hand.push(action(state, 'midnight_requisition'));
  fillHand(state, victim, victimHand);
  shrinkDeck(state, deck);
  return state;
}

test('conservative and neutral bait the shield with a cheap steal before firing Inspector General; aggressive does not', () => {
  // §1.3: 16.4% of fired breakers are eaten by an OPSEC and no bot has ever poked first.
  // Patience axis (§P2): "conservative and neutral bait, aggressive does not have the
  // temperament, chud and random never." Distinctness is a gate, not a nicety.
  for (const mode of ['conservative', 'neutral']) {
    const state = baitBoard();
    const bot = state.players[0];
    always(0.5);
    const plan = decideBotPlay(state, 'p1', mode);
    assert.ok(plan && plan.type === 'play_action', `${mode} made no action play`);
    assert.equal(kindOf(state, plan), 'midnight_requisition',
      `${mode} walked Inspector General into a live shield instead of drawing it out`);
    assert.equal(plan.targetId, 'p2', `${mode} baited someone other than the intended victim`);
    // and the breaker is still fired this turn — the bait costs a play, never the shot
    assert.ok(applyBotAction(state, 'p1', plan).ok, `${mode}: engine refused the bait`);
    resolvePending(state);
    const next = decideBotPlay(state, 'p1', mode);
    assert.ok(next && next.type === 'play_action', `${mode} baited and then never fired`);
    assert.equal(kindOf(state, next), 'inspector_general',
      `${mode} spent a play on a bait and then dropped the breaker`);
    setRng(null);
  }

  // aggressive keeps its temperament AND its exact RNG stream (weight 0 short-circuits
  // the roll, the CARD_AWARENESS pattern) — it shoots.
  const hot = baitBoard();
  always(0.5);
  const shot = decideBotPlay(hot, 'p1', 'aggressive');
  assert.ok(shot && shot.type === 'play_action');
  assert.equal(kindOf(hot, shot), 'inspector_general',
    'aggressive learned patience — that is a distinctness regression');
});

test('the bait is not spent when no play would remain to fire the breaker', () => {
  // The whole cost of the bait is one play. Spending it on the last play converts a
  // set-steal into a 3M steal, which is strictly worse than walking into the shield.
  //
  // A: two plays -> bait first  (RED today)
  const a = baitBoard();
  a.playsRemaining = 2;
  always(0.5);
  const planA = decideBotPlay(a, 'p1', 'conservative');
  assert.ok(planA && planA.type === 'play_action');
  assert.equal(kindOf(a, planA), 'midnight_requisition', 'two plays left and no bait');
  setRng(null);

  // B: one play -> fire
  const b = baitBoard();
  b.playsRemaining = 1;
  always(0.5);
  const planB = decideBotPlay(b, 'p1', 'conservative');
  assert.ok(planB && planB.type === 'play_action');
  assert.equal(kindOf(b, planB), 'inspector_general',
    'spent the last play on a bait it could never follow up');
});

test('the shield belief is public and density-weighted — a fat unseen pool does not bait', () => {
  // The proxy in §P2 is `unseen.opsec > 0 && victim.hand.length >= 4`, which is true on
  // essentially every turn of every game. The honest version prices the same public facts:
  // K shields hidden among U unseen cards (deck + every other hand), H of them in the
  // victim's hand. Late deck: P(they hold one) ~0.61. Fresh deck, same hand size: ~0.20.
  //
  // A: small pool -> the shield is probably in there  (RED today)
  const a = baitBoard({ deck: 20, victimHand: 7 });
  always(0.5);
  const planA = decideBotPlay(a, 'p1', 'conservative');
  assert.ok(planA && planA.type === 'play_action');
  assert.equal(kindOf(a, planA), 'midnight_requisition',
    'a 7-card hand against a 27-card unseen pool is where the bait pays');
  setRng(null);

  // B: same hand size, same shields unseen, but the pool is deep — the odds do not clear
  const b = baitBoard({ deck: 200, victimHand: 7 });
  // buildDeck() is 106 cards, so pad the pool out rather than truncating it
  while (b.deck.length < 200) b.deck.push({ id: 9000 + b.deck.length, type: 'money', name: '1M', value: 1 });
  always(0.5);
  const planB = decideBotPlay(b, 'p1', 'conservative');
  assert.ok(planB && planB.type === 'play_action');
  assert.equal(kindOf(b, planB), 'inspector_general',
    'baited on a hand-size proxy that is true all game instead of on the shield density');
});

test('the bait never takes the card the breaker was about to commandeer', () => {
  // A bait that eats its own target leaves the breaker with nothing to shoot at: the play
  // is spent, the planner re-derives, and the CHUD either goes somewhere worse or stays in
  // hand. The bait must pick a DIFFERENT card.
  //
  // Building the collision takes care under §3.10c. The escrow retargets a CHUD onto either
  // a card in a REAL threat's complete set — which a Midnight Requisition may never touch,
  // so no collision is possible there — or the card that COMPLETES one of our zones, which
  // can sit in an ordinary requisitionable zone. That second case is the only one where the
  // two cards can be the same, so it is the one the fixture builds: we are 2/3 red, and the
  // victim's red zone holds both the 3M red the CHUD wants and a 0M rainbow it does not.
  //
  // neutral rather than conservative: the shot must clear BREAKER_SELF_MARGIN (so the bot
  // holds one completed set) without reaching setsToWin (or tryArmingBreaker fires ahead of
  // the ordering pass and there is deliberately no bait there), and conservative only opens
  // its offensive branch at two sets.
  const state = build();
  const bot = state.players[0];
  const victim = state.players[1];
  setOf(state, bot, 'brown');                      // 1 set — clears the escrow's self-margin
  prop(state, bot, 'red'); prop(state, bot, 'red');// 2/3 red: one card finishes it
  // The rainbow goes down FIRST, so `cards[0]` of the victim's red zone is the 0M wild. The
  // CHUD must still pick the 3M red (round 11, angle 4: best card, player in front) — if it
  // took cards[0] the two cards would swap roles and the bait would eat the shot's target.
  const spare = wildInto(state, victim, 'red');    // 0M rainbow in the same requisitionable zone
  const wanted = prop(state, victim, 'red');       // 3M — what the CHUD is aimed at
  victim.bank.push(money(state, 10));
  bot.hand.push(action(state, 'chud'));
  bot.hand.push(action(state, 'midnight_requisition'));
  fillHand(state, victim, 7);
  shrinkDeck(state, 20);

  // The collision, stated: with no bait patience at all the CHUD goes straight at `wanted`.
  always(0.5);
  const unbaited = decideBotPlay(state, 'p1', 'aggressive');
  assert.ok(unbaited && unbaited.type === 'play_action');
  assert.equal(kindOf(state, unbaited), 'chud', 'fixture: the CHUD was not the chosen shot');
  assert.equal(unbaited.targetCardId, wanted.id,
    'fixture: the CHUD and the best requisition target must be the same card');
  setRng(null);

  always(0.5);
  const plan = decideBotPlay(state, 'p1', 'neutral');
  assert.ok(plan && plan.type === 'play_action');
  assert.equal(kindOf(state, plan), 'midnight_requisition', 'no bait was played at all');
  assert.notEqual(plan.targetCardId, wanted.id,
    'the bait ate the card the CHUD was aimed at');
  assert.equal(plan.targetCardId, spare.id,
    'the bait did not fall back to the other card it could legally take');
});
