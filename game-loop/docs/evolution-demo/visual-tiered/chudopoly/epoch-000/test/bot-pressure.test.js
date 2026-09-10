// test/bot-pressure.test.js — Cluster 3: economic pressure and arming discipline.
//
// Owner ask (docs/bot-foresight-research.md §4): "charge as much rent as possible to someone
// in final approach so they have to give up some of their sets." Measured over 400 games at
// every opponent turn taken while somebody was armed (2,010 samples), that cannot work:
//
//   armed player's disposable value   median 24M   mean 26.1M
//   best stacked charge available     median  2M   mean  3.1M
//   turns where any charge sequence could exceed the cushion:  50 / 2,010 = 2.5%
//   charges that did land and were payable out of loose change:      88.2%
//
// You cannot bankrupt somebody during Final Approach. But the same instrumentation says the
// leader's bank is a median of 4M at one set, 8M at two, and 13M (+9M loose property) the
// moment they arm. **The leverage is spent between the second set and the third**, and today
// `chooseRentTarget`/`rentYield` (bot.js:1843/1877) pick a charge target by what it COLLECTS,
// which actively prefers rich targets — and a rich target is by definition the one a charge
// cannot hurt.
//
// Three behaviours are pinned here. Every positive assertion below was proven RED against the
// tree at 338902b before the implementation existed (§8), with the exception of the legs
// explicitly commented `GUARD` — those pin behaviour that is already correct so the new code
// cannot over-fire and break it.
//
//   (a) cushion warfare  — charge TARGETING aimed at the player sitting at `setsToWin - 1`,
//                          read from the room's rules and never hardcoded. It ships inside
//                          `chooseRentTarget` and `findFinanceTarget` and NOWHERE ELSE: the
//                          tempo override that would have made a charge at the leader outrank
//                          board-building was cut, because leader-bashing that displaces our
//                          own build lengthens games and invites kingmaking.
//   (b) the grace-cycle bar — what the break branch will and will not fire at an armed
//                          player. The lap-aware version of this bar (charge at
//                          `spare / opponentTurnsRemainingInLap`) was designed, reviewed and
//                          CUT: it shares the two properties that made round 5's removed
//                          "charge them anyway" fallback fail, and the cluster-3 agent that
//                          proposed it recommended against shipping it. What is pinned here
//                          is the bar that DID ship.
//   (c) arm-turn preparation — complete the winning set with plays still in hand, and treat
//                          the OPSEC as the most valuable card in the hand while doing it.
//
// Everything drives Bot._internal directly — the same entry point server.js and simulate.js
// use — so a pass means the LIVE bot behaves this way.

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');
const Bot = require('../bot');

const I = Bot._internal;
const { decideBotPlay, setRng, chooseDiscards, disposableValue, applyBotAction } = I;

/* ── helpers ─────────────────────────────────────────────────────────── */

function build(seats = 3, opts = {}) {
  const players = Array.from({ length: seats }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  const state = G.createGame(players, Object.assign({ seed: 'botpress' }, opts));
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
function propCard(state, color) { return take(state, x => x.type === 'property' && x.color === color); }
function prop(state, player, color) {
  const c = propCard(state, color);
  (player.properties[color] = player.properties[color] || []).push({ ...c, placedColor: color });
  return c;
}
function setOf(state, p, color) {
  while ((p.properties[color] || []).length < G.COLORS[color].size) prop(state, p, color);
}
function wildRent(state) { return take(state, c => c.type === 'rent' && c.colors[0] === 'any'); }
function colorRent(state, colors) {
  return take(state, c => c.type === 'rent' && c.colors.length === colors.length
    && colors.every(k => c.colors.includes(k)));
}
function bankUp(state, p, values) { for (const v of values) p.bank.push(money(state, v)); }
function always(v) { setRng(() => v); }
test.afterEach(() => setRng(null));

const PLANNERS = ['conservative', 'neutral', 'aggressive'];
const CHAOTIC = ['chud', 'random'];

/* ═══ (a) CUSHION WARFARE ═══════════════════════════════════════════════ */

/* ── a1. the dial exists, and it is a GRADED axis, not a fifth clone ──── */

test('cushion pressure is a graded per-personality axis and the chaotic seats have none', () => {
  // §"Distinctness, checked not assumed" is a gate in this repo: five patient bots that all
  // squeeze the leader are one bot. Conservative and neutral learn this, aggressive already
  // attacks everything so it only learns to AIM, and chud/random must not learn it at all —
  // which is also what keeps their seeded RNG stream byte-identical (see a2).
  assert.ok(I.CUSHION_PRESSURE, 'CUSHION_PRESSURE is not exported from bot.js _internal');
  for (const mode of CHAOTIC) {
    assert.equal(I.CUSHION_PRESSURE[mode], 0, `${mode} must not learn cushion targeting`);
  }
  assert.ok(I.CUSHION_PRESSURE.conservative > 0, 'conservative should squeeze the leader');
  assert.ok(I.CUSHION_PRESSURE.neutral > 0, 'neutral should squeeze the leader');
  assert.ok(I.CUSHION_PRESSURE.conservative >= I.CUSHION_PRESSURE.neutral
    && I.CUSHION_PRESSURE.neutral > I.CUSHION_PRESSURE.aggressive,
    'the axis must stay ordered conservative >= neutral > aggressive');
  assert.ok(I.CUSHION_GAIN > 0,
    'CUSHION_GAIN is the scale of the cushion term against the plain "what does this collect" '
    + 'score — the primary dial, and it must be exported to be sweepable');
});

/* ── a2. seeded-RNG discipline: no draw for a zero-weight mode ────────── */

test('the chaotic seats get no arm-turn preparation, and it costs them no RNG draw', () => {
  // Every new rnd() call shifts the whole downstream stream and invalidates paired-seed
  // before/after comparison. CARD_AWARENESS and ORDER_ATTENTION short-circuit the roll for a
  // zero-weight personality precisely so chud and random keep their exact current stream;
  // arm-turn preparation does the same, and more cheaply — it is gated on BREAKER_BAR being
  // non-null, which is a lookup rather than a roll, so it consumes no randomness for ANY
  // personality. Chaos stays chaotic: a chud that has two sets and the third in hand goes on
  // harassing, which is its whole character.
  const state = build(3);
  const bot = state.players[0];
  setOf(state, bot, 'brown'); setOf(state, bot, 'lightblue');
  prop(state, bot, 'pink'); prop(state, bot, 'pink');       // 2/3 pink — one card arms us
  bot.hand.push(propCard(state, 'pink'), action(state, 'inspector_general'));
  setOf(state, state.players[1], 'red');
  assert.equal(G.completedSets(bot), G.setsToWinOf(state) - 1, 'fixture: one set from winning');

  for (const mode of CHAOTIC) {
    let draws = 0;
    setRng(() => { draws++; return 0; });
    assert.equal(I.tryArmingPlay(state, bot, mode), null,
      `${mode} produced an arming play — the chaotic seats get no arm-turn preparation`);
    assert.equal(I.tryArmingBreaker(state, bot, 'p1', mode), null,
      `${mode} produced an arming breaker shot`);
    assert.equal(draws, 0,
      `${mode} consumed ${draws} RNG draw(s); a barless mode must short-circuit before any `
      + 'roll or every seeded before/after comparison is invalidated');
    setRng(null);
  }

  // and the planners DO get it, from the same board — otherwise the assertions above are
  // green because the fixture is empty rather than because the gate works
  for (const mode of PLANNERS) {
    let draws = 0;
    setRng(() => { draws++; return 0; });
    const armNow = I.tryArmingPlay(state, bot, mode);
    assert.ok(armNow && armNow.type === 'play_property',
      `${mode} did not reach for the property that completes its winning set`);
    assert.equal(draws, 0, `${mode} spent an RNG draw on arm-turn preparation`);
    setRng(null);
  }
});

/* ── a3. the leverage window is read from the room, never hardcoded ───── */

test('the pre-armed leader is `setsToWin - 1`, read from the room rules', () => {
  // setsToWin is a per-room rule (3/4/5). A hardcoded 2 is right only in a default room and
  // silently squeezes the wrong player everywhere else.
  assert.equal(typeof I.preArmedLeader, 'function',
    'preArmedLeader(state, p) is not exported from bot.js _internal');

  const three = build(4);
  const four = build(4, { setsToWin: 4 });
  assert.equal(G.setsToWinOf(three), 3);
  assert.equal(G.setsToWinOf(four), 4);

  for (const [state, label] of [[three, 'setsToWin:3'], [four, 'setsToWin:4']]) {
    const two = state.players[1], threeSet = state.players[2];
    setOf(state, two, 'red'); setOf(state, two, 'yellow'); bankUp(state, two, [2]);
    setOf(state, threeSet, 'brown'); setOf(state, threeSet, 'lightblue');
    setOf(state, threeSet, 'pink'); bankUp(state, threeSet, [2]);
    const want = G.setsToWinOf(state) - 1;
    assert.equal(I.preArmedLeader(state, two), G.completedSets(two) >= want,
      `${label}: a 2-set player is the leverage window iff setsToWin - 1 <= 2`);
    assert.equal(I.preArmedLeader(state, threeSet), G.completedSets(threeSet) >= want,
      `${label}: a 3-set player is the leverage window iff setsToWin - 1 <= 3`);
  }
});

test('an ARMED player carries no cushion weight — that window has already closed', () => {
  // §4: by the time a player arms they sit on a 13M bank plus 9M of loose property and no
  // lap of charges gets through it. tryBreakFinalApproach owns the armed player; cushion
  // pressure is strictly the pre-arming posture, and pointing it at an armed player would
  // just re-buy the 2.5% branch at full price.
  assert.equal(typeof I.preArmedLeader, 'function',
    'preArmedLeader(state, opp) is not exported from bot.js _internal');
  const state = build(3);
  const armed = state.players[1];
  setOf(state, armed, 'brown'); setOf(state, armed, 'lightblue'); setOf(state, armed, 'pink');
  armed.finalApproach = true;
  armed.armedAtTurn = state.turnCounter || 0;
  assert.equal(I.preArmedLeader(state, armed), false,
    'an armed player was scored as a pre-armed leader');
});

/* ── a4. targeting: the thin leader beats the fat bystander ───────────── */

test('a wild rent goes to the thin-cushioned two-set leader, not the fat one-set bank', () => {
  // The measured inversion, minimally. p2 is one set from winning and every millon it owns
  // is locked inside a COMPLETE SET behind a 2M cushion — this charge forces a set card out.
  // p3 has one set and 15M of loose change and cannot be hurt at all. The plain scorer
  // (`collectableFrom` + 2 per set) ranks p3 at 23 against p2's 20 and fires at the player
  // it cannot hurt; the cushion term takes p2 to 30 because the charge removes 100% of the
  // slack between them and a broken set.
  //
  // All three planners, because the axis is graded (1 / 1 / 0.7) but not off anywhere: at
  // CUSHION_GAIN 10 even aggressive's 0.7 clears the gap.
  for (const mode of PLANNERS) {
    const state = build(3);
    const bot = state.players[0], leader = state.players[1], rich = state.players[2];
    setOf(state, bot, 'darkblue');
    setOf(state, leader, 'brown'); setOf(state, leader, 'green'); bankUp(state, leader, [2]);
    setOf(state, rich, 'pink'); bankUp(state, rich, [10, 5]);
    bot.hand.push(wildRent(state));
    state._surgeOps = 2;                      // face 32M — big enough that nothing is capped

    assert.equal(G.completedSets(leader), G.setsToWinOf(state) - 1);
    assert.equal(disposableValue(leader), 2, 'fixture: the leader must have a 2M cushion');
    assert.ok(disposableValue(rich) > 10, 'fixture: the bystander must be unhurtable');
    assert.ok(G.playerTotalValue(rich) > G.playerTotalValue(leader),
      'fixture: the plain "what does this collect" score must prefer the bystander, or this '
      + 'test passes without the cushion term');

    always(0);
    const plan = decideBotPlay(state, 'p1', mode);
    assert.ok(plan, `${mode} produced no plan`);
    assert.equal(plan.type, 'play_action', `${mode} did not charge`);
    assert.equal(bot.hand[plan.cardIndex].type, 'rent', `${mode} did not fire the rent`);
    assert.equal(plan.targetId, 'p2',
      `${mode} aimed a 32M charge at p3 (15M of loose change, one set) instead of p2 `
      + '(2M of cushion, one set from winning) — a rich target is the one a charge cannot hurt');
    assert.ok(applyBotAction(state, 'p1', plan).ok, `${mode}'s charge was refused by the engine`);
  }
});

test('Finance Office is aimed at the pre-armed leader, not the richest bank', () => {
  // findFinanceTarget() prefers the richest BANK (round 10: cash leaves without breaking a
  // board). That is the right default and the wrong answer against a player one set from
  // winning: 5M off a 4M cushion breaks a set, 5M off a 19M bank is a rounding error.
  // conservative and neutral already reach the leader through tryDefensiveOffense's
  // threat loop; aggressive goes through findFinanceTarget and gets it wrong.
  const state = build(3);
  const bot = state.players[0], leader = state.players[1], rich = state.players[2];
  setOf(state, leader, 'brown'); setOf(state, leader, 'lightblue'); bankUp(state, leader, [4]);
  setOf(state, rich, 'pink'); bankUp(state, rich, [10, 5, 4]);
  bot.hand.push(action(state, 'finance_office'));

  always(0);
  const plan = decideBotPlay(state, 'p1', 'aggressive');
  assert.ok(plan, 'aggressive produced no plan');
  assert.equal(bot.hand[plan.cardIndex].action, 'finance_office');
  assert.equal(plan.targetId, 'p2',
    'aggressive demanded 5M from p3 (19M bank, one set) instead of p2 (4M bank, one set from '
    + 'winning) — the 5M that breaks a set is worth more than the 5M that does not');
  assert.ok(applyBotAction(state, 'p1', plan).ok, 'the Finance Office was refused by the engine');
});

test('cushion pressure never resurrects a charge that collects nothing (round 10)', () => {
  // GUARD — green on the pre-change tree and it must stay green. Round 10 removed every
  // charge that collects nothing (470/13,692 → 0), and the cushion term is the obvious way
  // to bring one back: it is the first thing in this scorer that adds value for a reason
  // other than what the charge collects. It is protected twice — the term is gated on
  // `take > 0`, AND it is written as `min(1, take / cushion)` so a zero collection scores
  // zero however the gate is edited. Written the other way round — crediting the FRACTION OF
  // THE CUSHION LEFT BEHIND rather than the fraction taken — it would rank an empty seat top.
  const state = build(3);
  const bot = state.players[0], leader = state.players[1];
  setOf(state, bot, 'darkblue');
  // A leader whose whole board is complete sets still owns something and CAN be charged —
  // that is a set-break, not waste. The waste case is an eliminated/empty seat.
  const empty = state.players[2];
  bot.hand.push(wildRent(state));
  setOf(state, leader, 'brown'); setOf(state, leader, 'lightblue');
  assert.equal(G.playerTotalValue(empty), 0, 'fixture: p3 owns nothing');

  always(0);
  const plan = decideBotPlay(state, 'p1', 'conservative');
  assert.ok(plan && plan.type === 'play_action' && bot.hand[plan.cardIndex].type === 'rent',
    'fixture: conservative must actually fire the wild rent, or this guard proves nothing');
  assert.notEqual(plan.targetId, 'p3', 'a wild rent was aimed at a player who owns nothing');
  assert.equal(plan.targetId, 'p2');
  assert.ok(applyBotAction(state, 'p1', plan).ok, 'the charge was refused by the engine');
});

/* ═══ (b) THE GRACE-CYCLE BAR ═══════════════════════════════════════════ */
//
// NOT SHIPPED, and recorded here so it is not proposed a third time: the lap-aware charge,
// which would have divided the break branch's bar by the number of opponent turns left
// before the armed player's checkpoint. `tryBreakFinalApproach` step 4 already runs ahead of
// decideBotPlay's holdback, so widening its bar widens exactly the override round 5 measured
// and removed ("charge them anyway": conversion moved 0.4-1.5 points, inside run noise, while
// 5-player games decided on points went 8.3% -> 8.9%). Scaling the bar by the lap rather than
// removing it is not the same change, but it shares the two properties that made the old one
// fail, and the agent that proposed it recommended against it. It was cut.
//
// What ships, and what is pinned below, is the SEQUENCE bar: the branch fires only when the
// charges that fit in THIS TURN add up to more than the victim can cover out of loose change.
// A charge they can pay in full cannot disarm anybody by definition.

test('the break branch fires a charge only when the turn\'s charges outrun the cushion', () => {
  // §4 is why this bar is tight rather than generous: an armed player's disposable value is a
  // median of 24M while the best stacked charge available is a median of 2M, and on only 2.5%
  // of grace-cycle turns (50 of 2,010) could any charge sequence exceed the cushion. Firing
  // anyway is not pressure, it is 88.2% of charges being paid out of pocket change while the
  // rent card that could have mattered later is gone.
  //
  // A: an 8M charge into a 22M cushion — the 97.5% case. Held.
  const a = build(4);
  const botA = a.players[0], fatVictim = a.players[1];
  setOf(a, botA, 'darkblue');
  setOf(a, fatVictim, 'brown'); setOf(a, fatVictim, 'lightblue'); setOf(a, fatVictim, 'pink');
  bankUp(a, fatVictim, [10, 5, 4, 3]);
  fatVictim.finalApproach = true;
  fatVictim.armedAtTurn = a.turnCounter || 0;
  botA.hand.push(colorRent(a, ['green', 'darkblue']));

  assert.equal(disposableValue(fatVictim), 22, 'fixture: 22M cushion');
  assert.equal(G.calcRent(botA, 'darkblue'), 8, 'fixture: an 8M charge');

  always(1);   // fail both overpay rolls, so PCS Orders and attrition cannot answer instead
  assert.equal(I.tryBreakFinalApproach(a, botA, 'p1', botA.hand, [fatVictim], 'neutral'), null,
    'an 8M charge fired into a 22M cushion — it disarms nobody and it is the attrition '
    + 'fallback round 5 measured and removed');
  setRng(null);

  // B: the same 8M charge into a 3M cushion — now a set card has to come out. Fires.
  const b = build(4);
  const botB = b.players[0], thinVictim = b.players[1];
  setOf(b, botB, 'darkblue');
  setOf(b, thinVictim, 'brown'); setOf(b, thinVictim, 'lightblue'); setOf(b, thinVictim, 'pink');
  bankUp(b, thinVictim, [3]);
  thinVictim.finalApproach = true;
  thinVictim.armedAtTurn = b.turnCounter || 0;
  botB.hand.push(colorRent(b, ['green', 'darkblue']));

  assert.equal(disposableValue(thinVictim), 3, 'fixture: 3M cushion');

  always(1);
  const plan = I.tryBreakFinalApproach(b, botB, 'p1', botB.hand, [thinVictim], 'neutral');
  assert.ok(plan, 'the break branch declined a charge that forces a set card out');
  assert.equal(plan.type, 'play_action');
  assert.equal(botB.hand[plan.cardIndex].type, 'rent', 'the branch did not fire the rent');
  assert.ok(applyBotAction(b, 'p1', plan).ok, 'the charge was refused by the engine');
});
/* ═══ (c) ARM-TURN PREPARATION ══════════════════════════════════════════ */

test('the winning set is completed BEFORE the turn is spent attacking', () => {
  // Measured: bots arm holding an OPSEC 22.2% of the time with a median 13M bank, and the
  // mean arming turn is 30.7 of a ~33-turn game — the grace cycle IS the endgame and they
  // enter it unprepared 78% of the time. `finalApproach` is stamped the instant syncSets
  // sees the set (game.js:704), so every play AFTER the completing one is already covered by
  // tryDefendFinalApproach, which banks. What decides whether there ARE any is the ORDER: a
  // planner that spends three plays attacking and lays the winning property last arms with
  // nothing behind it.
  //
  // Note this fixture also puts a two-set opponent on the table, so it doubles as the
  // precedence test: arming ourselves outranks squeezing somebody else's cushion.
  for (const [mode, card] of [['aggressive', 'chud'], ['conservative', 'finance_office'],
                              ['neutral', 'finance_office']]) {
    const state = build(3);
    const bot = state.players[0], opp = state.players[1], opp2 = state.players[2];
    setOf(state, bot, 'brown'); setOf(state, bot, 'lightblue');
    prop(state, bot, 'pink'); prop(state, bot, 'pink');
    setOf(state, opp, 'red'); setOf(state, opp, 'yellow'); bankUp(state, opp, [4]);
    prop(state, opp2, 'orange'); bankUp(state, opp2, [2]);
    const attack = action(state, card);
    const completer = propCard(state, 'pink');
    bot.hand.push(attack, completer);

    assert.equal(G.completedSets(bot), G.setsToWinOf(state) - 1, 'fixture: one set from winning');
    assert.equal(state.playsRemaining, 3);

    always(0);
    const plan = decideBotPlay(state, 'p1', mode);
    assert.ok(plan, `${mode} produced no plan`);
    assert.equal(plan.type, 'play_property',
      `${mode} played ${card} with the winning property still in hand — it will arm on its `
      + 'last play with no turn left to bank behind the shield');
    assert.equal(bot.hand[plan.cardIndex].id, completer.id, `${mode} laid the wrong property`);
    assert.ok(applyBotAction(state, 'p1', plan).ok, `${mode}'s arming play was refused`);
    assert.ok(bot.finalApproach, 'the engine should have armed the bot on that play');
    assert.ok(state.playsRemaining >= 2, 'the bot should still hold plays to prepare with');
  }
});

test('a bot one set from winning does not discard its OPSEC', () => {
  // "Do not complete your final set until you can defend it" is the one principle the field
  // is unanimous on, and the shield is the only card that answers an Inspector General.
  // aggressive's discard comparator keeps ACTIONS over money and then sorts ascending by
  // value, which throws a 4M OPSEC away and keeps a 5M Inspector General on the exact turn
  // the shield is about to become the whole game. conservative and neutral already sort the
  // shield to the back; this makes it universal for a bot at `setsToWin - 1`.
  for (const mode of PLANNERS) {
    const state = build(3);
    const bot = state.players[0];
    setOf(state, bot, 'brown'); setOf(state, bot, 'lightblue');
    const shield = action(state, 'opsec');
    bot.hand.push(shield, action(state, 'inspector_general'));
    assert.equal(G.completedSets(bot), G.setsToWinOf(state) - 1, 'fixture: one set from winning');
    always(0);
    const ids = chooseDiscards(bot, 1, mode);
    assert.ok(!ids.includes(shield.id),
      `${mode} discarded the OPSEC while one set from winning — it arms naked, which is what `
      + '78% of measured armings already do');
  }
});

/* ── round 12 addendum: the fifth Finance Office call site ──────────────────
 *
 * Round 10 removed charges that collect nothing, and it reached four of the five places a
 * Finance Office target is chosen — findFinanceTarget and randomPayer both filter on canPay.
 * tryDefensiveOffense's branch returned the FIRST threat unconditionally.
 *
 * A threat normally has value by construction (two complete sets), and in the DEFAULT deck
 * the blunder is unreachable: the rainbow wilds are the only 0M cards and there are just two
 * of them, so a player cannot build two complete sets worth nothing. But `wildAny` is a host
 * knob and DECK_KIND_MAX allows 4 — at which point brown (size 2) and intel (size 2) can both
 * be filled with 0M wilds and a THREAT is worth exactly nothing to charge. This test builds
 * that legal room.
 *
 * Found while chasing a report that bots repeatedly charged a seat which could not pay. That
 * report did not survive contact with the log: of the 9 insolvencies in the game concerned,
 * 5 came from multi-target rents and 3 from Roll Call, both of which hit every opponent BY
 * RULE rather than by choice, leaving a single targeted charge. This is the real defect the
 * search turned up.
 */
test('Finance Office is never fired at a threat with nothing to take', () => {
  const players = [1, 2, 3].map(i => ({ id: `p${i}`, name: `P${i}` }));
  const state = G.createGame(players, { seed: 'financezero', deck: { wildAny: 4 } });
  state.deck = G.buildDeck(state.rules.deck);
  state.discardPile = [];
  state.pendingAction = null;
  state.players.forEach(p => { p.hand = []; p.bank = []; p.properties = {}; p.upgrades = {}; });
  state.turnPhase = 'play';
  state.currentPlayerIndex = 0;
  state.playsRemaining = 3;
  state.cardTotal = null;
  state._handSnapshot = 0;

  const [me, p2, p3] = state.players;
  const grab = (fn) => { const i = state.deck.findIndex(fn); return i < 0 ? null : state.deck.splice(i, 1)[0]; };
  const rainbow = () => grab(c => c.type === 'wild_property' && c.colors[0] === 'any');

  // p2 reads as a THREAT — two complete sets — built entirely from 0M rainbow wilds.
  for (const color of ['brown', 'intel']) {
    p2.properties[color] = [];
    for (let k = 0; k < G.COLORS[color].size; k++) {
      const w = rainbow();
      assert.ok(w, 'fixture: wildAny 4 must supply four rainbow wilds');
      p2.properties[color].push({ ...w, placedColor: color });
    }
  }
  p3.bank.push(grab(c => c.type === 'money' && c.value === 5));
  me.hand.push(grab(c => c.action === 'finance_office'));

  assert.equal(G.completedSets(p2), 2, 'fixture: p2 must read as a threat');
  assert.equal(G.playerTotalValue(p2), 0, 'fixture: and must be worth nothing to charge');

  setRng(() => 0);
  const plan = decideBotPlay(state, me.id, 'neutral');
  setRng(null);
  if (plan && plan.type === 'play_action' && me.hand[plan.cardIndex]?.action === 'finance_office') {
    assert.notEqual(plan.targetId, p2.id, 'a 5M demand was fired at a player holding 0M');
  }
});
