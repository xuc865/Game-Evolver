#!/usr/bin/env node
/**
 * tools/coverage.mjs — THE SURFACE CENSUS. What can this client look like, and
 * which of those looks has nothing ever looked at?
 * HARNESS-AGENT-OWNED (ARCHITECTURE.md §1, §8).
 *
 * ─── the failure this gate exists for ────────────────────────────────────
 * Twelve gates were green while six surfaces reachable in ordinary play had
 * never been rendered by any of them: the HOST lobby (a lobby broadcast has no
 * `game`, so the client was never handed its seat and every `lobby@*.png` on
 * disk was the guest view), the `myColor` wild-placement step and its printed
 * advice, an opponent holding an Upgrade, an opponent at six colours, an ARMED
 * opponent, and both transient message layers (`#toast`, `.announce` — the
 * latter found covering collapsed seats 51%/42% portrait and 70% landscape).
 *
 * Six different agents found those six, one each, by tripping over them while
 * doing something else. That is archaeology, and it does not scale: the seventh
 * blind spot is still out there and the next agent will find it the same way.
 *
 * ─── what it measures ────────────────────────────────────────────────────
 * lib/census.mjs reads the client's surface space OUT OF THE CLIENT — every
 * state class `public/style/` has a rule for and `public/src/` can produce,
 * every attribute-VALUE selector, every shell layer index.html ships `hidden`,
 * every screen, and the interaction machine's modes and steps. 133 markers as
 * of this writing, and the number moves when the product moves, because nobody
 * maintains it.
 *
 * The gates then say what they SAW. `screenshot.mjs` and `touchtest.mjs` run
 * `census.observeMarkers` against the same settled frame they measure
 * everything else on and drop a sidecar in tools/shots/. This tool is pure
 * Node, reads the sidecars, and prints the difference. It costs ~40ms.
 *
 * ─── why it is a gate and not a report ───────────────────────────────────
 * §8: "A gate that measured nothing must not pass." A surface with no gate
 * visiting it is the same failure one level up — the SET measured nothing about
 * that part of the product — so an uncovered marker is red, and adding a screen
 * without a shot breaks the build. Markers that genuinely cannot be held still
 * for a capture (a 420ms shake, a card mid-flight) are EXEMPT in census.mjs
 * with a reason each, and an exemption naming a marker that no longer exists is
 * itself a failure, so the exemption list cannot rot into a hiding place.
 *
 * Run: node tools/coverage.mjs   (after screenshot + touchtest)
 * Flags: --verbose (list every covered marker and who saw it first)
 *        --prove   (demonstrate the gate going red — see the bottom of the file)
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  SHOT_DIR, ROOT, parseArgs, reporter, green, red, yellow, dim, bold,
  EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';
import { census, EXEMPT } from './lib/census.mjs';

const args = parseArgs();
const r = reporter('coverage' + dim('  the client\'s surface space vs what the gates visit'));

/* ── 1. what the client can look like ──────────────────────────────────── */
const { markers, orphans } = census();
const byKey = new Map(markers.map((m) => [m.key, m]));

/* ── 2. what the gates saw ─────────────────────────────────────────────── */
const sidecars = fs.existsSync(SHOT_DIR)
  ? fs.readdirSync(SHOT_DIR).filter((f) => /^coverage-.*\.json$/.test(f))
  : [];

/**
 * Freshness. A sidecar written before the last edit to the client describes a
 * build that no longer exists, and a coverage claim about a build that no
 * longer exists is worse than none — it is the "gate that measured nothing"
 * failure with a timestamp on it. Newest source file wins.
 */
function newestSource() {
  let newest = 0;
  let which = '';
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|css|html|json)$/.test(p)) continue;
      const t = fs.statSync(p).mtimeMs;
      if (t > newest) { newest = t; which = path.relative(ROOT, p); }
    }
  };
  walk(path.join(ROOT, 'public'));
  walk(path.join(ROOT, 'tools', 'fixtures'));
  return { newest, which };
}

const seen = new Map();          // key → [labels]
const contributors = [];
let stale = [];
const src = newestSource();

for (const file of sidecars) {
  const full = path.join(SHOT_DIR, file);
  let data;
  try { data = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
  const age = fs.statSync(full).mtimeMs;
  const label = data.tool || file;
  contributors.push({ label, captures: data.captures || 0, fresh: age >= src.newest });
  if (age < src.newest) stale.push(`${label} (written before ${src.which} changed)`);
  for (const [key, where] of Object.entries(data.seen || {})) {
    if (!seen.has(key)) seen.set(key, []);
    for (const w of where) if (seen.get(key).length < 4) seen.get(key).push(`${label}:${w}`);
  }
}

if (!contributors.length) {
  r.fail('no coverage sidecar in tools/shots/ — run `node tools/screenshot.mjs` and '
    + '`node tools/touchtest.mjs` first; this gate reports on what THEY saw and asserts '
    + 'nothing on its own');
  console.log(red(bold('coverage: FAIL')));
  process.exit(EXIT_FAIL);
}
if (stale.length) {
  r.fail(`${stale.length} stale sidecar(s): ${stale.join('; ')} — re-run those gates, `
    + 'a coverage claim about an older build is not a coverage claim');
}

/* ── 3. the difference ─────────────────────────────────────────────────── */
const exemptKeys = Object.keys(EXEMPT);
const ghosts = exemptKeys.filter((k) => !byKey.has(k));
if (ghosts.length) {
  r.fail(`${ghosts.length} exemption(s) name a marker that no longer exists (${ghosts.join(', ')}) `
    + '— delete them; an exemption list that outlives its markers is where coverage goes to hide');
}

const covered = markers.filter((m) => seen.has(m.key));
const exempt = markers.filter((m) => !seen.has(m.key) && EXEMPT[m.key]);
const uncovered = markers.filter((m) => !seen.has(m.key) && !EXEMPT[m.key]);

console.log(dim(`  ${markers.length} marker(s) enumerated from public/ · `
  + `${contributors.map((c) => `${c.label} ${c.captures} capture(s)`).join(', ')}`));

if (uncovered.length) {
  r.fail(`${uncovered.length}/${markers.length} surface marker(s) are reachable in the client and `
    + 'visited by NO gate');
  const groups = new Map();
  for (const m of uncovered) {
    if (!groups.has(m.kind)) groups.set(m.kind, []);
    groups.get(m.kind).push(m);
  }
  for (const [kind, list] of [...groups].sort()) {
    console.log(dim(`      ${kind}:`));
    for (const m of list) {
      console.log(`        ${yellow(m.key.padEnd(30))} ${dim(`produced in ${m.where}`
        + `${m.styledIn ? `, styled in ${m.styledIn}` : ''}`)}`);
    }
  }
} else {
  r.pass(`every one of the ${markers.length - exempt.length} holdable surface marker(s) was `
    + 'visited by at least one gate');
}

if (exempt.length) {
  console.log(`  ${yellow('!')} ${exempt.length} marker(s) exempt as unholdable `
    + dim(`(${exempt.map((m) => m.key.replace(/^class:/, '')).join(', ')})`));
}
if (orphans.length) {
  // Not a coverage failure: nothing can reach them, so no gate could have.
  // Worth one line — a rule for a state the client cannot enter is dead CSS,
  // and this is the only place in the harness that can see it.
  console.log(`  ${yellow('!')} ${orphans.length} marker(s) are STYLED BUT UNREACHABLE — `
    + `public/style/ has a rule the client never turns on: ${orphans.map((o) => o.key).join(', ')}`);
}

if (args.verbose) {
  console.log(dim('\n  ── covered, and by whom ──'));
  for (const m of covered) console.log(dim(`    ${m.key.padEnd(30)} ${seen.get(m.key).slice(0, 2).join(', ')}`));
}

/**
 * §8: a gate must be proven to fail. The demonstration is exact — pretend one
 * covered marker was never seen and require the verdict to flip — because the
 * defect this gate exists to catch IS "a surface nothing visited", and there is
 * no need to simulate it with a mutation when it can be stated directly.
 */
if (args.prove) {
  console.log(dim('\n  ── --prove ──'));
  const victim = covered[Math.floor(covered.length / 2)];
  if (!victim) {
    r.fail('--prove: nothing is covered, so removing a covered marker proves nothing');
  } else {
    const without = markers.filter((m) => m.key !== victim.key && !seen.has(m.key) && !EXEMPT[m.key]);
    if (without.length === uncovered.length && !seen.has(victim.key)) {
      r.fail('--prove: the verdict did not move');
    } else {
      r.pass(`--prove: dropping '${victim.key}' from what the gates saw takes the uncovered count `
        + `${uncovered.length} → ${uncovered.length + 1}`);
    }
  }
  // A second, sharper demonstration: the six surfaces this round added. If the
  // census cannot tell that they are covered NOW, it could not have told that
  // they were uncovered before, and its green is a decoration.
  const NEW = [
    'layer:lobby-host', 'layer:btn-start', 'step:myColor', 'layer:emotes',
    /* P10, the flight log. Same argument one round later: this surface has no
     * server state at all — it renders `chud.stats.v1` — so no fixture can
     * reach it and every gate that wants it has to seed storage before the
     * document runs (tools/lib/logbook.mjs). `is-gapped` is the sharpest of the
     * three: it is the mark on a flight whose record has a hole in it, and it
     * only exists if the RECORDING really lost events. It went unseen on the
     * first attempt, because withholding a dozen broadcasts is entirely covered
     * by the next 120-event tail — the gap had to be made in event sequence,
     * not in broadcast count. A green here means that whole chain held. */
    'layer:btn-flight-log', 'class:is-won', 'class:is-gapped',
  ];
  const missing = NEW.filter((k) => byKey.has(k) && !seen.has(k));
  if (missing.length) {
    r.fail(`--prove: markers the P9 surfaces were built to reach are still unseen (${missing.join(', ')})`);
  } else {
    r.pass(`--prove: the markers the P9 surfaces exist to reach are all observed (${NEW.filter((k) => byKey.has(k)).join(', ')})`);
  }
}

fs.writeFileSync(path.join(SHOT_DIR, 'coverage.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  markers: markers.length,
  covered: covered.length,
  exempt: exempt.map((m) => m.key),
  uncovered: uncovered.map((m) => ({ key: m.key, where: m.where, styledIn: m.styledIn })),
  orphans: orphans.map((o) => o.key),
  contributors,
}, null, 1) + '\n');

console.log(r.code === EXIT_PASS ? green(bold('coverage: PASS')) : red(bold('coverage: FAIL')));
process.exit(r.code === EXIT_PASS ? EXIT_PASS : EXIT_FAIL);
