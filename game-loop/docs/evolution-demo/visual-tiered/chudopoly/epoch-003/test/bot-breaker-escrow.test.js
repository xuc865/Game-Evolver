// test/bot-breaker-escrow.test.js — Cluster 1: the breaker economy.
//
// docs/bot-foresight-research.md §1.1 measured the whole defect: 1,858 hard-breaker plays
// over 400 four-player games, and 39.5% of them fired at a table where NOBODY held 2+ sets
// and nobody was armed (aggressive 54.2%, neutral 46.0%, chud 45.8%, random 36.4%,
// conservative 11.9%). The consequence is §1.2: at the moment a player arms, 2.23 of the
// deck's 4 hard breakers are already spent, and 71.6% of armings face a table where not one
// opponent holds a breaker at all. The break branch works when it is loaded — 46.6% of
// armings are shot down — the ammunition is simply gone before the fight starts.
//
// There is no test anywhere in this repo asking whether a breaker shot is WORTH the card;
// only whether it is LEGAL. These tests are that question, in three parts:
//
//   (a) BREAKER ESCROW  — a gate at every breaker SELECTION SITE (tryOffensiveActions,
//       tryDefensiveOffense, decideAggressive steps 3-4) that lets an IG/CHUD through only
//       when the shot earns its card: it breaks a player at setsToWin-1 or better, or it
//       advances OUR OWN win. Otherwise the card is held and the site falls through to the
//       next action type. Graded per personality by BREAKER_BAR — a DETERMINISTIC bar, not
//       a patience roll: a per-decision p=0.8 hold fires anyway 89% of the time across ten
//       decision points and moved the headline no-threat share only 39.5% -> 37.5%, while
//       the same code deterministic moves it to 22.9%. It also costs zero new rnd() calls,
//       so no personality's seeded stream shifts.
//   (b) THE DISCARD DEPENDENCY — chooseDiscards() used to sort inspector_general and chud to
//       the FRONT of conservative's discard list, and to rank neutral's and aggressive's
//       hands by face value alone. Tell any of them to hold a breaker and it holds it to the
//       hand limit and then throws it away; (a) is defeated silently without this. The
//       shipped ordering is OPSEC last of all, then the two hard breakers, then whatever the
//       personality did before.
//   (c) OPSEC ESCORT — a bot holding both a breaker and an OPSEC reserves the shield to
//       escort the shot instead of spending it on a 2M charge. Round 5 measured the
//       OPSEC-chain headroom at ~0.3 points: this is a FEEL change, not a balance change.
//       It applies only to the personalities whose BREAKER_BAR carries `escort: true`.
//
// Everything drives Bot._internal directly — the same entry points simulate.js and
// server.js use — so a pass means the LIVE bot behaves this way.
//
// Honest information only (round 11): every assertion below is reachable from the discard
// pile, every player's table, and the bot's own hand. No test reads an opponent's hand or
// the deck order.

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');
const Bot = require('../bot');

const {
  decideBotPlay, shouldPlayOpsecDecision, chooseDiscards, setRng,
  BREAKER_BAR, BREAKER_SELF_MARGIN, worthwhileBreakerShot, escrowHoldsBreaker,
} = Bot._internal;

/* ── helpers (same shape as bot-cardcount.test.js / bot-finalapproach.test.js) ── */

function build(seats = 3) {
  const players = Array.from({ length: seats }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  const state = G.createGame(players, { seed: 'escrow' });
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
function rainbowInto(state, player, color) {
  const c = take(state, x => x.type === 'wild_property' && x.colors[0] === 'any');
  (player.properties[color] = player.properties[color] || []).push({ ...c, placedColor: color });
  return c;
}
function setOf(state, p, color) {
  while ((p.properties[color] || []).length < G.COLORS[color].size) prop(state, p, color);
}
function discardAll(state, kind, n) {
  for (let i = 0; i < n; i++) state.discardPile.push(action(state, kind));
}
// Thin the unseen reserve to nothing so the "another one is coming, hold loosely" valve is
// never the thing under test. `mine` is the kind this bot is holding.
function lastBreakerInPlay(state, mine) {
  if (mine === 'inspector_general') { discardAll(state, 'inspector_general', 1); discardAll(state, 'chud', 2); }
  else { discardAll(state, 'inspector_general', 2); discardAll(state, 'chud', 1); }
}
function always(v) { setRng(() => v); }
test.afterEach(() => setRng(null));

/* ══ (a) THE ESCROW ═══════════════════════════════════════════════════════════ */

/* ── the bar to fire: a no-threat table does not earn the card ────────── */

test('aggressive holds Inspector General at a table where nobody is close', () => {
  const state = build(3);
  const [me, p2] = state.players;
  lastBreakerInPlay(state, 'inspector_general');
  prop(state, me, 'red');                    // a board, so the opening property branch is skipped
  setOf(state, p2, 'brown');                 // ONE complete set — p2 is at 1 of 3, no threat
  me.hand.push(action(state, 'inspector_general'));
  me.hand.push(take(state, c => c.type === 'property' && c.color === 'lightblue'));

  always(0);   // every personality roll low: today aggressive fires IG at step 4
  const a = decideBotPlay(state, 'p1', 'aggressive');
  assert.ok(a, 'the escrow must never cost the turn — it spends the play elsewhere');
  assert.equal(a.type, 'play_property',
    'a breaker fired at a 0-set/1-set table is 200 of aggressive\'s 369 shots (54.2%)');
});

test('neutral holds THE CHUD CARD when the steal neither completes our set nor breaks one', () => {
  const state = build(3);
  const [me, p2] = state.players;
  lastBreakerInPlay(state, 'chud');
  prop(state, me, 'red');                    // 1/3 red — a steal here advances nothing decisive
  prop(state, p2, 'red');
  me.hand.push(action(state, 'chud'));
  me.hand.push(money(state, 2));

  always(0);
  const a = decideBotPlay(state, 'p1', 'neutral');
  assert.ok(a, 'the escrow must never cost the turn');
  assert.equal(a.type, 'play_money',
    'the strongest card in the deck is not a Midnight Requisition (23.0% of shots took a card '
    + 'that was neither in a complete set nor one we needed)');
});

test('conservative holds a CHUD orphan even with two sets down', () => {
  const state = build(3);
  const [me, p2] = state.players;
  lastBreakerInPlay(state, 'chud');
  setOf(state, me, 'brown'); setOf(state, me, 'lightblue');   // 2 sets — offensive branch is open
  prop(state, p2, 'red');                                     // a loose 3M orphan
  me.hand.push(action(state, 'chud'));
  me.hand.push(money(state, 2));

  always(0);
  const a = decideBotPlay(state, 'p1', 'conservative');
  assert.ok(a, 'the escrow must never cost the turn');
  assert.equal(a.type, 'play_money',
    'a CHUD that takes a card outside every complete set and completes nothing of ours is spent for nothing');
});

/* ── the bar to fire: a shot that gains US nothing is not a shot ──────── */

test('an Inspector General aimed into a colour we already own complete gains nothing', () => {
  // steal_set routes every card through receiveProperty (game.js:1804), so a stolen set
  // landing in a zone we have already filled overflows to other colours or to the bank: the
  // seizure moves cash, not a set. findBestIGTarget() never looks at OUR board at all.
  const state = build(3);
  const [me, p2] = state.players;
  lastBreakerInPlay(state, 'inspector_general');
  rainbowInto(state, me, 'brown'); rainbowInto(state, me, 'brown');   // our brown is complete
  setOf(state, p2, 'brown');                                          // the only set on the table
  me.hand.push(action(state, 'inspector_general'));
  me.hand.push(take(state, c => c.type === 'property' && c.color === 'lightblue'));

  always(0);
  const a = decideBotPlay(state, 'p1', 'aggressive');
  assert.ok(a);
  assert.equal(a.type, 'play_property',
    'the seizure would bank two 1M cards and cost the only breaker in play');
});

/* ── the owner's case: a breaker that advances OUR win ────────────────── */

test('conservative fires Inspector General when the set it seizes arms us', () => {
  // Owner, 2026-08-12: "it makes sense to steal a set if you have 1-2 already and are going
  // for final approach while holding opsec, but it seems bots don't play that way."
  // Before the change conservative reached its offensive branch only at step 8, BEHIND
  // building — so a property in hand outranked the shot that would put it on final approach.
  // tryArmingBreaker promotes it above the whole personality plan.
  //
  // The OPSEC in hand is load-bearing, not scenery: conservative's BREAKER_BAR carries
  // `escort: true`, so "this shot advances OUR OWN win" is only a reason when we can defend
  // the shot. Without the escort clause the self-rule passes for any bot with one set —
  // most of the mid-game — and the escrow measured a 39.5% -> 30.6% move in the no-threat
  // share while leaving breakers-in-hand-at-arming flat, i.e. it moved the shots without
  // fixing the empty gun.
  const state = build(3);
  const [me, p2] = state.players;
  setOf(state, me, 'lightblue'); setOf(state, me, 'pink');   // 2 of 3 sets
  setOf(state, p2, 'brown');
  me.hand.push(action(state, 'inspector_general'));
  me.hand.push(action(state, 'opsec'));                      // the escort
  me.hand.push(take(state, c => c.type === 'property' && c.color === 'red'));

  always(0);
  const a = decideBotPlay(state, 'p1', 'conservative');
  assert.ok(a);
  assert.equal(a.type, 'play_action', 'the third set outranks building a first red');
  assert.equal(me.hand[a.cardIndex].action, 'inspector_general');
  assert.equal(a.targetId, 'p2');
});

test('neutral fires Inspector General when the set it seizes arms us', () => {
  const state = build(3);
  const [me, p2] = state.players;
  setOf(state, me, 'lightblue'); setOf(state, me, 'pink');
  setOf(state, p2, 'brown');
  me.hand.push(action(state, 'inspector_general'));
  me.hand.push(action(state, 'opsec'));                      // neutral is escorted too
  me.hand.push(take(state, c => c.type === 'property' && c.color === 'red'));

  always(0);
  const a = decideBotPlay(state, 'p1', 'neutral');
  assert.ok(a);
  assert.equal(a.type, 'play_action');
  assert.equal(me.hand[a.cardIndex].action, 'inspector_general');
});

test('the same shot is HELD when the shield that would escort it is not in hand', () => {
  // The other half of the escort clause, and the reason the two tests above are not simply
  // asserting "a bot with two sets fires". Identical board, identical hand, minus the OPSEC:
  // "it advances our own win" stops being a reason on its own, nobody on the table is at
  // setsToWin - 1, and the card stays in hand. Aggressive carries `escort: false` and is
  // therefore NOT held here — that is the personality axis, stated as a difference in the
  // bar rather than as a coin flip.
  const bare = build(3);
  const [me, p2] = bare.players;
  lastBreakerInPlay(bare, 'inspector_general');
  setOf(bare, me, 'lightblue'); setOf(bare, me, 'pink');
  setOf(bare, p2, 'brown');
  me.hand.push(action(bare, 'inspector_general'));
  me.hand.push(take(bare, c => c.type === 'property' && c.color === 'red'));

  always(0);
  const held = decideBotPlay(bare, 'p1', 'conservative');
  assert.ok(held, 'the held card must not cost the turn when something else is playable');
  assert.equal(held.type, 'play_property',
    'an unescorted breaker was spent on our own set-building — the owner\'s rule is '
    + '"going for final approach WHILE HOLDING OPSEC"');

  const hot = build(3);
  const [me2, p2b] = hot.players;
  lastBreakerInPlay(hot, 'inspector_general');
  setOf(hot, me2, 'lightblue'); setOf(hot, me2, 'pink');
  setOf(hot, p2b, 'brown');
  me2.hand.push(action(hot, 'inspector_general'));
  me2.hand.push(take(hot, c => c.type === 'property' && c.color === 'red'));

  always(0);
  const shot = decideBotPlay(hot, 'p1', 'aggressive');
  assert.ok(shot && shot.type === 'play_action');
  assert.equal(me2.hand[shot.cardIndex].action, 'inspector_general',
    'aggressive requires no escort — disciplining all three planners identically would '
    + 'collapse the personalities into one');
});

/* ── target selection: prefer the set that matters, not the fattest ───── */

test('Inspector General goes to the player at setsToWin - 1, not to the fattest set', () => {
  // findBestIGTarget() (bot.js:2073) scores by the value of the set and nothing else, and
  // aggressive has no threat branch at all — so the 12M green of a 1-set player outranks
  // the 2M brown of the player one set from winning.
  const state = build(3);
  const [me, p2, p3] = state.players;
  lastBreakerInPlay(state, 'inspector_general');
  prop(state, me, 'red');
  setOf(state, p2, 'brown'); setOf(state, p2, 'intel');   // 2 sets, 2M each — the real threat
  setOf(state, p3, 'green');                              // 1 set, 12M — the fattest
  me.hand.push(action(state, 'inspector_general'));
  me.hand.push(money(state, 2));

  always(0);
  const a = decideBotPlay(state, 'p1', 'aggressive');
  assert.ok(a && a.type === 'play_action');
  assert.equal(me.hand[a.cardIndex].action, 'inspector_general');
  assert.equal(a.targetId, 'p2', 'the shot is worth the card only against the player who can win');
});

test('CHUD takes the card that completes one of our zones, not the first colour we own', () => {
  // findBuildingSteal() walks G.COLORS in declaration order and returns the first colour we
  // have any of — lightblue at 1/3 here — while red sits at 2/3 and the same card would
  // finish it. findChudCompletionTarget() (bot.js:2115) already knows the difference and is
  // consulted only by the guaranteed-shot branch.
  const state = build(3);
  const [me, p2] = state.players;
  lastBreakerInPlay(state, 'chud');
  setOf(state, me, 'intel');                     // 1 set, so the shot lands us at setsToWin - 1
  prop(state, me, 'lightblue');                  // 1/3 — earlier in COLORS order
  prop(state, me, 'red'); prop(state, me, 'red');// 2/3 — the completion
  prop(state, p2, 'lightblue');
  const theirRed = prop(state, p2, 'red');
  me.hand.push(action(state, 'chud'));
  me.hand.push(money(state, 2));

  always(0);
  const a = decideBotPlay(state, 'p1', 'neutral');
  assert.ok(a && a.type === 'play_action');
  assert.equal(me.hand[a.cardIndex].action, 'chud');
  assert.equal(a.targetCardId, theirRed.id, 'the steal that completes a set outranks the steal that does not');
});

test('denial of a real threat outranks our own completion — unless the completion wins outright', () => {
  // The precedence inside worthwhileBreakerShot's CHUD branch, and the one place it inverts.
  // A completion is use-it-or-lose-it (the card can be paid away, rearranged, or stolen by a
  // third player) which is why it clears the bar at all; a complete set on an opponent's
  // board is stable and will still be there next turn. But an opponent at setsToWin - 1 may
  // not still be there next turn, so denial goes first — right up to the point where our own
  // completion ENDS THE GAME, and nothing outranks that.
  //
  // A: we are at 1 set of 3. Completing red takes us to 2, which is not a win, so the CHUD
  //    goes into the threat's complete set instead.
  const a = build(3);
  const [meA, p2a, p3a] = a.players;
  lastBreakerInPlay(a, 'chud');
  setOf(a, meA, 'intel');                          // 1 set — clears BREAKER_SELF_MARGIN
  prop(a, meA, 'red'); prop(a, meA, 'red');        // 2/3 red — one card completes it
  const loose = prop(a, p3a, 'red');               // the completing card, on a harmless seat
  setOf(a, p2a, 'brown'); setOf(a, p2a, 'lightblue');  // p2 is at setsToWin - 1: the threat
  meA.hand.push(action(a, 'chud'));
  meA.hand.push(money(a, 2));

  always(0);
  const planA = decideBotPlay(a, 'p1', 'neutral');
  assert.ok(planA && planA.type === 'play_action');
  assert.equal(meA.hand[planA.cardIndex].action, 'chud');
  assert.equal(planA.targetId, 'p2',
    'took a card that moved us from 1 set to 2 while the player one set from winning kept theirs');
  assert.notEqual(planA.targetCardId, loose.id);

  // B: identical table, except we are at 2 sets — so the same completion is the third set
  //    and the game is over. Now the completion outranks the denial.
  const b = build(3);
  const [meB, p2b, p3b] = b.players;
  lastBreakerInPlay(b, 'chud');
  setOf(b, meB, 'intel'); setOf(b, meB, 'yellow'); // 2 sets — the completion WINS
  prop(b, meB, 'red'); prop(b, meB, 'red');
  const winner = prop(b, p3b, 'red');
  setOf(b, p2b, 'brown'); setOf(b, p2b, 'lightblue');
  meB.hand.push(action(b, 'chud'));
  meB.hand.push(money(b, 2));

  always(0);
  const planB = decideBotPlay(b, 'p1', 'neutral');
  assert.ok(planB && planB.type === 'play_action');
  assert.equal(meB.hand[planB.cardIndex].action, 'chud');
  assert.equal(planB.targetCardId, winner.id,
    'denied a threat instead of taking the card that ends the game in our favour');
});

/* ── the release valves ───────────────────────────────────────────────── */

// GREEN on the pre-change tree (today the shot fires unconditionally): a ratchet that the
// valve must keep true, not a proof of the valve.
test('guard: the deck clock releases the escrow — §3.11 ends the game on points', () => {
  const state = build(3);
  const [me, p2] = state.players;
  lastBreakerInPlay(state, 'inspector_general');
  prop(state, me, 'red');
  setOf(state, p2, 'brown');
  state.shuffleCount = G.DECK_CYCLE_LIMIT - 4;   // the endgame window decideBotPlay already knows
  me.hand.push(action(state, 'inspector_general'));
  me.hand.push(take(state, c => c.type === 'property' && c.color === 'lightblue'));

  always(0);
  const a = decideBotPlay(state, 'p1', 'aggressive');
  assert.ok(a && a.type === 'play_action', 'there is no "later" to save the card for');
  assert.equal(me.hand[a.cardIndex].action, 'inspector_general');
});

test('the escrow bar is a graded per-personality axis, and the chaotic two are exempt', () => {
  // The axis is the BAR, not a coin flip. `denyAt` counts back from setsToWin (1 = "an
  // opponent one set from winning"), `escort` requires a shield in hand before a shot may be
  // justified by advancing OUR OWN win, and `null` means no bar at all. chud and random keep
  // null on purpose: reckless is their whole character, they fire 318 of the 734 wasted
  // shots, and disciplining them would collapse five personalities into one.
  assert.ok(BREAKER_BAR, 'BREAKER_BAR must exist');
  assert.equal(BREAKER_BAR.chud, null, 'chud must keep its pre-change behaviour byte for byte');
  assert.equal(BREAKER_BAR.random, null, 'random must keep its pre-change behaviour byte for byte');
  for (const mode of ['conservative', 'neutral', 'aggressive']) {
    assert.ok(BREAKER_BAR[mode], `${mode} must carry a bar`);
    assert.equal(BREAKER_BAR[mode].denyAt, 1,
      `${mode} denies only a REAL threat — an opponent at setsToWin - 1`);
  }
  assert.equal(BREAKER_BAR.conservative.escort, true);
  assert.equal(BREAKER_BAR.neutral.escort, true);
  assert.equal(BREAKER_BAR.aggressive.escort, false,
    'aggressive is still the reckless planner: it shoots for its own win unescorted');
  assert.equal(BREAKER_SELF_MARGIN, 1,
    'the self-rule bar: the shot must bring us to setsToWin - 1 or better');
});

test('the escrow consumes no RNG draw — deterministic, so no seeded stream moves', () => {
  // The measured correction that shaped this code. A graded per-decision patience
  // (conservative 0.95 / neutral 0.8 / aggressive 0.5) moved the no-threat share only
  // 39.5% -> 37.5%: a probability re-rolled at every decision is not patience, it is a
  // delay. Deterministic, the same code reaches 22.9% — and it costs ZERO new rnd() calls,
  // which is what keeps paired-seed before/after comparison alive across this change.
  const state = build(3);
  const [me, p2] = state.players;
  prop(state, me, 'red');
  setOf(state, p2, 'brown');
  me.hand.push(action(state, 'inspector_general'), action(state, 'chud'));

  for (const mode of ['conservative', 'neutral', 'aggressive', 'chud', 'random']) {
    let draws = 0;
    setRng(() => { draws++; return 0; });
    for (let i = 0; i < me.hand.length; i++) {
      worthwhileBreakerShot(state, me, 'p1', i, mode);
      escrowHoldsBreaker(state, me, mode, i);
    }
    assert.equal(draws, 0,
      `${mode} consumed ${draws} RNG draw(s) inside the escrow; every one of them shifts the `
      + 'whole downstream stream and invalidates seeded before/after comparison');
    setRng(null);
  }

  // and the two barless modes are never held, whatever the table looks like
  for (const mode of ['chud', 'random']) {
    assert.equal(escrowHoldsBreaker(state, me, mode, 0), false,
      `${mode} was held by an escrow it has no bar for`);
  }
});

test('worthwhileBreakerShot reads only public state and answers per card', () => {
  const state = build(3);
  const [me, p2] = state.players;
  prop(state, me, 'red');
  setOf(state, p2, 'brown');
  me.hand.push(action(state, 'inspector_general'));

  always(0);
  assert.equal(worthwhileBreakerShot(state, me, 'p1', 0, 'aggressive'), null,
    'one set on the table, held by a player at 1 of 3, and we gain nothing decisive');

  setOf(state, p2, 'intel');   // p2 is now at setsToWin - 1
  const shot = worthwhileBreakerShot(state, me, 'p1', 0, 'aggressive');
  assert.ok(shot, 'a complete set held by a player one set from winning is always worth the card');
  assert.equal(shot.targetId, 'p2');

  // ...and a personality with no bar has nothing to retarget: the escrow returns null and
  // the planner's own pre-escrow targeting stands.
  assert.equal(worthwhileBreakerShot(state, me, 'p1', 0, 'chud'), null,
    'chud must not be routed through the escrow at all');
});

/* ── guards: a held breaker is never SOLD, and random is never touched ── */

test('a held breaker is never banked for cash — the veto redirects, or the turn ends', () => {
  // The leak the escrow moved rather than closed, on its first measurement: aggressive's
  // BANKED breakers went 20 -> 82 per 400 games. It was no longer firing them, so its
  // planner fell through to step 12 and sold the only counter in the deck for 5M. The veto
  // at the decideBotPlay chokepoint now covers "the escrow is holding this card" as well as
  // "somebody is armed" — a card held for a final approach that never comes is still worth
  // more than 5M we never get to spend.
  //
  // Note what this deliberately does NOT assert: that the turn always produces a play. The
  // shipped design would rather end the turn than sell the breaker, and leg B pins that.
  //
  // A: something else to bank -> the money goes instead of the breaker
  const a = build(3);
  const [meA, p2a] = a.players;
  lastBreakerInPlay(a, 'inspector_general');
  prop(a, meA, 'red');
  setOf(a, p2a, 'brown');
  const ig = action(a, 'inspector_general');
  const cash = money(a, 2);
  meA.hand.push(ig, cash);

  always(0);
  const planA = decideBotPlay(a, 'p1', 'aggressive');
  assert.ok(planA && planA.type === 'play_money');
  assert.equal(meA.hand[planA.cardIndex].id, cash.id,
    'the escrow held the shot and the planner sold the card it was holding');

  // B: the breaker is the whole hand -> the turn ends rather than converting it to cash
  const b = build(3);
  const [meB, p2b] = b.players;
  lastBreakerInPlay(b, 'inspector_general');
  prop(b, meB, 'red');
  setOf(b, p2b, 'brown');
  meB.hand.push(action(b, 'inspector_general'));

  always(0);
  assert.equal(decideBotPlay(b, 'p1', 'aggressive'), null,
    'the only counter in the deck was banked for 5M rather than kept for the final approach');
});

test('guard: random still sprays its breakers', () => {
  const state = build(3);
  const [me, p2] = state.players;
  lastBreakerInPlay(state, 'inspector_general');
  setOf(state, p2, 'brown');
  me.hand.push(action(state, 'inspector_general'));

  setRng(() => 0.5);
  const a = decideBotPlay(state, 'p1', 'random');
  assert.ok(a && a.type === 'play_action');
  assert.equal(me.hand[a.cardIndex].action, 'inspector_general',
    'patience 0 means the roll is never taken — random\'s stream and behaviour are untouched');
});

/* ══ (b) THE DISCARD DEPENDENCY ═══════════════════════════════════════════════ */
//
// chooseDiscards (bot.js:2524) groups inspector_general and chud with "offensive actions"
// and sorts that group to the FRONT of conservative's discard list. An escrowed breaker
// held to the hand limit is then discarded — the escrow would make conservative WORSE.

test('conservative discards money before a breaker', () => {
  const state = build(3);
  const me = state.players[0];
  const ig = action(state, 'inspector_general');
  const cash = money(state, 1);
  me.hand.push(ig, cash);

  always(0);
  assert.deepEqual(chooseDiscards(me, 1, 'conservative'), [cash.id],
    'the card the escrow is holding must not be the card the hand limit throws away');
});

// GREEN on the pre-change tree, but only by accident: today both cards sit in the same
// "offensive actions" group and the face-value tiebreak (MR 3M < CHUD 4M) happens to order
// them correctly. The change makes it structural rather than a coincidence.
test('guard: conservative discards a Midnight Requisition before a CHUD', () => {
  const state = build(3);
  const me = state.players[0];
  const mr = action(state, 'midnight_requisition');
  const chud = action(state, 'chud');
  me.hand.push(chud, mr);

  always(0);
  assert.deepEqual(chooseDiscards(me, 1, 'conservative'), [mr.id],
    'the cheap steal is the expendable one; the card that reaches into a complete set is not');
});

test('neutral discards a 10M before a breaker', () => {
  // neutral sorts by face value alone, and an Inspector General prints 5M.
  const state = build(3);
  const me = state.players[0];
  const ig = action(state, 'inspector_general');
  const cash = money(state, 10);
  me.hand.push(ig, cash);

  always(0);
  assert.deepEqual(chooseDiscards(me, 1, 'neutral'), [cash.id]);
});

test('aggressive keeps the breaker over an ordinary ACTION card of the same face value', () => {
  // Against money, aggressive was already right — it sheds money first, and that leg is the
  // guard below. The leak was between two ACTION cards: the comparator fell through to face
  // value, and THE CHUD CARD prints 4M, the same as a Full Operational Capability. On a tie
  // the sort is stable, so whichever of the two the bot happened to draw first went out —
  // half the time that was the strongest card in the deck, discarded to keep a hotel.
  const state = build(3);
  const me = state.players[0];
  const chud = action(state, 'chud');            // 4M
  const hotel = action(state, 'foc');            // 4M — same face value, ordinary card
  me.hand.push(chud, hotel);

  always(0);
  assert.deepEqual(chooseDiscards(me, 1, 'aggressive'), [hotel.id],
    'aggressive ranked two 4M actions by face value alone and threw away the breaker');

  // GUARD: money still goes first, which is the half that never needed changing
  const cashState = build(3);
  const you = cashState.players[0];
  const ig = action(cashState, 'inspector_general');
  const cash = money(cashState, 1);
  you.hand.push(ig, cash);
  assert.deepEqual(chooseDiscards(you, 1, 'aggressive'), [cash.id],
    'aggressive sorts money to the front already');
});

/* ══ (c) THE OPSEC ESCORT ═════════════════════════════════════════════════════ */
//
// Field principle 3 of 5 (docs/bot-foresight-research.md §2): escort the Deal Breaker with
// your own Just Say No so the steal cannot be answered. Round 5 put the OPSEC-chain
// headroom at ~0.3 points, so this is a feel change and it is deliberately small: only
// SMALL charges are declined, and only while a breaker is in hand and an OPSEC could still
// answer it.

test('neutral saves its OPSEC to escort a breaker instead of spending it on a 2M demand', () => {
  const state = build(3);
  const me = state.players[0];
  me.hand.push(action(state, 'opsec'), action(state, 'inspector_general'));
  state.pendingAction = {
    type: 'payment', action: 'finance_office', sourceId: 'p2', amount: 2,
    targets: [{ id: 'p1', depth: 0, responderId: 'p1' }],
  };
  always(0);
  assert.equal(shouldPlayOpsecDecision(state, state.pendingAction, 'neutral', 'p1'), false,
    'the shield is the escort — 16.4% of fired breakers are eaten by an OPSEC');
});

test('conservative saves its LAST OPSEC to escort a breaker instead of answering a 2M chain', () => {
  // Narrow on purpose: only 2M-or-less demands, only when this is our LAST shield, and only
  // for the two personalities whose BREAKER_BAR carries `escort: true`.
  //
  // A CHAIN response (depth > 0) is the leg that isolates the escort for conservative. Its
  // ordinary ladder already declines a 2M rent when it holds one shield, so a plain demand
  // would be answered `false` with or without the clause and would test nothing; the chain
  // rule below it — "somebody has already spent a card on this, so it is worth answering" —
  // returns true, and the escort is what overrules it.
  const state = build(3);
  const me = state.players[0];
  me.hand.push(action(state, 'opsec'), action(state, 'chud'));
  state.pendingAction = {
    type: 'payment', action: 'rent', sourceId: 'p2', amount: 2,
    targets: [{ id: 'p1', depth: 1, responderId: 'p1' }],
  };
  always(0);
  assert.equal(shouldPlayOpsecDecision(state, state.pendingAction, 'conservative', 'p1'), false,
    'the last shield was spent answering 2M of chain while a breaker sat in hand waiting for it');

  // a spare shield is not the escort, so the answer goes ahead exactly as before
  me.hand.push(action(state, 'opsec'));
  assert.equal(shouldPlayOpsecDecision(state, state.pendingAction, 'conservative', 'p1'), true,
    'a bot holding two shields reserved both — the escort is one card, not a policy of never answering');
});

/* §3.10h — neutral's shield policy was rewritten against real play, so these two guards were
 * rewritten with it. They used to pin `finance_office → true` and `rent >= 4 → true`, which
 * measured across 91 production games burned 15 of 15 shields on Finance Office and 23 of 23
 * on charges of 5M or more, and made neutral the weakest seat at a human table (13.9% per seat
 * against aggressive's 28.6% in the SAME games). Real players block Inspector General 82% of
 * the time and Finance Office 10%, and only 26% of charges at 5M or above. What the guards pin
 * now is the SHAPE of that gradient, which is the thing that must not regress. */
test('neutral spends its shield on the set-steal, not on the money', () => {
  const state = build(3);
  const me = state.players[0];
  me.hand.push(action(state, 'opsec'));
  const ask = (act, amount) => {
    state.pendingAction = {
      type: act === 'inspector_general' || act === 'chud' ? 'steal' : 'payment',
      action: act, sourceId: 'p2', amount,
      targets: [{ id: 'p1', depth: 0, responderId: 'p1' }],
    };
    always(0);
    return shouldPlayOpsecDecision(state, state.pendingAction, 'neutral', 'p1');
  };
  assert.equal(ask('inspector_general', 0), true, 'the set-steal is the one thing a shield must answer');
  assert.equal(ask('chud', 0), true, 'and so is the card that reaches into a complete set');
  assert.equal(ask('finance_office', 5), false, 'a 5M demand is money — it is earned back, a set is not');
  assert.equal(ask('rent', 4), false, 'a 4M rent is not worth the only shield we hold');
  assert.equal(ask('roll_call', 2), false, 'and neither is 2M off the whole table');
});

test('guard: a spare shield still answers the big charge', () => {
  const state = build(3);
  const me = state.players[0];
  me.hand.push(action(state, 'opsec'));
  state.pendingAction = {
    type: 'payment', action: 'finance_office', sourceId: 'p2', amount: 5,
    targets: [{ id: 'p1', depth: 0, responderId: 'p1' }],
  };
  always(0);
  assert.equal(shouldPlayOpsecDecision(state, state.pendingAction, 'neutral', 'p1'), false,
    'one shield is reserved for the steal');
  // A second shield is not the reserve, so the money charge gets answered after all — the
  // policy is about the LAST shield, not about never blocking a charge.
  me.hand.push(action(state, 'opsec'));
  assert.equal(shouldPlayOpsecDecision(state, state.pendingAction, 'neutral', 'p1'), true,
    'holding two, neutral can afford to answer the money as well');
});

/* ── THE CHUD CARD IS NEVER DISCARDED (owner directive, 2026-08-12) ─────────
 *
 * An absolute rule, not a sort weight. The §3.10c escrow asks every planner to sit on its
 * breakers, which makes them the cards most likely to be holding the bag when the hand limit
 * bites — and a comparator that merely ranks the CHUD last still surrenders it once the rest
 * of the hand is cheaper. The card is removed from the candidate pool instead.
 *
 * Cards are synthesised here rather than drawn: the deck holds only two CHUDs and six 1M
 * notes, and these fixtures deliberately exceed both.
 */
let synthId = 90000;
const synth = (props) => ({ id: ++synthId, ...props });
const aChud = () => synth({ type: 'action', action: 'chud', name: 'THE CHUD CARD', value: 4 });
const aNote = (v) => synth({ type: 'money', name: `${v}M`, value: v });
const aShield = () => synth({ type: 'action', action: 'opsec', name: 'OPSEC', value: 4 });

test('THE CHUD CARD is never discarded, by any personality', () => {
  for (const mode of ['conservative', 'neutral', 'aggressive', 'chud', 'random']) {
    const state = build(3);
    const me = state.players[0];
    // The fixture has to DISCRIMINATE: §3.10c already sorts hard breakers late, so a hand of
    // cheap money would keep the CHUD by sort weight alone and prove nothing. Fill it with
    // OPSEC instead — every comparator ranks the shield ABOVE a breaker, so under a mere
    // ranking the CHUD is the first card out. Only an absolute rule saves it. (And for the
    // two shuffle-based modes there is no comparator to appeal to at all.)
    me.hand = [aChud(), ...Array.from({ length: 7 }, aShield)];
    always(0);
    const ids = chooseDiscards(me, me.hand.length - 7, mode);
    setRng(null);
    const kept = me.hand.filter(c => !ids.includes(c.id));
    assert.equal(ids.length, 1, `${mode}: wrong number of cards discarded`);
    assert.ok(kept.some(c => c.action === 'chud'), `${mode} discarded THE CHUD CARD`);
  }
});

test('the CHUD protection yields rather than breaking the hand limit', () => {
  const state = build(3);
  const me = state.players[0];
  // Nine cards, eight of them CHUDs. The excess is 2 and only one ordinary card exists, so
  // one CHUD MUST go — returning a short list would have endTurn refuse it and wedge the
  // turn. Protection is a preference over the rest of the hand, not a licence to overrun it.
  me.hand = [...Array.from({ length: 8 }, aChud), aNote(1)];
  always(0);
  const ids = chooseDiscards(me, me.hand.length - 7, 'neutral');
  setRng(null);
  assert.equal(ids.length, 2, 'the hand limit still has to be met');
  const kept = me.hand.filter(c => !ids.includes(c.id));
  assert.equal(kept.length, 7);
  assert.equal(kept.filter(c => c.action === 'chud').length, 7,
    'the ordinary card goes first — only the overflow reaches a CHUD');
});
