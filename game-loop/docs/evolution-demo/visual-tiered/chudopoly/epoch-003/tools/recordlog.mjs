#!/usr/bin/env node
/**
 * tools/recordlog.mjs — record a REAL logbook, by playing real games.
 * HARNESS-AGENT-OWNED (ARCHITECTURE.md §1, §8).
 *
 * Sibling of `tools/record.mjs`: that one records SERVER STATES for the fixture
 * library, this one records what the CLIENT ends up with in `chud.stats.v1`
 * after it has watched a run of games go past. `tools/lib/logbook.mjs` then
 * feeds it back into every gate that needs a populated flight log.
 *
 * ── why the panel could not be fixtured by hand ──────────────────────────
 *
 * Every number on the flight log is folded by `state/recorder.js` out of the
 * §4 event stream, and the fold has real edges in it: `win` carries `actor`
 * while `stalemate` carries `winner`; `final_approach_broken` scores a
 * shootdown only when it can attribute one; `set_stolen` is n properties AND
 * one set; a client that arrived late has a clean gap count over a record
 * missing everything before it. A hand-written blob agrees with whoever wrote
 * the reader and with nothing else. This one is produced by the shipping
 * recorder, from the shipping engine, over the wire.
 *
 * ── the shape of the run ─────────────────────────────────────────────────
 *
 * ONE ROOM, N REMATCHES — not N rooms. `server/handlers.js` seeds each game
 * `CHUD_SEED#room.gameCount`, so N fresh rooms would deal the SAME game N
 * times and produce N identical rows; a rematch increments `gameCount` and
 * genuinely varies. It also puts the recorder's hardest case in the recording
 * itself: a rematch reuses the room code and restarts `eventSeq`, which is the
 * exact collision `recorder.newGame()` and the latch key exist for, so a bug
 * there shows up as a missing or doubled row in the output.
 *
 * GAPS ARE RECORDED, NOT SIMULATED. One game in `--gapEvery` has a run of
 * mid-game broadcasts withheld from the page, which is what a reconnect looks
 * like from the client's side: the next tail starts past `maxSeq + 1`,
 * `ui/journal.js` counts the hole, and `recordGame` refuses to let that row set
 * a personal best. The flight log has to mark those rows, so at least one of
 * them has to be real.
 *
 * Output: tools/fixtures/logbook.json — `{ recordedAt, seed, games, gapped, blob }`.
 * Run: node tools/recordlog.mjs [--games 14] [--seed N] [--gapEvery 4]
 */
import fs from 'node:fs';
import {
  FIXTURE_DIR, SEED, ensureDir, parseArgs, launchBrowser, openPage, requireBridge,
  reporter, green, red, dim, bold, EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';
import { startServer } from './serve.mjs';
import { ChudClient, driveGame } from './lib/wsclient.mjs';
import { LOGBOOK_FIXTURE } from './lib/logbook.mjs';

const args = parseArgs();
const seed = args.seed ? Number(args.seed) : SEED;
const games = Number(args.games || 14);
const gapEvery = Number(args.gapEvery || 4);
const maxMs = Number(args.maxMs || 240000);
/** game.js EVENT_TAIL (120) plus slack — see the withheld-window note below. */
const EVENT_TAIL_SLACK = Number(args.tail || 140);

const r = reporter(`recordlog  ${dim(`seed=${seed} games=${games}`)}`);
/* CHUD_GAME_LOG=0. This tool plays a dozen real games, and without it the
 * server appends every one to `logs/games.jsonl` — which `test/stats-logbook.
 * test.js` reads as its corpus of "real games". MEASURED: one recording run
 * turned that test red, because it asserts 100% of real games exceed
 * EVENT_TAIL=120 and a genuine 8-turn win came in at 69 events (room FSVA,
 * 2026-08-07). A harness recorder must not contaminate the corpus another gate
 * measures — and the finding itself is real and is in this round's report. */
const server = await startServer({ seed, env: { CHUD_GAME_LOG: '0' } });
let browser = null;
let code = EXIT_PASS;

try {
  browser = await launchBrowser();
  const h = await openPage(browser, `${server.url}/?harness=1&seed=${seed}`);
  await requireBridge(h.page, 8000);
  // The logbook is per-profile and this run is the profile. Start empty so the
  // recorded blob is exactly these games and not these games plus whatever a
  // previous run left behind.
  await h.page.evaluate(() => { try { localStorage.clear(); } catch { /* n/a */ } });
  await h.page.reload({ waitUntil: 'load' });
  await requireBridge(h.page, 8000);
  r.pass('client booted with an empty logbook');

  // Applications are serialised: `page.evaluate` is async and the socket does
  // not wait, so without a chain two broadcasts can land out of order and the
  // journal counts a gap that never happened on the wire.
  let chain = Promise.resolve();
  let applied = 0;
  let withheld = 0;
  const apply = (msg) => {
    chain = chain
      .then(() => h.page.evaluate((s) => window.__CHUD.applyState(s), msg))
      .then(() => { applied++; })
      .catch(() => { /* a dead page is reported by the assertions below */ });
    return chain;
  };

  const client = new ChudClient(server.wsUrl, { name: 'LOGBOOK' });
  await client.connect();
  await client.send({ type: 'create_room', name: 'LOGBOOK' });
  await client.waitFor((m) => m.type === 'joined', 10000, 'joined');

  // Two bots, two personalities — the same three-seat table tools/playtest.mjs
  // drives, and MEASURED: a four-seat table did not finish inside 90s of harness
  // time, so a run of fourteen of them is not a recording, it is an afternoon.
  // Composition is fixed for the whole run; the VARIETY comes from `gameCount`
  // moving the deck seed, not from reseating.
  let lobby = null;
  for (const mode of ['chud', 'aggressive']) {
    await client.send({ type: 'add_bot', mode });
    lobby = await client.waitFor((m) => m.type === 'state', 10000, 'lobby state');
  }
  await apply(lobby);

  let played = 0;
  let gapped = 0;
  let initial = lobby;

  for (let g = 0; g < games; g++) {
    if (g > 0) {
      // Quiet the finished game's handlers before asking for a new one, then
      // keep pushing states to the page by hand across the changeover.
      client.onState = (msg) => { apply(msg); };
      client.onAny = () => {};
      await client.send({ type: 'rematch' });
      try {
        initial = await client.waitFor(
          (m) => m.type === 'state' && m.game && m.game.phase !== 'finished', 12000, 'rematch',
        );
      } catch (e) {
        r.fail(`rematch ${g} never produced a fresh table: ${e.message}`);
        break;
      }
    }

    /* The withheld window: a run of mid-game broadcasts the page never sees.
     *
     * MEASURED, and the first version of this did NOT work: withholding a fixed
     * count of broadcasts produced 0 gapped rows out of 14 games. The server
     * ships the last EVENT_TAIL (=120) events on EVERY broadcast, so a hole of a
     * dozen broadcasts is entirely covered by the next tail — `ui/journal.js`
     * sees `tail[0].seq <= maxSeq + 1` and correctly reports no gap, because
     * nothing was actually lost. That is the real behaviour and it is the reason
     * a short disconnect costs a player nothing.
     *
     * A gap is therefore a fact about EVENT SEQUENCE, not about broadcasts: the
     * window has to outrun the tail. So it withholds until the game's `eventSeq`
     * has advanced more than EVENT_TAIL past the last one the page saw, which is
     * exactly the condition under which a reconnecting client cannot be caught
     * up — and it is what `gaps > 0` means on a stored row. */
    const gapThis = gapEvery > 0 && g > 0 && g % gapEvery === 0;
    let n = 0;
    let lastSeen = 0;
    let gapOpen = false;
    const drive = await driveGame(client, {
      maxMs,
      initialState: initial,
      planOpts: { turnTimeout: 60, responseTimeout: 30 },
      onState: (msg) => {
        n++;
        const seq = Number(msg.game?.eventSeq) || 0;
        const finished = msg.game?.phase === 'finished';
        if (gapThis && !finished) {
          if (!gapOpen && n > 8) { gapOpen = true; lastSeen = seq; }
          // EVENT_TAIL is 120 (game.js:318); +20 of slack so the resume is
          // unambiguously past it rather than exactly on the boundary.
          if (gapOpen && seq - lastSeen <= EVENT_TAIL_SLACK) { withheld++; return; }
          gapOpen = false;
        }
        apply(msg);
      },
    });
    await chain;

    if (!drive.finished) {
      r.fail(`game ${g + 1} never finished (${drive.timedOut ? 'timed out' : 'socket closed'})`);
      break;
    }
    played++;
    if (gapThis) gapped++;
    process.stdout.write(dim(`  · game ${played}/${games}`
      + `${gapThis ? ' (with a withheld window)' : ''}\n`));
  }

  client.close();
  await chain;

  // The store coalesces writes at 400ms and flushes on `pagehide`; ask for the
  // flush the way a phone player's OS does rather than waiting on a timer.
  await h.page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await h.page.waitForTimeout(200);

  const raw = await h.page.evaluate(() => {
    try { return localStorage.getItem('chud.stats.v1'); } catch { return null; }
  });
  let blob = null;
  try { blob = raw ? JSON.parse(raw) : null; } catch { blob = null; }

  if (!blob) r.fail('nothing in chud.stats.v1 — the recorder never banked a row');
  else if (blob.recent.length !== played) {
    r.fail(`${played} game(s) played but ${blob.recent.length} row(s) banked — `
      + 'the per-game latch is dropping or doubling games');
  } else r.pass(`${blob.recent.length} row(s) banked from ${played} real game(s)`);

  if (blob) {
    const withGaps = blob.recent.filter((x) => x.gaps > 0).length;
    if (gapEvery > 0 && gapped > 0 && withGaps === 0) {
      r.fail(`${gapped} game(s) had broadcasts withheld and NONE came out gapped — `
        + 'the journal is not seeing the holes, so the panel cannot mark them');
    } else {
      r.pass(`${withGaps} row(s) carry gaps>0 ${dim(`(${withheld} broadcast(s) withheld)`)}`);
    }
    const T = blob.totals;
    r.info(dim(`  games ${T.games} · wins ${T.wins} · armed ${T.armed} · converted ${T.converted}`
      + ` · shot down ${T.shotDown} · shootdowns ${T.shootdowns} · stolen ${T.propertiesStolen}`
      + ` · lost ${T.propertiesLost} · best run ${T.bestWinStreak}`));
    if (T.armed === 0) {
      r.warn('no seat of yours ever armed a final approach in this run — band 3 will be all '
        + 'zeros. Re-run with more games before trusting a screenshot of it.');
    }

    ensureDir(FIXTURE_DIR);
    fs.writeFileSync(LOGBOOK_FIXTURE, JSON.stringify({
      recordedAt: new Date().toISOString(),
      seed,
      games: played,
      gapped: blob.recent.filter((x) => x.gaps > 0).length,
      note: 'Recorded by tools/recordlog.mjs from real games through the real client. '
        + 'Do not hand-edit — regenerate it.',
      blob,
    }, null, 1) + '\n');
    r.pass(`wrote ${LOGBOOK_FIXTURE.replace(/^.*tools\//, 'tools/')} `
      + dim(`${applied} broadcast(s) applied`));
  }

  if (h.errors.length) {
    r.fail(`${h.errors.length} console/page error(s) during the run`);
    for (const e of h.errors.slice(0, 6)) console.log(red(`      ${e}`));
  } else r.pass('zero console/page errors');

  await h.close();
} catch (e) {
  console.log(red(`  ✗ ${e.stack || e.message}`));
  code = EXIT_FAIL;
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.stop();
}

if (r.code !== EXIT_PASS) code = EXIT_FAIL;
console.log(code === EXIT_PASS ? green(bold('recordlog: PASS')) : red(bold('recordlog: FAIL')));
process.exit(code);
