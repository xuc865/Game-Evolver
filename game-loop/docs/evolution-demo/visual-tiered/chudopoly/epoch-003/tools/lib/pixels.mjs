/**
 * tools/lib/pixels.mjs — the Node half of the colour measurements.
 * HARNESS-AGENT-OWNED (ARCHITECTURE.md §1, §8).
 *
 * Two gates read pixels off a captured frame:
 *   • grayscale.mjs   — ART-DIRECTION §10's "grayscale mid-game@desktop: is
 *                       hierarchy still readable?" ship gate,
 *   • checkContrast.mjs — the real painted background under a text run, for the
 *                       samples whose CSS background stack is a gradient/image
 *                       and therefore unmeasurable from getComputedStyle alone.
 *
 * Everything works in **CIE L\*** (0–100 perceptual lightness), not in linear
 * relative luminance, wherever a threshold is stated about what an eye can
 * separate. Linear luminance is savagely compressed at the dark end — the
 * current dark build's whole apron lives between Y 0.019 and Y 0.035, a span of
 * 1.6% that looks tiny and is a visible 7 L* — so a threshold expressed in Y
 * either passes everything dark or fails everything dark. Contrast RATIOS stay
 * in Y, because that is what WCAG 2.x defines.
 */

const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };

/** WCAG 2.x relative luminance of an [r,g,b] triple in 0..255. */
export function relLum(rgb) {
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** CIE L* from relative luminance. 0 = black, 100 = white. */
export function lstar(Y) {
  return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
}

export function contrastRatio(a, b) {
  const [hi, lo] = relLum(a) >= relLum(b) ? [relLum(a), relLum(b)] : [relLum(b), relLum(a)];
  return (hi + 0.05) / (lo + 0.05);
}

/** Per-pixel L* of a decoded PNG, as a Float32Array. Computed once per frame. */
export function lightnessField(png) {
  const out = new Float32Array(png.width * png.height);
  const d = png.data;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    out[p] = lstar(0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]));
  }
  return out;
}

/** Percentiles of an L* field, plus the decile occupancy used by the gate. */
export function lightnessStats(field) {
  const sorted = Float32Array.from(field).sort();
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  const bins = new Array(10).fill(0);
  for (let i = 0; i < field.length; i++) bins[Math.min(9, Math.floor(field[i] / 10))]++;
  return {
    n: field.length,
    p2: q(0.02), p5: q(0.05), p25: q(0.25), p50: q(0.5),
    p75: q(0.75), p95: q(0.95), p98: q(0.98),
    bulk: q(0.95) - q(0.05),          // p5–p95: the range the FRAME actually uses
    bins: bins.map((n) => n / field.length),
  };
}

/* ───────────────────── adjacent-pair separation (ART §10) ─────────────────
 *
 * grayscale.mjs asks one question per PAIR of things a player must tell apart:
 * "with colour removed, can I see where this object ends and the thing under it
 * begins?" That is a LOCAL question, so it needs local samplers:
 *
 *   sampleRect   — the robust tone of one surface's field, with the rects of
 *                  whatever is painted on top of it subtracted, because the mean
 *                  of a mat that has four cards lying on it is the mean of the
 *                  cards.
 *   edgeSwing    — the tonal excursion across a surface's boundary, per side.
 *                  ART §4 says light-theme paper is separated by "a soft shadow"
 *                  and a `--card-edge` stroke, not by bulk lightness; a metric
 *                  that only looks at field tone would call that design flat
 *                  when a human can plainly see the card. So the edge treatment
 *                  is MEASURED rather than assumed, and the pair's separation is
 *                  the better of the two channels.
 *
 * Percentiles, never means. A card face is ~15–25% ink and carries a solid §2
 * colour band; its mean is a number about nothing. The median is the tone of the
 * FIELD, which is what a player separates from the field beneath it.
 */

/** Rect helpers. Rects are CSS-px `[x, y, w, h]`; `scale` is the frame's DPR. */
const rectPx = (r, scale) => [r[0] * scale, r[1] * scale, (r[0] + r[2]) * scale, (r[1] + r[3]) * scale];

function percentiles(vals) {
  vals.sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor((vals.length - 1) * p))];
  return {
    n: vals.length,
    p05: q(0.05), p25: q(0.25), median: q(0.5), p75: q(0.75), p95: q(0.95),
    swing: q(0.95) - q(0.05),
  };
}

/**
 * Percentiles of L* inside `rect`, minus every rect in `excludes`, optionally
 * clipped to `clip` and inset from its own edge.
 *
 * `inset` keeps the sample off the element's own border/antialiasing — measuring
 * a card's field must not accidentally measure its 1px `--card-edge` stroke, or
 * the field and the edge channels stop being independent and the gate
 * double-counts. `bleed` grows the excluded rects for the same reason.
 *
 * Returns null when nothing survived (e.g. a full-bleed ancestor with no
 * uncovered pixels left) — callers must handle that rather than read a 0.
 */
export function sampleRect(field, png, rect, opts = {}) {
  const { scale = 1, inset = 0, excludes = [], clip = null, bleed = 1, maxSamples = 60000 } = opts;
  let [x0, y0, x1, y1] = rectPx([rect[0] + inset, rect[1] + inset, rect[2] - 2 * inset, rect[3] - 2 * inset], scale);
  if (clip) {
    const c = rectPx(clip, scale);
    x0 = Math.max(x0, c[0]); y0 = Math.max(y0, c[1]);
    x1 = Math.min(x1, c[2]); y1 = Math.min(y1, c[3]);
  }
  x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
  x1 = Math.min(png.width, Math.round(x1)); y1 = Math.min(png.height, Math.round(y1));
  if (x1 <= x0 || y1 <= y0) return null;
  const ex = excludes.map((r) => rectPx([r[0] - bleed, r[1] - bleed, r[2] + 2 * bleed, r[3] + 2 * bleed], scale));
  // Stride so a full-viewport surface costs the same as a card. Sampling every
  // Nth pixel changes a percentile by <0.1 L* on any region this gate looks at.
  const stride = Math.max(1, Math.ceil(Math.sqrt(((x1 - x0) * (y1 - y0)) / maxSamples)));
  const vals = [];
  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      let hidden = false;
      for (let k = 0; k < ex.length; k++) {
        const e = ex[k];
        if (x >= e[0] && x < e[2] && y >= e[1] && y < e[3]) { hidden = true; break; }
      }
      if (hidden) continue;
      vals.push(field[y * png.width + x]);
    }
  }
  return vals.length ? percentiles(vals) : null;
}

/**
 * The tonal excursion across a surface's boundary, measured PER SIDE.
 *
 * For each of the four sides a band is taken running from `out` px outside the
 * rect to `inn` px inside it, and the band's p5→p95 swing is the readable step
 * at that side: a plain tone change gives back the tone change; a `--card-edge`
 * stroke or a drop shadow between two near-identical fields gives back the
 * stroke. p5→p95 rather than min→max so one antialiased pixel or one glyph
 * clipping the band cannot supply the answer.
 *
 * Reported as all four sides plus a LOWER MEDIAN: with four sides that is the
 * second-smallest, i.e. "three of the four sides show at least this much". An
 * offset drop shadow is real separation on two sides and nothing on the other
 * two; a §2 colour band sits inside exactly one side; a mat's 3px rail is one
 * edge of four. Any of those buying a pass on its own would re-import the "one
 * element supplies the tier" defect this gate was rewritten to remove — you see
 * a figure by its outline, not by one of its edges.
 *
 * A side whose OUTER half is off-frame is not a boundary and returns null (the
 * full-bleed `#hud` has three of those). Without that check its clipped top band
 * reports the swing of its own interior and calls it an edge.
 */
export function edgeSwing(field, png, rect, opts = {}) {
  const { scale = 1, out = 6, inn = 6, excludes = [], maxSamples = 20000 } = opts;
  const [x, y, w, h] = rect;
  const bands = {
    top: { full: [x, y - out, w, out + inn], outer: [x, y - out, w, out] },
    bottom: { full: [x, y + h - inn, w, out + inn], outer: [x, y + h, w, out] },
    left: { full: [x - out, y, out + inn, h], outer: [x - out, y, out, h] },
    right: { full: [x + w - inn, y, out + inn, h], outer: [x + w, y, out, h] },
  };
  const sides = {};
  for (const [side, b] of Object.entries(bands)) {
    const o = sampleRect(field, png, b.outer, { scale, excludes, maxSamples, bleed: 0 });
    if (!o || o.n < 12) { sides[side] = null; continue; }
    const s = sampleRect(field, png, b.full, { scale, excludes, maxSamples, bleed: 0 });
    sides[side] = s && s.n >= 24 ? s.swing : null;
  }
  const got = Object.values(sides).filter((v) => v != null).sort((a, b) => a - b);
  return {
    sides,
    median: got.length ? got[Math.floor((got.length - 1) / 2)] : null,
    weakest: got.length ? got[0] : null,
    measured: got.length,
  };
}

/**
 * The tone of the GLYPHS inside a text run's box, and the tone of the plate they
 * sit on, read out of the same rect.
 *
 * Percentiles were tried first and are WRONG here: glyph coverage in a real
 * label box runs 3–25%, and `span.board-name` in this client came in under 5%,
 * so p95 landed on antialiased fringe and the function reported ink L\* 18.0 on
 * a plate of 14.2 — a 3.8 L\* "violation" of white-on-charcoal text measuring
 * 79 L\* by hand. A percentile cannot find a minority population whose size it
 * does not know.
 *
 * So it is a histogram, the same technique `sampledBackground` uses: the modal
 * bin is the plate, and the ink is the bin FURTHEST from it that still holds a
 * real population (≥1.5% of the box, ≥8 pixels). "At least 1.5% of this box is
 * this tone" is a claim a human can check; "the 95th percentile" is not.
 */
export function inkOnPlate(field, png, rect, opts = {}) {
  const { scale = 1, excludes = [] } = opts;
  const [x0, y0, x1, y1] = rectPx(rect, scale).map((v, i) => (i < 2
    ? Math.max(0, Math.round(v))
    : Math.min(i === 2 ? png.width : png.height, Math.round(v))));
  if (x1 <= x0 || y1 <= y0) return null;
  const ex = excludes.map((r) => rectPx(r, scale));
  const BINS = 40;
  const count = new Array(BINS).fill(0);
  const acc = new Array(BINS).fill(0);
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let hidden = false;
      for (let k = 0; k < ex.length; k++) {
        const e = ex[k];
        if (x >= e[0] && x < e[2] && y >= e[1] && y < e[3]) { hidden = true; break; }
      }
      if (hidden) continue;
      const v = field[y * png.width + x];
      const b = Math.min(BINS - 1, Math.max(0, Math.floor((v / 100) * BINS)));
      count[b]++; acc[b] += v; n++;
    }
  }
  if (n < 60) return null;
  let mode = 0;
  for (let i = 1; i < BINS; i++) if (count[i] > count[mode]) mode = i;
  const plate = acc[mode] / count[mode];
  const floor = Math.max(8, n * 0.015);
  let ink = null;
  let best = -1;
  for (let i = 0; i < BINS; i++) {
    if (!count[i] || count[i] < floor) continue;
    const v = acc[i] / count[i];
    const d = Math.abs(v - plate);
    if (d > best) { best = d; ink = v; }
  }
  if (ink == null || best < 0) return null;
  return { ink, plate, delta: best, n };
}

/** Mean L* inside a CSS-pixel rect [x,y,w,h], scaled by the frame's DPR. */
export function regionLightness(field, png, rect, scale = 1) {
  const x0 = Math.max(0, Math.round(rect[0] * scale));
  const y0 = Math.max(0, Math.round(rect[1] * scale));
  const x1 = Math.min(png.width, Math.round((rect[0] + rect[2]) * scale));
  const y1 = Math.min(png.height, Math.round((rect[1] + rect[3]) * scale));
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) { sum += field[y * png.width + x]; n++; }
  }
  return n ? sum / n : null;
}

/**
 * The painted background colour inside a text element's rect.
 *
 * Glyph pixels are a MINORITY of a text box (typical coverage 10–25%), so the
 * modal colour of the box is its background. Pixels close to the known ink are
 * dropped first so that a tight, heavy label cannot vote for its own ink, and
 * the winning 24-bin luminance bucket is averaged rather than picking a single
 * pixel — antialiasing makes any single pixel a coin flip.
 *
 * Returns `{ rgb, share, n }` — `share` is the winning bucket's fraction of the
 * non-ink pixels, i.e. how much of a background there was to find. Callers
 * should ignore a low-share answer and keep the CSS reading: an 8px label whose
 * glyphs are mostly antialiased fringe has no modal background worth trusting.
 * Returns null when the rect is empty or every pixel looked like ink.
 */
export function sampledBackground(png, rect, fg, scale = 1) {
  const x0 = Math.max(0, Math.round(rect[0] * scale));
  const y0 = Math.max(0, Math.round(rect[1] * scale));
  const x1 = Math.min(png.width, Math.round((rect[0] + rect[2]) * scale));
  const y1 = Math.min(png.height, Math.round((rect[1] + rect[3]) * scale));
  if (x1 <= x0 || y1 <= y0) return null;
  const BINS = 24;
  const count = new Array(BINS).fill(0);
  const acc = Array.from({ length: BINS }, () => [0, 0, 0]);
  const d = png.data;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      const r = d[i]; const g = d[i + 1]; const b = d[i + 2];
      // 70 in RGB euclidean space: wide enough to swallow antialiased fringes,
      // narrow enough that a background one tone off the ink still counts (a
      // 1.5:1 pair is a violation we must be able to SEE, not discard).
      const dr = r - fg[0]; const dg = g - fg[1]; const db = b - fg[2];
      if (dr * dr + dg * dg + db * db < 70 * 70) continue;
      const bin = Math.min(BINS - 1, Math.floor(lstar(relLum([r, g, b])) / (100 / BINS)));
      count[bin]++;
      acc[bin][0] += r; acc[bin][1] += g; acc[bin][2] += b;
    }
  }
  let best = -1;
  let total = 0;
  for (let i = 0; i < BINS; i++) {
    total += count[i];
    if (count[i] > (best < 0 ? 0 : count[best])) best = i;
  }
  if (best < 0 || !count[best]) return null;
  return {
    rgb: [
      Math.round(acc[best][0] / count[best]),
      Math.round(acc[best][1] / count[best]),
      Math.round(acc[best][2] / count[best]),
    ],
    share: count[best] / total,
    n: total,
  };
}
