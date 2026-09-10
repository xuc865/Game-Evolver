// test/replayeval.test.js — the replay-evaluation instrument's gates.
//
// Every gate here follows the project's rule that an instrument must be proven able to
// fail (ARCHITECTURE §8) and must pass a NULL TEST before any number it produces is
// believed (§3 amendment 2026-08-11 — the null caught two real traps then; it is not
// ceremony). The corpus gates run against self-generated seeded games so this file is
// green on a checkout with no logs/ directory; when the real corpora are present
// (logs/games.jsonl, logs/production-games.jsonl in the main checkout), the full
// reconstruction sweep runs over them too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const G = require('../game.js');
const Bot = require('../bot.js');
const gamelog = require('../server/gamelog.js');
const R = require('../tools/lib/replay.js');
const BI = Bot._internal;

/* ── a real, seeded game to reconstruct ──────────────────────────────── */

// Plays a full seeded bot game the way simulate.js does and returns a gamelog record
// for it. Seat 0 is marked as a human seat (isBot:false) so buildRecord keeps the
// event stream — exactly the shape a production record has.
function playRecordedGame(seed, modes = ['neutral', 'aggressive', 'conservative']) {
  const players = modes.map((m, i) => ({ id: 'p' + i, name: 'seat' + i }));
  const state = G.createGame(players, { seed });
  BI.setRng(G.makeRng('bot:' + seed));
  try {
    let safety = 8000;
    while (state.phase === 'playing' && safety-- > 0) {
      if (state.pendingAction) {
        const rid = BI.findResponder(state);
        if (rid) { BI.botRespondSync(state, rid, modes[Number(rid.slice(1))]); continue; }
        state.pendingAction = null; state.turnPhase = 'play';
        continue;
      }
      const cp = G.currentPlayer(state);
      if (cp.eliminated) { G.advanceToNextActive(state); continue; }
      const mode = modes[Number(cp.id.slice(1))];
      const action = BI.decideBotPlay(state, cp.id, mode);
      if (action) {
        const res = BI.applyBotAction(state, cp.id, action);
        if (res && !res.error) continue;
      }
      const bot = G.getPlayer(state, cp.id);
      let discardIds;
      if (bot.hand.length > 7) discardIds = BI.chooseDiscards(bot, bot.hand.length - 7, mode);
      const end = G.endTurn(state, cp.id, discardIds);
      if (end?.error) G.forceEndTurn(state);
    }
  } finally {
    BI.setRng(null);
  }
  assert.equal(state.phase, 'finished', 'the generated game must finish');
  const room = {
    code: 'TEST', state, turnTimeout: 60, responseTimeout: 30,
    players: players.map((p, i) => ({ ...p, isBot: i !== 0, botMode: i === 0 ? null : modes[i] })),
  };
  const record = gamelog.buildRecord(room, G);
  assert.ok(Array.isArray(record.events) && record.events.length > 0,
    'record must retain its event stream (humanSeats >= 1)');
  assert.equal(record.events.length, record.eventsTotal,
    'generated game must not overflow the event cap — pick a shorter seed');
  return record;
}

const RECORD_A = playRecordedGame('replayeval-gate-1');
const RECORD_B = playRecordedGame('replayeval-gate-2', ['aggressive', 'neutral', 'conservative', 'chud']);

/* ── 1. reconstruction is exact, and provably able to fail ───────────── */

test('a recorded game reconstructs exactly: every event, every board, the outcome', () => {
  for (const record of [RECORD_A, RECORD_B]) {
    const { state, decisions } = R.reconstruct(record, { focusSeats: ['p0'] });
    assert.equal(state.phase, 'finished');
    assert.equal(state.winner, record.winner);
    assert.equal(state.turnCounter, record.turns);
    assert.ok(decisions.length > 10, `captures real decision points (got ${decisions.length})`);
    for (const dp of decisions) {
      assert.equal(dp.snapshot.turnPhase, 'play');
      assert.equal(dp.snapshot.pendingAction, null);
      assert.ok(dp.meta.recorded, 'every decision carries the recorded action');
    }
  }
});

test('a seeded record ALSO replays from bare (seed, rules, seats) — record fidelity', () => {
  const state = R.verifySeeded(RECORD_A);
  assert.equal(state.winner, RECORD_A.winner);
});

test('the reconstruction gate FAILS on a tampered record (mutation-proved)', () => {
  const tampered = JSON.parse(JSON.stringify(RECORD_A));
  const draw = tampered.events.find(e => e.t === 'draw' && e.cards && e.cards.length);
  const other = tampered.events.find(e => e.t === 'draw' && e.cards
    && e.cards.some(c => c.id !== draw.cards[0].id));
  draw.cards[0] = other.cards.find(c => c.id !== draw.cards[0].id);
  assert.throws(() => R.reconstruct(tampered), /diverged|refused|not in hand|rig/,
    'a record whose stream lies must be rejected, not approximated');

  const tampered2 = JSON.parse(JSON.stringify(RECORD_A));
  tampered2.boards[0].bank.push(999);
  assert.throws(() => R.reconstruct(tampered2), /final boards diverge/,
    'a record whose final boards lie must be rejected');
});

/* ── 2. the null test — mandatory before any number is believed ──────── */

test('NULL: subject === baseline returns a delta of exactly zero', () => {
  const res = R.evaluate([RECORD_A], {
    subject: 'neutral', baseline: 'neutral', rollouts: 3, at: 'all',
    maxPoints: 12, seed: 'null-gate', focus: 'human',
  });
  assert.ok(res.evaluated >= 8, `null must actually evaluate points (got ${res.evaluated})`);
  assert.equal(res.meanDelta, 0, 'identical policies, paired seeds: EXACTLY zero, not merely small');
  assert.equal(res.divergent, 0, 'identical policies never diverge');
  assert.equal(res.subjectWins, res.baselineWins, 'paired trajectories are identical');
});

/* ── 3. discrimination — the instrument must separate known-ordered policies ── */

test('discrimination: the lobotomized policy prices clearly below its base', () => {
  const res = R.evaluate([RECORD_A, RECORD_B], {
    subject: 'nocompleter:neutral', baseline: 'neutral', rollouts: 8,
    at: 'divergent', maxPoints: 12, seed: 'lobotomy-gate', focus: 'human',
  });
  // Round 13's lesson: identical numbers across doses is a broken harness, not a null —
  // so first prove the knob took effect at all.
  assert.ok(res.subjectPolicyStats.triggered > 0, 'the wrapper must demonstrably fire');
  assert.ok(res.evaluated > 0, 'divergent points must exist for a policy that refuses completions');
  assert.ok(res.meanDelta < -0.05,
    `refusing to complete sets must price clearly negative (got ${res.meanDelta.toFixed(3)})`);
});

test('discrimination: random prices below aggressive at the same states', () => {
  const rand = R.evaluate([RECORD_A], {
    subject: 'random', baseline: 'aggressive', rollouts: 6,
    at: 'divergent', maxPoints: 10, seed: 'order-gate', focus: 'human',
  });
  assert.ok(rand.evaluated > 0);
  assert.ok(rand.meanDelta < 0,
    `random must price below aggressive (got ${rand.meanDelta.toFixed(3)})`);
});

test('the cashfloor wrapper is live, inert-by-default elsewhere, and bot.js is untouched', () => {
  // The candidate exists only as an evaluation-time wrapper: bot.js must not know it.
  const botSrc = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
  assert.ok(!/cashfloor|cash_floor|CASH_FLOOR/i.test(botSrc), 'no cash floor in live bot code');

  const policy = R.makePolicy('cashfloor:neutral');
  const res = R.evaluate([RECORD_A, RECORD_B], {
    subject: 'cashfloor:neutral', baseline: 'neutral', rollouts: 2,
    at: 'divergent', maxPoints: 6, seed: 'floor-knob-gate', focus: 'human',
  });
  assert.ok(res.subjectPolicyStats.triggered > 0,
    'the floor must fire at recorded states before any delta it produces is meaningful');
  assert.ok(policy.name.startsWith('cashfloor:'));
});

/* ── 3b. the sandbag and rent-leverage wrappers (evaluation-only) ────── */

// A state sandbagGate() passes on: default winRule, not armed, one set short of the
// gate's winningset valve, low bank, small hand with a plain completer plus something
// else, breakers unseen, no shield. Built from a real createGame state so every field
// the planner reads exists.
function sandbagReadyState() {
  const state = G.createGame([
    { id: 'p0', name: 'a' }, { id: 'p1', name: 'b' }, { id: 'p2', name: 'c' },
  ], { seed: 'sandbag-fixture' });
  const p0 = state.players[0];
  const take = (pred) => {
    const i = state.deck.findIndex(pred);
    assert.ok(i >= 0, 'fixture card present in deck');
    return state.deck.splice(i, 1)[0];
  };
  // Everything p0 holds is rebuilt from real deck cards, engine-legal.
  for (const c of p0.hand.splice(0)) state.deck.push(c);
  const browns = [take(c => c.color === 'brown'), take(c => c.color === 'brown')];
  p0.properties = { brown: [{ ...browns[0], placedColor: 'brown' }] };
  p0.bank = [];
  p0.hand = [browns[1], take(c => c.type === 'money' && c.value === 1)];
  state.currentPlayerIndex = 0;
  state.turnPhase = 'play';
  state.playsRemaining = 3;
  return { state, completerId: browns[1].id };
}

test('sandbag wrapper: bot.js machinery fires under the scope, and the flag never leaks', () => {
  const { state, completerId } = sandbagReadyState();
  const pol = R.makePolicy('sandbag@1:neutral');
  assert.equal(BI.sandbagConfig().enabled, false, 'flag off before');
  BI.setRng(G.makeRng('bot:sandbag-gate'));
  const action = pol.decide(state, 'p0');
  BI.setRng(null);
  assert.equal(BI.sandbagConfig().enabled, false, 'flag restored after — arm-scoped');
  assert.equal(pol.stats.held, 1, 'the shelved §3.10j implementation held the completer');
  if (action && action.type === 'play_property') {
    const played = state.players[0].hand[action.cardIndex];
    assert.notEqual(played.id, completerId, 'a held completer is not the card played');
  }
  // Weight 0 consumes no rnd() (sandbagGate returns before the roll), so sandbag@0
  // must be behaviourally IDENTICAL to the bare persona — the leak-proof null.
  const res = R.evaluate([RECORD_A], {
    subject: 'sandbag@0:neutral', baseline: 'neutral', rollouts: 2, at: 'all',
    maxPoints: 8, seed: 'sandbag-null', focus: 'human',
  });
  assert.equal(res.meanDelta, 0, 'sandbag@0 vs bare: exactly zero — no leakage, no stream drift');
  assert.equal(res.divergent, 0);
  assert.equal(BI.sandbagConfig().enabled, false, 'flag off after a whole evaluation');
});

test('rentlev wrapper: substitutes a collectible charge at the 2-set window, else passes through', () => {
  const state = G.createGame([
    { id: 'p0', name: 'a' }, { id: 'p1', name: 'b' }, { id: 'p2', name: 'c' },
  ], { seed: 'rentlev-fixture3' });
  const p0 = state.players[0], p1 = state.players[1];
  const take = (pred) => {
    const i = state.deck.findIndex(pred);
    assert.ok(i >= 0, 'fixture card present in deck');
    return state.deck.splice(i, 1)[0];
  };
  for (const c of p0.hand.splice(0)) state.deck.push(c);
  for (const c of p1.hand.splice(0)) state.deck.push(c);
  // p1 in the window: exactly 2 completed sets, tiny bank, payable cards on the board.
  p1.properties = {
    brown: [take(c => c.color === 'brown'), take(c => c.color === 'brown')].map(c => ({ ...c, placedColor: 'brown' })),
    intel: [take(c => c.color === 'intel'), take(c => c.color === 'intel')].map(c => ({ ...c, placedColor: 'intel' })),
  };
  p1.bank = [take(c => c.type === 'money' && c.value === 1)];
  // p0 owns one lightblue and holds a 1M brown/lightblue rent the base policy DECLINES
  // (probed: it lays the pink property instead — a 3M darkblue rent it fires itself, so
  // the wrapper's real surface is exactly the marginal charge the plan skips). The note's
  // case: a small collectible charge, spent into the window instead of building.
  const rentCard = take(c => c.type === 'rent' && c.colors[0] !== 'any' && c.colors.includes('lightblue'));
  p0.properties = { lightblue: [{ ...take(c => c.color === 'lightblue'), placedColor: 'lightblue' }] };
  p0.hand = [
    rentCard,
    take(c => c.color === 'pink'),
    take(c => c.type === 'money' && c.value === 2),
  ];
  state.currentPlayerIndex = 0;
  state.turnPhase = 'play';
  state.playsRemaining = 3;

  const pol = R.makePolicy('rentlev:neutral');
  BI.setRng(G.makeRng('bot:rlg3'));
  const action = pol.decide(state, 'p0');
  BI.setRng(null);
  assert.equal(pol.stats.triggered, 1, 'the window must fire on this state');
  assert.equal(action.type, 'play_action');
  assert.equal(state.players[0].hand[action.cardIndex].id, rentCard.id, 'the declined rent is the substitution');
  assert.equal(action.targetColor, 'lightblue', 'charging the color we can actually collect on');
  // Color rents hit the whole table, so the window seat p1 is in the blast by construction.

  // No window (fresh game, nobody near 2 sets): pass-through must be byte-identical.
  const fresh = G.createGame([{ id: 'p0', name: 'a' }, { id: 'p1', name: 'b' }], { seed: 'rentlev-null' });
  BI.setRng(G.makeRng('bot:rentlev-null'));
  const wrapped = R.makePolicy('rentlev:neutral').decide(fresh, G.currentPlayer(fresh).id);
  BI.setRng(G.makeRng('bot:rentlev-null'));
  const bare = R.makePolicy('neutral').decide(fresh, G.currentPlayer(fresh).id);
  assert.deepEqual(wrapped, bare, 'outside the window the wrapper is the base policy');
});

/* ── 3c. the setTuning hook and the tuned: wrapper ───────────────────── */

test('setTuning: overrides bind, restore is exact, and the tuned wrapper never leaks', () => {
  const before = JSON.stringify(BI.tuningConfig());
  BI.setTuning({
    tables: { BREAK_URGENCY: { neutral: 0.123 }, BREAKER_BAR: { neutral: { escort: false } } },
    CUSHION_GAIN: 999, BREAKER_SELF_MARGIN: 2,
  });
  const mid = BI.tuningConfig();
  assert.equal(mid.tables.BREAK_URGENCY.neutral, 0.123, 'table override binds');
  assert.equal(mid.tables.BREAKER_BAR.neutral.escort, false, 'nested merge binds');
  assert.equal(mid.tables.BREAKER_BAR.neutral.denyAt, 1, 'nested merge preserves siblings');
  assert.equal(mid.CUSHION_GAIN, 999, 'scalar override binds');
  BI.setTuning(null);
  assert.equal(JSON.stringify(BI.tuningConfig()), before, 'restore is EXACT, byte for byte');

  // Scoping null: a tuned policy carrying the SHIPPED values must be behaviourally
  // identical to the bare persona — exactly zero, or the scoping itself perturbs streams.
  const res = R.evaluate([RECORD_A], {
    subject: 'tuned:urgency=0.9:neutral', baseline: 'neutral', rollouts: 2, at: 'all',
    maxPoints: 8, seed: 'tune-null', focus: 'human',
  });
  assert.equal(res.meanDelta, 0, 'shipped-value tuning is the bare persona, exactly');
  assert.equal(res.divergent, 0);
  assert.equal(JSON.stringify(BI.tuningConfig()), before, 'defaults intact after a whole evaluation');
});

test('a tuned dial provably CHANGES behaviour: holdback=0 through the hook equals @0', () => {
  // The @scale suffix and the HOLDBACK table are two doors to the same constant; driving
  // one through setTuning and the other through holdScaleOf must produce identical
  // decisions on identical streams — a behavioural bind proof with a known-good referee.
  const { decisions } = R.reconstruct(RECORD_A, { focusSeats: ['p0'] });
  let checked = 0, diffsVsBase = 0;
  for (const dp of decisions.slice(0, 25)) {
    const seedS = 'tune-bind:' + dp.meta.index;
    const viaHook = R.decideAt(dp.snapshot, 'p0', R.makePolicy('tuned:holdback=0:neutral'), seedS);
    const viaScale = R.decideAt(dp.snapshot, 'p0', R.makePolicy('neutral@0'), seedS);
    const bare = R.decideAt(dp.snapshot, 'p0', R.makePolicy('neutral'), seedS);
    const st = R.reviveState(dp.snapshot);
    assert.deepEqual(R.canonicalAction(st, 'p0', viaHook), R.canonicalAction(st, 'p0', viaScale),
      'the hook and the @scale door must agree');
    if (JSON.stringify(R.canonicalAction(st, 'p0', viaHook))
      !== JSON.stringify(R.canonicalAction(st, 'p0', bare))) diffsVsBase++;
    checked++;
  }
  assert.ok(checked >= 20);
  // Round 13's lesson: prove the knob DID something somewhere, or the equality above
  // could be three copies of the same broken zero.
  assert.ok(diffsVsBase > 0, 'holdback=0 must actually change at least one decision vs bare');
});

/* ── 3d. the oracle-charge wrapper ───────────────────────────────────── */

test('oracle: surges into the window, holds small charges outside it, restores the hand', () => {
  // WINDOW: p1 one set from winning, tiny bank; p0 holds a 1M rent + surge_ops. The
  // doubled rent (2M) bites the board where the single (1M) does not -> surge first.
  const state = G.createGame([
    { id: 'p0', name: 'a' }, { id: 'p1', name: 'b' }, { id: 'p2', name: 'c' },
  ], { seed: 'oracle-fix' });
  const p0 = state.players[0], p1 = state.players[1];
  const take = (pred) => {
    const i = state.deck.findIndex(pred);
    assert.ok(i >= 0, 'fixture card present');
    return state.deck.splice(i, 1)[0];
  };
  for (const c of p0.hand.splice(0)) state.deck.push(c);
  for (const c of p1.hand.splice(0)) state.deck.push(c);
  p1.properties = {
    brown: [take(c => c.color === 'brown'), take(c => c.color === 'brown')].map(c => ({ ...c, placedColor: 'brown' })),
    intel: [take(c => c.color === 'intel'), take(c => c.color === 'intel')].map(c => ({ ...c, placedColor: 'intel' })),
  };
  p1.bank = [take(c => c.type === 'money' && c.value === 1)];
  p0.properties = { lightblue: [{ ...take(c => c.color === 'lightblue'), placedColor: 'lightblue' }] };
  p0.hand = [
    take(c => c.type === 'rent' && c.colors[0] !== 'any' && c.colors.includes('lightblue')),
    take(c => c.color === 'pink'),
    take(c => c.action === 'surge_ops'),
    take(c => c.action === 'finance_office'),
  ];
  state.currentPlayerIndex = 0; state.turnPhase = 'play'; state.playsRemaining = 3;
  const pol = R.makePolicy('oracle:neutral');
  BI.setRng(G.makeRng('bot:og'));
  const a = pol.decide(state, 'p0');
  BI.setRng(null);
  assert.equal(pol.stats.surged, 1, 'the surge branch must fire when doubling crosses the bank');
  assert.equal(state.players[0].hand[a.cardIndex].action, 'surge_ops');

  // HOLDING: opponent at setsToWin-2, base fires a 1M rent -> oracle hides it and the
  // base re-decides to a non-charge play. The hand must come back byte-identical.
  const s2 = G.createGame([{ id: 'p0', name: 'a' }, { id: 'p1', name: 'b' }], { seed: 'oracle-hold' });
  const q0 = s2.players[0], q1 = s2.players[1];
  const take2 = (pred) => {
    const i = s2.deck.findIndex(pred);
    assert.ok(i >= 0, 'fixture card present');
    return s2.deck.splice(i, 1)[0];
  };
  for (const c of q0.hand.splice(0)) s2.deck.push(c);
  q1.properties = { brown: [take2(c => c.color === 'brown'), take2(c => c.color === 'brown')].map(c => ({ ...c, placedColor: 'brown' })) };
  q1.bank = [take2(c => c.type === 'money' && c.value === 1)];
  q0.properties = { lightblue: [{ ...take2(c => c.color === 'lightblue'), placedColor: 'lightblue' }] };
  q0.hand = [
    take2(c => c.type === 'rent' && c.colors[0] !== 'any' && c.colors.includes('lightblue')),
    take2(c => c.type === 'money' && c.value === 2),
  ];
  s2.currentPlayerIndex = 0; s2.turnPhase = 'play'; s2.playsRemaining = 3;
  const handBefore = JSON.stringify(q0.hand);
  const pol2 = R.makePolicy('oracle:neutral');
  BI.setRng(G.makeRng('bot:oh'));
  const b = pol2.decide(s2, 'p0');
  BI.setRng(null);
  assert.equal(pol2.stats.held, 1, 'the holding branch must fire on a sub-4M charge');
  assert.equal(b.type, 'play_money', 'the re-decided alternative is played instead');
  assert.equal(JSON.stringify(q0.hand), handBefore, 'hide-and-redecide restores the hand exactly');

  // Round 10's rule survives composition: an insolvent window seat is NOT a window.
  q1.bank = []; q1.properties = {}; // nothing payable
  const pol3 = R.makePolicy('oracle:neutral');
  BI.setRng(G.makeRng('bot:oi'));
  pol3.decide(s2, 'p0');
  BI.setRng(null);
  assert.equal(pol3.stats.charged + pol3.stats.surged, 0, 'never a charge that collects nothing');
});

test('playFresh: wrapper benches play whole games, and plain modes match the sim loop shape', () => {
  const r = R.playFresh(['oracle:aggressive', 'humanlike', 'neutral', 'conservative'],
    'playfresh-gate', { winRule: 'finalApproach', setsToWin: 3 });
  assert.ok(r.winner === null || typeof r.winner === 'string');
  assert.ok(r.turns > 0 && r.turns <= 300);
});

/* ── 4. determinization conserves the deck ───────────────────────────── */

test('determinized rollout decks are exactly the unseen multiset', () => {
  const { decisions } = R.reconstruct(RECORD_A, { focusSeats: ['p0'] });
  const dp = decisions[Math.floor(decisions.length / 2)];
  const state = R.reviveState(dp.snapshot);
  R.determinize(state, 'conservation-gate');
  const universe = G.buildDeck(state.rules.deck);
  const seen = new Set();
  const add = c => { assert.ok(!seen.has(c.id), 'duplicate card ' + c.id); seen.add(c.id); };
  for (const p of state.players) {
    p.hand.forEach(add); p.bank.forEach(add);
    for (const cards of Object.values(p.properties)) cards.forEach(add);
    for (const ups of Object.values(p.upgrades)) ups.forEach(add);
  }
  state.discardPile.forEach(add);
  state.deck.forEach(add);
  assert.equal(seen.size, universe.length, 'every card accounted for, none twice');
});

/* ── 5. the real corpora, when present (main checkout only) ──────────── */

for (const [name, file, minTurns] of [
  ['dev corpus (agent playtests)', '/Users/hunter/chudopoly/logs/games.jsonl', 10],
  ['production corpus (real players)', '/Users/hunter/chudopoly/logs/production-games.jsonl', 5],
]) {
  test(`full reconstruction sweep over the ${name}`,
    { skip: !fs.existsSync(file) ? 'corpus not on this machine' : false }, () => {
      const { records } = R.loadRecords(file, { minTurns });
      let exact = 0;
      const failures = [];
      for (const record of records) {
        try { R.reconstruct(record, { collect: false }); exact++; }
        catch (e) { failures.push(record.code + ': ' + e.message); }
      }
      assert.equal(exact, records.length,
        `every loadable record must reconstruct exactly; failed: ${failures.slice(0, 3).join(' | ')}`);
    });
}
