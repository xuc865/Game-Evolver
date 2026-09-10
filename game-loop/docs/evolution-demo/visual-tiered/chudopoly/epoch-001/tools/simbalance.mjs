#!/usr/bin/env node
/**
 * tools/simbalance.mjs — §3 balance gate.
 *
 * Bound (ARCHITECTURE §3 header): in 4-player mixed games, NO bot personality
 * may win more than 60% or less than 8%. First-player advantage is measured and
 * reported (§3 asks for the number, not a threshold — a 4-player fair share is
 * 25%, and anything far off that is a finding for the engine agent, not a gate).
 *
 * Talks to simulate.js ONLY through the specced programmatic API:
 *     runMatches({ players, games, seed }) → { winrates, seatWinrates,
 *       firstPlayerWin, avgTurns, medianTurns, stalemateRate, wins, games, ... }
 * Exits 2 (PENDING ENGINE) if that export does not exist yet.
 *
 * Every personality plays every seat of every 4-subset of the roster, so a mode
 * cannot be flattered by seat order or by a lucky matchup.
 *
 * Usage: node tools/simbalance.mjs [--games 400] [--seed balance] [--md]
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  ROOT, parseArgs, green, red, yellow, dim, bold,
  EXIT_PASS, EXIT_FAIL, EXIT_SKIP,
} from './lib/harness.mjs';

const args = parseArgs();
const totalGames = Number(args.games || 400);
const seed = String(args.seed || 'balance');
const wantMd = !!args.md;

const require = createRequire(import.meta.url);

let sim;
try {
  sim = require(path.join(ROOT, 'simulate.js'));
} catch (e) {
  console.log(bold('simbalance'));
  console.log(yellow(bold('  PENDING ENGINE')) + ` — simulate.js could not be loaded: ${e.message}`);
  process.exit(EXIT_SKIP);
}

if (typeof sim.runMatches !== 'function') {
  console.log(bold('simbalance'));
  console.log(yellow(bold('  PENDING ENGINE')) +
    ' — simulate.js does not export runMatches({players, games, seed}) yet (§3)');
  process.exit(EXIT_SKIP);
}

const MODES = Array.isArray(sim.BOT_MODES) && sim.BOT_MODES.length
  ? sim.BOT_MODES
  : ['random', 'conservative', 'neutral', 'aggressive', 'chud'];

const MIN_WINRATE = 8;
const MAX_WINRATE = 60;
const SEATS = 4;

console.log(bold('simbalance') + dim(`  §3 bounds — ${MODES.length} personalities, ~${totalGames} games, seed "${seed}"`));

/* Every 4-subset (drop one mode) × every rotation of it (every seat). */
const lineups = [];
for (let drop = 0; drop < MODES.length; drop++) {
  const base = MODES.filter((_, i) => i !== drop);
  for (let r = 0; r < base.length; r++) lineups.push(base.slice(r).concat(base.slice(0, r)));
}
const perLineup = Math.max(1, Math.round(totalGames / lineups.length));

const tally = Object.fromEntries(MODES.map((m) => [m, { wins: 0, games: 0 }]));
let seat0Wins = 0, games = 0, decided = 0, turnSum = 0, stalemates = 0;
const started = Date.now();

lineups.forEach((order, i) => {
  const res = sim.runMatches({ players: order, games: perLineup, seed: `${seed}-l${i}` });
  // Lineups are 4-subsets of distinct modes, so each mode holds exactly one
  // seat per lineup and res.games is its opportunity count directly.
  for (const m of new Set(order)) {
    tally[m].wins += res.wins[m] || 0;
    tally[m].games += res.games;
  }
  seat0Wins += res.seatWins?.[0] ?? 0;
  games += res.games;
  decided += res.decided ?? res.games;
  turnSum += (res.avgTurns || 0) * res.games;
  stalemates += res.stalemates ?? 0;
  process.stdout.write(dim(i % 5 === 4 ? '.' : ''));
});
process.stdout.write('\n');

const rows = MODES.map((m) => {
  const t = tally[m];
  const pct = t.games ? (t.wins / t.games) * 100 : 0;
  return { mode: m, pct, wins: t.wins, games: t.games };
});

let code = EXIT_PASS;
console.log('  ' + bold('personality'.padEnd(15) + 'winrate'.padStart(8) + 'games'.padStart(8) + '   §3 bound 8–60%'));
for (const r of rows) {
  const bad = r.pct > MAX_WINRATE || r.pct < MIN_WINRATE;
  if (bad) code = EXIT_FAIL;
  const bar = '█'.repeat(Math.max(0, Math.round(r.pct / 2)));
  const verdict = r.pct > MAX_WINRATE ? red(` ✗ over ${MAX_WINRATE}%`)
    : r.pct < MIN_WINRATE ? red(` ✗ under ${MIN_WINRATE}%`)
    : green(' ✓');
  console.log('  ' + r.mode.padEnd(15) + `${r.pct.toFixed(1)}%`.padStart(8) + String(r.games).padStart(8) +
    '   ' + dim(bar) + verdict);
}

const firstPlayer = games ? (seat0Wins / games) * 100 : 0;
const fairShare = 100 / SEATS;
const skew = firstPlayer - fairShare;
console.log(
  `  first-player advantage: ${bold(firstPlayer.toFixed(1) + '%')} ` +
  dim(`(fair share ${fairShare.toFixed(1)}%, skew ${skew >= 0 ? '+' : ''}${skew.toFixed(1)}pp)`)
);
if (Math.abs(skew) > 8) {
  console.log(yellow(`  ! seat 1 is ${Math.abs(skew).toFixed(1)}pp off fair share — reportable under §3, not gated`));
}
console.log(dim(
  `  ${games} games, ${decided} decided, avg ${(turnSum / (games || 1)).toFixed(1)} turns, ` +
  `stalemates ${((stalemates / (games || 1)) * 100).toFixed(2)}%, ${((Date.now() - started) / 1000).toFixed(1)}s`
));

if (wantMd) {
  console.log('\n' + dim('── README table ──'));
  console.log('| personality | winrate | games |');
  console.log('|---|---|---|');
  for (const r of rows) console.log(`| ${r.mode} | ${r.pct.toFixed(1)}% | ${r.games} |`);
  console.log(`\nFirst-player advantage ${firstPlayer.toFixed(1)}% (fair share ${fairShare.toFixed(1)}%). ` +
    `${games} games, seed \`${seed}\`.`);
}

console.log(code === EXIT_PASS ? green(bold('simbalance: PASS')) : red(bold('simbalance: FAIL')));
process.exit(code);
