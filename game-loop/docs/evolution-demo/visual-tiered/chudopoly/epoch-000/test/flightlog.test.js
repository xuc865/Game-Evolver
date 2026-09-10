// test/flightlog.test.js — the flight log's derivation, and the three rules the
// data layer imposes on its surface.
//
// `public/src/ui/stats.js` splits deliberately into a PURE half (`foldRows`,
// `derive`) and a DOM half (`show`), so the arithmetic can be held against real
// recorded rows here while the rendering is gated by the harness
// (`tools/screenshot.mjs` drives it at four populations and asserts on what it
// found). This file is the arithmetic half.
//
// Three of the assertions below are SOURCE assertions rather than behavioural
// ones, and that is on purpose: "never display botModes" and "never say
// Lifetime" are prohibitions on the whole file, not on one code path. A
// behavioural test can only prove the paths it walked; a source test cannot be
// routed around by adding a branch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { stats, defaultRow, STATS_KEY } from '../public/src/state/stats.js';
import { derive, foldRows, TEXTURE_MIN, FORM_MAX } from '../public/src/ui/stats.js';
import * as journal from '../public/src/ui/journal.js';
import * as recorder from '../public/src/state/recorder.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PANEL = path.join(ROOT, 'public/src/ui/stats.js');
const LOGBOOK = path.join(ROOT, 'tools/fixtures/logbook.json');

const source = readFileSync(PANEL, 'utf8');
/** Comments explain the rules; only executable text can break them. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

class MemoryStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

/** Bank `rows` through the SHIPPING store and hand back its data. */
function bank(rows) {
  stats.load({ storage: new MemoryStorage() });
  for (const r of rows) stats.recordGame(r);
  const data = stats.data;
  stats.load({ storage: null });
  return data;
}

function row(over = {}) {
  return { ...defaultRow(), turns: 30, humans: 1, bots: 2, seats: 3, ...over };
}

/* ── rule 3: botModes is stored and never shown ──────────────────────────── */

test('the panel never reads botModes — the split exists, the display does not', () => {
  assert.equal(code.includes('botModes'), false,
    'ui/stats.js mentions botModes in executable code. It is recorded so the split exists the '
    + 'day the hiding rule changes; rendering it launders a deliberately hidden attribute '
    + 'through a different screen.');
  const d = derive(bank([row({ won: true, botModes: ['chud'] })]), 'all');
  assert.equal(JSON.stringify(d).includes('chud'), false,
    'derive() leaked a bot personality into what the panel renders');
});

/* ── rule 1: "Since {since}", never "Lifetime" ───────────────────────────── */

test('the panel dates the logbook and never claims a lifetime', () => {
  assert.match(code, /Since \$\{/,
    'nothing in ui/stats.js prints "Since {since}" — a browser-local record has to say so');
  assert.equal(/lifetime/i.test(code), false,
    'ui/stats.js uses the word "lifetime". localStorage is per-profile, editable from devtools '
    + 'and cleared with site data; framing it as a logbook is what makes the claim true.');
  const d = derive(bank([row({ won: true })]), 'all');
  assert.match(d.since, /^\d{4}-\d{2}-\d{2}$/, 'derive() must carry the stored ISO day through');
});

/* ── rule 2: a gapped row is an undercount ───────────────────────────────── */

test('a gapped flight counts as a flight and a result, and sets no personal best', () => {
  const clean = row({ won: true, turns: 40, biggest: 5, opsecDepth: 2 });
  // The same game, recorded across a reconnect: bigger numbers, but the client
  // only saw part of it, so none of them may claim a best.
  const gapped = row({ won: true, turns: 12, biggest: 99, opsecDepth: 9, gaps: 3 });

  const folded = foldRows([clean, gapped]);
  assert.equal(folded.flights, 2, 'both flights happened');
  assert.equal(folded.wins, 2, 'both were wins — that fact survives any hole in the record');
  assert.equal(folded.gapped, 1, 'the hole is counted, so the panel can say the totals are a floor');
  assert.equal(folded.biggestCharge, 5, 'a gapped row must not set the biggest charge');
  assert.equal(folded.fastestWinTurns, 40, 'a gapped row must not set the fastest win');
  assert.equal(folded.opsecDepthBest, 2, 'a gapped row must not set the deepest OPSEC chain');

  // And the store agrees — the surface is not applying a rule of its own.
  const d = derive(bank([clean, gapped]), 'all');
  assert.equal(d.biggestCharge, 5);
  assert.equal(d.fastestWinTurns, 40);
  assert.equal(d.gapped, 1);
});

/* ── band 1: the denominator is never optional ───────────────────────────── */

test('the win rate is always rendered against its own denominator', () => {
  assert.match(code, /Won \$\{d\.wins\} of \$\{plural\(d\.flights/,
    'the rate and its count must be built together — a percentage over three flights rendered '
    + 'at display size is a lie, and the denominator is the only thing that stops it');
  const d = derive(bank([row({ won: true }), row(), row()]), 'all');
  assert.equal(d.rate, 33);
  assert.equal(d.flights, 3);
  assert.equal(d.wins, 1);
  assert.equal(d.losses, 2);
});

test('an empty logbook derives to no rate at all, never to 0%', () => {
  const d = derive(bank([]), 'all');
  assert.equal(d.rate, null, 'a rate over zero flights is not 0%, it is nothing');
  assert.equal(d.flights, 0);
  assert.ok(TEXTURE_MIN > 0);
});

/* ── segmentation ────────────────────────────────────────────────────────── */

test('the three scopes partition the logbook exactly', () => {
  const rows = [
    row({ won: true, humans: 1, bots: 2 }),      // vs bots
    row({ won: false, humans: 1, bots: 3 }),     // vs bots
    row({ won: true, humans: 2, bots: 1 }),      // vs people
  ];
  const data = bank(rows);
  const all = derive(data, 'all');
  const bots = derive(data, 'bots');
  const people = derive(data, 'people');

  assert.equal(all.flights, 3);
  assert.equal(bots.flights + people.flights, all.flights, 'the split must lose nobody');
  assert.equal(bots.wins + people.wins, all.wins);
  assert.equal(people.flights, 1);
  assert.equal(people.wins, 1);
  assert.equal(bots.flights, 2);
});

test('a human-only default would open on an empty panel — All must be the default', () => {
  // Every recorded game in this project's logs has exactly one human seat, and
  // that is what makes the default load-bearing rather than a preference.
  const data = bank([row({ won: true }), row()]);
  assert.equal(derive(data, 'people').flights, 0);
  assert.ok(derive(data, 'all').flights > 0);
  assert.match(code, /let scope = 'all'/, 'the panel must open on All');
});

/* ── the ring, and what the panel says about it ──────────────────────────── */

test('the form line is the tail of the window, newest last, capped', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push(row({ won: i % 2 === 0, code: 'ABCD' }));
  const d = derive(bank(rows), 'all');
  assert.equal(d.form.length, FORM_MAX);
  assert.equal(d.form[d.form.length - 1].won, rows[rows.length - 1].won,
    'the last mark is the most recent flight');
});

test('when totals outrun the ring the panel is told, so it can name both windows', () => {
  const rows = [];
  for (let i = 0; i < 140; i++) rows.push(row({ won: i % 3 === 0 }));
  const data = bank(rows);
  const d = derive(data, 'all');
  assert.equal(d.recorded, 140, 'totals keep counting after a row rolls off the ring');
  assert.equal(d.detailed, 100, 'the ring is capped');
  assert.equal(d.rolled, true);
  // Band 1/2 come from `totals`, so they must NOT shrink to the ring.
  assert.equal(d.flights, 140);
  // And a personal best set on a row that has rolled off must still be there.
  assert.ok(d.fastestWinTurns > 0);
});

/* ── the ring cliff: a long, completed game is still a complete game ─────── */

test('a game longer than the beat ring still banks with gaps: 0', () => {
  // ui/journal.js caps the beat ring (MAX_BEATS = 900) and `game_start` is beat
  // #1, so any game past the cap splices it off the front. The recorder must
  // carry "this client saw the start" as sticky state, not re-derive it from
  // the spliced ring — that scored every long COMPLETED game as incomplete and
  // silently excluded it from every personal best.
  const TOTAL = 1100;                       // > MAX_BEATS
  const TAIL = 120;                         // game.js EVENT_TAIL
  const room = { code: 'ABCD', players: [
    { id: 'me', name: 'You', isBot: false, botMode: null },
    { id: 'b1', name: 'Raptor', isBot: true, botMode: 'neutral' },
  ] };

  const events = [{ seq: 1, t: 'game_start', order: ['me', 'b1'] }];
  for (let seq = 2; seq < TOTAL; seq++) {
    events.push(seq % 10 === 0
      ? { seq, t: 'turn_start', actor: seq % 20 === 0 ? 'me' : 'b1', plays: 3 }
      : { seq, t: 'draw', to: 'me', count: 1 });
  }
  events.push({ seq: TOTAL, t: 'win', actor: 'me', sets: 3 });

  stats.load({ storage: new MemoryStorage() });
  journal.reset();                          // also resets the recorder's latch
  let banked = null;
  // One broadcast per event with a 120-event tail, exactly the wire shape.
  for (let upTo = 1; upTo <= TOTAL; upTo++) {
    const finished = upTo === TOTAL;
    const view = {
      eventSeq: upTo,
      events: events.slice(Math.max(0, upTo - TAIL), upTo),
      phase: finished ? 'finished' : 'playing',
      winner: finished ? 'me' : null,
      turnNumber: 110, setsToWin: 3, winRule: 'finalApproach',
      players: [{ id: 'me', completedSets: 3 }, { id: 'b1', completedSets: 1 }],
    };
    journal.ingest(view);
    banked = recorder.observe({
      snapshot: view, room, selfId: 'me',
      beats: journal.entries(), gaps: journal.gapCount(), sink: stats,
    }) || banked;
  }

  // The premise, proven inside the test: the ring really did lose the start.
  assert.ok(journal.entries().length < TOTAL, 'the ring must stay bounded');
  assert.notEqual(journal.entries()[0].ev.t, 'game_start',
    'game_start must have rolled off the ring, or this test is not testing the cliff');
  assert.equal(journal.gapCount(), 0, 'a fully observed game has no broadcast gaps');

  assert.ok(banked, 'the game was banked');
  assert.equal(banked.won, true);
  assert.equal(banked.gaps, 0,
    'a completed game the client watched from the first beat is not "incomplete" '
    + 'just because the bounded ring spliced game_start off the front');

  // And the flip side stays true: a client that genuinely arrived mid-game is
  // still marked gapped — the fix must not launder a real hole in the record.
  journal.reset();
  const late = recorder.observe({
    snapshot: { eventSeq: 40, events: [{ seq: 40, t: 'win', actor: 'me', sets: 3 }],
      phase: 'finished', winner: 'me', turnNumber: 30, players: [] },
    room, selfId: 'me',
    beats: [{ seq: 40, ev: { t: 'win', actor: 'me', sets: 3 } }],
    gaps: 0, sink: stats,
  });
  assert.ok(late, 'the late-join game was banked');
  assert.ok(late.gaps > 0, 'a record that starts mid-game must stay marked incomplete');

  stats.load({ storage: null });
});

/* ── the real recording, when there is one ───────────────────────────────── */

test('the recorded logbook derives without throwing, in every scope', () => {
  if (!existsSync(LOGBOOK)) return;      // fixture is produced by tools/recordlog.mjs
  const f = JSON.parse(readFileSync(LOGBOOK, 'utf8'));
  stats.load({ storage: new MemoryStorage() });
  const data = (() => {
    const shim = new MemoryStorage();
    shim.setItem(STATS_KEY, JSON.stringify(f.blob));
    stats.load({ storage: shim });
    const d = stats.data;
    stats.load({ storage: null });
    return d;
  })();
  for (const scope of ['all', 'bots', 'people']) {
    const d = derive(data, scope);
    assert.ok(d.flights >= 0);
    assert.ok(d.wins <= d.flights, `${scope}: more wins than flights`);
    assert.equal(d.losses, d.flights - d.wins);
    if (d.flights > 0) assert.ok(d.rate >= 0 && d.rate <= 100);
  }
  const all = derive(data, 'all');
  assert.equal(all.flights, f.blob.totals.games,
    'band 1 must quote the stored total, not the ring');
});

/* ── the tier: meta progression between rounds, at scope All only ────────── */

test('the tier band reads at scope All only, and never reads the roster', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(row({ won: i % 2 === 0, botModes: ['aggressive', 'chud'] }));
  const data = bank(rows);
  const all = derive(data, 'all');
  assert.ok(all.rank, 'derive() must carry the rank at scope All');
  assert.ok(Number.isFinite(all.rank.sp) && all.rank.sp > 0);
  // 10 wins × 7 (CONTESTED, 3 seats) + 10 losses × 1 = 80 earned + 2 endowed.
  assert.equal(all.rank.sp, 82);
  assert.equal(all.rank.tier.name, 'BRONZE');
  // SP is a lifetime counter accrued across all compositions. The precedent is
  // bestStreak: it sidesteps the scope strip rather than printing a
  // whole-logbook figure under a filter — so under a filter there is no rank.
  assert.equal(derive(data, 'bots').rank, null);
  assert.equal(derive(data, 'people').rank, null);
  // The rank payload carries thresholds and tier names, never a personality.
  assert.equal(JSON.stringify(all.rank).includes('chud'), false);
  // And the panel prints the distance to the next tier — the near-miss line
  // ("118 · 82 TO SILVER") is the retention moment the design exists for.
  assert.match(code, /TO \$\{d\.rank\.next\.name\}/,
    'nothing in ui/stats.js prints the distance to the next tier');
});

test('the other two rank surfaces: the home rail wears the tier, the win overlay never wears the roster', () => {
  // SURFACE 2 — the home rail. The tier rides the existing flight-log mark
  // ("Flight log · BRONZE"), no new control; below Bronze the label is the
  // unchanged word, because the rail does not advertise a rank nobody has.
  // Source assertion, same reasoning as the two above: a prohibition-shaped
  // contract on the whole file, not on one walked path.
  assert.match(code, /Flight log · \$\{rank\.tier\.name\}/,
    'ui/stats.js no longer prints the tier on the home-rail mark');
  assert.match(code, /rank\.tier \? .*Flight log/,
    'the untiered rail label must stay the plain mark');

  // SURFACE 3 — the win/defeat overlay (ui/overlays.js). It may show the
  // band NAME — a property of the table, deliberately non-invertible — and
  // never the roster behind it: not the modes, not a per-seat tier, not the
  // BOT_TIER table. `botModes` may not even be MENTIONED there; bandFor()
  // reads it inside state/stats.js where the hiding rule is enforced.
  const overlays = readFileSync(path.join(ROOT, 'public/src/ui/overlays.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(overlays.includes('botModes'), false,
    'ui/overlays.js touches botModes — the roster must never reach the win screen');
  assert.equal(overlays.includes('BOT_TIER'), false,
    'ui/overlays.js imports the per-personality tier table — that is the breakdown');
  assert.match(overlays, /r\.band/,
    'the overlay stopped showing the band name — the difficulty context is the award’s only legible half');
});
