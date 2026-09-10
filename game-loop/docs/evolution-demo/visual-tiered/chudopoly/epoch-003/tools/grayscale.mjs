#!/usr/bin/env node
/**
 * tools/grayscale.mjs — ART-DIRECTION §10's grayscale ship gate, measured.
 *
 * The gate, verbatim from §10: "Grayscale `mid-game@desktop`: is hierarchy still
 * readable?" §3 states the diagnosis: "everything sits within ~8% luminance."
 *
 * Everything is in **CIE L\*** (perceptual lightness, 0–100), never in linear
 * relative luminance. Linear Y is savagely compressed at the dark end — a dark
 * apron's whole tonal life happens between Y 0.019 and Y 0.035, a 1.6% span that
 * reads as "flat" in Y and as a visible 14 L\* to an eye — so a threshold in Y
 * either passes everything dark or fails everything dark.
 *
 * ─── WHY THIS FILE WAS REWRITTEN (P8 round 2) ────────────────────────────
 * The first version asserted two whole-frame numbers: a p5→p95 histogram spread,
 * and a count of "tonal tiers" among five fixed screen regions averaged to one
 * number each. A fresh LOOK critic desaturated the frames by hand instead of
 * trusting it and found four things wrong, all reproduced here before the
 * rewrite:
 *
 *   1. IT WAS SPATIALLY BLIND. A histogram of the whole frame says nothing about
 *      whether two things a player must tell apart are separable *where they
 *      touch*. Measured on the light build it was passing: card 72.4 L\* on mat
 *      81.1 L\* — a Δ of 8.7, below the file's OWN stated 12 L\* "this is a
 *      decision, not a rendering artefact" threshold — and the verdict was pass.
 *   2. THE TIERS CHAINED. Tiers were grown by comparing each region to the
 *      running upper edge, so card 72.4 → mat 81.1 → chrome 91.4 all landed in
 *      one "tier" spanning 19 L\*. Transitive adjacency is not a gap.
 *   3. ONE ELEMENT BOUGHT THE PASS. In light, the third tier was supplied
 *      entirely by the single black End-turn button. A hierarchy gate a lone
 *      button can satisfy is not measuring hierarchy.
 *   4. THE PRINTED DIAGNOSTIC WAS BACKWARDS. It averaged the cards (72.4) with
 *      the ink slab (14.5) into "figure 43.5" and the apron/mats/chrome into
 *      "ground 77.5", and printed `Δ 34.0` — telling every reader that the
 *      figures were DARKER than the ground in a theme where the cards are the
 *      lightest thing on screen.
 *
 * ─── WHAT IS MEASURED NOW ────────────────────────────────────────────────
 * One question per PAIR of things a player must tell apart, sampled from the
 * geometry the client actually rendered (`getBoundingClientRect` + hit testing),
 * never from fixed screen rectangles:
 *
 *     a card against the mat it is lying on
 *     a card against the dock/apron behind the hand
 *     a mat against the apron
 *     a chrome panel against what is painted next to it
 *     the primary action against the bar it sits in
 *     a text run against its own plate
 *
 * Each side of a pair is a MEDIAN L\*, not a mean. A card face is 15–25% ink and
 * carries a §2 colour band; its mean is a number about nothing, and averaging a
 * region is what destroyed the old metric's information. The median is the tone
 * of the field, which is the thing being separated.
 *
 * Pairs are DIRECT comparisons, so nothing can chain (defect 2), and every pair
 * must clear the bar on its own, so no single element can carry the frame
 * (defect 3).
 *
 * ─── TWO CHANNELS, BOTH MEASURED ─────────────────────────────────────────
 * Separation can arrive two ways and this gate counts both, because ART ships
 * both:
 *
 *   FIELD  |median(A) − median(B)| — the tonal step between the two surfaces.
 *   EDGE   the p5→p95 tonal swing in a band straddling A's boundary, per side,
 *          reported as the MEDIAN of the four sides. This is `--card-edge`
 *          (#D9D2C4, L\* 84.4) and §4's "paper casts a soft shadow", and the
 *          3px solid rail §2 gives every mat. Median-of-four, because an offset
 *          drop shadow is real separation on two sides and nothing on the other
 *          two, and a §2 colour band sits inside exactly one side — letting
 *          either buy a pass alone would re-import defect 3 through the back
 *          door.
 *
 * `sep = max(field, edge)`, and the CARRIER is printed for every pair. That
 * matters: "cream cards on warm concrete, separated only by a hairline and a
 * shadow" and "cream cards on a mat you can see" are different designs with the
 * same verdict, and the designer needs to know which one they have.
 *
 * A flat |figure − ground| assertion was tried in the first version and rejected
 * for the right reason (§2 puts L\* 97.6 stock on L\* ~88 mats in light, so a
 * 25 L\* demand fails the ratified design) — but the conclusion drawn from it,
 * "therefore assert something global instead", was wrong. The right conclusion
 * was to measure the edge channel instead of asserting it in a comment.
 *
 * SEP_MIN is 12 L\*, the same number the old header claimed and did not enforce:
 * about where a step stops being a rendering artefact and starts being a
 * decision. It is now applied per pair, to real adjacent geometry.
 *
 * BULK tonal range survives as a second, weaker assertion (p5→p95 ≥ 45 L\*).
 * It is necessary, not sufficient: it catches "every surface is one grey" for
 * one cheap number, and it is explicitly NOT the hierarchy test.
 *
 * ─── WHERE THE BUILD LANDS (re-measured 2026-08-07, seed 1337, 1280x720) ──
 * BOTH THEMES PASS: all 16 adjacent pairs clear 12 L\* in dark and in light.
 *
 * They did NOT when this file was rewritten a day earlier, and the failing
 * numbers are kept here because they are the evidence that the gate
 * discriminates on a real build rather than only on the synthetic rows:
 *
 *                                     field  edge   sep
 *   DARK   property mat on #table       1.9   8.1   8.1  FAIL   -> now 15.1
 *          .board-opponent on #table    2.6   8.5   8.5  FAIL   -> now 18.2
 *          #hud vs what is next to it   0.1  10.7  10.7  FAIL   -> now 24.5
 *   LIGHT  property mat on #table       1.0   5.3   5.3  FAIL   -> now 20.1
 *          .board-opponent on #table    5.3   8.1   8.1  FAIL   -> now 20.8
 *          .board-bank on .board        0.0  11.2  11.2  FAIL   -> now 25.5
 *
 * WHAT ACTUALLY CHANGED IS WORTH READING. The apron moved, not the mats: dark
 * `#table` went 13.8 -> 14.1 while the panels went 14.1 -> 30.0, and light
 * `#table` went 87.8 -> 84.4 while the panels went 94.2 -> 70.1. The furniture
 * layer stepped DOWN and away from the ground in both themes, which is exactly
 * the direction `--prove`'s stepped rows said was the only one available in
 * light (`--ground` leaves ten L\* of headroom before white, so nothing above
 * the apron can reach a 12 L\* step).
 *
 * BUT THE PASS IS CARRIED BY EDGES, NOT BY TONE, and the gate says so on every
 * run: 12/12 (dark) and 10/12 (light) structural pairs are carried by the edge
 * channel, and the weakest FIELD step in both themes is 0.0 L\* — `#hud`
 * against what is painted next to it, and `.board-bank` inside `.board`, are
 * the same tone as their surroundings and are separated purely by a stroke and
 * a shadow. That is a legitimate design position (ART SS4: "paper casts a soft
 * shadow") and it is why the edge channel is measured rather than assumed. It
 * is also fragile in a nameable way: `--prove`'s "light, edge+shadow removed"
 * row is that same palette with the strokes taken away, and it fails at 4.4.
 *
 * Measured token tones behind those rows:
 *   light  stock 97.3 . panels 70.1 . apron 84.4 . mats ~64.5 . bulk 31.1->95.9
 *   dark   stock 97.3 . panels 30.0 . apron 14.1 . mats ~25.2 . bulk  3.6->94.2
 *
 * Exits 2 (PENDING CLIENT) until window.__CHUD exists.
 */
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  FIXTURE_DIR, DESKTOP, SEED,
  parseArgs, launchBrowser, openPage, requireBridge, readJSON, reporter,
  stableScreenshot, pristineStorage, dim, yellow, EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';
import { lightnessField, lightnessStats, sampleRect, edgeSwing, inkOnPlate } from './lib/pixels.mjs';
import * as audit from './lib/audit.mjs';
import { applyTheme, THEMES } from './lib/theme.mjs';
import { startServer } from './serve.mjs';

const args = parseArgs();
const seed = args.seed ? Number(args.seed) : SEED;

/** §10 names one surface. Both themes of it, because §2 ships two. */
const FIXTURE = 'mid-game';

const MIN_BULK = 45;      // L*, p5→p95 of the whole frame — necessary, not sufficient
const SEP_MIN = 12;       // L*, per adjacent pair, on the better of the two channels
/**
 * A gate that measured nothing must not report a pass. The flat-grey mutation
 * paints a full-bleed layer over the whole frame; every surface is then inside a
 * veil rect, every sample comes back empty, and `pairs.every(...)` on an empty
 * list is vacuously true. It failed on bulk range alone, which is luck, not a
 * gate. The real build resolves 16 pairs.
 */
const MIN_PAIRS = 8;
const INSET = 4;          // px kept off a surface's own border when reading its field
const EDGE_OUT = 6;       // px of the boundary band outside the rect
const EDGE_IN = 6;        // px of it inside

/**
 * The surfaces to find, by role. `sel` is tried against the live document; every
 * match is a candidate and the least-occluded one becomes the pair's subject
 * (see `collectSurfaces`). A role that matches nothing is a WARNING with the
 * role named, never a silent skip — the old tool's `missing` list existed for
 * the same reason and is kept.
 */
const ROLES = [
  { key: 'card', sel: '.card-face', what: 'card face' },
  { key: 'back', sel: '.card-facedown', what: 'card back' },
  { key: 'mat', sel: '.propcol', what: 'property mat' },
  { key: 'panel', sel: '#hud, #hand-dock, .board-bank, .board-opponent, #prompt', what: 'chrome panel' },
  { key: 'action', sel: '#btn-end-turn, .btn-primary, #prompt button, [data-action="end-turn"]', what: 'primary action' },
];

/**
 * How many of a role's elements are measured per backdrop, and how uncovered one
 * has to be to count.
 *
 * NOT one representative. Measured: `.card-face` medians on this fixture run
 * from 39.3 to 97.3 L\* — a bank note is mostly ink, a property card is mostly
 * stock — so "the card" is not a tone, and whichever element a picker happened
 * to choose set the verdict. Every sufficiently-uncovered candidate is measured
 * and the pair reports the WORST one: the hardest card to tell apart from the
 * mat it is on is the one that decides whether the hierarchy reads.
 */
const MAX_PER_PAIR = 8;
const MIN_CLEAR = 0.7;

/**
 * Text runs, measured against their OWN plate out of the same rect (the median
 * of a text box is its background; the far tail is the ink). checkContrast.mjs
 * owns the exhaustive WCAG sweep — these four exist so §10's question covers the
 * "text against its own plate" case on the surfaces ART §1/§2 name by hand.
 */
const TEXT_ROLES = [
  { key: 'card ink', sel: '.ca-title, .card-name, .ca-band-name' },
  { key: 'action ink', sel: '#btn-end-turn, .btn-primary' },
  { key: 'mat ink', sel: '.propcol-name, .zone-tag, .pile-label' },
  { key: 'hud ink', sel: '.hud-turn, .chip, .board-name' },
];

/**
 * Everything decorative that must not be measured AS a surface or counted
 * against one. The coach layer is shown "once ever" out of localStorage, which
 * `pristineStorage` resets, so it is reliably present in every take — and a
 * transient teaching bubble is not the design's tonal hierarchy.
 */
const VEIL = '.hints, .hint-card, #toast, #emotes, .floaters, .floater, .burst, .fx, .fx-layer';

/**
 * IN-PAGE. Find each role's subject and its painted backdrop, from the geometry
 * the client actually rendered.
 *
 * The backdrop is resolved by walking up to the nearest ancestor that PAINTS
 * (opaque background-color or a background-image), which is how the browser
 * itself decides what shows through: a `.card-face` in the fan resolves to
 * `#hand-dock`, the same face in a property column resolves to `.propcol`, and a
 * `.propcol` resolves to `#table`. Nothing here is a hardcoded pairing, so a
 * layout change moves the pairs instead of silently measuring the wrong thing.
 *
 * Candidates that are mostly buried are dropped with the shared hit test
 * (`audit.openHitTesting`, installed by `installPageHelpers`). Cards are stacked
 * by design; measuring the field of a card with three-quarters of another card
 * on top of it is measuring the other card. What survives is measured in full.
 */
function collectSurfaces([roles, textRoles, veilSel, maxPer, minClear]) {
  const open = window.__chudHitTesting;
  if (typeof open !== 'function') {
    throw new Error('audit.installPageHelpers(context) was never called — no hit testing in this page');
  }
  const hit = open();
  try {
    const px = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
    const name = (el) => {
      if (!el) return '?';
      const cls = (el.getAttribute?.('class') || '').trim().split(/\s+/).filter(Boolean)[0];
      return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`;
    };
    /** Alpha out of any computed colour form Chromium prints, incl. oklab(… / a). */
    const alphaOf = (c) => {
      const s = String(c || '').trim();
      if (!s || s === 'transparent' || s === 'none') return 0;
      const rgba = s.match(/rgba?\(([^)]+)\)/);
      if (rgba) {
        const p = rgba[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return p.length > 3 ? p[3] : 1;
      }
      const slash = s.match(/\/\s*([\d.]+)(%?)\s*\)/);
      if (slash) return slash[2] ? Number(slash[1]) / 100 : Number(slash[1]);
      return 1;
    };
    const paints = (el) => {
      const st = getComputedStyle(el);
      return st.backgroundImage !== 'none' || alphaOf(st.backgroundColor) >= 0.5;
    };
    const vis = (el) => {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.1) return false;
      for (let p = el; p; p = p.parentElement) {
        if (p.hasAttribute?.('hidden')) return false;
        if (Number(getComputedStyle(p).opacity) < 0.1) return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 14 && r.height > 14
        && r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0;
    };

    const veils = [...document.querySelectorAll(veilSel)]
      .filter((el) => {
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.05) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        // A layer that positions children and paints nothing is not in the way.
        return alphaOf(st.backgroundColor) > 0.05 || st.backgroundImage !== 'none'
          || (el.textContent || '').trim().length > 0;
      })
      .map(px);

    const backdropOf = (el) => {
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        if (paints(p) && vis(p)) return p;
      }
      return document.body;
    };
    /** Rects of everything painted ON a backdrop, so its own field can be read. */
    const litter = (b) => {
      const out = [];
      for (const e of b.querySelectorAll('*')) {
        if (out.length >= 300) break;
        if (!vis(e)) continue;
        if (!paints(e) && !e.matches('.card, .card-face, .card-back, [data-card-id]')) continue;
        out.push(px(e));
      }
      return out;
    };

    const surfaces = [];
    const missing = [];
    for (const role of roles) {
      const els = [...document.querySelectorAll(role.sel)].filter(vis);
      if (!els.length) { missing.push(role.key); continue; }
      // One pair per (role, backdrop): "a card on a mat" and "a card on the
      // dock" are two different questions and both get asked.
      const groups = new Map();
      for (const el of els) {
        const clear = 1 - hit.coverage(el, el.getBoundingClientRect()).pct;
        if (clear < minClear) continue;
        const b = backdropOf(el);
        const k = name(b);
        if (!groups.has(k)) groups.set(k, { b, items: [], seen: 0 });
        const g = groups.get(k);
        g.seen++;
        // Widest first: a bigger uncovered face is a more honest field read, and
        // the cap only exists so a 40-card table does not cost 40 samplings.
        g.items.push({ el, clear, rect: px(el) });
      }
      for (const [bname, g] of groups) {
        g.items.sort((a, c) => (c.rect[2] * c.rect[3]) - (a.rect[2] * a.rect[3]));
        surfaces.push({
          role: role.key,
          what: role.what,
          plate: bname,
          plateRect: px(g.b),
          plateLitter: litter(g.b),
          seen: g.seen,
          items: g.items.slice(0, maxPer).map((it) => ({
            el: name(it.el), rect: it.rect, clear: Math.round(it.clear * 100) / 100,
          })),
        });
      }
    }

    /**
     * Text is measured over the GLYPH box, not the element box.
     *
     * `span.board-name` is 731px wide on the self board and holds a six-letter
     * name; its element rect is >98% plate, the ink never reaches the 1.5% floor
     * `inkOnPlate` needs, and the gate reported white-on-charcoal chrome text as
     * a 4.5 L\* violation. `Range.getBoundingClientRect()` over the element's
     * contents is the box the browser actually painted glyphs into. Padded by
     * 2px so the plate is still the modal population inside it.
     */
    const glyphBox = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      range.detach?.();
      if (!r.width || !r.height) return null;
      return [r.left - 2, r.top - 2, r.width + 4, r.height + 4];
    };

    const texts = [];
    for (const role of textRoles) {
      const items = [];
      for (const el of document.querySelectorAll(role.sel)) {
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.1) continue;
        if (!(el.textContent || '').trim()) continue;
        const box = glyphBox(el);
        if (!box || box[2] < 14 || box[3] < 8) continue;
        if (box[0] < 0 || box[1] < 0 || box[0] + box[2] > innerWidth || box[1] + box[3] > innerHeight) continue;
        const clear = 1 - hit.coverage(el, el.getBoundingClientRect()).pct;
        if (clear < minClear) continue;
        items.push({ el: name(el), rect: box, clear: Math.round(clear * 100) / 100 });
      }
      if (!items.length) { missing.push(role.key); continue; }
      items.sort((a, b) => (b.rect[2] * b.rect[3]) - (a.rect[2] * a.rect[3]));
      texts.push({ role: role.key, items: items.slice(0, maxPer), seen: items.length });
    }

    return { surfaces, texts, veils, missing, dpr: devicePixelRatio, w: innerWidth };
  } finally {
    hit.close();
  }
}

/**
 * The backdrop measured from the pixels immediately OUTSIDE a surface, used when
 * the DOM backdrop has no uncovered pixels of its own left to read.
 *
 * `#hud` and `#hand-dock` are full-bleed children of `#screen-game`; their DOM
 * plate is 100% covered by them and their siblings, so its "own field" is empty.
 * What a player actually sees next to the HUD is the apron, and that is what
 * this reads. Reported as `(adjacent)` so nobody mistakes it for the DOM answer.
 */
function adjacentField(field, png, rect, scale, excludes) {
  const [x, y, w, h] = rect;
  const G = 3;                       // skip the element's own shadow/stroke
  const D = 12;                      // depth of the band read as "next to it"
  const bands = [
    [x, y - G - D, w, D], [x, y + h + G, w, D],
    [x - G - D, y, D, h], [x + w + G, y, D, h],
  ];
  const meds = bands
    .map((b) => sampleRect(field, png, b, { scale, excludes, bleed: 0, maxSamples: 20000 }))
    .filter((s) => s && s.n >= 60)
    .map((s) => s.median)
    .sort((a, b) => a - b);
  if (!meds.length) return null;
  return { median: meds[Math.floor((meds.length - 1) / 2)], n: meds.length, adjacent: true };
}

async function measure(page, extraCss) {
  if (extraCss) await page.addStyleTag({ content: extraCss });
  // Not a timeout: the fan lays out and the card faces build over several
  // frames, and a percentile sits exactly on the boundary of how much card stock
  // is painted (see harness.stableScreenshot's note).
  const frame = await stableScreenshot(page);
  const png = PNG.sync.read(frame.buffer);
  const field = lightnessField(png);
  const stats = lightnessStats(field);
  const scale = png.width / (await page.evaluate(() => innerWidth));
  const geo = await page.evaluate(collectSurfaces, [ROLES, TEXT_ROLES, VEIL, MAX_PER_PAIR, MIN_CLEAR]);

  const pairs = [];
  for (const s of geo.surfaces) {
    /* The plate is measured ONCE per pair: it is the same surface for every
     * candidate lying on it. Its own painted children are subtracted, or the
     * mean of a mat with four cards on it is the mean of the cards. */
    let plate = sampleRect(field, png, s.plateRect, {
      scale, excludes: [...s.plateLitter, ...geo.veils], maxSamples: 40000,
    });
    let adjacent = false;
    if (!plate || plate.n < 200) {
      plate = adjacentField(field, png, s.items[0].rect, scale, geo.veils);
      adjacent = true;
    }
    if (!plate) continue;

    let worst = null;
    let measured = 0;
    for (const it of s.items) {
      const own = sampleRect(field, png, it.rect, {
        scale, inset: INSET, excludes: geo.veils, maxSamples: 40000,
      });
      if (!own) continue;
      const edge = edgeSwing(field, png, it.rect, {
        scale, out: EDGE_OUT, inn: EDGE_IN, excludes: geo.veils,
      });
      measured++;
      const fieldDelta = Math.abs(own.median - plate.median);
      const edgeDelta = edge.median ?? 0;
      const sep = Math.max(fieldDelta, edgeDelta);
      if (worst && sep >= worst.sep) continue;
      worst = {
        el: it.el, rect: it.rect, clear: it.clear,
        a: own.median, field: fieldDelta, edge: edgeDelta, sides: edge.sides, sep,
        carrier: fieldDelta >= edgeDelta ? 'field' : 'edge',
      };
    }
    if (!worst) continue;
    pairs.push({
      ...worst,
      label: `${s.what} on ${adjacent ? 'what is next to it' : s.plate}`,
      b: plate.median,
      of: measured,
      seen: s.seen,
      kind: 'surface',
    });
  }

  for (const t of geo.texts) {
    let worst = null;
    let measured = 0;
    for (const it of t.items) {
      const m = inkOnPlate(field, png, it.rect, { scale, excludes: geo.veils });
      if (!m) continue;
      measured++;
      if (worst && m.delta >= worst.field) continue;
      worst = { el: it.el, rect: it.rect, clear: it.clear, a: m.ink, b: m.plate, field: m.delta };
    }
    if (!worst) continue;
    pairs.push({
      ...worst,
      label: `${t.role} on its plate`,
      edge: 0,
      sides: null,
      sep: worst.field,
      carrier: 'field',
      of: measured,
      seen: t.seen,
      kind: 'text',
    });
  }

  return {
    bulk: stats.bulk, p5: stats.p5, p50: stats.p50, p95: stats.p95, bins: stats.bins,
    pairs,
    missing: geo.missing,
    settled: frame.settled,
    settleMs: frame.ms,
  };
}

/* ─── the calibration rig (§8: a gate must be proven to fail) ───────────────
 *
 * These are NOT a proposed patch — public/ is not ours (§1). They are four
 * synthetic builds whose verdict is known in advance, and the gate has to agree
 * with all four or it is a decoration.
 *
 * Written in CSS `lab()`, where the first component IS CIE L\* — the same axis
 * the gate measures — so each rule states its own expected number instead of
 * hiding it in a hex. (`lab()` is D50 and the gate's L\* comes from sRGB
 * relative luminance, so measured values land within ~1 L\* of the literal.)
 */

/**
 * ART §2's LIGHT tokens exactly as ratified — and it FAILS, which is the single
 * most useful row in this table.
 *
 * `--surface` 94.2, `--ground` 90.0, mats ~88, `--ground-deep` 82.6: the entire
 * light furniture layer lives inside a 12 L\* window, and `--ground` at 90.0
 * leaves only 10 L\* of headroom before white, so nothing above the apron can
 * ever reach a 12 L\* step. Light-theme hierarchy under these tokens is carried
 * by edge stroke and shadow alone. That is a real design position and it is
 * exactly what the LOOK critic measured as 1.19:1 in colour — but it is not a
 * tonal hierarchy, and this gate now says so with the palette in hand.
 */
const SIM_ART2_LIGHT = `
  #table, .table, #app, #table-center, .pile, #screen-game { background: #E8E2D4 !important; }
  #hud, .board, .board-opponent, .board-bank { background: #F3EEE3 !important; }
  #hand-dock { background: #D5CDBB !important; }
  .propcol { background: #DED7C8 !important; }
  .card, .card-face, .card-inner { background: #FBF8F1 !important; }
  .card, .card * { color: #14161A !important; }
  .btn-primary, #btn-end-turn { background: #14161A !important; color: #FBF8F1 !important; }`;

/**
 * The same design with a real furniture step, and it PASSES. This is the target
 * the design agent can aim at, stated as four numbers instead of an adjective:
 *
 *   apron  L* 90   (--ground, unchanged)
 *   panels L* 76   (boards + HUD: 14 L* below the apron, not 4 above it)
 *   mats   L* 60   (16 L* below the panels they sit in, 30 below the apron)
 *   stock  L* 97.6 (--card-stock, unchanged)
 *
 * The direction of travel matters and is forced by the palette: at `--ground`
 * 90.0 there are only 10 L\* left above it, so every step in the light theme has
 * to go DOWN. Either the apron comes down to make room upward, or the furniture
 * goes down. Nothing else clears 12 L\*.
 */
const SIM_STEPPED_LIGHT = `
  #table, .table, #app, #table-center, .pile, #screen-game { background: lab(90% 1 6) !important; }
  #hud, .board, .board-opponent { background: lab(76% 1 7) !important; }
  .propcol, .board-bank { background: lab(60% 1 7) !important; }
  #hand-dock { background: lab(82% 1 6) !important; }
  .card, .card-face, .card-inner { background: #FBF8F1 !important; }
  .card, .card * { color: #14161A !important; }
  .btn-primary, #btn-end-turn { background: #14161A !important; color: #FBF8F1 !important; }`;

/**
 * The same stepped structure in the dark theme, and it PASSES.
 *
 * The apron literals are 6 L\* below their measured result on purpose: whatever
 * `#table` paints on top of its background colour in this build (grain/vignette)
 * lifts `lab(8%)` to a measured 14.6, and the first attempt at this row —
 * apron 8, panels 22 — came back 9.9 L\* apart and red. The rig is calibrated
 * against the MEASUREMENT, not against the literal, which is the whole reason
 * these rows exist.
 */
const SIM_STEPPED_DARK = `
  #table, .table, #app, #table-center, .pile, #screen-game { background: lab(8% 0 -1) !important; }
  #hud, .board, .board-opponent { background: lab(30% 0 -1) !important; }
  .propcol, .board-bank { background: lab(46% 0 -1) !important; }
  #hand-dock { background: lab(4% 0 -1) !important; }
  .card, .card-face, .card-inner { background: #FBF8F1 !important; }
  .card, .card * { color: #14161A !important; }
  .btn-primary, #btn-end-turn { background: #F2EEE4 !important; color: #14161A !important; }`;
/* Every surface one grey. The cheapest thing a broken theme can look like. */
const SIM_FLAT = `
  *, *::before, *::after { background: #2a2d33 !important; color: #303338 !important;
    box-shadow: none !important; border-color: #2a2d33 !important; text-shadow: none !important;
    outline: none !important; }`;
/* A plausible, PRETTY light theme with no §1 ink slab: cream cards on warm
 * concrete and a quiet primary action. It has to fail on the action pair. */
const SIM_NO_SLAB = `
  #table, .table, #app, #table-center, .pile, #hand-dock, #hud, .opponents > *, #screen-game
    { background: #E8E2D4 !important; }
  .propcol, .board-bank { background: #DED7C8 !important; }
  .card, .card-face, .card-inner { background: #FBF8F1 !important; }
  .btn-primary, #btn-end-turn { background: #DCD5C6 !important; color: #4A4E56 !important;
    box-shadow: none !important; }`;
/* The mutation the OLD gate could not see and this one exists for: the ratified
 * light palette with its edge treatment removed. Bulk range is untouched, the
 * ink slab is still there so the old tier count still found three — and a card
 * on a mat is now a 9 L* field step with no stroke and no shadow to find it by.
 * This is the "cream on concrete at 1.19:1" build with nothing holding it up. */
const SIM_NO_EDGE = `
  .card, .card-face, .card-inner, .card-back, .propcol, .board-bank, #hud, #hand-dock,
  .chip, .board-worth, .pile, .cardzone, [data-card-id]
    { box-shadow: none !important; border: 0 !important; outline: none !important;
      filter: none !important; }
  .propcol { background-image: none !important; }`;

const r = reporter('grayscale');
const server = await startServer({ seed });
let browser = null;
let code = EXIT_PASS;

const verdict = (m) => (m.bulk >= MIN_BULK && m.pairs.length >= MIN_PAIRS
  && m.pairs.every((p) => p.sep >= SEP_MIN) ? 'pass' : 'fail');
const line = (m) => {
  const worst = [...m.pairs].sort((a, b) => a.sep - b.sep)[0];
  return `bulk ${m.bulk.toFixed(1)} L*  ·  ${m.pairs.length} pairs  ·  `
    + `weakest ${worst ? `${worst.label} ${worst.sep.toFixed(1)} L* (${worst.carrier})` : '—'}`;
};

try {
  browser = await launchBrowser();
  const h = await openPage(browser, `${server.url}/?harness=1&seed=${seed}`, { viewport: DESKTOP, dpr: 1 });
  // Same reason as screenshot.mjs: the coach layer is shown "once ever" out of
  // localStorage, so without this the first surface measured carries a hint
  // bubble and no other one does. (Its rect is excluded from every sample too —
  // reset for determinism, excluded because it is not the design's hierarchy.)
  await pristineStorage(h.context);
  // The subject picker hit-tests candidates; that helper lives in the page.
  await audit.installPageHelpers(h.context);
  await requireBridge(h.page, 8000);

  const states = (() => {
    const f = readJSON(path.join(FIXTURE_DIR, `${FIXTURE}.json`));
    return Array.isArray(f) ? f : f.states;
  })();
  if (!states?.length) {
    r.fail(`fixture ${FIXTURE}.json missing; run npm run tool:record`);
    throw new Error('no fixture');
  }

  const load = async (theme, css) => {
    const u = new URL('/?harness=1', server.url);
    u.searchParams.set('seed', seed);
    await h.page.goto(u.href, { waitUntil: 'load', timeout: 20000 });
    await requireBridge(h.page, 8000);
    await applyTheme(h.page, theme);
    await h.page.evaluate((s) => {
      window.__CHUD.applyState(s);
      window.__CHUD.drainEvents?.();
    }, states[states.length - 1]);
    await h.page.waitForTimeout(200);
    return measure(h.page, css);
  };

  /* ── the gate itself: §10's surface, in every theme §2 ships ──────────── */
  for (const theme of THEMES) {
    const m = await load(theme);
    const label = `${FIXTURE}@desktop ${theme.key}`;
    if (m.missing.length) r.warn(`${label}: no element matched ${m.missing.join(', ')}`);
    if (!m.settled) r.warn(`${label}: the frame never stopped changing in ${m.settleMs}ms — numbers below are of a moving target`);

    if (m.bulk >= MIN_BULK) r.pass(`${label} tonal range: ${m.bulk.toFixed(1)} L* ≥ ${MIN_BULK}`);
    else {
      r.fail(`${label} tonal range: ${m.bulk.toFixed(1)} L* < ${MIN_BULK} `
        + `— 90% of the frame lives between L* ${m.p5.toFixed(1)} and ${m.p95.toFixed(1)}; `
        + 'in grayscale it is one tone (ART §3, §10)');
    }

    const bad = m.pairs.filter((p) => p.sep < SEP_MIN);
    if (m.pairs.length < MIN_PAIRS) {
      r.fail(`${label} resolved only ${m.pairs.length} adjacent pair(s) (< ${MIN_PAIRS}) `
        + '— nothing measurable was found, so the separation verdict below means nothing');
    }
    if (!bad.length) {
      r.pass(`${label} adjacent-pair separation: all ${m.pairs.length} pairs ≥ ${SEP_MIN} L*`);
    } else {
      r.fail(`${label} adjacent-pair separation: ${bad.length}/${m.pairs.length} pair(s) below ${SEP_MIN} L* `
        + '— with colour removed a player cannot tell these apart (ART §10)');
    }

    /* Every pair, every run. This is the block a human re-derives by hand:
     * two medians, their difference, and the boundary swing per side.        */
    for (const p of [...m.pairs].sort((a, b) => a.sep - b.sep)) {
      const flag = p.sep < SEP_MIN ? '✗' : (p.carrier === 'edge' ? '~' : '·');
      const sides = p.sides
        ? ` [T${fmt(p.sides.top)} R${fmt(p.sides.right)} B${fmt(p.sides.bottom)} L${fmt(p.sides.left)}]`
        : '';
      const body = `${flag} ${p.label.padEnd(38)} ${p.a.toFixed(1).padStart(5)} vs ${p.b.toFixed(1).padStart(5)} L*  `
        + `field ${p.field.toFixed(1).padStart(5)}  edge ${p.edge.toFixed(1).padStart(5)}${sides}  `
        + `→ ${p.sep.toFixed(1)} by ${p.carrier}   `
        + `${p.el} @${p.rect.map(Math.round).join(',')} (worst of ${p.of}/${p.seen})`;
      if (p.sep < SEP_MIN) console.log(`      ${yellow(body)}`);
      else r.info(body);
    }

    /* The number the designer aims at: the weakest FIELD step among the
     * structural pairs, i.e. how much tonal separation the palette itself is
     * providing before any stroke or shadow is counted.                      */
    const structural = m.pairs.filter((p) => p.kind === 'surface');
    const onEdge = structural.filter((p) => p.carrier === 'edge');
    const weakField = structural.reduce((w, p) => (!w || p.field < w.field ? p : w), null);
    if (weakField) {
      r.info(dim(`palette alone: weakest field step is ${weakField.field.toFixed(1)} L* `
        + `(${weakField.label}); ${onEdge.length}/${structural.length} structural pair(s) are `
        + `carried by edge treatment rather than by tone`));
    }
    r.info(dim(`bulk p5→p95 ${m.p5.toFixed(1)}→${m.p95.toFixed(1)}  deciles ${m.bins.map((b) => Math.round(b * 100)).join('/')}`));
  }

  /* ── proof the gate discriminates (§8) ────────────────────────────────── */
  if (args.prove) {
    console.log(dim('\n  ── --prove: the same assertion on six synthetic builds ──'));
    for (const [name, theme, css, want] of [
      ['mutation: one flat grey', THEMES[0], SIM_FLAT, 'fail'],
      ['mutation: light apron, no ink slab', THEMES[1], SIM_NO_SLAB, 'fail'],
      ['mutation: light, edge+shadow removed', THEMES[1], SIM_NO_EDGE, 'fail'],
      ['ART §2 light tokens, exactly as ratified', THEMES[1], SIM_ART2_LIGHT, 'fail'],
      ['light + a 12 L* furniture step', THEMES[1], SIM_STEPPED_LIGHT, 'pass'],
      ['dark + a 12 L* furniture step', THEMES[0], SIM_STEPPED_DARK, 'pass'],
    ]) {
      const m = await load(theme, css);
      const got = verdict(m);
      if (got === want) r.pass(`${name}: ${got} as expected  ${dim(line(m))}`);
      else {
        r.fail(`${name}: expected ${want}, measured ${got}  ${line(m)}`);
        for (const p of [...m.pairs].sort((a, b) => a.sep - b.sep).slice(0, 4)) {
          r.info(`${p.label} ${p.a.toFixed(1)} vs ${p.b.toFixed(1)} field ${p.field.toFixed(1)} edge ${p.edge.toFixed(1)} → ${p.sep.toFixed(1)}`);
        }
      }
    }
  } else {
    console.log(dim('  (run with --prove to re-measure the calibration rig: flat-grey, '
      + 'no-ink-slab and no-edge mutations must go red, the two simulated ART §2 themes green)'));
  }

  if (h.errors.length) r.warn(`${h.errors.length} console/page error(s) while measuring`);
  await h.close();
} catch (e) {
  if (!String(e.message).includes('no fixture')) {
    r.fail(`${e.message.split('\n')[0]}`);
  }
  code = EXIT_FAIL;
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.stop();
}

function fmt(v) { return v == null ? ' —' : v.toFixed(0).padStart(2); }

r.finish('grayscale');
process.exit(r.code === EXIT_PASS && code === EXIT_PASS ? EXIT_PASS : EXIT_FAIL);
