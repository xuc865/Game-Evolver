// test/deckconfig.test.js — §3 configurable deck composition and §3.10b contested approach.
//
// The two rules added 2026-08-07 that a lobby can change. Both are engine-owned and
// server-validated, so the assertions here are about three things and nothing else:
//   1. the DEFAULT is unchanged, byte for byte (a config knob that moves the shipped game
//      is not a config knob, it is a balance change wearing one);
//   2. no reachable configuration can produce a game that fails to end;
//   3. every MIRROR of these numbers — the client picker and the discard census — is the
//      engine's own answer rather than a copy that has started to drift.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

const G = require('../game');
const sim = require('../simulate');
const protocol = require('../server/protocol');

const loadRuleset = () => import(pathToFileURL(join(__dirname, '..', 'public/src/ui/ruleset.js')).href);
const loadCensus = () => import(pathToFileURL(join(__dirname, '..', 'public/src/ui/deckcensus.js')).href);

/* ── 1. the default deck did not move ─────────────────────────────────── */

test('buildDeck() with no argument is byte-identical to the deck before it took one', () => {
  // Not "still 106" — IDENTICAL, id for id, in order. A recorded game replays by seed, and
  // the seed only reproduces the shuffle; if buildDeck's emission order changed, every
  // recorded game in gamelog would silently replay as a different game. Compared against
  // git HEAD~1's own output rather than against a copy pasted into this file, because a
  // copy is exactly the thing that cannot detect its own staleness.
  let previous;
  try {
    previous = execFileSync('git', ['show', 'HEAD~1:game.js'], { encoding: 'utf8', cwd: join(__dirname, '..') });
  } catch {
    return; // shallow clone or first commit — nothing to compare against
  }
  if (!previous.includes('function buildDeck')) return;
  const module0 = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', previous)(module0, module0.exports, require);
  const before = module0.exports.buildDeck();
  if (before.length !== 106) return;   // HEAD~1 predates the 106-card deck entirely
  // Compared WITHOUT the `description` prose: replay identity is ids, types,
  // values and emission order — the seed reproduces the shuffle over those, and
  // the client renders core/cards.js ACTION_RULES over the wire text anyway.
  // Pinning the prose byte-for-byte froze every stale sentence in place: the
  // round-2 clarity pass corrected surge_ops's "rent or any demand" (game.js:408
  // still carried the pre-§3.1c rule) and this comparison was the only thing
  // holding the old sentence. test/ui-clarity2.test.js pins the corrected text.
  const bare = (cards) => cards.map(({ description, ...rest }) => rest);
  assert.deepEqual(bare(G.buildDeck()), bare(before),
    'the stock deck changed shape — every gamelog record that replays by seed is now wrong');
});

test('the fixed families are exactly DECK_FIXED, and the editable ones exactly DECK_BASE', () => {
  const deck = G.buildDeck();
  const fixed = deck.filter(c => c.type === 'property' || c.type === 'money' || c.type === 'rent');
  assert.equal(fixed.length, G.DECK_FIXED, 'property + money + rent is not the constant claimed');
  assert.equal(deck.length, 106);
  assert.equal(G.deckSize(G.DECK_BASE), 106);

  const counted = {};
  for (const c of deck) {
    if (c.type === 'action') counted[c.action] = (counted[c.action] || 0) + 1;
    else if (c.type === 'wild_property') {
      const k = c.colors[0] === 'any' ? 'wildAny' : 'wildPairs';
      counted[k] = (counted[k] || 0) + 1;
    }
  }
  assert.deepEqual(counted, { ...G.DECK_BASE },
    'DECK_BASE claims counts the deck does not actually contain');
});

test('a property count is NOT editable, and COLORS[c].size is why', () => {
  // The §3 brief's "exposing all 15 card types invites nonsense decks" made concrete: a
  // property count is simultaneously the zone cap and the completion test, so it is not a
  // free parameter. Asserted structurally rather than by comment.
  for (const kind of G.DECK_KINDS) {
    assert.ok(!G.COLORS[kind], `${kind} is a colour — property counts must not be editable`);
  }
  const deck = G.buildDeck();
  for (const [color, info] of Object.entries(G.COLORS)) {
    const n = deck.filter(c => c.type === 'property' && c.color === color).length;
    assert.equal(n, info.size,
      `${color} ships ${n} cards for a set of ${info.size} — the set would be uncompletable`);
  }
});

/* ── 2. mdFaithful is the official deck, checked against the published counts ── */

test('the mdFaithful preset IS the official Monopoly Deal playable deck, category for category', () => {
  // Official Monopoly Deal is 110 cards = 4 rule cards + 106 playable. Source:
  // monopolydealrules.com, cross-checked against Geeky Hobbies. (Some secondary lists give
  // Forced Deal 4 / Hotel 3, which sums the action deck to 36 rather than 34 and is wrong.)
  const OFFICIAL = {
    property: 28, wild_property: 11, rent: 13, money: 20,
    action: { inspector_general: 2, opsec: 3, midnight_requisition: 3, tdy_orders: 3,
      finance_office: 3, roll_call: 3, surge_ops: 2, upgrade: 3, foc: 2, pcs_orders: 10 },
  };
  const deck = G.buildDeck(G.RULE_PRESETS.mdFaithful.deck);
  assert.equal(deck.length, 106, 'the official playable deck is 106 cards');

  for (const [type, n] of Object.entries(OFFICIAL)) {
    if (type === 'action') continue;
    assert.equal(deck.filter(c => c.type === type).length, n, `${type} count`);
  }
  const actions = {};
  for (const c of deck) if (c.type === 'action') actions[c.action] = (actions[c.action] || 0) + 1;
  assert.deepEqual(actions, OFFICIAL.action,
    'MD Faithful must contain the official action deck and nothing else — no CHUD');
  assert.equal(actions.chud, undefined, 'CHUD has no Monopoly Deal equivalent');

  const sum = Object.values(OFFICIAL.action).reduce((a, b) => a + b, 0);
  assert.equal(sum, 34, 'the official action deck is 34 cards');
  assert.equal(OFFICIAL.property + OFFICIAL.wild_property + OFFICIAL.rent + OFFICIAL.money + sum, 106);
});

test('the two restored wilds are MD\'s missing pair, and they are the LAST two', () => {
  const pairKey = c => c.colors.slice().sort().join('|');
  const at7 = G.buildDeck().filter(c => c.type === 'wild_property' && c.colors[0] !== 'any');
  const at9 = G.buildDeck({ wildPairs: 9 }).filter(c => c.type === 'wild_property' && c.colors[0] !== 'any');
  assert.equal(at7.length, 7);
  assert.equal(at9.length, 9);
  // Taking the first n means the baseline is a strict PREFIX of the extended list, which is
  // what makes the counts a stable identity rather than a reshuffle.
  assert.deepEqual(at9.slice(0, 7).map(pairKey), at7.map(pairKey));
  assert.deepEqual(at9.slice(7).map(pairKey).sort(), ['orange|pink', 'red|yellow']);
});

/* ── 3. bounds, clamping and the strict door ──────────────────────────── */

test('normalizeDeck is total: any input becomes a complete, legal, in-range deck', () => {
  const junk = [undefined, null, 0, 'deck', [], [1, 2], { nope: 5 }, { chud: 'two' },
    { chud: 1.5 }, { chud: NaN }, { __proto__: { chud: 9 } }];
  for (const raw of junk) {
    const out = G.normalizeDeck(raw);
    assert.deepEqual(Object.keys(out).sort(), G.DECK_KINDS.slice().sort(), String(raw));
    const size = G.deckSize(out);
    assert.ok(size >= G.DECK_MIN && size <= G.DECK_MAX, `${raw} → ${size} cards`);
  }
  // per-kind clamping, not rejection
  assert.equal(G.normalizeDeck({ chud: 999 }).chud, G.deckKindMax('chud'));
  assert.equal(G.normalizeDeck({ chud: -4 }).chud, 0);
  assert.equal(G.normalizeDeck({ wildPairs: 99 }).wildPairs, G.WILD_PAIRS.length);
});

test('a deck that resolves out of range is refused WHOLE, not silently rescaled', () => {
  // Every action at 0 is individually legal and sums to 70 — below DECK_MIN. Half-honouring
  // it would run the table on a deck nobody chose, so the override is dropped entirely.
  const empty = Object.fromEntries(G.DECK_ACTION_KINDS.map(k => [k, 0]));
  assert.deepEqual(G.normalizeDeck(empty), { ...G.DECK_BASE },
    'an under-size deck must fall back to the base, not be partially applied');
  const huge = Object.fromEntries(G.DECK_ACTION_KINDS.map(k => [k, 12]));
  assert.deepEqual(G.normalizeDeck(huge), { ...G.DECK_BASE });
  // ...and one that lands INSIDE the range is honoured in full.
  const ok = G.normalizeDeck({ inspector_general: 3, chud: 3 });
  assert.equal(ok.inspector_general, 3);
  assert.equal(ok.chud, 3);
  assert.equal(G.deckSize(ok), 108);
});

test('validateDeck refuses out loud everything normalizeDeck would swallow', () => {
  assert.equal(G.validateDeck(undefined), null);
  assert.equal(G.validateDeck({ inspector_general: 3 }), null);
  assert.match(G.validateDeck([]), /must be an object/i);
  assert.match(G.validateDeck({ nope: 1 }), /unknown deck card/i);
  assert.match(G.validateDeck({ chud: 13 }), /invalid count/i);
  assert.match(G.validateDeck({ chud: -1 }), /invalid count/i);
  assert.match(G.validateDeck({ chud: 1.5 }), /invalid count/i);
  assert.match(G.validateDeck({ wildPairs: 10 }), /invalid count/i);
  assert.match(G.validateDeck(Object.fromEntries(G.DECK_ACTION_KINDS.map(k => [k, 0]))),
    /must hold 80.130 cards/i);
});

test('set_rules and start_game accept exactly the same decks, and refuse the same ones', () => {
  for (const type of ['set_rules', 'start_game']) {
    assert.equal(protocol.validateMessage({ type, deck: { inspector_general: 3 } }).ok, true, type);
    assert.equal(protocol.validateMessage({ type, deck: { chud: 0, wildPairs: 9 } }).ok, true, type);
    assert.equal(protocol.validateMessage({ type }).ok, true, `${type}: deck is optional`);
    assert.match(protocol.validateMessage({ type, deck: { chud: 99 } }).error, /invalid count/i);
    assert.match(protocol.validateMessage({ type, deck: { hax: 1 } }).error, /unknown deck card/i);
    assert.match(protocol.validateMessage({ type, deck: 'all the chuds' }).error, /must be an object/i);
    assert.match(protocol.validateMessage({ type, suddenDeath: 'nope' }).error, /sudden death/i);
  }
});

/* ── 4. the ruleset carries it, so a recorded game reproduces ─────────── */

test('the resolved deck reaches the state, the view, game_start and therefore the gamelog', () => {
  const players = [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }];
  const state = G.createGame(players, { deck: { inspector_general: 3, chud: 3 }, seed: 'rec' });
  assert.equal(state.cardTotal, 108);
  assert.equal(state.rules.deck.inspector_general, 3);
  // gamelog.buildRecord writes `rules: state.rules` verbatim, so carrying it on the ruleset
  // is what makes a recorded custom-deck game reproducible from seed + rules alone.
  const record = require('../server/gamelog').buildRecord({ code: 'TEST', players, state }, G);
  assert.deepEqual(record.rules.deck, state.rules.deck, 'the record must carry the real deck');
  assert.equal(record.seed, 'rec');

  const view = G.getPlayerView(state, 'p1');
  assert.deepEqual(view.rules.deck, state.rules.deck, 'the client is told what deck it is playing');
  assert.deepEqual(state.events[0].rules.deck, state.rules.deck, 'game_start carries it');

  // and the record actually replays: same seed + same rules ⇒ same deck order.
  const replay = G.createGame(players, { ...record.rules, seed: record.seed });
  assert.deepEqual(replay.deck.map(c => c.id), state.deck.map(c => c.id));
});

test('a preset\'s deck is cloned, so one room can never mutate another room\'s ruleset', () => {
  const a = G.resolveRules({ preset: 'mdFaithful' });
  a.deck.chud = 99;
  assert.equal(G.resolveRules({ preset: 'mdFaithful' }).deck.chud, 0,
    'resolveRules handed out a reference to the shared preset');
  assert.equal(G.RULE_PRESETS.mdFaithful.deck.chud, 0);
});

test('a deck override merges over the PRESET\'s deck, and the label follows', () => {
  const md3 = G.resolveRules({ preset: 'mdFaithful', deck: { inspector_general: 3 } });
  assert.equal(md3.inspector_general, undefined, 'counts live under .deck, never on the ruleset');
  assert.equal(md3.deck.inspector_general, 3);
  assert.equal(md3.deck.chud, 0, 'the preset\'s own deck is the base, not DECK_BASE');
  assert.equal(md3.deck.wildPairs, 9);
  assert.equal(md3.preset, 'custom', 'a changed deck is never labelled as the preset');
  // ...and a deck that lands back on a preset's exact composition re-labels as it.
  assert.equal(G.resolveRules({ winRule: 'mdFaithful', pureSetRequired: true,
    counterCostsPlay: true, deck: { chud: 0, wildPairs: 9 } }).preset, 'mdFaithful');
  // resolveRules is idempotent on its own output — server/handlers.js replays pendingRules
  // through it and the picker must not drift from the launch.
  const once = G.resolveRules({ deck: { chud: 3 } });
  assert.deepEqual(G.resolveRules(once), once);
});

/* ── 5. no reachable deck can produce a game that does not end ────────── */

test('every extreme reachable deck still terminates, at 2 and at 5 players', () => {
  // §3.6 and §3.11 are the terminators; this proves they still fire at both ends of the
  // configurable range rather than trusting the comment that says so.
  const smallest = { pcs_orders: 0, opsec: 0, upgrade: 0, foc: 0, surge_ops: 0,
    roll_call: 0, finance_office: 0, wildAny: 0, wildPairs: 0 };
  const biggest = Object.fromEntries(G.DECK_KINDS.map(k => [k, G.deckKindMax(k)]));
  for (const [label, deck] of [['smallest', smallest], ['biggest', biggest], ['stock', {}]]) {
    const size = G.deckSize(G.normalizeDeck(deck));
    assert.ok(size >= G.DECK_MIN && size <= G.DECK_MAX, `${label} resolved to ${size}`);
    for (const count of [2, 5]) {
      const modes = ['neutral', 'aggressive', 'chud', 'conservative', 'random'].slice(0, count);
      const cfg = modes.map((m, i) => ({ name: m.slice(0, 4) + i, mode: m }));
      for (let g = 0; g < 6; g++) {
        const r = sim.runGame(cfg, 400, `term-${label}-${count}-${g}`, { deck });
        assert.ok(r.winner || r.endReason,
          `${label} deck, ${count} players, game ${g}: no ending in 400 turns`);
      }
    }
  }
});

test('card conservation holds over a real game on a custom deck', () => {
  const cfg = [{ name: 'A', mode: 'aggressive' }, { name: 'B', mode: 'chud' },
    { name: 'C', mode: 'neutral' }];
  const origEnd = G.endTurn;
  let checked = 0;
  G.endTurn = function patched(state, ...rest) {
    const r = origEnd.call(this, state, ...rest);
    if (state && state.players) {
      assert.deepEqual(G.validateState(state), { ok: true });
      checked++;
    }
    return r;
  };
  try {
    for (const deck of [{ inspector_general: 4, chud: 4 }, { chud: 0, wildPairs: 9 },
      { wildAny: 4, wildPairs: 9 }]) {
      for (let s = 1; s <= 2; s++) sim.runGame(cfg, 300, `cons-${s}`, { deck });
    }
  } finally {
    G.endTurn = origEnd;
  }
  assert.ok(checked > 50, `expected many samples, got ${checked}`);
});

/* ── 6. §3.10b contested approach ─────────────────────────────────────── */

test('sudden death is refused with instant win, where nothing is ever armed', () => {
  for (const mode of G.SUDDEN_DEATH_RULES) {
    assert.equal(G.resolveRules({ winRule: 'instant', suddenDeath: mode }).suddenDeath, 'off',
      'a control wired to nothing must not be offered');
    assert.equal(G.resolveRules({ preset: 'blitz', suddenDeath: mode }).suddenDeath, 'off');
  }
  // ...and it IS allowed on the other two, which then stop being a named preset.
  assert.equal(G.resolveRules({ suddenDeath: 'escalate' }).suddenDeath, 'escalate');
  assert.equal(G.resolveRules({ suddenDeath: 'escalate' }).preset, 'custom');
  assert.equal(G.resolveRules({ preset: 'mdFaithful', suddenDeath: 'oneLap' }).preset, 'custom',
    'MD Faithful plus a house rule is no longer "by the book"');
  assert.equal(G.resolveRules({ suddenDeath: 'nonsense' }).suddenDeath, 'off');
});

test('every preset ships sudden death off — the default game is unchanged', () => {
  for (const name of G.PRESET_NAMES) {
    assert.equal(G.RULE_PRESETS[name].suddenDeath, 'off', name);
  }
  assert.equal(G.DEFAULT_SUDDEN_DEATH, 'off');
});

test('a contested approach suspends the win, and every mode still terminates', () => {
  // The defect the design had to answer: as the owner asked for it, two armed players who
  // both hold could never resolve. Each mode carries its own bound; this proves each one
  // actually ends a real game rather than relying on the deck running out.
  const cfg = ['neutral', 'aggressive', 'chud', 'conservative']
    .map((m, i) => ({ name: m.slice(0, 4) + i, mode: m }));
  for (const suddenDeath of G.SUDDEN_DEATH_RULES) {
    let contested = 0;
    for (let g = 0; g < 40; g++) {
      const r = sim.runGame(cfg, 400, `sd-${suddenDeath}-${g}`, { suddenDeath });
      assert.ok(r.winner || r.endReason, `${suddenDeath} game ${g} never ended`);
      if (r.maxArmed >= 2) contested++;
    }
    assert.ok(contested > 0, `${suddenDeath}: no game was ever contested — nothing was tested`);
  }
});

test('the escalate bar rises only while contested, and drops back at the lap cap', () => {
  const players = [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }, { id: 'p3', name: 'C' }];
  const state = G.createGame(players, { suddenDeath: 'escalate', seed: 'bar' });
  assert.equal(G.contestOpen(state), false);
  assert.equal(G.contestBar(state), 3, 'an uncontested approach needs the normal count');

  // Arm two seats by hand, then let the clock run. The bar is a pure function of the
  // contest clock, so it can be driven without playing a whole game to the state.
  state.players[0].finalApproach = true;
  state.players[1].finalApproach = true;
  state.turnCounter = 10;
  G.syncContest(state);
  assert.equal(G.contestOpen(state), true);
  assert.equal(G.contestBar(state), 4, 'while contested, escalate demands one more set');

  state.turnCounter = 10 + 3 * G.CONTEST_LAP_CAP;      // exactly the cap, 3 active seats
  assert.ok(G.contestLaps(state) >= G.CONTEST_LAP_CAP);
  assert.equal(G.contestBar(state), 3,
    'the bar must drop back at the cap, or the fall-through to turn order can never fire');
  assert.equal(G.contestBlocks(state, state.players[0]), null, 'the cap releases the win');

  // and dropping back to one armed seat closes the contest outright
  state.players[1].finalApproach = false;
  G.syncContest(state);
  assert.equal(G.contestOpen(state), false);
  assert.equal(G.contestBar(state), 3);
});

test('the contested view fields never lie about what a conversion needs', () => {
  const players = [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }];
  const state = G.createGame(players, { suddenDeath: 'escalate', seed: 'view' });
  state.players[0].finalApproach = true;
  state.players[1].finalApproach = true;
  state.turnCounter = 4;
  G.syncContest(state);
  const view = G.getPlayerView(state, 'p1');
  assert.equal(view.contested, true);
  assert.equal(view.contestBar, 4, 'the HUD must not say "3 sets" when it takes 4');
  assert.equal(view.contestLapCap, G.CONTEST_LAP_CAP);
  assert.equal(view.rules.suddenDeath, 'escalate');
});

/* ── 7. the mirrors ───────────────────────────────────────────────────── */

test('ui/ruleset.js mirrors the engine\'s deck numbers exactly', async () => {
  const R = await loadRuleset();
  assert.deepEqual({ ...R.DECK_BASE }, { ...G.DECK_BASE });
  assert.deepEqual([...R.DECK_KINDS].sort(), G.DECK_KINDS.slice().sort());
  assert.equal(R.DECK_MIN, G.DECK_MIN);
  assert.equal(R.DECK_MAX, G.DECK_MAX);
  assert.equal(R.DECK_FIXED, G.DECK_FIXED);
  for (const kind of G.DECK_KINDS) {
    assert.equal(R.deckKindMax(kind), G.deckKindMax(kind), kind);
  }
  assert.deepEqual([...R.SUDDEN_DEATH_RULES], G.SUDDEN_DEATH_RULES);
  // ...and the wire's vocabulary is the engine's, so the picker cannot offer a mode
  // start_game would refuse.
  for (const mode of G.SUDDEN_DEATH_RULES) {
    assert.equal(protocol.validateMessage({ type: 'set_rules', suddenDeath: mode }).ok, true, mode);
  }
  // every editable count has a name a host can read, and every named one is editable
  assert.deepEqual(Object.keys(R.DECK_COPY).sort(), G.DECK_KINDS.slice().sort());
  assert.deepEqual([...R.DECK_ORDER].sort(), G.DECK_KINDS.slice().sort());
  for (const mode of G.SUDDEN_DEATH_RULES) assert.ok(R.SUDDEN_DEATH_COPY[mode]?.label, mode);

  // the four preset decks agree, which is the claim the picker's label rests on
  for (const name of G.PRESET_NAMES) {
    assert.ok(R.sameDeck(R.PRESETS[name].deck, G.RULE_PRESETS[name].deck), name);
  }
  // and the client's matchPreset is still the server's, deck included
  assert.equal(R.matchPreset(R.PRESETS.mdFaithful), 'mdFaithful');
  assert.equal(R.matchPreset({ ...R.PRESETS.mdFaithful, deck: { ...G.DECK_BASE } }), 'custom');
  assert.equal(G.resolveRules(R.rulesPayload({ ...R.PRESETS.chudopoly, deck: { ...G.DECK_BASE, chud: 3 } })).deck.chud, 3,
    'a custom deck must survive rulesPayload → resolveRules');
});

test('ui/deckcensus.js totals match buildDeck() for EVERY deck, not just the stock one', async () => {
  const { totalsFor, kindKey, sizeOf } = await loadCensus();
  const decks = [undefined, { ...G.DECK_BASE }, G.RULE_PRESETS.mdFaithful.deck,
    { ...G.DECK_BASE, inspector_general: 3, chud: 3 },
    { ...G.DECK_BASE, wildPairs: 9, wildAny: 4 },
    { ...G.DECK_BASE, wildPairs: 0, wildAny: 0 },
    { ...G.DECK_BASE, chud: 0, opsec: 0 }];
  for (const deck of decks) {
    const real = new Map();
    for (const card of G.buildDeck(deck)) {
      const key = kindKey(card);
      real.set(key, (real.get(key) || 0) + 1);
    }
    const claimed = totalsFor(deck);
    for (const [key, n] of real) {
      assert.equal(claimed.get(key), n, `${JSON.stringify(deck)} ${key}: census ${claimed.get(key)}, deck ${n}`);
    }
    for (const [key, n] of claimed) {
      if (n === 0) continue;
      assert.equal(real.get(key), n, `${JSON.stringify(deck)} ${key}: census invents ${n}`);
    }
    assert.equal(sizeOf(claimed), G.buildDeck(deck).length, 'census total is the real deck size');
  }
});

test('the census conserves cards over a real game on a CUSTOM deck', async () => {
  const { census } = await loadCensus();
  const deck = { inspector_general: 3, chud: 3, wildPairs: 9 };
  const size = G.deckSize(G.normalizeDeck(deck));
  const cfg = [{ mode: 'aggressive', name: 'A' }, { mode: 'chud', name: 'B' },
    { mode: 'conservative', name: 'C' }];
  const origEnd = G.endTurn;
  let checked = 0;
  G.endTurn = function patched(state, ...rest) {
    const r = origEnd.call(this, state, ...rest);
    if (state && state.phase === 'playing') {
      for (const p of state.players) {
        const c = census(G.getPlayerView(state, p.id), p.id);
        assert.equal(c.total, size, 'the census must know how big this deck is');
        assert.equal(c.gone + c.visible + c.unseen, size,
          `conservation broke: ${c.gone}+${c.visible}+${c.unseen} != ${size}`);
        assert.equal(c.unseen, c.deckCount + c.hiddenHands);
        for (const g of c.groups) {
          for (const row of g.rows) {
            assert.ok(row.live >= 0 && row.gone >= 0 && row.live + row.gone <= row.total,
              `${row.key}: ${row.gone} gone + ${row.live} live > ${row.total}`);
          }
        }
        checked++;
      }
    }
    return r;
  };
  try {
    for (let seed = 1; seed <= 2; seed++) sim.runGame(cfg, 300, `census-${seed}`, { deck });
  } finally {
    G.endTurn = origEnd;
  }
  assert.ok(checked > 50, `expected many samples, got ${checked}`);
});

/* ── 8. the measurement pipeline the variants were chosen with ────────── */

test('lineupsFor is every k-subset x every rotation, and k=4 is the old loop exactly', () => {
  const M = sim.BOT_MODES;
  const old = [];
  for (let d = 0; d < M.length; d++) {
    const b = M.filter((_, i) => i !== d);
    for (let r = 0; r < b.length; r++) old.push(b.slice(r).concat(b.slice(0, r)));
  }
  const key = a => a.map(x => x.join('|')).sort().join(' / ');
  assert.equal(key(sim.lineupsFor(4)), key(old),
    'the generalised matrix must reproduce every number BOT-STRATEGY.md already quotes');
  assert.equal(sim.lineupsFor(3).length, 30);
  assert.equal(sim.lineupsFor(5).length, 5);
  // every personality plays every seat at every supported count — the property the whole
  // matrix rests on, asserted rather than assumed.
  for (const k of [3, 4, 5]) {
    const seats = M.map(() => new Set());
    for (const lineup of sim.lineupsFor(k)) {
      lineup.forEach((mode, seat) => seats[M.indexOf(mode)].add(seat));
    }
    for (let i = 0; i < M.length; i++) {
      assert.equal(seats[i].size, k, `${M[i]} does not play every seat at ${k} players`);
    }
  }
});

test('runMatches reports the deck it ran and splits the points ending by cause', () => {
  const r = sim.runMatches({ players: ['neutral', 'chud', 'aggressive'], games: 60,
    seed: 'report', rules: { deck: { inspector_general: 3 } } });
  assert.equal(r.deckSize, 107, 'a variant that does not report its own deck is unfalsifiable');
  for (const key of ['deckDry', 'deckCycles', 'contestCap', 'pointsRate', 'avgShuffles',
    'contestedGames', 'contestedRate']) {
    assert.ok(r[key] !== undefined, `runMatches must report ${key}`);
  }
  assert.equal(r.deckDry + r.deckCycles + r.contestCap,
    Math.round(r.pointsRate / 100 * r.games), 'pointsRate must be the sum of its causes');
});
