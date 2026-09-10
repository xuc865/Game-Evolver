// test/houserules.test.js — §3.1 / §3.1b / §3.1c Hasbro corrections, plus the §3 rule
// presets and their individual toggles.

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');
const protocol = require('../server/protocol');
const sim = require('../simulate');

/* ── helpers ─────────────────────────────────────────────────────────── */

function game(playerCount = 2, opts = {}) {
  const players = Array.from({ length: playerCount }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  const state = G.createGame(players, opts);
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
  if (i >= 0) return state.deck.splice(i, 1)[0];
  for (const p of state.players) {
    const h = p.hand.findIndex(predicate);
    if (h >= 0) return p.hand.splice(h, 1)[0];
  }
  return assert.fail('expected card in deck or hand');
}
const give = (s, p, f) => { const c = take(s, f); p.hand.push(c); return c; };
function property(s, p, color) {
  const c = take(s, x => x.type === 'property' && x.color === color);
  (p.properties[color] = p.properties[color] || []).push({ ...c, placedColor: color });
  return c;
}
function wild(s, p, color) {
  const c = take(s, x => x.type === 'wild_property'
    && (x.colors[0] === 'any' || x.colors.includes(color)));
  (p.properties[color] = p.properties[color] || []).push({ ...c, placedColor: color });
  return c;
}
// The two wilds pureSetRequired now tells apart, taken by NAME rather than by whatever the
// generic helper happens to find first — the whole rule is which of the two it is.
function rainbowWild(s, p, color) {
  const c = take(s, x => x.type === 'wild_property' && x.colors[0] === 'any');
  (p.properties[color] = p.properties[color] || []).push({ ...c, placedColor: color });
  return c;
}
function pairWild(s, p, color) {
  const c = take(s, x => x.type === 'wild_property'
    && x.colors[0] !== 'any' && x.colors.includes(color));
  (p.properties[color] = p.properties[color] || []).push({ ...c, placedColor: color });
  return c;
}
function healthy(s) { assert.deepEqual(G.validateState(s), { ok: true }); }
function completeSet(s, p, color) {
  for (let i = (p.properties[color] || []).length; i < G.COLORS[color].size; i++) property(s, p, color);
}

/* ── §3.1 TDY Orders may not touch a complete set (Hasbro FAQ 926) ───── */

test('TDY Orders is refused when the TARGET card sits in a complete set', () => {
  const state = game();
  const [a, b] = state.players;
  completeSet(state, b, 'darkblue');
  property(state, a, 'red');
  give(state, a, c => c.action === 'tdy_orders');
  const res = G.playAction(state, 'p1', 0, {
    targetId: 'p2', targetCardId: b.properties.darkblue[0].id, myCardId: a.properties.red[0].id,
  });
  assert.match(res.error, /complete set/);
  assert.equal(state.pendingAction, null, 'the card is not spent on an illegal swap');
  assert.equal(a.hand.length, 1);
  healthy(state);
});

test('TDY Orders is refused when YOUR card sits in a complete set', () => {
  const state = game();
  const [a, b] = state.players;
  completeSet(state, a, 'darkblue');
  property(state, b, 'red');
  give(state, a, c => c.action === 'tdy_orders');
  const res = G.playAction(state, 'p1', 0, {
    targetId: 'p2', targetCardId: b.properties.red[0].id, myCardId: a.properties.darkblue[0].id,
  });
  assert.match(res.error, /complete set/);
  healthy(state);
});

test('TDY Orders still works when neither side is a complete set', () => {
  const state = game();
  const [a, b] = state.players;
  property(state, a, 'red');
  property(state, b, 'green');
  give(state, a, c => c.action === 'tdy_orders');
  assert.ok(G.playAction(state, 'p1', 0, {
    targetId: 'p2', targetCardId: b.properties.green[0].id, myCardId: a.properties.red[0].id,
  }).ok);
  assert.ok(G.respondToAction(state, 'p2', 'accept').ok);
  assert.equal(a.properties.green?.length, 1);
  assert.equal(b.properties.red?.length, 1);
  healthy(state);
});

test('CHUD is now the only card that takes out of a complete set', () => {
  const state = game();
  const [a, b] = state.players;
  completeSet(state, b, 'darkblue');
  const victim = b.properties.darkblue[0];

  // Midnight Requisition: refused.
  give(state, a, c => c.action === 'midnight_requisition');
  assert.match(G.playAction(state, 'p1', 0, { targetId: 'p2', targetCardId: victim.id }).error,
    /complete set/);
  a.hand.length = 0;
  // CHUD: allowed.
  give(state, a, c => c.action === 'chud');
  assert.ok(G.playAction(state, 'p1', 0, { targetId: 'p2', targetCardId: victim.id }).ok);
  assert.ok(G.respondToAction(state, 'p2', 'accept').ok);
  assert.equal(G.isSetComplete(b, 'darkblue'), false);
  healthy(state);
});

/* ── §3.1b Upgrades ──────────────────────────────────────────────────── */

test('a broken set sends its upgrades to the owner BANK, not the discard', () => {
  const state = game();
  const [a, b] = state.players;
  completeSet(state, a, 'darkblue');
  give(state, a, c => c.action === 'upgrade');
  assert.ok(G.playAction(state, 'p1', 0, { targetColor: 'darkblue' }).ok);
  assert.deepEqual(G.upgradeKinds(a, 'darkblue'), ['house']);
  const houseId = a.upgrades.darkblue[0].id;
  const discardBefore = state.discardPile.length;

  // p2 CHUDs a card out of the set, breaking it.
  state.currentPlayerIndex = 1; state.turnPhase = 'play'; state.playsRemaining = 3;
  give(state, b, c => c.action === 'chud');
  assert.ok(G.playAction(state, 'p2', 0, {
    targetId: 'p1', targetCardId: a.properties.darkblue[0].id }).ok);
  assert.ok(G.respondToAction(state, 'p1', 'accept').ok);

  assert.equal(a.upgrades.darkblue, undefined, 'the upgrade left the set');
  assert.ok(a.bank.some(c => c.id === houseId), 'it went to the owner\'s bank');
  assert.equal(state.discardPile.some(c => c.id === houseId), false, 'not the discard');
  assert.equal(state.discardPile.length, discardBefore + 1, 'only the CHUD card was discarded');
  healthy(state);
});

test('a banked upgrade sheds its upgradeType so it cannot render as a house', () => {
  const state = game();
  const [a] = state.players;
  completeSet(state, a, 'darkblue');
  give(state, a, c => c.action === 'upgrade');
  G.playAction(state, 'p1', 0, { targetColor: 'darkblue' });
  const house = a.upgrades.darkblue[0];
  assert.equal(house.upgradeType, 'house');

  G.bankUpgrades(state, a, 'darkblue');
  const banked = a.bank.find(c => c.id === house.id);
  assert.ok(banked);
  assert.equal(banked.upgradeType, undefined, 'stripped on the object');
  assert.equal(banked.placedColor, undefined);
  assert.equal(G.publicCard(banked).upgradeType, undefined, 'and therefore in the public view');
  const view = G.getPlayerView(state, 'p1').players[0];
  assert.equal(view.bank.some(c => c.upgradeType), false, 'no house sitting in a bank');
  healthy(state);
});

test('upgrades can be handed over as payment and land in the payee bank', () => {
  const state = game();
  const [a, b] = state.players;
  completeSet(state, b, 'darkblue');
  give(state, b, c => c.action === 'upgrade');
  state.currentPlayerIndex = 1;
  assert.ok(G.playAction(state, 'p2', 0, { targetColor: 'darkblue' }).ok);
  const houseId = b.upgrades.darkblue[0].id;

  // Roll Call demands 2M, which the 3M Upgrade covers on its own.
  state.currentPlayerIndex = 0; state.turnPhase = 'play'; state.playsRemaining = 3;
  give(state, a, c => c.action === 'roll_call');
  assert.ok(G.playAction(state, 'p1', 0, {}).ok);
  assert.ok(G.respondToAction(state, 'p2', 'accept', [houseId]).ok);

  assert.ok(a.bank.some(c => c.id === houseId), 'the payee banks it');
  assert.equal(a.bank.find(c => c.id === houseId).upgradeType, undefined, 'as a plain card');
  assert.equal(b.upgrades.darkblue, undefined);
  assert.equal(G.isSetComplete(b, 'darkblue'), true, 'the SET itself is untouched');
  healthy(state);
});

test('paying away an Upgrade takes its FOC with it rather than orphaning it', () => {
  const state = game();
  const [a, b] = state.players;
  completeSet(state, b, 'darkblue');
  give(state, b, c => c.action === 'upgrade');
  give(state, b, c => c.action === 'foc');
  state.currentPlayerIndex = 1;
  assert.ok(G.playAction(state, 'p2', 0, { targetColor: 'darkblue' }).ok);
  assert.ok(G.playAction(state, 'p2', 0, { targetColor: 'darkblue' }).ok);
  assert.deepEqual(G.upgradeKinds(b, 'darkblue'), ['house', 'hotel']);
  const houseId = b.upgrades.darkblue.find(u => u.upgradeType === 'house').id;

  state.currentPlayerIndex = 0; state.turnPhase = 'play'; state.playsRemaining = 3;
  give(state, a, c => c.action === 'roll_call');
  G.playAction(state, 'p1', 0, {});
  assert.ok(G.respondToAction(state, 'p2', 'accept', [houseId]).ok);

  assert.equal(b.upgrades.darkblue, undefined, 'the lone FOC did not stay on the set');
  // Command's complete-set rent is 8M; with House +3 and FOC +4 it was 15M.
  assert.equal(G.calcRent(b, 'darkblue'), 8, 'and both upgrades stopped paying rent');
  assert.ok(b.bank.some(u => u.value === 4), 'the FOC followed the House into the bank');
  healthy(state);
});

test('net worth now equals payable value — the HUD cannot show unspendable money', () => {
  const state = game();
  const [a] = state.players;
  completeSet(state, a, 'darkblue');
  give(state, a, c => c.action === 'upgrade');
  G.playAction(state, 'p1', 0, { targetColor: 'darkblue' });
  const row = G.getPlayerView(state, 'p1').players[0];
  assert.equal(row.netWorth, row.payableValue);
  assert.equal(row.upgradeValue, 3);
  assert.equal(row.netWorth, 8 + 3, 'two 4M Command properties plus the 3M Upgrade');
});

test('upgrades move between complete sets, and illegal moves are refused', () => {
  const state = game();
  const [a] = state.players;
  completeSet(state, a, 'darkblue');
  completeSet(state, a, 'brown');
  property(state, a, 'red');                       // an incomplete set
  give(state, a, c => c.action === 'upgrade');
  G.playAction(state, 'p1', 0, { targetColor: 'darkblue' });
  const houseId = a.upgrades.darkblue[0].id;

  assert.match(G.moveProperty(state, 'p1', houseId, 'red').error, /not a complete set/);
  assert.match(G.moveProperty(state, 'p1', houseId, 'darkblue').error, /Already on that set/);

  const plays = state.playsRemaining;
  assert.ok(G.moveProperty(state, 'p1', houseId, 'brown').ok);
  assert.equal(state.playsRemaining, plays, 'rearranging costs no play');
  assert.deepEqual(G.upgradeKinds(a, 'brown'), ['house']);
  assert.equal(a.upgrades.darkblue, undefined);
  assert.ok(state.events.some(e => e.t === 'move_upgrade' && e.to === 'brown'));
  healthy(state);
});

test('an FOC cannot be moved to a set with no Upgrade, nor stranded by moving its Upgrade', () => {
  const state = game();
  const [a] = state.players;
  completeSet(state, a, 'darkblue');
  completeSet(state, a, 'brown');
  give(state, a, c => c.action === 'upgrade');
  give(state, a, c => c.action === 'foc');
  G.playAction(state, 'p1', 0, { targetColor: 'darkblue' });
  G.playAction(state, 'p1', 0, { targetColor: 'darkblue' });
  const house = a.upgrades.darkblue.find(u => u.upgradeType === 'house');
  const hotel = a.upgrades.darkblue.find(u => u.upgradeType === 'hotel');

  assert.match(G.moveProperty(state, 'p1', hotel.id, 'brown').error, /needs an Upgrade/);
  assert.match(G.moveProperty(state, 'p1', house.id, 'brown').error, /Move the FOC off/);
  healthy(state);
});

/* ── §3.1c Surge Ops ─────────────────────────────────────────────────── */

test('Surge Ops never touches Finance Office or Roll Call, and is not consumed by them', () => {
  const state = game(3);
  const [a] = state.players;
  give(state, a, c => c.action === 'surge_ops');
  give(state, a, c => c.action === 'roll_call');
  assert.ok(G.playAction(state, 'p1', 0, {}).ok);
  assert.ok(G.playAction(state, 'p1', 0, {}).ok);
  assert.equal(state.pendingAction.amount, 2);
  assert.equal(state._surgeOps, 1, 'still armed for a rent');
});

test('two Surge Ops stack to x4 on rent', () => {
  const state = game();
  const [a] = state.players;
  property(state, a, 'brown');
  give(state, a, c => c.action === 'surge_ops');
  give(state, a, c => c.action === 'surge_ops');
  give(state, a, c => c.type === 'rent' && c.colors.includes('brown'));
  G.playAction(state, 'p1', 0, {});
  G.playAction(state, 'p1', 0, {});
  assert.equal(G.getPlayerView(state, 'p1').surgeMultiplier, 4);
  G.playAction(state, 'p1', 0, { targetColor: 'brown' });
  assert.equal(state.pendingAction.amount, 4);
  healthy(state);
});

/* ── §3 presets and toggles: configuration surface ───────────────────── */

test('every preset resolves server-side to its documented ruleset', () => {
  // The deck is asserted card-for-card in test/deckconfig.test.js; here it is stripped so
  // this stays a test of the SCALAR ruleset rather than a second copy of the deck table.
  const scalars = (p) => { const { deck, ...rest } = G.resolveRules({ preset: p }); return rest; };
  assert.deepEqual(scalars('chudopoly'),
    { preset: 'chudopoly', winRule: 'finalApproach', setsToWin: 3, pureSetRequired: false, counterCostsPlay: false, passGoRestartsTurn: false, suddenDeath: 'off' });
  assert.deepEqual(scalars('mdFaithful'),
    { preset: 'mdFaithful', winRule: 'mdFaithful', setsToWin: 3, pureSetRequired: true, counterCostsPlay: true, passGoRestartsTurn: false, suddenDeath: 'off' });
  assert.deepEqual(scalars('blitz'),
    { preset: 'blitz', winRule: 'instant', setsToWin: 3, pureSetRequired: false, counterCostsPlay: false, passGoRestartsTurn: true, suddenDeath: 'off' });
  assert.deepEqual(scalars('longGame'),
    { preset: 'longGame', winRule: 'finalApproach', setsToWin: 5, pureSetRequired: false, counterCostsPlay: false, passGoRestartsTurn: false, suddenDeath: 'off' });
  // absent / unknown ⇒ Chudopoly defaults
  for (const bad of [undefined, null, 'nope', 42]) {
    assert.equal(G.resolveRules({ preset: bad }).preset, 'chudopoly');
  }
});

test('individual toggles override a preset and the label becomes custom', () => {
  const mixed = G.resolveRules({ preset: 'blitz', setsToWin: 5 });
  assert.equal(mixed.preset, 'custom');
  assert.equal(mixed.winRule, 'instant');
  assert.equal(mixed.setsToWin, 5);
  // and a toggle combination that exactly equals a preset is labelled as that preset
  assert.equal(G.resolveRules({ winRule: 'instant', passGoRestartsTurn: true }).preset, 'blitz');
  assert.equal(G.resolveRules({ setsToWin: 4 }).preset, 'custom');
});

test('start_game validates every rule field additively', () => {
  const base = { type: 'start_game', turnTimeout: 60, responseTimeout: 30 };
  assert.equal(protocol.validateMessage(base).ok, true, 'all rule fields are optional');
  for (const p of ['chudopoly', 'mdFaithful', 'blitz', 'longGame']) {
    assert.equal(protocol.validateMessage({ ...base, preset: p }).ok, true, p);
  }
  for (const n of [3, 4, 5]) {
    assert.equal(protocol.validateMessage({ ...base, setsToWin: n }).ok, true, String(n));
  }
  assert.equal(protocol.validateMessage({ ...base, pureSetRequired: true, passGoRestartsTurn: false }).ok, true);

  assert.match(protocol.validateMessage({ ...base, preset: 'nope' }).error, /preset/i);
  assert.match(protocol.validateMessage({ ...base, setsToWin: 6 }).error, /sets to win/i);
  assert.match(protocol.validateMessage({ ...base, setsToWin: '3' }).error, /sets to win/i);
  assert.match(protocol.validateMessage({ ...base, pureSetRequired: 'yes' }).error, /pure-set/i);
  assert.match(protocol.validateMessage({ ...base, passGoRestartsTurn: 1 }).error, /PCS Orders/i);
});

test('getPlayerView ships the whole resolved ruleset', () => {
  const state = game(2, { preset: 'longGame' });
  const view = G.getPlayerView(state, 'p1');
  const { deck, ...scalars } = view.rules;
  assert.deepEqual(scalars, {
    preset: 'longGame', winRule: 'finalApproach', setsToWin: 5,
    pureSetRequired: false, counterCostsPlay: false, passGoRestartsTurn: false, suddenDeath: 'off',
  });
  // §3 deck knob: the whole composition is on the wire, so the client never has to guess
  // what is in the deck and a recorded game carries the deck it was played with.
  assert.deepEqual(deck, G.DECK_BASE);
  assert.equal(view.setsToWin, 5, 'the legacy scalar agrees with the ruleset');
  assert.equal(view.winRule, 'finalApproach');
  assert.equal(state.events[0].rules.preset, 'longGame', 'game_start carries it too');
});

/* ── setsToWin ───────────────────────────────────────────────────────── */

test('setsToWin 5 does not arm at 3 and does arm at 5', () => {
  const state = game(2, { setsToWin: 5 });
  const [a] = state.players;
  for (const color of ['brown', 'darkblue', 'intel']) completeSet(state, a, color);
  G.getPlayerView(state, 'p1');
  assert.equal(G.completedSets(a), 3);
  assert.equal(a.finalApproach, false, 'three sets is not enough any more');

  completeSet(state, a, 'lightblue');
  // Complete the fifth through a real play so syncSets runs.
  property(state, a, 'pink'); property(state, a, 'pink');
  give(state, a, c => c.type === 'property' && c.color === 'pink');
  assert.ok(G.playProperty(state, 'p1', 0).ok);
  assert.equal(G.completedSets(a), 5);
  assert.equal(a.finalApproach, true);
  healthy(state);
});

test('setsToWin is reflected in the log copy and the view instead of a hard-coded 3', () => {
  const state = game(2, { setsToWin: 4 });
  const [a] = state.players;
  property(state, a, 'brown');
  give(state, a, c => c.type === 'property' && c.color === 'brown');
  G.playProperty(state, 'p1', 0);
  assert.ok(state.log.some(l => /completed the Drone Ops set — 1 of 4\./.test(l)), state.log.join(' | '));
  assert.equal(G.getPlayerView(state, 'p1').setsToWin, 4);
});

/* ── pureSetRequired ─────────────────────────────────────────────────── */

test('pureSetRequired: an all-RAINBOW zone is full but is not a set', () => {
  const state = game(2, { pureSetRequired: true });
  const [a] = state.players;
  rainbowWild(state, a, 'darkblue'); rainbowWild(state, a, 'darkblue');
  assert.equal(G.zoneFull(a, 'darkblue'), true, 'the zone is still capped');
  assert.equal(G.isSetComplete(a, 'darkblue'), false, 'but it is not a SET');
  assert.equal(G.completedSets(a), 0);
  // ...and therefore it is fair game for Midnight Requisition
  assert.equal(G.zoneRequisitionable(a, 'darkblue'), true);

  const off = game(2, {});
  rainbowWild(off, off.players[0], 'darkblue'); rainbowWild(off, off.players[0], 'darkblue');
  assert.equal(G.isSetComplete(off.players[0], 'darkblue'), true, 'default rules still count it');
});

// NARROWED 2026-08-08. The toggle used to demand a real `type:'property'` card, which also
// outlawed a zone of two-colour wilds — stricter than the source it is named after. Hasbro
// prints the distinction on the two card faces (Monopoly Deal FIFA G3239, Harry Potter
// G0717): two-colour wild "You may make a complete player set using only these cards";
// every-colour wild "You may not make a complete player set using only these cards."
test('pureSetRequired: two-colour wilds alone DO finish a set — only rainbows cannot', () => {
  const state = game(2, { pureSetRequired: true });
  const [a] = state.players;
  // brown is a 2-card colour and the stock deck carries two brown/lightblue wilds, so a
  // brown zone can legally be filled with nothing but two-colour wilds.
  pairWild(state, a, 'brown'); pairWild(state, a, 'brown');
  assert.equal(a.properties.brown.every(c => c.type === 'wild_property'), true, 'no real property');
  assert.equal(G.isSetComplete(a, 'brown'), true, 'a set of two-colour wilds is a SET');
  assert.equal(G.completedSets(a), 1);
  assert.equal(G.zoneRequisitionable(a, 'brown'), false, 'and it is protected like any set');

  // One rainbow among them is still fine — the ban is on a zone of NOTHING but rainbows.
  const mixed = game(2, { pureSetRequired: true });
  const [m] = mixed.players;
  rainbowWild(mixed, m, 'darkblue'); pairWild(mixed, m, 'darkblue');
  assert.equal(G.isSetComplete(m, 'darkblue'), true);
});

test('pureSetRequired: losing the only real property un-arms a final approach', () => {
  const state = game(2, { pureSetRequired: true });
  const [a, b] = state.players;
  completeSet(state, a, 'brown');
  completeSet(state, a, 'darkblue');
  // intel: one real property plus one wild — a set only because of the real card.
  wild(state, a, 'intel');
  give(state, a, c => c.type === 'property' && c.color === 'intel');
  assert.ok(G.playProperty(state, 'p1', 0).ok);
  assert.equal(G.completedSets(a), 3);
  assert.equal(a.finalApproach, true);

  // p2 CHUDs the real intel property out; the zone stays full of wilds but stops being a set.
  state.currentPlayerIndex = 1; state.turnPhase = 'play'; state.playsRemaining = 3;
  const realCard = a.properties.intel.find(c => c.type === 'property');
  give(state, b, c => c.action === 'chud');
  assert.ok(G.playAction(state, 'p2', 0, { targetId: 'p1', targetCardId: realCard.id }).ok);
  assert.ok(G.respondToAction(state, 'p1', 'accept').ok);

  assert.equal(a.finalApproach, false, 'the approach is broken');
  assert.ok(state.events.some(e => e.t === 'final_approach_broken' && e.by === 'p2'),
    'and the HUD is told who broke it');
  healthy(state);
});

/* ── counterCostsPlay (§3.1d) ────────────────────────────────────────── */

// Hasbro's modern printings charge the counter. FIFA Deal's RED CARD (G3239) — the Just Say
// No of that cut — prints: "If you add this card to your Bank as points or play it as an
// action card, it counts as one of the three cards you may play on your turn." Only the seat
// whose turn it is has a play budget, so only that seat ever pays.
function opsecChain(opts) {
  const state = game(2, opts);
  const [a, b] = state.players;
  give(state, a, c => c.action === 'finance_office');
  give(state, b, c => c.action === 'opsec');
  give(state, a, c => c.action === 'opsec');
  assert.ok(G.playAction(state, 'p1', 0, { targetId: 'p2' }).ok);
  assert.equal(state.playsRemaining, 2, 'the attack itself spent one');
  return { state, a, b };
}

test('counterCostsPlay: the defender counters free, the attacker pays a play', () => {
  const { state, a } = opsecChain({ counterCostsPlay: true });

  assert.ok(G.respondToAction(state, 'p2', 'opsec').ok);
  assert.equal(state.playsRemaining, 2,
    'P2 is answering on somebody else\'s turn and has no play budget to spend');

  assert.equal(G.canCounter(state, 'p1'), true);
  assert.ok(G.respondToAction(state, 'p1', 'opsec').ok);
  assert.equal(state.playsRemaining, 1, 'the attacker\'s counter is one of their three');
  const ev = state.events.filter(e => e.t === 'opsec');
  assert.equal(ev[0].spentPlay, false, 'defender');
  assert.equal(ev[1].spentPlay, true, 'attacker on their own turn');
  assert.ok(state.log.some(l => /one of their three plays/.test(l)));
  assert.equal(a.hand.filter(c => c.action === 'opsec').length, 0);
  healthy(state);
});

test('counterCostsPlay: with no plays left the counter is refused, not discounted', () => {
  const { state, a } = opsecChain({ counterCostsPlay: true });
  assert.ok(G.respondToAction(state, 'p2', 'opsec').ok);
  state.playsRemaining = 0;                       // the attacker spent their last two

  assert.equal(G.canCounter(state, 'p1'), false);
  const res = G.respondToAction(state, 'p1', 'opsec');
  assert.match(res.error, /no plays left/i);
  assert.equal(a.hand.filter(c => c.action === 'opsec').length, 1, 'the card is not consumed');
  assert.equal(state.playsRemaining, 0);
  // and accepting still resolves the pending action, so the refusal is never a softlock
  assert.ok(G.respondToAction(state, 'p1', 'accept').ok);
  assert.equal(state.pendingAction, null);
  healthy(state);
});

test('counterCostsPlay: OFF by default — OPSEC chains stay free in every shipped preset', () => {
  const { state } = opsecChain({});
  assert.ok(G.respondToAction(state, 'p2', 'opsec').ok);
  assert.ok(G.respondToAction(state, 'p1', 'opsec').ok);
  assert.equal(state.playsRemaining, 2, 'neither counter cost anything');
  assert.equal(state.events.filter(e => e.t === 'opsec').every(e => e.spentPlay === false), true);
  for (const preset of ['chudopoly', 'blitz', 'longGame']) {
    assert.equal(G.RULE_PRESETS[preset].counterCostsPlay, false, preset);
  }
  assert.equal(G.RULE_PRESETS.mdFaithful.counterCostsPlay, true, 'only MD Faithful charges');
});

/* ── passGoRestartsTurn ──────────────────────────────────────────────── */

test('passGoRestartsTurn: PCS Orders draws 2 and refills the plays', () => {
  const state = game(2, { passGoRestartsTurn: true });
  const [a] = state.players;
  give(state, a, c => c.action === 'pcs_orders');
  give(state, a, c => c.type === 'money');
  assert.ok(G.playAsMoney(state, 'p1', 1).ok);
  assert.equal(state.playsRemaining, 2);
  const res = G.playAction(state, 'p1', 0, {});
  assert.equal(res.drawn.length, 2, 'still draws 2');
  assert.equal(state.playsRemaining, 3, 'and hands back a full turn');
  assert.ok(state.events.some(e => e.t === 'turn_restart' && e.actor === 'p1'));
  healthy(state);
});

test('passGoRestartsTurn off: PCS Orders just spends a play', () => {
  const state = game(2);
  const [a] = state.players;
  give(state, a, c => c.action === 'pcs_orders');
  assert.equal(G.playAction(state, 'p1', 0, {}).drawn.length, 2);
  assert.equal(state.playsRemaining, 2);
  assert.equal(state.events.some(e => e.t === 'turn_restart'), false);
});

/* ── bots play legally under every combination ───────────────────────── */

test('bots make no illegal move and every game reaches an ending, under every preset', () => {
  const refusals = [];
  const wrapped = ['playAction', 'playProperty', 'playAsMoney', 'moveProperty', 'respondToAction'];
  const originals = {};
  for (const fn of wrapped) {
    originals[fn] = G[fn];
    G[fn] = function (state, ...rest) {
      const res = originals[fn].call(this, state, ...rest);
      if (res && res.error) refusals.push(`${fn}: ${res.error}`);
      return res;
    };
  }
  try {
    const modes = ['random', 'conservative', 'neutral', 'aggressive', 'chud'];
    for (const preset of ['chudopoly', 'mdFaithful', 'blitz', 'longGame']) {
      let decided = 0;
      const games = 10;
      for (let g = 0; g < games; g++) {
        const players = Array.from({ length: 4 }, (_, i) => ({ name: 'B' + i, mode: modes[(g + i) % 5] }));
        const result = sim.runGame(players, 300, `legal-${preset}-${g}`, { preset });
        if (result.winner || result.endReason) decided++;
      }
      assert.equal(decided, games, `${preset}: every game must reach an ending`);
    }
  } finally {
    for (const fn of wrapped) G[fn] = originals[fn];
  }
  assert.deepEqual(refusals.slice(0, 5), [],
    `bots proposed ${refusals.length} illegal move(s)`);
});
