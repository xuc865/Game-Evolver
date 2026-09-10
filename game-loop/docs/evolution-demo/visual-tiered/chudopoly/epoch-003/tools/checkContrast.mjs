#!/usr/bin/env node
/**
 * tools/checkContrast.mjs — ARCHITECTURE §0.9 / ART-DIRECTION §10:
 * "text contrast ≥ 4.5:1 except decorative", "both themes ≥4.5:1 on every text
 * token".
 *
 * WHY A GATE AND NOT A REVIEW: a screenshot review cannot read a ratio off a
 * picture. ART §2 publishes pre-verified numbers, but a published number is a
 * claim about a PAIR (`--fg` on `--ground`) — it says nothing about the pair a
 * given string is actually painted in, and a two-theme system doubles the pairs
 * while halving the chance anyone looks at the second one. The failure this
 * catches is `--fg-mute` landing on `--ground-deep` in exactly one theme: fine
 * in the dark shot, 3:1 in the light one, invisible to every other gate.
 *
 * ─── how a sample is measured ────────────────────────────────────────────
 *   INK    `getComputedStyle(el).color`, composited over its backdrop if it is
 *          translucent. lib/audit.mjs `auditTextContrast` — in the page, using
 *          the same WCAG relative-luminance formula ART §2 quotes.
 *   PAPER  the CSS `background-color` stack, composited down to the first
 *          opaque layer — EXCEPT where that stack passes through a
 *          `background-image`, in which case the CSS answer is a fiction and
 *          the real painted background is sampled from the rendered frame
 *          (lib/pixels.mjs `sampledBackground`: modal colour of the text box,
 *          with ink-coloured pixels excluded).
 *
 *          That refinement is not optional. Measured on `home@desktop`, the
 *          pure-CSS reading of `#btn-quick-play` was **1.22:1** — dark ink on
 *          the page background — because the button's fill is a gradient with
 *          no `background-color` under it, so the stack fell through to `body`.
 *          The painted answer is 8.4:1. A gate that reports 1.22:1 there gets
 *          switched off within a week, and rightly.
 *
 *   NEED   WCAG 1.4.3 as §0.9 cites it: 3:1 for large text (≥24px, or ≥18.66px
 *          at weight ≥700), 4.5:1 otherwise.
 *
 * Fully transparent text is skipped, not failed — `color: transparent` on a
 * buried card's band (table.css:654) is a deliberate hiding, and 39 of them
 * would drown every real violation at a nominal 0:1.
 *
 * COVERED text is skipped for the same reason, and it is most of the DOM's text
 * on this table: cards are stacked by design (hand fan, bank stacks, property
 * columns, upgrade badges), so a buried card's name and value band are still in
 * the tree with their computed colours while nothing of them is visible. The
 * card-art agent hit-tested the 24 card-side violations that survived its own
 * fix and every one was covered — the entire card-side signal was noise.
 * lib/audit.mjs hit-tests each run's centre and edges; 417 of 2163 runs across
 * the eight surfaces are dropped this way. The count is printed every run, so
 * "the gate went quiet" and "the gate went blind" stay distinguishable.
 *
 * ─── surfaces × themes ───────────────────────────────────────────────────
 * The six surfaces the review set covers in both themes, plus the two moments
 * that carry the most rules text (payment, discard browser), each measured in
 * dark, light, and `[data-theme=light]`-over-media-dark. That third mode is
 * how ART §2 says the attribute must beat the media query; if the override is
 * not wired, its violations differ from plain light and the tool says so.
 *
 * ─── proven to fail (§8) ─────────────────────────────────────────────────
 * `--prove` injects a plausible "slightly muted secondary text" mistake into
 * the help sheet, which is clean in all three theme modes on arrival, and
 * requires the tool to catch it. Measured 2026-08-06: **0 → 31 violations**.
 * It then re-runs every surface with the CSS-only reading and reports how many
 * runs that reading would have false-flagged, so the painted-background
 * refinement is demonstrated rather than asserted. An assertion nobody has
 * watched go red is a decoration.
 *
 * ─── status: RED, and down to one class ──────────────────────────────────
 * `public/style/` moved three times while this was being written — 48
 * violations at 21:50, 26 at 22:10, 3 now — so the CLASSES matter and the count
 * does not. Numbers are 2026-08-06, seed 1337, and reproduce exactly run to run.
 *
 *   3 violations / 1746 measured runs — dark 1, light 1, override 1.
 *   (+21 sub-8px decorative, +417 occluded, neither gated.)
 *
 * The override column matching light EXACTLY is the good news, and it is the
 * thing only this gate can see: ART §2's three-way selection is correctly wired,
 * so `[data-theme=light]` really does beat `prefers-color-scheme: dark`.
 *
 * OPEN — ink on the set colour inside the card art. Theme-independent, so it
 * reads identically in all three modes:
 *   2.64:1  .ca-val "3M" on Drone Ops #8A4B1E, 9px.
 * ART §6 asks for "a filled ink disc with bone numerals". §2's table
 * pre-verified ink-on-set at 4.78–10.41, but that column is measured against
 * CARD STOCK, not against the colour itself; the same ink directly on Drone Ops
 * is 2.64:1.
 *
 * CLOSED under this gate while it was landing, listed so a regression is
 * recognisable rather than rediscovered:
 *   1.55:1  #btn-rematch "Rematch"    paper ink on a paper button, light only —
 *           the §1 achromatic slab reached `#btn-end-turn` before the win modal.
 *   2.06:1  #deck-count "14"          near-black `--fg` on the near-black card
 *           back, light only.
 *   2.65:1  .ca-title "INSPECTOR GEN" / "TDY ORDERS", and b "1" at 2.73:1.
 *   4.18:1  .pile-label "DECK", .win-tag "FINAL APPROACH HELD" (foil #8A6320 on
 *           the win modal's light paper, 0.3 short in light only).
 *
 * Exits 2 (PENDING CLIENT) until window.__CHUD exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  DESKTOP, SEED, SHOT_DIR, ensureDir,
  parseArgs, launchBrowser, openPage, requireBridge, reporter,
  stableScreenshot, pristineStorage, dim, red, yellow, EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';
import * as audit from './lib/audit.mjs';
import { contrastRatio, sampledBackground } from './lib/pixels.mjs';
import { drive } from './lib/drivers.mjs';
import { loadFixture, stageFixture, quietTransients } from './lib/stage.mjs';
import { installLogbooks } from './lib/logbook.mjs';
import { census, observeMarkers } from './lib/census.mjs';
import { applyTheme, THEME_MODES } from './lib/theme.mjs';
import { startServer } from './serve.mjs';

const args = parseArgs();
const seed = args.seed ? Number(args.seed) : SEED;

/** Mirrors the review set's theme subset, plus the two rules-text-heavy modes. */
const SURFACES = [
  { name: 'home', fixture: null },
  { name: 'help', fixture: null, drive: 'help', expect: 'sheet:open' },
  { name: 'mid-game', fixture: 'mid-game' },
  { name: 'final-approach', fixture: 'final-approach' },
  { name: 'win', fixture: 'finished' },
  { name: 'discard-browser', fixture: 'mid-game', drive: 'discard', expect: 'sheet:open' },
  { name: 'payment', fixture: 'payment-pending', drive: 'payment', expect: 'mode:payment' },
  /* ── P9: five surfaces this gate had never had an entry for ─────────────
   * Each one carries text, each one is reachable in ordinary play, and each
   * had to be hand-checked by the agent that built it because there was
   * nowhere in this list to put it (see tools/coverage.mjs).
   *   lobby-host   the busiest PRE-GAME screen. It had never been measured at
   *                all, in any gate: `store.self.id` was never set from a lobby
   *                broadcast, so every capture was the guest view.
   *   wild-place   §3.8/§3.9's placement advice — rent ladders and a BEST mark
   *                printed straight onto the mats, over ten saturated set
   *                colours. It is the one piece of rules text painted ON the
   *                table and it shipped verified only by its author.
   *   opponent-*   the upgrade lane and the ARMED treatment, which only ever
   *                render on a seat that is not yours.
   *   announce     a full-width banner over the table, ~2600ms, two colourways.
   *   toast        the client's only other transient message surface.          */
  { name: 'lobby-host', fixture: 'lobby', drive: 'lobby-host', expect: 'lobby:host' },
  { name: 'wild-place', fixture: 'mid-game', drive: 'wild-place', expect: 'myColor:' },
  { name: 'opponent-upgrade', fixture: 'opponent-upgrade' },
  { name: 'opponent-armed', fixture: 'opponent-armed' },
  { name: 'announce', fixture: 'approach-called', from: 0, at: 1, transient: true, drive: 'announce', expect: 'announce:' },
  { name: 'toast', fixture: null, drive: 'toast', expect: 'toast:"' },
  /* ── the flight log (ui/stats.js) ───────────────────────────────────────
   * A whole panel of --fg-mute labels against --fg figures on --surface, plus
   * one set-colour swatch, and none of it is reachable from a fixture: it
   * renders `chud.stats.v1`, which lib/logbook.mjs seeds off `?logbook=`.
   * Two populations, because they are two different sets of text — the young
   * one is the threshold sentence and no band 3 at all, and `-gone` is the
   * `stats.status` note, which is the longest run of small muted type this
   * client prints anywhere. */
  {
    name: 'flightlog', route: '/?harness=1&logbook=300', fixture: null,
    drive: 'flight-log', expect: 'flightlog:open',
  },
  {
    name: 'flightlog-young', route: '/?harness=1&logbook=3', fixture: null,
    drive: 'flight-log', expect: 'flightlog:open',
  },
  {
    name: 'flightlog-gone', route: '/?harness=1&logbook=future', fixture: null,
    drive: 'flight-log', expect: 'flightlog:open',
  },
];

/**
 * A violation must be worth acting on. 0.2 of a ratio point is inside the
 * measurement's own error bar (antialiased ink over a sampled modal background),
 * so 4.31:1 is not reported as a failure of a 4.5:1 rule.
 */
const SLACK = 0.2;

/**
 * How much of a text box must agree on one background before the frame is
 * believed over the stylesheet. Below this the box is mostly glyph and fringe
 * and the sampled "background" is really the antialiasing.
 */
const MIN_BG_SHARE = 0.25;

/**
 * §0.9 says "≥4.5:1 **except decorative**". This is where that line is drawn,
 * and it is drawn by measurement rather than by taste: below 8px nothing in
 * this client is a reading surface. ART §6's own tier degradation says the same
 * thing from the other side — at ≤28px a card is "band + glyph at 70% only,
 * nothing that can truncate" — so a 5px string on a mini card is texture.
 *
 * Measured: the sub-8px population is 100% card-art micro-typography — the
 * `CHUDOPOLY` wordmark stamped on the card back at 5px and the `WILD` band name
 * on a mini wild. Both are duplicated in the card's accessible name. They are
 * COUNTED and PRINTED, never silently dropped, because "there are 9 illegible
 * strings on this table" is itself worth knowing.
 */
const MIN_TEXT_PX = 8;

/**
 * The mutation `--prove` injects, and the surface it injects into.
 *
 * #6a6f78 is not a silly colour — it is the sort of "slightly muted secondary
 * text" that gets committed without measurement, and on the dark sheet
 * (`--surface: #20242B`) it lands at about 3:1. The help sheet is the target
 * because it is CLEAN in all three theme modes on arrival, so any violation the
 * mutated run reports is the mutation's.
 */
const MUTATION = '#sheet, #sheet * { color: #6a6f78 !important; }';
const MUTATION_SURFACE = 'help';

const CENSUS = census().markers;
const markerSeen = new Map();
let captures = 0;

const r = reporter('checkContrast');
const server = await startServer({ seed });
let browser = null;
let hardError = null;

/** Measure one (surface, theme). Returns {violations, samples, sheet} or null. */
async function measureSurface(h, surface, theme, extraCss) {
  // `route` exists for surfaces with NO server state — the flight log renders
  // out of localStorage, and lib/logbook.mjs seeds it from a query parameter
  // before the document runs. Everything else navigates to the same URL it
  // always did.
  const u = new URL(surface.route || '/?harness=1', server.url);
  u.searchParams.set('seed', seed);
  u.searchParams.set('surface', surface.name);
  await h.page.goto(u.href, { waitUntil: 'load', timeout: 20000 });
  await requireBridge(h.page, 8000);
  await applyTheme(h.page, theme);
  if (extraCss) await h.page.addStyleTag({ content: extraCss });

  if (surface.fixture) {
    const fx = loadFixture(surface.fixture);
    if (!fx) return { error: `fixture ${surface.fixture}.json missing` };
    // Seat first (lib/stage.mjs): without it a lobby fixture measures the
    // guest's screen and reports it under the host's name.
    await stageFixture(h.page, fx, { at: surface.at, from: surface.from, drain: !surface.transient });
    await h.page.waitForTimeout(150);
    // Same reason as screenshot.mjs: a state application can raise a 2600ms
    // `.announce` over the table, and a surface that is not about it must not
    // have its numbers depend on whether the banner was still up.
    if (!surface.transient) await quietTransients(h.page);
  }
  if (surface.drive) {
    const reached = await drive(h.page, surface.drive);
    if (surface.expect && !String(reached).startsWith(surface.expect)) {
      return { error: `driver '${surface.drive}' reached '${reached}', expected '${surface.expect}*'` };
    }
  }

  // Settled frame first: the sampled background is read off THIS buffer, so it
  // must be the same frame the DOM rects describe.
  const frame = await stableScreenshot(h.page);
  const png = PNG.sync.read(frame.buffer);
  const scale = png.width / (await h.page.evaluate(() => innerWidth));
  const { samples, hidden } = await h.page.evaluate(audit.auditTextContrast);
  /* tools/coverage.mjs. This gate is the ONLY one that drives ART §2's third
   * selection path (`[data-theme]` over a media query), so without its sidecar
   * the census correctly reported `data-theme=light` and `=dark` as states no
   * gate had ever rendered — while this file was rendering both, every run. */
  for (const key of await h.page.evaluate(observeMarkers, CENSUS)) {
    if (!markerSeen.has(key)) markerSeen.set(key, []);
    const at = markerSeen.get(key);
    if (at.length < 4) at.push(`${surface.name}@${theme.key}`);
  }
  captures++;

  const violations = [];
  const decorative = [];
  let refined = 0;
  for (const s of samples) {
    let bg = s.bgCss;
    let from = 'css';
    // The painted answer wins wherever there IS one. `approx` (a
    // background-image somewhere in the stack) is a hint that the CSS reading
    // is fiction, not the only case where it is: measured on
    // `final-approach@light`, `.ca-band-name` read as white-on-cream 1.06:1
    // with `approx` false, because the coloured band it sits on is painted by a
    // child rather than by a background-color of its own.
    const painted = sampledBackground(png, s.rect, s.fg, scale);
    // A low share means there was no background to find — an 8px label whose
    // box is mostly antialiased fringe. Keep the CSS reading there.
    if (painted && painted.share >= MIN_BG_SHARE) { bg = painted.rgb; from = 'painted'; refined++; }
    const got = contrastRatio(s.fg, bg);
    if (got + SLACK >= s.need) continue;
    const hit = { ...s, bg, from, ratio: Math.round(got * 100) / 100 };
    (s.px < MIN_TEXT_PX ? decorative : violations).push(hit);
  }
  violations.sort((a, b) => a.ratio - b.ratio);
  decorative.sort((a, b) => a.ratio - b.ratio);
  return { violations, decorative, samples, hidden, refined, settled: frame.settled };
}

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

try {
  browser = await launchBrowser();
  const h = await openPage(browser, `${server.url}/?harness=1&seed=${seed}`, { viewport: DESKTOP, dpr: 1 });
  // Same reason as screenshot.mjs: the coach layer is shown "once ever" out of
  // localStorage, so without this the first surface measured carries a hint
  // bubble and no other one does.
  await pristineStorage(h.context);
  // AFTER pristineStorage — init scripts run in the order added and that one
  // clears storage at document start, so a logbook seeded any earlier would be
  // wiped before the client ever read it.
  await installLogbooks(h.context);
  // `auditTextContrast`'s buried-run filter runs on audit.openHitTesting, which
  // lives in the page, not in this module — install it for every document.
  await audit.installPageHelpers(h.context);
  await requireBridge(h.page, 8000);

  let totalSamples = 0;
  let totalViolations = 0;
  let totalDecorative = 0;
  let totalHidden = 0;
  const perTheme = new Map(THEME_MODES.map((t) => [t.key, 0]));

  for (const surface of SURFACES) {
    for (const theme of THEME_MODES) {
      const label = `${surface.name} · ${theme.key}`;
      const m = await measureSurface(h, surface, theme);
      if (!m || m.error) { r.fail(`${label}: ${m?.error || 'no measurement'}`); continue; }
      if (!m.settled) r.warn(`${label}: frame never settled; the sampled backgrounds may be of a moving target`);
      totalSamples += m.samples.length;
      totalHidden += m.hidden;
      totalViolations += m.violations.length;
      perTheme.set(theme.key, perTheme.get(theme.key) + m.violations.length);

      totalDecorative += m.decorative.length;
      const deco = m.decorative.length
        ? dim(`  (+${m.decorative.length} sub-${MIN_TEXT_PX}px decorative, worst `
          + `${m.decorative[0].ratio.toFixed(2)}:1 ${m.decorative[0].el})`)
        : '';

      if (!m.violations.length) {
        r.pass(`${label}: ${m.samples.length} text run(s), all ≥ threshold `
          + dim(`(${m.refined} background(s) read off the frame)`) + deco);
        continue;
      }
      r.fail(`${label}: ${m.violations.length}/${m.samples.length} text run(s) below §0.9` + deco);
      for (const v of m.violations.slice(0, 6)) {
        const paint = v.ratio < 3 ? red : yellow;
        r.info(`${paint(`${v.ratio.toFixed(2)}:1`)} (needs ${v.need}) ${v.el} "${v.text}" `
          + `— ${rgb(v.fg)} on ${rgb(v.bg)} ${dim(`[${v.from}, ${v.px}px]`)}`);
      }
      if (m.violations.length > 6) r.info(dim(`… and ${m.violations.length - 6} more`));
    }
  }

  console.log(dim(`  ── ${totalViolations} violation(s) across ${totalSamples} text run(s); `
    + `by theme: ${[...perTheme].map(([k, n]) => `${k} ${n}`).join(', ')}; `
    + `plus ${totalDecorative} sub-${MIN_TEXT_PX}px decorative and ${totalHidden} `
    + `occluded run(s), neither gated`));

  /* ── §8: watch it go red ─────────────────────────────────────────────── */
  if (args.prove) {
    console.log(dim('\n  ── --prove: mutation must be caught, gradients must not be false-flagged ──'));
    const target = SURFACES.find((s) => s.name === MUTATION_SURFACE) || SURFACES[0];
    const clean = await measureSurface(h, target, THEME_MODES[0]);
    const dirty = await measureSurface(h, target, THEME_MODES[0], MUTATION);
    if (dirty.violations.length > clean.violations.length) {
      r.pass(`mutation (#6a6f78 secondary text) caught: ${clean.violations.length} → `
        + `${dirty.violations.length} violation(s) on ${target.name}@dark`);
      for (const v of dirty.violations.slice(0, 3)) {
        r.info(dim(`${v.ratio.toFixed(2)}:1 ${v.el} "${v.text}"`));
      }
    } else {
      r.fail(`mutation NOT caught on ${target.name}@dark — injected #6a6f78 text and the count `
        + `stayed at ${clean.violations.length}. This gate asserts nothing.`);
    }
    /* The false positive the painted-background refinement exists to kill. Run
     * across every surface: a CSS-only reading of this client says the home
     * screen's primary CTA is 1.22:1, because its fill is a gradient with no
     * background-color under it. */
    let avoided = 0;
    const examples = [];
    for (const surface of SURFACES) {
      const m = await measureSurface(h, surface, THEME_MODES[0]);
      if (!m || m.error) continue;
      const kept = new Set(m.violations.concat(m.decorative).map((v) => `${v.el}|${v.text}`));
      for (const s of m.samples) {
        if (s.ratioCss + SLACK >= s.need || kept.has(`${s.el}|${s.text}`)) continue;
        avoided++;
        if (examples.length < 4) examples.push(`${surface.name} ${s.el} ${s.ratioCss}:1`);
      }
    }
    if (avoided) {
      r.pass(`${avoided} run(s) that a CSS-only reading would false-flag are correctly cleared `
        + `by the painted background: ${examples.join(', ')}`);
    } else {
      r.warn('no CSS-only false positives found in this run — the painted-background '
        + 'refinement went untested');
    }
  } else {
    console.log(dim('  (run with --prove to watch the gate catch an injected low-contrast '
      + 'mutation, and to see the CSS-only false positives it avoids)'));
  }

  ensureDir(SHOT_DIR);
  fs.writeFileSync(path.join(SHOT_DIR, 'coverage-checkContrast.json'), JSON.stringify({
    tool: 'checkContrast',
    generatedAt: new Date().toISOString(),
    captures,
    seen: Object.fromEntries(markerSeen),
  }, null, 1) + '\n');
  console.log(dim(`  ${markerSeen.size}/${CENSUS.length} surface marker(s) seen → coverage-checkContrast.json`));

  if (h.errors.length) r.warn(`${h.errors.length} console/page error(s) while measuring`);
  await h.close();
} catch (e) {
  hardError = e;
  r.fail(e.message.split('\n')[0]);
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.stop();
}

r.finish('checkContrast');
process.exit(r.code === EXIT_PASS && !hardError ? EXIT_PASS : EXIT_FAIL);
