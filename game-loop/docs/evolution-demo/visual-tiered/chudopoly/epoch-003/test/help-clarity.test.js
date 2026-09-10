// Clarity gates for the copy fixes proven in the P-round Clarity review.
//
// Same shape as test/ui-contract.test.js's behavioural gates: every claim is
// driven out of the ENGINE first, so a rules change breaks the gate from the
// engine side whatever the copy says, and the source assertions that remain are
// anchored to a fact this file has just proved.
//
// The four findings pinned here:
//   1. the help said wild rearranging was "Free, unlimited" while game.js
//      moveProperty() enforces REARRANGE_BUDGET = 12 per turn (SWAP_COST = 2);
//   2. §3.10b contested-approach shipped four modes and getPlayerView's
//      contested/contestLaps/contestBar with ZERO client readers — under
//      'escalate' the win bar rises to setsToWin + 1 and every surface said 3;
//   3. the help Cards page printed the STOCK deck's ACTION_COUNTS under any
//      custom deck, including the shipped MD Faithful preset (chud: 0);
//   4. the defender's OPSEC decision for a swap/steal never named the card at
//      stake, though startPending ships targetCardId/myCardId on every one.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

const game = require('../game.js');
const read = (file) => readFileSync(join(__dirname, '..', file), 'utf8');
const load = (mod) => import(pathToFileURL(join(__dirname, '..', mod)).href);

const prop = (id, color, name, value = 4) => ({ id, type: 'property', name, color, value });

/** Three complete 2-card sets — the smallest armed board. Ids offset per seat. */
function armBoard(player, base) {
  player.properties = {
    darkblue: [prop(base + 1, 'darkblue', 'HQ'), prop(base + 2, 'darkblue', 'Pentagon')],
    intel: [prop(base + 3, 'intel', 'SIGINT'), prop(base + 4, 'intel', 'HUMINT')],
    brown: [prop(base + 5, 'brown', 'MQ-9'), prop(base + 6, 'brown', 'RQ-4')],
  };
  player.finalApproach = true;
  player.armedAtTurn = 0;
}

test('the rearrange copy states the budget the engine enforces, from one mirror', async () => {
  // The engine's numbers, driven not remembered: the budget is real, a swap
  // draws two, and the refusal copy is the sentence the help must not contradict.
  const state = game.createGame(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { seed: 'budget' });
  assert.equal(state.rearrangesRemaining, game.REARRANGE_BUDGET);
  const view = game.getPlayerView(state, 'a');
  assert.equal(view.rearrangeBudget, game.REARRANGE_BUDGET,
    'the budget is on the wire — the help reads the snapshot first, the mirror second');

  // The client mirror the help and canSwap() both quote.
  const cards = await load('public/src/core/cards.js');
  assert.equal(cards.REARRANGE_BUDGET, game.REARRANGE_BUDGET,
    'core/cards.js REARRANGE_BUDGET must equal game.js (347)');
  assert.equal(cards.SWAP_COST, game.SWAP_COST,
    'core/cards.js SWAP_COST must equal game.js (352)');
  const selectors = await load('public/src/state/selectors.js');
  assert.equal(selectors.SWAP_COST, cards.SWAP_COST,
    'state/selectors.js must re-export the same mirror, not carry a second literal');

  // The disproved claim must not return, on either page that carried it.
  const help = read('public/src/ui/help.js');
  assert.doesNotMatch(help, /Free, unlimited/,
    'moveProperty() refuses the 13th accepted move of a turn (game.js:1987-1989)');
  assert.doesNotMatch(help, /as often as you like/,
    'same claim in the Controls page drag row — same engine refusal');
  // And the truth must be stated from the shared numbers, never a literal.
  assert.match(help, /rearrangeBudget\(\)/,
    'the help must print the snapshot budget (getPlayerView rearrangeBudget, 2395)');
  assert.match(help, /SWAP_COST/,
    'a swap counts as two of the allowance — the help must say so from the mirror');
  assert.match(help, /resets when your next turn starts|allowance resets/,
    'beginTurn() refills the budget; the reset is half the rule');
});

test('§3.10b escalate raises contestBar and the client surfaces read it', async () => {
  // Drive the engine into a real contest: two armed seats under 'escalate'.
  const state = game.createGame(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    { seed: 'contest', suddenDeath: 'escalate' });
  armBoard(game.getPlayer(state, 'a'), 100);
  armBoard(game.getPlayer(state, 'b'), 200);
  state.currentPlayerIndex = state.players.findIndex(p => p.id === 'c');
  game.forceEndTurn(state);                       // beginTurn → syncContest
  assert.equal(state.phase, 'playing', 'a contested approach must not convert');

  const view = game.getPlayerView(state, 'c');
  assert.equal(view.contested, true, 'two armed seats open a contest (syncContest)');
  assert.equal(view.rules.suddenDeath, 'escalate');
  assert.equal(view.setsToWin, 3);
  assert.equal(view.contestBar, 4,
    'under escalate the bar is setsToWin + 1 while the contest is live (contestBar, 807-813) '
    + '— "the HUD must never tell a player they need three when they need four"');
  assert.ok(view.armedIds.includes('a') && view.armedIds.includes('b'),
    'both seats stay armed — 3 sets against a bar of 4, which is why armedIds must be read');

  // Off, for contrast: the same board under the default never opens a contest.
  const off = game.createGame(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    { seed: 'contest-off' });
  armBoard(game.getPlayer(off, 'a'), 100);
  armBoard(game.getPlayer(off, 'b'), 200);
  off.currentPlayerIndex = off.players.findIndex(p => p.id === 'c');
  game.forceEndTurn(off);
  const offView = game.getPlayerView(off, 'c');
  assert.equal(offView.contested, false);
  assert.equal(offView.contestBar, offView.setsToWin, 'the bar only moves under escalate');

  // The readers. ui/ modules import DOM helpers, so these are source gates —
  // the same style ui-contract.test.js uses for every ui/ file.
  const prompt = read('public/src/ui/prompt.js');
  assert.match(prompt, /snap\.contestBar/,
    'the prompt bar\'s "N sets" chip must read contestBar, or it lies under escalate');
  assert.match(prompt, /snap\.armedIds/,
    'and ARMED must come from armedIds — an armed seat can sit below a raised bar');
  const hud = read('public/src/ui/hud.js');
  assert.match(hud, /snap\.contested/, 'the HUD strip must know a contest is open');
  assert.match(hud, /snap\.contestBar/, 'and print the bar the engine ships, never a constant');
  assert.match(hud, /SUDDEN_DEATH_COPY/,
    'the chip\'s explanation must be ruleset.js\'s one copy of the mode sentence');
  const help = read('public/src/ui/help.js');
  assert.match(help, /SUDDEN_DEATH_COPY/,
    'the help Goal page must state the active mode from the same one copy');
  assert.match(help, /suddenDeath && active\.suddenDeath !== 'off'/,
    'and only when the table actually runs one — all presets ship off');
});

test('the help Cards page counts follow the deck this game is played with', async () => {
  // MD Faithful is the shipped preset that made the stock counts a lie:
  // chud 0, wildPairs 9, still 106.
  const state = game.createGame(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { seed: 'md', preset: 'mdFaithful' });
  const view = game.getPlayerView(state, 'a');
  assert.equal(view.rules.deck.chud, 0, 'MD Faithful ships no CHUD card');

  // totalsFor(rules.deck) must agree with the deck buildDeck() actually builds.
  const { totalsFor } = await load('public/src/ui/deckcensus.js');
  const totals = totalsFor(view.rules.deck);
  const actual = new Map();
  for (const card of game.buildDeck(view.rules.deck)) {
    if (card.type !== 'action') continue;
    actual.set(card.action, (actual.get(card.action) || 0) + 1);
  }
  for (const action of Object.keys(view.rules.deck)) {
    if (action.startsWith('wild')) continue;
    assert.equal(totals.get(`act:${action}`) || 0, actual.get(action) || 0,
      `totalsFor disagrees with buildDeck on ${action}`);
  }
  assert.equal(totals.get('act:chud'), 0, 'the census holds zero CHUD under MD Faithful');

  // The page must draw from that resolver, not the frozen stock mirror.
  const help = read('public/src/ui/help.js');
  assert.match(help, /totalsFor\(active\.deck\)/,
    'pageCards must resolve counts through ui/deckcensus.js totalsFor()');
  assert.doesNotMatch(help, /count: ACTION_COUNTS\[action\]/,
    'the frozen stock count must not be printed under a custom deck again');
  assert.match(help, /Not in this table's deck/,
    'a kind the deck holds zero of is named as absent, not listed at ×0');
  assert.match(help, /'edited deck'/,
    'ruleBadge must flag a non-stock deck, so the badge and the counts agree');
});

test('the defender\'s swap/steal decision names the cards at stake', () => {
  // The wire carries the ids: drive a TDY swap and a CHUD steal and read them.
  const mk = () => {
    const state = game.createGame(
      [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { seed: 'name' });
    const a = game.getPlayer(state, 'a');
    const b = game.getPlayer(state, 'b');
    for (const p of [a, b]) { p.hand = []; p.properties = {}; }
    a.properties.red = [prop(1, 'red', 'F-22')];
    b.properties.green = [prop(2, 'green', 'Red Flag')];
    state.currentPlayerIndex = 0;
    state.turnPhase = 'play';
    state.playsRemaining = 3;
    return { state, a };
  };

  const swap = mk();
  swap.a.hand = [{ id: 90, type: 'action', action: 'tdy_orders', name: 'TDY Orders', value: 3 }];
  assert.ok(game.playAction(swap.state, 'a', 0, { targetId: 'b', targetCardId: 2, myCardId: 1 }).ok);
  const swapPa = game.getPlayerView(swap.state, 'b').pendingAction;
  assert.equal(swapPa.type, 'swap');
  assert.equal(swapPa.targetCardId, 2, 'the defender\'s card at stake is on the wire (1532-1536)');
  assert.equal(swapPa.myCardId, 1, 'and so is the attacker\'s side of the trade');

  const steal = mk();
  steal.a.hand = [{ id: 91, type: 'action', action: 'chud', name: 'THE CHUD CARD', value: 4 }];
  assert.ok(game.playAction(steal.state, 'a', 0, { targetId: 'b', targetCardId: 2 }).ok);
  const stealPa = game.getPlayerView(steal.state, 'b').pendingAction;
  assert.equal(stealPa.type, 'steal_property');
  assert.equal(stealPa.targetCardId, 2, 'the stolen card\'s id is on the wire (1588-1592)');

  // The bar must read both ids and resolve them to names.
  const prompt = read('public/src/ui/prompt.js');
  assert.match(prompt, /pa\.targetCardId/,
    'describePending must name the card a steal or swap takes');
  assert.match(prompt, /pa\.myCardId/,
    'and the card a swap gives back — "wants to swap properties" named neither');
  assert.match(prompt, /wants your .*for their/,
    'the swap sentence carries both sides');
  // XSS discipline: names go through the item text (setText → textContent);
  // no markup may be built around them.
  assert.doesNotMatch(prompt, /innerHTML/, 'no interpolated markup in the bar (§0.10)');
});

test('scoop timing, the clocks, and the full-zone note are stated', () => {
  // Scoop: any time while playing — scoop() (game.js:2173) checks phase and
  // seat only. Proved off-turn and with a demand pending.
  const state = game.createGame(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], { seed: 'scoop' });
  const b = game.getPlayer(state, 'b');
  state.currentPlayerIndex = 0;
  state.turnPhase = 'play';
  state.playsRemaining = 3;
  const a = game.getPlayer(state, 'a');
  a.hand = [{ id: 90, type: 'action', action: 'finance_office', name: 'FO', value: 3 }];
  assert.ok(game.playAction(state, 'a', 0, { targetId: 'b' }).ok);
  assert.ok(state.pendingAction, 'a demand is pointed at b');
  assert.deepEqual(game.scoop(state, 'b').ok, true,
    'scooping is legal off-turn, even with a demand pending — it unwinds the demand');
  assert.equal(b.eliminated, true);

  const help = read('public/src/ui/help.js');
  assert.match(help, /scoop at any moment/i,
    'the help must state WHEN scooping is legal, not only what it costs');
  assert.match(help, /turn clock|answer clock/,
    'the Turn page must state the clocks and their consequences (server/timers.js)');
  assert.match(help, /cheapest cards first/,
    'auto-accept pays cheapest-first (autoPickPayment, server/timers.js:274-315)');

  const details = read('public/src/ui/details.js');
  assert.match(details, /no room for this card/,
    'a full zone among a hand wild\'s counts-as rows must say it cannot take the card');
});

/* ── P-round 3 CLARITY: the break-list and the TDY copy on a CHUD-less deck ─
 *
 * breakBullets() taught "THE CHUD CARD — the only card that can pull ONE card
 * out of a set" unconditionally, including under the shipped MD Faithful preset
 * (chud: 0) — while the same brief's Cards page correctly said "Not in this
 * table's deck: THE CHUD CARD". Same class, smaller: ACTION_RULES.tdy_orders
 * ended "…which is what separates it from CHUD", a comparison to a card the
 * table may not contain. */
test('the Goal page break-list follows the deck, and the TDY copy stops naming CHUD', async () => {
  // Engine half: under MD Faithful the game genuinely deals no CHUD card.
  const state = game.createGame(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { seed: 'nochud', preset: 'mdFaithful' });
  const view = game.getPlayerView(state, 'a');
  assert.equal(view.rules.deck.chud, 0, 'MD Faithful ships chud: 0');
  const dealt = game.buildDeck(view.rules.deck);
  assert.equal(dealt.some(c => c.action === 'chud'), false,
    'buildDeck honours the count — no CHUD card exists in this game');
  const { totalsFor } = await load('public/src/ui/deckcensus.js');
  assert.equal(totalsFor(view.rules.deck).get('act:chud'), 0,
    'the census resolver the help must consult agrees');

  // Renderer half (help.js imports DOM helpers → source gates, ui-contract style).
  const help = read('public/src/ui/help.js');
  const body = /function breakBullets\(active\)[\s\S]*?\n\}/.exec(help);
  assert.ok(body, 'breakBullets must take the ACTIVE rules — with no argument it '
    + 'cannot know which deck it is describing');
  assert.match(body[0], /totalsFor\(active\.deck\)/,
    'the break-list must filter through the same resolver pageCards uses');
  assert.match(body[0], /'chud'/,
    'and the CHUD bullet must be conditional on the deck holding one');
  assert.doesNotMatch(help, /breakBullets\(\)/,
    'no call site may ask for the list without saying whose deck it is');
  assert.match(body[0], /Not in this table's deck/,
    'an absent break card is NAMED absent (the Cards page policy), not silently dropped');

  // core/cards.js is dependency-free and loads: the card copy itself.
  const cards = await load('public/src/core/cards.js');
  assert.doesNotMatch(cards.ACTION_RULES.tdy_orders, /CHUD/,
    'the TDY rule text must not define itself against a card the deck may hold zero of');
  assert.match(cards.ACTION_RULES.tdy_orders, /give a card back/,
    'the fact the comparison carried — a trade, never a one-way take — must survive the cut');
});
