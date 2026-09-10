// server/raster.js — the shared software rasteriser and PNG encoder.
//
// EXTRACTED from server/icon.js when server/og.js became its second consumer
// (the link-preview image is generated the same way the icons are: shapes in,
// PNG out, nothing binary in the tree — §0.3). The icon kept its geometry and
// its palette; everything below is the part that was never icon-specific, now
// generalised from a square N×N tile to a W×H canvas.
//
// No SVG parser: any SVG a consumer emits and the bitmap it rasterises are
// generated from the SAME shape list, so they cannot drift. Rects get ANALYTIC
// coverage (exact pixel-square overlap — what keeps the icon's micro tier
// crisp); circles and convex polygons get 4×4 supersampling; `rings` (a filled
// path of one or more subpaths, even-odd) gets a scanline fill with 4 subrows
// per pixel and analytic horizontal spans, which is what makes rasterising the
// wordmark's ~40 letter contours cost milliseconds rather than seconds.

'use strict';

const zlib = require('node:zlib');

/* ── Shape primitives ────────────────────────────────────────────────────
   Everything is a rect, a convex polygon, a circle, or a ring set, in the
   consumer's own authoring grid. The transform m = {k, ox, oy} maps grid
   units to device px (uniform scale k, then offset). */

const rect = (x, y, w, h) => ({ t: 'r', x, y, w, h });
const poly = (pts) => ({ t: 'p', pts });
const circle = (cx, cy, r) => ({ t: 'c', cx, cy, r });
/** One filled even-odd path: an array of rings, each an array of [x, y]. */
const rings = (rr) => ({ t: 'g', rings: rr });

const SS = 4;

function coverRect(cov, W, H, s, m) {
  const x0 = s.x * m.k + m.ox, y0 = s.y * m.k + m.oy;
  const x1 = (s.x + s.w) * m.k + m.ox, y1 = (s.y + s.h) * m.k + m.oy;
  const px0 = Math.max(0, Math.floor(x0)), px1 = Math.min(W, Math.ceil(x1));
  const py0 = Math.max(0, Math.floor(y0)), py1 = Math.min(H, Math.ceil(y1));
  for (let py = py0; py < py1; py++) {
    const cy = Math.min(y1, py + 1) - Math.max(y0, py);
    if (cy <= 0) continue;
    for (let px = px0; px < px1; px++) {
      const cx = Math.min(x1, px + 1) - Math.max(x0, px);
      if (cx <= 0) continue;
      const i = py * W + px, c = cx * cy;
      if (c > cov[i]) cov[i] = c;
    }
  }
}

function bboxOf(s, m) {
  let x0, y0, x1, y1;
  if (s.t === 'c') { x0 = s.cx - s.r; y0 = s.cy - s.r; x1 = s.cx + s.r; y1 = s.cy + s.r; }
  else {
    x0 = y0 = Infinity; x1 = y1 = -Infinity;
    for (const [x, y] of s.pts) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return [x0 * m.k + m.ox - 1, y0 * m.k + m.oy - 1, x1 * m.k + m.ox + 1, y1 * m.k + m.oy + 1];
}

function coverSampled(cov, W, H, s, m, hit) {
  const b = bboxOf(s, m);
  const px0 = Math.max(0, Math.floor(b[0])), px1 = Math.min(W, Math.ceil(b[2]));
  const py0 = Math.max(0, Math.floor(b[1])), py1 = Math.min(H, Math.ceil(b[3]));
  const step = 1 / SS, half = step / 2;
  for (let py = py0; py < py1; py++) {
    for (let px = px0; px < px1; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        const y = ((py + half + sy * step) - m.oy) / m.k;
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + half + sx * step) - m.ox) / m.k;
          if (hit(x, y)) hits++;
        }
      }
      if (!hits) continue;
      const i = py * W + px, c = hits / (SS * SS);
      if (c > cov[i]) cov[i] = c;
    }
  }
}

/** Even-odd crossing test for a convex polygon (the icon's diamond datum). */
function inPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Scanline even-odd fill over a ring set. Coverage ACCUMULATES (4 subrows ×
 *  ≤1 horizontal overlap each ≤ 1 total), where the other shapes take max —
 *  spans within one subrow are disjoint by even-odd, so the sum is exact. */
function coverRings(cov, W, H, s, m) {
  const dev = [];
  let gy0 = Infinity, gy1 = -Infinity;
  for (const ring of s.rings) {
    const r = new Array(ring.length);
    let ry0 = Infinity, ry1 = -Infinity;
    for (let i = 0; i < ring.length; i++) {
      const x = ring[i][0] * m.k + m.ox, y = ring[i][1] * m.k + m.oy;
      r[i] = [x, y];
      if (y < ry0) ry0 = y; if (y > ry1) ry1 = y;
    }
    dev.push({ pts: r, y0: ry0, y1: ry1 });
    if (ry0 < gy0) gy0 = ry0; if (ry1 > gy1) gy1 = ry1;
  }
  const py0 = Math.max(0, Math.floor(gy0)), py1 = Math.min(H, Math.ceil(gy1));
  const step = 1 / SS;
  const xs = [];
  for (let sy = py0 * SS; sy < py1 * SS; sy++) {
    const y = (sy + 0.5) * step;
    xs.length = 0;
    for (const ring of dev) {
      if (y < ring.y0 || y > ring.y1) continue;
      const pts = ring.pts;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const yi = pts[i][1], yj = pts[j][1];
        if ((yi > y) !== (yj > y)) {
          xs.push(pts[i][0] + (pts[j][0] - pts[i][0]) * (y - yi) / (yj - yi));
        }
      }
    }
    if (!xs.length) continue;
    xs.sort((a, b) => a - b);
    const row = Math.floor(sy / SS) * W;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const a = Math.max(0, xs[i]), b = Math.min(W, xs[i + 1]);
      if (b <= a) continue;
      for (let px = Math.floor(a), pe = Math.ceil(b); px < pe; px++) {
        const c = Math.min(b, px + 1) - Math.max(a, px);
        if (c <= 0) continue;
        const idx = row + px, v = cov[idx] + c * step;
        cov[idx] = v > 1 ? 1 : v;
      }
    }
  }
}

/**
 * Coverage of `shapes` on a W×H canvas under transform m = {k, ox, oy}.
 * @returns {Float32Array} W*H, 0..1 per pixel
 */
function coverage(shapes, W, H, m) {
  const cov = new Float32Array(W * H);
  for (const s of shapes) {
    if (s.t === 'r') coverRect(cov, W, H, s, m);
    else if (s.t === 'g') coverRings(cov, W, H, s, m);
    else if (s.t === 'c') {
      const r2 = s.r * s.r;
      coverSampled(cov, W, H, s, m, (x, y) => (x - s.cx) ** 2 + (y - s.cy) ** 2 <= r2);
    } else coverSampled(cov, W, H, s, m, (x, y) => inPoly(s.pts, x, y));
  }
  return cov;
}

/** Blend `colour` into an RGB buffer wherever cov > 0, scaled by alpha. */
function paint(data, cov, colour, alpha) {
  for (let i = 0; i < cov.length; i++) {
    const a = cov[i] * alpha;
    if (a <= 0) continue;
    const k = a > 1 ? 1 : a;
    for (let c = 0; c < 3; c++) {
      const j = i * 3 + c;
      data[j] = Math.round(data[j] + (colour[c] - data[j]) * k);
    }
  }
}

/** A W×H RGB buffer flooded with `ground` ([r, g, b]). */
function canvas(W, H, ground) {
  const data = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    data[i * 3] = ground[0]; data[i * 3 + 1] = ground[1]; data[i * 3 + 2] = ground[2];
  }
  return data;
}

/* ── PNG encoder ─────────────────────────────────────────────────────────
   Truecolour 8-bit, one IDAT, filter 0 on every scanline. zlib is built in,
   so this adds no dependency and no binary to the tree. */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, payload) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * @param {Buffer} data  W*H*3 RGB bytes
 * @returns {Buffer} a complete PNG
 */
function encodePNG(data, W, H) {
  const stride = W * 3;
  const raw = Buffer.alloc((stride + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (stride + 1)] = 0;                                   // filter: None
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { rect, poly, circle, rings, coverage, paint, canvas, encodePNG };
