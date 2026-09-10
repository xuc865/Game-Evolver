// Contract tests for the installed-app (PWA) surface: the §0.3 amendment (f)
// icon set, the manifest the installer reads, and the client's standalone
// detection.
//
// The load-bearing one is the first: the committed PNGs are legal ONLY as the
// byte-for-byte output of tools/genicons.mjs (which renders server/icon.js's
// hand-authored geometry — no roundel, no insignia). checkAssets holds the
// count and the location; this holds the provenance, so a hand-edited or
// foreign PNG in public/icons/ cannot ride in under the allowlist.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
const html = readFileSync('public/index.html', 'utf8');
const mainjs = readFileSync('public/src/main.js', 'utf8');

test('public/icons/ regenerates byte-for-byte from the checked-in generator', () => {
  const r = spawnSync(process.execPath, ['tools/genicons.mjs', '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0,
    `genicons --check failed — a committed icon differs from a fresh render:\n${r.stdout}${r.stderr}`);
});

test('the manifest is what the installer needs, under the game\'s own name', () => {
  assert.equal(manifest.name, 'CHUDOPOLY');
  assert.equal(manifest.short_name, 'Chudopoly');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.id, '/', 'id pins install identity independent of start_url');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.orientation, 'any', 'the game supports both orientations — leave it free');
  // ART §2 dark tokens (style/variables.css): splash hands off to first paint.
  assert.equal(manifest.background_color, '#0B0D10', '--ground-deep dark — what html paints');
  assert.equal(manifest.theme_color, '#15171C', '--ground dark — matches the dark theme-color meta');
});

test('start_url carries the pwa marker and collides with nothing the client reads', () => {
  const url = new URL(manifest.start_url, 'http://x');
  assert.equal(url.pathname, '/');
  assert.deepEqual([...url.searchParams.keys()], ['source']);
  // Params with client behaviour behind them; `source` must never become one
  // without this list (and the manifest) being reconsidered.
  for (const reserved of ['harness', 'room', 'mute', 'logbook']) {
    assert.ok(!url.searchParams.has(reserved), `start_url must not set ?${reserved}`);
  }
});

test('the maskable icons keep the mark inside the safe zone (inner 80% circle)', () => {
  const { PNG } = require('pngjs');
  for (const name of ['icon-maskable-192.png', 'icon-maskable-512.png']) {
    const file = `public/icons/${name}`;
    assert.ok(existsSync(file), `${file} missing — run node tools/genicons.mjs`);
    const png = PNG.sync.read(readFileSync(file));
    const size = png.width;
    const c = (size - 1) / 2;
    const safe = 0.4 * size;                    // Android guarantees the centred 80%-diameter circle
    let worst = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        // ground is --card-back #14161A; anything else is the mark (incl. AA edges)
        if (png.data[i] === 0x14 && png.data[i + 1] === 0x16 && png.data[i + 2] === 0x1a) continue;
        const r = Math.hypot(x - c, y - c);
        if (r > worst) worst = r;
      }
    }
    assert.ok(worst <= safe,
      `${name}: mark pixels reach r=${worst.toFixed(1)}px, past the ${safe}px safe radius`);
  }
});

test('the shell declares the installed-app metas the platforms still read', () => {
  // 2026 posture: display comes from the manifest; the two -capable metas are
  // legacy but load-bearing on iOS (startup image / older WebKit) and harmless
  // beside it. Chrome's deprecation is of apple-* in favour of the unprefixed.
  assert.match(html, /<meta name="mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/);
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="\/icons\/icon-180\.png\?v=/);
  assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover/);
});

test('no service worker — a caching SW is a stale-build landmine for a live-socket game', () => {
  // Installability has not required one since Chrome 121 / Edge (2024), and iOS
  // never did. If this fails, someone added one: it must be the minimal
  // passthrough and this test must be updated WITH the reason.
  assert.doesNotMatch(html, /serviceWorker/);
  assert.doesNotMatch(mainjs, /serviceWorker/);
  assert.ok(!existsSync('public/sw.js') && !existsSync('public/service-worker.js'));
});

test('main.js detects standalone display and stages it for the harness', () => {
  assert.match(mainjs, /display-mode: standalone/);
  assert.match(mainjs, /navigator\.standalone/, 'iOS pre-manifest signal');
  assert.match(mainjs, /classList\.toggle\('is-pwa'/);
  assert.match(mainjs, /bridge\.setPWA/, '§9 additive staging hook');
});
