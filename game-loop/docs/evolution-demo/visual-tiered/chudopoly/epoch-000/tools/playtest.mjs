#!/usr/bin/env node
/**
 * tools/playtest.mjs — a full seeded game to the win screen, in the browser (§8).
 *
 * Asserts:
 *   • zero pageerrors and zero console.error for the whole game
 *   • __CHUD.driftCount === 0 — the choreographer's DOM matched every snapshot,
 *     so the animation never lied about the game (§10). Nonzero means reconcile
 *     had to silently correct the table, which is the bug this tool exists for.
 *   • the game actually reaches phase 'finished' with a winner
 *   • __CHUD.lastError is null
 *
 * The seat is driven the same way record.mjs drives one — over a raw socket
 * from Node — while the BROWSER watches the same room as a spectator seat. That
 * keeps the move policy in one place and means a client bug cannot deadlock the
 * game it is supposed to be rendering.
 *
 * Exits 2 (PENDING CLIENT) until public/src/ exposes window.__CHUD (§9).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  FIXTURE_DIR, SEED, parseArgs, launchBrowser, openPage, requireBridge, reporter,
  readJSON, green, red, yellow, dim, bold, EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';
import { startServer } from './serve.mjs';
import { ChudClient, driveGame } from './lib/wsclient.mjs';

const args = parseArgs();
const seed = args.seed ? Number(args.seed) : SEED;
const maxMs = Number(args.maxMs || 240000);
/** Broadcast cadence for the ANIMATED pass. 120ms is the measured floor a fast
 *  bot table produces, and the cadence at which the motion agent measured 6
 *  drift corrections and 42% of sfx dropped. */
const cadence = Number(args.cadence || 120);
const animMs = Number(args.animMs || 40000);

const r = reporter(`playtest  ${dim(`seed=${seed}`)}`);
const server = await startServer({ seed });
let browser = null;
let code = EXIT_PASS;

try {
  browser = await launchBrowser();
  const h = await openPage(browser, `${server.url}/?harness=1&seed=${seed}`);
  // Fail fast: a missing bridge is a PENDING, not a 45s selector wait.
  await requireBridge(h.page, 8000);
  r.pass('client booted with the __CHUD bridge');

  const version = await h.page.evaluate(() => window.__CHUD.version);
  if (version !== 1) r.fail(`__CHUD.version is ${version}, expected 1 (§9)`);
  else r.pass('bridge contract v1');

  // ---- play a real game over a socket, feeding the page every state --------
  const client = new ChudClient(server.wsUrl, { name: 'PLAYTEST' });
  await client.connect();
  await client.send({ type: 'create_room', name: 'PLAYTEST' });
  await client.waitFor((m) => m.type === 'joined', 10000, 'joined');

  const lobby = [];
  for (const mode of ['chud', 'aggressive']) {
    await client.send({ type: 'add_bot', mode });
    lobby.push(await client.waitFor((m) => m.type === 'state', 10000, 'lobby state'));
  }

  let applied = 0;
  let applyError = null;
  const drive = await driveGame(client, {
    maxMs,
    initialState: lobby[lobby.length - 1],
    planOpts: { turnTimeout: 60, responseTimeout: 30 },
    onState: async (msg) => {
      try {
        await h.page.evaluate((state) => window.__CHUD.applyState(state), msg);
        applied++;
      } catch (e) {
        applyError = applyError || e.message;
      }
    },
  });
  client.close();

  if (applyError) r.fail(`__CHUD.applyState threw: ${applyError}`);
  else r.pass(`${applied} state broadcast(s) applied to the client`);

  if (drive.finished) r.pass(`game reached 'finished' in ${drive.stateCount} broadcasts`);
  else r.fail(`game never finished (${drive.timedOut ? 'timed out' : 'socket closed'}) after ${drive.stateCount} broadcasts`);

  const winner = drive.lastState?.game?.winner;
  if (drive.finished && !winner) r.fail("phase is 'finished' but no winner is set");
  else if (winner) r.pass(`winner recorded ${dim(String(winner))}`);

  // ---- the rank movement on the win screen ---------------------------------
  // Through the REAL path, not staging: the recorder banks the finished game
  // (once, latched), journal emits GAME_BANKED, overlays paints the cached
  // movement inside renderWin — win AND defeat both show it. The block must
  // carry the award and the band NAME, and may never carry a personality:
  // the roster is hidden by standing owner constraint (state/stats.js), and
  // the band is deliberately non-invertible so the award cannot reveal it.
  if (drive.finished) {
    const rank = await h.page.evaluate(() => {
      const host = document.getElementById('win-rank');
      return { present: !!host && !host.hidden, text: host ? host.textContent : '' };
    });
    if (!rank.present) r.fail('no rank movement on the win screen (#win-rank absent or hidden)');
    else if (!/\+\d+ SP/.test(rank.text)) r.fail(`#win-rank carries no award: "${rank.text}"`);
    else if (!/ROUTINE|CONTESTED|HOSTILE/.test(rank.text)) r.fail(`#win-rank names no band: "${rank.text}"`);
    else r.pass(`rank movement on the win screen ${dim(rank.text.slice(0, 44))}`);
    if (/chud|aggressive|conservative|neutral|random/i.test(rank.text)) {
      r.fail(`the win screen leaked a bot personality: "${rank.text.slice(0, 60)}"`);
    } else r.pass('no personality on the win screen — band name only');
  }

  // ---- bridge assertions ---------------------------------------------------
  await h.page.evaluate(() => window.__CHUD.drainEvents?.()).catch(() => {});
  const bridge = await h.page.evaluate(() => ({
    drift: window.__CHUD.driftCount,
    lastError: window.__CHUD.lastError ? String(window.__CHUD.lastError) : null,
    sfx: (window.__CHUD.sfxLog || []).length,
    haptics: (window.__CHUD.hapticLog || []).length,
  }));

  if (bridge.drift === 0) r.pass('driftCount 0 — every animation left the DOM matching the snapshot (§10)');
  else r.fail(`driftCount ${bridge.drift} — reconcile had to correct the table ${bridge.drift}× (§10 requires 0)`);

  if (bridge.lastError) r.fail(`__CHUD.lastError: ${bridge.lastError}`);
  else r.pass('__CHUD.lastError is null');

  if (bridge.sfx > 0) r.pass(`sfx dispatched (${bridge.sfx} events)`);
  else r.fail('no sfx events reached the recorder — §7 audio path is dead');
  if (bridge.haptics > 0) r.pass(`haptics dispatched (${bridge.haptics} patterns)`);
  else r.fail('no haptic patterns recorded — §7 haptics path is dead');

  if (h.errors.length) {
    r.fail(`${h.errors.length} console/page error(s)`);
    for (const e of h.errors.slice(0, 8)) console.log(red(`      ${e}`));
  } else r.pass('zero console/page errors across the whole game');

  await h.close();

  /* ══════════════════════ ANIMATED PASS (P7 round 1) ═══════════════════════
   *
   * Everything above runs under `setInstant(true)` — the choreographer places
   * cards instead of performing them, its queue is never more than one job
   * deep, and its backpressure/collapse path is NEVER ENTERED. So `driftCount
   * === 0` above proves the reconcile logic is sound and proves nothing at all
   * about the code path a player actually sees.
   *
   * The motion agent measured what that hid, on the same transcript at a 120ms
   * cadence with animation ON: 6 drift corrections and 42% of all sfx dropped,
   * including HALF the game's set completions and both `final_approach` cues —
   * §3.10's dramatic peak, silent. The gate said PASS through all of it.
   *
   * This pass replays a recorded transcript at a fixed fast cadence with
   * `setInstant(false)` and asserts two things:
   *   1. driftCount is still 0 — collapsing may drop MOTION, never TRUTH (§10)
   *   2. every BIG-moment event still gets a cue — collapsing may drop MOTION,
   *      never MEANING. The BIG set is read out of the client itself so this
   *      assertion cannot drift from the implementation it gates.
   * ---------------------------------------------------------------------- */
  const transcript = (() => {
    for (const name of ['session-3p.json', 'arc.json']) {
      const f = path.join(FIXTURE_DIR, name);
      if (fs.existsSync(f)) {
        const j = readJSON(f);
        const states = Array.isArray(j) ? j : j.states;
        if (states?.length >= 6) return { name, states };
      }
    }
    return null;
  })();

  if (!transcript) {
    r.fail('no transcript fixture to replay — run npm run tool:record (the animated pass cannot run)');
  } else {
    const budgetStates = Math.max(6, Math.floor(animMs / cadence));
    const states = transcript.states.slice(0, budgetStates);
    console.log(dim(`  animated pass: ${states.length}/${transcript.states.length} states from ${transcript.name} at ${cadence}ms, setInstant(false)`));

    const a = await openPage(browser, `${server.url}/?harness=1&seed=${seed}&mode=animated`);
    await requireBridge(a.page, 8000);
    await a.page.evaluate(() => window.__CHUD.setInstant(false));

    // Instrument BEFORE any state lands. CHOREO_SFX carries the engine event it
    // came from, so cue survival is measured per-event-seq rather than by
    // counting sounds — a count can be met by the wrong sounds.
    const instrumented = await a.page.evaluate(async () => {
      try {
        const bus = await import('/src/core/bus.js');
        const ch = await import('/src/anim/choreographer.js');
        window.__CHUD_MOTION = {
          cued: new Set(), sfxByType: {},
          isBig: (t) => !!ch.isBigMoment?.(t),
          pending: () => (ch.pending ? ch.pending() : 0),
        };
        bus.on(bus.EVENTS.CHOREO_SFX, (d) => {
          const seq = d?.ev?.seq;
          if (seq != null) window.__CHUD_MOTION.cued.add(seq);
          const t = d?.ev?.t || '?';
          window.__CHUD_MOTION.sfxByType[t] = (window.__CHUD_MOTION.sfxByType[t] || 0) + 1;
        });
        return typeof ch.isBigMoment === 'function';
      } catch (e) { return `err:${e.message}`; }
    });
    if (instrumented !== true) {
      r.fail(`cannot read the choreographer's big-moment set (${instrumented}) — `
        + 'anim/choreographer.js must export isBigMoment(t) so this gate cannot drift from it');
    }

    const started = Date.now();
    for (const s of states) {
      await a.page.evaluate((st) => window.__CHUD.applyState(st), s);
      await a.page.waitForTimeout(cadence);
    }
    // Let the queue finish honestly — no drainEvents(), which would clear it.
    await a.page.waitForFunction(
      () => (window.__CHUD_MOTION?.pending?.() ?? 0) === 0, null, { timeout: 4000 },
    ).catch(() => {});
    await a.page.waitForTimeout(1500);

    const seen = new Map();          // seq → t, every event the server broadcast
    for (const s of states) for (const ev of s.game?.events || []) {
      if (ev.seq != null) seen.set(ev.seq, ev.t);
    }

    const anim = await a.page.evaluate((entries) => {
      const M = window.__CHUD_MOTION;
      const missed = [];
      const bigTotal = { n: 0 };
      for (const [seq, t] of entries) {
        if (!M?.isBig(t)) continue;
        bigTotal.n++;
        if (!M.cued.has(seq)) missed.push(`${t}#${seq}`);
      }
      return {
        drift: window.__CHUD.driftCount,
        hitstops: typeof window.__CHUD.hitstopCount === 'number' ? window.__CHUD.hitstopCount : null,
        driftLog: (window.__CHUD.driftLog || []).slice(0, 8),
        lastError: window.__CHUD.lastError ? String(window.__CHUD.lastError) : null,
        sfx: (window.__CHUD.sfxLog || []).length,
        fx: (window.__CHUD.fxLog || []).length,
        bigTotal: bigTotal.n,
        missed,
        sfxByType: M?.sfxByType || {},
        // §7 voice cap: a big moment must never lose its voice to a card
        // slide. audiotest asserts the same counter against a synthetic burst;
        // this is the live one, over a real event stream at a real cadence.
        audio: window.__CHUD.audio?.stats ? (() => {
          const st = window.__CHUD.audio.stats();
          return { droppedPriority: st.droppedPriority, dropped: st.dropped, peakVoices: st.peakVoices };
        })() : null,
      };
    }, [...seen.entries()]);

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (anim.drift === 0) {
      r.pass(`[animated ${secs}s] driftCount 0 with animation ON at ${cadence}ms (§10)`);
    } else {
      r.fail(`[animated] driftCount ${anim.drift} at ${cadence}ms with animation ON — `
        + 'the collapse path corrupts the table (§10 requires 0)');
      for (const d of anim.driftLog) r.info(typeof d === 'string' ? d : JSON.stringify(d));
    }

    if (anim.bigTotal === 0) {
      r.fail('[animated] the replayed transcript contains no big-moment events — '
        + 'cue survival is unproven; re-record a longer transcript');
    } else if (anim.missed.length) {
      r.fail(`[animated] ${anim.missed.length}/${anim.bigTotal} big-moment event(s) produced NO cue `
        + 'under collapse — collapsing may drop motion, never meaning (§7)');
      r.info(anim.missed.slice(0, 12).join(', '));
    } else {
      r.pass(`[animated] all ${anim.bigTotal} big-moment event(s) kept their cue under collapse`);
    }

    if (anim.audio && anim.audio.peakVoices === 0) {
      // No AudioContext without a user gesture (§7), and the harness never
      // makes one — so the live voice budget was never exercised and the
      // counter is trivially 0. Saying PASS here would be the same species of
      // lie this whole round is about. audiotest asserts the same rule offline,
      // where OfflineAudioContext needs no gesture.
      r.warn('[animated] the live voice budget never engaged (no AudioContext without a gesture) — '
        + 'droppedPriority is vacuous here; audiotest asserts it offline');
    } else if (anim.audio && anim.audio.droppedPriority > 0) {
      r.fail(`[animated] ${anim.audio.droppedPriority} priority voice(s) dropped during a real game — `
        + 'a big moment lost its sound to a card slide (§7 voice cap)');
    } else if (anim.audio) {
      r.pass(`[animated] droppedPriority 0 over the whole replay ${dim(`(peak voice load ${anim.audio.peakVoices}, ${anim.audio.dropped} non-priority dropped)`)}`);
    } else {
      r.warn('[animated] __CHUD.audio.stats() absent — the live priority-drop counter was not read');
    }

    /* ART §4's hitstop had ZERO regression coverage: flight.hitstopCount() was
     * exported, correct and measured (40–58ms freezes, one per landing beat) and
     * no tool read it — zeroing HITSTOP_MS shipped green through the whole
     * verify chain. Only the ANIMATED pass can assert it: the instant pass
     * places cards without flights, so no landing ever reaches CONTACT there.
     * The floor is deliberately far below the measured value (see the figure
     * printed by the pass) so cadence jitter cannot flake it — it exists to
     * catch the counter going to ~0, which is what every real regression
     * (HITSTOP_MS zeroed, the arm dropped, contact never detected) looks like. */
    const HITSTOP_FLOOR = 5;
    if (anim.hitstops == null) {
      r.fail('[animated] __CHUD.hitstopCount is absent — the hitstop counter fell off the bridge (§9)');
    } else if (anim.hitstops < HITSTOP_FLOOR) {
      r.fail(`[animated] only ${anim.hitstops} hitstop(s) over the whole replay (floor ${HITSTOP_FLOOR}) — `
        + "ART §4's landing freeze is dead or disarmed");
    } else {
      r.pass(`[animated] ${anim.hitstops} hitstop(s) landed over the replay ${dim(`(floor ${HITSTOP_FLOOR})`)}`);
    }

    /* ══ §0.8's "60fps on a mid phone", finally MEASURED (P9 round 2) ═══════
     *
     * Nothing in the harness had ever sampled a frame time — §0.8 was a claim
     * with no instrument. This replays a slice of the same transcript with the
     * CPU throttled 4× (CDP Emulation.setCPUThrottlingRate — Lighthouse's
     * mid-device convention) and reads real rAF-to-rAF deltas out of the page.
     *
     * The floor is set FROM measurement, not from the wish. Idle machine,
     * 3 runs, 461–486 frames each: p95 25.3 / 25.0 / 25.0 ms — stable to
     * 0.3ms — with p50 8.4–8.5 and p99 ranging 49.9–58.3. The assertion is
     * on p95 (the percentile that did not move) at 2× the measured value:
     * 50ms. This is deliberately a collapse-detector, not a jank-meter —
     * what it exists to catch is the frame loop falling apart under a
     * throttled CPU (a main-thread stall, a layout storm, an unthrottled
     * per-frame allocation), any of which doubles p95 outright. A 20%
     * regression will NOT trip it; tighten only with more idle-machine data.
     * p99 is printed but never gated: it brushes the budget on a clean build,
     * so gating it would flake by construction.
     *
     * It runs AFTER `anim` is read, so the throttle cannot contaminate the
     * drift/cue/hitstop numbers above; the console-error verdict below stays
     * downstream of it on purpose (an error under throttle is still an
     * error). Provably red: `--frame-budget 10` (or any figure under the
     * machine's vsync interval) fails it on demand.
     */
    const FRAME_BUDGET_MS = Number(args['frame-budget'] || 50);
    const FRAME_SEGMENT = Math.min(40, states.length);
    const fcdp = await a.context.newCDPSession(a.page);
    await fcdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await a.page.evaluate(() => {
      const S = { deltas: [], last: 0, on: true };
      window.__CHUD_FRAMES = S;
      const tick = (t) => {
        if (S.last) S.deltas.push(t - S.last);
        S.last = t;
        if (S.on) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    for (const s of states.slice(0, FRAME_SEGMENT)) {
      await a.page.evaluate((st) => window.__CHUD.applyState(st), s);
      await a.page.waitForTimeout(cadence);
    }
    const deltas = await a.page.evaluate(() => {
      const S = window.__CHUD_FRAMES; S.on = false; return S.deltas;
    });
    await fcdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    if (deltas.length < 60) {
      r.fail(`[animated] frame sample too thin to mean anything (${deltas.length} deltas over `
        + `${FRAME_SEGMENT} states) — the rAF sampler is not seeing the replay`);
    } else {
      const sorted = [...deltas].sort((x, y) => x - y);
      const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
      const p50 = q(0.5).toFixed(1);
      const p95 = q(0.95);
      const p99 = q(0.99).toFixed(1);
      if (p95 > FRAME_BUDGET_MS) {
        r.fail(`[animated] p95 frame time ${p95.toFixed(1)}ms under a 4×-throttled CPU (budget ${FRAME_BUDGET_MS}ms) `
          + `— §0.8's mid-phone frame loop is falling apart ${dim(`(${deltas.length} frames, p50 ${p50}, p99 ${p99})`)}`);
      } else {
        r.pass(`[animated] p95 frame time ${p95.toFixed(1)}ms under a 4×-throttled CPU `
          + `${dim(`(budget ${FRAME_BUDGET_MS}ms; ${deltas.length} frames, p50 ${p50}, p99 ${p99})`)}`);
      }
    }

    if (anim.sfx === 0) r.fail('[animated] no sfx at all reached the recorder');
    if (anim.fx === 0) r.fail('[animated] no fx cue at all reached the recorder (§5 juice path dead)');
    if (anim.lastError) r.fail(`[animated] __CHUD.lastError: ${anim.lastError}`);
    if (a.errors.length) {
      r.fail(`[animated] ${a.errors.length} console/page error(s) with animation on`);
      for (const e of a.errors.slice(0, 6)) console.log(red(`      ${e}`));
    } else r.pass('[animated] zero console/page errors with animation on');

    await a.close();
  }

  code = r.code;
} catch (e) {
  console.log(red(`  ✗ ${e.stack || e.message}`));
  code = EXIT_FAIL;
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.stop();
}

console.log(code === EXIT_PASS ? green(bold('playtest: PASS')) : red(bold('playtest: FAIL')));
process.exit(code);
