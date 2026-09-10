// Contract tests for the link preview (server/og.js + the <head> metadata).
//
// Like the icon, the preview has no file on disk to review — and unlike the
// icon, nobody on the team ever sees it in normal use: it exists for crawlers,
// which do not run JS and do not complain. A wrong tag here fails silently as
// a bare grey link on someone else's timeline. So the things a crawler would
// trip over are asserted here: the tags exist in the SERVED html, the image
// URLs are absolute once the origin is substituted, the declared dimensions
// are the encoded dimensions, and the image actually painted.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const zlib = require('node:zlib');
const og = require('../server/og');

const html = readFileSync('public/index.html', 'utf8');
const meta = (sel) => {
  const re = new RegExp(`<meta (?:property|name)="${sel}" content="([^"]*)"`);
  return re.exec(html)?.[1];
};

test('the head carries the full unfurl set', () => {
  // og:image and og:url must be ABSOLUTE — a relative image does not unfurl.
  // The file is static, so absoluteness is carried by the __ORIGIN__
  // placeholder server.js substitutes; both facts are asserted.
  assert.equal(meta('og:type'), 'website');
  assert.equal(meta('og:site_name'), 'CHUDOPOLY');
  // The document <title> and og:title are DELIBERATELY different, and the
  // difference is the whole reasoning: <title> is met by people searching, so
  // it leads with the words they typed; og:title is met by people who were
  // HANDED the link, so it leads with the brand. Pinned so neither drifts onto
  // the other's job.
  const ogTitle = meta('og:title');
  assert.match(ogTitle, /^Chudopoly\b/, 'a shared card leads with the brand');
  assert.match(ogTitle, /Monopoly Deal/, '...and still says what kind of game it is');
  const docTitle = /<title>([^<]*)<\/title>/.exec(html)?.[1];
  assert.match(docTitle, /^Play Monopoly Deal Online Free/, 'a result leads with the intent');
  assert.ok(docTitle.length <= 60, `a SERP truncates past ~60 chars (${docTitle.length})`);
  assert.notEqual(docTitle, ogTitle);
  assert.match(meta('og:url'), /^__ORIGIN__\//);
  assert.match(meta('og:image'), /^__ORIGIN__\/og\.png\?v=/, 'absolute and cache-busted');
  assert.equal(meta('twitter:card'), 'summary_large_image');
  assert.equal(meta('twitter:image'), meta('og:image'), 'one asset, both crawlers');
  assert.match(html, /<link rel="canonical" href="__ORIGIN__\/">/);
  for (const key of ['og:description', 'twitter:description']) {
    const d = meta(key);
    assert.ok(d && d.length >= 40 && d.length <= 200, `${key} is the one sentence under the card`);
    assert.equal(d, meta('description'), 'one description everywhere, or they drift');
  }
  for (const key of ['og:image:alt', 'twitter:image:alt']) {
    assert.ok((meta(key) || '').length > 20, `${key} must describe the image`);
  }
});

/** Minimal PNG reader for OUR encoder: truecolour 8-bit, filter 0 rows. */
function decode(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR');
  const W = png.readUInt32BE(16), H = png.readUInt32BE(20);
  assert.equal(png[24], 8); assert.equal(png[25], 2);
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('latin1'), 'IEND');
  const idat = [];
  for (let off = 8; off < png.length;) {
    const len = png.readUInt32BE(off), type = png.subarray(off + 4, off + 8).toString('latin1');
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = W * 3;
  const data = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    assert.equal(raw[y * (stride + 1)], 0, 'filter 0 rows only');
    raw.copy(data, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { W, H, at: (x, y) => [...data.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)] };
}

test('the served PNG is valid and its dimensions are the declared ones', async () => {
  const img = decode(await og.png('og'));
  assert.equal(img.W, Number(meta('og:image:width')));
  assert.equal(img.H, Number(meta('og:image:height')));
  assert.deepEqual([img.W, img.H], [1200, 630], 'the OG canonical size');
  const gh = decode(await og.png('github'));
  assert.deepEqual([gh.W, gh.H], [1280, 640], 'GitHub social-preview size');
});

test('the composition actually painted — an empty apron would encode just as cleanly', async () => {
  const img = decode(await og.png('og'));
  assert.deepEqual(img.at(2, 2), [0x15, 0x17, 0x1c], 'the ground is the night apron');
  // The three registers, sampled where their solids must be: cream plate
  // stock inside the head register, ink letterform at dead centre of the
  // plate, and the card back's dark tile at the pile's centre.
  const tones = { cream: 0, ink: 0 };
  for (let y = 0; y < img.H; y += 3) {
    for (let x = 0; x < img.W; x += 3) {
      const [r, g, b] = img.at(x, y);
      if (r === 0xfb && g === 0xf8 && b === 0xf1) tones.cream++;
      if (r === 0x14 && g === 0x16 && b === 0x1a) tones.ink++;
    }
  }
  assert.ok(tones.cream > 2000, `card stock painted (${tones.cream} samples)`);
  assert.ok(tones.ink > 1000, `ink painted (${tones.ink} samples)`);
});

test('an unknown key is not a route — the allowlist is the DoS guard', async () => {
  assert.equal(await og.png('4096'), null);
  assert.equal(await og.png('constructor'), null);
});

test('originOf: env pin wins, headers are validated, nothing 404s meanwhile', () => {
  const req = (headers, encrypted = false) => ({ headers, socket: { encrypted } });
  delete process.env.CANONICAL_ORIGIN;
  assert.equal(og.originOf(req({ host: 'localhost:3000' }), 'localhost:9'), 'http://localhost:3000');
  assert.equal(og.originOf(req({
    host: 'internal:3000', 'x-forwarded-host': 'deal.8tp.dev', 'x-forwarded-proto': 'https',
  }), 'localhost:9'), 'https://deal.8tp.dev', 'the proxy headers are the public identity');
  // A Host header is attacker-controlled bytes headed for an HTML attribute.
  assert.equal(og.originOf(req({ host: 'evil"><script>' }), 'localhost:9'), 'http://localhost:9');
  assert.equal(og.originOf(req({ host: 'x', 'x-forwarded-proto': 'gopher"' }), 'x'), 'http://x');
  process.env.CANONICAL_ORIGIN = 'https://chudopoly.deal/';
  try {
    assert.equal(og.originOf(req({ host: 'anything' }), 'x'), 'https://chudopoly.deal',
      'the pin wins over every header, trailing slash trimmed');
  } finally { delete process.env.CANONICAL_ORIGIN; }
  const page = og.withOrigin(html, 'https://deal.8tp.dev');
  assert.doesNotMatch(page, /__ORIGIN__/, 'no placeholder survives substitution');
  assert.match(page, /content="https:\/\/deal\.8tp\.dev\/og\.png\?v=/);
});
