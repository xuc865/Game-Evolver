// test/bot-sandbag.test.js — §3.10j SANDBAGGING: the completer that stays in hand.
//
// MEASURED, on 91 real production games (21 distinct players, mostly 4-seat,
// finalApproach/setsToWin 3). Decision point: a turn start holding a card that completes a
// colour the player is one short of.
//
//     humans play it 56% of the time.   neutral 96%.   aggressive 91%.
//
// And it splits, which is what makes it a policy rather than indecision:
//
//     humans complete 93% when it is their FINAL, WINNING set — and 52% otherwise.
//
// Three controls survived. (1) 66% of the declines laid a DIFFERENT colour that same turn, so
// a play was available and was taken. (2) Restricted to plain non-wild completers, humans
// declined 16 of 55 while aggressive declined 1 of 19 and neutral 0 of 18. (3) NONE of the
// declined cards was later paid away or banked — the card was held to be played. Corroborated
// by hand composition: property cards in hand at turn start after turn 30, human 1.52 vs
// neutral 0.38.
//
// WHY IT WORKS. payableCards() (game.js:1128) is bank + properties + upgrades. The hand is
// not in it. A card in hand cannot be paid away, cannot be taken by Midnight Requisition or
// TDY Orders, cannot be taken by THE CHUD CARD, and cannot be seized by an Inspector General
// — and a completed set is the ONLY thing an Inspector General can take at all. Holding the
// last card of a set converts a stealable asset into an unstealable one, at the cost of the
// rent it would have earned and the tempo of the play not made.
//
// THE OUTCOME EFFECT IS UNMEASURED AND THESE TESTS DO NOT CLAIM IT. Humans who declined >=50%
// won 7 of 15; those who did not won 3 of 6. Two groups of fifteen and six support no
// conclusion. This mechanism ships behind SANDBAG_ENABLED = false and is priced by
// tools/simhuman.mjs before anything is turned on. What is measured is that humans do it and
// bots never do.
//
// WHAT IS UNDER TEST, in four parts:
//
//   (a) THE HOLD — a plain property that completes a colour is kept in hand and a DIFFERENT
//       colour is laid instead, weighted per personality by SANDBAG. The winning set is never
//       held (that is tryArmingPlay, shipped in round 12, and this file guards it).
//   (b) THE RELEASE VALVES — the card cannot rot. The deck-cycle clock, a dry table, the hand
//       limit, an opponent reaching setsToWin - 1, a rent we could actually fire on that
//       colour, an OPSEC in hand, a bank that can absorb a charge, a dead breaker pool, and
//       the `instant` / `mdFaithful` win rules where delaying a set is pure loss.
//   (c) THE DISCIPLINE — the roll is taken ONCE PER TURN, not once per decision (round 12:
//       "a probability that is re-rolled every decision is not patience; it is a delay"), and
//       a zero weight short-circuits it so chud, random and aggressive keep byte-identical
//       RNG streams and paired-seed comparison stays alive.
//   (d) THE DISCARD DEPENDENCY — chooseDiscards() throws the completer away TODAY, in all
//       three planner comparators. This is the same class of bug that nearly defeated the
//       round-12 escrow and bit it twice. (a) is defeated silently without this.
//
// HOW EACH FIXTURE DISCRIMINATES. A release valve makes the bot do what it already does
// today, so a valve test in isolation is green against the current tree and proves nothing —
// the trap that has caught this project twice. Every valve below is therefore a PAIR OF LEGS
// inside one test: leg A without the valve condition (expects the card HELD — this is the leg
// that is red today), leg B with it (expects the card LAID — green today, and it is what
// stops a trivially-holding implementation from passing). The delta between the legs IS the
// valve.
//
// The base fixture is one brown on the board (brown.size === 2), hand [brown completer, red
// property], and an opponent with a bank. Verified against the current tree: every
// personality lays the brown, because findBestPropertyPlay scores it 0.5 + 0.3 + 0.5 = 1.3
// against red's 0.0 + 0.2 + 0.0 = 0.2. Nothing else in bot.js prefers the red, so "plays the
// red" has exactly one possible cause.
//
// Honest information only (round 11): every assertion is reachable from the discard pile,
// every player's table, and the bot's own hand. Nothing reads an opponent's hand or the deck.

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');
const Bot = require('../bot');

const I = Bot._internal;
const { decideBotPlay, chooseDiscards, setRng } = I;

/* ── helpers (same shape as bot-cardcount.test.js / bot-breaker-escrow.test.js) ── */

function build(seats = 3, opts = {}) {
  const players = Array.from({ length: seats }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  const state = G.createGame(players, { seed: 'sandbag', ...opts });
  state.deck = G.buildDeck(state.rules.deck);
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
function propCard(state, color) { return take(state, c => c.type === 'property' && c.color === color); }
function rainbow(state) { return take(state, c => c.type === 'wild_property' && c.colors[0] === 'any'); }
function prop(state, player, color) {
  const c = propCard(state, color);
  (player.properties[color] = player.properties[color] || []).push({ ...c, placedColor: color });
  return c;
}
function setOf(state, p, color) {
  while ((p.properties[color] || []).length < G.COLORS[color].size) prop(state, p, color);
}
function always(v) { setRng(() => v); }

// THE SANDBAG FLAG. SANDBAG_ENABLED is a module `let`, so assigning to
// Bot._internal.SANDBAG_ENABLED would not rebind it — the spec exposes a setter, same shape
// as setRng. Until it exists this is a no-op, deliberately: the tests below must then fail on
// their ASSERTIONS (the wrong card was played) and not on a TypeError, so each one is red for
// the reason it names. `apiExists` below is the guard that keeps this shim from going stale.
const apiExists = typeof I.setSandbag === 'function';
function sandbag(weights) {
  if (apiExists) I.setSandbag({ enabled: true, weights });
}
function sandbagOff() {
  if (apiExists) I.setSandbag(null);
}
// sandbagHeld likewise: absent -> [], so an assertion on its CONTENT is what fails.
function held(state, bot, botId, mode) {
  return typeof I.sandbagHeld === 'function' ? I.sandbagHeld(state, bot, botId, mode) : [];
}

test.afterEach(() => { setRng(null); sandbagOff(); });

// The base fixture described in the header. Returns the pieces every test pokes at.
function baseTable(opts = {}) {
  const state = build(3, opts);
  const [me, p2, p3] = state.players;
  prop(state, me, 'brown');                       // 1 of 2 — one short
  const completer = propCard(state, 'brown');     // the last brown: laying it completes a set
  const other = propCard(state, 'red');           // the DIFFERENT colour (control 1: 66%)
  me.hand.push(completer, other);
  p2.bank.push(money(state, 5));                  // somebody a rent could actually collect from
  return { state, me, p2, p3, completer, other };
}
// What card did the bot reach for? Returns the card object, or null for a pass.
function played(state, me, mode) {
  always(0);
  const a = decideBotPlay(state, 'p1', mode);
  setRng(null);
  if (!a || a.cardIndex === undefined) return null;
  return me.hand[a.cardIndex];
}

/* ══ (0) THE SURFACE THIS FILE DRIVES ═════════════════════════════════════════ */

test('Bot._internal exposes the sandbag surface', () => {
  // Red on the current tree by construction, and deliberately so: the shims above degrade to
  // no-ops so that every OTHER test in this file fails on its own assertion rather than on a
  // missing function. This test is what stops those shims from silently passing forever if
  // the API is renamed or dropped.
  for (const name of ['setSandbag', 'sandbagConfig', 'sandbagHeld', 'sandbagRelease', 'completesASet']) {
    assert.equal(typeof I[name], 'function', `Bot._internal.${name} is missing`);
  }
  assert.equal(typeof I.SANDBAG, 'object', 'Bot._internal.SANDBAG is missing');
  assert.equal(I.sandbagConfig().enabled, false,
    'the flag defaults OFF — nothing ships on a hunch, and the OFF tree must stay byte-identical');
});

/* ══ (a) THE HOLD ═════════════════════════════════════════════════════════════ */

test('neutral holds a plain completer and lays a DIFFERENT colour that same turn', () => {
  // The measurement, in one decision. Humans play the completer 56% of the time overall and
  // 52% when it is not their winning set; neutral plays it 96%. Control 1 is the shape of the
  // target behaviour, not an afterthought: 66% of human declines laid a different colour the
  // same turn, so the bot must NOT pass the turn — it must build elsewhere.
  //
  // DISCRIMINATION: on the current tree findBestPropertyPlay scores brown 1.3 and red 0.2, so
  // brown is played by every personality (verified). No other rule in bot.js prefers the red
  // here: there is no rent card, no action card, no threat, no armed player and the ordering
  // pass only fires behind a rent. "Plays the red" has exactly one cause.
  const { state, me, completer, other } = baseTable();
  sandbag({ neutral: 0.52 });

  const card = played(state, me, 'neutral');
  assert.ok(card, 'the sandbag must never cost the turn — 66% of declines laid another colour');
  assert.equal(card.id, other.id,
    'the completer was laid: neutral completes 96% where a human completes 52%');
  assert.notEqual(card.id, completer.id, 'the completer must stay in hand');
});

test('the axis is graded — conservative holds, aggressive does not', () => {
  // Distinctness is a gate. SANDBAG = { humanlike 0.52, conservative 0.35, neutral 0.20,
  // aggressive 0, chud 0, random 0 }: aggressive is escort:false, leads with the biggest card
  // it holds, and is the seat the corpus already ranks best against humans (28.6%) — holding
  // is the negation of its character, and its measured completion rate (91%) is one bots
  // already match. A zero also short-circuits the roll, which is what keeps its seeded stream
  // identical (pinned separately below).
  //
  // DISCRIMINATION: both legs use the identical fixture. The only difference is the mode, so
  // the assertion is purely about the axis. The aggressive leg is green today — it is the leg
  // that stops "hold always" from passing; the conservative leg carries the red.
  const patient = baseTable();
  sandbag({ conservative: 0.35 });
  assert.equal(played(patient.state, patient.me, 'conservative').id, patient.other.id,
    'conservative is the asset-protection personality — it takes the largest legacy dose');

  const reckless = baseTable();
  assert.equal(played(reckless.state, reckless.me, 'aggressive').id, reckless.completer.id,
    'aggressive holds nothing back — disciplining all the planners identically would collapse '
    + 'five personalities into one');

  const gremlin = baseTable();
  assert.equal(played(gremlin.state, gremlin.me, 'chud').id, gremlin.completer.id,
    'chud has no weight at all: reckless is its whole character and a zero preserves its stream');
});

test('GUARD: the WINNING set is laid, never held — humans complete 93%', () => {
  // Green on the current tree, and it must stay that way. tryArmingPlay (§3.10g, round 12)
  // already promotes the play that completes our setsToWin-th set above the entire personality
  // plan; that IS the 93% leg of the measurement, and the sandbag must not reach it.
  //
  // The weight is forced to 1.0 — a CERTAIN hold — precisely so this is not passing by luck of
  // the roll. If a future implementation threads the held set into tryArmingPlay, this goes red.
  const state = build(3);
  const [me, p2] = state.players;
  setOf(state, me, 'lightblue');
  setOf(state, me, 'pink');                       // 2 of 3 — the next set wins
  prop(state, me, 'brown');
  const completer = propCard(state, 'brown');
  const other = propCard(state, 'red');
  me.hand.push(completer, other);
  p2.bank.push(money(state, 5));
  sandbag({ neutral: 1 });

  assert.equal(played(state, me, 'neutral').id, completer.id,
    'the set that arms us is never sandbagged — the winning completion is 93%, not 52%');
});

test('only ONE colour is hidden at a time, and it is the expensive one', () => {
  // SANDBAG_MAX_HELD = 1. Holding two completers doubles the tempo cost and reproduces neither
  // the measurement nor control 1 (the observed shape is hiding ONE thing while continuing to
  // build). It also keeps the roll count at exactly one per turn.
  //
  // Tiebreak: hold the set worth MORE, because that is the one an Inspector General costs us
  // more to lose. Here darkblue completes to 8M (Pentagon 4M + Air Force One 4M) and brown to
  // 2M (two 1M bases), so darkblue is hidden and brown is laid.
  //
  // DISCRIMINATION: darkblue is FIRST in hand, and findBestPropertyPlay scores brown and
  // darkblue identically (0.5 + 0.3 + 0.5 = 1.3 each) with a strict `>` comparison — so the
  // current tree plays the darkblue (verified). Asserting "plays the brown" therefore cannot
  // be satisfied by the existing scorer at all, and asserting the darkblue stays in hand
  // cannot be satisfied by a "hold everything" implementation either, because the brown would
  // then be held too and the bot would reach for the red.
  const state = build(3);
  const [me, p2] = state.players;
  prop(state, me, 'brown');
  prop(state, me, 'darkblue');
  const dbCompleter = propCard(state, 'darkblue');   // completes to 8M
  const brCompleter = propCard(state, 'brown');      // completes to 2M
  const other = propCard(state, 'red');
  me.hand.push(dbCompleter, brCompleter, other);
  p2.bank.push(money(state, 5));
  sandbag({ neutral: 0.52 });

  const card = played(state, me, 'neutral');
  assert.equal(card.id, brCompleter.id,
    'one colour is hidden, not two — the cheap set is still laid and still earns');
  assert.notEqual(card.id, dbCompleter.id, 'the expensive set is the one worth hiding');
  assert.notEqual(card.id, other.id,
    'holding BOTH completers would send the bot to the red — that is two colours hidden');
});

test('sandbagging is for PLAIN properties — a wild that completes is always laid', () => {
  // SANDBAG_WILDS = false. Three reasons pointing the same way: (1) it is the population the
  // surviving control was measured on — plain non-wild completers, humans declined 16/55;
  // (2) a held wild forfeits its ALTERNATIVE placement, so the cost is strictly higher and
  // entirely unmeasured; (3) findCompletingPlay iterates G.legalColorsFor and returns the
  // first colour that completes, so a rainbow "completes" up to ten zones and there is no
  // principled answer to which one is being hidden.
  //
  // DISCRIMINATION: leg A is the plain fixture and is red today (it must hold); leg B swaps
  // the plain completer for a rainbow wild and is green today. The pair is what proves the
  // rule is about the card TYPE and not about the board.
  const plain = baseTable();
  sandbag({ neutral: 0.52 });
  assert.equal(played(plain.state, plain.me, 'neutral').id, plain.other.id,
    'leg A — the plain completer is held (this is the red leg)');

  const state = build(3);
  const [me, p2] = state.players;
  prop(state, me, 'brown');
  const wild = rainbow(state);
  const other = propCard(state, 'red');
  me.hand.push(wild, other);
  p2.bank.push(money(state, 5));
  assert.equal(played(state, me, 'neutral').id, wild.id,
    'leg B — a wild that completes a set is laid: a rainbow in hand is already unstealable '
    + 'and already flexible, so the marginal gain is smallest exactly where the cost is highest');
});

/* ══ (b) THE RELEASE VALVES — the card cannot rot ══════════════════════════════ */

test('the deck-cycle clock releases the held card', () => {
  // §3.11 adjudicates on points after DECK_CYCLE_LIMIT reshuffles, and shuffleCount is public
  // (every shuffle is a table event). decideBotPlay's holdback clock and breakerEscrowRelease
  // already use this exact window. Inside it there is no "later" to save the card for — and
  // the adjudication is brutal about it: endInStalemate (game.js:2332) ranks on completedSets,
  // then playerNetWorth, and NEITHER counts hand cards. A held completer loses twice over.
  const early = baseTable();
  sandbag({ neutral: 0.52 });
  assert.equal(played(early.state, early.me, 'neutral').id, early.other.id,
    'leg A — outside the window the completer is held (the red leg)');

  const late = baseTable();
  late.state.shuffleCount = G.DECK_CYCLE_LIMIT - 4;
  assert.equal(played(late.state, late.me, 'neutral').id, late.completer.id,
    'leg B — inside the clock the set goes down: a card in hand scores nothing on §3.6 points');
});

test('a dry table releases it — the idle-turn stalemate is a second ending', () => {
  // endTurn ends the game on _idleTurns >= activeCount when deck AND discard are empty and no
  // hand card has moved for a full lap (game.js:2422). shuffleCount does not cover that path,
  // and a bot that plays nothing is a bot that FEEDS the idle counter. A first draft of this
  // gate copied breakerEscrowRelease verbatim and missed it.
  const wet = baseTable();
  sandbag({ neutral: 0.52 });
  assert.equal(played(wet.state, wet.me, 'neutral').id, wet.other.id,
    'leg A — with cards left to come, the completer is held (the red leg)');

  const dry = baseTable();
  dry.state.deck = [];
  dry.state.discardPile = [];
  assert.equal(played(dry.state, dry.me, 'neutral').id, dry.completer.id,
    'leg B — nothing is coming and nothing can be shuffled back: lay the set');
});

test('the hand limit releases it BEFORE the discard comparator ever sees it', () => {
  // >= HAND_LIMIT, not >. At exactly 7 cards a hold guarantees a discard decision next turn
  // over a hand that contains the completer, and laying it now costs nothing. This is the
  // first of the three independent reasons a held completer cannot wedge at the limit; the
  // other two are the comparator tier in part (d) and decideBotPlay's holdback already being
  // skipped above 7 cards.
  const roomy = baseTable();
  sandbag({ neutral: 0.52 });
  assert.equal(played(roomy.state, roomy.me, 'neutral').id, roomy.other.id,
    'leg A — a two-card hand holds the completer (the red leg)');

  const full = baseTable();
  for (let i = 0; i < 5; i++) full.me.hand.push(money(full.state, 1));
  assert.equal(full.me.hand.length, G.HAND_LIMIT, 'fixture: exactly at the limit');
  assert.equal(played(full.state, full.me, 'neutral').id, full.completer.id,
    'leg B — at the hand limit the card is laid rather than risked to a comparator');
});

test('an opponent reaching setsToWin - 1 releases it — a hidden set does not race', () => {
  // A set on the table counts for §3.6 points AND for the win race; a set in hand counts for
  // neither. Once somebody else is one set from arming there is no longer time to be coy.
  // setsToWin is read from state (the longGame preset ships 5), never assumed to be 3.
  const calm = baseTable();
  sandbag({ neutral: 0.52 });
  assert.equal(played(calm.state, calm.me, 'neutral').id, calm.other.id,
    'leg A — nobody is close, the completer is held (the red leg)');

  const race = baseTable();
  setOf(race.state, race.p2, 'lightblue');
  setOf(race.state, race.p2, 'pink');             // p2 at 2 of 3 — one set from arming
  assert.equal(G.completedSets(race.p2), G.setsToWinOf(race.state) - 1, 'fixture: p2 is at the bar');
  assert.equal(played(race.state, race.me, 'neutral').id, race.completer.id,
    'leg B — the race is on and a hidden set scores nothing');
});

test('a rent we could actually fire on that colour releases it — a hidden set earns nothing', () => {
  // The set is only worth hiding while it is not earning. Firability is determined from the
  // engine's own numbers (calcRent / rentYield, capped by what the victims can hand over), not
  // guessed, so the valve cannot release the card for a charge makeRentPlay would then refuse.
  //
  // DISCRIMINATION, and this one needed care: the obvious fixture — 2 of 3 red plus a red rent
  // — is GREEN today for an unrelated reason. The planner picks the rent, and then round 8's
  // findChargeBooster spots that the completer raises the charged colour and plays it first.
  // That fixture would test findChargeBooster, not this valve. So the rent here is the
  // brown/lightblue card against a ONE-card brown zone: calcRent is 1, below neutral's minRent
  // of 2, so findBestRent declines it, the planner never chooses a rent, and the ordering pass
  // never runs. The only thing that can lay the brown is this valve.
  const noRent = baseTable();
  sandbag({ neutral: 0.52 });
  assert.equal(played(noRent.state, noRent.me, 'neutral').id, noRent.other.id,
    'leg A — no charge is available on brown, so the set is hidden (the red leg)');

  const withRent = baseTable();
  withRent.me.hand.push(take(withRent.state, c => c.type === 'rent' && c.colors[0] === 'brown'));
  assert.equal(withRent.state.playsRemaining >= 2, true, 'fixture: a play is left to fire the rent');
  assert.equal(played(withRent.state, withRent.me, 'neutral').id, withRent.completer.id,
    'leg B — completing brown doubles the rent we are about to charge; hiding it earns 0M');
});

test('OFF under the instant and mdFaithful win rules — the rule is read from state', () => {
  // Under `instant` the third set wins the moment it completes, from any call site including
  // off-turn (syncSets, game.js:684). Under `mdFaithful` a set completed on your own turn wins
  // on the spot. Delaying a set is pure loss under both, and the reasons compound: the
  // mdFaithful PRESET ships chud: 0, so half the seizure threat this hides from does not
  // exist; counterCostsPlay changes the tempo arithmetic the 52% was measured under; and
  // pureSetRequired changes what "completes a set" means for a wild zone.
  const house = baseTable();
  sandbag({ neutral: 0.52 });
  assert.equal(house.state.winRule, 'finalApproach', 'fixture: the house rule');
  assert.equal(played(house.state, house.me, 'neutral').id, house.other.id,
    'leg A — under finalApproach the completer is held (the red leg)');

  const instant = baseTable({ winRule: 'instant' });
  assert.equal(instant.state.winRule, 'instant');
  assert.equal(played(instant.state, instant.me, 'neutral').id, instant.completer.id,
    'leg B — instant: every set is one third of an immediate win');

  const faithful = baseTable({ winRule: 'mdFaithful' });
  assert.equal(faithful.state.winRule, 'mdFaithful');
  assert.equal(played(faithful.state, faithful.me, 'neutral').id, faithful.completer.id,
    'leg C — mdFaithful: three unmeasured differences at once, so it is off until measured');
});

test('holding is only safer when something could actually take the set', () => {
  // An Inspector General and THE CHUD CARD are the only two cards that can reach a completed
  // set — Midnight Requisition and TDY Orders read zoneRequisitionable, which refuses one. If
  // no hard breaker can still come, a completed set is safe on the table and there is nothing
  // to hide from. unseenCounts is honest information: discard pile, every table, our own hand.
  const live = baseTable();
  sandbag({ neutral: 0.52 });
  assert.equal(played(live.state, live.me, 'neutral').id, live.other.id,
    'leg A — two IGs and two CHUDs are still unseen, so the zone would sit exposed (the red leg)');

  const dead = baseTable();
  for (let i = 0; i < 2; i++) dead.state.discardPile.push(action(dead.state, 'inspector_general'));
  for (let i = 0; i < 2; i++) dead.state.discardPile.push(action(dead.state, 'chud'));
  assert.equal(I.unseenCounts(dead.state, dead.me).breakers, 0, 'fixture: the breaker pool is dead');
  assert.equal(played(dead.state, dead.me, 'neutral').id, dead.completer.id,
    'leg B — nothing left in the deck can seize it, so put the set down and start earning');
});

test('an OPSEC in hand releases it — a defensible zone is not an exposed one', () => {
  // The mirror image of round 12's escort clause. There, holding the shield is what licenses
  // FIRING the breaker; here, holding the shield is what licenses laying the set down, because
  // the seizure can be answered. It is deliberately the same axis real players were measured
  // conditioning on (they fire escorted breakers 75% against 44% unescorted).
  const bare = baseTable();
  sandbag({ neutral: 0.52 });
  assert.equal(played(bare.state, bare.me, 'neutral').id, bare.other.id,
    'leg A — no shield, so the completed set could be taken and not answered (the red leg)');

  const shielded = baseTable();
  shielded.me.hand.push(action(shielded.state, 'opsec'));
  assert.equal(played(shielded.state, shielded.me, 'neutral').id, shielded.completer.id,
    'leg B — with an OPSEC in hand the zone is defensible: lay it and let it earn');
});

test('a bank that can absorb a charge releases it — the set is not what pays', () => {
  // payableCards is bank + properties + upgrades, and selectPaymentCards spends the bank
  // first. With cash on the table a charge is settled in cash and the property never moves;
  // with an empty bank the property IS what pays. That is the payment half of "genuinely
  // safer" — and it is NOT the rejected cash floor, which substituted a bank play for a
  // property play across the board and cost +2.2 turns per game. This substitutes nothing; it
  // is a condition on an already-narrow branch.
  const broke = baseTable();
  sandbag({ neutral: 0.52 });
  assert.equal(broke.me.bank.length, 0, 'fixture: nothing but the board to pay with');
  assert.equal(played(broke.state, broke.me, 'neutral').id, broke.other.id,
    'leg A — an empty bank means the completed set is the thing that pays (the red leg)');

  const flush = baseTable();
  flush.me.bank.push(money(flush.state, 10));
  assert.equal(played(flush.state, flush.me, 'neutral').id, flush.completer.id,
    'leg B — 10M of cushion means a charge never reaches the board');
});

test('it never spends a whole turn doing nothing', () => {
  // The idle valve. Control 1 of the measurement is that 66% of human declines laid a
  // DIFFERENT colour the same turn — the behaviour is "build elsewhere", never "pass". So a
  // hold requires the hand to contain something else that is not an OPSEC.
  //
  // This is an approximation and the spec says so: it cannot see whether the planner's other
  // cards are actually playable this instant (a rent with no matching colour, a Finance Office
  // against a broke table), because sandbagHeld is called from inside the planner and finding
  // out means re-running it, which is the rnd()-doubling round 12 forbade.
  const twoCards = baseTable();
  sandbag({ neutral: 0.52 });
  assert.equal(played(twoCards.state, twoCards.me, 'neutral').id, twoCards.other.id,
    'leg A — there is another colour to lay, so the completer is held (the red leg)');

  const alone = build(3);
  const [me, p2] = alone.players;
  prop(alone, me, 'brown');
  const only = propCard(alone, 'brown');
  me.hand.push(only);
  p2.bank.push(money(alone, 5));
  const card = played(alone, me, 'neutral');
  assert.ok(card, 'leg B — a bot with one card must not pass its whole turn to hide it');
  assert.equal(card.id, only.id, 'leg B — nothing else to do, so do the thing');

  const shieldOnly = build(3);
  const [me2, p2b] = shieldOnly.players;
  prop(shieldOnly, me2, 'brown');
  const only2 = propCard(shieldOnly, 'brown');
  me2.hand.push(only2, action(shieldOnly, 'opsec'));
  p2b.bank.push(money(shieldOnly, 5));
  assert.equal(played(shieldOnly, me2, 'neutral').id, only2.id,
    'leg C — an OPSEC is not "something else to do": conservative and neutral hold their '
    + 'shields by rule, so a hand of [completer, OPSEC] is an idle turn too');
});

test('it steps aside when laying the property is what loads the escrow gun', () => {
  // Round 12's tryArmingBreaker opens only at completedSets + 1 >= setsToWin. Sandbagging our
  // SECOND set therefore keeps that gate shut and leaves the bot sitting on the property that
  // would have armed the Inspector General. A regression found by reading the escrow rather
  // than by running it, and the valve is one line.
  //
  // DISCRIMINATION: both legs have two-of-three lightblue on the board and a brown one short.
  // Leg A holds no breaker and must hide the brown; leg B adds an Inspector General with a
  // worth-it target (p2 holds a complete set) and must lay the brown so that the very next
  // call this turn can fire the IG for the win.
  //
  // LEG B IS ASSERTED AT THE VALVE, NOT THROUGH decideBotPlay, and that is forced rather than
  // chosen. §3.10c's escort clause accepts "an OPSEC in hand" OR "every OPSEC accounted for",
  // and BOTH routes collide with an earlier branch that produces the identical answer: a shield
  // in hand trips the `shield` valve several steps before arming-unlock is reached (this test
  // was originally written that way and stayed green with the valve deleted entirely), while a
  // dead pool trips tryGuaranteedBreaker, which fires the Inspector General outright and never
  // reaches the property decision at all. There is no third way to satisfy the escort, so no
  // fixture can isolate this valve end-to-end for an escort-bearing personality. Asserting the
  // valve directly is the honest alternative to a test that looks end-to-end and proves
  // nothing — and leg A above still pins the behaviour it guards.
  const noGun = build(3);
  {
    const [me, p2] = noGun.players;
    setOf(noGun, me, 'lightblue');                 // 1 of 3 sets
    prop(noGun, me, 'brown');
    const completer = propCard(noGun, 'brown');
    const other = propCard(noGun, 'red');
    me.hand.push(completer, other);
    p2.bank.push(money(noGun, 5));
    sandbag({ neutral: 0.52 });
    assert.equal(played(noGun, me, 'neutral').id, other.id,
      'leg A — no breaker in hand, so the second set is hidden (the red leg)');
  }

  const gun = build(3);
  {
    const [me, p2] = gun.players;
    setOf(gun, me, 'lightblue');
    prop(gun, me, 'brown');
    const completer = propCard(gun, 'brown');
    const other = propCard(gun, 'red');
    setOf(gun, p2, 'pink');                        // a complete set an IG could seize
    me.hand.push(completer, other, action(gun, 'inspector_general'));
    // Escort satisfied by a DEAD POOL, so the `shield` valve (which fires on a shield in hand
    // and would otherwise answer first) cannot. Calling the valve directly is also what keeps
    // tryGuaranteedBreaker out of it — through decideBotPlay a dead pool fires the Inspector
    // General outright and the property decision is never reached.
    for (let i = 0; i < 3; i++) gun.discardPile.push(action(gun, 'opsec'));
    assert.equal(I.unseenCounts(gun, me).opsec, 0, 'fixture: the shield pool must be dead');
    assert.ok(!me.hand.some(c => c.action === 'opsec'), 'fixture: and no shield in hand');
    p2.bank.push(money(gun, 5));
    sandbag({ neutral: 0.52 });
    always(0);
    // The valve names itself. Deleting the arming-unlock branch makes this return null
    // instead, which is the discrimination the end-to-end form could not provide.
    assert.equal(I.sandbagRelease(gun, me, me.id, 'neutral', completer), 'armingunlock',
      'leg B — laying the brown puts us at setsToWin - 1, which is what opens tryArmingBreaker');
    setRng(null);
  }
});

/* ══ (c) THE DISCIPLINE — patience, not delay ═════════════════════════════════ */

test('the roll is taken ONCE PER TURN, not once per decision', () => {
  // Round 12, in its own words: "a probability that is re-rolled every decision is not
  // patience; it is a delay." decideBotPlay is called once per play, so a naive per-decision
  // rnd() < 0.52 holds a card across a whole turn only 0.52^3 = 14% of the time — which is how
  // the first breaker escrow moved its headline metric by 2pp and had to be rebuilt.
  //
  // So the roll is cached on state, keyed by (turnCounter, botId, cardId). Only the ROLL is
  // cached: the deterministic valves are re-evaluated every call, because the hand shrinks,
  // the bank grows and an opponent can arm mid-turn.
  const { state, me } = baseTable();
  sandbag({ neutral: 0.52 });

  always(0);                                        // a roll that holds
  const first = held(state, me, 'p1', 'neutral');
  setRng(null);
  assert.equal(first.length, 1, 'the completer is held on the first decision of the turn');

  always(0.99);                                     // a roll that would NOT hold
  const second = held(state, me, 'p1', 'neutral');
  setRng(null);
  assert.deepEqual(second, first,
    'the same turn must not re-roll — that is a delay, not patience');

  state.turnCounter = (state.turnCounter || 0) + 1; // a new turn IS a new decision
  always(0.99);
  const nextTurn = held(state, me, 'p1', 'neutral');
  setRng(null);
  assert.deepEqual(nextTurn, [],
    'the roll is retaken each turn, so a hold decays geometrically and cannot rot');
});

test('a zero weight costs no rnd() — chud, random and aggressive keep their streams', () => {
  // Paired-seed before/after comparison is the whole measurement culture of this project, and
  // it survives only if a personality that does not use a feature consumes exactly the same
  // randomness it did before. BREAKER_BAR, BAIT_PATIENCE and CUSHION_PRESSURE all give the
  // chaotic two a zero for this reason. Verified against the current tree, the base fixture
  // costs: neutral 3 rolls, chud 3, random 2, aggressive 2.
  function rolls(mode, on) {
    const { state } = baseTable();
    if (on) sandbag({ neutral: 0.52 }); else sandbagOff();
    let n = 0;
    setRng(() => { n++; return 0; });
    decideBotPlay(state, 'p1', mode);
    setRng(null);
    sandbagOff();
    return n;
  }
  for (const mode of ['aggressive', 'chud', 'random']) {
    assert.equal(rolls(mode, true), rolls(mode, false),
      `${mode} has weight 0: the roll must be short-circuited, not taken and discarded`);
  }
  assert.equal(rolls('neutral', true), rolls('neutral', false) + 1,
    'exactly ONE new roll per turn per sandbagging bot — one candidate is picked before the '
    + 'roll, so two eligible colours still cost one roll');
});

/* ══ (d) THE DISCARD DEPENDENCY ═══════════════════════════════════════════════ */
//
// The trap that nearly defeated the round-12 escrow, and it bit that round TWICE: conservative
// sorted hard breakers to the FRONT of its discard list, and aggressive threw its OPSEC away
// to keep a 5M Inspector General on the exact turn it armed. Told to hold a card, a bot holds
// it to the hand limit and then throws it away — the feature is defeated silently.
//
// Every comparator leaks here TODAY, and each for its own reason. Verified by running them:
//   neutral      — OPSEC last, breakers next, then purely `a.value - b.value`. Brown and
//                  lightblue properties print 1M, so a completer is the FIRST card out.
//   conservative — properties sort late as a group, but between two properties it falls
//                  through to face value, so the cheap completer goes before an expensive orphan.
//   aggressive   — `a.type === 'action'` sorts AFTER property, so the completer is discarded
//                  ahead of any ordinary action card.
//
// The fix is a TIER behind OPSEC, not pool removal. isNeverDiscarded gets to be absolute
// because the owner said "never" about THE CHUD CARD; a second absolute class multiplies the
// ways the arithmetic escape is reached, and endTurn refuses a short list. A tier can always
// yield. Gated on the FLAG rather than on the live per-turn hold, so that a card released
// mid-turn by the hand-limit valve is still protected when endTurn asks.

function discardFixture(mode, second) {
  const state = build(3);
  const me = state.players[0];
  prop(state, me, 'brown');
  const completer = propCard(state, 'brown');   // 1M, and it finishes the brown set
  const decoy = second(state);
  me.hand.push(completer, decoy);
  sandbag({ conservative: 0.35, neutral: 0.20, aggressive: 0.20 });
  always(0);
  const ids = chooseDiscards(me, 1, mode);
  setRng(null);
  return { ids, completer, decoy };
}

test('neutral does not discard the property that completes a set', () => {
  // DISCRIMINATION: the decoy is a 10M note, the most valuable card in the deck. Neutral sorts
  // by face value alone below the OPSEC/breaker tiers, so today the 1M completer goes first
  // and the 10M is kept. There is no other rule that would keep a 1M property over a 10M note.
  const { ids, completer, decoy } = discardFixture('neutral', s => money(s, 10));
  assert.deepEqual(ids, [decoy.id],
    'the card that finishes a set is not the card the hand limit throws away');
  assert.ok(!ids.includes(completer.id));
});

test('conservative keeps the 1M completer over a 4M property', () => {
  // DISCRIMINATION: both cards are properties, so conservative's property-late grouping is a
  // tie and the comparator falls through to `a.value - b.value` — today it sheds the 1M brown
  // and keeps the 4M green, which completes nothing. The ONLY thing that distinguishes them is
  // that one finishes a set.
  const { ids, completer, decoy } = discardFixture('conservative', s => propCard(s, 'green'));
  assert.deepEqual(ids, [decoy.id],
    'a 4M orphan is expendable; the 1M that finishes a set is not');
  assert.ok(!ids.includes(completer.id));
});

test('aggressive keeps the completer over an ordinary action card', () => {
  // DISCRIMINATION: aggressive's comparator sorts action cards AFTER properties, so a property
  // always goes out first today — the face-value tiebreak never even runs. Against money
  // aggressive is already right (it sheds money first), which is why the decoy here is an
  // action and not a note.
  const { ids, completer, decoy } = discardFixture('aggressive', s => action(s, 'roll_call'));
  assert.deepEqual(ids, [decoy.id],
    'aggressive discarded a third of a set to keep a 2M Roll Call');
  assert.ok(!ids.includes(completer.id));
});

test('a 1M completer outranks a 1M note — and the protection still yields', () => {
  // TWO legs, and only the first is red.
  //
  // Leg A is red today for a reason worth naming precisely: neutral's comparator sorts by face
  // value and a brown property prints exactly 1M, the same as a 1M note. On a tie the sort is
  // stable, so whichever the bot happens to hold first goes out — half the time that is a
  // third of a set, surrendered to keep a banknote of identical value. Face value cannot
  // separate these two cards; only "does it finish a zone" can.
  //
  // Leg B is the yield invariant, and it is why the fix is a TIER rather than the CHUD's
  // pool-removal treatment. endTurn refuses a short discard list and the turn wedges, so
  // chooseDiscards(...).length === excess must hold even when EVERY card in the hand is
  // protected. A ranking can always yield; an absolute rule needs an arithmetic escape, and a
  // second absolute class multiplies the ways that escape is reached.
  const state = build(3);
  const me = state.players[0];
  prop(state, me, 'brown');
  const completer = propCard(state, 'brown');       // 1M, finishes the brown set
  me.hand.push(completer);
  for (let i = 0; i < 6; i++) me.hand.push(money(state, 1));   // 1M notes — the same face value
  sandbag({ neutral: 0.20 });

  // The deck holds only six 1M notes, so the excess is named rather than derived — the same
  // way bot-breaker-escrow.test.js drives chooseDiscards on a two-card hand.
  always(0);
  const ids = chooseDiscards(me, 1, 'neutral');
  setRng(null);
  assert.equal(ids.length, 1, 'the hand limit still has to be met');
  assert.ok(!ids.includes(completer.id),
    'leg A — a 1M note and a 1M completer tie on face value; only one of them is a third of a set');

  // Leg B: eight zones one short and a hand of nothing but the eight cards that finish them.
  const packed = build(3);
  const you = packed.players[0];
  const colors = ['brown', 'lightblue', 'pink', 'orange', 'red', 'yellow', 'darkblue', 'intel'];
  for (const color of colors) {
    while ((you.properties[color] || []).length < G.COLORS[color].size - 1) prop(packed, you, color);
    you.hand.push(propCard(packed, color));
  }
  assert.equal(you.hand.length, 8, 'fixture: every card in hand finishes a set');
  always(0);
  const forced = chooseDiscards(you, you.hand.length - G.HAND_LIMIT, 'neutral');
  setRng(null);
  assert.equal(forced.length, 1,
    'leg B — protection is a preference over the rest of the hand, never a licence to overrun it');
});

test('GUARD: with the flag OFF nothing changes at all', () => {
  // The contract that makes the whole round measurable: SANDBAG_ENABLED = false must leave
  // every comparator, every planner and every RNG stream byte-identical to the tree it landed
  // on, so simbalance and botaudit can be run paired. Green today; it goes red the moment
  // somebody ships the discard tier unconditionally, which is a change worth making later and
  // deliberately NOT made here.
  sandbagOff();
  const state = build(3);
  const me = state.players[0];
  prop(state, me, 'brown');
  const completer = propCard(state, 'brown');
  const cash = money(state, 10);
  me.hand.push(completer, cash);
  always(0);
  assert.deepEqual(chooseDiscards(me, 1, 'neutral'), [completer.id],
    'flag OFF: neutral sheds by face value exactly as it did before');
  setRng(null);

  const play = baseTable();
  assert.equal(played(play.state, play.me, 'neutral').id, play.completer.id,
    'flag OFF: the completer is laid, as it is on every tree before this one');
});
