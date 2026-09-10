#!/usr/bin/env node
/**
 * tools/touchtest.mjs — the mobile gate (§8, §0.9, §2).
 *
 * REWRITTEN P7 round 1. The previous version passed 9/9 while the mobile critic
 * scored the shipped product 5/10 with evidence. Every one of its misses was a
 * gate gap, and each is now a named section below:
 *
 *   §A real touch      old tool dispatched `new PointerEvent()` from page JS, so
 *                      `touch-action` was never consulted and a drag that starts
 *                      horizontally — dead in the product — looked healthy.
 *                      Now every gesture is CDP Input.dispatchTouchEvent.
 *   §B tap targets     old audit selected `button,[role=button],[data-action]`.
 *                      `.propcol` (20px tall, the primary on-table targeting
 *                      surface), hand card strips, `input`, `select` were all
 *                      exempt. Now everything a finger can hit is measured.
 *   §C per surface     old tool measured layout ONCE, in whatever state was
 *                      staged last. Help, settings, side panel, emote, discard,
 *                      win and the scoop confirm were never sized. Now each
 *                      surface is opened and measured.
 *   §D occlusion       old tool used elementsFromPoint, which SKIPS
 *                      pointer-events:none — the hint layer is exactly that, so
 *                      a coach bubble over 83% of CONFIRM PAYMENT was invisible.
 *                      Now: rectangle overlap of veil layers against CTAs.
 *   §E landscape       never measured. `.self-board` was 0px tall at 844×390.
 *   §F soft keyboard   never measured. Chat composer sat 327px under it.
 *   §G dead space      never measured. ~68px of double-counted safe-area.
 *   §H offline         never measured. No reconnect affordance under a dead net.
 *   §I duplicate CTAs  never measured. Two enabled DRAW buttons, 57px apart.
 *
 * P8 ROUND 2. A fresh mobile critic found the gate passing for the wrong
 * reasons. Four of the five findings were about the gate's own integrity, not
 * about coverage, and they are fixed here:
 *
 *   §D was INCAPABLE OF FAILING. This file never reset client storage, and
 *      hints are shown once-ever out of `localStorage` — by the time the
 *      `payment-pending` stage ran, `chud_hints_v1` already held
 *      `["peek","drag","pay"]`, consumed by the live game ninety seconds
 *      earlier in the same run. The layer §D exists to catch could not appear.
 *      `openTouchPage` now clears storage per navigation (the mechanism
 *      harness.mjs already shipped for screenshot.mjs), `auditOcclusion`'s CTA
 *      list is a rule instead of a hand-maintained list of ids (it was missing
 *      `.pile[data-action="open-discard"]`, a primary on-table control), and
 *      `--prove` demonstrates §D going red.
 *
 *   §0.9 was ORDER-DEPENDENT. Same fixture, same viewport: applied as the FIRST
 *      state the hand strips measure [46,46,46,44,42,42,42,56] — three under
 *      44px — and applied after any other state they measure
 *      [47,48,48,46,44,44,44,56] — none under. (A module-level `cssStep` cache
 *      in the client only captures on a layout with no inline margin, so a hand
 *      that has been tightened once holds a stale natural step; that bug is
 *      being fixed separately.) This file staged payment and targeting before
 *      discard-limit and therefore always measured the lucky branch. Every
 *      staged surface is now measured COLD — fresh document, state applied
 *      once, no interaction — and settled by geometry rather than by a sleep.
 *
 *   TAP TARGETS SKIPPED THE REAL HIT AREA. `auditTapTargets` dropped
 *      `opacity: 0` elements, so the visually-hidden `<input>` that IS the
 *      target of a 44×23 settings switch was never measured.
 *
 *   "EVERY INTERACTIVE ELEMENT IS ON-SCREEN" only tested the viewport, never
 *      overflow scrollers — which is why it could not see three of the four
 *      targetable opponent boards sitting at `visibleH 0` in landscape.
 *
 *   PENDING CLIENT WAS FLAKY: exit 2 on 2 of 6 runs with a second headless
 *      Chromium live, from an 8s bridge budget. Now 30s, still strict about
 *      real absence.
 *
 * P9 ROUND 2. The round-2 mobile critic (8/10) verified with real CDP touch
 * that the two remaining landscape reds were this gate OVER-CLAIMING:
 * "clipped by a scrolling ancestor — on-screen and still unreachable" was a
 * geometry walk pretending to be a gesture. The `.opponents` rail scrolls
 * under a real thumb (scrollTop 0→61, partial-seat sliver, edge fade, 5px
 * scrollbar) and `.board-props` scrolls sideways with 39px of the next column
 * showing — both printed as unreachable. Now every clipped/off-viewport
 * control is PROBED with a real dispatched swipe before it may stay red
 * (probeReachability, lib/touch.mjs: ancestor actually scrolled + control
 * became ≥44px reachable + a cold-frame affordance existed — fail any leg and
 * the red stands with the leg named). Both directions are mutation-proven in
 * --prove: a rail nailed shut with overflow:hidden goes red on leg (i), and a
 * working scroller stripped of every affordance goes red on leg (iii).
 *
 * P11 (seat-shuffle repair). 964d382 shuffles quick-play seats, and three of
 * this gate's assumptions broke with it:
 *
 *   THE 40s TURN WAIT only covered "this seat moves first" — one game in
 *      four. Seeded 1337 seats this client LAST, so the wait went red 5/5
 *      (idle and loaded alike; triage 2026-08-08). The budget is now derived
 *      from the table — seats × 60s: the 45s answer clock a bot's charge
 *      against this seat burns while the gate waits, plus ≤10.4s of bot
 *      think time per turn (measured worst wait 65.9s over 5 seeded runs) —
 *      and a rotation check fails fast the moment a full cycle of
 *      turnNumbers passes without this seat ever being current: the genuine
 *      never-comes, which the mutation run watches going red.
 *   WILD-PLACE'S FIXTURE could be recorded wild-less — record.mjs's mid-game
 *      predicate never required a wild — and the driver died 'nowild:… mode
 *      idle', reading like a client regression. The predicate now requires
 *      a wild_property in the recording seat's hand, and the driver's
 *      failure line names the fixture as the thing to re-record.
 *   THE SWIPE PROBE misread two by-design states as layout defects: fan
 *      cards (a swipe on the fan IS drag-play, so the scroller can never
 *      move — 'UNREACHABLE' over-claimed) and anything under an open modal
 *      sheet (covered by design while the sheet is up). Fan candidates are
 *      now probed with a real tap — selection is the fan's reachability
 *      contract (probeFanTap, lib/drivers.mjs) — and sheet-covered
 *      candidates are skipped with the reason printed per surface, never
 *      silently. A card no tap can select, and a control inside the sheet
 *      no swipe can reach, still go red.
 *
 * Exits 2 (PENDING CLIENT) until window.__CHUD exists.
 */
import {
  PHONE, PHONE_DPR, LANDSCAPE, SEED, SHOT_DIR, ensureDir, parseArgs, launchBrowser,
  reporter, green, red, dim, bold, EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';
import {
  openTouchPage, centre, settleLayout, waitForBridge, KEYBOARD_PX, probeReachability,
} from './lib/touch.mjs';
import * as audit from './lib/audit.mjs';
import { loadFixture, stageFixture, quietTransients } from './lib/stage.mjs';
import { installLogbooks } from './lib/logbook.mjs';
import { drive, probeFanTap } from './lib/drivers.mjs';
import { census, observeMarkers } from './lib/census.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './serve.mjs';

const args = parseArgs();
const seed = args.seed ? Number(args.seed) : SEED;
/** See waitForBridge: 8s was measuring the machine, not the client. */
const BRIDGE_MS = 30000;

const r = reporter(`touchtest  ${dim(`${PHONE.width}×${PHONE.height} DPR${PHONE_DPR} + ${LANDSCAPE.width}×${LANDSCAPE.height}, real touch only`)}`);
// The drag-play section (§A) drives a live quick-play game and needs the local
// seat on turn to play a card at all. Seats shuffle in real rooms (owner
// directive), which would seat this client late 3 games in 4 and blow the
// turn-wait budget behind intervening bot response windows — flaking a gate
// that is about touch-action, not seating. The test hook seats roster-order.
const server = await startServer({ seed, env: { CHUD_NO_SEAT_SHUFFLE: '1' } });

/* A PUBLIC room on the ephemeral server, opened BEFORE any page loads, so the
 * home surface renders OPEN TABLES (owner directive 2026-08-07) and its rows
 * are inside every §0.9 audit this file runs on 'home'. The census minted
 * `layer:home-tables` the day the section shipped, and a hidden-when-empty
 * surface no gate can see is the exact failure tools/coverage.mjs exists for.
 * The socket stays open for the whole run — a lobby with no connected human
 * is deliberately not listed (server.js /api/public-rooms), so closing it
 * early would blank the light-theme home and fail the geometry parity check. */
const require2 = (await import('node:module')).createRequire(new URL('../package.json', import.meta.url));
const PubWS = require2('ws');
const pubWs = new PubWS(server.url.replace('http', 'ws'));
await new Promise((resolve) => {
  pubWs.on('open', () => { pubWs.send(JSON.stringify({ type: 'create_room', name: 'Open Table', public: true })); resolve(); });
  pubWs.on('error', () => resolve());          // no room = the section stays hidden; home audits still run
});

let browser = null;
let code = EXIT_PASS;

const fixture = (name) => loadFixture(name);

try {
  browser = await launchBrowser();
  const h = await openTouchPage(browser, `${server.url}/?harness=1&seed=${seed}`);
  const page = h.page;
  // A real logbook in storage for the `?logbook=` stages below. The flight log
  // has no server state, so this is the only way this gate can put a finger on
  // it — see tools/lib/logbook.mjs.
  await installLogbooks(h.context);

  const bridged = await waitForBridge(page, BRIDGE_MS);
  if (!bridged.ok) {
    console.log(`  PENDING CLIENT — window.__CHUD absent with ?harness=1 after ${bridged.ms}ms`);
    await h.close(); await browser.close(); await server.stop();
    process.exit(2);
  }
  r.pass(`booted on an emulated iPhone with a real touchscreen ${dim(`(bridge in ${bridged.ms}ms)`)}`);

  const sentCount = () => page.evaluate(() => (window.__CHUD.sentLog || []).length);
  const lastSent = () => page.evaluate(() => (window.__CHUD.sentLog || []).slice(-1)[0] || null);
  const modeKind = () => page.evaluate(() => window.__CHUD.mode?.kind);
  const tapSel = async (sel, nth = 0, hold) => {
    const c = await centre(page, sel, nth);
    if (!c) return false;
    await h.tap(c.x, c.y, hold);
    return true;
  };

  /* ═══ §B/§C: one audit routine, run per surface ════════════════════════ */
  let surfaceIssues = [];
  /* The mobile half of tools/coverage.mjs's evidence. touchtest opens surfaces
   * screenshot never does (a live game, a soft keyboard, the offline window),
   * so its census is not a subset of the review set's. */
  const CENSUS = census().markers;
  const markerSeen = new Map();
  let captures = 0;
  /**
   * Staged surfaces that never got measured.
   *
   * P8 round 2, measured on one run in four: `§H` left the browser unable to
   * reach the server, all five staged surfaces died on ERR_CONNECTION_REFUSED —
   * and the run still printed "✓ tap targets ≥ 44px on all 9 measured
   * surfaces", because the summaries below count what they were GIVEN. A green
   * summary over a set that is missing the surfaces the run was about is the
   * same defect as an assertion that cannot fail, so the summaries are now
   * suppressed and the run is red whenever this list is non-empty.
   */
  const stagesFailed = [];
  /**
   * P9 round 2: "clipped by a scrolling ancestor — on-screen and still
   * unreachable" was OVER-CLAIMING (mobile critic, verified with real CDP
   * touch: the `.opponents` rail and `.board-props` both scroll fine under a
   * thumb). Before a clipped or off-viewport control is allowed into the red
   * lists it is now PROBED with a real dispatched swipe — see
   * `probeReachability` in lib/touch.mjs for the three legs and for what the
   * reclassification deliberately can no longer catch. A control behind a
   * working, affordance-bearing scroller comes back as `*Reachable` (warned,
   * not gated); a control that fails any leg stays red with the leg named.
   */
  async function probeAndSplit(handle, t) {
    const byId = new Map();
    for (const i of t.clippedInfo || []) {
      const cur = byId.get(i.id) || { ...i, kinds: [] };
      cur.kinds.push('clipped'); byId.set(i.id, cur);
    }
    for (const i of t.offscreenInfo || []) {
      const cur = byId.get(i.id) || { ...i, kinds: [] };
      cur.kinds.push('off'); byId.set(i.id, cur);
    }
    const res = { clipped: [], off: [], clippedReachable: [], offReachable: [], covered: [] };
    if (!byId.size) return res;
    const entries = [...byId.values()];
    /* Two candidate classes a SWIPE probe misjudges (both triage-proven on
     * re-recorded fixtures, 2026-08-08):
     *
     *   FAN CARDS — swipe on the fan is drag-play (see probeFanTap), so they
     *   are probed with a real tap instead.
     *
     *   MODAL-COVERED — while #sheet/#side is open, the table behind it is
     *   covered BY DESIGN: the probe's swipes land on the sheet, the scroller
     *   behind can never move, and the old flow printed UNREACHABLE for
     *   elements the player reaches the moment the sheet closes ('#self-board
     *   cardzone' on all six sheet surfaces). They are skipped here with the
     *   reason stated in the run (res.covered, printed per surface) — NOT
     *   gated, NOT passed either. Candidates INSIDE the open sheet still go
     *   to the swipe probe, so a control no input can reach there fails. */
    const cls = await handle.page.evaluate((ids) => {
      const modalOpen = ['sheet', 'side'].some((mid) => {
        const el = document.getElementById(mid);
        return el && !el.hidden && el.getBoundingClientRect().height > 0;
      });
      const out = { fan: [], covered: [], rest: [] };
      for (const id of ids) {
        const el = document.querySelector(`[data-chud-reach="${CSS.escape(id)}"]`);
        if (!el) { out.rest.push(id); continue; }
        if (modalOpen && !el.closest('#sheet') && !el.closest('#side')) out.covered.push(id);
        else if (el.hasAttribute('data-card-id') && el.closest('#zone-hand, [data-zone="hand"]')) out.fan.push(id);
        else out.rest.push(id);
      }
      return out;
    }, entries.map((e) => e.id));
    const byStamp = new Map(entries.map((e) => [e.id, e]));
    const bucket = (p) => {
      for (const k of p.kinds) {
        const b = p.ok
          ? (k === 'clipped' ? res.clippedReachable : res.offReachable)
          : (k === 'clipped' ? res.clipped : res.off);
        b.push(p.line);
      }
    };
    for (const id of cls.covered) {
      res.covered.push(`${byStamp.get(id).label} — behind the open modal sheet/panel by design; `
        + 'reachable the moment it closes, so not probed and not gated');
    }
    for (const id of cls.fan) bucket(await probeFanTap(handle, byStamp.get(id)));
    const rest = cls.rest.map((id) => byStamp.get(id));
    if (rest.length) for (const p of await probeReachability(handle, rest)) bucket(p);
    return res;
  }
  let stageWasTransient = false;
  async function measureSurface(label, { live = false } = {}) {
    /* A transient stage measures a banner with a 2600ms designed lifetime,
     * and whether the cold reads landed inside it was luck: settleLayout
     * below consumes an unpredictable slice of the banner's life, so PASS
     * runs simply never saw the compressed frame (§8: the gate moved). Pin
     * the phase: the cold reads happen WITH the banner up, or with a warn
     * that it was already gone. */
    if (stageWasTransient) {
      const up = await page.waitForFunction(
        () => document.querySelector('.announce:not([hidden])'),
        null, { timeout: 3000 },
      ).then(() => true).catch(() => false);
      if (!up) r.warn(`[${label}] the transient banner was already gone before the cold reads — this run under-measures the banner frame`);
    }
    // Settle by GEOMETRY, never by a sleep: the hand-fan verdict flipped between
    // three-under-44px and none-under depending on when the measurement landed.
    const s = await settleLayout(page);
    if (!s.settled) r.warn(`[${label}] layout never stopped moving in ${s.ms}ms — the numbers below are of a moving target`);
    const t = await page.evaluate(audit.auditTapTargets);
    // Every COLD read happens before the probe: the probe swipes the frame
    // around (and on a transient stage the clock is running), so it must be
    // the last thing to touch what this surface is being measured on.
    const occ = await page.evaluate(audit.auditOcclusion);
    const dup = await page.evaluate(audit.auditDuplicateCTAs);
    captures++;
    for (const key of await page.evaluate(observeMarkers, CENSUS)) {
      if (!markerSeen.has(key)) markerSeen.set(key, []);
      const at = markerSeen.get(key);
      if (at.length < 4) at.push(label);
    }
    /* P10: reachability is a claim about the SETTLED table — §0.9 concerns
     * controls a player must use, and during a docked transient (the 2.6s
     * announce stripe) the rail is deliberately compressed. Probing during
     * the banner made the verdict a function of banner phase at probe time
     * (measured: PASS/FAIL/FAIL across three runs of an unchanged build).
     * The cold reads above still measure the banner frame — occlusion during
     * the announce is that audit's business; which cards a thumb can reach
     * is judged on the table the player is left with. One-shot: live
     * surfaces after a transient stage measure with the clock running. */
    if (stageWasTransient) {
      stageWasTransient = false;
      await page.waitForFunction(
        () => !document.querySelector('.announce:not([hidden])'),
        null, { timeout: 6000 },
      ).catch(() => {});
      await quietTransients(page);
      await settleLayout(page);
    }
    const reach = await probeAndSplit(h, t);
    // Stated-reason skips (modal cover), never silent: §8's summary law applies
    // to what the probe did NOT measure as much as to what it did.
    for (const line of reach.covered || []) r.info(`[${label}] not gated: ${line}`);
    const rec = {
      label, live, small: t.fatal, zones: t.zones, advisory: t.advisory,
      off: reach.off, clipped: reach.clipped,
      offReachable: reach.offReachable, clippedReachable: reach.clippedReachable,
      covered: reach.covered,
      occ, dup, t,
    };
    surfaceIssues.push(rec);
    if (t.scrollW > t.w + 1) {
      r.fail(`[${label}] page scrolls horizontally (${t.scrollW} > ${t.w})`);
    }
    return rec;
  }

  /* ═══════════════ live game on the phone, driven by thumb ═════════════ */
  await page.evaluate(() => window.__CHUD.setInstant(false));
  if (!(await tapSel('#name-input'))) r.fail('#name-input is not tappable on the home screen');
  await page.keyboard.type('TOUCH');
  await measureSurface('home', { live: true });
  if (!(await tapSel('#btn-quick-play'))) r.fail('quick-play button missing');
  const inGame = await page.waitForFunction(
    () => !document.getElementById('screen-game')?.hidden, null, { timeout: 25000 },
  ).then(() => true).catch(() => false);
  if (!inGame) r.fail('quick play never reached the game screen by touch');
  await page.waitForTimeout(2200);

  if (inGame) {
    /* ── §I duplicate CTAs, measured BEFORE the draw resolves ─────────── */
    const preDraw = await measureSurface('game:draw-phase', { live: true });
    if (preDraw.dup.length) {
      r.fail(`${preDraw.dup.length} duplicate enabled control(s) on screen at once (§I)`);
      for (const d of preDraw.dup) r.info(`${d.key} ×${d.count}, ${d.gap}px apart — ${d.where.join(' / ')}`);
    } else r.pass('no duplicate enabled CTA on screen');

    /* ── our turn arrives, and DRAW must not be lying ────────────────────
     * The engine auto-draws (P7, commit 65e36ef): `turnPhase` is never
     * broadcast as 'draw' any more, so there is nothing to tap and the old
     * assertion here ("a real tap on DRAW reaches the server") is not just
     * stale, it is unsatisfiable. What is worth asserting is the inverse — a
     * visible, ENABLED draw control under auto-draw is a control that does
     * nothing, and a dead primary button teaches the player that taps do not
     * work.                                                                  */
    /* The wait budget is derived from the GAME, not a magic number. Seats
     * shuffle (964d382), so this seat moves first one game in four and LAST
     * another — the old flat 40s only covered "we are first" and went red
     * 5/5 on the seeded order (seed 1337 seats this client last every time).
     * The gate now seats roster order (CHUD_NO_SEAT_SHUFFLE=1 at line 139 —
     * the drag-play sections measure touch, not game flow), so this budget
     * is headroom, not the load-bearing fix; it stays because a gate that
     * can only pass when the human sits first is a gate that lies by seed.
     *
     * Measured on this gate's own quick-play table (5 runs, seed 1337,
     * setInstant(false), 2026-08-08, /tmp/chud-evidence/fixtouch/): seated
     * last, the first turn arrived at 62.1–65.9s. One bot turn is 3.7–8.8s
     * of server-side think time (bot.js DELAYS bound it at draw ≤2.0s +
     * ≤3 plays × ≤2.8s ⇒ ≤10.4s), and EVERY measured round also paid one
     * full 45.0s response window: a bot's first-turn rent charge names this
     * seat, the gate does not answer charges while it waits, and the server
     * holds the game for the whole DEFAULT_RESPONSE_TIMEOUT
     * (server/handlers.js:195; quick play takes the 45s default,
     * handlers.js:357). A full round of bot turns can therefore legitimately
     * cost (seats−1) × (45 + 10.4)s ≈ 166s at four seats. PER_SEAT_MS = 60s
     * is the answer clock plus the worst think time rounded up; the budget
     * covers that 166s worst round with ~45% headroom, and is 3.6× the worst
     * measured wait.
     *
     * The fail-fast is progression-based, not time-based: in a fair
     * rotation any `seats` consecutive turns include every seat once, so
     * `turnNumber` advancing a full cycle without this seat ever being
     * current is the genuine never-comes, reported as such in seconds
     * rather than at the budget. */
    const TURN_PER_SEAT_MS = 60000;
    const tw0 = await page.evaluate(() => ({
      seats: window.__CHUD.snapshot?.players?.length || 0,
      turn: window.__CHUD.snapshot?.turnNumber ?? 0,
      self: window.__CHUD.selfId,
      cp: window.__CHUD.snapshot?.currentPlayerId || null,
    }));
    const turnBudgetMs = Math.max(tw0.seats, 1) * TURN_PER_SEAT_MS;
    const turnDeadline = Date.now() + turnBudgetMs;
    let myTurn = !!tw0.cp && tw0.cp === tw0.self;
    let lapped = false;
    while (!myTurn && !lapped && Date.now() < turnDeadline) {
      await page.waitForTimeout(250);
      const st = await page.evaluate(() => ({
        cp: window.__CHUD.snapshot?.currentPlayerId || null,
        self: window.__CHUD.selfId,
        turn: window.__CHUD.snapshot?.turnNumber ?? 0,
      }));
      if (st.cp && st.cp === st.self) myTurn = true;
      else if (tw0.seats > 0 && st.turn - tw0.turn >= tw0.seats) lapped = true;
    }
    if (!myTurn) {
      r.fail(lapped
        ? `a full rotation of ${tw0.seats} turns passed and this seat was never current — the turn genuinely never comes round`
        : `the turn never came round to this seat within ${Math.round(turnBudgetMs / 1000)}s `
          + `(${tw0.seats} seats × 60s = 45s answer clock + ≤10.4s bot think; worst measured round 65.9s)`);
    } else {
      await page.waitForTimeout(600);
      const draw = await page.evaluate(() => {
        const els = [...document.querySelectorAll('[data-action="draw"]')];
        const live = els.filter((el) => {
          if (el.disabled) return false;
          const st = getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.05) return false;
          for (let p = el; p; p = p.parentElement) if (p.hasAttribute?.('hidden')) return false;
          return el.getBoundingClientRect().height > 0;
        });
        return { total: els.length, live: live.length, phase: window.__CHUD.snapshot?.turnPhase };
      });
      if (draw.live) {
        r.fail(`${draw.live} enabled DRAW control(s) on screen while turnPhase is '${draw.phase}' `
          + '— the engine auto-draws, so tapping it does nothing');
      } else r.pass(`no dead DRAW affordance under auto-draw ${dim(`(turnPhase '${draw.phase}')`)}`);
    }

    /* ── §A drag-play, vertical then horizontal-first ──────────────────── */
    async function realDrag(label, horizontalFirst) {
      const from = await centre(page, '#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]', 0);
      const to = await centre(page, '#self-board .propcol, #self-board [data-zone^="properties"], [data-zone="bank"]', 0);
      if (!from || !to) { r.fail(`${label}: no hand card / drop zone in the DOM`); return; }
      const before = await sentCount();
      let sawDragging = false;
      const onStep = async (i) => {
        if (i !== 4 && i !== 9) return;
        sawDragging = sawDragging || await page.evaluate(
          () => !!document.querySelector('.is-dragging, [data-dragging="1"]'),
        );
      };
      if (horizontalFirst) await h.dragHorizontalFirst(from.x, from.y, to.x, to.y, { onStep });
      else await h.swipe(from.x, from.y, to.x, to.y, 18, { onStep });
      await page.waitForTimeout(800);
      const after = await sentCount();
      if (after > before) r.pass(`${label}: the drag played a card (${(await lastSent())?.type})`);
      else r.fail(`${label}: real touch drag produced NO request — the gesture never reached the client${sawDragging ? '' : ' (drag never even started; touch-action is claiming it)'} (§A)`);
      // Leave no half-open mode behind.
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);
    }
    await realDrag('drag-play (vertical)', false);
    await realDrag('drag-play (horizontal-first)', true);

    /* ── double-fire / ghost tap ───────────────────────────────────────── */
    const et = await centre(page, '#btn-end-turn');
    if (et && !(await page.evaluate(() => document.getElementById('btn-end-turn')?.disabled))) {
      const b = await sentCount();
      await h.tap(et.x, et.y, 25);
      await page.waitForTimeout(60);
      await h.tap(et.x, et.y, 25);
      await page.waitForTimeout(900);
      const sends = (await sentCount()) - b;
      if (sends <= 1) r.pass('a double-tap on END TURN sends at most one request');
      else r.fail(`a double-tap on END TURN sent ${sends} requests — no debounce (ghost/double-fire)`);
    }

    /* ── §G safe-area dead space ───────────────────────────────────────── */
    const dead = await page.evaluate(audit.auditDeadSpace);
    // Emulated Chromium reports zero insets, so an unexplained band is either a
    // double-counted env() or a hardcoded notch guess.
    if (dead.top > 24 || dead.bottom > 24) {
      r.fail(`[§G] ${dead.top}px dead at the top, ${dead.bottom}px at the bottom on a device with NO insets `
        + '— safe-area is being counted twice or hardcoded');
    } else r.pass(`no dead chrome band (${dead.top}px top, ${dead.bottom}px bottom)`);

    /* ── §H offline / reconnect UX ─────────────────────────────────────── */
    await h.setOffline(true).catch(() => {});
    await page.evaluate(() => { try { window.__CHUD_SOCKET_KILL = true; } catch {} });
    // Force the socket shut: emulateNetworkConditions does not tear down an
    // already-open WebSocket, and a client that only reacts to `close` would
    // otherwise look fine while being completely deaf.
    await h.cdp.send('Network.enable').catch(() => {});
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      // Nothing in the shipped client exposes the socket, so provoke the same
      // event the network does: the client's own close path.
      window.dispatchEvent(new Event('offline'));
    });
    await page.waitForTimeout(2500);
    const offline = await page.evaluate(() => {
      const conn = document.getElementById('hud-conn');
      const toast = document.getElementById('toast');
      const cs = conn ? getComputedStyle(conn) : null;
      return {
        connClass: conn?.className || '',
        connText: (conn?.textContent || '').trim(),
        connTitle: conn?.getAttribute('title') || '',
        connVisible: !!cs && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05,
        toast: (toast && !toast.hidden ? toast.textContent : '').trim(),
        online: navigator.onLine,
      };
    });
    const signalled = /off|down|lost|reconnect|retry|drop|bad|warn|is-/i.test(
      `${offline.connClass} ${offline.connText} ${offline.connTitle} ${offline.toast}`,
    );
    if (signalled && offline.connVisible) r.pass(`connection loss is shown to the player ${dim(offline.connClass || offline.toast)}`);
    else r.fail('[§H] the network went away and the UI says nothing — no visible reconnect affordance');
    /* The offline window is a SURFACE (`.conn.is-off`, the RECONNECTING label)
     * and this is the only gate in the harness that can hold it: it needs a
     * socket that was genuinely wanted and then genuinely lost, which no
     * fixture-staged page has (hud.js renderConn: `socket.wanted() &&
     * !store.connected`, exactly so staged pages don't all scream RECONNECTING).
     * tools/coverage.mjs reported `is-off` visited by nothing — the assertion
     * above was reading the class off the DOM without ever telling the census.
     * Census only, not measureSurface: the full audit would add a live surface
     * to the clipped-controls count for a frame whose geometry §H does not
     * change, and this stage is about the connection chrome, not tap floors. */
    captures++;
    for (const key of await page.evaluate(observeMarkers, CENSUS)) {
      if (!markerSeen.has(key)) markerSeen.set(key, []);
      const at = markerSeen.get(key);
      if (at.length < 4) at.push('game:offline');
    }
    await h.setOffline(false).catch(() => {});
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(2500);
    const recovered = await page.evaluate(() => ({
      cards: document.querySelectorAll('[data-card-id]').length,
      err: window.__CHUD.lastError ? String(window.__CHUD.lastError) : null,
      gameVisible: !document.getElementById('screen-game')?.hidden,
    }));
    if (recovered.gameVisible && recovered.cards > 0) r.pass('the table is still there after the network returns');
    else r.fail(`[§H] the client did not recover from an offline window (cards=${recovered.cards}, game=${recovered.gameVisible})`);
    if (recovered.err) r.fail(`__CHUD.lastError after reconnect: ${recovered.err}`);

    /* ── §E landscape ──────────────────────────────────────────────────── */
    await page.setViewportSize(LANDSCAPE);
    await page.waitForTimeout(900);
    const land = await page.evaluate(() => {
      const g = (id) => {
        const e = document.getElementById(id);
        if (!e) return null;
        const rc = e.getBoundingClientRect();
        return { w: Math.round(rc.width), h: Math.round(rc.height), top: Math.round(rc.top), bottom: Math.round(rc.bottom) };
      };
      return {
        self: g('self-board'), hand: g('zone-hand'), table: g('table'),
        opponents: g('opponents'), dock: g('hand-dock'),
        handCards: document.querySelectorAll('#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]').length,
        propCards: document.querySelectorAll('#self-board [data-card-id]').length,
        innerH: innerHeight,
      };
    });
    // A zone with no height is not "tight", it is gone. The player cannot see
    // their own board, which makes the game unplayable, not merely cramped.
    const MIN_ZONE = 44;
    for (const [key, min] of [['self', MIN_ZONE], ['hand', MIN_ZONE], ['table', 80], ['opponents', 40]]) {
      const z = land[key];
      if (!z) { r.fail(`[§E landscape] #${key} is missing entirely`); continue; }
      if (z.h < min) r.fail(`[§E landscape] ${key} is ${z.h}px tall at ${LANDSCAPE.width}×${LANDSCAPE.height} (needs ≥${min}) — unplayable`);
      else r.pass(`[landscape] ${key} ${z.w}×${z.h}`);
    }
    if (land.handCards === 0) r.fail('[§E landscape] no hand cards render at all');
    await measureSurface('landscape', { live: true });
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(600);
  }


  /**
   * §C every surface a thumb can open — measured from a STAGED table.
   *
   * P8 round 2: the clipped-control count moved 38 → 48 between runs of
   * unchanged code. These six surfaces were the cause. They used to be opened on
   * top of the LIVE game, whose state is not reproducible from the seed alone —
   * bots act on real timers and the tool's taps race them, so how many cards
   * were on the boards behind a sheet (and therefore how many of them a scroller
   * had clipped) differed run to run. The sheet is deterministic; the table
   * behind it was not.
   *
   * Opening them over a recorded fixture keeps every behavioural assertion here
   * (opens by touch, closes by touch, the thumb is never trapped, §F's keyboard)
   * and makes the geometry they report reproducible. The live game keeps the
   * assertions that are actually about a live game.
   */
  async function measureSheets() {
  const surfaces = [
    ['help sheet', '#hud [data-action="help"]', '#sheet [data-action="close-sheet"]'],
    ['settings sheet', '#hud [data-action="settings"]', '#sheet [data-action="close-sheet"]'],
    ['emote sheet', '#btn-emote', '#sheet [data-action="close-sheet"]'],
    ['scoop confirm', '#btn-scoop', '#sheet [data-action="close-sheet"]'],
    // P8 round 2: the discard browser is opened by tapping the centre-table
    // pile — a primary on-table control that was in NO gate's selector list.
    ['discard browser', '[data-action="open-discard"]', '#sheet [data-action="close-sheet"]'],
    ['side panel', '#hud [data-action="toggle-side"]', '#side [data-action="toggle-side"]'],
  ];
  for (const [label, open, close] of surfaces) {
    const opened = await tapSel(open);
    if (!opened) { r.fail(`[${label}] no control to open it by touch`); continue; }
    await page.waitForTimeout(700);
    const visible = await page.evaluate(() => {
      const s = document.getElementById('sheet');
      const side = document.getElementById('side');
      return { sheet: s ? !s.hidden : false, side: side ? !side.hidden : false };
    });
    if (!visible.sheet && !visible.side) r.fail(`[${label}] tapping its control opened nothing`);
    await measureSurface(label);

    /* ── §F soft keyboard, only meaningful with the composer on screen ── */
    if (label === 'side panel') {
      await tapSel('#chat-input');
      await page.waitForTimeout(200);
      await page.evaluate(audit.shrinkViewportForKeyboard, KEYBOARD_PX);
      await page.waitForTimeout(600);
      const kb = await page.evaluate(audit.measureComposer, KEYBOARD_PX);
      if (!kb.input) r.fail('[§F] no #chat-input to measure against the keyboard');
      else if (kb.input.bottom > kb.line + 2) {
        r.fail(`[§F] chat composer sits ${Math.round(kb.input.bottom - kb.line)}px UNDER the software keyboard `
          + `(bottom ${kb.input.bottom}, keyboard line ${kb.line}) — §2 keeps visualViewport handling`);
      } else r.pass('chat composer stays above the software keyboard (visualViewport honored)');
      if (kb.send && kb.send.bottom > kb.line + 2) {
        r.fail(`[§F] the SEND button is ${Math.round(kb.send.bottom - kb.line)}px under the keyboard`);
      }
      await page.evaluate(audit.shrinkViewportForKeyboard, 0);
      await page.waitForTimeout(300);
    }

    await tapSel(close);
    await page.waitForTimeout(450);
    const stillOpen = await page.evaluate(() => {
      const s = document.getElementById('sheet');
      const side = document.getElementById('side');
      return (s && !s.hidden) || (side && !side.hidden);
    });
    if (stillOpen) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(350);
      const reallyStuck = await page.evaluate(() => {
        const s = document.getElementById('sheet');
        const side = document.getElementById('side');
        return (s && !s.hidden) || (side && !side.hidden);
      });
      if (reallyStuck) r.fail(`[${label}] cannot be dismissed by touch OR Escape — the thumb is trapped`);
      else r.fail(`[${label}] its close control does not respond to touch (Escape works)`);
    }
  }
  }

  /* ═══════════════ fixture-staged flows (payment, target, discard, win) ═ */
  /**
   * Stage a fixture from a KNOWN STARTING STATE and measure it before anything
   * is touched.
   *
   * The cold measurement is the point. Every §0.9 number this file reported for
   * a staged surface used to be taken after the surface had been interacted
   * with, and the client's layout is not idempotent across those two paths — the
   * hand fan measures [46,46,46,44,42,42,42,56] cold and
   * [47,48,48,46,44,44,44,56] warm, i.e. red and green. A gate must not inherit
   * whatever the previous stage happened to leave behind, so: fresh document,
   * storage cleared by the init script, state applied exactly once, settle by
   * geometry, measure. Interaction-driven measurements still happen afterwards
   * and are labelled separately.
   */
  const stage = async (name, opts = {}) => {
    const { cold = true, label = name } = opts;
    /* `fixture: null` is for surfaces with NO SERVER STATE. The flight log
     * renders `chud.stats.v1` out of localStorage, seeded before the document
     * runs by lib/logbook.mjs off the `?logbook=` in `route` — there is nothing
     * for `applyState` to apply, and demanding a fixture would have kept a whole
     * §0.9 surface out of this gate for want of a file that cannot exist. */
    const fx = opts.fixture === null ? null : fixture(name);
    if (opts.fixture !== null && !fx) { r.fail(`fixture ${name}.json missing — run npm run tool:record`); stagesFailed.push(name); return false; }
    /* §H leaves CDP network emulation behind on some runs, and a later stage
     * then dies on ERR_CONNECTION_REFUSED — one aborted run in four. Clearing
     * the emulation and retrying once distinguishes "the harness left the wire
     * cut" from "the server is genuinely gone": the second failure is still
     * reported and still fails the gate. */
    const goStage = () => {
      const u = new URL(opts.route || '/?harness=1', server.url);
      u.searchParams.set('seed', seed);
      u.searchParams.set('stage', name);
      return page.goto(u.href, { waitUntil: 'load' });
    };
    try {
      await goStage();
    } catch (e) {
      await h.setOffline(false).catch(() => {});
      await page.waitForTimeout(300);
      try {
        await goStage();
        r.warn(`stage ${name}: first navigation failed (${e.message.split('\n')[0]}), succeeded on retry`);
      } catch (e2) {
        /* Say WHICH side died. A Node-side fetch does not go through the page's
         * CDP network emulation, so this separates "§H left the wire cut in the
         * browser" from "the server process is gone" — one aborted run in four
         * looked identical from inside the page and they need different fixes. */
        const alive = await fetch(server.url, { method: 'GET' })
          .then((res) => `server answered ${res.status}`)
          .catch((err) => `server is down (${err.cause?.code || err.message})`);
        r.fail(`stage ${name}: navigation failed — ${e2.message.split('\n')[0]}; ${alive}`
          + (server.died !== null ? `; server.js exited ${server.died}` : ''));
        if (server.died !== null && !stagesFailed.length) {
          // Print it ONCE, on the first stage that noticed: the reason the
          // server went away is in its own log and nowhere else.
          for (const l of server.logs().trim().split('\n').slice(-8)) r.info(l);
        }
        stagesFailed.push(name);
        return false;
      }
    }
    const b = await waitForBridge(page, BRIDGE_MS);
    if (!b.ok) { r.fail(`stage ${name}: the bridge never appeared in ${b.ms}ms`); return false; }
    /* Seat first, THEN state — see tools/lib/stage.mjs. Passing the fixture's
     * own `selfId` is what makes a LOBBY fixture render the seat it was
     * recorded from; without it `store.self.id` is null, `#lobby-host` never
     * appears and this gate measures a screen nobody is looking at. */
    if (fx) await stageFixture(page, fx, { at: opts.at, from: opts.from, drain: !opts.transient });
    stageWasTransient = !!opts.transient;
    if (!opts.transient) await quietTransients(page);
    if (opts.drive) {
      const reached = await drive(page, opts.drive);
      if (opts.expect && !String(reached).startsWith(opts.expect)) {
        r.fail(`stage ${label}: driver '${opts.drive}' reached '${reached}', expected '${opts.expect}*'`);
        stagesFailed.push(label);
        return false;
      }
      r.info(`${label}: ${reached}`);
    }
    if (cold) await measureSurface(`${label} (cold)`);
    return true;
  };

  /* ── the flight log, on a phone, at two populations ─────────────────────
   * §0.9 is the whole reason this stage exists: a panel of small figures and
   * .74em labels inside a scrolling sheet is exactly where a 44px floor and a
   * clipped control go unnoticed. Two populations because they are two
   * different layouts — the young one is four cells and a sentence, the deep
   * one is fifteen rows, twenty form marks and a scroll. */
  if (await stage('flightlog', {
    fixture: null, route: '/?harness=1&logbook=300',
    drive: 'flight-log', expect: 'flightlog:open', label: 'flight log (300)',
  })) {
    // The segment toggle is the one control on this panel a player uses twice.
    await tapSel('.fl-seg .seg', 1);
    await page.waitForTimeout(220);
    const scope = await page.evaluate(
      () => document.querySelector('.fl-seg input:checked')?.value || 'none',
    );
    if (scope === 'bots') r.pass('flight log: the scope toggle changes scope on a real finger tap');
    else r.fail(`flight log: tapping "vs bots" left the scope on '${scope}'`);
    await measureSurface('flight log (segment tapped)');
  }
  await stage('flightlog-young', {
    fixture: null, route: '/?harness=1&logbook=3',
    drive: 'flight-log', expect: 'flightlog:open', label: 'flight log (3)',
  });

  /* ── END TURN exists only on your own turn (owner directive 2026-08-07) ──
   * "hide end turn on screen unless it is actually your turn — better player
   * feedback if the button disappears." Both halves are asserted on recorded
   * fixtures whose turn-holder is known: mid-game is this seat's turn,
   * payment-pending is Iceman's. GONE means gone — `[hidden]`/display:none
   * with no box — not merely disabled, which is the state the owner named as
   * bad feedback. PROVEN TO FAIL: with hud.js's setHidden(endBtn) reverted to
   * the old disable-only line, the off-turn half reports the button visible
   * (red run recorded in this round's report). */
  const endTurnState = () => page.evaluate(() => {
    const b = document.getElementById('btn-end-turn');
    if (!b) return { present: false, visible: false, myTurn: null };
    const st = getComputedStyle(b);
    const box = b.getBoundingClientRect();
    return {
      present: true,
      visible: !b.hidden && st.display !== 'none' && box.width > 0 && box.height > 0,
      disabled: !!b.disabled,
      myTurn: window.__CHUD.snapshot?.currentPlayerId === window.__CHUD.selfId,
    };
  });

  /* Sheets first, over a recorded table, so their numbers are reproducible. */
  if (await stage('mid-game')) {
    const et = await endTurnState();
    if (!et.present || et.myTurn !== true) {
      r.fail(`end-turn: mid-game did not stage this seat's turn (${JSON.stringify(et)}) — measured nothing`);
    } else if (et.visible && !et.disabled) {
      r.pass('END TURN is on screen and live on your own turn');
    } else {
      r.fail(`END TURN missing or dead on the player's own turn — ${JSON.stringify(et)} (§0.9: the keyboard/tap path to ending a turn must exist)`);
    }
    await measureSheets();
  }

  /* ── payment by touch, and §D occlusion of the confirm bar ───────────── */
  if (await stage('payment-pending')) {
    const et = await endTurnState();
    if (!et.present || et.myTurn !== false) {
      r.fail(`end-turn: payment-pending did not stage another seat's turn (${JSON.stringify(et)}) — measured nothing`);
    } else if (et.visible) {
      r.fail('END TURN is on screen during another seat\'s turn — the owner asked for it GONE off-turn, not greyed');
    } else {
      r.pass('END TURN is gone from the dock off-turn (owner directive 2026-08-07)');
    }
    await tapSel('[data-action="begin-payment"]');
    await page.waitForTimeout(300);
    const payable = await page.evaluate(
      () => document.querySelectorAll('[data-payable="1"], [data-zone="bank"] [data-card-id]').length,
    );
    if (!payable) r.fail('payment: nothing is selectable to pay with');
    for (let i = 0; i < Math.min(payable, 4); i++) {
      await tapSel('[data-payable="1"], [data-zone="bank"] [data-card-id]', i);
      await page.waitForTimeout(140);
    }
    const occ = await page.evaluate(audit.auditOcclusion);
    if (occ.length) {
      r.fail(`[§D] ${occ.length} primary CTA(s) covered by a pointer-events:none layer`);
      for (const o of occ) r.info(`"${o.cta}" ${o.pct}% covered by ${o.by}`);
    } else r.pass('no decorative layer covers a primary CTA during payment (§D)');
    const before = await sentCount();
    await tapSel('[data-action="confirm-payment"]');
    await page.waitForTimeout(600);
    if ((await sentCount()) > before) r.pass('payment confirmed by a real finger tap');
    else r.fail('CONFIRM PAYMENT did not respond to a real touch');
    await measureSurface('payment');
  }

  /* ── targeting is a CLIENT-SIDE mode: it has to be driven, not staged ── */
  if (await stage('targeting')) {
    const entered = await page.evaluate(async () => {
      const hand = [...document.querySelectorAll('#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]')];
      for (const card of hand) {
        window.__CHUD_TAPPING = card.dataset.cardId;
        card.click();
        await new Promise((res) => setTimeout(res, 120));
        const play = document.querySelector('[data-action="play-card"]:not([disabled])');
        if (play) { play.click(); await new Promise((res) => setTimeout(res, 200)); }
        if (window.__CHUD.mode?.kind === 'target') return window.__CHUD.mode.needs?.[0] || 'target';
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((res) => setTimeout(res, 80));
      }
      return null;
    });
    if (!entered) {
      r.fail('targeting: no card in the staged hand can enter target mode — the fixture cannot show targeting');
    } else {
      const glow = await page.evaluate(
        () => document.querySelectorAll('[data-targetable="1"], .is-targetable, [data-droppable="1"]').length,
      );
      if (!glow) r.fail(`targeting: mode is '${entered}' but nothing on the table is marked targetable`);
      else r.pass(`targeting mode entered (needs ${entered}); ${glow} target(s) marked`);
      const t = await centre(page, '[data-targetable="1"], .is-targetable', 0);
      if (t) {
        const before = await sentCount();
        // Choosing a target is not always the last step (rent picks a player
        // AND a colour), so "did it work" is: a request went out, OR the mode
        // moved on, OR the pick was recorded. Only "nothing at all changed"
        // is the dead-touch defect.
        const modeBefore = await page.evaluate(() => JSON.stringify(window.__CHUD.mode));
        await h.tap(t.x, t.y);
        await page.waitForTimeout(600);
        const modeAfter = await page.evaluate(() => JSON.stringify(window.__CHUD.mode));
        if ((await sentCount()) > before || modeAfter !== modeBefore) {
          r.pass(`a real tap on a glowing target advanced the choice ${dim(`→ ${await modeKind()}`)}`);
        } else r.fail('tapping a glowing target with a real finger changed nothing — the on-table target is dead to touch');
      }
      await measureSurface('targeting');
    }
  }

  /* ── discard-to-limit ─────────────────────────────────────────────────── */
  if (await stage('discard-limit')) {
    await tapSel('#btn-end-turn');
    await page.waitForTimeout(400);
    const k = await modeKind();
    if (k !== 'discard') r.fail(`discard: END TURN over the hand limit put us in '${k}', not discard mode`);
    else {
      r.pass('over the hand limit, END TURN opens discard selection');
      await measureSurface('discard');
      const occ = await page.evaluate(audit.auditOcclusion);
      if (occ.length) {
        r.fail(`[§D] ${occ.length} CTA(s) covered during discard`);
        for (const o of occ) r.info(`"${o.cta}" ${o.pct}% covered by ${o.by}`);
      }
    }
  }

  /* ── §E landscape at FIVE players ──────────────────────────────────────
   * Landscape was measured once, in whatever seat count the live game happened
   * to have (3), and only as four zone heights. Five opponents is where the
   * boards get pushed into a scroller — and the clipped-control check in the
   * verdict below is the thing that can see that. */
  await page.setViewportSize(LANDSCAPE);
  if (await stage('five-player', { cold: false })) {
    await measureSurface('landscape · five players (cold)');
  }
  await page.setViewportSize(PHONE);

  /* ── win overlay ──────────────────────────────────────────────────────── */
  if (await stage('finished')) {
    const shown = await page.evaluate(() => {
      const w = document.getElementById('win-overlay');
      return w ? !w.hidden : false;
    });
    if (!shown) r.fail('win: the finished fixture does not raise #win-overlay');
    else r.pass('win overlay is up');
    await measureSurface('win overlay');
  }

  /* ═══ P9: surfaces reachable in ordinary play that no gate had opened ═══
   *
   * Every one of these was hand-staged by the agent who happened to need it,
   * and none of them was in any tool's list. tools/coverage.mjs is the thing
   * that now says so out loud; these are the six it named first.
   *
   * The LOBBY is the priority and it is not a subtlety: it is the busiest
   * pre-game screen in the product and it had never been under this gate at
   * all, because the harness could not set `store.self.id` from a broadcast
   * with no `game` in it, so every capture in every tool was the guest view of
   * a transcript recorded by the host.                                        */
  if (await stage('lobby', { label: 'lobby (host)', drive: 'lobby-host', expect: 'lobby:host' })) {
    const seen = await page.evaluate(() => {
      const code = document.getElementById('lobby-code');
      const start = document.getElementById('btn-start');
      const rect = (el) => (el ? el.getBoundingClientRect() : null);
      const r = rect(start);
      const c = rect(code);
      const doc = document.scrollingElement;
      return {
        start: r && { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) },
        code: c && { top: Math.round(c.top), bottom: Math.round(c.bottom) },
        innerH: innerHeight,
        scrollH: doc ? doc.scrollHeight : 0,
      };
    });
    /* The host's two irreducible jobs are READ THE CODE OUT LOUD and LAUNCH.
     * Neither is a tap-target question or an overflow question, so neither of
     * the verdicts below would have caught them: they are "is it on the
     * screen", asked of the two specific controls the screen exists for. */
    for (const [what, box] of [['the room code', seen.code], ['Launch Mission', seen.start]]) {
      if (!box) { r.fail(`[lobby] ${what} is not in the DOM at all`); continue; }
      if (box.top >= seen.innerH || box.bottom <= 0) {
        r.fail(`[lobby] ${what} is entirely off-screen for the HOST at ${PHONE.width}×${PHONE.height} `
          + `(y ${box.top}..${box.bottom} of ${seen.innerH}; the panel is ${seen.scrollH}px of content)`);
      } else if (box.bottom > seen.innerH) {
        r.fail(`[lobby] ${what} is ${Math.round(box.bottom - seen.innerH)}px below the fold for the HOST `
          + `(${seen.scrollH}px of content in ${seen.innerH}px)`);
      } else r.pass(`[lobby] ${what} is on screen for the host ${dim(`y ${box.top}..${box.bottom}`)}`);
    }
  }
  await stage('lobby-guest', { label: 'lobby (guest)', drive: 'lobby-guest', expect: 'lobby:guest' });

  /* The `myColor` step: ten mats, each carrying printed placement advice.
   * §0.9's 44px rule lands on the MAT, and interact.css says the chit is
   * `pointer-events: none` so it cannot shadow the thing being tapped — a
   * claim nothing had ever tested on a phone. */
  await stage('mid-game', { label: 'wild placement', drive: 'wild-place', expect: 'myColor:' });

  /* The opponent half of the table. An upgrade lane, a second mat row and the
   * ARMED treatment only exist on a seat that is not yours, and three seperate
   * agents each had to build one by hand to check their own work. */
  for (const name of ['opponent-upgrade', 'opponent-wide', 'opponent-armed']) await stage(name);

  /* The two transient message layers. `#toast` is measured for what it covers;
   * `.announce` is a full-width banner over the table that is now part of
   * §D's veil set (lib/audit.mjs) — it was found on collapsed opponent seats
   * at 51%/42% portrait and 70% landscape by an agent, by hand, because
   * nothing raised it. Landscape gets its own pass: that is where the banner
   * has the least room to fall clear of the seats. */
  await stage('approach-called', { label: 'announce', from: 0, at: 1, transient: true, drive: 'announce', expect: 'announce:' });
  await page.setViewportSize(LANDSCAPE);
  await stage('approach-called', { label: 'announce · landscape', from: 0, at: 1, transient: true, drive: 'announce', expect: 'announce:' });
  await page.setViewportSize(PHONE);
  /* The toast is reached from the HOME screen — join a room that is not there.
   * Not from a staged table: `#btn-join-room` lives inside `#screen-home`,
   * which is `hidden` behind a game, and a click routed from inside a hidden
   * ancestor is not a click a player can make. */
  await page.goto(`${server.url}/?harness=1&seed=${seed}&stage=toast`, { waitUntil: 'load' });
  if ((await waitForBridge(page, BRIDGE_MS)).ok) {
    const reached = await drive(page, 'toast');
    if (!String(reached).startsWith('toast:"')) { r.fail(`toast: driver reached '${reached}'`); stagesFailed.push('toast'); }
    else { r.info(`toast: ${reached}`); await measureSurface('toast (cold)'); }
  }

  /* ═══════════════ verdict over every surface measured ══════════════════ */
  if (stagesFailed.length) {
    r.fail(`${stagesFailed.length} staged surface(s) were never measured (${stagesFailed.join(', ')}) `
      + '— every "all surfaces" verdict below is over an incomplete set and must not be read as green');
  }
  const complete = stagesFailed.length === 0;
  /** A summary may only report success when it saw everything it claims to cover. */
  const summary = (ok, msg) => (ok && complete ? r.pass(msg) : (ok ? r.info(`${msg} (incomplete set)`) : null));

  /**
   * GATE on the reproducible surfaces; REPORT the live ones.
   *
   * P8 round 2: the clipped-control count moved 38 → 48 between runs of
   * unchanged code, and a gate whose number moves without the build moving gets
   * ignored — which is worse than a gate that is merely strict. Most of it was
   * the sheets, now measured over a fixture (see measureSheets). What is left
   * is irreducible: `home`, `game:draw-phase` and the live `landscape` pass come
   * off a REAL game with real bots on real timers, and the tool's taps race
   * them, so the table behind them is genuinely different run to run. Seeding
   * the shuffle does not seed the wall clock.
   *
   * So those three are measured, printed, and kept out of the gated totals
   * rather than quietly dropped: a live-game regression still shows up in the
   * run, it just cannot make the headline number flicker.
   */
  const staged = surfaceIssues.filter((s) => !s.live);
  const liveOnly = surfaceIssues.filter((s) => s.live);
  surfaceIssues = staged;

  const smalls = surfaceIssues.filter((s) => s.small.length);
  if (smalls.length) {
    // Distinct signatures, not raw hits: one 20px .propcol repeated across ten
    // set columns and eleven surfaces is ONE defect, and a count of 101 reads
    // like a wall of noise nobody fixes.
    const total = new Set(surfaceIssues.flatMap((s) => s.small)).size;
    r.fail(`${total} distinct tap target(s) under 44px across ${smalls.length} surface(s) (§0.9, §B)`);
    for (const s of smalls) {
      r.info(`${s.label}: ${[...new Set(s.small)].slice(0, 8).join(', ')}`);
    }
  } else summary(true, `tap targets ≥ 44px on all ${surfaceIssues.length} reproducible surfaces`);

  const zoneHits = new Set(surfaceIssues.flatMap((s) => s.zones || []));
  if (zoneHits.size) {
    r.fail(`${zoneHits.size} distinct card zone(s) under 44px — §5 says tapping any zone zooms it, `
      + 'so a zone thinner than a thumb hides the data it is supposed to reveal');
    // WHICH SURFACE, not just which signature. P9: this verdict went red on the
    // first run that staged an opponent holding six colours, and the line as
    // written named `div.cardzone 46×11` without saying where — which is the
    // difference between a finding somebody can fix and a number.
    for (const su of surfaceIssues.filter((x) => (x.zones || []).length)) {
      r.info(`${su.label}: ${[...new Set(su.zones)].slice(0, 6).join(', ')}`);
    }
  } else summary(true, 'every card zone is at least 44px');

  const offs = surfaceIssues.filter((s) => s.off.length);
  if (offs.length) {
    r.fail(`interactive elements outside the viewport on ${offs.length} surface(s) — probed with real touch (swipe, or tap where a swipe is drag-play) and still unreachable`);
    for (const s of offs) r.info(`${s.label}: ${s.off.slice(0, 5).join(', ')}`);
  } else summary(true, 'every interactive element is on-screen or provably scroll-reachable on every surface');

  /* The other half of "on-screen": inside the viewport but scrolled out of its
   * own overflow container, which the viewport test cannot see. P9 round 2:
   * "unreachable" is only claimed after probeReachability has ACTUALLY TRIED
   * with a real swipe — the failing leg is in each line. */
  const clips = surfaceIssues.filter((s) => (s.clipped || []).length);
  if (clips.length) {
    const total = new Set(surfaceIssues.flatMap((s) => s.clipped || [])).size;
    r.fail(`${total} distinct control(s) clipped by an overflow ancestor across ${clips.length} surface(s) `
      + '— probed with real touch (swipe, or tap where a swipe is drag-play) and still unreachable');
    for (const s of clips) r.info(`${s.label}: ${[...new Set(s.clipped)].slice(0, 5).join(', ')}`);
  } else summary(true, 'no control is clipped away by an overflow container (real-swipe probed)');

  /* The reclassified ones: behind a scroller that a real dispatched swipe
   * moved, that revealed ≥44px of the control, and that announced itself in
   * the cold frame. Reported, never gated — and never silently dropped. */
  const reclassed = surfaceIssues.filter(
    (s) => (s.clippedReachable || []).length || (s.offReachable || []).length,
  );
  if (reclassed.length) {
    const lines = (s) => [...new Set([...(s.clippedReachable || []), ...(s.offReachable || [])])];
    const total = new Set(reclassed.flatMap(lines)).size;
    r.warn(`${total} control(s) behind a WORKING scroller with a visible cold-frame affordance `
      + '— verified reachable by a real dispatched swipe, so reported, not gated');
    for (const s of reclassed) for (const line of lines(s).slice(0, 6)) r.info(`${s.label}: ${line}`);
  }

  const occAll = surfaceIssues.filter((s) => s.occ.length);
  if (occAll.length) {
    r.fail(`CTAs occluded by decorative layers on ${occAll.length} surface(s) (§D)`);
    for (const s of occAll) r.info(`${s.label}: ${s.occ.map((o) => `"${o.cta}" ${o.pct}% by ${o.by}`).join('; ')}`);
  }

  const advisories = surfaceIssues.flatMap((s) => s.advisory);
  if (advisories.length) {
    r.warn(`${advisories.length} sub-44px card node(s) that are zoom affordances, not controls (advisory, §5)`);
  }

  /* The live-game surfaces, reported and not gated (see the note above). */
  if (liveOnly.length) {
    const n = (k) => liveOnly.reduce((a, x) => a + new Set(x[k] || []).size, 0);
    const small = new Set(liveOnly.flatMap((x) => x.small)).size;
    const clip = new Set(liveOnly.flatMap((x) => x.clipped || [])).size;
    const line = `${liveOnly.length} live-game surface(s) (${liveOnly.map((x) => x.label).join(', ')}): `
      + `${small} tap target(s) under 44px, ${clip} clipped, ${n('off')} off-viewport`;
    if (small || clip || n('off')) {
      r.warn(`${line} — measured on a real game, so not gated (timing-dependent)`);
      /* NAME what moved: an aggregate warn with no lines in it cannot be told
       * apart from a probe regression (a run-2 flake showed '3 clipped' with
       * the controls nowhere in the log). */
      for (const x of liveOnly) {
        const probeLines = [...new Set([...(x.clipped || []), ...(x.off || [])])];
        for (const l of probeLines.slice(0, 4)) r.info(`${x.label}: ${l}`);
      }
    }
    else r.info(`${line} — clean`);
  }

  if (h.errors.length) {
    r.fail(`${h.errors.length} console/page error(s) on phone`);
    for (const e of h.errors.slice(0, 6)) console.log(red(`      ${e}`));
  } else r.pass('no console errors on phone');

  /* ═══ --prove: §D and §0.9 must be able to go red (§8) ══════════════════
   * §D passed every round while being structurally unable to fail (see the
   * header). An assertion nobody has seen fail is a decoration, so this injects
   * the exact defect it exists to catch — a pointer-events:none veil laid over
   * the primary action — and requires the verdict to flip.                    */
  if (args.prove) {
    console.log(dim('\n  ── --prove: the same assertions against injected defects ──'));
    await stage('payment-pending', { cold: false });
    await settleLayout(page);

    /* Half one: with a veil actually over a CTA, the verdict must flip. */
    const clean = await page.evaluate(audit.auditOcclusion);
    const injected = await page.evaluate(() => {
      const vis = (el) => {
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.05) return false;
        for (let p = el; p; p = p.parentElement) if (p.hasAttribute?.('hidden')) return false;
        const r2 = el.getBoundingClientRect();
        return r2.width > 20 && r2.height > 20 && r2.top < innerHeight && r2.bottom > 0;
      };
      const cta = [...document.querySelectorAll(
        '[data-action]:not([disabled]), #prompt button, #hand-dock button, .btn-primary',
      )].filter(vis)[0];
      if (!cta) return null;
      const r2 = cta.getBoundingClientRect();
      const veil = document.createElement('div');
      veil.className = 'hint-card';
      veil.textContent = 'injected coach bubble';
      Object.assign(veil.style, {
        position: 'fixed', left: `${r2.left - 4}px`, top: `${r2.top - 4}px`,
        width: `${r2.width + 8}px`, height: `${r2.height + 8}px`,
        background: '#888', pointerEvents: 'none', zIndex: '9999',
        // `.hint-card` ships `opacity: 0` and animates in via `.is-in`, so the
        // first version of this injection produced an INVISIBLE veil and the
        // demonstration failed for a reason that had nothing to do with §D.
        opacity: '1', visibility: 'visible',
      });
      document.body.appendChild(veil);
      return (cta.textContent || cta.dataset.action || cta.id || 'button').trim().slice(0, 24);
    });
    await page.waitForTimeout(120);
    const veiled = await page.evaluate(audit.auditOcclusion);
    if (!injected) {
      r.fail('--prove §D: no visible CTA on the staged surface to cover — the demonstration cannot run');
    } else if (veiled.length > clean.length) {
      r.pass(`--prove §D: covering "${injected}" took the verdict ${clean.length} → ${veiled.length} `
        + dim(`("${veiled[0].cta}" ${veiled[0].pct}% by ${veiled[0].by})`));
    } else {
      r.fail(`--prove §D: covering "${injected}" left the verdict at ${veiled.length} — §D cannot `
        + 'distinguish a covered CTA from an uncovered one, so its green is a decoration');
    }

    /* Half two: prove the STORAGE half, which is what made §D unfalsifiable.
     *
     * A/B on the one variable: a freshly staged surface builds coach nodes,
     * and the same surface with `chud_hints_v1` pre-seeded as "all seen" builds
     * none. That second state is exactly what every stage inherited before this
     * run cleared storage — the layer §D exists to catch could not be created,
     * so §D was green by construction. The seeding init script is added AFTER
     * the pristine one and therefore wins; --prove is the end of the run.     */
    const countHints = () => page.evaluate(
      () => document.querySelectorAll('.hints .hint-card, .hint-card').length,
    );
    const withPristine = await countHints();
    await h.context.addInitScript(() => {
      try {
        localStorage.setItem('chud_hints_v1',
          JSON.stringify(['peek', 'drag', 'pay', 'play', 'bank', 'discard', 'target', 'end']));
      } catch { /* private mode */ }
    });
    await stage('payment-pending', { cold: false });
    await settleLayout(page);
    const withSpent = await countHints();
    if (withPristine > 0 && withSpent === 0) {
      r.pass(`--prove: the coach layer is storage-gated — ${withPristine} node(s) on pristine storage, `
        + `${withSpent} once the once-ever keys are spent. Not clearing storage is what made §D unfalsifiable.`);
    } else {
      r.fail(`--prove: pristine ${withPristine} hint node(s) vs spent ${withSpent} — the storage fix `
        + 'cannot be shown to change what §D is able to see');
    }

    /* ═══ Half three: reachability-by-real-scroll must fail BOTH ways ═════
     *
     * P9 round 2 reclassified "clipped by a scrolling ancestor" from a
     * geometry claim into a three-leg gesture measurement (probeReachability,
     * lib/touch.mjs). §8 says a reclassification is a new assertion, and both
     * of its outs need to be watched going red on the surface that caused it —
     * the five-player landscape rail:
     *
     *   (a) leg (i): nail the rail shut (`overflow: hidden`, via addStyleTag,
     *       the genuine-clip defect the old string always claimed) — the
     *       probe's swipes must move nothing and the verdict must go red;
     *   (b) leg (iii): keep the rail scrolling but strip every cold-frame
     *       affordance (port cut exactly on a seat boundary so no sliver,
     *       scrollbar hidden, edge mask off) — reachable by force, and still
     *       red, because a scroller nothing announces is one nobody scrolls.
     */
    await page.setViewportSize(LANDSCAPE);
    if (await stage('five-player', { cold: false, label: 'prove reachability' })) {
      await settleLayout(page);
      const gated = async () => {
        const t = await page.evaluate(audit.auditTapTargets);
        const s2 = await probeAndSplit(h, t);
        return {
          red: new Set([...s2.clipped, ...s2.off]).size,
          ok: new Set([...s2.clippedReachable, ...s2.offReachable]).size,
        };
      };
      const clean = await gated();
      if (clean.red > 0 || clean.ok === 0) {
        r.fail(`--prove reachability: no clean baseline — the untouched rail probes red ${clean.red} / `
          + `reachable ${clean.ok}, so the demonstrations below prove nothing`);
      } else {
        r.info(`prove reachability baseline: 0 red, ${clean.ok} reclassified reachable`);
      }

      const tagA = await page.addStyleTag({ content: '#opponents { overflow: hidden !important; }' });
      await settleLayout(page);
      const nailed = await gated();
      await tagA.evaluate((el) => el.remove());
      if (nailed.red > clean.red) {
        r.pass(`--prove reachability (a): overflow:hidden on the rail took the red count ${clean.red} → ${nailed.red} `
          + '— a scroller that will not move under a real swipe stays red');
      } else {
        r.fail(`--prove reachability (a): nailing the rail shut left the red count at ${nailed.red} — `
          + 'the probe cannot tell a working scroller from a genuine clip, so its green is a decoration');
      }

      await settleLayout(page);
      const blinded = await page.evaluate(() => {
        const rail = document.getElementById('opponents');
        if (!rail) return false;
        const pr = rail.getBoundingClientRect();
        // Cut the port EXACTLY on a child boundary: no partially-visible seat,
        // therefore no sliver, and the styles below take the other two
        // affordances. The rail still scrolls — only leg (iii) is broken.
        let bottom = pr.top;
        for (const ch of rail.children) {
          const cr = ch.getBoundingClientRect();
          if (cr.bottom <= pr.bottom + 1) bottom = Math.max(bottom, cr.bottom);
        }
        const st = document.createElement('style');
        st.id = 'chud-prove-affless';
        st.textContent = `#opponents { height: ${Math.max(48, Math.round(bottom - pr.top))}px !important;`
          + ' flex: none !important; scrollbar-width: none !important;'
          + ' -webkit-mask-image: none !important; mask-image: none !important; }'
          + ' #opponents::-webkit-scrollbar { display: none !important; width: 0 !important; }';
        document.head.appendChild(st);
        return true;
      });
      if (!blinded) {
        r.fail('--prove reachability (b): no #opponents rail to strip — the demonstration cannot run');
      } else {
        await settleLayout(page);
        const affless = await gated();
        await page.evaluate(() => document.getElementById('chud-prove-affless')?.remove());
        if (affless.red > clean.red) {
          r.pass(`--prove reachability (b): stripping every cold-frame affordance took the red count `
            + `${clean.red} → ${affless.red} — a scroller that works but never announces itself stays red`);
        } else {
          r.fail(`--prove reachability (b): an affordance-free scroller left the red count at ${affless.red} — `
            + 'leg (iii) cannot fail, so "reachable" would green a scroller no player would ever discover');
        }
      }
    }
    await page.setViewportSize(PHONE);
  }

  /* ═══ --prove-surfaces: every P9 surface, watched going red ════════════
   *
   * §8: "A gate must be proven to fail. Before a new assertion is trusted,
   * break the fix it guards and watch it go red — an assertion nobody has seen
   * fail is a decoration." A SURFACE is not an assertion, so the thing to break
   * is the defect the surface exists to catch: for the lobby, the host's
   * primary control leaving the viewport; for the mats, a target under a thumb;
   * for the opponent seats, a lane clipped out of its own scroller; for the two
   * message layers, a veil over a control.
   *
   * Each case measures the surface CLEAN, injects, measures again, and requires
   * the number to move. Injection is per-page CSS/DOM and is discarded with the
   * next navigation, so nothing here can leak into the gated numbers above —
   * this block runs after them and after `h.close()`'s counterpart passes.  */
  if (args['prove-surfaces']) {
    console.log(dim('\n  ── --prove-surfaces: the P9 surfaces, against injected defects ──'));
    const distinct = (t, key) => new Set(t[key] || []).size;
    const CASES = [
      {
        label: 'lobby (host)',
        stage: ['lobby', { cold: false, drive: 'lobby-host', expect: 'lobby:host' }],
        defect: 'Launch Mission pushed below the fold',
        /* The metric is the assertion this surface ADDED, not the generic
         * off-viewport list — and that is a measurement, not a preference.
         * `auditTapTargets` drops any element entirely below the fold
         * (`vis()`: `if (r.top >= innerHeight) return false`), so a primary
         * control pushed 30px past the bottom edge disappears from the
         * off-viewport count instead of appearing in it. Worth knowing on its
         * own; here it means the generic verdict cannot demonstrate the exact
         * defect the host lobby was added for. */
        measure: async () => page.evaluate(() => {
          const b = document.getElementById('btn-start');
          const r = b.getBoundingClientRect();
          return r.bottom > innerHeight || r.top >= innerHeight ? 1 : 0;
        }),
        inject: () => {
          const b = document.getElementById('btn-start');
          Object.assign(b.style, { position: 'fixed', left: '20px', top: `${innerHeight + 30}px` });
        },
      },
      {
        label: 'lobby (guest)',
        stage: ['lobby-guest', { cold: false, drive: 'lobby-guest', expect: 'lobby:guest' }],
        defect: 'the host-only block shown to a guest',
        // The verdict here is the DRIVER's, not an audit's: "this guest is
        // being offered controls the server would refuse" is the whole point
        // of having a guest surface at all.
        measure: async () => (String(await drive(page, 'lobby-guest')).startsWith('lobby:guest') ? 0 : 1),
        inject: () => { document.getElementById('lobby-host').hidden = false; },
      },
      {
        label: 'wild placement',
        stage: ['mid-game', { cold: false, drive: 'wild-place', expect: 'myColor:' }],
        defect: 'a set column shrunk under the 44px floor while it IS the primary action',
        measure: async () => distinct(await page.evaluate(audit.auditTapTargets), 'fatal'),
        inject: () => {
          const st = document.createElement('style');
          st.textContent = '.propcol { height: 20px !important; min-height: 20px !important; }';
          document.head.appendChild(st);
        },
      },
      {
        label: 'opponent upgrade lane',
        stage: ['opponent-upgrade', { cold: false }],
        defect: 'the seat clipped to a 40px scrollport',
        measure: async () => distinct(await page.evaluate(audit.auditTapTargets), 'clipped'),
        inject: () => {
          const st = document.createElement('style');
          st.textContent = '#opponents .board { max-height: 40px !important; overflow: hidden !important; }';
          document.head.appendChild(st);
        },
      },
      {
        label: 'opponent second mat row',
        stage: ['opponent-wide', { cold: false }],
        defect: 'the mat grid narrowed until the second row runs off its own scroller',
        measure: async () => distinct(await page.evaluate(audit.auditTapTargets), 'clipped'),
        // Narrowed rather than shortened: on a six-colour holding the row break
        // is horizontal, and a 60px height clamp changed nothing measurable
        // because the seat-toggle still fitted inside it.
        inject: () => {
          const st = document.createElement('style');
          st.textContent = '#opponents .board { max-width: 90px !important; overflow: hidden !important; }';
          document.head.appendChild(st);
        },
      },
      {
        label: 'announce banner',
        stage: ['approach-called', { cold: false, from: 0, at: 1, transient: true, drive: 'announce', expect: 'announce:' }],
        defect: 'the banner laid over the seat controls it sits above',
        measure: async () => (await page.evaluate(audit.auditOcclusion)).length,
        inject: () => {
          const a = document.querySelector('.announce');
          Object.assign(a.style, { position: 'fixed', left: '0', top: '0', width: '100%', height: '60%' });
        },
      },
      {
        label: 'toast',
        stage: null,        // home screen — see the toast driver
        defect: 'the toast laid over the primary control',
        measure: async () => (await page.evaluate(audit.auditOcclusion)).length,
        inject: () => {
          const t = document.getElementById('toast');
          // `is-on` is dropped 2600ms after the toast is raised and the audit
          // skips anything invisible, so without re-asserting it the injection
          // lands on an element nothing is looking at — measured: the verdict
          // stayed at 0 with a full-screen veil in the DOM.
          t.classList.add('is-on');
          // Full height, not 70%: measured at 390×844 the home CTAs start at
          // y687 and a 70% veil stops at y591, so the injection covered nothing
          // and the demonstration failed for a reason that had nothing to do
          // with whether §D can see a toast.
          Object.assign(t.style, {
            position: 'fixed', left: '0', top: '0', width: '100%', height: '100%',
            maxWidth: 'none', opacity: '1', visibility: 'visible', transform: 'none',
          });
        },
      },
    ];

    for (const c of CASES) {
      if (c.stage) {
        if (!(await stage(c.stage[0], { ...c.stage[1], label: `prove ${c.label}` }))) {
          r.fail(`--prove-surfaces [${c.label}]: could not stage it — the demonstration cannot run`);
          continue;
        }
      } else {
        await page.goto(`${server.url}/?harness=1&seed=${seed}&stage=prove-toast`, { waitUntil: 'load' });
        if (!(await waitForBridge(page, BRIDGE_MS)).ok) continue;
        await drive(page, 'toast');
      }
      await settleLayout(page);
      const clean = await c.measure();
      await page.evaluate(c.inject);
      await page.waitForTimeout(200);
      const dirty = await c.measure();
      if (dirty > clean) {
        r.pass(`--prove-surfaces [${c.label}]: ${c.defect} took the verdict ${clean} → ${dirty}`);
      } else {
        r.fail(`--prove-surfaces [${c.label}]: ${c.defect} left the verdict at ${dirty} — `
          + 'this surface cannot report the defect it was added for');
      }
    }
  }

  await h.close();

  /* ═══ ART §2 ships TWO appearances; this file measured one ══════════════
   * `openTouchPage` hardcoded `colorScheme: 'dark'`, so the light theme had no
   * mobile gate at all. A full second pass would double a slow gate for little
   * return — light and dark are geometrically identical in this build, which is
   * a claim worth CHECKING rather than assuming, so the light pass is cold
   * measurements only (tap targets, occlusion, clipping) over the surfaces most
   * likely to differ, and any divergence from the dark numbers is reported.  */
  {
    const lh = await openTouchPage(browser, `${server.url}/?harness=1&seed=${seed}`, { colorScheme: 'light' });
    const lb = await waitForBridge(lh.page, BRIDGE_MS);
    if (!lb.ok) r.fail('light-theme pass: the bridge never appeared');
    else {
      for (const name of ['mid-game', 'discard-limit', 'five-player']) {
        const fx = fixture(name);
        if (!fx) continue;
        await lh.page.goto(`${server.url}/?harness=1&seed=${seed}&stage=${name}&theme=light`, { waitUntil: 'load' });
        if (!(await waitForBridge(lh.page, BRIDGE_MS)).ok) continue;
        await stageFixture(lh.page, fx);
        await quietTransients(lh.page);
        await settleLayout(lh.page);
        const t = await lh.page.evaluate(audit.auditTapTargets);
        // Same reachability treatment as the dark pass — the light theme must
        // not be able to go red on a claim the dark theme is not held to.
        const reach = await probeAndSplit(lh, t);
        for (const line of reach.covered || []) r.info(`[${name} (cold, light)] not gated: ${line}`);
        const occ = await lh.page.evaluate(audit.auditOcclusion);
        surfaceIssues.push({
          label: `${name} (cold, light)`, small: t.fatal, zones: t.zones, advisory: t.advisory,
          off: reach.off, clipped: reach.clipped,
          offReachable: reach.offReachable, clippedReachable: reach.clippedReachable,
          covered: reach.covered,
          occ, dup: [], t,
        });
      }
      const dk = (n) => surfaceIssues.find((s) => s.label === `${n} (cold)`);
      let diverged = 0;
      for (const name of ['mid-game', 'discard-limit', 'five-player']) {
        const a = dk(name);
        const b = surfaceIssues.find((s) => s.label === `${name} (cold, light)`);
        if (!a || !b) continue;
        if (a.small.join('|') !== b.small.join('|')) {
          diverged++;
          r.fail(`[${name}] the light theme has DIFFERENT tap targets from dark — `
            + `${a.small.length} under 44px in dark, ${b.small.length} in light`);
        }
      }
      if (!diverged) r.pass('light and dark are geometrically identical on the surfaces measured');
      if (lh.errors.length) r.fail(`${lh.errors.length} console/page error(s) in the light theme`);
    }
    await lh.close();
  }

  ensureDir(SHOT_DIR);
  fs.writeFileSync(path.join(SHOT_DIR, 'coverage-touchtest.json'), JSON.stringify({
    tool: 'touchtest',
    generatedAt: new Date().toISOString(),
    captures,
    seen: Object.fromEntries(markerSeen),
  }, null, 1) + '\n');
  r.info(`${markerSeen.size}/${CENSUS.length} surface marker(s) seen → coverage-touchtest.json`);

  code = r.code;
} catch (e) {
  console.log(red(`  ✗ ${e.stack || e.message}`));
  code = EXIT_FAIL;
} finally {
  try { pubWs.close(); } catch { /* already down */ }
  if (browser) await browser.close().catch(() => {});
  await server.stop();
}

console.log(code === EXIT_PASS ? green(bold('touchtest: PASS')) : red(bold('touchtest: FAIL')));
process.exit(code);
