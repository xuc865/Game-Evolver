#!/usr/bin/env node
/**
 * tools/tabaway.mjs — the tab was backgrounded. Does the table come back? (§8)
 *
 * OWNER BUG, 2026-08-07: "I tabbed out of a bot game earlier went back in and
 * everything really froze and doesnt let me play cards so its just not working
 * right there."
 *
 * There was no `visibilitychange`, `document.hidden` or `visibilityState`
 * handler anywhere in the client, and §0.6's one clock is rAF-driven — so the
 * suspicion was the client: a backgrounded tab stops producing frames, the
 * clock stops, `clock.wait()` never resolves, the choreographer's drain parks
 * mid-job and the server keeps broadcasting into a queue nobody is draining.
 * This tool exists to settle that with numbers rather than reasoning, and then
 * to keep the answer true.
 *
 * ── WHAT A BACKGROUNDED TAB ACTUALLY IS, AND WHY IT IS FAKED ──────────────
 * Headless Chromium will not background a tab for you. `bringToFront()` on a
 * second page leaves the first at `visibilityState: 'visible'` and 60fps
 * (measured: 480 frames delivered across a 4s "background"), every harness tool
 * launches with `--disable-background-timer-throttling
 * --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`,
 * and `Page.setWebLifecycleState('frozen')` is a no-op headless (measured: 300
 * frames delivered while "frozen"). CDP has no visibility override.
 *
 * So the four things a real background does, done to the page directly:
 *   • requestAnimationFrame stops delivering. Callbacks are PARKED, not
 *     dropped, and every parked callback is released in one frame on return —
 *     which is what a real browser does and is the thing that makes the return
 *     interesting.
 *   • document.hidden / visibilityState answer honestly, and a real
 *     `visibilitychange` event is dispatched on the document.
 *   • setTimeout is clamped to 1000ms with --throttle (Chrome's background
 *     clamp), so a watchdog that rides a timer is exercised at the rate it
 *     will really get.
 *   • --offline drops the socket for the absence. This is the owner's chain:
 *     a frozen renderer stops answering the server's 15s WebSocket ping, the
 *     liveness reaper terminates the socket, the seat is handed to a bot, and
 *     the client's own 2s retry reconnects while the tab is still hidden.
 *
 * ── THE TWO ABSENCES ──────────────────────────────────────────────────────
 *   backlog  a whole recorded session (137 states, 233 events) is applied to a
 *            page whose clock is stopped, then the tab returns. Answers "is it
 *            a permanent stall or a slow drain?" — and the answer is neither:
 *            anim/choreographer.js's backpressure caps the queue at 3 jobs no
 *            matter how long you are away, so the return costs one collapse,
 *            not a replay of the absence.
 *   dropped  a real Quick Play bot game, a real socket, a real reconnect. The
 *            assertion is not about frames at all: the GAME must still be
 *            moving when you get back. It was not — see server/handlers.js
 *            reclaimFromBot.
 *
 * Exits 0 pass / 1 fail / 2 the client bridge is not there yet.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  FIXTURE_DIR, SEED, parseArgs, launchBrowser, openPage, requireBridge, reporter,
  dim, red, EXIT_PASS,
} from './lib/harness.mjs';
import { startServer } from './serve.mjs';

const args = parseArgs();
const seed = Number(args.seed || SEED);
/** How long the tab is away. Long enough that a real game moves several turns;
 *  short enough that the room reaper (30s of no live human) is not what this
 *  tool is measuring — CHUD_REAP_MS is raised below for the same reason. */
const awayMs = Number(args.away || 12000);
/** The budget the table has to become playable again after the tab returns.
 *  Measured settle time for a full 233-event absence is 1.22s; 5s is that with
 *  room for a loaded CI box, and it is still an order of magnitude below
 *  "the player reloads the page". */
const budgetMs = Number(args.budget || 5000);
const throttleTimers = args.throttle !== 'off';

const r = reporter(`tabaway  ${dim(`seed=${seed} away=${awayMs}ms`)}`);

/* The page-side background gate. Serialised into the document, so it closes over
   nothing and imports nothing. */
const GATE = `(() => {
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  const st = window.setTimeout.bind(window);
  let hidden = false;
  let nextId = 900000;
  const parked = new Map();
  let peak = 0;
  window.requestAnimationFrame = (cb) => {
    if (!hidden) return raf(cb);
    const id = nextId++; parked.set(id, cb);
    if (parked.size > peak) peak = parked.size;
    return id;
  };
  window.cancelAnimationFrame = (id) => { if (parked.delete(id)) return; caf(id); };
  if (${throttleTimers}) {
    window.setTimeout = (fn, ms, ...a) => st(fn, hidden ? Math.max(1000, ms || 0) : ms, ...a);
  }
  // Every socket the client opens, so the absence can take the connection with
  // it. context.setOffline() fails NEW requests but leaves an ESTABLISHED
  // WebSocket up (measured: no close event, no bot takeover, the whole reclaim
  // path silently untested), and a tab that stops answering the server's 15s
  // ping is closed from the other end anyway — this is that close, on cue.
  const NativeWS = window.WebSocket;
  const sockets = [];
  class TrackedWS extends NativeWS {
    constructor(...a) { super(...a); sockets.push(this); }
  }
  window.WebSocket = TrackedWS;
  Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true });
  Object.defineProperty(document, 'visibilityState',
    { get: () => (hidden ? 'hidden' : 'visible'), configurable: true });
  window.__tab = {
    parked: () => parked.size,
    peak: () => peak,
    dropSocket() {
      let n = 0;
      for (const s of sockets) { if (s.readyState <= 1) { try { s.close(4000, 'tabaway'); n++; } catch (e) { /* gone */ } } }
      return n;
    },
    hide() {
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('blur'));
    },
    show() {
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      // One frame delivers everything that piled up, exactly as the browser does.
      const cbs = [...parked.values()]; parked.clear();
      raf((t) => { for (const cb of cbs) { try { cb(t); } catch (e) { console.error(e); } } });
    },
  };
})();`;

/** Everything a stall diagnosis needs, in one page read. */
const PROBE = () => {
  const B = window.__CHUD;
  const s = B.snapshot;
  const card = document.querySelector('#zone-hand .card');
  let hit = 'no-card';
  if (card) {
    const box = card.getBoundingClientRect();
    const e = document.elementFromPoint(
      Math.round(box.left + box.width / 2), Math.round(box.top + box.height * 0.3));
    hit = !e ? 'none' : (e === card || card.contains(e)) ? 'card'
      : `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}`;
  }
  return {
    frames: B.clock.frames,
    q: B.choreo.pending,
    running: B.choreo.running,
    parked: window.__tab.parked(),
    peakParked: window.__tab.peak(),
    seq: s?.eventSeq ?? null,
    phase: s?.phase ?? null,
    screen: document.querySelector('#screen-game:not([hidden])') ? 'game' : 'other',
    myTurn: !!s && s.currentPlayerId === B.selfId,
    iAnswer: !!s && (s.responders || []).includes(B.selfId),
    vt: document.documentElement.className,
    drift: B.driftCount,
    sfx: (B.sfxLog || []).length,
    err: B.lastError ? String(B.lastError) : null,
    hit,
  };
};

const server = await startServer({
  seed,
  // The 30s room reaper is a different mechanism with its own tests; raising it
  // keeps `--away` a free parameter instead of a cliff at 30s.
  env: { CHUD_REAP_MS: '120000' },
});
let browser = null;
let code = EXIT_PASS;

try {
  browser = await launchBrowser();

  /* ══ ABSENCE 1 — the backlog ══════════════════════════════════════════════
     A whole recorded game applied to a page whose clock is stopped. */
  {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(FIXTURE_DIR, 'session-3p.json'), 'utf8'));
    const h = await openPage(browser, `${server.url}/?harness=1`);
    await h.page.evaluate(GATE);
    await requireBridge(h.page, 8000);
    // The bridge turns choreography instant; this tool is about the REAL timing
    // path, so put it back.
    await h.page.evaluate(() => window.__CHUD.setInstant(false));

    const states = fixture.states;
    for (let i = 0; i < 4; i++) {
      await h.page.evaluate((s) => window.__CHUD.applyState(s), states[i]);
      await sleep(120);
    }
    // The frame baseline is read INSIDE the same evaluate that hides the tab.
    // It used to be a separate PROBE round-trip ~5-15ms earlier, and the clock
    // is still running at 60fps in that gap — so the "frames while hidden"
    // subtraction sometimes charged the gate for a frame that landed while the
    // tab was still visible (measured: 60 → 62, an intermittent red against a
    // ≤1 bound). Atomic baseline, same bound: only the ONE in-flight rAF that
    // was already scheduled when hide() ran is allowed to land afterwards.
    const hiddenAtFrames = await h.page.evaluate(() => {
      window.__tab.hide();
      return window.__CHUD.clock.frames;
    });
    let peakQueue = 0;
    for (let i = 4; i < states.length; i++) {
      await h.page.evaluate((s) => window.__CHUD.applyState(s), states[i]);
      await sleep(40);
      if (i % 12 === 0) {
        const p = await h.page.evaluate(PROBE);
        if (p.q > peakQueue) peakQueue = p.q;
      }
    }
    const away = await h.page.evaluate(PROBE);

    // One frame, not zero: the rAF that was already outstanding when hide() ran
    // still lands, exactly as the in-flight frame does in a real browser. Two
    // would mean the gate is not holding anything.
    const ticked = away.frames - hiddenAtFrames;
    if (ticked <= 1) {
      r.pass(`the clock really stopped while hidden ${dim(`(${ticked} frame in ${states.length - 4} broadcasts)`)}`);
    } else {
      r.fail(`the clock kept ticking while hidden (${hiddenAtFrames} → ${away.frames}) — the gate is not backgrounding the page`);
    }
    // The whole "is it a permanent stall or a slow drain" question. Neither:
    // enqueue() collapses at 4 jobs, so the depth is bounded by the SHAPE of the
    // queue and not by the length of the absence.
    if (peakQueue <= 4) {
      r.pass(`queue depth stayed bounded while away ${dim(`(peak ${peakQueue} jobs across ${states.length - 4} broadcasts)`)}`);
    } else {
      r.fail(`the choreographer queue reached ${peakQueue} jobs — backpressure is not collapsing (§10)`);
    }

    const t0 = Date.now();
    await h.page.evaluate(() => window.__tab.show());
    let settled = null;
    while (Date.now() - t0 < budgetMs) {
      const p = await h.page.evaluate(PROBE);
      if (p.q === 0 && !p.running && p.frames > away.frames) { settled = p; break; }
      await sleep(100);
    }
    const took = Date.now() - t0;
    if (settled) {
      r.pass(`the table caught up ${Math.round(took)}ms after the tab came back ${dim(`(peak ${away.peakParked} parked rAF callbacks)`)}`);
    } else {
      const p = await h.page.evaluate(PROBE);
      r.fail(`the table never settled within ${budgetMs}ms: queue=${p.q} running=${p.running} frames=${p.frames}`);
    }

    const after = await h.page.evaluate(PROBE);
    if (after.drift === 0) r.pass('driftCount 0 — the catch-up left the felt matching the snapshot (§10)');
    else r.fail(`driftCount ${after.drift} after the catch-up — the table and the server disagree`);
    if (after.seq === states[states.length - 1].game.eventSeq) {
      r.pass(`the felt is on the newest state ${dim(`(seq ${after.seq})`)}`);
    } else {
      r.fail(`stuck on seq ${after.seq}, server is at ${states[states.length - 1].game.eventSeq}`);
    }
    if (after.err) r.fail(`__CHUD.lastError: ${after.err}`);
    if (h.errors.length) {
      r.fail(`${h.errors.length} console/page error(s) across the absence`);
      for (const e of h.errors.slice(0, 5)) console.log(red(`      ${e}`));
    } else r.pass('zero console/page errors across the absence');

    await h.close();
  }

  /* ══ ABSENCE 2 — the socket went with it ══════════════════════════════════
     The owner's chain, end to end: a real Quick Play bot game, the tab
     backgrounded, the connection gone for the absence, the client's own resume
     path used to come back. The question this half asks is not "did the client
     catch up" but "is there still a game to come back to". */
  {
    const h = await openPage(browser, `${server.url}/?harness=1`);
    await h.page.evaluate(GATE);
    await requireBridge(h.page, 8000);
    await h.page.evaluate(() => window.__CHUD.setInstant(false));

    await h.page.fill('#name-input', 'OWNER');
    await h.page.click('#btn-quick-play');
    await h.page.waitForSelector('#screen-game:not([hidden])', { timeout: 20000 });
    r.pass('a Quick Play bot game, over the page\'s own socket');

    // Hand the table to the bots, so the absence is spent the way a real one is.
    await endMyTurn(h.page);
    await sleep(1200);

    await h.page.evaluate(() => window.__tab.hide());
    await h.context.setOffline(true);
    const dropped = await h.page.evaluate(() => window.__tab.dropSocket());
    if (dropped > 0) r.pass(`the connection went with the tab ${dim(`(${dropped} socket closed)`)}`);
    else r.fail('no socket to drop — the page never connected');
    await sleep(awayMs);
    await h.context.setOffline(false);
    // Back online while still hidden: net/socket.js retries every 2s and
    // resumeOrConnect() re-claims the seat with the stored token.
    await sleep(4000);
    await h.page.evaluate(() => window.__tab.show());

    const back = await waitFor(h.page, (p) => p.frames > 0 && !p.running, budgetMs);
    if (back.screen === 'game') r.pass('still at the table after the absence');
    else r.fail(`the client left the table (screen=${back.screen}) — the session did not survive`);

    if (back.hit === 'card' || back.hit === 'no-card') {
      r.pass(`nothing is eating the pointer ${dim(`(hand card hit-tests to ${back.hit}, <html> class "${back.vt}")`)}`);
    } else {
      r.fail(`a hand card hit-tests to ${back.hit} — something is covering the table`);
    }

    // Did the absence actually exercise the path? A reconnect that never had a
    // bot to reclaim from proves nothing, and a green tool that tested nothing
    // is worse than a red one.
    if (/reclaimed from bot/.test(server.logs())) {
      r.pass('the seat was taken over by a bot and reclaimed on the resume — the real path ran');
    } else {
      r.warn('the socket never dropped long enough for a bot takeover — the reclaim path was not exercised');
    }

    // THE ASSERTION THIS TOOL WAS WRITTEN FOR. A table you cannot play on
    // because it is a bot's turn is indistinguishable from a frozen client, and
    // the difference is entirely in whether the seq is still moving. So the tool
    // plays: a turn that is ours is ended, and the table is then required to
    // move on its own. Only an answer we owe (a 45s clock the tool will not sit
    // through) is allowed to stand still.
    const first = await h.page.evaluate(PROBE);
    let later = first;
    let acted = 0;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      later = await h.page.evaluate(PROBE);
      if (later.seq > first.seq && !later.myTurn) break;
      if (later.phase === 'finished' || later.iAnswer) break;
      // Up to three attempts, not one: the first End Turn after a resume may
      // land while the catch-up narration is still settling, and a helper that
      // gives up after one try reports a live table as a wedge.
      if (later.myTurn && acted < 3) { acted++; await endMyTurn(h.page); }
      await sleep(500);
    }
    if (later.seq > first.seq || later.phase === 'finished') {
      r.pass(`the game is still being played ${dim(`(seq ${first.seq} → ${later.seq}${acted ? ', after ending our turn' : ''})`)}`);
    } else if (later.iAnswer) {
      r.pass(`the table is waiting on an answer from us ${dim(`(seq ${later.seq}) — a live table, not a wedged one`)}`);
    } else {
      r.fail(`the room is WEDGED: seq stuck at ${later.seq} for 12s, phase ${later.phase}, `
        + `${later.myTurn ? `OUR turn and ${acted} attempt(s) to play it went nowhere` : 'not our turn'}`
        + ' and no answer owed — nobody can move this table again');
      // The diagnosis a wedge needs, in the failure itself: what the client saw
      // and what the server was doing. The round-2 hunt had to re-instrument
      // both halves to learn the "wedge" was a live table and a tap that never
      // produced a click — never make a red run that mute again.
      console.log(dim(`      probe: ${JSON.stringify(later)}`));
      for (const line of server.logs().split('\n').slice(-25)) console.log(dim(`      ${line}`));
    }

    if (later.err) r.fail(`__CHUD.lastError: ${later.err}`);
    // Chromium logs a console error of its own for every WebSocket that cannot
    // be opened, and this tool spends `awayMs` deliberately offline — those are
    // the outage we asked for, not a client defect.
    const real = h.errors.filter((e) => !/WebSocket connection to .* failed/.test(e));
    if (real.length) {
      r.fail(`${real.length} console/page error(s) across the reconnect`);
      for (const e of real.slice(0, 5)) console.log(red(`      ${e}`));
    } else r.pass('zero console/page errors across the reconnect (the outage\'s own WS noise aside)');

    await h.close();
  }
} catch (err) {
  r.fail(`tabaway threw: ${err.message}`);
} finally {
  await browser?.close();
  await server.stop();
}

process.exit(r.finish('tabaway'));

/* ── helpers ─────────────────────────────────────────────────────────────── */

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

async function waitFor(page, ok, ms) {
  const end = Date.now() + ms;
  let last = await page.evaluate(PROBE);
  while (Date.now() < end) {
    last = await page.evaluate(PROBE);
    if (ok(last)) return last;
    await sleep(100);
  }
  return last;
}

/**
 * End the human's turn through the real controls, discarding down to the limit
 * first if the engine's auto-draw put the hand over it. The point is only to
 * hand the table to the bots before the absence — a seat that still holds the
 * turn makes the server wait, and an absence nobody's game moves during is not
 * an absence.
 */
async function endMyTurn(page) {
  // Explicit timeouts on EVERY click: Playwright's default is 30s, and this
  // helper runs inside a 12s wedge deadline — one unactionable control used to
  // eat the whole observation window and turn a live table into a "wedge".
  await page.click('#btn-end-turn', { timeout: 3000 }).catch(() => {});
  await sleep(400);
  // A discard was demanded (a reclaimed seat auto-draws over the limit, so this
  // is the NORMAL first act after a resume, not an edge case). Two lessons are
  // baked in, both learned from a red run that blamed the server:
  //   • a tap must go through the REAL input pipeline (page.mouse) — the tap
  //     path is delivered by the browser's compatibility CLICK after the
  //     pointer pair (interact/pointer.js onUp), and a synthetic
  //     pointerdown/pointerup never produces one, so nothing ever selected;
  //   • a chosen card is marked `is-discarding` (interact/index.js), not
  //     `is-selected` — the old selector re-tapped the same card forever.
  for (let i = 0; i < 8; i++) {
    const kind = await page.evaluate(() => window.__CHUD.mode.kind);
    if (kind !== 'discard') break;
    // The client's own one-tap default fills the selection exactly.
    const auto = await page.$('[data-action="discard-cheapest"]');
    if (auto) {
      await auto.click({ timeout: 1500 }).catch(() => {});
    } else {
      const box = await page.evaluate(() => {
        const card = document.querySelector('#zone-hand .card:not(.is-discarding)');
        if (!card) return null;
        const b = card.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height * 0.3 };
      });
      if (!box) break;
      await page.mouse.click(box.x, box.y);
    }
    await sleep(250);
    await page.click('[data-action="confirm-discard"]', { timeout: 1500 }).catch(() => {});
    await sleep(300);
  }
}
