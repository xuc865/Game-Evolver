#!/usr/bin/env node
/**
 * tools/benchstudy.mjs — price a QUICK-PLAY BENCH against the human proxy.
 *
 * simhuman answers "how strong is one personality against a table of humanlike".
 * The bench question is the inverse: ONE humanlike (standing in for the solo human)
 * against the three bots quick play actually seats (server/handlers.js quick_play:
 * [neutral, aggressive, conservative]). This tool measures the proxy's win rate
 * against candidate benches under quick play's real ruleset (default preset:
 * finalApproach / setsToWin 3), proxy seat rotated, seeds shared across benches so
 * bench-to-bench comparison is paired on deck order.
 *
 * CALIBRATION — the number that matters is the RATIO, not the rate. humanlike is a
 * behavioural clone and a poor strength clone (round 13: a real human won 42% of the
 * production lineup where humanlike wins ~25%), so the absolute rate is optimistic
 * only in level, and the projection maps the measured production anchor through the
 * proxy's relative change:
 *
 *     projected real-human rate = 46.2% (production solo, 48/104)
 *                               x (proxy rate vs candidate) / (proxy rate vs current)
 *
 * ASSUMPTION, stated: the proxy's RELATIVE response to a bench change transfers to
 * real humans (a bench that cuts the proxy's win rate by 20% cuts a human's by ~20%).
 * That holds best when the change is composition/strength of the same personalities,
 * and worst if a bench exploits a specific humanlike blind spot — which is why the
 * candidates here are made of the same shipped personas (plus @scale holdback dials
 * bot.js already understands per-seat).
 *
 * Usage:
 *   node tools/benchstudy.mjs --bench neutral,aggressive,conservative --games 2000 --seed bench14
 *   node tools/benchstudy.mjs --bench aggressive,aggressive,conservative --games 2000 --seed bench14 \
 *       --anchor 46.2 --current 33.1     # print the projection against a measured current rate
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { ROOT, parseArgs, bold, dim, EXIT_PASS, EXIT_FAIL } from './lib/harness.mjs';

const require = createRequire(import.meta.url);
const sim = require(path.join(ROOT, 'simulate.js'));

const args = parseArgs();
const bench = String(args.bench || 'neutral,aggressive,conservative').split(',').map(s => s.trim());
const totalGames = Number(args.games || 2000);
const seed = String(args.seed || 'bench14');
const anchor = args.anchor !== undefined ? Number(args.anchor) : null;
const currentRate = args.current !== undefined ? Number(args.current) : null;
const PROXY = 'humanlike';

if (bench.length !== 3) { console.error('a quick-play bench is exactly 3 bots'); process.exit(EXIT_FAIL); }

function wilson(wins, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = wins / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return [Math.max(0, (c - h) / d) * 100, Math.min(1, (c + h) / d) * 100];
}

const seats = 4;
const perSeat = Math.max(1, Math.round(totalGames / seats));
let wins = 0, games = 0, turnSum = 0, stales = 0, armings = 0, breaks = 0, contested = 0;
const started = Date.now();

// A bench entry containing ':' is an evaluation-only wrapper policy (oracle:, tuned:,
// cashfloor:, …) that simulate.js's mode-string loop cannot seat; those benches run
// through tools/lib/replay.js's playFresh loop instead. IMPORTANT for comparability:
// the two loops are the same shape but not the same rnd() consumption, so compare a
// wrapper bench ONLY against a plain bench that was ALSO run with --loop fresh.
const useFresh = bench.some(m => m.includes(':')) || args.loop === 'fresh';
const R = useFresh ? require(path.join(ROOT, 'tools', 'lib', 'replay.js')) : null;

for (let s = 0; s < seats; s++) {
  const lineup = bench.slice();
  lineup.splice(s, 0, PROXY);
  // The seed deliberately does NOT contain the bench, so every candidate bench sees the
  // SAME deck order per (seat, game index) — bench-to-bench comparison is paired.
  if (useFresh) {
    for (let g = 0; g < perSeat; g++) {
      const r = R.playFresh(lineup, `${seed}-s${s}:${g}`,
        { winRule: 'finalApproach', setsToWin: 3 });
      games++;
      turnSum += r.turns;
      if (r.winner === 'p' + s) wins++;
      if (r.endReason === 'stalemate') stales++;
    }
  } else {
    const res = sim.runMatches({
      players: lineup, games: perSeat, seed: `${seed}-s${s}`,
      // Quick play launches the default ruleset (preset chudopoly): finalApproach, 3 sets.
      rules: { winRule: 'finalApproach', setsToWin: 3, shuffleSeats: false },
    });
    wins += res.seatWins[s];
    games += res.games;
    turnSum += res.avgTurns * res.games;
    stales += res.stalemates;
    armings += res.armings || 0;
    breaks += res.breaks || 0;
    contested += res.contestedGames || 0;
  }
  process.stdout.write(dim('.'));
}
process.stdout.write('\n');

const rate = (wins / games) * 100;
const [lo, hi] = wilson(wins, games);
console.log(bold('benchstudy') + `  ${PROXY} vs [${bench.join(', ')}]`);
console.log(`  proxy winrate: ${rate.toFixed(1)}%  [${lo.toFixed(1)}, ${hi.toFixed(1)}]  ` +
  `(${wins}/${games}, fair share 25.0%)`);
console.log(dim(`  avg turns ${(turnSum / games).toFixed(1)}, stalemates ` +
  `${((stales / games) * 100).toFixed(2)}%, ${((Date.now() - started) / 1000).toFixed(1)}s`));

if (anchor !== null && currentRate !== null && currentRate > 0) {
  const mult = rate / currentRate;
  const projected = anchor * mult;
  // Crude propagated band: each bound uses its own Wilson edge over the other's point
  // estimate. Not a joint interval — stated as indicative, not exact.
  const pLo = anchor * (lo / currentRate);
  const pHi = anchor * (hi / currentRate);
  console.log(`  multiplier vs current bench (${currentRate.toFixed(1)}%): x${mult.toFixed(3)}`);
  console.log(bold(`  projected REAL-HUMAN solo winrate: ${projected.toFixed(1)}%`) +
    dim(`  (indicative band ${pLo.toFixed(1)}-${pHi.toFixed(1)}, anchor ${anchor}%,`) +
    dim(' assumes the proxy\'s relative response transfers)'));
}
// Round 7 chose the current bench partly for its final-approach dynamics (shot-down and
// contested rates); any candidate must show its numbers on the same axis.
console.log(dim(`  final approach: ${armings} armings, ${breaks} broken ` +
  `(${armings ? ((breaks / armings) * 100).toFixed(1) : '0'}%), ` +
  `${((contested / games) * 100).toFixed(1)}% of games contested`));
console.log(JSON.stringify({
  bench, rate, lo, hi, wins, games, avgTurns: turnSum / games,
  armings, breaks, shotDownPct: armings ? (breaks / armings) * 100 : 0,
  contestedPct: (contested / games) * 100,
}));
process.exit(games > 0 ? EXIT_PASS : EXIT_FAIL);
