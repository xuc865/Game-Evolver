// Clarity gates for the round-2 UI-CLARITY findings.
//
// Same shape as test/help-clarity.test.js: every claim is driven out of the
// ENGINE first, so a rules change breaks the gate from the engine side whatever
// the copy says, and the source assertions that remain are anchored to a fact
// this file has just proved. ui/ modules import DOM helpers, so the renderer
// halves are source gates — the ui-contract style.
//
// The six findings pinned here:
//   1. details.js propertyContext() read selfPlayer() under an OPPONENT's table
//      card — hovering Coyote's wild in Coyote's complete 2/2 set printed
//      "Drone Ops 0/2 · rent 0M" (the viewer's empty zone), unattributed;
//   2. the 'escalate' contest copy said "pull ahead or nobody converts" while
//      contestBar()/contestBlocks() drop the bar back at CONTEST_LAP_CAP laps
//      and let turn order resolve the still-open contest;
//   3. feed grammar: "completed Drone Ops — 1 sets", and "hold 3 sets for 2
//      more turns" counting OPPONENT turns without saying whose;
//   4. game.js:408 Surge Ops wire text still said "rent or any demand" (the
//      pre-reversal rule), and the mergeUpgrades() comment said surplus goes
//      "to the discard pile" while the code banks it;
//   5. two unstated edge rules for the help Sets page: a duplicate Upgrade
//      arriving with a seized set is banked to the thief, and under
//      pureSetRequired a full all-wild zone IS stealable;
//   6. Escape did not close the comms drawer (#side) — §0.9.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

const game = require('../game.js');
const read = (file) => readFileSync(join(__dirname, '..', file), 'utf8');
const load = (mod) => import(pathToFileURL(join(__dirname, '..', mod)).href);

const prop = (id, color, name, value = 4) => ({ id, type: 'property', name, color, value });
const wild = (id, color) => ({
  id, type: 'wild_property', name: 'Wild Property', colors: ['any'], value: 0,
  placedColor: color,
});
const upgradeCard = (id, kind, color) => ({
  id, type: 'action', action: kind === 'hotel' ? 'foc' : 'upgrade',
  name: kind === 'hotel' ? 'Full Operational Capability' : 'Upgrade',
  value: kind === 'hotel' ? 4 : 3, upgradeType: kind, placedColor: color,
});

/** A bare two/three-seat playing state with `build(a, b)` applied. */
function fixture(build, { who = 'a', preset, suddenDeath } = {}) {
  const opts = { seed: 'clarity2' };
  if (preset) opts.preset = preset;
  if (suddenDeath) opts.suddenDeath = suddenDeath;
  const state = game.createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], opts);
  const a = game.getPlayer(state, 'a');
  const b = game.getPlayer(state, 'b');
  for (const p of [a, b]) { p.hand = []; p.bank = []; p.properties = {}; p.upgrades = {}; }
  build(a, b);
  state.currentPlayerIndex = state.players.findIndex(p => p.id === who);
  state.turnPhase = 'play';
  state.playsRemaining = 3;
  state.pendingAction = null;
  return { state, a, b };
}

/* ── 1: the details/peek context is attributed to the card's OWNER ──────── */

test('an opponent\'s table card carries the OWNER\'s zone data on the wire, and details.js attributes it', () => {
  // Engine half: getPlayerView ships every seat's board with real ids, so the
  // client CAN resolve a table card to its owner — the fix has data to stand on.
  const { state } = fixture((a, b) => {
    b.properties.brown = [wild(30, 'brown'), wild(36, 'brown')];   // Coyote's 2/2, all wilds
  });
  const view = game.getPlayerView(state, 'a');
  const owner = view.players.find(p => p.id === 'b');
  assert.deepEqual(owner.properties.brown.map(c => c.id), [30, 36],
    'the opponent board is on the viewer\'s snapshot, ids intact');
  assert.equal(owner.properties.brown[0].placedColor, 'brown',
    'placedColor travels, so the owner\'s zone is resolvable from the card alone');
  assert.equal(game.isSetComplete(game.getPlayer(state, 'b'), 'brown'), true,
    'the staged zone is COMPLETE for the owner — the state the old rows lied about');

  // Renderer half (details.js imports DOM helpers, so: source gates).
  const details = read('public/src/ui/details.js');
  assert.match(details, /function boardOwner\(/,
    'propertyContext must resolve the card\'s OWNER from the snapshot');
  assert.match(details, /\$\{theirs\.name\}'s \$\{colorName\(c\)\}/,
    'an opponent\'s zone row must be attributed by name ("Coyote\'s Drone Ops")');
  assert.match(details, /`your \$\{colorName\(c\)\}`/,
    'and the viewer\'s own zone must be attributed too — the steal/TDY landing question');
  // The old shape, kept out by name: rows built from selfPlayer() only.
  assert.match(details, /zoneRow\(owner, c/,
    'the primary row must be computed from the OWNER, not from selfPlayer()');
});

/* ── 2: the escalate copy states the lap-cap fallback ───────────────────── */

test('escalate: the bar lapses at CONTEST_LAP_CAP and turn order decides — and the copy says so', async () => {
  // Engine truth, driven: bar up while contested and inside the cap, back down
  // at the cap with the contest STILL OPEN, and the checkpoint unblocked.
  const players = [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }, { id: 'p3', name: 'C' }];
  const state = game.createGame(players, { suddenDeath: 'escalate', seed: 'lapse' });
  state.players[0].finalApproach = true;
  state.players[1].finalApproach = true;
  state.turnCounter = 10;
  game.syncContest(state);
  assert.equal(game.contestOpen(state), true);
  assert.equal(game.contestBar(state), game.setsToWinOf(state) + 1,
    'inside the cap the bar is one higher (contestBar, game.js:809-814)');
  assert.ok(game.contestBlocks(state, state.players[0]),
    'and the checkpoint is suspended (contestBlocks, game.js:820-838)');

  state.turnCounter = 10 + 3 * game.CONTEST_LAP_CAP;      // cap reached, 3 active seats
  assert.equal(game.contestOpen(state), true, 'the contest is STILL open');
  assert.equal(game.contestBar(state), game.setsToWinOf(state),
    'at the cap the bar drops back — "nobody converts" was never the rule');
  assert.equal(game.contestBlocks(state, state.players[0]), null,
    'and contestBlocks() stands aside, so turn order resolves the live contest');

  // The copy, pinned to that behaviour. "Two full rounds" is CONTEST_LAP_CAP in
  // words — if the constant moves, this is the sentence that must move with it.
  assert.equal(game.CONTEST_LAP_CAP, 2,
    'the ruleset.js/help.js escalate copy says "two full rounds" — update it with this constant');
  const { SUDDEN_DEATH_COPY } = await load('public/src/ui/ruleset.js');
  const esc = SUDDEN_DEATH_COPY.escalate.line;
  assert.doesNotMatch(esc, /nobody converts/,
    'the escalate line must not deny the lap-cap fallback');
  assert.match(esc, /two full rounds/, 'the cap is part of the rule');
  assert.match(esc, /turn order decides/, 'and so is what happens after it');
  // 'points' genuinely never converts by turn order (contestBlocks returns a
  // block until endTurn ends the game on §3.6) and 'oneLap' serves one lap —
  // both lines must stay accurate while escalate changes.
  assert.match(SUDDEN_DEATH_COPY.points.line, /never converts/);
  assert.match(SUDDEN_DEATH_COPY.oneLap.line, /one full round, then turn order decides/);

  const help = read('public/src/ui/help.js');
  assert.doesNotMatch(help, /While the contest is live, converting takes/,
    'the Goal page claimed the raised bar for the WHOLE contest');
  assert.match(help, /drops back to \$\{n\}/,
    'the Goal page must state that the raised bar lapses back to the base count');
});

/* ── 3: feed grammar on the race lines ──────────────────────────────────── */

test('the feed pluralises set counts and says WHOSE turns the approach clock counts', () => {
  // Engine half: final_approach's number is opponentTurnsRemaining — turns by
  // OTHER players (game.js opponentTurnsRemaining) — so a line that just says
  // "turns" invites the own-turns misreading.
  const { state, a } = fixture((pa) => {
    pa.properties.darkblue = [prop(1, 'darkblue', 'HQ'), prop(2, 'darkblue', 'Pentagon')];
    pa.properties.intel = [prop(3, 'intel', 'SIGINT'), prop(4, 'intel', 'HUMINT')];
    pa.properties.brown = [prop(5, 'brown', 'MQ-9')];
    pa.hand = [prop(6, 'brown', 'RQ-4')];
  }, { who: 'a' });
  assert.ok(game.playProperty(state, 'a', 0, 'brown').ok);
  const done = (state.events || []).find(ev => ev.t === 'set_completed' && ev.color === 'brown');
  assert.ok(done, 'completing the zone emits set_completed');
  assert.equal(typeof done.total, 'number', 'with the count the feed prints');
  const fa = (state.events || []).find(ev => ev.t === 'final_approach');
  assert.ok(fa, 'the third set arms the approach');
  assert.ok('opponentTurnsRemaining' in fa,
    'final_approach carries opponentTurnsRemaining — turns by OTHERS, not the reader');
  assert.equal(a.finalApproach, true);

  const feed = read('public/src/ui/feed.js');
  assert.doesNotMatch(feed, /\$\{ev\.total\} sets`/,
    '"— 1 sets" shipped on every first completed set; the noun must be declined');
  assert.match(feed, /set\$\{ev\.total === 1 \? '' : 's'\}/,
    'set_completed pluralises from the count');
  assert.match(feed, /more enemy turn/,
    'the armed player\'s line must say WHOSE turns the countdown counts');
  assert.doesNotMatch(feed, /more turns`/,
    'the unattributed form must not return');
});

/* ── 4: the wire text and the comment match the code ────────────────────── */

test('the Surge Ops wire description matches the engine (rent only, stacks)', () => {
  const surge = game.buildDeck().find(c => c.action === 'surge_ops');
  assert.ok(surge, 'the stock deck carries Surge Operations');
  assert.doesNotMatch(surge.description, /any demand/i,
    'chargeAmount() (game.js) passes surgeable:true from the RENT branch only — '
    + '"rent or any demand" is the pre-reversal rule');
  assert.match(surge.description, /rent only|only rent/i,
    'the one-liner must carry the rider ACTION_RULES carries');
  assert.match(surge.description, /stack/i, 'and that it stacks (§3.1c)');

  // The behavioural anchor: a demand is flat at any stack depth.
  const { state, a } = fixture((pa) => {
    pa.hand = [
      { id: 90, type: 'action', action: 'surge_ops', name: 'Surge Ops', value: 1 },
      { id: 91, type: 'action', action: 'finance_office', name: 'FO', value: 3 },
    ];
  }, { who: 'a' });
  assert.ok(game.playAction(state, 'a', 0, {}).ok);
  assert.ok(game.playAction(state, 'a', 0, { targetId: 'b' }).ok);
  assert.equal(state.pendingAction.amount, 5,
    'Finance Office charges 5M with a surge running — the old text said it doubled');
  assert.ok(a);

  // And the mergeUpgrades() comment must describe what the code does: BANK.
  const src = read('game.js');
  assert.doesNotMatch(src, /Surplus goes to the discard pile/,
    'the comment said discard while bankUpgradeCard() banks — §0.11 comments record facts');
  assert.match(src, /Surplus is BANKED to the seizing player/,
    'the corrected comment must name the real destination');
});

/* ── 5: the two unstated edge rules, proved then demanded of the copy ───── */

test('a duplicate Upgrade arriving with a seized set is banked to the THIEF', () => {
  // Thief 'a' already holds a house on intel; 'b' has a complete intel set
  // carrying house + hotel. Seize it: the incoming house is the duplicate.
  const { state, a, b } = fixture((pa, pb) => {
    pa.upgrades.intel = [upgradeCard(50, 'house', 'intel')];
    pb.properties.intel = [prop(60, 'intel', 'SIGINT'), prop(61, 'intel', 'HUMINT')];
    pb.upgrades.intel = [upgradeCard(62, 'house', 'intel'), upgradeCard(63, 'hotel', 'intel')];
  }, { who: 'a' });
  a.hand = [{ id: 70, type: 'action', action: 'inspector_general', name: 'IG', value: 5 }];
  assert.ok(game.playAction(state, 'a', 0, { targetId: 'b', targetColor: 'intel' }).ok);
  game.respondToAction(state, 'b', 'accept', []);

  assert.deepEqual(game.upgradeKinds(a, 'intel').sort(), ['hotel', 'house'].sort(),
    'the set carries one of each after the merge');
  assert.ok(a.bank.some(c => c.id === 62),
    'the duplicate house landed in the THIEF\'s bank (mergeUpgrades → bankUpgradeCard)');
  assert.equal(a.bank.find(c => c.id === 62).upgradeType, undefined,
    'stripped on the way out, so it is ordinary money');
  assert.equal(state.discardPile.some(c => c.id === 62), false, 'nothing was discarded');
  assert.equal(b.upgrades.intel, undefined, 'the victim keeps none of it');

  const help = read('public/src/ui/help.js');
  assert.match(help, /duplicate is banked to you/,
    'the Sets page must state where a seized duplicate Upgrade goes (§3.9)');
});

test('under pureSetRequired a full all-RAINBOW zone IS requisitionable — and the help says so', () => {
  const { state, b } = fixture((pa, pb) => {
    pa.hand = [{ id: 70, type: 'action', action: 'midnight_requisition', name: 'MR', value: 3 }];
    // RAINBOW wilds specifically (`colors: ['any']`). Narrowed 2026-08-08: a zone of
    // two-colour wilds IS a set even under pureSetRequired, so it would be protected.
    pb.properties.darkblue = [wild(30, 'darkblue'), wild(31, 'darkblue')];   // full, rainbows only
  }, { who: 'a', preset: 'mdFaithful' });
  assert.equal(game.zoneFull(b, 'darkblue'), true, 'the zone is FULL');
  assert.equal(game.isSetComplete(b, 'darkblue'), false,
    'and under pureSetRequired it is NOT a set (zoneIsSet)');
  assert.equal(game.zoneRequisitionable(b, 'darkblue'), true,
    'zoneRequisitionable() is completeness-based, so the full wild zone is fair game');
  assert.ok(game.playAction(state, 'a', 0, { targetId: 'b', targetCardId: 30 }).ok,
    'Midnight Requisition takes from it — the engine agrees with its own predicate');

  const help = read('public/src/ui/help.js');
  assert.match(help, /wilds is NOT a complete set/,
    'the Sets page must state the exposure (§3.9)');
  assert.match(help, /Midnight Requisition and TDY Orders can still take from it/,
    'and must name the two cards that can still take from it');
  assert.match(help, /active\.pureSetRequired \?/,
    'stated only when the toggle is on — on other tables the claim would be false');
});

/* ── 6: Escape closes the comms drawer (§0.9) ───────────────────────────── */

test('Escape reaches the comms drawer, at sheet priority, without stealing the interact cancel', () => {
  const hud = read('public/src/ui/hud.js');
  const block = /keydown[\s\S]{0,900}?setHidden\(side, true\)/.exec(hud);
  assert.ok(block, 'ui/hud.js must route Escape to close #side');
  assert.match(block[0], /'Escape'/, 'on the Escape key');
  assert.match(block[0], /side\.hidden/, 'only when the drawer is open');
  assert.match(block[0], /sheetOpen\(\)/,
    'a sheet stacked over the drawer takes the key first (ui/screens.js:171)');
  assert.match(block[0], /defaultPrevented/,
    'and when screens.js ran first on the same event, its preventDefault is the '
    + 'only remaining trace that the key was spent — without this guard one press '
    + 'closed the sheet AND the drawer under it (measured)');
  assert.match(block[0], /is-dragging/,
    'a live drag keeps the key for abortDrag() (interact/pointer.js:197)');
  assert.match(block[0], /mode\.kind !== 'idle'/,
    'an active interaction mode keeps the key for interact.cancel()');
  assert.match(block[0], /data-targetable|data-payable/,
    'the same glow guard table/layout.js:211 uses for the expanded seat');
  // §3.9: the help Controls page must state the new Escape target.
  assert.match(read('public/src/ui/help.js'), /comms drawer/,
    'no rule may exist that the help does not state');
});

/* ── 7 (round-3 CLARITY): a banked card's peek describes ITS OWNER'S bank ──
 *
 * Fixture evidence: mid-game.json card 94 (a rent card in Coyote's bank) peeked
 * with the VIEWER's rent table — "Bills every other player · Space Force (0/3)"
 * — and card 40 (money in Iceman's bank) printed "Your bank: NM". A banked card
 * is money wherever it sits; the peek must lead with whose bank and what it
 * counts as, not describe a rent the owner is not charging. */
test('a card in an opponent\'s bank peeks as THAT bank\'s money, not the viewer\'s board', () => {
  // Engine half: the snapshot ships every seat's bank with real ids, so the
  // client CAN resolve a banked card to its owner — the fix has data under it.
  const { state } = fixture((a, b) => {
    b.bank = [
      { id: 94, type: 'rent', name: 'Rent: pink/orange', value: 1, colors: ['pink', 'orange'] },
      { id: 40, type: 'money', name: '1M', value: 1 },
    ];
  });
  const view = game.getPlayerView(state, 'a');
  const owner = view.players.find(p => p.id === 'b');
  assert.deepEqual(owner.bank.map(c => c.id), [94, 40],
    'the opponent bank is on the viewer\'s snapshot, ids intact');
  assert.equal(owner.bankValue, 2, 'and its value is the sum the lead row can quote');

  // Renderer half (details.js imports DOM helpers → source gates).
  const details = read('public/src/ui/details.js');
  assert.match(details, /function bankOwner\(/,
    'the context must resolve a card to the BANK that holds it');
  assert.match(details, /const banked = bankOwner\(card\.id\)/,
    'and consult it BEFORE the per-type dispatch — a banked rent card must not '
    + 'reach rentContext() and describe the viewer\'s colours');
  assert.match(details, /In \$\{owner\.name\}'s bank/,
    'the lead row names whose bank ("In Coyote\'s bank")');
  assert.match(details, /counts as \$\{/,
    'and what the card counts as — money now, whatever the face says');
});

/* ── 8 (round-3 CLARITY): "1 plays" ──────────────────────────────────────── */
test('the HUD header declines its play counter', () => {
  const hud = read('public/src/ui/hud.js');
  assert.doesNotMatch(hud, /\$\{snap\.playsRemaining\} plays/,
    'hud.js:558 rendered "1 plays" — the strip\'s "1 play left" is already correct');
  assert.match(hud, /play\$\{snap\.playsRemaining === 1 \? '' : 's'\}/,
    'the counter must pluralise from the count');
});
