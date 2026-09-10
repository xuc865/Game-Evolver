#!/usr/bin/env node
/**
 * tools/checkAssets.mjs — §0.3 gate: no external binary assets outside a NAMED,
 * NARROW allowlist.
 *
 * Four passes, because "no .png in the repo" is the easy half:
 *   1. banned file EXTENSIONS anywhere in the tree
 *   2. MAGIC BYTES — a PNG named `card-back.txt` is still a PNG
 *   3. base64 binary DATA URIs inside source text — smuggling a sprite sheet
 *      into a JS string is exactly the failure mode §0.3 exists to stop.
 *      Inline SVG (as text, or `data:image/svg+xml,…`) stays legal per §0.3.
 *   4. the ALLOWLIST'S OWN LIMITS — count, and nothing sneaking in beside it
 *
 * ── THE ALLOWLIST (§0.3, amended 2026-08-07) ───────────────────────────────
 * Two amendments landed on the same day and each one names an exact directory
 * and an exact extension. Nothing else in the repo may be binary, and that is
 * the whole reason this gate stayed a gate instead of becoming a preference:
 *
 *   public/fonts/*.woff2   self-hosted webfonts. Amendment (b): a font
 *                          generated in code is just a worse font, and
 *                          self-hosting is what finally makes screenshot.mjs
 *                          machine-independent.
 *   public/audio/*.opus    recorded MUSIC, at most SIX tracks (one lobby, two
 *                          match, one Final Approach, and a victory/defeat
 *                          pair). The count is part of the amendment, not a rule
 *                          of thumb: a 3-minute bed is ~1.5MB against a 381KB
 *                          gzipped client, so one more BED is another whole
 *                          game's worth of payload. The cap moved four → six on
 *                          2026-08-07 (c) for the endgame pair specifically,
 *                          which is cheap in a way the beds are not — 40s
 *                          rather than 3 minutes, 322KB + 317KB against 1.5MB
 *                          each. It is checked below.
 *
 * What is NOT licensed: every sound EFFECT stays procedural (a synthesised
 * click fires at zero latency and jitters per call, which is what stops a cue
 * heard 400× a match from becoming a woodpecker — samples would ship the SAME
 * click 400 times), and the CHUDOPOLY wordmark stays hand-authored geometry.
 * Neither is expressible as a file-extension rule, so neither is checked here;
 * both are checked by reading the diff.
 *
 * Exits 1 listing offenders. Never 2 — this gate has nothing to wait for.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, green, red, yellow, dim, bold, EXIT_FAIL, EXIT_PASS } from './lib/harness.mjs';

const BANNED_EXT = new RegExp(
  '\\.(png|jpe?g|gif|webp|bmp|tiff?|ico|tga|psd|avif|heic' +
  '|svg' +                                   // an .svg FILE is an asset; inline SVG text is not
  '|mp3|wav|ogg|oga|m4a|aac|flac|opus|aiff?|mid|midi' +
  '|woff2?|ttf|otf|eot' +
  '|glb|gltf|fbx|obj|dae|blend|usdz' +
  '|mp4|webm|mov|avi|mkv' +
  '|zip|gz|tgz|7z|rar|pdf|wasm|dll|so|dylib|exe)$',
  'i'
);

/**
 * The allowlist, as (directory, extension, cap) triples. A file passes only if
 * its directory is EXACTLY the named one — `public/audio/beds/x.opus` is not
 * `public/audio/x.opus` and does not pass — and its extension matches. `cap` is
 * the maximum number of files that directory may hold; null is uncapped.
 *
 * Written as path segments rather than a regex so a `..` or a nested directory
 * cannot satisfy it by accident.
 */
const ALLOW = [
  { dir: ['public', 'fonts'], ext: '.woff2', cap: null, why: '§0.3 amendment (b): self-hosted webfonts' },
  { dir: ['public', 'audio'], ext: '.opus', cap: 8, why: '§0.3 amendment (e): recorded music, at most eight tracks — lobby, four match beds, final approach, victory, defeat' },
  // The cap is the SET: 32 tab fallback, 180 apple-touch, 192/512 any-purpose,
  // 192/512 maskable. Every byte is rendered by tools/genicons.mjs from
  // server/icon.js's hand-authored geometry, and test/pwa.test.js fails if the
  // committed files differ from a fresh render — this gate holds the count and
  // the location, that one holds the provenance.
  { dir: ['public', 'icons'], ext: '.png', cap: 6, why: '§0.3 amendment (f): PWA install icons, rendered by tools/genicons.mjs' },
];

function allowedFor(rel) {
  const parts = rel.split(path.sep);
  const dir = parts.slice(0, -1);
  const name = parts[parts.length - 1];
  for (const a of ALLOW) {
    if (dir.length !== a.dir.length) continue;
    if (!a.dir.every((seg, i) => dir[i] === seg)) continue;
    if (!name.toLowerCase().endsWith(a.ext)) continue;
    return a;
  }
  return null;
}

/**
 * `.claude` holds agent git WORKTREES (gitignored). A worktree is a second full
 * checkout, so walking it scanned public/audio twice and reported every generated
 * PNG in its tools/shots as an offence — SKIP_REL matches on a path relative to the
 * repo root, so `tools/shots` never matched `.claude/worktrees/x/tools/shots`. One
 * agent worktree present was enough to fail this gate on an otherwise clean tree.
 *
 * `docs` is required by ARCHITECTURE §0.3 amendment (d) 2026-08-07, verbatim: brand
 * assets for the README are permitted there and checkAssets "must not be relaxed to
 * cover docs/ — it should simply not scan there." Note the distinction the amendment
 * draws and this fix preserves: docs/ is SKIPPED, not ALLOWLISTED. Nothing under
 * public/ is loosened, so a binary that reaches a player still fails.
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.github', 'coverage', '.vscode', '.idea', '.claude', 'docs',
]);
/** tools/shots/ holds GENERATED review screenshots — output, not source assets. Gitignored. */
const SKIP_REL = new Set([
  path.join('tools', 'shots'),
  path.join('tools', 'out'),
]);

/** [label, byte signature, offset] — offset 0 unless noted. */
const MAGIC = [
  ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0],
  ['JPEG', [0xff, 0xd8, 0xff], 0],
  ['GIF', [0x47, 0x49, 0x46, 0x38], 0],
  ['BMP', [0x42, 0x4d], 0],
  ['RIFF (wav/webp/avi)', [0x52, 0x49, 0x46, 0x46], 0],
  ['OGG', [0x4f, 0x67, 0x67, 0x53], 0],
  ['MP3 (ID3)', [0x49, 0x44, 0x33], 0],
  ['FLAC', [0x66, 0x4c, 0x61, 0x43], 0],
  ['WOFF', [0x77, 0x4f, 0x46, 0x46], 0],
  ['WOFF2', [0x77, 0x4f, 0x46, 0x32], 0],
  ['TrueType', [0x00, 0x01, 0x00, 0x00, 0x00], 0],
  ['OpenType', [0x4f, 0x54, 0x54, 0x4f], 0],
  ['glTF binary', [0x67, 0x6c, 0x54, 0x46], 0],
  ['ZIP/OOXML', [0x50, 0x4b, 0x03, 0x04], 0],
  ['gzip', [0x1f, 0x8b], 0],
  ['WebAssembly', [0x00, 0x61, 0x73, 0x6d], 0],
  ['PDF', [0x25, 0x50, 0x44, 0x46], 0],
  ['Mach-O', [0xcf, 0xfa, 0xed, 0xfe], 0],
  ['ftyp (mp4/mov/heic)', [0x66, 0x74, 0x79, 0x70], 4],
];

/**
 * Built from parts so this scanner does not flag its own source. (It scans the
 * whole repo including tools/; a literal pattern here would be a permanent
 * false positive that everyone would learn to ignore.)
 */
const DATA_URI = new RegExp(
  'data:' + '(image\\/(?!svg)[a-z0-9.+-]+|audio\\/[a-z0-9.+-]+|video\\/[a-z0-9.+-]+' +
  '|font\\/[a-z0-9.+-]+|application\\/(font|octet-stream|wasm)[a-z0-9.+-]*)' +
  ';base64,',
  'i'
);
const TEXT_EXT = /\.(js|mjs|cjs|ts|jsx|tsx|css|html?|json|md|txt|svg)$/i;
const SELF = path.join('tools', 'checkAssets.mjs');

const extHits = [];
const magicHits = [];
const uriHits = [];
const capHits = [];
const allowed = new Map();              // allowlist entry → [rel, …]
let scanned = 0;

function magicOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    if (n < 4) return null;
    for (const [label, sig, off] of MAGIC) {
      if (off + sig.length > n) continue;
      let ok = true;
      for (let i = 0; i < sig.length; i++) {
        if (buf[off + i] !== sig[i]) { ok = false; break; }
      }
      if (ok) return label;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(ROOT, full);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name) || SKIP_REL.has(rel)) continue;
      walk(full);
      continue;
    }
    if (!ent.isFile()) continue;
    scanned++;

    const allow = allowedFor(rel);
    if (allow) {
      let list = allowed.get(allow);
      if (!list) { list = []; allowed.set(allow, list); }
      list.push(rel);
      continue;
    }

    if (BANNED_EXT.test(ent.name)) {
      extHits.push(rel);
      continue; // one offence per file is enough to fail
    }
    const magic = magicOf(full);
    if (magic) {
      magicHits.push(`${rel} ${dim(`(${magic} bytes under a non-asset name)`)}`);
      continue;
    }
    if (rel !== SELF && TEXT_EXT.test(ent.name)) {
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const m = DATA_URI.exec(text);
      if (m) {
        const line = text.slice(0, m.index).split('\n').length;
        uriHits.push(`${rel}:${line} ${dim(m[0])}`);
      }
    }
  }
}

console.log(bold('checkAssets') + dim('  §0.3 zero external binary assets'));
walk(ROOT);

let code = EXIT_PASS;
const report = (label, hits) => {
  if (!hits.length) return;
  code = EXIT_FAIL;
  console.log(red(`  ✗ ${hits.length} ${label}:`));
  for (const h of hits.slice(0, 40)) console.log(red(`      ${h}`));
  if (hits.length > 40) console.log(dim(`      … ${hits.length - 40} more`));
};

/* The allowlist's own caps. §0.3's music amendment says "at most FOUR tracks"
 * and that number carries the whole payload argument, so it is enforced here
 * rather than remembered. */
for (const a of ALLOW) {
  const list = allowed.get(a) || [];
  if (a.cap != null && list.length > a.cap) {
    capHits.push(`${a.dir.join('/')}/*${a.ext}: ${list.length} files, cap ${a.cap} — ${a.why}`);
  }
}

report('banned asset file(s)', extHits);
report('binary file(s) by magic bytes', magicHits);
report('base64 binary data URI(s) in source', uriHits);
report('allowlisted directory over its cap', capHits);

if (code === EXIT_PASS) {
  console.log(`  ${green('✓')} ${scanned} files scanned, zero binary assets outside the allowlist`);
  for (const a of ALLOW) {
    const list = allowed.get(a) || [];
    const cap = a.cap == null ? '' : `/${a.cap}`;
    console.log(`  ${green('✓')} ${a.dir.join('/')}/*${a.ext}: ${list.length}${cap} ${dim(a.why)}`);
    for (const f of list) console.log(dim(`      ${f}`));
  }
  console.log(green(bold('checkAssets: PASS')));
} else {
  console.log(yellow('  every texture and every sound EFFECT must be generated in code'));
  console.log(yellow('  (CSS, inline SVG text, canvas, WebAudio); the only binaries permitted are'));
  for (const a of ALLOW) console.log(yellow(`    ${a.dir.join('/')}/*${a.ext} — ${a.why}`));
  console.log(red(bold('checkAssets: FAIL')));
}
process.exit(code);
