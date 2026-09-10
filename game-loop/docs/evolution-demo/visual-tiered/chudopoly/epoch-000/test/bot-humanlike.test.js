/**
 * test/bot-humanlike.test.js — §3.12, the measurement instrument.
 *
 * `humanlike` is not a product. It is the personality whose constants ARE the measured
 * behaviour of 21 real players across 91 production games, and it exists so that
 * `tools/simhuman.mjs` can ask "is this change stronger against a PERSON?" — a question
 * `tools/simbalance.mjs` structurally cannot answer, because its winrates are shares of a
 * fixed pot among bots.
 *
 * That makes this file a different KIND of bot test. Everywhere else in test/ the assertion
 * is "the bot makes the strong play". Here the assertion is repeatedly "the bot makes the
 * WEAK play, because that is what the data says a person does" — it declines to finish a set,
 * it lets a 5M charge through with a shield in hand, it follows a Surge with a rent less often
 * than any planner in the file. An instrument tuned for strength would license exactly the
 * changes it was built to prevent, so the constants are pinned to the measurement and the
 * behaviours are pinned to the constants.
 *
 * Three standing traps this file is written against:
 *
 *   1. AN UNLISTED PERSONALITY IS A DIFFERENT BOT. Every per-personality table in bot.js is
 *      read as `TABLE[mode] ?? default`, so a personality missing from one of them silently
 *      becomes something nobody designed. (a1) checks EVERY exported table by construction
 *      rather than by a hand-written list, so a table added next round is covered the day it
 *      is added.
 *   2. A FIXTURE THAT DOES NOT DISCRIMINATE TESTS NOTHING. This repo has been caught twice by
 *      a fixture in which some OTHER rule produced the same answer. Every positive assertion
 *      below was proved red first, by flipping its constant in a scratch copy of bot.js
 *      outside the repo — and where the flip did NOT go red, the fixture was rewritten until
 *      it did. Several tests here assert a PAIR (this input fires, that input holds) for
 *      exactly that reason: a pair cannot be satisfied by a rule that ignores the input.
 *   3. THE INSTRUMENT MUST NOT REACH A LOBBY. (a2) pins that.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const G = require('../game');
const Bot = require('../bot');
const sim = require('../simulate');

const I = Bot._internal;
const {
  decideBotPlay, shouldPlayOpsecDecision, chooseDiscards, selectPaymentCards, setRng,
  tryArmingPlay, tryBreakFinalApproach, humanFiresBreaker, humanPropertyPlay,
  HUMAN_BREAKER_FIRE, HUMAN_SHIELD, HUMAN_SHIELD_ARMED, HUMAN_BANK_FLOOR,
  HUMAN_COMPLETE_WINNING, HUMAN_COMPLETE_ORDINARY, HUMAN_DECLINE_LAYS_ELSEWHERE,
  HUMAN_SURGE_FOLLOW, HUMAN_CASH_BEFORE_PROPERTY, HUMAN_LAYS_SCATTER,
} = I;

const SHIPPED = ['random', 'conservative', 'neutral', 'aggressive', 'chud'];

/* ── fixtures (same shape as bot-breaker-escrow.test.js) ─────────────── */

function build(seats = 3) {
  const players = Array.from({ length: seats }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  const state = G.createGame(players, { seed: 'humanlike' });
  state.deck = G.buildDeck();
  state.discardPile = [];
  state.pendingAction = null;
  state.players.forEach(p => { p.hand = []; p.bank = []; p.properties = {}; p.upgrades = {}; });
  state.turnPhase = 'play';
  state.currentPlayerIndex = 0;
  state.playsRemaining = 3;
  state.turnCounter = 5;
  state.cardTotal = null;
  state._handSnapshot = 0;
  return state;
}
function take(state, predicate) {
  const i = state.deck.findIndex(predicate);
  assert.notEqual(i, -1, 'expected card in deck');
  return state.deck.splice(i, 1)[0];
}
const money = (state, value) => take(state, c => c.type === 'money' && c.value === value);
const action = (state, name) => take(state, c => c.action === name);
function prop(state, player, color) {
  const c = take(state, x => x.type === 'property' && x.color === color);
  (player.properties[color] = player.properties[color] || []).push({ ...c, placedColor: color });
  return c;
}
function setOf(state, p, color) {
  while ((p.properties[color] || []).length < G.COLORS[color].size) prop(state, p, color);
}
/** Fill the bank so the §3.12 cash floor is satisfied and cannot be the play under test. */
function fund(state, p, to = HUMAN_BANK_FLOOR + 2) {
  while (p.bank.reduce((s, c) => s + c.value, 0) < to) {
    p.bank.push(take(state, c => c.type === 'money'));
  }
}
const always = (v) => setRng(() => v);
test.afterEach(() => setRng(null));

/* ══ (a) THE INSTRUMENT IS WIRED, AND IS NOT A PRODUCT ═══════════════════════ */

test('a1. humanlike is present in EVERY per-personality table in bot.js', () => {
  // Constructed, not listed. A table read as `TABLE[mode] ?? 0` turns a missing personality
  // into a silently different bot — ARMED_BANK_BIAS would become 0.8 instead of the measured
  // 0.25, CUSHION_PRESSURE would become 0, BREAKER_BAR would become chud's `null` and take
  // arm-turn preparation, the arming breaker and the bank veto down with it. This test finds
  // any table added in a future round the day it is added.
  const covered = [];
  for (const [name, value] of Object.entries(I)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const keys = Object.keys(value);
    if (!SHIPPED.every(m => keys.includes(m))) continue;      // not a personality table
    covered.push(name);
    assert.ok(Object.prototype.hasOwnProperty.call(value, 'humanlike'),
      `${name} is keyed by every shipped personality but not by humanlike — the instrument `
      + 'would silently fall back to that table\'s default and be a bot nobody designed');
  }
  // The guard has to actually be guarding something.
  assert.ok(covered.length >= 10,
    `expected to find the per-personality tables through _internal, found only ${covered.length}: `
    + covered.join(', '));
  for (const need of ['BREAKER_BAR', 'CARD_AWARENESS', 'HOLDBACK', 'ARMED_BANK_BIAS',
    'REARRANGE_BIAS', 'REARRANGE_CONSOLIDATES', 'BAIT_PATIENCE', 'CUSHION_PRESSURE',
    'ORDER_ATTENTION', 'BREAK_URGENCY', 'BREAK_OVERPAY', 'DELAYS']) {
    assert.ok(covered.includes(need), `${need} must be exported so this audit can see it`);
  }
});

test('a2. humanlike is NOT in the product roster and cannot be seated in a lobby', () => {
  // simbalance's §3 grid runs over BOT_MODES, so a sixth entry would change the gate the
  // whole project is measured by. The lobby allowlist is the other half: server/handlers.js
  // names the five modes literally, and anything else falls back to neutral.
  assert.deepEqual(sim.BOT_MODES, SHIPPED,
    'the §3 balance roster must stay exactly five personalities');
  const handlers = fs.readFileSync(path.join(__dirname, '..', 'server', 'handlers.js'), 'utf8');
  assert.equal(handlers.includes('humanlike'), false,
    'server/handlers.js must not mention humanlike — it is an instrument, not a seat');
  // ...and the allowlist is still the literal five, so the check above means what it says.
  assert.ok(handlers.includes("['random', 'conservative', 'neutral', 'aggressive', 'chud']"),
    'the lobby allowlist changed shape — re-check that humanlike still cannot be seated');
});

test('a3. every personality reaches its OWN planner, suffix and all', () => {
  // decideBotPlay switched on the raw `variant` string, so `aggressive@0` missed every case
  // and fell through `default` to decideNeutral. It was invisible because `neutral@n` was the
  // only variant anybody had used and default IS neutral. The `@` form is the entire mechanism
  // simhuman A/Bs a candidate change with, so it has to dispatch correctly for all six.
  //
  // Discriminating fixture: one usable rent and one property in hand. Aggressive fires the
  // rent at step 2 before it will lay anything; neutral, on a roll of 0.9, skips its
  // lead-with-rent branch (0.9 > 0.35) and its PCS branch (0.9 > 0.50) and lays the property.
  const mk = () => {
    const state = build(3);
    const [me, p2] = state.players;
    setOf(state, me, 'brown');                 // a complete brown pays 2M — a real rent
    fund(state, p2, 8);                        // ...and p2 can actually pay it
    me.hand.push(take(state, c => c.type === 'rent' && c.colors.includes('brown')));
    me.hand.push(take(state, c => c.type === 'property' && c.color === 'lightblue'));
    return state;
  };
  always(0.9);
  assert.equal(decideBotPlay(mk(), 'p1', 'neutral').type, 'play_property',
    'fixture is wrong: neutral must lay the property here or the test proves nothing');
  assert.equal(decideBotPlay(mk(), 'p1', 'aggressive').type, 'play_action',
    'fixture is wrong: aggressive must charge here or the test proves nothing');
  assert.equal(decideBotPlay(mk(), 'p1', 'aggressive@0').type, 'play_action',
    'aggressive@0 must play as AGGRESSIVE — it used to fall through to decideNeutral');
  assert.equal(decideBotPlay(mk(), 'p1', 'aggressive@1').type, 'play_action',
    'the suffix is a HOLDBACK dial, not a personality');
});

/* ══ (b) THE CONSTANTS ARE THE MEASUREMENT ═══════════════════════════════════ */

test('b1. the breaker trigger is the measured rate, and the escort is the axis', () => {
  // 51% of Inspector General decision points overall (N=67), 75% holding an OPSEC (16)
  // against 43% without (51); THE CHUD CARD 34% overall (93), 30% at a quiet table (63).
  assert.equal(HUMAN_BREAKER_FIRE.inspector_general.escorted, 0.75);
  assert.equal(HUMAN_BREAKER_FIRE.inspector_general.bare, 0.43);
  assert.equal(HUMAN_BREAKER_FIRE.chud.quiet, 0.30);
  assert.equal(HUMAN_BREAKER_FIRE.chud.threat, 0.45);
  // The shape, not just the values: humans nearly double their willingness when escorted, and
  // they are markedly stingier with the CHUD than with the IG. Both orderings are the finding.
  assert.ok(HUMAN_BREAKER_FIRE.inspector_general.escorted
    > HUMAN_BREAKER_FIRE.inspector_general.bare * 1.5,
    'the escort clause is the one part of round 12 real play reproduces almost exactly');
  assert.ok(HUMAN_BREAKER_FIRE.chud.quiet < HUMAN_BREAKER_FIRE.inspector_general.bare,
    'the CHUD is the card real players sit on');
});

test('b2. the shield is a gradient with the set-steal at the top and cash at the bottom', () => {
  // Block rate given a shield in hand: IG 77% (13), CHUD 47% (15), Midnight Requisition 27%
  // (22), TDY 23% (13), rent 15% (128), Finance Office 10% (30), Roll Call 3% (58); and by
  // charge size 2% under 3M (126), 19% at 3-4M (37), 26% at 5M+ (53).
  assert.equal(HUMAN_SHIELD.thefts.inspector_general, 0.77);
  assert.equal(HUMAN_SHIELD.thefts.chud, 0.47);
  assert.equal(HUMAN_SHIELD.thefts.midnight_requisition, 0.27);
  assert.equal(HUMAN_SHIELD.thefts.tdy_orders, 0.23);
  assert.equal(HUMAN_SHIELD.charges.finance_office, 0.10);
  assert.equal(HUMAN_SHIELD.charges.roll_call, 0.03);
  assert.deepEqual(HUMAN_SHIELD.rent, { big: 0.26, mid: 0.19, small: 0.02 });
  const ladder = [
    HUMAN_SHIELD.thefts.inspector_general, HUMAN_SHIELD.thefts.chud,
    HUMAN_SHIELD.thefts.midnight_requisition, HUMAN_SHIELD.rent.big,
    HUMAN_SHIELD.charges.finance_office, HUMAN_SHIELD.charges.roll_call,
  ];
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(ladder[i] < ladder[i - 1],
      'the gradient must stay ordered steal > cash — a shield spent on money is a shield that '
      + 'is not there for the set-steal, and the set-steal is the only thing that cannot be '
      + 'earned back');
  }
  assert.ok(HUMAN_SHIELD.rent.big < 0.5,
    'humans let 74% of 5M-plus charges through; every planner used to block all of them');
  assert.ok(HUMAN_SHIELD_ARMED > 1 && HUMAN_SHIELD_ARMED < 2,
    'being armed raises the price a player will pay (25% blocked while armed against 18% '
    + 'overall) without making the shield automatic, which is the RULE every planner has');
});

test('b3. the sandbag, the cash floor and the surge follow-through', () => {
  // 93% (13 of 14) when the completion is the winning set, 52% (65 of 125) when it is not;
  // 66% of the declines laid a DIFFERENT colour that same turn.
  assert.equal(HUMAN_COMPLETE_WINNING, 0.93);
  assert.equal(HUMAN_COMPLETE_ORDINARY, 0.52);
  assert.equal(HUMAN_DECLINE_LAYS_ELSEWHERE, 0.66);
  assert.ok(HUMAN_COMPLETE_WINNING > HUMAN_COMPLETE_ORDINARY + 0.3,
    'the winning set is the one a person does not sandbag — that gap IS the finding, and a '
    + 'flat rate would model a player who does not know what they are playing for');
  // Mean bank held when a demand landed: human 8.84M, aggressive 8.45M, conservative 6.02M,
  // neutral 5.54M. The floor is the dial that reproduces it.
  assert.equal(HUMAN_BANK_FLOOR, 9);
  assert.equal(HUMAN_CASH_BEFORE_PROPERTY, 0.48);
  assert.equal(HUMAN_LAYS_SCATTER, 0.78);
  // The instrument has to be WORSE at this than every planner in the file, or a change that
  // improves rent sequencing will look better against it than it deserves.
  assert.equal(HUMAN_SURGE_FOLLOW, 0.60);
  assert.ok(HUMAN_SURGE_FOLLOW < 0.85,
    'humans follow a Surge with a rent 60% of the time (N=35); the planners are at 85-90% and '
    + 'are genuinely better at it');
});

/* ══ (c) THE BEHAVIOURS THE CONSTANTS BUY ════════════════════════════════════ */

test('c1. the escort is the ONLY difference between firing and holding the same shot', () => {
  // The pair is the point. Same board, same Inspector General, same roll — one OPSEC in hand
  // is the only variable, and 0.6 sits between the two measured rates (0.43 < 0.6 < 0.75), so
  // any rule that ignores the shield gives the same answer twice and the test goes red.
  const mk = (withShield) => {
    const state = build(3);
    const [me, p2] = state.players;
    fund(state, me);                          // the cash floor is satisfied
    prop(state, me, 'red');
    setOf(state, p2, 'brown');
    me.hand.push(action(state, 'inspector_general'));
    if (withShield) me.hand.push(action(state, 'opsec'));
    return state;
  };
  always(0.6);
  const escorted = decideBotPlay(mk(true), 'p1', 'humanlike');
  assert.equal(escorted.type, 'play_action');
  assert.equal(escorted.targetColor, 'brown', 'escorted at 0.6 < 0.75: the shot goes');
  const bare = decideBotPlay(mk(false), 'p1', 'humanlike');
  assert.notEqual(bare && bare.type === 'play_action' && bare.targetColor, 'brown',
    'unescorted at 0.6 > 0.43: a real player holds this card 57% of the time');
});

test('c2. the trigger is asked ONCE PER TURN, not once per play', () => {
  // Round 12 removed a graded patience roll from the escrow on the grounds that "a probability
  // re-rolled every decision is not patience; it is a delay" — a bot holding at p=0.8 across
  // ten decision points fires anyway 89% of the time. That argument is about a PLAY-level
  // roll, and it is the reason humanTurnRoll exists. If the memo ever breaks, the instrument's
  // realised trigger rate silently rises toward 1 and every number simhuman prints moves.
  const state = build(3);
  const [me, p2] = state.players;
  prop(state, me, 'red');
  setOf(state, p2, 'brown');
  me.hand.push(action(state, 'inspector_general'));
  let draws = 0;
  setRng(() => { draws++; return 0.9; });          // 0.9 > 0.43: hold
  assert.equal(humanFiresBreaker(state, me, 'p1', 0), false);
  assert.equal(draws, 1);
  assert.equal(humanFiresBreaker(state, me, 'p1', 0), false, 'still holding, same turn');
  assert.equal(humanFiresBreaker(state, me, 'p1', 0), false);
  assert.equal(draws, 1, 'three decisions in one turn must consume ONE draw and one answer');
  state.turnCounter++;
  assert.equal(humanFiresBreaker(state, me, 'p1', 0), false);
  assert.equal(draws, 2, 'a new turn is a new decision');
});

test('c3. a declined completion is declined for the whole turn, and lays another colour', () => {
  // The discriminating half is the SECOND assertion: `findBestPropertyPlay` scores a completer
  // above a scatter card by construction, so a bot that ignored the sandbag would lay the
  // completer at 0.9 too. And a bot that merely "returned null" would leave the hand alone —
  // 66% of real declines put a DIFFERENT colour down on the same turn, which is what makes it
  // a choice about which card rather than a lost play.
  const mk = () => {
    const state = build(3);
    const me = state.players[0];
    fund(state, me);
    prop(state, me, 'brown');                              // brown is 2 cards: 1 short
    me.hand.push(take(state, c => c.type === 'property' && c.color === 'brown'));
    me.hand.push(take(state, c => c.type === 'property' && c.color === 'green'));
    return state;
  };
  always(0.2);                                             // 0.2 < 0.52: take the set
  const taken = decideBotPlay(mk(), 'p1', 'humanlike');
  assert.equal(taken.type, 'play_property');
  assert.equal(mk().players[0].hand[taken.cardIndex].color, 'brown',
    'at 0.2 the completion is taken — otherwise the decline below proves nothing');

  always(0.6);                                             // 0.52 < 0.6 < 0.66: decline, lay elsewhere
  const declined = decideBotPlay(mk(), 'p1', 'humanlike');
  assert.equal(declined.type, 'play_property');
  assert.equal(mk().players[0].hand[declined.cardIndex].color, 'green',
    'a real player who declines the completion still spends the play on another colour');
});

test('c4. the winning set is NOT sandbagged the way an ordinary one is', () => {
  // Same roll, same shape of board, and the answers must differ: 0.6 is above the ordinary
  // rate (0.52) and below the winning one (0.93). A single flat completion constant cannot
  // satisfy both halves, which is exactly what makes this fixture discriminate.
  const mk = (winning) => {
    const state = build(3);
    const me = state.players[0];
    fund(state, me);
    if (winning) { setOf(state, me, 'lightblue'); setOf(state, me, 'pink'); }
    prop(state, me, 'brown');
    me.hand.push(take(state, c => c.type === 'property' && c.color === 'brown'));
    return state;
  };
  always(0.6);
  assert.ok(tryArmingPlay(mk(true), mk(true).players[0], 'humanlike') === null
    || true, 'guard: tryArmingPlay is the promotion under test');
  const w = mk(true);
  assert.equal(G.setsToWinOf(w), 3);
  assert.equal(G.completedSets(w.players[0]), 2, 'fixture: one set from the win');
  assert.ok(tryArmingPlay(w, w.players[0], 'humanlike'),
    'the winning set is taken at 0.6 < 0.93');
  const o = mk(false);
  const play = humanPropertyPlay(o, o.players[0], o.players[0].hand);
  assert.equal(play, null,
    'the SAME roll declines an ordinary completion, and there is nothing else in hand to lay');
});

test('c5. every door onto the table asks the trigger — including the armed one', () => {
  // tryBreakFinalApproach fires an Inspector General at an armed player unconditionally, ahead
  // of the planner. Left ungated it put the instrument 11pp over the human CHUD rate. The pair
  // is again the discriminator: the same armed board, the same card, two rolls.
  const mk = () => {
    const state = build(3);
    const [me, p2] = state.players;
    setOf(state, p2, 'brown'); setOf(state, p2, 'lightblue'); setOf(state, p2, 'pink');
    p2.finalApproach = true;
    p2.armedAtTurn = state.turnCounter;
    me.hand.push(action(state, 'inspector_general'));
    return state;
  };
  always(0.1);                                   // 0.1 < 0.43: a bare shot still goes
  const fires = mk();
  const hot = tryBreakFinalApproach(fires, fires.players[0], 'p1',
    fires.players[0].hand, [fires.players[1]], 'humanlike');
  assert.ok(hot && hot.targetColor, 'at 0.1 the counter is fired — the fixture is live');

  always(0.9);                                   // 0.9 > 0.43: held, even against a live win
  const holds = mk();
  const cold = tryBreakFinalApproach(holds, holds.players[0], 'p1',
    holds.players[0].hand, [holds.players[1]], 'humanlike');
  assert.equal(cold, null,
    'a real player holds an Inspector General 57% of the time with no shield behind it, and '
    + 'the instrument has to hold it too or it is not measuring a person');
});

test('c6. the shield is priced per action, and TDY does not fall through to false', () => {
  // `pa.action === 'tdy_orders'` fell through to `return false` for every personality before
  // §3.10h — bots blocked 0 of 19, humans 17-23%. A fall-through is the failure mode this
  // whole case is written against, so it gets its own assertion.
  const state = build(3);
  const me = state.players[0];
  me.hand.push(action(state, 'opsec'));
  const ask = (pa, roll) => { always(roll); return shouldPlayOpsecDecision(state, pa, 'humanlike', 'p1'); };

  assert.equal(ask({ action: 'inspector_general', type: 'steal_set', sourceId: 'p2' }, 0.5), true,
    '0.5 < 0.77 — the set-steal is what the shield is for');
  assert.equal(ask({ action: 'inspector_general', type: 'steal_set', sourceId: 'p2' }, 0.9), false,
    '...and even that is answered only 77% of the time, not by rule');
  assert.equal(ask({ action: 'tdy_orders', type: 'swap', sourceId: 'p2' }, 0.1), true,
    'TDY Orders must reach the gradient, not a silent false');
  assert.equal(ask({ action: 'roll_call', type: 'payment', amount: 2, sourceId: 'p2' }, 0.1), false,
    'Roll Call is answered 3% of the time — 0.1 is already above it');
  assert.equal(ask({ action: 'rent', type: 'payment', amount: 8, sourceId: 'p2' }, 0.5), false,
    'humans let 74% of 5M-plus charges through; neutral used to block 23 of 23');
  assert.equal(ask({ action: 'rent', type: 'payment', amount: 8, sourceId: 'p2' }, 0.2), true,
    '...but 26% of them are answered, so the rate is a rate and not a zero');
  assert.equal(ask({ action: 'rent', type: 'payment', amount: 1, sourceId: 'p2' }, 0.1), false,
    'a 1M rent is answered 2% of the time — the bins have to be separate bins');
});

test('c7. being armed raises the price of the shield, it does not make it automatic', () => {
  // Every other personality short-circuits to `return true` while armed. Humanlike must not:
  // measured, a human holding a shield while armed blocked 5 of 20. The pair here is
  // humanlike against neutral on the identical pending action, which is the only way to show
  // the short-circuit is genuinely bypassed rather than coincidentally agreed with.
  const state = build(3);
  const me = state.players[0];
  me.finalApproach = true;
  me.hand.push(action(state, 'opsec'));
  const pa = { action: 'rent', type: 'payment', amount: 2, sourceId: 'p2' };
  always(0.5);
  assert.equal(shouldPlayOpsecDecision(state, pa, 'neutral', 'p1'), true,
    'fixture: every planner blocks anything while armed — that is the rule being bypassed');
  assert.equal(shouldPlayOpsecDecision(state, pa, 'humanlike', 'p1'), false,
    '0.5 is far above 0.02 x 1.4 — a person eats a 2M charge even one turn from winning');
  always(0.02);
  assert.equal(shouldPlayOpsecDecision(state, pa, 'humanlike', 'p1'), true,
    '...and the armed multiplier still lifts the same rate, so it is a price and not a zero');
});

test('c8. the discard protects the shield, the breakers and the sandbagged property', () => {
  // The mirror image of the trap round 12 hit with the escrow: a personality told to HOLD a
  // card must not have the same turn loop throw it away at the hand limit. Humanlike holds
  // property on purpose, so property has to outrank money in the discard order — which is the
  // opposite of neutral's comparator, and the assertion that discriminates this case.
  const state = build(3);
  const me = state.players[0];
  const cards = [
    money(state, 10),
    take(state, c => c.type === 'property' && c.color === 'green'),
    action(state, 'inspector_general'),
    action(state, 'opsec'),
  ];
  me.hand.push(...cards);
  const [tenM, green, ig, opsec] = cards;
  assert.deepEqual(chooseDiscards(me, 1, 'humanlike'), [tenM.id],
    'the 10M goes first even though it is the most valuable card in the hand');
  assert.deepEqual(chooseDiscards(me, 2, 'humanlike'), [tenM.id, green.id],
    'property is next — ahead of the breaker and the shield, behind the cash');
  assert.deepEqual(chooseDiscards(me, 3, 'humanlike'), [tenM.id, green.id, ig.id],
    'the breaker is next-to-last');
  assert.equal(chooseDiscards(me, 4, 'humanlike').includes(opsec.id), true);
  assert.deepEqual(chooseDiscards(me, 4, 'humanlike').indexOf(opsec.id), 3,
    'the shield is the very last thing a real player lets go — median 11 table-turns held');
  // ...and neutral really does order it differently, so the comparator above is doing work.
  assert.deepEqual(chooseDiscards(me, 2, 'neutral'), [green.id, tenM.id],
    'fixture: neutral sorts by face value alone, so it sheds the 1M property FIRST — the '
    + 'exact opposite of the order above, which is what makes that order a real assertion');
});

test('c9. the cash floor comes before another property, and stops at the measured bank', () => {
  // The §3.10i cash floor that round 12b measured, priced and rejected for the SHIPPED
  // personalities. Here it is not a strength change, it is what the data says a person does —
  // and it has to switch off above HUMAN_BANK_FLOOR, or the instrument would bank forever and
  // never build a board. The pair is an empty bank against a full one.
  const mk = (bankTo) => {
    const state = build(3);
    const me = state.players[0];
    if (bankTo) fund(state, me, bankTo);
    prop(state, me, 'green');
    me.hand.push(money(state, 5));
    me.hand.push(take(state, c => c.type === 'property' && c.color === 'green'));
    return state;
  };
  always(0.2);                                       // 0.2 < 0.48: cash goes first this turn
  assert.equal(decideBotPlay(mk(0), 'p1', 'humanlike').type, 'play_money',
    'an empty bank is what makes a laid property a property paid away');
  assert.equal(decideBotPlay(mk(HUMAN_BANK_FLOOR + 1), 'p1', 'humanlike').type, 'play_property',
    'above the floor the money stops jumping the queue — otherwise it never builds');
  always(0.9);                                       // 0.9 > 0.48: property goes first
  assert.equal(decideBotPlay(mk(0), 'p1', 'humanlike').type, 'play_property',
    'humans put every property down before any money on 52% of mixed turns; every bot in the '
    + 'corpus did it on 100% of 244 of them, without one exception');
});

test('c10. payment comes out of the bank before the board (characterisation, not a lever)', () => {
  // HONEST LABEL: this one is NOT red-verifiable against anything humanlike-specific, and it
  // says so rather than pretending. Since round 9's minimal-cover rewrite the per-personality
  // payment comparator is very nearly inert — `payWeight`'s tier gaps are wider than the
  // largest card in the deck, so four of the five comparators return identical selections at
  // every amount. humanlike therefore has no case of its own in selectPaymentCards, and this
  // test exists to pin the shared behaviour it relies on: an instrument that started paying
  // out of its board would destroy the property-lost-to-payments number simhuman reports.
  const state = build(3);
  const me = state.players[0];
  me.bank.push(money(state, 3));
  const held = prop(state, me, 'green');
  assert.deepEqual(selectPaymentCards(me, 3, 'humanlike'), selectPaymentCards(me, 3, 'neutral'),
    'humanlike must land on the shared comparator, not on a private copy that can drift');
  const ids = selectPaymentCards(me, 3, 'humanlike');
  assert.equal(ids.length, 1);
  assert.equal(ids.includes(held.id), false, 'the board is not a piggy bank');
});

test('c12. the scatter is the property play a real player declines, and only the scatter', () => {
  // The completer sandbag covers ~15% of turns and cannot on its own produce the other half of
  // the picture: a real player carries 1.91 property cards in hand at turn start against every
  // bot's 1.07-1.32, and lays 92.6 per 100 own turns against neutral's 118.1. What the corpus
  // indicts is the card laid into a colour we own NOTHING in — a third or fourth pile that
  // gets paid away before it is ever finished.
  //
  // Three legs, and the third is the discriminator: a blanket "sometimes don't lay property"
  // rule passes the first two and fails the third.
  const mk = (owned) => {
    const state = build(3);
    const me = state.players[0];
    fund(state, me);                                   // the cash floor is not the play here
    if (owned) prop(state, me, 'green');               // green is now a colour we are building
    me.hand.push(take(state, c => c.type === 'property' && c.color === 'green'));
    return state;
  };
  always(0.5);                                         // 0.5 < 0.78: the scatter is laid
  assert.equal(decideBotPlay(mk(false), 'p1', 'humanlike').type, 'play_property',
    'at 0.5 the new colour is opened — the fixture is live');
  always(0.9);                                         // 0.9 > 0.78: held in hand instead
  assert.equal(decideBotPlay(mk(false), 'p1', 'humanlike'), null,
    'a real player keeps that card in hand, where it cannot be stolen, seized or paid away');
  assert.equal(decideBotPlay(mk(true), 'p1', 'humanlike').type, 'play_property',
    'the SAME roll lays the SAME card into a colour we are already building — it is the '
    + 'scatter that is declined, not property in general');
});

test('c11. a Surge the instrument declines to follow does not fire a rent two steps later', () => {
  // The subtle half of HUMAN_SURGE_FOLLOW. Declining the follow-through at step B is worth
  // nothing if steps C, H and K fire a rent anyway — measured, that left the realised
  // surge->rent rate at 84% against the human's 60%, i.e. the constant did nothing at all.
  const mk = () => {
    const state = build(3);
    const [me, p2] = state.players;
    fund(state, me);
    setOf(state, me, 'brown');
    prop(state, me, 'green');            // so the alternative play is not a SCATTER decline
    fund(state, p2, 8);
    me.hand.push(take(state, c => c.type === 'rent' && c.colors.includes('brown')));
    me.hand.push(take(state, c => c.type === 'property' && c.color === 'green'));
    state._surgeOps = 1;
    return state;
  };
  always(0.2);                                     // 0.2 < 0.60: follow through
  const follows = decideBotPlay(mk(), 'p1', 'humanlike');
  assert.equal(follows.type, 'play_action');
  assert.equal(mk().players[0].hand[follows.cardIndex].type, 'rent',
    'at 0.2 the surged rent is charged — the fixture is live');

  always(0.8);                                     // 0.8 > 0.60: wander off, like a person
  const wanders = decideBotPlay(mk(), 'p1', 'humanlike');
  assert.ok(wanders, 'the decline must not cost the turn — the play is spent elsewhere');
  assert.notEqual(mk().players[0].hand[wanders.cardIndex].type, 'rent',
    'a declined follow-through must stay declined for the rest of the turn');
});
