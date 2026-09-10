#!/usr/bin/env node
/**
 * tools/verify.mjs — the gate. §8, as extended in P7 round 1 and P8:
 *   check → test → checkAssets → checkClient → checkServer → statsfuzz → simbalance →
 *   playtest → tabaway → handoff → touchtest → screenshot → checkContrast → coverage →
 *   grayscale → audiotest
 *
 * P8 adds the two COLOUR gates. ART-DIRECTION §10's ship gate lists "grayscale
 * mid-game@desktop: is hierarchy still readable?" and "both themes ≥4.5:1 on
 * every text token" as checkboxes, and a checkbox nobody can run is a wish. Both
 * are strict, both are calibrated against builds that fail (see each tool's
 * header, and `--prove` on either one), and both were RED when they landed.
 *
 * EXIT CODE 2 IS A SKIP, NOT A PASS. It existed because P2 (the harness) landed
 * before P3 (the client): without it every tool reported red for work that had
 * simply not been written, and a real red would have been invisible in the
 * noise.
 *
 * P7: THAT WINDOW IS CLOSED. Every gate's subject now exists, so `--strict` is
 * the default — a skip is a failure unless you explicitly pass `--allow-skips`.
 * The five round-1 critics all found defects that gates had reported PASS
 * through; a silently-skipped gate is the same failure with fewer steps.
 *
 * Flags: --fast (skip playtest/simbalance/screenshot/coverage/grayscale), --allow-skips
 *        (restore the old lenient behaviour), --strict (kept as a no-op alias),
 *        --games N (simbalance sample size)
 */
import { spawn } from 'node:child_process';
import {
  ROOT, parseArgs, green, red, yellow, bold, dim,
  EXIT_PASS, EXIT_FAIL, EXIT_SKIP,
} from './lib/harness.mjs';

const args = parseArgs();
const FAST = !!args.fast;
/** Strict is the default now. --allow-skips is the escape hatch, and it is
 *  loud, because "the gate did not run" is the failure mode this whole file
 *  exists to make impossible to miss. */
const STRICT = !args['allow-skips'];

function run(cmd, cmdArgs, label) {
  return new Promise((resolve) => {
    const started = Date.now();
    console.log(bold(`\n━━ ${label} `) + dim(`${cmd} ${cmdArgs.join(' ')}`));
    const p = spawn(cmd, cmdArgs, { stdio: 'inherit', cwd: ROOT, env: process.env });
    p.on('exit', (c) => resolve({ label, code: c ?? EXIT_FAIL, secs: (Date.now() - started) / 1000 }));
  });
}

const steps = [
  ['npm', ['run', '--silent', 'check'], 'check'],
  ['npm', ['test', '--silent'], 'test'],
  ['node', ['tools/checkAssets.mjs'], 'checkAssets'],
  ['node', ['tools/checkClient.mjs'], 'checkClient'],
  // Node-only, never skips: proves the WS error handling and the ping/pong
  // heartbeat stay wired (a single anonymous frame used to end the process).
  ['node', ['tools/checkServer.mjs'], 'checkServer'],
  // Node-only, ~2s: fuzzes the logbook's `sanitize` and drives a real seeded
  // game end-to-end into the store. It runs in the inner loop because a save
  // system that throws is invisible until it happens to somebody else's phone.
  ['node', ['tools/statsfuzz.mjs', '--game'], 'statsfuzz'],
];
if (!FAST) steps.push(['node', ['tools/simbalance.mjs', '--games', String(args.games || 400)], 'simbalance']);
if (!FAST) steps.push(['node', ['tools/playtest.mjs'], 'playtest']);
// The owner tabbed out of a bot game and came back to a table nobody could move
// (server/handlers.js reclaimFromBot). It backgrounds a real page, takes the
// socket with it, and asserts both halves of coming back: the client catches up,
// and there is still a game to catch up to.
if (!FAST) steps.push(['node', ['tools/tabaway.mjs'], 'tabaway']);
// The owner started a second game and got the first one's hand back for 1.75s,
// under an outage notice for a connection they had just asked for. It plays two
// real Quick Play sessions back to back and samples every frame of the handoff:
// a defect that lasts a second and a half is invisible to a capture at a fixed
// delay, which is how this one shipped past every other gate.
if (!FAST) steps.push(['node', ['tools/handoff.mjs'], 'handoff']);
steps.push(['node', ['tools/touchtest.mjs'], 'touchtest']);
/* DIRECT MANIPULATION ON YOUR OWN BOARD. Two defects reported in live play were
 * unreachable by every gate above: a `myColor` answer on a full mat dispatched
 * §3.5's swap with no confirming step, and a card dragged OUT OF A MAT painted
 * underneath the cards it crossed. touchtest and screenshot both drag a HAND
 * card, which is measurably clean — the stacking bug needs a card whose ancestor
 * is a `.propcol`, and the swap needs a deadlocked board no recorded fixture
 * contains. It builds its boards through engine calls (§0.7) and drives real
 * CDP input. In the inner loop: it is 25s and it defends a gesture the owner
 * uses on every turn. */
steps.push(['node', ['tools/dragtest.mjs'], 'dragtest']);
// The review set is now gated on its own honesty (duplicate shots, undriven
// client modes, clipped text, theme pairs that come out identical) — not on
// pixels, which §8 still forbids.
if (!FAST) steps.push(['node', ['tools/screenshot.mjs'], 'screenshot']);
// §0.9 / ART §10, both themes. Runs in the inner loop too: a contrast
// regression is cheap to introduce and expensive to find by eye.
steps.push(['node', ['tools/checkContrast.mjs'], 'checkContrast']);
/* THE SURFACE CENSUS (P9). Pure Node, ~40ms: lib/census.mjs enumerates every
 * conditional visual state public/style/ has a rule for and public/src/ can
 * produce, and this diffs that against the sidecars touchtest, screenshot and
 * checkContrast just wrote. It goes after ALL THREE because it reports on what
 * they saw and asserts nothing on its own — and checkContrast is the only gate
 * that ever renders ART §2's `[data-theme]` override path, so running the
 * census before it reported two live theme states as never visited.
 *
 * Six surfaces reachable in ordinary play had never been rendered by any gate,
 * each found by a different agent tripping over it. That needed to become a
 * report instead of archaeology. */
if (!FAST) steps.push(['node', ['tools/coverage.mjs'], 'coverage']);
// ART §10's grayscale ship gate. Skipped by --fast only because it captures
// its own frames and wants them settled.
if (!FAST) steps.push(['node', ['tools/grayscale.mjs'], 'grayscale']);
steps.push(['node', ['tools/audiotest.mjs'], 'audiotest']);

const results = [];
for (const [cmd, a, label] of steps) results.push(await run(cmd, a, label));

console.log(bold('\n━━ verify summary'));
let failed = 0;
let skipped = 0;
for (const res of results) {
  const t = dim(`${res.secs.toFixed(1)}s`);
  if (res.code === EXIT_PASS) {
    console.log(`  ${green('✓')} ${res.label.padEnd(14)} ${t}`);
  } else if (res.code === EXIT_SKIP) {
    skipped++;
    console.log(`  ${yellow('⚠')} ${yellow(res.label.padEnd(14))} ${t} ${yellow('SKIPPED — asserted nothing')}`);
  } else {
    failed++;
    console.log(`  ${red('✗')} ${res.label.padEnd(14)} ${t} ${red(`exit ${res.code}`)}`);
  }
}

if (skipped) {
  const names = results.filter((x) => x.code === EXIT_SKIP).map((x) => x.label).join(', ');
  const paint = STRICT ? red : yellow;
  console.log('');
  console.log(paint(bold('  ⚠  ' + '─'.repeat(66))));
  console.log(paint(bold(`  ⚠  ${skipped} GATE(S) DID NOT RUN: ${names}`)));
  console.log(paint(bold('  ⚠  These assert nothing. Do not read this run as coverage.')));
  console.log(paint(bold(STRICT
    ? '  ⚠  Counted as FAILURES: every gate\'s subject exists as of P7.'
    : '  ⚠  --allow-skips is set. This run does NOT satisfy the ship gate.')));
  console.log(paint(bold('  ⚠  ' + '─'.repeat(66))));
  if (STRICT) failed += skipped;
}

if (FAST) {
  console.log(yellow(bold('\n  ⚠  --fast: simbalance, playtest, screenshot, coverage and grayscale did not run.')));
}

if (failed) {
  console.log(red(bold(`\nverify: FAIL (${failed} failing, ${skipped} skipped, ${results.length} total)`)));
  process.exit(EXIT_FAIL);
}
console.log(skipped
  ? yellow(bold(`\nverify: PASS with ${skipped} skipped gate(s) — NOT the ship gate`))
  : green(bold('\nverify: PASS')));
process.exit(EXIT_PASS);
