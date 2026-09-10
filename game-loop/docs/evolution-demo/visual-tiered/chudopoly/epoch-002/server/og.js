// server/og.js — the link preview, drawn in code and rasterised in code.
//
// WHAT THIS IS
// The Open Graph image behind <meta property="og:image"> — the card a timeline
// shows when the game's URL is pasted into Twitter/X, iMessage, Discord or
// Slack. §0.3 bans .png files in the repo, so like the app icon it is a ROUTE
// (/og.png), generated once at startup from geometry the client already ships,
// through the same rasteriser and PNG encoder the icons use (server/raster.js,
// extracted from icon.js when this file became its second consumer).
//
// WHAT IS DRAWN — the home screen, because the home screen is the identity
// ("the home screen IS the table" — ART §3.3, and the strongest surface the
// project has). Night apron ground, the three registers the home screen paints:
//
//   head   the ratified WORDMARK PLATE — not redrawn: the shape list is parsed
//          out of public/index.html's own .brand-mark SVG at build time, so the
//          preview cannot drift from the mark the page renders. Under it, the
//          head's rule pair (solid over dashed), edge to edge.
//   table  the DECK — four card backs at the dealer's angles ui.css gives the
//          home pile (-4°, 2.6°, -1.2°, .6°). Each back is built from
//          table/cardart.js's OWN exports (BACK_MARK, WORD_FULL, and the
//          .ca-back proportions: word at 66% of the card, mark at 52%, the 45°
//          halftone screen clipped to a diamond), so a card-art redraw lands
//          here for free — the same argument that rebuilt the home deck from
//          faceNode()/backNode().
//   rail   the hold-short line — two solid, two dashed, edge to edge.
//
// Face-up cards are NOT drawn: a face is DOM + CSS + system type, and a
// server-side imitation of it would be a second copy that drifts — the exact
// failure this file's sourcing exists to avoid. Backs are pure geometry.
//
// WHY THE GROUND IS THE NIGHT APRON
// The centre must carry the meaning at timeline scale, and the meaning is the
// name. Cream plate on #15171C is the highest-contrast rendering of the
// wordmark the palette allows, it holds on a white timeline and a dark one
// alike (the image brings its own ground), and it is the same family as the
// favicon's dark tile — the tab and the unfurl agree.
//
// STATIC BY CHOICE: a preview that changes is a preview that gets cached wrong
// (crawlers cache og:image for days). Nothing here reads game state.
//
// ALSO HERE: originOf()/withOrigin(), because og:image and og:url must be
// ABSOLUTE and index.html is a static file served to both dev and prod. The
// file carries the placeholder __ORIGIN__; server.js substitutes per request
// from CANONICAL_ORIGIN (set it once chudopoly.deal is attached) or, failing
// that, from the request's own Host / X-Forwarded-* — so localhost:3000,
// deal.8tp.dev and the Railway host each unfurl with URLs that resolve to
// themselves, and nothing 404s while the custom domain is in flux.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const raster = require('./raster');

/* ── Palette (ART §2; identical to the tokens variables.css ships) ───────── */

const GROUND = [0x15, 0x17, 0x1c];     // --ground, apron at night
const DARK = [0x14, 0x16, 0x1a];       // --card-back
const CREAM = [0xfb, 0xf8, 0xf1];      // --card-stock
const STENCIL = [0xf2, 0xee, 0xe4];    // --fg dark; markings painted on the apron
const STENCIL_HI_A = 0.22;             // --stencil-hi dark theme alpha
const STENCIL_LO_A = 0.11;             // --stencil dark theme alpha
const DROP = [0xa2, 0x97, 0x7e];       // --ca-drop fallback in the brand mark

const VAR_FILL = {
  'var(--card-stock)': CREAM,
  'var(--ink)': DARK,
  'var(--card-back)': DARK,
};

function fillColour(v) {
  if (!v) return null;
  if (VAR_FILL[v]) return VAR_FILL[v];
  const hex = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const fb = /^var\([^,]+,\s*(#[0-9a-f]{6})\s*\)$/i.exec(v.trim());
  if (fb) return fillColour(fb[1]);
  throw new Error(`og: unmappable fill "${v}"`);
}

/* ── Path data → rings ────────────────────────────────────────────────────
   The whole corpus (brand mark, alphabet, BACK_MARK) is authored with absolute
   M/L/H/V/Z only — the drawing law has no curves. Anything else throws, so a
   future redraw that adds an arc fails the build loudly instead of rendering
   a hole. */

function pathRings(d) {
  const out = [];
  let ring = null, x = 0, y = 0, cmd = '';
  const toks = d.match(/[A-Za-z]|-?\d*\.?\d+/g) || [];
  let i = 0;
  const close = () => { if (ring && ring.length >= 3) out.push(ring); ring = null; };
  while (i < toks.length) {
    const t = toks[i];
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t; i++;
      if (cmd === 'Z' || cmd === 'z') close();
      else if (!'MLHV'.includes(cmd)) throw new Error(`og: unsupported path command "${cmd}"`);
      continue;
    }
    if (cmd === 'M') { close(); x = +t; y = +toks[i + 1]; i += 2; ring = [[x, y]]; cmd = 'L'; }
    else if (cmd === 'L') { x = +t; y = +toks[i + 1]; i += 2; ring.push([x, y]); }
    else if (cmd === 'H') { x = +t; i += 1; ring.push([x, y]); }
    else if (cmd === 'V') { y = +t; i += 1; ring.push([x, y]); }
    else throw new Error('og: path data before any command');
  }
  close();
  return out;
}

/* ── The wordmark plate, parsed out of index.html ─────────────────────────
   The mark is ratified and must not be altered, so this file holds NO copy of
   it: the <svg class="brand-mark"> block is read from the page and its
   rect/g/path structure (fills, translate transforms) is turned into paint
   layers. If the structure ever changes shape, the throw below fails startup
   rather than shipping a wrong mark to every unfurler. */

function parseBrandMark(html) {
  const block = /<svg class="brand-mark"[^>]*viewBox="0 0 (\d+) (\d+)"[\s\S]*?<\/svg>/.exec(html);
  if (!block) throw new Error('og: no .brand-mark svg in public/index.html');
  const [w, h] = [Number(block[1]), Number(block[2])];
  const svg = block[0].replace(/<!--[\s\S]*?-->/g, '');

  const layers = [];   // {colour, shapes} in document order
  const stack = [{ fill: null, dx: 0, dy: 0 }];
  const top = () => stack[stack.length - 1];
  const tagRe = /<\/g>|<(g|rect|path)\b([^>]*?)\/?>/g;
  const attr = (s, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(s)?.[1];
  let m;
  while ((m = tagRe.exec(svg))) {
    if (m[0] === '</g>') { stack.pop(); continue; }
    const [, tag, attrs] = m;
    if (tag === 'g') {
      const t = /translate\((-?[\d.]+)[ ,](-?[\d.]+)\)/.exec(attr(attrs, 'transform') || '');
      stack.push({
        fill: attr(attrs, 'fill') || top().fill,
        dx: top().dx + (t ? +t[1] : 0),
        dy: top().dy + (t ? +t[2] : 0),
      });
      continue;
    }
    const colour = fillColour(attr(attrs, 'fill') || top().fill);
    if (tag === 'rect') {
      layers.push({
        colour,
        shapes: [raster.rect(
          +(attr(attrs, 'x') || 0) + top().dx, +(attr(attrs, 'y') || 0) + top().dy,
          +attr(attrs, 'width'), +attr(attrs, 'height'))],
      });
    } else {
      const rr = pathRings(attr(attrs, 'd'))
        .map((ring) => ring.map(([x, y]) => [x + top().dx, y + top().dy]));
      layers.push({ colour, shapes: [raster.rings(rr)] });
    }
  }
  if (layers.length < 4) throw new Error(`og: brand mark parsed to ${layers.length} layers — structure changed`);
  return { w, h, layers };
}

/* ── The card back, from table/cardart.js's own geometry ─────────────────── */

/** Rotate-and-translate helpers: rects survive only unrotated; everything
 *  else becomes rings/points in device space. */
function placeRings(rr, k, rot, cx, cy) {
  const s = Math.sin(rot), c = Math.cos(rot);
  return rr.map((ring) => ring.map(([x, y]) => {
    const px = x * k, py = y * k;
    return [cx + px * c - py * s, cy + px * s + py * c];
  }));
}

/** A rounded rect as a union: two crossing rects + 4 corner circles. The two
 *  rects are SEPARATE shapes — in one even-odd ring set their intersection
 *  would knock out (measured on the first render: every card back came out as
 *  a hollow frame with the pile visible through it). All in CARD-LOCAL units,
 *  centred on (0,0) so rotation is trivial. */
function roundedRectShapes(w, h, r, rot, cx, cy) {
  const rects = [
    [[-w / 2 + r, -h / 2], [w / 2 - r, -h / 2], [w / 2 - r, h / 2], [-w / 2 + r, h / 2]],
    [[-w / 2, -h / 2 + r], [w / 2, -h / 2 + r], [w / 2, h / 2 - r], [-w / 2, h / 2 - r]],
  ];
  const shapes = rects.map((ring) => raster.rings(placeRings([ring], 1, rot, cx, cy)));
  const s = Math.sin(rot), c = Math.cos(rot);
  for (const [ox, oy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const px = ox * (w / 2 - r), py = oy * (h / 2 - r);
    shapes.push(raster.circle(cx + px * c - py * s, cy + px * s + py * c, r));
  }
  return shapes;
}

/**
 * Paint layers for one card back of width `w` at centre (cx, cy), rotated
 * `deg`. Proportions are cardart's: --card-ratio 5/7; .ca-hand.ca-back gives
 * the word 66% of the card, the deck mark 52%, gap 5cqw; the halftone screen
 * is a 6px-pitch 45° lattice of r=.85 dots at .40 alpha clipped to the centred
 * diamond; the edge is the .22-alpha bone inset ring.
 */
function cardBackLayers(art, w, cx, cy, deg) {
  const h = w * 7 / 5;
  const rot = deg * Math.PI / 180;
  const r = Math.min(6, 0.06 * w);   // --card-r: 6% of width, clamped like the CSS
  const layers = [];

  // tile + inset ring (paint ring under a re-fill of the interior)
  layers.push({ colour: DARK, alpha: 1, shapes: roundedRectShapes(w, h, r, rot, cx, cy) });
  layers.push({ colour: CREAM, alpha: 0.22, shapes: roundedRectShapes(w, h, r, rot, cx, cy) });
  layers.push({ colour: DARK, alpha: 1, shapes: roundedRectShapes(w - 3, h - 3, Math.max(1, r - 1.5), rot, cx, cy) });

  // 45° halftone screen, clipped to the centred diamond (ca-back::before)
  const dots = [];
  const s = Math.sin(rot), c = Math.cos(rot);
  const inDiamond = (x, y) =>
    Math.abs(x) / (0.46 * w) + Math.abs(y) / (0.46 * h) <= 1;
  for (let gy = 0, y = -h / 2; y <= h / 2; y = ++gy * 6 - h / 2) {
    for (let x = -w / 2 + (gy % 2 ? 3 : 0); x <= w / 2; x += 6) {
      if (!inDiamond(x, y)) continue;
      dots.push(raster.circle(cx + x * c - y * s, cy + x * s + y * c, 0.85));
    }
  }
  layers.push({ colour: STENCIL, alpha: 0.40, shapes: dots });

  // the word (66%) over the mark (52%), the column centred as flex centres it
  const wordW = 0.66 * w, wordK = wordW / 604, wordH = 112 * wordK;
  const markW = 0.52 * w, markK = markW / 100;
  const gap = 0.05 * w;
  const colH = wordH + gap + markW;
  const wordTop = -colH / 2, markTop = wordTop + wordH + gap;

  const wordRings = art.wordRings.map((ring) => ring.map(([x, y]) =>
    [(x + 4) * wordK - wordW / 2, (y + 6) * wordK + wordTop]));
  layers.push({ colour: CREAM, alpha: 1, shapes: [raster.rings(placeRings(wordRings, 1, rot, cx, cy))] });

  const mark = (rr) => raster.rings(placeRings(
    rr.map((ring) => ring.map(([x, y]) => [x * markK - markW / 2, y * markK + markTop])),
    1, rot, cx, cy));
  layers.push({ colour: CREAM, alpha: 1, shapes: art.markInk.map(mark) });
  layers.push({ colour: DARK, alpha: 1, shapes: art.markKnock.map(mark) });
  return layers;
}

/* ── Composition ────────────────────────────────────────────────────────── */

/** The home pile, verbatim from ui.css (.home-back-0…3): translate cqw pairs
 *  and the dealer's angles. Offsets are fractions of the card width (1cqw of
 *  the deck box = 1/38 card width). */
const PILE = [
  { tx: 1.0, ty: 0.0, deg: -4.0 },
  { tx: 2.4, ty: 1.2, deg: 2.6 },
  { tx: 1.4, ty: 0.6, deg: -1.2 },
  { tx: 2.0, ty: 0.0, deg: 0.6 },
];

/** A horizontal marking line: solid, or dashed with `[dash, gap]`. */
function lineShapes(W, y, hpx, dash) {
  if (!dash) return [raster.rect(0, y, W, hpx)];
  const out = [];
  for (let x = 0; x < W; x += dash[0] + dash[1]) {
    out.push(raster.rect(x, y, Math.min(dash[0], W - x), hpx));
  }
  return out;
}

function compose(W, H, mark, art) {
  const data = raster.canvas(W, H, GROUND);
  const put = (layers) => {
    for (const l of layers) {
      raster.paint(data, raster.coverage(l.shapes, W, H, { k: 1, ox: 0, oy: 0 }),
        l.colour, l.alpha == null ? 1 : l.alpha);
    }
  };

  // head — the plate, centred, height-capped exactly like .brand-mark is
  const plateH = Math.round(0.27 * H);
  const plateK = plateH / mark.h;
  const plateX = (W - mark.w * plateK) / 2, plateY = Math.round(0.135 * H);
  for (const l of mark.layers) {
    raster.paint(data, raster.coverage(l.shapes, W, H, { k: plateK, ox: plateX, oy: plateY }),
      l.colour, 1);
  }

  // the head's rule pair: solid over dashed (home-head::after)
  const ruleY = Math.round(0.448 * H);
  put([
    { colour: STENCIL, alpha: STENCIL_HI_A, shapes: lineShapes(W, ruleY, 2) },
    { colour: STENCIL, alpha: STENCIL_LO_A, shapes: lineShapes(W, ruleY + 3, 2, [26, 14]) },
  ]);

  // table — the pile. Card height 0.38H, the largest object on screen, as the
  // home screen's comment demands of its deck. 1cqw of the home deck box is
  // 1/38 of a card width; the same unit here keeps the stagger proportional.
  const cw = Math.round(0.42 * H * 5 / 7);
  const cqw = cw / 38;
  const ccx = W / 2, ccy = Math.round(0.705 * H);
  for (const p of PILE) {
    put(cardBackLayers(art, cw, ccx + (p.tx - 1.7) * cqw, ccy + (p.ty - 0.45) * cqw, p.deg));
  }

  // rail — the hold-short line (home-rail::before): two solid, two dashed
  const holdY = Math.round(0.925 * H);
  put([
    { colour: STENCIL, alpha: STENCIL_HI_A, shapes: lineShapes(W, holdY, 2) },
    { colour: STENCIL, alpha: STENCIL_HI_A, shapes: lineShapes(W, holdY + 3, 2) },
    { colour: STENCIL, alpha: STENCIL_HI_A, shapes: lineShapes(W, holdY + 7, 2, [12, 10]) },
    { colour: STENCIL, alpha: STENCIL_HI_A, shapes: lineShapes(W, holdY + 10, 2, [12, 10]) },
  ]);
  return raster.encodePNG(data, W, H);
}

/* ── Build & cache ──────────────────────────────────────────────────────── */

const SIZES = {
  og: [1200, 630],          // the OG/Twitter canonical
  github: [1280, 640],      // GitHub's social-preview recommendation
};

let built = null;           // Promise<{og: Buffer, github: Buffer}>

async function build() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const mark = parseBrandMark(html);

  // The back's geometry, from the module the client renders it with.
  const cardart = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'src', 'table', 'cardart.js')).href);
  const markPaths = [...cardart.BACK_MARK.matchAll(/<path d="([^"]+)"\/?>/g)].map((m) => m[1]);
  const markRects = [...cardart.BACK_MARK.matchAll(
    /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"\/>/g)];
  if (!markPaths.length || !markRects.length) throw new Error('og: BACK_MARK structure changed');
  const art = {
    wordRings: pathRings(cardart.WORD_FULL),
    markInk: markPaths.map(pathRings),
    markKnock: markRects.map((m) => [[
      [+m[1], +m[2]], [+m[1] + +m[3], +m[2]], [+m[1] + +m[3], +m[2] + +m[4]], [+m[1], +m[2] + +m[4]],
    ]]),
  };

  const out = {};
  for (const [key, [w, h]] of Object.entries(SIZES)) out[key] = compose(w, h, mark, art);
  return out;
}

/** @param {'og'|'github'} key @returns {Promise<Buffer|null>} */
async function png(key) {
  if (!Object.prototype.hasOwnProperty.call(SIZES, key)) return null;
  if (!built) built = build();
  return (await built)[key];
}

/** Build every size up front so the first crawler is not the one that pays.
 *  @returns {Promise<number>} elapsed ms */
async function warm() {
  const t = Date.now();
  if (!built) built = build();
  await built;
  return Date.now() - t;
}

/* ── Absolute URLs for the static page ───────────────────────────────────── */

const HOST_OK = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i;

/**
 * The origin to print into og:url / og:image / the canonical link.
 * CANONICAL_ORIGIN wins when set (set it to https://chudopoly.deal once that
 * domain is attached); otherwise the request's own forwarded proto + host, so
 * every host the app is reachable on unfurls with URLs that resolve to itself.
 * The host is validated before it is printed into HTML — a Host header is
 * attacker-controlled bytes.
 */
function originOf(req, fallbackHost) {
  const env = (process.env.CANONICAL_ORIGIN || '').trim().replace(/\/+$/, '');
  if (env) return env;
  const first = (v) => String(v || '').split(',')[0].trim();
  let host = first(req.headers['x-forwarded-host']) || first(req.headers.host);
  if (!HOST_OK.test(host)) host = fallbackHost || 'localhost';
  let proto = first(req.headers['x-forwarded-proto']).toLowerCase();
  if (proto !== 'http' && proto !== 'https') proto = req.socket && req.socket.encrypted ? 'https' : 'http';
  return `${proto}://${host}`;
}

/** Substitute the page's __ORIGIN__ placeholder. */
function withOrigin(html, origin) {
  return html.split('__ORIGIN__').join(origin);
}

module.exports = { png, warm, originOf, withOrigin, SIZES };
