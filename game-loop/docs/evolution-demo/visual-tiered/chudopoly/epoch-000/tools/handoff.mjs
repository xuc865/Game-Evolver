#!/usr/bin/env node
/**
 * tools/handoff.mjs — the second game of a session. Is the first one gone? (§8)
 *
 * OWNER BUG, 2026-08-07: "when starting a new game it briefly shows your
 * cards/hand from the last game (says offline) then syncs lets fix that bug so
 * it flows better."
 *
 * ── WHAT WAS MEASURED, BEFORE THE FIX ────────────────────────────────────
 * This exact drive — quick play → Leave game → quick play, 1280×800 headless
 * Chromium against a real server — on the shipped build:
 *
 *   after the leave   store.snapshot null, and SEVEN card nodes of the finished
 *                     game still parented in #zone-hand
 *   +48ms             #screen-game unhidden with all seven of them fanned
 *                     face-up, under a label reading "Hand 0"
 *   +168ms            the new deal arrives ON TOP of them: 11 nodes in a hand
 *                     that holds 7, then 12
 *   +1799ms           the choreographer's TERMINAL reconcile finally culls the
 *                     last game — 1.75s of two games on one table
 *   +324ms after the leave, a toast: "Offline — held, and sent the moment the
 *                     connection is back", over a game the player just started
 *
 * Two causes, both fixed, both watched here:
 *   • Nothing in the client had ever removed a card node except reconcile()'s
 *     step 2, and reconcile only runs when a NEW snapshot arrives — at the END
 *     of a choreographer job. So the felt outlived its session. §10 says the
 *     snapshot is truth; a null snapshot has to mean an empty table.
 *     (table.clear(), called by ui/screens.js endSession and by main.js on
 *     store.applyState's `fresh`.)
 *   • ui/home.js calls socket.connect() and send.quickPlay() in one tick, so
 *     the message is always queued before the socket can be open.
 *     announceQueue() suppressed that on a fresh boot, but `everOpened` was per
 *     PAGE and not per session — so every game after the first greeted a
 *     deliberate Quick Play with an outage notice. (net/socket.js disconnect().)
 *
 * ── WHY IT IS A FRAME SAMPLER AND NOT A SCREENSHOT ───────────────────────
 * The defect's whole nature is that it is BRIEF. A capture at a fixed delay
 * either lands inside the window or does not, and a gate that depends on that
 * is a coin toss. So a page-side rAF loop records every frame from the press to
 * the settle, and the assertion is over all of them: no frame in which the game
 * screen is visible and a node from the previous game is in the document.
 *
 * IDENTITY, NOT CARD ID. Both games are dealt from one deck, so ids repeat
 * across games — an id match proves nothing. Every node alive at the end of
 * game 1 is stamped `data-old-game`, and the stamp travels with the NODE.
 *
 * ── AND THE OTHER HALF OF "FLOWS BETTER" ─────────────────────────────────
 * An empty table is not the goal either; the goal is that the handoff reads as
 * the start of something. So this also asserts the shape of the arrival: the
 * first frame the table is visible has an EMPTY hand, and the cards arrive
 * afterwards, off the deck, through the choreographed deal — a table that is
 * dealt to, not one that is repainted.
 *
 * Exits 0 pass / 1 fail / 2 the client bridge is not there yet.
 */
import {
  parseArgs, launchBrowser, openPage, requireBridge, reporter,
  dim, red, SEED, EXIT_PASS,
} from './lib/harness.mjs';
import { startServer } from './serve.mjs';

const args = parseArgs();
const seed = Number(args.seed || SEED);
/** How long the second game gets to finish its opening deal. Measured settle is
 *  ~1.5s on this box; 8s is that with room for a loaded CI machine. */
const dealMs = Number(args.deal || 8000);

const r = reporter(`handoff  ${dim(`seed=${seed}`)}`);

/* The page-side recorder. Serialised into the document: it closes over nothing
   and imports nothing. Installed BEFORE the second Quick Play, after the first
   game's nodes have been stamped. */
const RECORDER = `(() => {
  const frames = [];
  const toasts = [];
  const toast = document.getElementById('toast');
  if (toast) {
    new MutationObserver(() => {
      if (!toast.classList.contains('is-on')) return;
      const text = toast.textContent || '';
      if (toasts[toasts.length - 1]?.text !== text) {
        toasts.push({ t: Math.round(performance.now() - window.__h0), text });
      }
    }).observe(toast, { attributes: true, childList: true, subtree: true, characterData: true });
  }
  window.__h0 = performance.now();
  window.__handoff = { frames, toasts };
  const tick = () => {
    const screen = document.getElementById('screen-game');
    frames.push({
      t: Math.round(performance.now() - window.__h0),
      visible: !!(screen && !screen.hidden),
      // The previous game, by NODE identity — ids repeat across games.
      old: document.querySelectorAll('[data-old-game]').length,
      hand: document.querySelectorAll('#zone-hand [data-card-id]').length,
      cards: document.querySelectorAll('[data-card-id]').length,
      backs: document.querySelectorAll('[data-back]').length,
    });
    if (performance.now() - window.__h0 < ${dealMs}) requestAnimationFrame(tick);
    else window.__handoff.done = true;
  };
  requestAnimationFrame(tick);
})();`;

const server = await startServer({ seed });
let browser = null;

try {
  browser = await launchBrowser();
  const h = await openPage(browser, `${server.url}/?harness=1`, { viewport: { width: 1280, height: 800 } });
  await requireBridge(h.page, 8000);
  // The bridge turns choreography instant; the whole subject here is what the
  // player SEES between the press and the first deal, so put the clock back.
  await h.page.evaluate(() => window.__CHUD.setInstant(false));

  /* ── game 1 ──────────────────────────────────────────────────────────── */
  await h.page.fill('#name-input', 'OWNER');
  await h.page.click('#btn-quick-play');
  await h.page.waitForSelector('#screen-game:not([hidden])', { timeout: 20000 });
  await h.page.waitForFunction(
    () => document.querySelectorAll('#zone-hand [data-card-id]').length >= 5,
    null, { timeout: 20000 });
  await sleep(1800);                                  // let the deal finish

  const g1 = await h.page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[data-card-id]')];
    for (const n of nodes) n.dataset.oldGame = '1';   // stamp the NODES
    return { cards: nodes.length, hand: document.querySelectorAll('#zone-hand [data-card-id]').length };
  });
  if (g1.hand >= 5 && g1.cards >= 5) {
    r.pass(`a Quick Play bot game dealt over the page's own socket ${dim(`(${g1.hand} in hand, ${g1.cards} card nodes)`)}`);
  } else {
    r.fail(`the first game never dealt (${g1.cards} card nodes) — nothing to leave behind`);
  }

  /* ── the leave ───────────────────────────────────────────────────────────
     The HUD's ✕ and the win overlay's "Leave room" are ONE registered action
     (ui/overlays.js), so this drives the same teardown a finished game does. */
  const shared = await h.page.evaluate(() => {
    const win = document.getElementById('btn-win-leave');
    const hud = document.querySelector('.hud-right [data-action="leave-room"]');
    return !!win && !!hud && win.dataset.action === hud.dataset.action;
  });
  if (shared) r.pass('the HUD ✕ and the win screen\'s Leave room are one action — this drives both exits');
  else r.fail('the win overlay no longer shares the leave action; this tool is testing only one exit');

  await h.page.click('.hud-right [data-action="leave-room"]');
  await h.page.waitForSelector('#screen-home:not([hidden])', { timeout: 8000 });
  const left = await h.page.evaluate(() => ({
    snapshot: !!window.__CHUD.snapshot,
    old: document.querySelectorAll('[data-old-game]').length,
    cards: document.querySelectorAll('[data-card-id]').length,
    backs: document.querySelectorAll('[data-back]').length,
  }));
  if (left.snapshot) r.fail('the store still holds a snapshot after leaving — reset() did not run');
  else if (left.cards === 0 && left.backs === 0) {
    r.pass('the felt went with the session — zero card nodes, zero backs, zero snapshot');
  } else {
    r.fail(`the session ended with ${left.cards} card node(s) and ${left.backs} back(s) still on the felt `
      + '(§10: the snapshot is truth, and it is null)');
  }

  /* ── game 2, frame by frame ─────────────────────────────────────────────── */
  await h.page.evaluate(RECORDER);
  await h.page.click('#btn-quick-play');
  await h.page.waitForFunction(() => window.__handoff?.done === true, null, { timeout: dealMs + 10000 });
  const rec = await h.page.evaluate(() => window.__handoff);
  const frames = rec.frames;
  const shown = frames.filter(f => f.visible);

  if (!shown.length) {
    r.fail('the second game never reached the table — nothing was sampled');
  } else {
    r.pass(`${frames.length} frame(s) sampled across the handoff `
      + dim(`(table visible from +${shown[0].t}ms)`));
  }

  // THE ASSERTION THIS TOOL EXISTS FOR.
  const contaminated = shown.filter(f => f.old > 0);
  if (!contaminated.length) {
    r.pass('the last game was never on the new game\'s table — 0 stale node(s) in every visible frame');
  } else {
    const first = contaminated[0];
    const last = contaminated[contaminated.length - 1];
    r.fail(`the previous game was visible on ${contaminated.length} frame(s), +${first.t}ms → +${last.t}ms `
      + `(up to ${Math.max(...contaminated.map(f => f.old))} of its card nodes) — §10`);
  }
  // Anywhere at all, even under a hidden screen: a node that survives the
  // teardown is one reconcile away from being seen again.
  const survivors = Math.max(...frames.map(f => f.old), 0);
  if (survivors === 0) r.pass('and none of its nodes survived anywhere in the document');
  else r.fail(`${survivors} node(s) from the last game outlived it in the document`);

  // The shape of the arrival: dealt to, not repainted into.
  const firstVisible = shown[0];
  const filled = shown.find(f => f.hand >= 5);
  if (firstVisible && filled && firstVisible.hand === 0 && filled.t > firstVisible.t) {
    r.pass(`the table arrives empty and is dealt to ${dim(`(hand 0 at +${firstVisible.t}ms → ${filled.hand} at +${filled.t}ms)`)}`);
  } else if (firstVisible?.hand > 0) {
    r.fail(`the table's first visible frame already held ${firstVisible.hand} hand card(s) — `
      + 'the deal was a repaint, not a deal');
  } else {
    r.fail('the second game never filled a hand within the deal budget');
  }
  const deckAtArrival = firstVisible?.backs ?? 0;
  if (deckAtArrival > 0) r.pass(`and it arrives on a stacked deck ${dim(`(${deckAtArrival} back(s) at +${firstVisible.t}ms)`)}`);
  else r.warn('the deck had no backs on the first visible frame — the deal comes off an empty pile');

  // The other half the owner named.
  const offline = rec.toasts.filter(t => /offline|reconnect/i.test(t.text));
  if (!offline.length) {
    r.pass(`no outage was announced over a game the player started ${dim(`(${rec.toasts.length} toast(s): ${rec.toasts.map(t => `"${t.text}"`).join(', ') || 'none'})`)}`);
  } else {
    r.fail(`the new game was greeted with ${offline.map(t => `"${t.text}" at +${t.t}ms`).join(', ')} — `
      + 'net/socket.js announceQueue() is treating a deliberate connect as an outage');
  }

  const after = await h.page.evaluate(() => ({
    drift: window.__CHUD.driftCount,
    err: window.__CHUD.lastError ? String(window.__CHUD.lastError) : null,
    deal: (window.__CHUD.sfxLog || []).filter(s => /deal|draw/.test(s.name)).length,
    phase: window.__CHUD.snapshot?.phase || null,
  }));
  if (after.phase === 'playing') r.pass('the second game is live and playable');
  else r.fail(`the second game is in phase ${after.phase}`);
  if (after.drift === 0) r.pass('driftCount 0 — the emptied felt reconciled to the new snapshot exactly (§10)');
  else r.fail(`driftCount ${after.drift} across the handoff — clearing the felt lost the choreographer's claims`);
  if (after.deal > 0) r.pass(`the opening deal was performed, not skipped ${dim(`(${after.deal} deal/draw cue(s))`)}`);
  else r.fail('no deal cue fired for the second game — the table was repainted, not dealt');
  if (after.err) r.fail(`__CHUD.lastError: ${after.err}`);

  if (h.errors.length) {
    r.fail(`${h.errors.length} console/page error(s) across the handoff`);
    for (const e of h.errors.slice(0, 5)) console.log(red(`      ${e}`));
  } else r.pass('zero console/page errors across the handoff');

  await h.close();
} catch (err) {
  r.fail(`handoff threw: ${err.message}`);
} finally {
  await browser?.close();
  await server.stop();
}

process.exit(r.finish('handoff'));

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }
