// test/bot-economy.test.js — what a bot does with its money and with its own board.
//
// Owner report (2026-08-07): "sometimes bots just pay or give way extra causing players to
// win more … their decisions as a whole they should be smarter, use rent cards better and
// also move wilds around etc to protect resources."
//
// Three defects were found by instrumenting 400 four-player games rather than by reading
// the code, and all three are pinned here:
//
//   1. selectPaymentCards() ended in a greedy walk that stopped the moment it had ENOUGH
//      and never asked whether a different combination got CLOSER. Every personality handed
//      over 28-32% more than it owed. `[1, 10]` paying 5M is the minimal reproduction and
//      it FAILS on the shipped code, which hands over 11M.
//   2. No bot had ever called moveProperty() or swapProperties(). A single free wild move
//      would have completed a set on 16-21% of turn starts and none was ever made.
//   3. hasChargeFollowUp() answered yes to Finance Office and Roll Call, which §3.1c makes
//      unsurgeable, so bots armed a multiplier that could not fire. 39-85% of all Surges
//      expired unused.
//
// Everything drives Bot._internal directly — the same entry point server.js and simulate.js
// use — so a pass means the LIVE bot behaves this way.

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');
const Bot = require('../bot');

const { decideBotPlay, selectPaymentCards, planRearrange, applyBotAction, setRng } = Bot._internal;

/* ── helpers ─────────────────────────────────────────────────────────── */

function build(seats = 3) {
  const players = Array.from({ length: seats }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  const state = G.createGame(players, { seed: 'boteco' });
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
function wild(state, player, color, colors) {
  const c = take(state, x => x.type === 'wild_property'
    && (colors ? colors.every(k => x.colors.includes(k)) : x.colors[0] === 'any'));
  (player.properties[color] = player.properties[color] || []).push({ ...c, placedColor: color });
  return c;
}
function setOf(state, p, color) {
  while ((p.properties[color] || []).length < G.COLORS[color].size) prop(state, p, color);
}
function bankUp(state, p, values) { for (const v of values) p.bank.push(money(state, v)); }
function valueOf(player, ids) {
  const all = G.payableCards(player);
  return ids.reduce((s, id) => s + (all.find(c => c.id === id) || { value: 0 }).value, 0);
}
function always(v) { setRng(() => v); }
test.afterEach(() => setRng(null));

const MODES = ['random', 'conservative', 'neutral', 'aggressive', 'chud'];

/* ── 1. the overpay bug, minimally ───────────────────────────────────── */

test('a bank of 1M and 10M pays a 5M charge with the 10M alone, never both', () => {
  // FAILS on the shipped greedy walk: it takes the 1 (1 < 5), then the 10 (11 >= 5), and
  // hands over 11M for a 5M debt. This is the owner's report as a unit test.
  for (const mode of MODES) {
    const state = build();
    const bot = state.players[0];
    bankUp(state, bot, [1, 10]);
    const ids = selectPaymentCards(bot, 5, mode);
    assert.equal(valueOf(bot, ids), 10, `${mode} overpaid`);
    assert.equal(ids.length, 1, `${mode} handed over ${ids.length} cards`);
  }
});

test('exact change is preferred to a bigger single note', () => {
  for (const mode of ['conservative', 'neutral', 'aggressive']) {
    const state = build();
    const bot = state.players[0];
    bankUp(state, bot, [1, 2, 3, 10]);
    const ids = selectPaymentCards(bot, 5, mode);
    assert.equal(valueOf(bot, ids), 5, `${mode} did not make exact change`);
  }
});

test('every solvent payment covers the debt and never exceeds the minimum reachable', () => {
  // A fuzz over random banks: the selection must always be legal (>= amount) and must
  // never beat the true minimum, which is what "minimal overpay" means.
  const rng = G.makeRng('pay-fuzz');
  for (let trial = 0; trial < 400; trial++) {
    const state = build();
    const bot = state.players[0];
    const n = 1 + Math.floor(rng() * 6);
    const values = [];
    for (let i = 0; i < n; i++) {
      const v = [1, 1, 2, 3, 4, 5, 10][Math.floor(rng() * 7)];
      values.push(v);
      bot.bank.push({ id: `f${trial}_${i}`, value: v, type: 'money', name: `${v}M` });
    }
    const total = values.reduce((s, v) => s + v, 0);
    const amount = 1 + Math.floor(rng() * total);
    // the true floor over every subset of the bank
    const reach = new Set([0]);
    for (const v of values) for (const t of [...reach]) reach.add(t + v);
    const floor = Math.min(...[...reach].filter(t => t >= amount));

    const ids = selectPaymentCards(bot, amount, 'neutral');
    const paid = valueOf(bot, ids);
    assert.ok(paid >= amount, `paid ${paid} for a debt of ${amount}`);
    assert.equal(paid, floor, `paid ${paid}, the minimum reachable was ${floor}`);
    assert.equal(new Set(ids).size, ids.length, 'duplicate card in the payment');
  }
});

/* ── 2. minimising overpay must not reorder the priorities ───────────── */

test('a 10M note is spent before a property that would make exact change', () => {
  // The tier order is measured, not arbitrary — handing over a property can cost a whole
  // set, and getting this wrong cost chud ~3 points and random ~2. Saving 5M of overpay is
  // never a reason to break it.
  for (const mode of ['conservative', 'neutral', 'aggressive']) {
    const state = build();
    const bot = state.players[0];
    bankUp(state, bot, [10]);
    prop(state, bot, 'darkblue');          // a 4M property, alone in its zone
    const ids = selectPaymentCards(bot, 4, mode);
    assert.equal(ids.length, 1, `${mode} handed over ${ids.length} cards`);
    assert.ok(bot.bank.some(c => c.id === ids[0]), `${mode} paid with a property while holding cash`);
  }
});

test('the bank goes before an upgrade, and an upgrade before a property', () => {
  const state = build();
  const bot = state.players[0];
  setOf(state, bot, 'brown');
  const house = { ...action(state, 'upgrade'), upgradeType: 'house' };
  bot.upgrades.brown = [house];
  bankUp(state, bot, [2]);
  // 2M owed: the bank covers it alone.
  assert.deepEqual(selectPaymentCards(bot, 2, 'neutral'), [bot.bank[0].id]);
  // 5M owed: the bank cannot, so the upgrade goes next — never the set.
  const ids = selectPaymentCards(bot, 5, 'neutral');
  assert.ok(ids.includes(house.id), 'the upgrade was not spent before the properties');
});

test('an armed bot pays out of its bank rather than out of a completed set', () => {
  const state = build();
  const bot = state.players[0];
  setOf(state, bot, 'brown'); setOf(state, bot, 'lightblue'); setOf(state, bot, 'pink');
  bot.finalApproach = true;
  bankUp(state, bot, [5]);
  const ids = selectPaymentCards(bot, 3, 'neutral');
  const setIds = new Set(Object.values(bot.properties).flat().map(c => c.id));
  assert.ok(!ids.some(id => setIds.has(id)), 'an armed bot volunteered a card out of a set');
});

test('an insolvent bot surrenders every card it owns, zero-value wilds included', () => {
  // §3.4 — "pay with everything you have" counts CARDS, not value, and the engine only
  // accepts a short payment when every payable card is in it.
  const state = build();
  const bot = state.players[0];
  bankUp(state, bot, [1]);
  wild(state, bot, 'green');               // a rainbow wild: payable, worth 0
  const ids = selectPaymentCards(bot, 9, 'neutral');
  assert.equal(ids.length, G.payableCards(bot).length, 'did not surrender everything');
});

/* ── 3. §3.8 free rearranging ────────────────────────────────────────── */

test('a free wild move that completes a set is taken, and it costs no play', () => {
  for (const mode of ['conservative', 'neutral', 'aggressive']) {
    const state = build();
    const bot = state.players[0];
    prop(state, bot, 'brown');                       // brown 1/2
    wild(state, bot, 'green');                       // rainbow parked on green 1/3
    const before = state.playsRemaining;
    const plan = decideBotPlay(state, 'p1', mode);
    assert.ok(plan, `${mode} produced no plan`);
    assert.equal(plan.type, 'rearrange', `${mode} did not rearrange`);
    assert.equal(plan.toColor, 'brown');
    const res = applyBotAction(state, 'p1', plan);
    assert.ok(res.ok, `the engine refused the move: ${res.error}`);
    assert.equal(G.completedSets(bot), 1, 'the set did not complete');
    assert.equal(state.playsRemaining, before, 'a rearrange must not cost a play');
  }
});

test('a bot never moves a card out of a completed set', () => {
  const state = build();
  const bot = state.players[0];
  prop(state, bot, 'brown');
  wild(state, bot, 'brown');                          // brown is now a complete 2/2 set
  prop(state, bot, 'lightblue'); prop(state, bot, 'lightblue');   // lightblue 2/3
  assert.equal(G.completedSets(bot), 1);
  const plan = planRearrange(state, bot, 'neutral');
  assert.equal(plan, null, 'it broke its own set to feed another one');
});

test('every rearrange a bot proposes is accepted by the engine', () => {
  // A refused rearrange is not a wasted turn, it is an INFINITE LOOP: it costs no play and
  // no budget, so botTakeTurn would re-decide, re-propose and reschedule forever. The
  // planner therefore has to re-check every precondition moveProperty/swapProperties
  // enforce. Fuzzed over random boards rather than trusted.
  const rng = G.makeRng('rearrange-fuzz');
  const colors = Object.keys(G.COLORS);
  let proposals = 0;
  for (let trial = 0; trial < 300; trial++) {
    const state = build();
    const bot = state.players[0];
    for (let i = 0; i < 6; i++) {
      const color = colors[Math.floor(rng() * colors.length)];
      if (G.zoneFull(bot, color)) continue;
      if (rng() < 0.45) { try { wild(state, bot, color); } catch { /* deck exhausted */ } }
      else { try { prop(state, bot, color); } catch { /* deck exhausted */ } }
    }
    always(0);
    for (let step = 0; step < 6; step++) {
      const plan = planRearrange(state, bot, MODES[Math.floor(rng() * MODES.length)]);
      if (!plan) break;
      proposals++;
      const res = applyBotAction(state, 'p1', plan);
      assert.ok(res.ok, `engine refused a proposed ${plan.type}: ${res.error}`);
      assert.deepEqual(G.validateState(state), { ok: true });
    }
    setRng(null);
  }
  assert.ok(proposals > 20, `the fuzz never exercised the planner (${proposals} proposals)`);
});

test('rearranging is bounded — a bot cannot spend its turn sliding cards around', () => {
  const state = build();
  const bot = state.players[0];
  // A board with many loose wilds, so every move opens another one.
  for (const c of ['brown', 'lightblue', 'pink', 'orange', 'red']) {
    try { wild(state, bot, c); } catch { /* out of wilds */ }
  }
  always(0);
  let moves = 0;
  while (moves < 50) {
    const plan = planRearrange(state, bot, 'conservative');
    if (!plan) break;
    assert.ok(applyBotAction(state, 'p1', plan).ok);
    moves++;
  }
  assert.ok(moves <= 4, `made ${moves} rearranges in one turn`);
});

/* ── 4. §3.1c — Surge Ops doubles rent, and only rent ────────────────── */

test('Surge Ops is not armed for a Finance Office or a Roll Call', () => {
  // FAILS on the shipped code: hasChargeFollowUp() returned true for both, and game.js
  // calls chargeAmount() for them with no `surgeable` flag, so the multiplier is always 1.
  for (const follow of ['finance_office', 'roll_call']) {
    for (const mode of ['conservative', 'neutral', 'aggressive']) {
      const state = build();
      const bot = state.players[0];
      bot.hand.push(action(state, 'surge_ops'), action(state, follow));
      always(0.99);
      const plan = decideBotPlay(state, 'p1', mode);
      const card = plan && plan.type === 'play_action' ? bot.hand[plan.cardIndex] : null;
      assert.notEqual(card?.action, 'surge_ops',
        `${mode} armed a Surge ahead of ${follow}, which the engine never doubles`);
      setRng(null);
    }
  }
});

test('Surge Ops is armed when a rent can actually follow it', () => {
  for (const mode of ['conservative', 'neutral', 'aggressive']) {
    const state = build();
    const bot = state.players[0];
    setOf(state, bot, 'brown');
    state.players[1].bank.push(money(state, 4));   // a rent can only "actually follow" if it collects
    bot.hand.push(action(state, 'surge_ops'), take(state, c => c.type === 'rent' && c.colors.includes('brown')));
    always(0.99);
    const plan = decideBotPlay(state, 'p1', mode);
    assert.ok(plan && plan.type === 'play_action');
    assert.equal(bot.hand[plan.cardIndex].action, 'surge_ops', `${mode} skipped the Surge/rent combo`);
    setRng(null);
  }
});

/* ── 5. rent is worth what it collects, not what it prints ───────────── */

test('a colour rent that charges the whole table beats a bigger wild rent', () => {
  // §3.2 leaves colour rents hitting every opponent; only the wild "any" rent names one
  // victim. The old ranking compared face values and systematically preferred the wild.
  const state = build(4);
  const bot = state.players[0];
  setOf(state, bot, 'brown');            // brown complete: 2M rent, x3 opponents = 6M
  setOf(state, bot, 'darkblue');         // darkblue complete: 8M rent, but a wild rent
  for (const p of state.players.slice(1)) p.bank.push(money(state, 1), money(state, 3));
  bot.hand.push(take(state, c => c.type === 'rent' && c.colors[0] === 'any'));
  bot.hand.push(take(state, c => c.type === 'rent' && c.colors.includes('brown') && c.colors[0] !== 'any'));
  const plan = decideBotPlay(state, 'p1', 'aggressive');
  assert.ok(plan && plan.type === 'play_action');
  const card = bot.hand[plan.cardIndex];
  assert.equal(card.type, 'rent');
  // brown is 2M x three opponents = 6M collected; the wild rent's best colour is darkblue
  // at 8M face, but it names ONE victim and that victim only holds 4M.
  assert.notEqual(card.colors[0], 'any',
    'took an 8M single-target rent over a 2M charge on three players');
  assert.equal(plan.targetColor, 'brown');
});

test('a wild rent goes to a player who can pay, not one who has nothing', () => {
  const state = build(4);
  const bot = state.players[0];
  setOf(state, bot, 'brown');
  state.players[1].bank = [];                            // broke
  state.players[2].bank.push(money(state, 3));           // solvent
  bot.hand.push(take(state, c => c.type === 'rent' && c.colors[0] === 'any'));
  for (const mode of ['conservative', 'neutral', 'aggressive']) {
    const plan = decideBotPlay(state, 'p1', mode);
    assert.ok(plan && plan.targetId, `${mode} named no victim for a wild rent`);
    assert.equal(plan.targetId, 'p3', `${mode} charged a player with nothing to take`);
  }
});

/* ── 6. play ordering: boosters before the charge they raise (round 8) ── */

test('holding rent and Upgrade for the same set, the Upgrade is played first', () => {
  // Owner report: "they will charge rent and then add houses/upgrades — they should play
  // their cards in the correct order." Both orders cost two plays; the wrong one forfeits
  // the +3M on every payer. FAILS on the round-7 code, which returns the rent first.
  for (const mode of ['conservative', 'neutral', 'aggressive']) {
    const state = build();
    const bot = state.players[0];
    setOf(state, bot, 'brown');
    state.players[1].bank.push(money(state, 5));
    bot.hand.push(take(state, c => c.type === 'rent' && c.colors.includes('brown') && c.colors[0] !== 'any'));
    bot.hand.push(action(state, 'upgrade'));
    always(0.99);   // pass every attention roll, defeat every holdback — for BOTH
    // decisions: resetting the rng between them left the follow-through rent on
    // Math.random, and the holdback roll failed ~1 run in 30 (flaked 2026-08-07;
    // afterEach resets the rng, no mid-test reset needed)
    const plan = decideBotPlay(state, 'p1', mode);
    assert.ok(plan && plan.type === 'play_action', `${mode} made no action play`);
    assert.equal(bot.hand[plan.cardIndex].action, 'upgrade', `${mode} charged before upgrading`);
    assert.equal(plan.targetColor, 'brown');
    assert.ok(applyBotAction(state, 'p1', plan).ok);
    // and the rent follows, now worth +3
    const next = decideBotPlay(state, 'p1', mode);
    assert.ok(next && next.type === 'play_action', `${mode} armed the set and never charged`);
    assert.equal(bot.hand[next.cardIndex].type, 'rent', `${mode} did not follow through with the rent`);
  }
});

test('a property of the rent colour climbs the ladder before the rent fires', () => {
  const state = build();
  const bot = state.players[0];
  prop(state, bot, 'red');                      // red 1/3: rent 2
  state.players[1].bank.push(money(state, 5));
  bot.hand.push(take(state, c => c.type === 'rent' && c.colors.includes('red') && c.colors[0] !== 'any'));
  bot.hand.push(take(state, c => c.type === 'property' && c.color === 'red'));   // 2/3: rent 3
  always(0.99);
  const plan = decideBotPlay(state, 'p1', 'aggressive');
  setRng(null);
  assert.ok(plan);
  assert.equal(plan.type, 'play_property', 'the ladder step did not go first');
  assert.equal(bot.hand[plan.cardIndex].color, 'red');
});

test('the booster never fires when no play would remain for the rent', () => {
  const state = build();
  const bot = state.players[0];
  setOf(state, bot, 'brown');
  state.players[1].bank.push(money(state, 5));
  bot.hand.push(take(state, c => c.type === 'rent' && c.colors.includes('brown') && c.colors[0] !== 'any'));
  bot.hand.push(action(state, 'upgrade'));
  state.playsRemaining = 1;
  always(0.99);
  const plan = decideBotPlay(state, 'p1', 'neutral');
  setRng(null);
  assert.ok(plan && plan.type === 'play_action');
  assert.equal(bot.hand[plan.cardIndex].type, 'rent',
    'burned the last play on an upgrade instead of the charge it was meant to raise');
});

test('a wild bound for a different set is not pulled onto the rent pile', () => {
  const state = build();
  const bot = state.players[0];
  setOf(state, bot, 'brown');                    // rent target, complete at 2 — but zoneFull
  prop(state, bot, 'red');                       // red 1/3
  prop(state, bot, 'lightblue'); prop(state, bot, 'lightblue');   // lightblue 2/3 — a wild HERE completes a set
  state.players[1].bank.push(money(state, 5));
  bot.hand.push(take(state, c => c.type === 'rent' && c.colors.includes('red') && c.colors[0] !== 'any'));
  const w = take(state, c => c.type === 'wild_property' && c.colors[0] === 'any');
  bot.hand.push(w);
  always(0.99);
  const plan = decideBotPlay(state, 'p1', 'aggressive');
  setRng(null);
  assert.ok(plan);
  // The rent is on red; the rainbow wild's best home is lightblue (completes a set). The
  // ordering pass must not hijack it for a red ladder step.
  if (plan.type === 'play_property' && bot.hand[plan.cardIndex]?.id === w.id) {
    assert.notEqual(plan.targetColor, 'red', 'the wild was pulled onto the rent pile');
  }
});

/* ── 7. finish the set before the rent — any colour (round 9) ────────── */

test('a cross-colour set-completing property goes down before the rent fires', () => {
  // Owner: "if bots are going to finish a set that turn, have them finish the set before
  // they play any rent cards." Worth zero millions (verified: order cannot change what the
  // charge collects), but it is the order a human expects to see. FAILS on round-8 code,
  // whose booster only knew the rent's own colour.
  for (const mode of ['conservative', 'neutral', 'aggressive']) {
    const state = build();
    const bot = state.players[0];
    setOf(state, bot, 'brown');                    // the rent target, already complete
    prop(state, bot, 'lightblue'); prop(state, bot, 'lightblue');   // 2/3 — one card short
    state.players[1].bank.push(money(state, 5));
    bot.hand.push(take(state, c => c.type === 'rent' && c.colors.includes('brown') && c.colors[0] !== 'any'));
    bot.hand.push(take(state, c => c.type === 'property' && c.color === 'lightblue'));
    always(0.99);
    const plan = decideBotPlay(state, 'p1', mode);
    setRng(null);
    assert.ok(plan, `${mode} produced no plan`);
    assert.equal(plan.type, 'play_property', `${mode} charged before finishing the set`);
    assert.equal(bot.hand[plan.cardIndex].color, 'lightblue');
    assert.ok(applyBotAction(state, 'p1', plan).ok);
    assert.equal(G.completedSets(bot), 2);
  }
});

test('the completing play never eats the last play the rent needed', () => {
  const state = build();
  const bot = state.players[0];
  setOf(state, bot, 'brown');
  prop(state, bot, 'lightblue'); prop(state, bot, 'lightblue');
  state.players[1].bank.push(money(state, 5));
  bot.hand.push(take(state, c => c.type === 'rent' && c.colors.includes('brown') && c.colors[0] !== 'any'));
  bot.hand.push(take(state, c => c.type === 'property' && c.color === 'lightblue'));
  state.playsRemaining = 1;
  always(0.99);
  // Aggressive is the mode whose own plan is the rent here (rent is its priority 2,
  // properties its 9) — neutral would play the property first by personality, which is
  // exactly the build-before-charge style the ordering pass must not overrule.
  const plan = decideBotPlay(state, 'p1', 'aggressive');
  setRng(null);
  assert.ok(plan && plan.type === 'play_action');
  assert.equal(bot.hand[plan.cardIndex].type, 'rent',
    'burned the last play on the property instead of the charge the planner chose');
});

/* ── 8. wasted charges — never charge a table that can pay nothing ─────
 *
 * Owner report (this wave): "sometimes they charge rent when all players have nothing."
 * findBestRent()/findRentOnCompleteSet() ranked candidates by the millions they COLLECT but
 * never GATED on it, so a bot holding a complete-set rent fired it into a broke table and
 * collected nothing — a lost play with no denial either (playerTotalValue 0 means there is
 * literally nothing to force out). Finance Office and Roll Call had the same hole.
 *
 * A charge that collects zero is a strict blunder for every personality — it helps nobody's
 * style — so the gate is universal. The chaotic seats keep their random colour and their
 * random victim; they just stop firing at a target, or a table, that has nothing at all. */

// Charge collectability is a property of the board, not the roll, so these are checked
// across every mode and pass without touching the rng.
function isRentPlay(state, plan) {
  return !!plan && plan.type === 'play_action'
    && state.players[0].hand[plan.cardIndex]?.type === 'rent';
}

test('a complete-set rent is not fired into a table that can pay nothing', () => {
  for (const mode of MODES) {
    const state = build(4);
    const bot = state.players[0];
    setOf(state, bot, 'brown');   // 2M rent, real props only (no wild to rearrange)
    // opponents hold nothing at all
    bot.hand.push(take(state, c => c.type === 'rent' && c.colors.includes('brown') && c.colors[0] !== 'any'));
    const plan = decideBotPlay(state, 'p1', mode);
    assert.ok(!isRentPlay(state, plan), `${mode} charged rent at a table with nothing to take`);
  }
});

test('a rent IS fired the moment one opponent can pay something', () => {
  // Guard against over-gating: the fix must not make bots stop charging solvent tables.
  for (const mode of ['conservative', 'neutral', 'aggressive']) {
    const state = build(4);
    const bot = state.players[0];
    setOf(state, bot, 'brown');
    state.players[2].bank.push(money(state, 3));   // exactly one solvent opponent
    bot.hand.push(take(state, c => c.type === 'rent' && c.colors.includes('brown') && c.colors[0] !== 'any'));
    const plan = decideBotPlay(state, 'p1', mode);
    assert.ok(isRentPlay(state, plan), `${mode} refused a rent a solvent opponent could pay`);
  }
});

test('a wild rent points at a payer even for the chaotic seats', () => {
  for (const mode of MODES) {
    const state = build(4);
    const bot = state.players[0];
    setOf(state, bot, 'brown');
    state.players[1].bank = [];                     // broke
    state.players[2].bank.push(money(state, 3));    // the only payer
    bot.hand.push(take(state, c => c.type === 'rent' && c.colors[0] === 'any'));
    const plan = decideBotPlay(state, 'p1', mode);
    // If it charges at all it must name the solvent seat; it may also decline (fine).
    if (isRentPlay(state, plan)) {
      assert.equal(plan.targetId, 'p3', `${mode} aimed a wild rent at a player with nothing`);
    }
  }
});

test('Finance Office is not played against a table that can pay nothing', () => {
  for (const mode of MODES) {
    const state = build(4);
    const bot = state.players[0];
    bot.hand.push(action(state, 'finance_office'));
    const plan = decideBotPlay(state, 'p1', mode);
    const fired = plan && plan.type === 'play_action'
      && bot.hand[plan.cardIndex]?.action === 'finance_office';
    assert.ok(!fired, `${mode} played Finance Office with no one able to pay`);
  }
});

test('Roll Call is not played against a table that can pay nothing', () => {
  for (const mode of MODES) {
    const state = build(4);
    const bot = state.players[0];
    bot.hand.push(action(state, 'roll_call'));
    const plan = decideBotPlay(state, 'p1', mode);
    const fired = plan && plan.type === 'play_action'
      && bot.hand[plan.cardIndex]?.action === 'roll_call';
    assert.ok(!fired, `${mode} played Roll Call with no one able to pay`);
  }
});
