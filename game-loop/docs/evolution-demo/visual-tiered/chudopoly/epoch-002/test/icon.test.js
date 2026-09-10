// Contract tests for the generated app icon (server/icon.js + the <head> links).
//
// The icon is the one asset in the build with no file on disk to look at, so
// the things a reviewer would normally catch by opening the file have to be
// caught here: that the PNG is a real PNG, that the mark actually painted
// (a silently-empty tile still encodes fine), that the drawing law holds, and
// that §0.3 was not walked back by someone adding a .png "just for the icon".

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const icon = require('../server/icon');

const html = readFileSync('public/index.html', 'utf8');
const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));

test('the page declares an SVG favicon, a raster fallback, and a manifest', () => {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]);
  const rel = (r) => links.filter(l => new RegExp(`rel="${r}"`).test(l));
  assert.equal(rel('icon').length, 1);
  assert.match(rel('icon')[0], /type="image\/svg\+xml"/);
  assert.equal(rel('alternate icon').length, 1, 'old Safari needs a PNG');
  assert.equal(rel('apple-touch-icon').length, 1, 'iOS home screen needs a PNG');
  assert.equal(rel('manifest').length, 1);
  // §0.2: every href in the head is cache-busted, icons included.
  for (const l of [...rel('icon'), ...rel('alternate icon'), ...rel('apple-touch-icon'), ...rel('manifest')]) {
    assert.match(l, /href="[^"]+\?v=/, l);
  }
});

test('theme-color is declared for both colour schemes', () => {
  const metas = [...html.matchAll(/<meta name="theme-color"[^>]*>/g)].map(m => m[0]);
  assert.equal(metas.length, 2);
  assert.ok(metas.some(m => /prefers-color-scheme: dark/.test(m)));
  assert.ok(metas.some(m => /prefers-color-scheme: light/.test(m)));
});

test('every manifest icon resolves to something the server can actually serve', () => {
  // Two legal sources since §0.3 amendment (f): the /icon.svg route, and the
  // committed /icons/*.png set that tools/genicons.mjs renders from this same
  // geometry (test/pwa.test.js holds the byte-for-byte provenance).
  for (const entry of manifest.icons) {
    const path = entry.src.split('?')[0];
    if (path === '/icon.svg') { assert.ok(icon.tabSVG().length > 0); continue; }
    const file = /^\/icons\/(icon-[\w-]+\.png)$/.exec(path);
    assert.ok(file, `manifest points at ${path}, which is neither the SVG route nor a committed /icons/ file`);
    assert.ok(existsSync(`public/icons/${file[1]}`), `manifest points at ${path} but the file is not committed — run node tools/genicons.mjs`);
  }
  // An Android install prompt is refused without a maskable icon >=192px.
  assert.ok(manifest.icons.some(i => i.purpose === 'maskable'));
});

test('an unknown size is not a route — the allowlist is the DoS guard', () => {
  assert.equal(icon.pngFor('4096'), null);
  assert.equal(icon.pngFor('../../etc/passwd'), null);
  assert.equal(icon.pngFor('constructor'), null);   // prototype keys are not sizes
});

test('the PNG route emits a structurally valid PNG', () => {
  const png = icon.pngFor('32');
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 32);           // width
  assert.equal(png.readUInt32BE(20), 32);           // height
  assert.equal(png[24], 8, 'bit depth');
  assert.equal(png[25], 2, 'colour type: truecolour');
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('latin1'), 'IEND');
});

test('the mark actually paints — an empty tile would encode just as cleanly', () => {
  const { data, size } = icon.iconRGB(32, { tier: 'micro' });
  const at = (x, y) => [...data.subarray((y * size + x) * 3, (y * size + x) * 3 + 3)];
  assert.deepEqual(at(0, 0), [0x14, 0x16, 0x1a], 'tile ground is --card-back');
  assert.deepEqual(at(16, 16), [0xfb, 0xf8, 0xf1], 'the datum is --card-stock');
  assert.deepEqual(at(4, 4), [0xfb, 0xf8, 0xf1], 'the top-left bracket is drawn');
  // Every pixel is one of the two solid tokens: no AA, no half-tones, no grey
  // mush. This is the whole point of the micro tier and it is measurable.
  const tones = new Set();
  for (let i = 0; i < size * size; i++) tones.add(data.subarray(i * 3, i * 3 + 3).toString('hex'));
  assert.deepEqual([...tones].sort(), ['14161a', 'fbf8f1'].sort(),
    `micro tier rendered ${tones.size} tones at 32px; it must be exactly 2`);
});

test('the icon obeys the drawing law (ART §6 / MIL-STD-38784B)', () => {
  for (const tier of ['micro', 'full']) {
    const svg = icon.iconSVG({ tier });
    assert.doesNotMatch(svg, /Gradient|filter|blur|opacity="0?\.\d+"\s*\/>/i, `${tier}: no gradient/blur`);
    assert.doesNotMatch(svg, /\brx=|\bry=|stroke-linejoin="round"|stroke-linecap="round"/, `${tier}: square corners only`);
    assert.doesNotMatch(svg, /<(mask|clipPath|use|image)\b/, `${tier}: no ids to collide when inlined`);
  }
  // The micro tier is rects only — that is what makes 16px and 32px integral.
  const micro = icon.iconSVG({ tier: 'micro' });
  assert.doesNotMatch(micro, /<(path|circle|polygon)\b/);
  assert.match(micro, /shape-rendering="crispEdges"/);
  assert.doesNotMatch(micro, /="\d+\.\d/, 'every micro coordinate must land on a pixel');
});

test('no insignia crept back in (32 C.F.R. §507.9, and 844f99e)', () => {
  // Structural, not a word grep: the two shapes a roundel or a service device
  // needs are a large disc and a star. Every circle in the corpus is a halftone
  // dot (r <= 1 of 100 units), and the only polygon is a 4-point diamond — a
  // star needs at least 8 points, or 10 with its reflex vertices.
  for (const tier of ['micro', 'full']) {
    const svg = icon.iconSVG({ tier });
    for (const m of svg.matchAll(/<circle[^>]*r="([\d.]+)"/g)) {
      assert.ok(Number(m[1]) <= 1, `${tier}: a circle of r=${m[1]} is not a halftone dot`);
    }
    for (const m of svg.matchAll(/<path d="M([^"]+)"/g)) {
      const pts = m[1].split('L').length;
      assert.ok(pts <= 4, `${tier}: a ${pts}-point polygon is not the diamond datum`);
    }
  }
});
