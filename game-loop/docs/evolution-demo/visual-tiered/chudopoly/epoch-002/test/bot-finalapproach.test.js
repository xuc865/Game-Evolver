// test/bot-finalapproach.test.js — §3.10, the breaking half.
//
// Owner report (2026-08-07): "when playing against bots, if someone is on final approach I
// want the bots to do everything they can to stop them." The break branch already existed;
// what it did NOT do was model the victim correctly, and it threw plays away on moves the
// rules had already locked out. These tests pin the four things that were actually wrong, so
// they cannot regress quietly the way the TDY reversal did.
//
// Everything here drives Bot._internal.decideBotPlay directly — the same entry point
// simulate.js and server.js use — so a pass means the LIVE bot behaves this way.

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');
const Bot = require('../bot');

const { decideBotPlay, setRng } = Bot._internal;

/* ── helpers ─────────────────────────────────────────────────────────── */

function build(seats = 3) {
  const players = Array.from({ length: seats }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  const state = G.createGame(players, { seed: 'botfa' });
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
function setOf(state, p, color) {
  while ((p.properties[color] || []).length < G.COLORS[color].size) prop(state, p, color);
}
function action(state, name) { return take(state, c => c.action === name); }
function money(state, value) { return take(state, c => c.type === 'money' && c.value === value); }

// Arm a player for real, through the engine's own accounting, so `armedAtTurn` and the
// checkpoint forecast are populated exactly as they would be in a live game.
function arm(state, p, colors) {
  for (const c of colors) setOf(state, p, c);
  p.finalApproach = true;
  p.armedAtTurn = state.turnCounter || 0;
  assert.ok(G.completedSets(p) >= 3, 'helper must actually build three sets');
}

// Deterministic RNG so the personality gates are not the thing under test.
function always(v) { setRng(() => v); }
test.afterEach(() => setRng(null));

const PLANNERS = ['conservative', 'neutral', 'aggressive', 'chud'];

/* ── 1. every planning personality fires the hard breakers ───────────── */

test('every planning personality spends Inspector General on an armed opponent', () => {
  for (const mode of PLANNERS) {
    const state = build();
    arm(state, state.players[1], ['brown', 'lightblue', 'pink']);
    const bot = state.players[0];
    bot.hand.push(action(state, 'inspector_general'), money(state, 3), money(state, 4));
    always(0);   // pass every urgency roll
    const plan = decideBotPlay(state, 'p1', mode);
    assert.ok(plan, `${mode} produced no plan`);
    assert.equal(plan.type, 'play_action', `${mode} did not play an action`);
    assert.equal(bot.hand[plan.cardIndex].action, 'inspector_general', `${mode} did not fire IG`);
    assert.equal(plan.targetId, 'p2');
    // and the engine must accept it — a plan the rules refuse is a wasted turn
    assert.ok(G.playAction(state, 'p1', plan.cardIndex, plan).ok, `${mode}'s IG was refused`);
  }
});

test('THE CHUD CARD is aimed into the complete set, and the engine accepts it', () => {
  for (const mode of PLANNERS) {
    const state = build();
    const victim = state.players[1];
    arm(state, victim, ['brown', 'lightblue', 'pink']);
    const bot = state.players[0];
    bot.hand.push(action(state, 'chud'), money(state, 3));
    always(0);
    const plan = decideBotPlay(state, 'p1', mode);
    assert.equal(bot.hand[plan.cardIndex].action, 'chud', `${mode} did not fire CHUD`);
    const inSet = Object.entries(victim.properties)
      .filter(([col]) => G.isSetComplete(victim, col))
      .some(([, cards]) => cards.some(c => c.id === plan.targetCardId));
    assert.ok(inSet, `${mode} aimed CHUD outside a complete set — it disarms nobody`);
    assert.ok(G.playAction(state, 'p1', plan.cardIndex, plan).ok, `${mode}'s CHUD was refused`);
  }
});

/* ── 2. the rules lock-outs are respected (the TDY reversal, §3.1) ───── */

test('TDY Orders and Midnight Requisition are never proposed as the disarming move', () => {
  // Both are barred from complete sets by zoneRequisitionable(). The victim here holds
  // NOTHING but complete sets, so neither card has any legal set-breaking target at all.
  for (const mode of PLANNERS) {
    const state = build();
    const victim = state.players[1];
    arm(state, victim, ['brown', 'lightblue', 'pink']);
    const bot = state.players[0];
    setOf(state, bot, 'intel');   // give TDY something of ours to offer
    bot.hand.push(action(state, 'tdy_orders'), action(state, 'midnight_requisition'));
    always(0);
    const plan = decideBotPlay(state, 'p1', mode);
    if (plan && plan.type === 'play_action') {
      const played = bot.hand[plan.cardIndex].action;
      if (played === 'tdy_orders' || played === 'midnight_requisition') {
        // If it is proposed at all it must at least be legal — never a burned play.
        assert.ok(G.playAction(state, 'p1', plan.cardIndex, plan).ok,
          `${mode} proposed an illegal ${played} against a player with only complete sets`);
      }
    }
  }
});

/* ── 3. Surge Ops is never burned on a charge it cannot double (§3.1c) ─ */

test('Surge Ops is not played ahead of Finance Office — it doubles rent only', () => {
  // The old break code surged before Finance Office and threw the play away, at the one
  // moment in the game when plays are worth the most. chargeAmount() passes no
  // `surgeable` flag for finance_office, so the multiplier is always 1.
  for (const mode of PLANNERS) {
    const state = build();
    arm(state, state.players[1], ['brown', 'lightblue', 'pink']);
    const bot = state.players[0];
    bot.hand.push(action(state, 'surge_ops'), action(state, 'finance_office'));
    always(0);
    const plan = decideBotPlay(state, 'p1', mode);
    assert.ok(plan, `${mode} produced no plan`);
    assert.notEqual(bot.hand[plan.cardIndex].action, 'surge_ops',
      `${mode} burned a play surging a Finance Office that cannot be surged`);
  }
});

/* ── 4. a charge is only a break if it beats what they can pay ───────── */

test('no charge is aimed at an armed player who can settle it out of loose change', () => {
  // Victim is armed but rich: 10M in the bank. Finance Office (5M) and a 2M Roll Call both
  // bounce off, so neither may be chosen as the *disarming* move.
  const state = build();
  const victim = state.players[1];
  arm(state, victim, ['brown', 'lightblue', 'pink']);
  victim.bank.push(money(state, 5), money(state, 5));
  const bot = state.players[0];
  bot.hand.push(action(state, 'finance_office'), action(state, 'roll_call'));
  always(0.99);   // fail the overpay roll: attrition is off, only certain breaks allowed
  // Asked of the break branch itself. Playing Finance Office at a rich player is perfectly
  // good ORDINARY play and the personality planner may still do it; what must not happen is
  // the bot mistaking it for a disarming move and skipping something that would actually work.
  const shot = Bot._internal.tryBreakFinalApproach(state, bot, 'p1', bot.hand, [victim], 'conservative');
  assert.equal(shot, null, 'offered a charge the victim covers twice over as a break');
  assert.equal(Bot._internal.disposableValue(victim), 10);
});

test('a charge IS aimed at an armed player who has spent down to nothing', () => {
  const state = build();
  const victim = state.players[1];
  arm(state, victim, ['brown', 'lightblue', 'pink']);   // no bank, no loose properties
  const bot = state.players[0];
  setOf(state, bot, 'intel');
  bot.hand.push(action(state, 'finance_office'));
  always(0);
  const plan = decideBotPlay(state, 'p1', 'neutral');
  assert.ok(plan && plan.type === 'play_action');
  assert.equal(bot.hand[plan.cardIndex].action, 'finance_office');
  assert.equal(plan.targetId, 'p2');
});

/* ── 5. spend now, not later ─────────────────────────────────────────── */

test('a hard breaker is never banked as money while an opponent is armed', () => {
  // Inspector General is the highest-value card in the deck (5M), so "bank the biggest
  // thing" reaches for it first. While anybody is armed it is a weapon, not currency.
  for (const mode of [...PLANNERS, 'random']) {
    for (const armSelf of [false, true]) {
      const state = build();
      arm(state, state.players[1], ['brown', 'lightblue', 'pink']);
      const bot = state.players[0];
      if (armSelf) arm(state, bot, ['orange', 'red', 'yellow']);
      bot.hand.push(action(state, 'inspector_general'), action(state, 'chud'));
      for (let r = 0; r < 3; r++) {
        always(r / 3);
        const plan = decideBotPlay(state, 'p1', mode);
        if (plan && plan.type === 'play_money') {
          assert.ok(!['inspector_general', 'chud'].includes(bot.hand[plan.cardIndex].action),
            `${mode} banked a hard breaker (armed self: ${armSelf})`);
        }
      }
    }
  }
});

test('with no counter in hand, the bot digs with PCS Orders rather than building', () => {
  // There is no next turn to draw into. A speculative draw beats any ordinary play.
  const state = build();
  arm(state, state.players[1], ['brown', 'lightblue', 'pink']);
  const bot = state.players[0];
  bot.hand.push(take(state, c => c.type === 'property' && c.color === 'green'),
    action(state, 'pcs_orders'));
  always(0);
  const plan = decideBotPlay(state, 'p1', 'aggressive');
  assert.ok(plan && plan.type === 'play_action');
  assert.equal(bot.hand[plan.cardIndex].action, 'pcs_orders');
});

/* ── 6. multiple armed opponents, and being armed yourself ───────────── */

test('the shot goes at whoever converts FIRST, not whoever has the most sets', () => {
  const state = build(4);
  const [bot, soon, later] = [state.players[0], state.players[1], state.players[3]];
  // p2 is the very next seat — its checkpoint arrives before p4's.
  arm(state, soon, ['brown', 'lightblue', 'pink']);
  arm(state, later, ['orange', 'red', 'yellow']);
  setOf(state, later, 'green');    // p4 has MORE sets, but converts later
  assert.ok(G.completedSets(later) > G.completedSets(soon));
  assert.ok(G.checkpointForecast(state, soon).turn < G.checkpointForecast(state, later).turn);
  bot.hand.push(action(state, 'inspector_general'));
  always(0);
  const plan = decideBotPlay(state, 'p1', 'neutral');
  assert.equal(plan.targetId, soon.id, 'shot the player who was NOT about to win');
});

test('an armed bot that converts first does not treat a later rival as an emergency', () => {
  // Tested on tryBreakFinalApproach directly, because this is a statement about the
  // OVERRIDE branch — the one that outranks every personality and the holdback. Ordinary
  // threat play may still choose to take a rival's set later in the turn, and that is fine:
  // it costs a spare play and gains a set. What must NOT happen is the bot treating someone
  // who converts after us as the emergency that suspends its own defence.
  const { tryBreakFinalApproach } = Bot._internal;
  const state = build(4);
  const bot = state.players[0];
  const rival = state.players[3];         // last seat: converts after us
  arm(state, bot, ['brown', 'lightblue', 'pink']);
  arm(state, rival, ['orange', 'red', 'yellow']);
  assert.ok(G.checkpointForecast(state, bot).turn < G.checkpointForecast(state, rival).turn,
    'fixture must put our checkpoint first');
  bot.hand.push(action(state, 'inspector_general'));
  always(0);
  const shot = tryBreakFinalApproach(state, bot, 'p1', bot.hand, [rival], 'neutral');
  assert.equal(shot, null, 'raised the alarm for a rival who wins AFTER us');
});

test('an armed bot still shoots a rival who converts before it does', () => {
  const state = build(4);
  state.turnCounter = 10;
  const bot = state.players[0];
  const rival = state.players[1];
  arm(state, bot, ['brown', 'lightblue', 'pink']);          // armed just now, turn 10
  arm(state, rival, ['orange', 'red', 'yellow']);
  rival.armedAtTurn = 6;                                     // armed a lap earlier
  assert.ok(G.checkpointForecast(state, rival).turn < G.checkpointForecast(state, bot).turn,
    'fixture must put the rival checkpoint first');
  bot.hand.push(action(state, 'inspector_general'));
  always(0);
  const plan = decideBotPlay(state, 'p1', 'neutral');
  assert.ok(plan && plan.type === 'play_action');
  assert.equal(bot.hand[plan.cardIndex].action, 'inspector_general');
  assert.equal(plan.targetId, rival.id);
});

/* ── 7. personalities survive ────────────────────────────────────────── */

test('the urgency and overpay tables keep all five personalities distinct', () => {
  const { BREAK_URGENCY, BREAK_OVERPAY } = Bot._internal;
  for (const mode of ['random', 'conservative', 'neutral', 'aggressive', 'chud']) {
    assert.equal(typeof BREAK_URGENCY[mode], 'number', `${mode} missing from BREAK_URGENCY`);
    assert.equal(typeof BREAK_OVERPAY[mode], 'number', `${mode} missing from BREAK_OVERPAY`);
  }
  // random is the one personality allowed to be asleep at the wheel; nobody else is.
  assert.ok(BREAK_URGENCY.random < 0.5, 'random must stay the easy seat');
  for (const mode of PLANNERS) {
    assert.ok(BREAK_URGENCY[mode] >= 0.8, `${mode} must not ignore an armed player`);
  }
  // the aggressive end overpays harder than the cautious end — that is the whole axis
  assert.ok(BREAK_OVERPAY.aggressive > BREAK_OVERPAY.conservative);
  assert.ok(BREAK_OVERPAY.conservative > BREAK_OVERPAY.random);
});

test('a seat filled after a disconnect fights an armed player like any other bot', () => {
  // server/handlers.js replaces a dropped human with one of these three modes.
  for (const mode of ['conservative', 'neutral', 'aggressive']) {
    const state = build();
    arm(state, state.players[1], ['brown', 'lightblue', 'pink']);
    const bot = state.players[0];
    bot.hand.push(action(state, 'chud'));
    always(0);
    const plan = decideBotPlay(state, 'p1', mode);
    assert.ok(plan && plan.type === 'play_action', `${mode} takeover bot did nothing`);
    assert.equal(bot.hand[plan.cardIndex].action, 'chud');
  }
  // And an unknown/missing mode must fall through to a mode that still fights.
  const state = build();
  arm(state, state.players[1], ['brown', 'lightblue', 'pink']);
  state.players[0].hand.push(action(state, 'chud'));
  always(0);
  const plan = decideBotPlay(state, 'p1', undefined);
  assert.ok(plan && plan.type === 'play_action');
  assert.equal(state.players[0].hand[plan.cardIndex].action, 'chud');
});
