// server/icon.js — the app icon, drawn in code and rasterised in code.
//
// WHY THIS FILE IS ON THE SERVER AND NOT IN public/src/
// The client never renders the app icon; the browser fetches it as a document
// subresource. But §0.3 bans .svg and .png FILES in the repo (checkAssets fails
// on the extension AND on the magic bytes), and ui-contract.test.js requires
// every <link href> in index.html to be cache-busted, which rules out a
// data: URI href. So the icon has to be a route, the route needs the geometry,
// and one copy of the geometry beats two. Everything below is text and integer
// arithmetic: `npm start` is still the whole deploy (§0.2) and nothing binary
// ever lands in the tree.
//
// WHAT IS DRAWN
// Not a new mark. Commit 844f99e replaced the card back's star-and-bar (a
// colorable imitation of the US national aircraft insignia, prohibited by
// 32 C.F.R. §507.9 to author by hand) with a pre-press ALIGNMENT TARGET, and
// that is now the deck mark. This is the same mark at two tiers.
//
//   FULL   (>=64px)  the deck mark exactly as BACK_MARK draws it — corner
//                    brackets, thin frame, four heavy bars with stencil
//                    bridges knocked out, diamond datum — over the 45°
//                    halftone screen clipped to a diamond, as on the back.
//   MICRO  (<=32px)  a redraw, NOT a scale. Measured: at 16px one unit of the
//                    100-unit mark box is 0.16px, so BACK_MARK's thin frame
//                    (3 units) lands at 0.48px and its bars at 0.96px — every
//                    layer falls under one pixel and greys into mush. The
//                    micro tier is authored natively on a 16×16 grid so every
//                    edge is integral at 16px and at 32px, and it keeps only
//                    what still has a silhouette there: the corner brackets
//                    and the diamond datum.
//
// WHAT THE MICRO TIER CUTS, AND WHY
//   halftone screen  6px pitch at 16px total = two dots. Reads as dirt.
//   thin frame       0.48px. Reads as a grey wash over the ground.
//   the four bars    0.96px, and they run INTO the brackets at this size:
//                    bar (12..37 units) ends 4.4px from a bracket that is
//                    2px thick, so the negative space that makes a target
//                    look like a target closes up.
//   stencil bridges  3 units = 0.48px knocked out of a bar that is itself
//                    under a pixel. Invisible by construction.
// Left: four 2px brackets and a 6px diamond on a 16px near-black tile — four
// marks, all >=2px, all pixel-aligned.
//
// WHY THE TILE IS SOLID AND DARK
// A favicon sits in browser chrome we do not control, light or dark, and the
// owner's complaint was that the tab reads "too plain". An outline mark at
// 16px is scratches; the same mark reversed out of the deck's near-black is an
// OBJECT with a silhouette, and it is literally the back of a card — the one
// dark object the identity allows (ART §6). Cream on #14161A is 15.5:1, so the
// mark holds against a white tab strip and against a #202124 one alike.
//
// Drawing law (ART §6, MIL-STD-38784B): two line widths at 2:1, square corners
// only, no gradient/blur/shadow, solid fills, a pattern rather than opacity for
// the tint. No insignia, no seal, no roundel.

'use strict';

// The rasteriser and PNG encoder lived here until server/og.js became their
// second consumer; they are server/raster.js now, unchanged in behaviour. The
// geometry, the tiers and the route allowlist stay here — one mark, one owner.
const raster = require('./raster');

/* ── Palette (ART §2, shared card tokens — identical in both themes) ─────── */

const DARK = [0x14, 0x16, 0x1a];   // --card-back
const CREAM = [0xfb, 0xf8, 0xf1];  // --card-stock

/* ── Shape primitives ────────────────────────────────────────────────────
   Everything is a rect, a convex polygon or a circle, in a square authoring
   grid whose size is declared per tier. Rects get ANALYTIC coverage (exact
   pixel-square overlap), which is what keeps the micro tier crisp; polygons
   and the halftone dots get 4×4 supersampling. */

const { rect, poly, circle } = raster;

/** An L-shaped corner bracket: arm `len`, stroke `w`, at (x,y), pointing
 *  `sx`/`sy` (+1 right/down, -1 left/up). Two rects, square corners. */
function bracket(x, y, len, w, sx, sy) {
  const hx = sx > 0 ? x : x - len;
  const vy = sy > 0 ? y : y - len;
  return [rect(hx, sy > 0 ? y : y - w, len, w), rect(sx > 0 ? x : x - w, vy, w, len)];
}

/* ── MICRO — authored on a 16×16 grid so 16px and 32px are both integral ── */

const MICRO_GRID = 16;

/** The datum, built from stacked rects rather than as a rotated square.
 *  Measured, first pass: a true polygon diamond 6px across at 16px is 45° on a
 *  pixel grid, so every edge pixel lands on partial coverage — rendered, it was
 *  a grey circular blob, the same mush the tier exists to avoid. Three rects
 *  give the identical silhouette with every edge on a pixel boundary, and they
 *  render the same in the SVG (`shape-rendering="crispEdges"`) and in the
 *  rasteriser instead of depending on each renderer's AA.
 *  @param {number} h  half-height in grid units (3 → 6px at 16px). */
function datum(h) {
  const out = [];
  for (let i = 0; i < h; i++) {
    const w = 2 * (i + 1);
    out.push(rect(8 - w / 2, 8 - h + i, w, 2 * (h - i)));
  }
  return out;
}

/** @param {number} d  datum half-height, grid units. */
function microShapes(d = 3) {
  const B = 5, W = 2, I = 1;         // arm 5px, stroke 2px, inset 1px at 16px
  const F = MICRO_GRID - I;          // far edge
  return {
    ink: [
      ...bracket(I, I, B, W, +1, +1),
      ...bracket(F, I, B, W, -1, +1),
      ...bracket(I, F, B, W, +1, -1),
      ...bracket(F, F, B, W, -1, -1),
      ...datum(d),
    ],
    knock: [],
    dots: null,
  };
}

/* Two alternates were drawn and rendered at 16px before this one shipped, and
   both were rejected on the render, not on principle:
     bar stubs added back  rect(7,1,2,3) ×4, i.e. the four bars reduced to
        3px stubs off the frame line. At 16px the stubs leave 1px of ground
        between themselves and both the brackets and the datum, so the tile
        goes to 8 marks in 196px² and reads as texture. Rejected.
     datum at d=4 (8px)    closes the diagonal gap to the brackets to 1px. The
        mark stops being a target with a datum in it and becomes a blob in a
        frame. d=3 holds a 4px gap on the axes. Rejected. */

/* ── FULL — BACK_MARK's own geometry, 100-unit box (kept in sync by hand) ── */

const FULL_GRID = 100;

function fullShapes() {
  const ink = [
    // corner brackets: 26 long, 6 thick, inset 4
    ...bracket(4, 4, 26, 6, +1, +1),
    ...bracket(96, 4, 26, 6, -1, +1),
    ...bracket(4, 96, 26, 6, +1, -1),
    ...bracket(96, 96, 26, 6, -1, -1),
    // thin frame: a 3-unit square annulus at 24..76 (the 2:1 partner of the bars)
    rect(24, 24, 52, 3), rect(24, 73, 52, 3), rect(24, 27, 3, 46), rect(73, 27, 3, 46),
    // four heavy bars, 6 wide
    rect(47, 12, 6, 25), rect(47, 63, 6, 25), rect(12, 47, 25, 6), rect(63, 47, 25, 6),
    // diamond datum
    poly([[50, 40.5], [59.5, 50], [50, 59.5], [40.5, 50]]),
  ];
  // stencil bridges, knocked out of the bars (they read as breaks, not chips)
  const knock = [rect(47, 19, 6, 3), rect(47, 78, 6, 3), rect(19, 47, 3, 6), rect(78, 47, 3, 6)];
  return { ink, knock, dots: halftone() };
}

/** The 45° halftone, matching style/cardart.css's back: a lattice offset by
 *  half a tile (an orthogonal grid reads as mesh; the offset makes it halftone)
 *  clipped to the same centred diamond the card back clips to. Solid dots at a
 *  measured area fraction, not a faded fill — ART §6 wants the pattern. */
function halftone() {
  const pitch = 3.5, r = 0.5, reach = 42, dots = [];
  const inDiamond = (x, y) => Math.abs(x - 50) / reach + Math.abs(y - 50) / reach <= 1;
  for (let gy = 0; gy * pitch <= FULL_GRID; gy++) {
    for (let gx = 0; gx * pitch <= FULL_GRID; gx++) {
      const x = gx * pitch + (gy % 2 ? pitch / 2 : 0);
      const y = gy * pitch;
      if (x <= FULL_GRID && inDiamond(x, y)) dots.push(circle(x, y, r));
    }
  }
  return dots;
}

const TIERS = {
  micro: () => ({ grid: MICRO_GRID, ...microShapes(3) }),
  full: () => ({ grid: FULL_GRID, ...fullShapes() }),
};

/* ── SVG ─────────────────────────────────────────────────────────────────── */

const n = (v) => String(Math.round(v * 1000) / 1000);

function shapeSVG(s) {
  if (s.t === 'r') return `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}"/>`;
  if (s.t === 'c') return `<circle cx="${n(s.cx)}" cy="${n(s.cy)}" r="${n(s.r)}"/>`;
  return `<path d="M${s.pts.map(p => `${n(p[0])} ${n(p[1])}`).join('L')}Z"/>`;
}

/**
 * The icon as SVG text.
 * @param {object} [o]
 * @param {'micro'|'full'} [o.tier]
 * @param {number} [o.inset]  fraction of the tile the MARK occupies (1 = bleed).
 * @param {boolean} [o.invert]  ink tile / cream mark — the printed side.
 * @returns {string}
 */
function iconSVG(o = {}) {
  const tier = TIERS[o.tier] ? o.tier : 'micro';
  const { grid, ink, knock, dots } = TIERS[tier]();
  const inset = o.inset || 1;
  const ground = o.invert ? CREAM : DARK;
  const mark = o.invert ? DARK : CREAM;
  const hex = (c) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');

  // The mark box is placed inside the tile; the tile itself always bleeds.
  const k = inset, off = (1 - inset) / 2 * grid;
  const g = (body, attrs) => `<g ${attrs}>${body}</g>`;
  const placed = (body) => (k === 1 && off === 0
    ? body
    : g(body, `transform="translate(${n(off)} ${n(off)}) scale(${n(k)})"`));

  let body = '';
  if (dots && dots.length) {
    body += g(dots.map(shapeSVG).join(''), `fill="${hex(mark)}" fill-opacity=".34"`);
  }
  // Knockouts are the GROUND colour, not a mask: the tile is opaque, so a
  // painted bridge and a cut bridge are the same pixels, and this keeps the
  // SVG free of <mask>/<clipPath> ids (a favicon may be inlined anywhere).
  body += g(ink.map(shapeSVG).join(''), `fill="${hex(mark)}"`);
  if (knock.length) body += g(knock.map(shapeSVG).join(''), `fill="${hex(ground)}"`);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${grid} ${grid}" `
    + `shape-rendering="crispEdges">`
    + `<title>Chudopoly</title>`
    + `<rect width="${grid}" height="${grid}" fill="${hex(ground)}"/>`
    + placed(body)
    + `</svg>`;
}

/* ── Rasteriser — server/raster.js ───────────────────────────────────────
   Rects get exact analytic coverage (the micro tier is all rects, so 16px and
   32px come out pixel-crisp with no AA on any edge); polygons and dots get
   4×4 supersampling, which is enough for two 45° edges. */

/**
 * The icon as raw RGB bytes.
 * @returns {{data: Buffer, size: number}}
 */
function iconRGB(size, o = {}) {
  const tier = TIERS[o.tier] ? o.tier : 'micro';
  const { grid, ink, knock, dots } = TIERS[tier]();
  const inset = o.inset || 1;
  const ground = o.invert ? CREAM : DARK;
  const mark = o.invert ? DARK : CREAM;

  const k = size * inset / grid;          // grid units → device px
  const off = (size - grid * k) / 2;
  const m = { k, ox: off, oy: off };

  const data = raster.canvas(size, size, ground);
  if (dots && dots.length) raster.paint(data, raster.coverage(dots, size, size, m), mark, 0.34);
  raster.paint(data, raster.coverage(ink, size, size, m), mark, 1);
  if (knock.length) raster.paint(data, raster.coverage(knock, size, size, m), ground, 1);
  return { data, size };
}

/**
 * @param {number} size  square edge in px
 * @returns {Buffer} a complete PNG
 */
function iconPNG(size, o = {}) {
  const { data } = iconRGB(size, o);
  return raster.encodePNG(data, size, size);
}

/* ── What the server serves ──────────────────────────────────────────────
   Sizes are an ALLOWLIST, not a path parameter: `/icon-4096.png` from a bot
   would otherwise be a 100MB allocation per request. Everything here is built
   once at require() time and handed out from the map. */

const PNG_ICONS = {
  // tab fallback for a browser without SVG favicon support (old Safari)
  '32': { size: 32, tier: 'micro', inset: 1 },
  // iOS home screen. Mark inset to 72% so the OS's ~22% corner mask cannot
  // clip the brackets: their corners land at 25/180 px, well inside the mask's
  // corner arc (centre 40,40 r 40 — distance 21px).
  '180': { size: 180, tier: 'full', inset: 0.72 },
  '192': { size: 192, tier: 'full', inset: 0.82 },
  '512': { size: 512, tier: 'full', inset: 0.82 },
  // Android adaptive: only the centred 80%-diameter circle is guaranteed, so
  // the mark's corners must sit inside r=0.4·size. A 0.56 inset puts them at
  // r=0.396·size.
  'maskable-512': { size: 512, tier: 'full', inset: 0.56 },
};

const svgCache = new Map();
const pngCache = new Map();

/** The tab favicon: micro tier, full bleed. */
function tabSVG() {
  if (!svgCache.has('tab')) svgCache.set('tab', iconSVG({ tier: 'micro' }));
  return svgCache.get('tab');
}

/** @param {string} key  a key of PNG_ICONS. @returns {Buffer|null} */
function pngFor(key) {
  if (!Object.prototype.hasOwnProperty.call(PNG_ICONS, key)) return null;
  if (!pngCache.has(key)) {
    const { size, ...o } = PNG_ICONS[key];
    pngCache.set(key, iconPNG(size, o));
  }
  return pngCache.get(key);
}

/** Build every raster up front so the first tab paint is not the one that pays
 *  for it. Measured on the dev machine: 29ms for the SVG + all five PNGs. */
function warm() {
  const t = Date.now();
  tabSVG();
  for (const key of Object.keys(PNG_ICONS)) pngFor(key);
  return Date.now() - t;
}

module.exports = { iconSVG, iconPNG, iconRGB, tabSVG, pngFor, warm, PNG_ICONS };
