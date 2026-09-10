/**
 * tools/lib/touch.mjs — REAL touch input, via CDP Input.dispatchTouchEvent.
 * HARNESS-AGENT-OWNED (ARCHITECTURE.md §1, §8).
 *
 * Why this file exists (P7 round-1 finding, mobile critic):
 * touchtest.mjs used to dispatch `new PointerEvent(...)` from page JS. Those
 * events are created and delivered inside the renderer's script context — they
 * never enter the browser's real input pipeline, so:
 *
 *   • `touch-action` is never consulted (the compositor is not involved),
 *   • scroll/gesture arbitration never happens,
 *   • `preventDefault()` on a passive listener has no observable consequence,
 *   • no `touchstart`/`touchmove`/`touchend` is produced at all — only pointer.
 *
 * Result: the gate reported 9/9 PASS while a real thumb-drag that started
 * horizontally was dead on arrival (the compositor claimed the gesture for a
 * pan before the client ever saw a move). CDP `Input.dispatchTouchEvent` enters
 * at the browser process, produces real touch + compensated pointer + mouse
 * events, and is subject to touch-action exactly like a finger.
 *
 * Everything in tools/ that claims to test touch MUST go through here.
 */
import {
  PHONE, PHONE_DPR, PHONE_UA, LANDSCAPE,
} from './harness.mjs';
import { inspectReachability } from './audit.mjs';

/** iPhone 14/15 portrait software keyboard height, in CSS px. */
export const KEYBOARD_PX = 336;

/** Wrap a CDP session in the gesture vocabulary a thumb actually has. */
export function touchDriver(cdp) {
  const send = (type, points) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points, modifiers: 0 });
  const pt = (x, y, id = 1) => ({
    x: Math.round(x), y: Math.round(y), radiusX: 12, radiusY: 12, force: 1, id,
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /** A real tap: touchStart, dwell, touchEnd. No synthetic click is injected. */
  const tap = async (x, y, holdMs = 55) => {
    await send('touchStart', [pt(x, y)]);
    await wait(holdMs);
    await send('touchEnd', []);
  };

  /** Long press — the gesture that opens details / triggers context menus. */
  const press = async (x, y, ms = 650) => {
    await send('touchStart', [pt(x, y)]);
    await wait(ms);
    await send('touchEnd', []);
  };

  /**
   * Follow a path of points. `path` is [[x,y], ...] AFTER the start point.
   * stepMs 16 ≈ one frame; a human drag is 200–400ms, not one instant jump —
   * and the difference matters because drag thresholds are time+distance based.
   */
  const drag = async (x0, y0, path, { stepMs = 16, holdMs = 40, onStep } = {}) => {
    await send('touchStart', [pt(x0, y0)]);
    await wait(holdMs);
    for (let i = 0; i < path.length; i++) {
      await wait(stepMs);
      await send('touchMove', [pt(path[i][0], path[i][1])]);
      if (onStep) await onStep(i, path[i]);
    }
    await wait(stepMs);
    await send('touchEnd', []);
  };

  /** Straight-line drag from (x0,y0) to (x1,y1) in `steps` moves. */
  const swipe = (x0, y0, x1, y1, steps = 16, opts = {}) => drag(x0, y0,
    Array.from({ length: steps }, (_, i) => [
      x0 + ((x1 - x0) * (i + 1)) / steps,
      y0 + ((y1 - y0) * (i + 1)) / steps,
    ]), opts);

  /**
   * A drag whose FIRST movement is horizontal, then turns vertical. This is the
   * worst case for `touch-action` / scroll arbitration and is the exact gesture
   * the mobile critic found dead: the browser hands a horizontal-first gesture
   * to the pan handler unless the element opts out.
   */
  const dragHorizontalFirst = (x0, y0, x1, y1, opts = {}) => {
    const path = [];
    const lead = Math.max(40, Math.abs(x1 - x0) * 0.5) * (x1 >= x0 ? 1 : -1);
    for (let i = 1; i <= 8; i++) path.push([x0 + (lead * i) / 8, y0 + i]);
    const mx = x0 + lead;
    const my = y0 + 8;
    for (let i = 1; i <= 10; i++) {
      path.push([mx + ((x1 - mx) * i) / 10, my + ((y1 - my) * i) / 10]);
    }
    return drag(x0, y0, path, opts);
  };

  return { rawTouch: send, touchPoint: pt, tap, press, drag, swipe, dragHorizontalFirst };
}

/**
 * Open a page with a real touchscreen attached. Same error collection contract
 * as harness.openPage, plus the CDP session and the gesture vocabulary.
 */
export async function openTouchPage(browser, url, opts = {}) {
  const context = await browser.newContext({
    viewport: opts.viewport || PHONE,
    deviceScaleFactor: opts.dpr ?? PHONE_DPR,
    isMobile: true,
    hasTouch: true,
    userAgent: opts.userAgent || PHONE_UA,
    // P8 round 2: this was hardcoded 'dark', so the light theme was never
    // touch-tested at all — half of ART §2 had no mobile gate.
    colorScheme: opts.colorScheme || 'dark',
    reducedMotion: opts.reducedMotion || 'no-preference',
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  /**
   * P8 round 2 GAP (mobile critic): touchtest never reset client storage, and
   * hints are shown ONCE EVER out of `localStorage`. Instrumented at the
   * `payment-pending` stage, `chud_hints_v1` already held `["peek","drag","pay"]`
   * — consumed by the live game ninety seconds earlier in the same run. So §D's
   * "no decorative layer covers a primary CTA" was asserting against a build
   * where the decorative layer could no longer appear: an assertion structurally
   * incapable of failing.
   *
   * harness.mjs documented this exact trap for screenshot.mjs and shipped
   * `pristineStorage` for it; this file simply never called it. Same init-script
   * approach here so it survives every `page.goto` a stage does.
   */
  if (opts.pristine !== false) {
    await context.addInitScript(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch { /* private mode */ }
    });
  }
  const cdp = await context.newCDPSession(page);
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  return {
    page, context, cdp, errors,
    ...touchDriver(cdp),
    /** Cut the wire at the network stack — the client cannot tell this from a tunnel. */
    setOffline: (offline) => cdp.send('Network.emulateNetworkConditions', {
      offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    }).catch(() => cdp.send('Network.enable').then(() => cdp.send('Network.emulateNetworkConditions', {
      offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    }))),
    close: () => context.close(),
  };
}

/**
 * Wait until layout has stopped moving, then measure. Returns how long it took.
 *
 * P8 round 2: the hand-fan tap-target verdict moved between runs and between
 * settle times — `[46,46,46,44,42,42,42,56]` on one pass and
 * `[47,48,48,46,44,44,44,56]` on another — so `waitForTimeout(300)` was deciding
 * whether the gate was red. A fixed sleep is a guess about a machine's load; two
 * consecutive identical geometry reads are a fact about the layout. Same
 * argument as harness.stableScreenshot, one level up.
 */
export async function settleLayout(page, { gap = 120, budgetMs = 3000 } = {}) {
  const read = () => page.evaluate(() => [...document.querySelectorAll(
    '#zone-hand [data-card-id], [data-zone="hand"] [data-card-id], .propcol, button, #sheet, #side',
  )].map((e) => {
    const r = e.getBoundingClientRect();
    return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
  }).join('|'));
  const started = Date.now();
  let prev = await read();
  while (Date.now() - started < budgetMs) {
    await page.waitForTimeout(gap);
    const next = await read();
    if (next === prev) return { settled: true, ms: Date.now() - started };
    prev = next;
  }
  return { settled: false, ms: Date.now() - started };
}

/**
 * The §9 bridge, waited for HONESTLY.
 *
 * P8 round 2: touchtest returned `PENDING CLIENT` (exit 2, which strict verify
 * treats as failure) on 2 of 6 runs whenever a second headless Chromium was
 * live — an 8s budget on a loaded machine is a measurement of the machine, not
 * of the client. The budget is now 30s, which is not leniency about real
 * absence: `window.__CHUD` either gets defined by module evaluation or it never
 * does, and a client that has not shipped it still reports absent. What changes
 * is that "slow" stops being reported as "not implemented".
 */
export async function waitForBridge(page, budgetMs = 30000) {
  const started = Date.now();
  const found = await page.waitForFunction(() => !!window.__CHUD, null, { timeout: budgetMs })
    .then(() => true).catch(() => false);
  if (!found) return { ok: false, ms: Date.now() - started };
  await page.evaluate(() => window.__CHUD.ready).catch(() => {});
  return { ok: true, ms: Date.now() - started };
}

/**
 * REACHABILITY BY REAL SCROLL (P9 round 2).
 *
 * The clip audit's "on-screen and still unreachable" was a claim about a
 * GESTURE made from a geometry walk, and the round-2 mobile critic caught it
 * over-claiming with real CDP touch: the `.opponents` seat rail scrolls under
 * a thumb (scrollTop 0→61, partial-seat sliver, edge fade, 5px scrollbar) and
 * `.board-props` scrolls sideways with 39px of the next column showing —
 * both printed as unreachable. So before a clipped/off-viewport control is
 * allowed to stay red, this probes it the way a thumb would, and greens it
 * ONLY when all three legs hold:
 *
 *   (i)   the clipping ancestor ACTUALLY SCROLLED under a real dispatched
 *         swipe (scrollTop/scrollLeft moved — a page-side scrollTop write is
 *         exactly the fake this file exists to ban),
 *   (ii)  the control became ≥min(44px, its own size) reachable within
 *         `maxSwipes` swipes, by the same clipRect walk the audit gates on,
 *   (iii) the COLD frame carried a visible affordance on every cut axis —
 *         a partially-cut child ≥12px (the "next column showing" class), a
 *         classic scrollbar gutter ≥4px (overlay bars spend no layout and
 *         prove nothing), or an edge-fade mask on the scroller. Measured
 *         before the first probe swipe, because an affordance discovered by
 *         scrolling is not one the player had.
 *
 * A control failing ANY leg stays red with the failing leg named. What this
 * reclassification can no longer catch, on purpose and worth knowing:
 *   • a scroller whose affordance is technically present (a 12px sliver, a
 *     5px thumb) but that a player would never THINK to scroll —
 *     discoverability is measured here as geometry, not as behaviour;
 *   • a scroller that works from the port's CENTRE (where this probe puts
 *     the finger) but is dead from the edge a real thumb favours, e.g. when
 *     most of the port is covered by a draggable card that claims the
 *     gesture — one start point per swipe is all this measures;
 *   • a control needing up to `maxSwipes` (8) swipes: reachable-but-tedious
 *     now passes, where the old audit called everything past one port red.
 *
 * Scroll positions are restored and the probe stamps removed afterwards, so a
 * later audit on the same document measures the frame it was given, not the
 * one this probe left behind (the restore is a JS write — bookkeeping after
 * the measurement, not part of it).
 *
 * `entries`: [{ id, label, ... }] from auditTapTargets' clippedInfo /
 * offscreenInfo. Returns the same objects with { ok, line } added.
 */
export async function probeReachability(h, entries, opts = {}) {
  const {
    maxSwipes = 8, settleMs = 240, sliverMin = 12, gutterMin = 4,
  } = opts;
  const page = h.page;
  const results = [];

  /* Cold pass FIRST, for every entry, before anything is scrolled: leg (iii)
   * is a claim about the frame the player saw. */
  const cold = [];
  for (const e of entries) cold.push([e, await page.evaluate(inspectReachability, e.id)]);
  const orig = [];
  const seenScroller = new Set();
  for (const [, c] of cold) {
    const s = c.scroller;
    if (s && !seenScroller.has(s.stampId)) {
      seenScroller.add(s.stampId);
      orig.push([s.stampId, s.scrollLeft, s.scrollTop]);
    }
  }

  /** Leg (iii): every axis the scroller cuts on must announce itself. */
  const affFor = (s) => {
    const a = s.aff;
    const per = (axis) => {
      const parts = [];
      const sliver = axis === 'x' ? a.sliverX : a.sliverY;
      const gutter = axis === 'x' ? a.gutterX : a.gutterY;
      if (sliver >= sliverMin) parts.push(`${sliver}px partial ${axis === 'x' ? 'column' : 'row'}`);
      if (gutter >= gutterMin) parts.push(`${gutter}px scrollbar gutter`);
      if (a.mask) parts.push('edge-fade mask');
      return parts;
    };
    const axes = [];
    if (s.cutX) axes.push(['x', per('x')]);
    if (s.cutY) axes.push(['y', per('y')]);
    const ok = axes.length > 0 && axes.every(([, p]) => p.length > 0);
    const desc = axes.map(([ax, p]) => `${ax}: ${p.length ? p.join(' + ') : 'NONE'}`).join('; ');
    return { ok, desc };
  };

  for (const [e, c0] of cold) {
    const base = { ...e };
    results.push(base);
    const fail = (line) => { base.ok = false; base.line = line; };
    const pass = (line) => { base.ok = true; base.line = line; };
    if (!c0.found) { fail(`${e.label} — vanished before the reachability probe could touch it`); continue; }
    const s0 = c0.scroller;
    if (!s0 && !c0.reachable) { fail(`${e.label} — UNREACHABLE: no scrolling ancestor can reveal it`); continue; }
    const aff = s0 ? affFor(s0) : { ok: false, desc: 'no scroller' };

    /* Where the scroller stands NOW vs the cold frame. Read off the stamped
     * scroller itself: once a control has been revealed it is no longer cut,
     * so a fresh inspect returns `scroller: null` and cannot answer this. */
    const scrollNow = () => (s0 ? page.evaluate((stamp) => {
      const p = document.querySelector(`[data-chud-scroller="${CSS.escape(stamp)}"]`);
      return p ? { l: Math.round(p.scrollLeft), t: Math.round(p.scrollTop) } : null;
    }, s0.stampId) : null);

    /* Fresh read before swiping: a sibling entry's probe on the same scroller
     * may already have revealed this one, and the layout may have settled
     * since the audit measured. */
    let cur = await page.evaluate(inspectReachability, e.id);
    if (!cur.found) { fail(`${e.label} — vanished before the reachability probe could touch it`); continue; }
    if (cur.reachable) {
      const now = await scrollNow();
      const scrolledAlready = !!now && (now.l !== s0.scrollLeft || now.t !== s0.scrollTop);
      if (scrolledAlready && !aff.ok) {
        fail(`${e.label} — reachable by scroll, but the COLD frame showed no affordance on ${s0.label} `
          + `(${aff.desc}) — a scroller nothing announces is one nobody scrolls`);
      } else if (scrolledAlready) {
        pass(`${e.label} — reachable: revealed by this probe's swipes on the same scroller (${s0.label}, `
          + `scroll ${s0.scrollLeft},${s0.scrollTop}→${now.l},${now.t}; cold affordance ${aff.desc})`);
      } else {
        pass(`${e.label} — reachable without any scroll: the audit raced a settling layout`);
      }
      continue;
    }

    /* Legs (i)+(ii): swipe toward it, bounded, and re-measure each time. Two
     * swipes are enough to prove an ancestor immobile when its overflow says
     * it cannot scroll at all.
     *
     * Two thumb-realisms, both MEASURED in (dead swipes on a green scroller,
     * 2 of ~40 probes on unchanged code, which is exactly a moving gate §8
     * bans):
     *   • the finger does not insist on one spot — the start point walks
     *     across the port between attempts, so a child that claims the
     *     gesture at the centre (touch-action) cannot immobilise the probe;
     *   • a dead-looking swipe gets ONE grace re-read ~300ms later before it
     *     is believed: anim/flight.js opens `overflow` on every clipping
     *     ancestor of a card in flight, so for that window the rail is
     *     genuinely not a scroller — a player mid-announce hits the same
     *     dead 300ms and simply swipes again.
     * Deltas are read off the STAMPED scroller, not the re-inspect: once the
     * control is revealed it stops being cut and the inspect returns no
     * scroller to read. */
    const budget = (s0.canX || s0.canY) ? maxSwipes : 2;
    const CROSS = [0.5, 0.35, 0.65, 0.28, 0.72, 0.45, 0.6, 0.5];
    let swipes = 0;
    let moved = 0;
    let lastPos = { l: s0.scrollLeft, t: s0.scrollTop };
    while (swipes < budget && cur.found && !cur.reachable) {
      const s = cur.scroller || s0;
      const port = s.port;
      const portW = port.r - port.l;
      const portH = port.b - port.t;
      const rect = cur.rect;
      const defY = Math.max(rect.b - port.b, port.t - rect.t);
      const defX = Math.max(rect.r - port.r, port.l - rect.l);
      if (defY <= 1 && defX <= 1) break;      // cut by something scrolling cannot fix
      const axis = defY >= defX ? 'y' : 'x';
      const frac = CROSS[swipes % CROSS.length];
      /* Swipe the distance the deficit ASKS FOR (+12px of margin), never the
       * whole port. MEASURED on the announce rail (port 88px, seat 51px,
       * maxY 77): the seat is reachable at ANY scrollTop in [19, 70] — a
       * 51px-wide green window — but a full-port (74px) swipe parked at
       * 69–75 from one end and 0–6 from the other, i.e. a bang-bang
       * oscillator that crossed the window twice per cycle and landed inside
       * it only by fling luck (8 misses in a row ≈ 1 gate run in 4 red on
       * unchanged code). A deficit-sized swipe converges: overshoot makes the
       * NEXT deficit small, which makes the next swipe small. It is also
       * what a thumb does — nobody flings a rail by its full height to
       * reveal the 26px they are missing. */
      if (axis === 'y') {
        const below = (rect.b - port.b) >= (port.t - rect.t);
        const need = below ? rect.b - port.b : port.t - rect.t;
        const cx = Math.min(Math.max(port.l + portW * frac, port.l + 8), port.r - 8);
        const cy = (port.t + port.b) / 2;
        const span = Math.min(Math.max(need + 12, 24), Math.max(portH - 14, 24), 300);
        const dir = below ? -1 : 1;                  // content below → finger up
        await h.swipe(cx, cy - (dir * span) / 2, cx, cy + (dir * span) / 2, 14);
      } else {
        const right = (rect.r - port.r) >= (port.l - rect.l);
        const need = right ? rect.r - port.r : port.l - rect.l;
        const cx = (port.l + port.r) / 2;
        const cy = Math.min(Math.max(port.t + portH * frac, port.t + 8), port.b - 8);
        const span = Math.min(Math.max(need + 12, 24), Math.max(portW - 14, 24), 300);
        const dir = right ? -1 : 1;                  // content right → finger left
        await h.swipe(cx - (dir * span) / 2, cy, cx + (dir * span) / 2, cy, 14);
      }
      swipes++;
      await page.waitForTimeout(settleMs);
      let next = await page.evaluate(inspectReachability, e.id);
      let now = await scrollNow();
      if (now && now.l === lastPos.l && now.t === lastPos.t && next.found && !next.reachable) {
        await page.waitForTimeout(300);              // the grace beat — see above
        next = await page.evaluate(inspectReachability, e.id);
        now = await scrollNow();
      }
      if (now) {
        moved += Math.abs(now.l - lastPos.l) + Math.abs(now.t - lastPos.t);
        lastPos = now;
      }
      cur = next;
    }

    if (!cur.found) { fail(`${e.label} — vanished mid-probe after ${swipes} swipe(s)`); continue; }
    if (!cur.reachable) {
      if (moved < 2) {
        fail(`${e.label} — UNREACHABLE: ${s0.label} (overflow ${s0.overflowX}/${s0.overflowY}) `
          + `never moved under ${swipes} real swipe(s)`);
      } else {
        fail(`${e.label} — UNREACHABLE: still only ${Math.round(cur.reach.w)}×${Math.round(cur.reach.h)} `
          + `exposed after ${swipes} swipe(s) (${s0.label} scrolled ${Math.round(moved)}px)`);
      }
      continue;
    }
    if (!aff.ok) {
      const at = await scrollNow();
      const net = at ? Math.abs(at.l - s0.scrollLeft) + Math.abs(at.t - s0.scrollTop) : Math.round(moved);
      fail(`${e.label} — reachable by force (${s0.label} scrolled ${net}px in ${swipes} swipe(s)) `
        + `but the COLD frame showed no affordance (${aff.desc}) — a scroller nothing announces is one nobody scrolls`);
      continue;
    }
    const end = await scrollNow();
    pass(`${e.label} — reachable: ${swipes} real swipe(s) on ${s0.label} took scroll `
      + `${s0.scrollLeft},${s0.scrollTop}→${end ? `${end.l},${end.t}` : '?'} `
      + `(cold affordance ${aff.desc})`);
  }

  /* Put the frame back and take the stamps off. */
  await page.evaluate((positions) => {
    for (const [stampId, left, top] of positions) {
      const p = document.querySelector(`[data-chud-scroller="${CSS.escape(stampId)}"]`);
      if (p) { p.scrollLeft = left; p.scrollTop = top; }
    }
    for (const el of document.querySelectorAll('[data-chud-scroller]')) el.removeAttribute('data-chud-scroller');
    for (const el of document.querySelectorAll('[data-chud-reach]')) el.removeAttribute('data-chud-reach');
  }, orig);
  return results;
}

/** Centre + geometry of the nth match, or null if absent/zero-sized. */
export function centre(page, selector, nth = 0) {
  return page.evaluate(([sel, n]) => {
    const el = document.querySelectorAll(sel)[n];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return {
      x: r.left + r.width / 2, y: r.top + r.height / 2,
      w: Math.round(r.width), h: Math.round(r.height),
      top: Math.round(r.top), left: Math.round(r.left),
      right: Math.round(r.right), bottom: Math.round(r.bottom),
    };
  }, [selector, nth]);
}

export { PHONE, PHONE_DPR, PHONE_UA, LANDSCAPE };
