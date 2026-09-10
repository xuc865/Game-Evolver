// test/stats-logbook.test.js — the local play-history logbook.
//
// Three files under test, all of them mine:
//   public/src/state/stats.js     storage (total sanitize, versioning, ring)
//   public/src/state/recorder.js  event stream → one row
//   public/src/ui/journal.js      the accumulator both of the above depend on
//
// `tools/statsfuzz.mjs` is the deep gate on `sanitize` (40k generated inputs).
// THIS file pins the claims that are about CHUDOPOLY specifically — the ones a
// generic fuzzer cannot know are true, and that a future refactor would break
// silently:
//
//   * the wire tail is too short to record from        (measured, logs/games.jsonl)
//   * `win` says `actor`, `stalemate` says `winner`    (game.js finishGame)
//   * a finished game re-broadcasts and must latch     (server/handlers.js)
//   * `state.stats.payments` is TABLE-GLOBAL           (so it is not "your" rent)
//   * bot games must count, or the logbook is empty    (733/735 records)
//
// public/src/ is native ESM (§0.2) and this suite is CommonJS, so client modules
// load through dynamic import() — the same route test/wild-rearrange.test.js takes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

const G = require('../game.js');

const ROOT = join(__dirname, '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const loadStats = () => import(url('public/src/state/stats.js'));
const loadRecorder = () => import(url('public/src/state/recorder.js'));
const loadJournal = () => import(url('public/src/ui/journal.js'));
/** A FRESH module instance — the store and the recorder are both singletons. */
const freshStats = () => import(`${url('public/src/state/stats.js')}?t=${Math.random()}`);

/** An in-memory Storage that behaves like the real one (values are strings). */
function shim(over = {}) {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    ...over,
  };
}

const LOG = join(ROOT, 'logs', 'games.jsonl');
function realGames() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    // The other ~671 rows are 5–7 event abandons and harness stubs; a "real
    // game" is one that was actually played out.
    .filter((r) => Array.isArray(r.events) && r.events.length > 20);
}

/* ── 1. the measurement this whole design rests on ───────────────────────── */

test('the wire tail is far shorter than a real game — the reason we accumulate', () => {
  const games = realGames();
  if (!games.length) return; // logs/ is gitignored on a fresh clone
  const lens = games.map((g) => g.eventsTotal || g.events.length).sort((a, b) => a - b);
  const median = lens[Math.floor(lens.length / 2)];
  const over = lens.filter((n) => n > G.EVENT_TAIL).length;
  assert.equal(over, lens.length,
    `${over}/${lens.length} real games exceed EVENT_TAIL=${G.EVENT_TAIL}; if this ever `
    + 'drops below 100% the "record from the tail" shortcut becomes arguable again');
  assert.ok(median > G.EVENT_TAIL * 1.5,
    `median real game is ${median} events against a ${G.EVENT_TAIL}-event tail`);
});

test('recording from the final tail alone loses most of every game', async () => {
  const games = realGames();
  if (!games.length) return;
  const { deriveRow } = await loadRecorder();
  const g = games.find((x) => x.winner) || games[0];
  const me = g.winner;
  const beats = g.events.map((ev, i) => ({ seq: ev.seq ?? i + 1, ev }));
  const snapshot = { phase: 'finished', winner: me, endReason: g.endReason, players: [], turnNumber: g.turns };
  const seats = g.seats.map((s) => ({ id: s.id, human: s.everHuman, botMode: s.botMode }));

  const whole = deriveRow({ beats, snapshot, selfId: me, code: g.code, seats, gaps: 0 });
  const tail = deriveRow({
    beats: beats.slice(-G.EVENT_TAIL), snapshot, selfId: me, code: g.code, seats, gaps: 0,
  });
  const sum = (r) => r.armed + r.broken + r.shootdowns + r.stolen + r.lost
    + r.opsec + r.insolvent + r.charged + r.paid;
  assert.ok(sum(whole) > sum(tail),
    'the tail-only fold should undercount — if it does not, this fixture is too short to prove anything');
  // Trap 3: a fold with no `game_start` in view is marked gapped, so a
  // tail-only recording can never claim a personal best.
  assert.ok(tail.gaps > 0, 'a tail-only fold must mark itself incomplete');
  assert.equal(whole.gaps, 0, 'a whole-stream fold with no missed broadcasts is clean');
});

/* ── 2. the two field names ──────────────────────────────────────────────── */

test('game.js really does emit `actor` for win and `winner` for stalemate', () => {
  const src = read('game.js');
  assert.match(src, /emit\(state, 'stalemate', \{\s*winner: winnerId/,
    'stalemate no longer carries `winner` — recorder.js END_EVENTS must change');
  assert.match(src, /emit\(state, 'win', \{ actor: winnerId/,
    'win no longer carries `actor` — recorder.js END_EVENTS must change');
});

test('endWinner reads whichever field the ending used', async () => {
  const { endWinner, END_EVENTS } = await loadRecorder();
  assert.equal(END_EVENTS.win, 'actor');
  assert.equal(END_EVENTS.stalemate, 'winner');
  assert.equal(endWinner({ t: 'win', actor: 'me' }), 'me');
  assert.equal(endWinner({ t: 'stalemate', winner: 'me' }), 'me');
  // THE BUG: a uniform `.actor` read scores every stalemate a loss for its winner.
  assert.equal(endWinner({ t: 'stalemate', winner: 'me' }), 'me');
  assert.equal({ t: 'stalemate', winner: 'me' }.actor, undefined);
  assert.equal(endWinner({ t: 'stalemate', winner: null }), null, 'a genuine draw');
  assert.equal(endWinner({ t: 'turn_end', actor: 'me' }), null);
});

test('a stalemate produced BY THE ENGINE is scored as a win for its winner', async () => {
  const { deriveRow } = await loadRecorder();
  const state = G.createGame([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], { seed: 'stale' });
  // Dry the table: endTurn() ends in a stalemate once every active player has
  // taken an idle turn with no deck, no discard and no change in hand totals.
  state.deck = [];
  state.discardPile = [];
  for (let i = 0; i < 12 && state.phase === 'playing'; i++) {
    G.endTurn(state, G.currentPlayer(state).id);
  }
  assert.equal(state.phase, 'finished', 'the engine did not reach a stalemate');
  assert.equal(state.endReason, 'stalemate');
  const end = state.events[state.events.length - 1];
  assert.equal(end.t, 'stalemate');
  assert.ok(end.winner, 'this fixture should have a ranked winner');
  assert.equal(end.actor, undefined, 'the whole trap: stalemate has no `actor`');

  const beats = state.events.map((ev) => ({ seq: ev.seq, ev }));
  const view = G.getPlayerView(state, end.winner);
  const row = deriveRow({
    beats, snapshot: view, selfId: end.winner, code: 'STAL',
    seats: [{ id: 'p1', human: true }, { id: 'p2', human: false, botMode: 'neutral' }], gaps: 0,
  });
  assert.equal(row.won, true, 'the stalemate winner was scored as a loss');
  assert.equal(row.end, 'stalemate');
  const loserId = state.players.find((p) => p.id !== end.winner).id;
  const loss = deriveRow({
    beats, snapshot: G.getPlayerView(state, loserId), selfId: loserId, code: 'STAL',
    seats: [], gaps: 0,
  });
  assert.equal(loss.won, false);
});

/* ── 3. the latch ────────────────────────────────────────────────────────── */

test('a finished game re-broadcast ten times is recorded ONCE', async () => {
  const { deriveRow, observe, newGame } = await loadRecorder();
  assert.ok(deriveRow);
  const { stats } = await freshStats();
  stats.load({ storage: shim() });
  newGame();

  const beats = [
    { seq: 1, ev: { t: 'game_start', order: ['me', 'bot'] } },
    { seq: 2, ev: { t: 'set_completed', actor: 'me', color: 'darkblue', total: 3 } },
    { seq: 3, ev: { t: 'win', actor: 'me', sets: 3, reason: 'sets' } },
  ];
  const snapshot = {
    phase: 'finished', winner: 'me', endReason: 'sets', eventSeq: 3, turnNumber: 22,
    winRule: 'finalApproach', setsToWin: 3,
    players: [{ id: 'me', completedSets: 3 }, { id: 'bot', completedSets: 1 }],
  };
  const room = { code: 'AAAA', players: [{ id: 'me', isBot: false }, { id: 'bot', isBot: true, botMode: 'neutral' }] };
  for (let i = 0; i < 10; i++) observe({ snapshot, room, selfId: 'me', beats, gaps: 0, sink: stats });
  assert.equal(stats.data.totals.games, 1, 'the rebroadcast latch failed');
  assert.equal(stats.data.totals.wins, 1);
  assert.equal(stats.data.recent.length, 1);

  // …and a REMATCH in the same room is a different game. journal.reset() is what
  // calls newGame(); a rematch restarts eventSeq, which is why the code alone
  // could never be the key.
  newGame();
  for (let i = 0; i < 4; i++) observe({ snapshot, room, selfId: 'me', beats, gaps: 0, sink: stats });
  assert.equal(stats.data.totals.games, 2, 'a rematch in the same room was swallowed by the latch');
});

test('nothing is recorded while a game is still playing', async () => {
  const { observe, newGame } = await loadRecorder();
  const { stats } = await freshStats();
  stats.load({ storage: shim() });
  newGame();
  const room = { code: 'AAAA', players: [{ id: 'me', isBot: false }] };
  observe({
    snapshot: { phase: 'playing', players: [], eventSeq: 40 },
    room, selfId: 'me', beats: [{ seq: 1, ev: { t: 'game_start' } }], gaps: 0, sink: stats,
  });
  assert.equal(stats.data.totals.games, 0);
});

/* ── 4. composition: bot games count, and the split is recorded ──────────── */

test('bot games are recorded, with composition on the row', async () => {
  const games = realGames();
  if (games.length) {
    const anyHuman = games.filter((g) => g.humanSeats > 1).length;
    assert.equal(anyHuman, 0,
      'logs/games.jsonl now contains multi-human games; the "a bot-excluding logbook '
      + 'would be empty" argument should be re-measured, not deleted');
  }
  const { observe, newGame } = await loadRecorder();
  const { stats } = await freshStats();
  stats.load({ storage: shim() });
  newGame();
  const row = observe({
    snapshot: {
      phase: 'finished', winner: 'me', endReason: 'sets', eventSeq: 2, turnNumber: 30,
      winRule: 'finalApproach', setsToWin: 3, players: [{ id: 'me', completedSets: 3 }],
    },
    room: {
      code: 'BOTS',
      players: [
        { id: 'me', isBot: false },
        { id: 'b1', isBot: true, botMode: 'neutral' },
        { id: 'b2', isBot: true, botMode: 'aggressive' },
      ],
    },
    selfId: 'me',
    beats: [{ seq: 1, ev: { t: 'game_start' } }, { seq: 2, ev: { t: 'win', actor: 'me', reason: 'sets' } }],
    gaps: 0, sink: stats,
  });
  assert.equal(stats.data.totals.games, 1, 'a bot game must count');
  assert.equal(row.humans, 1);
  assert.equal(row.bots, 2);
  assert.deepEqual(row.botModes, ['aggressive', 'neutral'], 'modes stored (never displayed)');
  assert.equal(stats.data.totals.humanGames, 0, 'a solo-vs-bots game is not a human game');
  // Segmentation is available ON READ, from the row, forever — the thing Coup
  // threw away at write time and can never recover.
  assert.equal(stats.data.recent[0].bots, 2);
});

test('a human who is bot-taken-over mid-game still counts as a human seat', async () => {
  const { observe, newGame } = await loadRecorder();
  const { stats } = await freshStats();
  stats.load({ storage: shim() });
  newGame();
  const snapPlaying = { phase: 'playing', players: [], eventSeq: 1 };
  const beats = [{ seq: 1, ev: { t: 'game_start' } }];
  // Broadcast 1: two humans. server/handlers.js:789-793 then flips `isBot` on
  // the SAME seat when one drops, and `_wasHuman` is not on the wire.
  observe({
    snapshot: snapPlaying,
    room: { code: 'DROP', players: [{ id: 'me', isBot: false }, { id: 'you', isBot: false }] },
    selfId: 'me', beats, gaps: 0, sink: stats,
  });
  const row = observe({
    snapshot: {
      phase: 'finished', winner: 'me', endReason: 'sets', eventSeq: 2, turnNumber: 18,
      winRule: 'finalApproach', setsToWin: 3, players: [{ id: 'me', completedSets: 3 }],
    },
    room: { code: 'DROP', players: [{ id: 'me', isBot: false }, { id: 'you', isBot: true, botMode: 'neutral' }] },
    selfId: 'me',
    beats: [...beats, { seq: 2, ev: { t: 'win', actor: 'me', reason: 'sets' } }],
    gaps: 0, sink: stats,
  });
  assert.equal(row.humans, 2, 'the dropped human was scored as a bot');
  assert.equal(stats.data.totals.humanGames, 1);
  assert.equal(stats.data.totals.humanWins, 1);
});

/* ── 5. the fold, against a real game, through the real accumulator ─────── */

test('a real game replayed broadcast-by-broadcast folds to a coherent row', async () => {
  const games = realGames();
  if (!games.length) return;
  const journal = await loadJournal();
  const { deriveRow } = await loadRecorder();

  const g = games.find((x) => x.winner && x.events.length > 200) || games[0];
  const me = g.winner;
  const seats = g.seats.map((s) => ({ id: s.id, human: s.everHuman, botMode: s.botMode }));

  journal.reset();
  // Chunk the stream the way the wire does: each broadcast carries the last
  // EVENT_TAIL events known at that moment.
  for (let i = 1; i <= g.events.length; i++) {
    journal.ingest({ events: g.events.slice(Math.max(0, i - G.EVENT_TAIL), i), eventSeq: i });
  }
  assert.equal(journal.gapCount(), 0, 'a complete replay must report no gaps');
  assert.equal(journal.entries().length, Math.min(900, g.events.length));

  const row = deriveRow({
    beats: journal.entries(),
    snapshot: { phase: 'finished', winner: me, endReason: g.endReason, turnNumber: g.turns, players: [] },
    selfId: me, code: g.code, seats, gaps: journal.gapCount(),
  });
  assert.equal(row.won, true);
  assert.equal(row.turns, g.turns);
  assert.equal(row.gaps, 0);

  // Cross-check against the ENGINE's own bookkeeping, which counted the same
  // game independently at the server.
  const engineStolen = (g.stats?.propertiesStolen || {})[me] || 0;
  assert.equal(row.stolen, engineStolen,
    'derived steals disagree with state.stats.propertiesStolen — one of the two is wrong');
  assert.ok(row.charged + row.paid > 0, 'a 200+ event game with no payments at all is suspect');
  assert.ok(row.charged <= (g.stats?.payments?.total ?? Infinity),
    'you cannot have collected more than the whole table paid');
  assert.equal(row.biggest <= (g.stats?.payments?.biggest ?? Infinity), true);
});

test('a MISSED broadcast is recorded as a gap and disqualifies personal bests', async () => {
  const games = realGames();
  if (!games.length) return;
  const journal = await loadJournal();
  const { deriveRow } = await loadRecorder();
  const { stats } = await freshStats();
  stats.load({ storage: shim() });

  const g = games.find((x) => x.winner && x.events.length > 200) || games[0];
  journal.reset();
  for (let i = 1; i <= g.events.length; i++) {
    // Drop a run of broadcasts in the middle — a reconnect. The tail is 120
    // events, so a silence longer than that leaves a hole nothing can refill.
    if (i > 40 && i < 40 + G.EVENT_TAIL + 30) continue;
    journal.ingest({ events: g.events.slice(Math.max(0, i - G.EVENT_TAIL), i), eventSeq: i });
  }
  assert.ok(journal.gapCount() > 0, 'the journal did not notice the hole');

  const row = deriveRow({
    beats: journal.entries(),
    snapshot: { phase: 'finished', winner: g.winner, endReason: g.endReason, turnNumber: g.turns, players: [] },
    selfId: g.winner, code: g.code, seats: [], gaps: journal.gapCount(),
  });
  assert.ok(row.gaps > 0);
  row.biggest = 999;
  row.turns = 1;
  const { best } = stats.recordGame(row);
  assert.equal(best.biggestCharge, false, 'a gapped row claimed a biggest charge');
  assert.equal(best.fastestWin, false, 'a gapped row claimed a fastest win');
  assert.equal(stats.data.totals.games, 1, 'a gapped game is still a game');
  assert.equal(stats.data.totals.wins, 1, 'a gapped game is still a win');
});

/* ── 6. what we deliberately did NOT record, and why ─────────────────────── */

test('state.stats.payments is TABLE-GLOBAL, so it is not "your" rent', () => {
  const state = G.createGame([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], { seed: 'pay' });
  assert.deepEqual(Object.keys(state.stats.payments).sort(), ['biggest', 'count', 'total'],
    'if payments ever became per-player, the logbook could read it directly instead of '
    + 'folding `payment` events');
  // The per-player maps next to it are what a per-player shape looks like.
  assert.deepEqual(state.stats.cardsPlayed, {});
  assert.deepEqual(state.stats.propertiesStolen, {});
});

test('discards and deck cycles are too rare to be a stat', () => {
  const all = existsSync(LOG)
    ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  if (!all.length) return;
  const discardGames = all.filter((r) => (r.events || []).some((e) => e.t === 'discard')).length;
  assert.ok(discardGames / all.length < 0.05,
    `discards fired in ${discardGames}/${all.length} games — still under 5%, still not a stat`);
  const cycles = all.map((r) => r.deckCycles || 0).sort((a, b) => a - b);
  assert.ok(cycles[Math.floor(cycles.length * 0.99)] <= 1,
    'deck cycles p99 is above 1 now; a "deck cycles survived" stat would stop reading 0');
});

/* ── 7. storage: the properties the fuzzer states, asserted once here too ── */

test('sanitize is total over the shapes that actually reach it', async () => {
  const { sanitize, defaultStats, STATS_VERSION } = await loadStats();
  const keys = Object.keys(defaultStats()).sort().join(',');
  for (const input of [undefined, null, 0, '', 'null', [], [1, 2], true, NaN,
    { version: 'x' }, { totals: [] }, { recent: {} }, { recent: 'x' },
    JSON.parse('{"__proto__":{"polluted":1}}')]) {
    const out = sanitize(input);
    assert.equal(Object.keys(out).sort().join(','), keys, `shape drifted for ${JSON.stringify(input)}`);
    assert.equal(out.version, STATS_VERSION);
  }
  assert.equal(Object.prototype.polluted, undefined, 'prototype pollution escaped');
});

test('unknown keys are dropped, not merged', async () => {
  const { sanitize } = await loadStats();
  const out = sanitize({ version: 1, mystery: 1, totals: { games: 2, mystery: 1 }, recent: [{ mystery: 1 }] });
  assert.ok(!('mystery' in out));
  assert.ok(!('mystery' in out.totals));
  assert.ok(!('mystery' in out.recent[0]));
});

test('a FUTURE version is never written over — the Coup bug, pinned', async () => {
  const { stats, STATS_KEY, STATS_VERSION } = await freshStats();
  const st = shim();
  const blob = JSON.stringify({ version: STATS_VERSION + 1, totals: { games: 400 }, recent: [] });
  st.map.set(STATS_KEY, blob);
  stats.load({ storage: st });
  assert.equal(stats.status, 'future-version');
  assert.equal(stats.persistent, false);
  stats.recordGame({ won: true });
  stats.flush();
  assert.equal(st.map.get(STATS_KEY), blob,
    'a newer build\'s record was destroyed by an older client');
});

test('a corrupt blob is quarantined to a sidecar key', async () => {
  const { stats, STATS_KEY } = await freshStats();
  const st = shim();
  st.map.set(STATS_KEY, '{"version":1,"tot');
  stats.load({ storage: st });
  assert.equal(stats.status, 'corrupt');
  assert.equal(st.map.get(`${STATS_KEY}.corrupt`), '{"version":1,"tot');
  assert.equal(stats.persistent, true, 'a corrupt blob is recoverable ground, not a dead disk');
});

test('storage that throws on every access is survived', async () => {
  const { stats } = await freshStats();
  const hostile = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  const d = stats.load({ storage: hostile });
  assert.equal(d.totals.games, 0);
  stats.recordGame({ won: true });
  stats.flush();
  assert.equal(stats.data.totals.games, 1, 'the in-memory logbook must survive a dead disk');
});

test('the ring rolls off and the totals do not', async () => {
  const { stats, RECENT_MAX } = await freshStats();
  stats.load({ storage: shim() });
  for (let i = 0; i < RECENT_MAX + 25; i++) stats.recordGame({ won: i % 2 === 0, turns: 30 });
  assert.equal(stats.data.recent.length, RECENT_MAX);
  assert.equal(stats.data.totals.games, RECENT_MAX + 25);
  assert.equal(stats.data.totals.turns, (RECENT_MAX + 25) * 30);
});

test('facts are stored, ratios are not', async () => {
  const { defaultStats } = await loadStats();
  const flat = JSON.stringify(defaultStats());
  for (const banned of ['rate', 'Rate', 'pct', 'percent', 'average', 'avg', 'ratio']) {
    assert.ok(!flat.includes(banned), `\`${banned}\` is a derived quantity and must not be stored`);
  }
});

test('there is no device id', async () => {
  const src = read('public/src/state/stats.js');
  assert.ok(!/deviceId|device_id|crypto\.randomUUID/.test(src),
    'a no-account game has nothing to identify a device to');
});

test('streaks carry their sign and never exceed their evidence', async () => {
  const { stats } = await freshStats();
  stats.load({ storage: shim() });
  for (let i = 0; i < 3; i++) stats.recordGame({ won: true });
  assert.equal(stats.data.totals.streak, 3);
  assert.equal(stats.data.totals.bestWinStreak, 3);
  for (let i = 0; i < 4; i++) stats.recordGame({ won: false });
  assert.equal(stats.data.totals.streak, -4);
  assert.equal(stats.data.totals.bestWinStreak, 3, 'a losing run erased the best win streak');
  assert.equal(stats.data.totals.worstLossStreak, 4);
});

test('cross-field repair reconciles toward the evidence of play', async () => {
  const { sanitize } = await loadStats();
  // A counter wiped to zero over a ring that still holds the games.
  const out = sanitize({
    version: 1,
    totals: { games: 0, wins: 0, fastestWinTurns: 5, converted: 9, armed: 0, streak: 40 },
    recent: [
      { at: 1, won: true, turns: 22, biggest: 7, gaps: 0 },
      { at: 2, won: false, turns: 31, biggest: 99, gaps: 3 },
      { at: 3, won: true, turns: 18, biggest: 4, gaps: 0 },
    ],
  });
  assert.equal(out.totals.games, 3, 'games must be at least the number of rows');
  assert.equal(out.totals.wins, 2, 'wins must be at least the number of won rows');
  assert.equal(out.totals.biggestCharge, 7,
    'a clean row must RAISE the best (0 → 7), and the gapped row\'s 99 must not');
  // A best is only ever raised, never lowered. `fastestWinTurns: 5` survives a
  // ring that cannot prove it, because the ring holds 100 games and a real
  // 5-turn win from last year has rolled off. Deleting it would be the store
  // destroying a record it merely could not see.
  assert.equal(out.totals.fastestWinTurns, 5, 'a best outside the ring was deleted');
  assert.ok(out.totals.converted <= out.totals.wins);
  assert.ok(out.totals.streak <= out.totals.wins);

  // …but a best with NO win behind it at all is a wiped counter, not a memory.
  const empty = sanitize({ version: 1, totals: { games: 0, wins: 0, fastestWinTurns: 5, streak: 9 }, recent: [] });
  assert.equal(empty.totals.fastestWinTurns, 0);
  assert.equal(empty.totals.streak, 0);
});

/* ── 8. the wiring ───────────────────────────────────────────────────────── */

test('ui/journal.js drives the recorder, and resets its latch on a new game', () => {
  const src = read('public/src/ui/journal.js');
  assert.match(src, /import \* as recorder from '\.\.\/state\/recorder\.js'/);
  assert.match(src, /recorder\.newGame\(\)/, 'the per-game latch must clear on journal.reset()');
  assert.match(src, /recorder\.observe\(\{/, 'the recorder must see every broadcast');
  // Ordering matters: the fold must read the ACCUMULATED stream, not the tail
  // this broadcast happened to carry.
  const ingestAt = src.indexOf('ingest(snapshot);\n    // AFTER ingest');
  const observeAt = src.indexOf('recorder.observe({');
  assert.ok(ingestAt >= 0 && observeAt > ingestAt, 'observe() must run after ingest()');
});

test('the storage key matches the house style', async () => {
  const { STATS_KEY } = await loadStats();
  assert.equal(STATS_KEY, 'chud.stats.v1');
  // The neighbours it has to live beside, all `chud.` dotted, none snake_case.
  assert.match(read('public/src/ui/ruleset.js'), /chud\.lobbyRules\.v1/);
  assert.match(read('public/src/ui/settings.js'), /chud\.uiscale/);
});

test('stats.js and recorder.js import nothing that needs a DOM', () => {
  for (const f of ['public/src/state/stats.js', 'public/src/state/recorder.js']) {
    const src = read(f);
    const imports = [...src.matchAll(/^import[^;]+from '([^']+)';/gm)].map((m) => m[1]);
    for (const i of imports) {
      assert.ok(/^\.\.\/core\/cards\.js$|^\.\/stats\.js$/.test(i),
        `${f} imports ${i}; the storage layer must stay loadable in Node for the fuzzer`);
    }
    assert.ok(!/\bdocument\.(getElementById|querySelector|createElement)/.test(src),
      `${f} touches the DOM`);
  }
});

/* ── 9. the rank ladder: bronze/silver/gold over sortie points ────────────
 *
 * Owner override on the researched design (research-ranks/DESIGN.md): three
 * legible tiers instead of six aircrew codes, same plumbing underneath —
 * Sortie Points accrued per banked game, the ROUTINE/CONTESTED/HOSTILE
 * mean-tier band as the anti-farm, monotonic, no decay, no placement. The
 * numbers below are the contract; if a threshold moves, this section is the
 * place that says so out loud. */

test("BOT_MODES carries every mode the server can seat — including 'random'", async () => {
  const { BOT_MODES, sanitizeRow } = await loadStats();
  // The server really can seat it (host-chosen roster, handlers.js add_bot).
  assert.ok(read('server/handlers.js')
    .includes("['random', 'conservative', 'neutral', 'aggressive', 'chud']"),
  'handlers.js no longer lists random as host-seatable — re-derive this section');
  assert.ok(BOT_MODES.includes('random'),
    "stats.js BOT_MODES omits 'random': the seat silently vanishes from the stored row, "
    + 'leaving botModes.length < bots — and random is the WEAKEST personality, so the '
    + 'missing entry would otherwise be priced as something stronger');
  const row = sanitizeRow({ bots: 2, humans: 1, botModes: ['random', 'aggressive'] });
  assert.deepEqual(row.botModes, ['aggressive', 'random'],
    'the random seat must survive sanitize');
});

test('a missing or unknown bot mode prices at tier 0 — unknown opposition earns the least', async () => {
  const { bandFor, awardFor } = await loadStats();
  // The farming hole DESIGN.md §2.4 names: modes that were dropped (or never
  // recorded) must average as 0, never be skipped from the denominator.
  assert.equal(bandFor({ bots: 3, humans: 1, botModes: [] }).name, 'ROUTINE');
  // One aggressive plus one unknown is mean 1.5, not mean 3.
  assert.equal(bandFor({ bots: 2, humans: 1, botModes: ['aggressive'] }).name, 'CONTESTED');
  // Priced ROUTINE: 3×1 + (4 seats − 2) + 0 humans = 5, not the CONTESTED 8.
  assert.equal(awardFor({ won: true, bots: 3, humans: 1, botModes: [] }), 5);
  // And the weakest real roster prices the same as no roster at all.
  assert.equal(bandFor({ bots: 2, humans: 1, botModes: ['random', 'random'] }).name, 'ROUTINE');
});

test('the award: +1 to finish; a win pays 3×band + (seats−2) + 3×(other humans), capped at 15', async () => {
  const { awardFor } = await loadStats();
  // A loss or draw is the finish point, whoever was at the table.
  assert.equal(awardFor({ won: false, bots: 2, humans: 1, botModes: ['aggressive', 'aggressive'] }), 1);
  // The Quick Play bench: 4 seats vs conservative/neutral/aggressive — mean
  // tier 2.0 → CONTESTED ×2 → 3×2 + 2 + 0 = 8. The pacing math below rests
  // on this exact number.
  assert.equal(awardFor({
    won: true, bots: 3, humans: 1, botModes: ['conservative', 'neutral', 'aggressive'],
  }), 8);
  // Heads-up vs aggressive is HOSTILE (mean 3.0), the calibration catch the
  // sum-band design got wrong: 3×3 + 0 + 0 = 9.
  assert.equal(awardFor({ won: true, bots: 1, humans: 1, botModes: ['aggressive'] }), 9);
  // Humans carry their own weight: +3 per other human seat.
  assert.equal(awardFor({ won: true, bots: 0, humans: 2, botModes: [] }), 6);
  // The cap: 3 aggressive + 2 other humans at 6 seats would price 9+4+6=19.
  assert.equal(awardFor({
    won: true, bots: 3, humans: 3, botModes: ['aggressive', 'aggressive', 'aggressive'],
  }), 15);
});

test('the band is non-invertible: different rosters, one price (the personality-hiding rule)', async () => {
  const { awardFor, bandFor } = await loadStats();
  // Four different 2-bot rosters, means 2.0 / 2.0 / 1.5 / 1.0 — all CONTESTED,
  // all worth exactly the same, so no award can be read back into a roster.
  const tables = [
    ['neutral', 'neutral'],
    ['aggressive', 'conservative'],
    ['aggressive', 'chud'],
    ['conservative', 'conservative'],
  ];
  const awards = tables.map((botModes) => awardFor({ won: true, bots: 2, humans: 1, botModes }));
  assert.equal(new Set(awards).size, 1, `one band must be one price, got ${awards}`);
  for (const botModes of tables) {
    assert.equal(bandFor({ bots: 2, humans: 1, botModes }).name, 'CONTESTED');
  }
});

test('three tiers — Bronze 30, Silver 200, Gold 700 — and the endowed floor', async () => {
  const { rankFor, TIERS, ENDOWED_SP } = await loadStats();
  assert.deepEqual(TIERS.map((t) => [t.name, t.at]),
    [['BRONZE', 30], ['SILVER', 200], ['GOLD', 700]],
    'the tier table moved — restate the pacing math where it is derived');
  // Endowed progress (Nunes & Drèze 2006, DESIGN.md §2.8): the ladder starts
  // two points in, on read, never stored.
  assert.equal(ENDOWED_SP, 2);
  const fresh = rankFor(0);
  assert.equal(fresh.sp, 2);
  assert.equal(fresh.tier, null, 'below Bronze is the fresh state, not a tier');
  assert.equal(fresh.next.name, 'BRONZE');
  assert.equal(fresh.remaining, 28);
  // The boundaries, exactly.
  assert.equal(rankFor(27).tier, null);
  assert.equal(rankFor(28).tier.name, 'BRONZE');
  assert.equal(rankFor(197).tier.name, 'BRONZE');
  assert.equal(rankFor(198).tier.name, 'SILVER');
  assert.equal(rankFor(697).tier.name, 'SILVER');
  assert.equal(rankFor(698).tier.name, 'GOLD');
  assert.equal(rankFor(698).next, null, 'Gold is the top');
  assert.equal(rankFor(698).remaining, 0);
  // Total over garbage: the ladder can never NaN.
  for (const junk of [NaN, -5, Infinity, -Infinity, 'x', null, undefined, {}, 1.7]) {
    const r = rankFor(junk);
    assert.ok(Number.isFinite(r.sp) && r.sp >= 2, `rankFor(${String(junk)}) sp=${r.sp}`);
    assert.ok(r.progress >= 0 && r.progress <= 1, `progress=${r.progress}`);
    assert.ok(Number.isInteger(r.remaining) && r.remaining >= 0);
  }
});

test('sortie points are monotonic: no losing streak ever demotes', async () => {
  const { stats } = await freshStats();
  stats.load({ storage: shim() });
  let last = 0;
  for (let i = 0; i < 60; i++) {
    const { rank } = stats.recordGame({
      won: false, humans: 1, bots: 2, botModes: ['aggressive', 'chud'], turns: 20,
    });
    assert.ok(rank, 'recordGame must report the rank movement');
    assert.equal(rank.points, 1, 'a loss is still a finished game: exactly +1');
    assert.ok(stats.data.totals.sortiePoints > last, 'SP went down — demotion is forbidden');
    last = stats.data.totals.sortiePoints;
  }
  assert.equal(stats.data.totals.sortiePoints, 60);
  // A win reports the band NAME only — never the roster behind it.
  const { rank } = stats.recordGame({
    won: true, humans: 1, bots: 2, botModes: ['aggressive', 'chud'],
  });
  assert.equal(rank.points, 7, '3×2 (CONTESTED) + 1 seat over 2 + 0 humans');
  assert.equal(rank.band, 'CONTESTED');
  assert.equal(JSON.stringify(rank).includes('chud'), false,
    'the rank payload leaked a personality — band name only, never the breakdown');
  assert.ok(rank.to.sp > rank.from.sp);
});

test('repair reconciles sortie points toward the evidence of play', async () => {
  const { sanitize } = await loadStats();
  // A clipped counter: every banked game earned at least the finish point.
  const low = sanitize({ version: 1, totals: { games: 10, sortiePoints: 3 }, recent: [] });
  assert.equal(low.totals.sortiePoints, 10);
  // An absurd counter: nothing pays past the 15-point per-game cap.
  const high = sanitize({ version: 1, totals: { games: 2, sortiePoints: 9999 }, recent: [] });
  assert.equal(high.totals.sortiePoints, 30);
  // A legacy blob with no counter floors to games — DESIGN.md §2.8's second
  // application: a returning player is already partway up the day this ships.
  const legacy = sanitize({ version: 1, totals: { games: 40, wins: 10 }, recent: [] });
  assert.equal(legacy.totals.sortiePoints, 40);
  // And a wiped logbook holds no points.
  const empty2 = sanitize({ version: 1, totals: { games: 0, sortiePoints: 500 }, recent: [] });
  assert.equal(empty2.totals.sortiePoints, 0);
});
