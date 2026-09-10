#!/usr/bin/env node
/**
 * tools/genicons.mjs — render the PWA install icon set into public/icons/.
 * §0.3 amendment (f): these PNGs are a BUILD ARTIFACT that happens to be
 * committed, and this file is the build. The platform forces the format —
 * iOS `apple-touch-icon` and Android maskable install icons must be raster
 * files; an installed app without them renders a screenshot thumbnail.
 *
 * ONE GEOMETRY, ONE OWNER. The shapes come from server/icon.js — the same
 * hand-authored deck mark (commit 844f99e's pre-press alignment target; no
 * roundel, no insignia, 32 C.F.R. §507.9) that already draws the favicon and
 * the /icon-*.png routes. This file adds NO drawing: it asks server/icon.js
 * for pixels and writes files, so the committed set cannot drift from what
 * the server serves. server/raster.js is a pure-JS rasteriser + PNG encoder
 * (analytic rect coverage, 4×4 supersampling, zlib level 9, no timestamps,
 * no randomness), so two runs are byte-identical by construction — which
 * `--check` verifies rather than assumes.
 *
 * The insets are measurements, not taste (server/icon.js PNG_ICONS):
 *   180  inset .72  iOS ~22% corner mask cannot clip the brackets
 *   192/512  .82   full-bleed any-purpose tier
 *   maskable .56   Android guarantees only the centred 80%-diameter circle;
 *                  .56 puts the mark's corners at r=0.396·size — inside the
 *                  inner 80% safe zone with margin
 *
 * Modes:
 *   node tools/genicons.mjs           write/overwrite the set
 *   node tools/genicons.mjs --check   render in memory and byte-compare with
 *                                     disk; exits 1 on any mismatch, missing
 *                                     file, or stray file in public/icons/.
 *                                     Run by test/pwa.test.js, so `npm test`
 *                                     is the regeneration gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { ROOT, green, red, dim, bold, EXIT_FAIL, EXIT_PASS } from './lib/harness.mjs';

const require = createRequire(import.meta.url);
const icon = require(path.join(ROOT, 'server', 'icon.js'));

const OUT = path.join(ROOT, 'public', 'icons');

/**
 * filename → raster spec. Five of six come straight from server/icon.js's own
 * allowlist so an inset retuned there lands here on the next `genicons` run;
 * maskable-192 is the one size the routes never served (the manifest wants a
 * 192 maskable beside the 512) and reuses maskable-512's measured inset.
 */
function specs() {
  const P = icon.PNG_ICONS;
  return {
    'icon-32.png': P['32'],
    'icon-180.png': P['180'],
    'icon-192.png': P['192'],
    'icon-512.png': P['512'],
    'icon-maskable-192.png': { ...P['maskable-512'], size: 192 },
    'icon-maskable-512.png': P['maskable-512'],
  };
}

function render() {
  const out = new Map();
  for (const [name, { size, ...o }] of Object.entries(specs())) {
    out.set(name, icon.iconPNG(size, o));
  }
  return out;
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);

const check = process.argv.includes('--check');
const set = render();

console.log(bold('genicons') + dim(`  §0.3(f) PWA install icons — ${check ? 'verify' : 'write'} public/icons/`));

if (!check) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, buf] of set) {
    fs.writeFileSync(path.join(OUT, name), buf);
    console.log(`  ${green('✓')} ${name}  ${dim(`${buf.length}b sha256:${sha(buf)}`)}`);
  }
  console.log(green(bold('genicons: WROTE ' + set.size + ' files')));
  process.exit(EXIT_PASS);
}

const bad = [];
for (const [name, buf] of set) {
  const file = path.join(OUT, name);
  if (!fs.existsSync(file)) { bad.push(`${name}: missing — run node tools/genicons.mjs`); continue; }
  const disk = fs.readFileSync(file);
  if (!disk.equals(buf)) {
    bad.push(`${name}: differs from a fresh render (disk sha256:${sha(disk)} vs render ${sha(buf)})`);
  } else {
    console.log(`  ${green('✓')} ${name}  ${dim(`byte-identical, ${buf.length}b`)}`);
  }
}
// A file the generator did not author has no business in the generated set.
if (fs.existsSync(OUT)) {
  for (const f of fs.readdirSync(OUT)) {
    if (!set.has(f)) bad.push(`${f}: stray file in public/icons/ — the generator does not produce it`);
  }
}

if (bad.length) {
  for (const b of bad) console.log(red(`  ✗ ${b}`));
  console.log(red(bold('genicons --check: FAIL')));
  process.exit(EXIT_FAIL);
}
console.log(green(bold('genicons --check: PASS — the set regenerates byte-for-byte')));
process.exit(EXIT_PASS);
