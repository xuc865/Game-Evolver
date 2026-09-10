const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');

function game(playerCount = 2) {
  const players = Array.from({ length: playerCount }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}` }));
  const state = G.createGame(players);
  state.deck = G.buildDeck();
  state.discardPile = [];
  state.pendingAction = null;
  state.players.forEach(p => { p.hand = []; p.bank = []; p.properties = {}; p.upgrades = {}; });
  state.turnPhase = 'play';
  state.currentPlayerIndex = 0;
  state.playsRemaining = 3;
  state._handSnapshot = 0;
  return state;
}

function take(state, predicate) {
  const index = state.deck.findIndex(predicate);
  if (index >= 0) return state.deck.splice(index, 1)[0];
  // The turn draw is automatic now, so a card a test wants may already have been auto-drawn
  // into a hand (buildDeck's last two cards are the CHUDs, and pop() takes from the end).
  // Reclaim it from there so the fixtures stay deterministic and cards stay conserved.
  for (const player of state.players) {
    const handIndex = player.hand.findIndex(predicate);
    if (handIndex >= 0) return player.hand.splice(handIndex, 1)[0];
  }
  assert.fail('expected card in deck or in a hand');
}

function give(state, player, predicate) {
  const card = take(state, predicate);
  player.hand.push(card);
  return card;
}

function bank(state, player, value) {
  const card = take(state, c => c.type === 'money' && c.value === value);
  player.bank.push(card);
  return card;
}

function property(state, player, color) {
  const card = take(state, c => c.type === 'property' && c.color === color);
  (player.properties[color] ||= []).push({ ...card, placedColor: color });
  return card;
}

function events(state, type) {
  return state.events.filter(e => e.t === type);
}

function assertHealthy(state) {
  assert.deepEqual(G.validateState(state), { ok: true });
}

test('deck has unique IDs and a healthy initial state', () => {
  const state = G.createGame([{ id:'p1', name:'One' }, { id:'p2', name:'Two' }]);
  assert.equal(G.buildDeck().length, 106);
  assert.equal(new Set(G.buildDeck().map(c => c.id)).size, G.buildDeck().length);
  assertHealthy(state);
});

test('a seed makes the shuffle reproducible and stays out of the view', () => {
  const players = [{ id:'p1', name:'One' }, { id:'p2', name:'Two' }];
  const a = G.createGame(players, { seed: 'alpha' });
  const b = G.createGame(players, { seed: 'alpha' });
  const c = G.createGame(players, { seed: 'beta' });
  const ids = s => s.deck.map(card => card.id).join(',');
  assert.equal(ids(a), ids(b));
  assert.notEqual(ids(a), ids(c));
  assert.deepEqual(a.players[0].hand.map(x => x.id), b.players[0].hand.map(x => x.id));
  assert.equal(Object.keys(a).includes('_rng'), false);
  assert.equal(JSON.stringify(G.getPlayerView(a, 'p1')).includes('_rng'), false);

  // Reshuffles use the seeded stream too.
  a.deck = []; b.deck = [];
  a.discardPile = G.buildDeck(); b.discardPile = G.buildDeck();
  a.cardTotal = null; b.cardTotal = null;
  a.turnPhase = 'draw'; b.turnPhase = 'draw';   // turn 1 already auto-drew (game.js beginTurn)
  G.drawCards(a); G.drawCards(b);
  assert.deepEqual(a.players[0].hand.map(x => x.id), b.players[0].hand.map(x => x.id));
});

test('game_start, deal, turn_start, auto-draw events are emitted with monotonic seq', () => {
  const state = G.createGame([{ id:'p1', name:'One' }, { id:'p2', name:'Two' }], { seed: 'ev' });
  // The turn draw is automatic, so turn 1's `draw` lands inside createGame, immediately
  // after `turn_start` — the same position it occupied when the client asked for it.
  assert.deepEqual(state.events.map(e => e.t), ['game_start', 'deal', 'deal', 'turn_start', 'draw']);
  assert.deepEqual(state.events.map(e => e.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(state.events[0].order, ['p1', 'p2']);
  assert.equal(state.events[1].cards.length, 5);
  assert.equal(state.events[3].actor, 'p1');
  assert.equal(state.events[4].to, 'p1');
  assert.equal(state.events[4].count, 2);
  assert.equal(state.turnPhase, 'play');
});

test('PCS, Upgrade, FOC, and Surge actions preserve cards', () => {
  const state = game();
  const p1 = state.players[0];
  property(state, p1, 'brown'); property(state, p1, 'brown');
  give(state, p1, c => c.action === 'upgrade');
  give(state, p1, c => c.action === 'foc');
  give(state, p1, c => c.action === 'surge_ops');
  assert.ok(G.playAction(state, 'p1', 0, { targetColor:'brown' }).ok);
  assert.ok(G.playAction(state, 'p1', 0, { targetColor:'brown' }).ok);
  assert.ok(G.playAction(state, 'p1', 0, {}).ok);
  assert.deepEqual(G.upgradeKinds(p1, 'brown'), ['house', 'hotel']);
  assert.equal(state._surgeOps, 1);   // §3.1c: a counter now, not a boolean
  assert.equal(events(state, 'upgrade').length, 2);
  assertHealthy(state);

  const pcsState = game();
  give(pcsState, pcsState.players[0], c => c.action === 'pcs_orders');
  assert.equal(G.playAction(pcsState, 'p1', 0, {}).drawn.length, 2);
  assertHealthy(pcsState);
});

test('Surge Operations stacks and applies to RENT ONLY (§3.1c)', () => {
  // Hasbro's Double The Rent: it never touches Finance Office.
  const finance = game();
  give(finance, finance.players[0], c => c.action === 'surge_ops');
  give(finance, finance.players[0], c => c.action === 'finance_office');
  assert.ok(G.playAction(finance, 'p1', 0, {}).ok);
  assert.ok(G.playAction(finance, 'p1', 0, { targetId:'p2' }).ok);
  assert.equal(finance.pendingAction.amount, 5, 'Finance Office is never surged');
  assert.equal(finance.pendingAction.doubled, false);
  assert.equal(finance._surgeOps, 1, 'and the surge is NOT consumed by it');
  assertHealthy(finance);

  // Nor Roll Call.
  const roll = game(3);
  give(roll, roll.players[0], c => c.action === 'surge_ops');
  give(roll, roll.players[0], c => c.action === 'roll_call');
  assert.ok(G.playAction(roll, 'p1', 0, {}).ok);
  assert.ok(G.playAction(roll, 'p1', 0, {}).ok);
  assert.equal(roll.pendingAction.amount, 2, 'Roll Call is never surged');
  assert.equal(roll.pendingAction.targets.length, 2);
  assertHealthy(roll);

  // Rent IS surged, and one surge doubles it.
  const rent = game();
  property(rent, rent.players[0], 'brown');
  give(rent, rent.players[0], c => c.action === 'surge_ops');
  give(rent, rent.players[0], c => c.type === 'rent' && c.colors.includes('brown'));
  assert.ok(G.playAction(rent, 'p1', 0, {}).ok);
  assert.ok(G.playAction(rent, 'p1', 0, { targetColor:'brown' }).ok);
  assert.equal(rent.pendingAction.amount, 2, '1M base rent x2');
  assert.equal(events(rent, 'rent_charged')[0].doubled, true);
  assert.equal(rent._surgeOps, undefined, 'consumed by the rent');
  assertHealthy(rent);

  // Two copies stack to x4, spending two of the three plays (MD explicitly allows it).
  const stacked = game();
  property(stacked, stacked.players[0], 'brown');
  give(stacked, stacked.players[0], c => c.action === 'surge_ops');
  give(stacked, stacked.players[0], c => c.action === 'surge_ops');
  give(stacked, stacked.players[0], c => c.type === 'rent' && c.colors.includes('brown'));
  assert.ok(G.playAction(stacked, 'p1', 0, {}).ok);
  assert.ok(G.playAction(stacked, 'p1', 0, {}).ok, 'a second Surge is legal, not refused');
  assert.equal(stacked._surgeOps, 2);
  assert.equal(stacked.playsRemaining, 1, 'two of three plays spent');
  assert.ok(G.playAction(stacked, 'p1', 0, { targetColor:'brown' }).ok);
  assert.equal(stacked.pendingAction.amount, 4, '1M base rent x4');
  assert.equal(G.getPlayerView(stacked, 'p1').surgeOps, 0);
  assertHealthy(stacked);
});

test('a surge that is never spent expires at end of turn', () => {
  const state = game();
  give(state, state.players[0], c => c.action === 'surge_ops');
  assert.ok(G.playAction(state, 'p1', 0, {}).ok);
  assert.equal(state._surgeOps, 1);
  assert.equal(G.getPlayerView(state, 'p1').surgeOps, 1);
  assert.equal(G.getPlayerView(state, 'p1').surgeMultiplier, 2);
  assert.ok(G.endTurn(state, 'p1').ok);
  assert.equal(state._surgeOps, undefined);
});

test('Finance payment and OPSEC counter chain resolve correctly', () => {
  const state = game();
  const [p1, p2] = state.players;
  give(state, p1, c => c.action === 'finance_office');
  give(state, p1, c => c.action === 'opsec');
  give(state, p2, c => c.action === 'opsec');
  const payment = bank(state, p2, 5);
  assert.ok(G.playAction(state, 'p1', 0, { targetId:'p2' }).ok);
  assert.ok(G.respondToAction(state, 'p2', 'opsec').ok);
  assert.equal(state.pendingAction.targets[0].depth, 1);
  assert.deepEqual(G.pendingResponders(state), ['p1']);
  assert.ok(G.respondToAction(state, 'p1', 'opsec').ok);
  assert.deepEqual(G.pendingResponders(state), ['p2']);
  assert.ok(G.respondToAction(state, 'p2', 'accept', [payment.id]).ok);
  assert.equal(p1.bank[0].value, 5);
  assert.equal(state.pendingAction, null);
  assert.equal(state.turnPhase, 'play');
  assert.equal(events(state, 'opsec').length, 2);
  assert.equal(events(state, 'payment').length, 1);
  assertHealthy(state);
});

test('an unanswered OPSEC blocks the action and consumes no payment', () => {
  const state = game();
  const [p1, p2] = state.players;
  give(state, p1, c => c.action === 'finance_office');
  give(state, p2, c => c.action === 'opsec');
  bank(state, p2, 5);
  assert.ok(G.playAction(state, 'p1', 0, { targetId:'p2' }).ok);
  assert.ok(G.respondToAction(state, 'p2', 'opsec').ok);
  assert.ok(G.respondToAction(state, 'p1', 'accept').ok);   // source concedes
  assert.equal(state.pendingAction, null);
  assert.equal(p1.bank.length, 0);
  assert.equal(p2.bank.length, 1);
  assert.equal(events(state, 'action_blocked').length, 1);
  assertHealthy(state);
});

test('OPSEC → counter → counter-counter leaves the defender safe', () => {
  const state = game();
  const [p1, p2] = state.players;
  give(state, p1, c => c.action === 'midnight_requisition');
  give(state, p1, c => c.action === 'opsec');
  give(state, p2, c => c.action === 'opsec');
  give(state, p2, c => c.action === 'opsec');
  const stolen = property(state, p2, 'brown');
  assert.ok(G.playAction(state, 'p1', 0, { targetId:'p2', targetCardId:stolen.id }).ok);
  assert.ok(G.respondToAction(state, 'p2', 'opsec').ok);   // depth 1
  assert.ok(G.respondToAction(state, 'p1', 'opsec').ok);   // depth 2
  assert.ok(G.respondToAction(state, 'p2', 'opsec').ok);   // depth 3
  assert.deepEqual(G.pendingResponders(state), ['p1']);
  assert.ok(G.respondToAction(state, 'p1', 'accept').ok);
  assert.equal(state.pendingAction, null);
  assert.equal(p2.properties.brown.length, 1, 'property stayed with the defender');
  assert.equal(state.players[0].properties.brown, undefined);
  assert.equal(events(state, 'opsec').length, 3);
  assertHealthy(state);
});

test('Roll Call resolves each target independently: pay, block, insolvent', () => {
  const state = game(4);
  const [p1, p2, p3, p4] = state.players;
  give(state, p1, c => c.action === 'roll_call');
  const p2Money = bank(state, p2, 2);
  give(state, p3, c => c.action === 'opsec');
  // p4 owns nothing at all
  assert.ok(G.playAction(state, 'p1', 0, {}).ok);
  assert.equal(state.pendingAction.targets.length, 3);

  assert.ok(G.respondToAction(state, 'p2', 'accept', [p2Money.id]).ok);
  assert.ok(G.respondToAction(state, 'p3', 'opsec').ok);
  assert.ok(G.respondToAction(state, 'p4', 'accept').ok);          // nothing to give
  assert.equal(state.pendingAction.targets.length, 1, 'only the OPSEC chain is left');
  assert.ok(G.respondToAction(state, 'p1', 'accept').ok);           // concede to p3
  assert.equal(state.pendingAction, null);

  assert.equal(G.playerTotalValue(p1), 2);
  assert.equal(events(state, 'insolvent').length, 1);
  assert.equal(events(state, 'action_blocked').length, 1);
  assert.equal(events(state, 'demand').length, 3);
  assertHealthy(state);
});

test('colour rent bills the table; wild rent bills one named player', () => {
  const colour = game(3);
  property(colour, colour.players[0], 'brown');
  give(colour, colour.players[0], c => c.type === 'rent' && c.colors.includes('brown'));
  const m2 = bank(colour, colour.players[1], 1);
  const m3 = bank(colour, colour.players[2], 1);
  assert.ok(G.playAction(colour, 'p1', 0, { targetColor:'brown' }).ok);
  assert.deepEqual(colour.pendingAction.targets.map(t => t.id), ['p2', 'p3']);
  assert.ok(G.respondToAction(colour, 'p2', 'accept', [m2.id]).ok);
  assert.ok(G.respondToAction(colour, 'p3', 'accept', [m3.id]).ok);
  assert.equal(colour.pendingAction, null);
  assertHealthy(colour);

  const wild = game(3);
  property(wild, wild.players[0], 'brown');
  give(wild, wild.players[0], c => c.type === 'rent' && c.colors[0] === 'any');
  bank(wild, wild.players[1], 1);
  bank(wild, wild.players[2], 1);
  assert.match(G.playAction(wild, 'p1', 0, { targetColor:'brown' }).error, /Choose a player/);
  assert.equal(wild.players[0].hand.length, 1, 'rejected play keeps the card in hand');
  assert.ok(G.playAction(wild, 'p1', 0, { targetColor:'brown', targetId:'p3' }).ok);
  assert.deepEqual(wild.pendingAction.targets.map(t => t.id), ['p3']);
  assert.deepEqual(events(wild, 'rent_charged')[0].targets, ['p3']);
  assertHealthy(wild);
});

test('steal, set seizure, swap, and CHUD actions resolve atomically', () => {
  const stealState = game();
  const stealCard = property(stealState, stealState.players[1], 'brown');
  give(stealState, stealState.players[0], c => c.action === 'midnight_requisition');
  assert.ok(G.playAction(stealState, 'p1', 0, { targetId:'p2', targetCardId:stealCard.id }).ok);
  assert.equal(stealState.turnPhase, 'action_response');
  assert.ok(G.respondToAction(stealState, 'p2', 'accept').ok);
  assert.equal(stealState.players[0].properties.brown.length, 1);
  assert.equal(events(stealState, 'steal').length, 1);
  assertHealthy(stealState);

  const setState = game();
  property(setState, setState.players[1], 'brown'); property(setState, setState.players[1], 'brown');
  give(setState, setState.players[0], c => c.action === 'inspector_general');
  assert.ok(G.playAction(setState, 'p1', 0, { targetId:'p2', targetColor:'brown' }).ok);
  assert.ok(G.respondToAction(setState, 'p2', 'accept').ok);
  assert.equal(setState.players[0].properties.brown.length, 2);
  assert.equal(events(setState, 'set_stolen')[0].cards.length, 2);
  assert.equal(events(setState, 'set_completed').length, 1);
  assertHealthy(setState);

  const swapState = game();
  const mine = property(swapState, swapState.players[0], 'brown');
  const theirs = property(swapState, swapState.players[1], 'green');
  give(swapState, swapState.players[0], c => c.action === 'tdy_orders');
  assert.ok(G.playAction(swapState, 'p1', 0, { targetId:'p2', myCardId:mine.id, targetCardId:theirs.id }).ok);
  assert.ok(G.respondToAction(swapState, 'p2', 'accept').ok);
  assert.equal(swapState.players[0].properties.green[0].id, theirs.id);
  assert.equal(swapState.players[1].properties.brown[0].id, mine.id);
  assertHealthy(swapState);
});

test('CHUD steals out of a complete set and charges nothing (§3.1)', () => {
  const state = game();
  const [p1, p2] = state.players;
  property(state, p2, 'brown'); property(state, p2, 'brown');
  const target = p2.properties.brown[0];
  bank(state, p2, 5);
  give(state, p1, c => c.action === 'chud');
  assert.ok(G.playAction(state, 'p1', 0, { targetId:'p2', targetCardId:target.id }).ok);
  assert.ok(G.respondToAction(state, 'p2', 'accept').ok);
  assert.equal(state.pendingAction, null, 'no tax rider follows the steal');
  assert.equal(state.turnPhase, 'play');
  assert.equal(p1.properties.brown.length, 1);
  assert.equal(p1.bank.length, 0);
  assert.equal(p2.bank.length, 1);
  assert.equal(G.buildDeck().filter(c => c.action === 'chud')[0].value, 4);
  assertHealthy(state);
});

test('Midnight Requisition cannot touch a complete set', () => {
  const state = game();
  property(state, state.players[1], 'brown'); property(state, state.players[1], 'brown');
  const target = state.players[1].properties.brown[0];
  give(state, state.players[0], c => c.action === 'midnight_requisition');
  assert.match(G.playAction(state, 'p1', 0, { targetId:'p2', targetCardId:target.id }).error, /complete set/);
  assertHealthy(state);
});

test('a colour zone never holds more than the set size (§3.5)', () => {
  const state = game();
  const p1 = state.players[0];
  property(state, p1, 'brown'); property(state, p1, 'brown');   // brown is size 2 → full
  const wild = give(state, p1, c => c.type === 'wild_property' && c.colors.includes('brown'));
  assert.match(G.playProperty(state, 'p1', 0, 'brown').error, /full set/);
  assert.equal(p1.properties.brown.length, 2);
  assert.equal(p1.hand.length, 1);

  // the same wild fits its other colour
  const other = wild.colors.find(c => c !== 'brown');
  assert.ok(G.playProperty(state, 'p1', 0, other).ok);
  assert.match(G.moveProperty(state, 'p1', wild.id, 'brown').error, /full set/);
  assertHealthy(state);
});

test('a player whose only cards are zero-value wilds must surrender them (§3.4)', () => {
  const state = game();
  const [p1, p2] = state.players;
  const wild = take(state, c => c.type === 'wild_property' && c.colors[0] === 'any');
  p2.properties.brown = [{ ...wild, placedColor:'brown' }];
  assert.equal(G.playerTotalValue(p2), 0);
  give(state, p1, c => c.action === 'finance_office');
  assert.ok(G.playAction(state, 'p1', 0, { targetId:'p2' }).ok);

  const empty = G.respondToAction(state, 'p2', 'accept');
  assert.equal(empty.needPayment, true, 'zero value is not the same as nothing to pay');
  assert.ok(G.respondToAction(state, 'p2', 'accept', [wild.id]).ok);
  assert.equal(p1.properties.brown.length, 1);
  assert.equal(Object.values(p2.properties).flat().length, 0);
  assert.equal(state.pendingAction, null);
  assertHealthy(state);
});

test('short payments are rejected unless everything is surrendered', () => {
  const state = game();
  const [p1, p2] = state.players;
  const one = bank(state, p2, 1);
  bank(state, p2, 4);
  give(state, p1, c => c.action === 'finance_office');
  assert.ok(G.playAction(state, 'p1', 0, { targetId:'p2' }).ok);
  const short = G.respondToAction(state, 'p2', 'accept', [one.id]);
  assert.match(short.error, /at least 5M/);
  assert.equal(p2.bank.length, 2);
  assert.ok(G.respondToAction(state, 'p2', 'accept', p2.bank.map(c => c.id)).ok);
  assert.equal(G.playerTotalValue(p1), 5);
  assertHealthy(state);
});

test('upgrades are payable and net worth equals payable value (§3.1b)', () => {
  const state = game();
  const p1 = state.players[0];
  property(state, p1, 'brown'); property(state, p1, 'brown');
  give(state, p1, c => c.action === 'upgrade');
  assert.ok(G.playAction(state, 'p1', 0, { targetColor:'brown' }).ok);
  assert.equal(G.playerUpgradeValue(p1), 3);
  assert.equal(G.playerTotalValue(p1), 5, 'the 2M of brown plus the 3M Upgrade');
  assert.equal(G.playerNetWorth(p1), 5);
  assert.equal(G.payableCards(p1).some(c => c.upgradeType === 'house'), true,
    'the Upgrade can now actually be handed over');
  const view = G.getPlayerView(state, 'p1').players[0];
  assert.equal(view.upgradeValue, 3);
  // The old HUD lie: netWorth counted the upgrade while payableValue did not.
  assert.equal(view.netWorth, view.payableValue);
  assert.equal(view.netWorth, 5);
  assertHealthy(state);
});

test('the table ends when the deck is dry and a full round changes no hand (§3.6)', () => {
  const state = game();
  const [p1, p2] = state.players;
  property(state, p1, 'brown'); property(state, p1, 'brown');   // one completed set
  p1.bank.push(...state.deck.splice(0));                        // empty the deck legally
  state.discardPile = [];
  state._handSnapshot = 0;
  assert.equal(state.deck.length, 0);

  assert.ok(G.endTurn(state, 'p1').ok);
  assert.equal(state.phase, 'playing');
  const done = G.endTurn(state, 'p2');
  assert.equal(done.stalemate, true);
  assert.equal(state.phase, 'finished');
  assert.equal(state.endReason, 'stalemate');
  assert.equal(state.winner, 'p1');
  assert.equal(events(state, 'stalemate').length, 1);
  assert.equal(G.getPlayerView(state, 'p2').endReason, 'stalemate');
  assertHealthy(state);
});

test('the game ends on points once the deck has been cycled too often', () => {
  const state = game(3);
  const [p1, p2] = state.players;
  property(state, p1, 'brown'); property(state, p1, 'brown');   // one set
  bank(state, p2, 10);                                          // richest, but no sets
  state.shuffleCount = G.DECK_CYCLE_LIMIT;

  const ended = G.endTurn(state, 'p1');
  assert.equal(ended.stalemate, true);
  assert.equal(state.phase, 'finished');
  assert.equal(state.endReason, 'stalemate');
  assert.equal(state.winner, 'p1', 'completed sets beat net worth');
  assert.equal(events(state, 'stalemate')[0].reason, 'deck_cycles');
  const view = G.getPlayerView(state, 'p1');
  assert.equal(view.deckCycle, G.DECK_CYCLE_LIMIT);
  assert.equal(view.deckCycleLimit, G.DECK_CYCLE_LIMIT);
  assertHealthy(state);
});

test('scoop unwinds every chain the scooper was part of', () => {
  const state = game(3);
  const [p1, p2, p3] = state.players;
  give(state, p1, c => c.action === 'roll_call');
  give(state, p2, c => c.action === 'opsec');
  bank(state, p3, 2);
  assert.ok(G.playAction(state, 'p1', 0, {}).ok);
  assert.ok(G.respondToAction(state, 'p2', 'opsec').ok);
  assert.ok(G.scoop(state, 'p2').ok);
  assert.equal(state.pendingAction.targets.length, 1);
  assert.deepEqual(G.pendingResponders(state), ['p3']);
  assert.ok(G.respondToAction(state, 'p3', 'accept', [p3.bank[0].id]).ok);
  assert.equal(state.pendingAction, null);
  assertHealthy(state);

  const sourceScoops = game(3);
  give(sourceScoops, sourceScoops.players[0], c => c.action === 'roll_call');
  assert.ok(G.playAction(sourceScoops, 'p1', 0, {}).ok);
  assert.ok(G.scoop(sourceScoops, 'p1').ok);
  assert.equal(sourceScoops.pendingAction, null);
  assertHealthy(sourceScoops);
});

test('duplicate and stale selections are rejected without mutation', () => {
  const state = game();
  const [p1, p2] = state.players;
  const one = bank(state, p2, 1);
  bank(state, p2, 10);
  give(state, p1, c => c.action === 'finance_office');
  assert.ok(G.playAction(state, 'p1', 0, { targetId:'p2' }).ok);
  const duplicate = G.respondToAction(state, 'p2', 'accept', [one.id, one.id]);
  assert.match(duplicate.error, /unique/);
  assert.deepEqual(p2.bank.map(c => c.value), [1, 10]);
  assert.equal(p1.bank.length, 0);
  assertHealthy(state);

  const swapState = game();
  const target = property(swapState, swapState.players[1], 'brown');
  give(swapState, swapState.players[0], c => c.action === 'tdy_orders');
  const before = swapState.players[0].hand.length;
  const invalidSwap = G.playAction(swapState, 'p1', 0, { targetId:'p2', myCardId:999, targetCardId:target.id });
  assert.match(invalidSwap.error, /no longer available/);
  assert.equal(swapState.players[0].hand.length, before);
  assertHealthy(swapState);
});

test('duplicate discards and post-win mutations are rejected', () => {
  const state = game();
  for (let i = 0; i < 9; i++) state.players[0].hand.push(state.deck.pop());
  const id = state.players[0].hand[0].id;
  assert.match(G.endTurn(state, 'p1', [id, id]).error, /unique/);
  assert.equal(state.players[0].hand.length, 9);
  assert.ok(G.endTurn(state, 'p1', state.players[0].hand.slice(0, 2).map(c => c.id)).ok);
  assert.equal(events(state, 'discard')[0].cards.length, 2);
  assertHealthy(state);

  state.phase = 'finished';
  state.winner = 'p1';
  assert.match(G.playAsMoney(state, 'p1', 0).error, /finished/);
  assert.equal(state.players[0].bank.length, 0);
});

/* ── §3.10 final approach ────────────────────────────────────────────── */

// Gives `player` two complete sets plus one card of a third, and puts the card that
// completes the third set in their hand.
function armAt(state, player) {
  property(state, player, 'brown'); property(state, player, 'brown');
  property(state, player, 'darkblue'); property(state, player, 'darkblue');
  property(state, player, 'intel');
  give(state, player, c => c.type === 'property' && c.color === 'intel');
}

test('the third set arms a final approach instead of winning', () => {
  const state = game();
  const p1 = state.players[0];
  armAt(state, p1);
  assert.ok(G.playProperty(state, 'p1', 0).ok);

  assert.equal(state.phase, 'playing', 'three sets does not win on the spot');
  assert.equal(state.winner, null);
  assert.equal(p1.finalApproach, true);
  assert.deepEqual(G.armedPlayers(state), ['p1']);
  assert.equal(events(state, 'final_approach').length, 1);
  assert.deepEqual(
    { actor: events(state, 'final_approach')[0].actor, sets: events(state, 'final_approach')[0].sets },
    { actor:'p1', sets:3 });
  assert.equal(events(state, 'win').length, 0);

  const view = G.getPlayerView(state, 'p2');
  assert.deepEqual(view.armedIds, ['p1']);
  assert.equal(view.players[0].finalApproach, true);
  assert.equal(view.players[1].finalApproach, false);
  assertHealthy(state);
});

test('an armed player wins when their own next turn begins', () => {
  const state = game(3);
  const p1 = state.players[0];
  armAt(state, p1);
  assert.ok(G.playProperty(state, 'p1', 0).ok);

  assert.ok(G.endTurn(state, 'p1').ok);
  assert.equal(state.phase, 'playing');
  assert.equal(G.currentPlayer(state).id, 'p2');
  assert.ok(G.endTurn(state, 'p2').ok);
  assert.equal(state.phase, 'playing', 'every other player gets exactly one turn');
  assert.equal(G.currentPlayer(state).id, 'p3');

  const closing = G.endTurn(state, 'p3');
  assert.equal(closing.win, true);
  assert.equal(events(state, 'final_approach')[0].onOwnTurn, true);
  assert.equal(events(state, 'final_approach')[0].turnsToCheckpoint, 3);
  assert.equal(state.phase, 'finished');
  assert.equal(state.winner, 'p1');
  assert.equal(state.endReason, 'sets');
  assert.equal(events(state, 'win').length, 1);
  assert.equal(events(state, 'win')[0].sets, 3);
  // turn_start fires before the win so the client can stage the moment
  const tail = state.events.slice(-2).map(e => e.t);
  assert.deepEqual(tail, ['turn_start', 'win']);
  assert.equal(state.events.at(-2).finalApproach, true);
  assertHealthy(state);
});

test('arming on the seat before you does not convert at your very next turn', () => {
  const state = game(3);
  const [p1, , p3] = state.players;
  property(state, p1, 'brown'); property(state, p1, 'brown');
  property(state, p1, 'darkblue'); property(state, p1, 'darkblue');
  property(state, p1, 'intel');
  const spare = property(state, p1, 'green');       // the card p3 will take in the swap
  const theirIntel = property(state, p3, 'intel');  // the card that completes p1's third set

  // p3 (the seat immediately before p1) hands the completing card over on their own turn
  state.currentPlayerIndex = 2;
  state.turnPhase = 'play';
  state.playsRemaining = 3;
  give(state, p3, c => c.action === 'tdy_orders');
  assert.ok(G.playAction(state, 'p3', 0, {
    targetId:'p1', myCardId:theirIntel.id, targetCardId:spare.id }).ok);
  assert.ok(G.respondToAction(state, 'p1', 'accept').ok);

  assert.equal(p1.finalApproach, true);
  assert.equal(events(state, 'final_approach')[0].onOwnTurn, false);
  assert.equal(G.getPlayerView(state, 'p1').players[0].finalApproachIn, 3);

  // p1's own turn starts one turn later — nobody has had a chance to answer yet
  assert.ok(G.endTurn(state, 'p3').ok);
  assert.equal(G.currentPlayer(state).id, 'p1');
  assert.equal(state.phase, 'playing', 'a full cycle has not passed');
  assert.equal(G.getPlayerView(state, 'p1').players[0].finalApproachIn, 2);

  // a full cycle later it converts
  assert.ok(G.endTurn(state, 'p1').ok);
  assert.ok(G.endTurn(state, 'p2').ok);
  assert.equal(state.phase, 'playing');
  assert.equal(G.endTurn(state, 'p3').win, true);
  assert.equal(state.winner, 'p1');
  assertHealthy(state);
});

test('breaking the third set disarms, and rebuilding re-arms', () => {
  const state = game();
  const [p1, p2] = state.players;
  armAt(state, p1);
  assert.ok(G.playProperty(state, 'p1', 0).ok);
  assert.equal(p1.finalApproach, true);
  assert.ok(G.endTurn(state, 'p1').ok);
  state.turnPhase = 'play';

  // p2 CHUDs a card straight out of a complete set
  const victimCard = p1.properties.intel[0];
  give(state, p2, c => c.action === 'chud');
  assert.ok(G.playAction(state, 'p2', 0, { targetId:'p1', targetCardId:victimCard.id }).ok);
  assert.ok(G.respondToAction(state, 'p1', 'accept').ok);

  assert.equal(p1.finalApproach, false);
  assert.deepEqual(G.armedPlayers(state), []);
  const broken = events(state, 'final_approach_broken');
  assert.equal(broken.length, 1);
  assert.deepEqual({ actor: broken[0].actor, by: broken[0].by }, { actor:'p1', by:'p2' });

  // p1 survives to their turn and does NOT win
  assert.ok(G.endTurn(state, 'p2').ok);
  assert.equal(state.phase, 'playing');
  assert.equal(G.currentPlayer(state).id, 'p1');

  // rebuild the set with a wild → arms again
  state.turnPhase = 'play';
  state.playsRemaining = 3;
  const rebuild = give(state, p1, c => c.type === 'wild_property' && c.colors.includes('intel'));
  const idx = p1.hand.findIndex(c => c.id === rebuild.id);
  assert.ok(G.playProperty(state, 'p1', idx, 'intel').ok);
  assert.equal(p1.finalApproach, true);
  assert.equal(events(state, 'final_approach').length, 2, 're-arming fires the event again');
  assert.equal(state.phase, 'playing');
  assert.equal(G.getPlayerView(state, 'p1').players[0].finalApproachIn, 2,
    're-arming restarts the full grace cycle');
  assertHealthy(state);
});

test('a self-inflicted break reports no breaker', () => {
  const state = game();
  const p1 = state.players[0];
  armAt(state, p1);
  assert.ok(G.playProperty(state, 'p1', 0).ok);
  const wildIdx = state.deck.findIndex(c => c.type === 'wild_property' && c.colors.includes('brown'));
  const wild = state.deck.splice(wildIdx, 1)[0];
  state.deck.push(p1.properties.brown.pop());
  p1.properties.brown.push({ ...wild, placedColor:'brown' });
  assert.equal(G.completedSets(p1), 3);

  const other = wild.colors.find(c => c !== 'brown');
  assert.ok(G.moveProperty(state, 'p1', wild.id, other).ok);
  assert.equal(p1.finalApproach, false);
  const broken = events(state, 'final_approach_broken').at(-1);
  assert.equal(broken.by, null);
  assertHealthy(state);
});

test('a payment that completes a third set arms the payee, it never wins mid-turn', () => {
  const state = game();
  const [p1, p2] = state.players;
  property(state, p2, 'brown'); property(state, p2, 'brown');
  property(state, p2, 'darkblue'); property(state, p2, 'darkblue');
  property(state, p2, 'intel');
  const owed = property(state, p1, 'intel');       // p1 will hand this over
  give(state, p2, c => c.action === 'finance_office');
  state.currentPlayerIndex = 1;

  assert.ok(G.playAction(state, 'p2', 0, { targetId:'p1' }).ok);
  assert.ok(G.respondToAction(state, 'p1', 'accept', [owed.id]).ok);

  assert.equal(state.phase, 'playing', 'win-on-opponent-turn is gone');
  assert.equal(p2.finalApproach, true);
  assert.equal(G.completedSets(p2), 3);
  assert.equal(events(state, 'win').length, 0);
  assertHealthy(state);
});

test('two armed players race: the first to reach their own turn wins', () => {
  const state = game(3);
  const [, p2, p3] = state.players;

  // p2: brown + darkblue complete, one intel down and the second in hand
  property(state, p2, 'brown'); property(state, p2, 'brown');
  property(state, p2, 'darkblue'); property(state, p2, 'darkblue');
  property(state, p2, 'intel');
  give(state, p2, c => c.type === 'property' && c.color === 'intel');

  // p3: lightblue + orange complete, two pink down and the third in hand
  for (let i = 0; i < 3; i++) property(state, p3, 'lightblue');
  for (let i = 0; i < 3; i++) property(state, p3, 'orange');
  property(state, p3, 'pink'); property(state, p3, 'pink');
  give(state, p3, c => c.type === 'property' && c.color === 'pink');

  state.currentPlayerIndex = 1;
  state.turnPhase = 'play';
  state.playsRemaining = 3;
  assert.ok(G.playProperty(state, 'p2', 0).ok);
  assert.equal(p2.finalApproach, true);
  assert.ok(G.endTurn(state, 'p2').ok);

  state.turnPhase = 'play';
  assert.ok(G.playProperty(state, 'p3', 0).ok);
  assert.equal(p3.finalApproach, true);
  assert.deepEqual(G.armedPlayers(state), ['p2', 'p3']);

  assert.ok(G.endTurn(state, 'p3').ok);
  assert.equal(state.phase, 'playing');
  assert.equal(G.endTurn(state, 'p1').win, true);
  assert.equal(state.winner, 'p2', 'p2 reached their checkpoint one seat earlier');
  assertHealthy(state);
});

test('scooping while armed clears the approach and never wins', () => {
  const state = game(3);
  const p1 = state.players[0];
  armAt(state, p1);
  assert.ok(G.playProperty(state, 'p1', 0).ok);
  assert.equal(p1.finalApproach, true);

  assert.ok(G.scoop(state, 'p1').ok);
  assert.equal(p1.finalApproach, false);
  assert.equal(state.phase, 'playing');
  assert.equal(state.winner, null);
  assert.equal(events(state, 'final_approach_broken').at(-1).by, null);
  assert.deepEqual(G.armedPlayers(state), []);
  assertHealthy(state);
});

test('a scoop-out still ends the game immediately', () => {
  const state = game();
  assert.ok(G.scoop(state, 'p2').ok);
  assert.equal(state.phase, 'finished');
  assert.equal(state.winner, 'p1');
  assert.equal(state.endReason, 'last_standing');
  assert.equal(events(state, 'win')[0].reason, 'last_standing');
  assertHealthy(state);
});
