#!/usr/bin/env node
/**
 * tools/simhuman.mjs — the HUMAN-FACING benchmark.
 *
 * `simbalance` asks "are the five personalities inside §3's 8-60% band against EACH OTHER".
 * It cannot answer the question this project actually keeps needing, because its winrates are
 * shares of a fixed pot among bots: a change that makes a bot stronger against a PERSON is
 * invisible in it, and a change that lifts every personality at once moves nothing at all.
 *
 * That is not a hypothetical gap. Round 12b measured, on 91 production games with 21 real
 * players, that a human loses HALF as much property to payments as neutral does (34.7 cards
 * per 100 own turns against 66.1) and completes 41.2 sets per 100 turns against 29.3. It
 * implemented the cash floor three ways, priced the cost each time — +1.6 to +2.2 turns per
 * game and 4.3 points of chud's §3 headroom — and REJECTED it, on the stated grounds that the
 * cost was measurable and the benefit was not, and that shipping a measured cost for an
 * unmeasurable benefit is not a trade this project makes. The stated way to land it properly
 * was to build the missing instrument first. This is that instrument.
 *
 * WHAT IT DOES. Seats one SUBJECT personality against N-1 copies of `humanlike` — the §3.12
 * personality in bot.js whose constants are the measured behaviour of those 21 real players —
 * rotates the subject through every seat, and reports its win rate with a 95% confidence
 * interval, plus the two board-economy numbers the human corpus says separate a person from
 * this file's planners: sets completed and property cards lost to payments, per 100 own turns.
 *
 * `humanlike` is NOT in `BOT_MODES` and NOT in server/handlers.js's five-name allowlist, so
 * nothing here can seat it in a lobby and the §3 grid is unaffected. It is an instrument.
 *
 * HOW TO A/B A CANDIDATE CHANGE. Every persona accepts the `@` suffix form that bot.js's
 * `personaOf`/`holdScaleOf` already understand — `--subject neutral@0` is neutral with
 * HOLDBACK_SCALE overridden to 0 for that seat only. Run the pair and compare the intervals:
 *
 *     node tools/simhuman.mjs --subject neutral   --games 2000 --seed cand
 *     node tools/simhuman.mjs --subject neutral@0 --games 2000 --seed cand
 *
 * The same seed gives both runs the same deck order and the same RNG stream per game, so the
 * comparison is paired rather than two independent samples.
 *
 * READ THE FIDELITY CAVEAT BEFORE BELIEVING A RESULT. `humanlike` reproduces the CONDITIONAL
 * behaviour of a real player closely (breaker trigger rates, the sandbag, the shield
 * gradient, turn shape) but it does NOT reproduce a real player's STRENGTH: a human seat won
 * 42% of the paired 4-seat production games and `humanlike` wins about 25% of the same
 * lineup. So the absolute winrate this tool prints is optimistic — a real person is harder.
 * Use it to RANK changes, not to certify a difficulty target.
 *
 * Usage:
 *   node tools/simhuman.mjs [--subject neutral] [--seats 4] [--games 1200] [--seed human] [--md]
 *   node tools/simhuman.mjs --all            # every shipped personality, the §3.12 baseline
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  ROOT, parseArgs, green, red, yellow, dim, bold,
  EXIT_PASS, EXIT_FAIL, EXIT_SKIP,
} from './lib/harness.mjs';

const args = parseArgs();
const totalGames = Number(args.games || 1200);
const seed = String(args.seed || 'human');
const seats = Math.max(2, Number(args.seats || 4));
const wantMd = !!args.md;
const wantAll = !!args.all;

const OPPONENT = 'humanlike';

const require = createRequire(import.meta.url);

let sim, Bot;
try {
  sim = require(path.join(ROOT, 'simulate.js'));
  Bot = require(path.join(ROOT, 'bot.js'));
} catch (e) {
  console.log(bold('simhuman'));
  console.log(yellow(bold('  PENDING ENGINE')) + ` — could not load: ${e.message}`);
  process.exit(EXIT_SKIP);
}

if (typeof sim.runMatches !== 'function') {
  console.log(bold('simhuman'));
  console.log(yellow(bold('  PENDING ENGINE')) +
    ' — simulate.js does not export runMatches({players, games, seed}) yet (§3)');
  process.exit(EXIT_SKIP);
}

// The instrument has to exist before the tool that uses it can mean anything. Without this
// check a typo'd personality would silently fall through decideBotPlay's `default` and the
// tool would cheerfully report a table of four neutrals.
if (!Bot?._internal?.BREAKER_BAR?.[OPPONENT]) {
  console.log(bold('simhuman'));
  console.log(yellow(bold('  PENDING BOT')) +
    ` — bot.js has no \`${OPPONENT}\` personality (§3.12); nothing to benchmark against`);
  process.exit(EXIT_SKIP);
}

const SHIPPED = Array.isArray(sim.BOT_MODES) && sim.BOT_MODES.length
  ? sim.BOT_MODES
  : ['random', 'conservative', 'neutral', 'aggressive', 'chud'];

const subjects = wantAll ? SHIPPED.slice() : [String(args.subject || 'neutral')];

/* A personality may be named `neutral@0`; `personaOf` strips the suffix. Only the PERSONA has
 * to be a real one — the suffix is a per-seat dial, not a name. */
const personaOf = (m) => (m.indexOf('@') < 0 ? m : m.slice(0, m.indexOf('@')));
for (const s of subjects) {
  const persona = personaOf(s);
  if (!SHIPPED.includes(persona) && persona !== OPPONENT) {
    console.log(bold('simhuman'));
    console.log(red(`  unknown subject persona "${persona}" — expected one of ${SHIPPED.join(', ')}`));
    process.exit(EXIT_FAIL);
  }
}

console.log(bold('simhuman') + dim(
  `  ${subjects.length === 1 ? subjects[0] : subjects.length + ' personalities'} vs ${seats - 1}× ` +
  `${OPPONENT}, ${seats} seats, ~${totalGames} games, seed "${seed}"`));

/* Wilson score interval — the right one for a proportion at these N, and it does not produce
 * an interval that runs below 0% or above 100% the way the normal approximation does at the
 * winrates the weak personalities post here. */
function wilson(wins, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return [Math.max(0, (centre - half) / d) * 100, Math.min(1, (centre + half) / d) * 100];
}

/* Per-seat board economy, in the same units the human corpus reports: PER 100 OWN TURNS, so
 * these are directly comparable with the production figures in BOT-STRATEGY.md round 12b
 * (human 41.2 sets and 34.7 property cards lost; neutral 29.3 and 66.1).
 *
 * runMatches does not carry them, so this runs its own loop over Bot._internal — the same
 * shape tools/botaudit.mjs uses, and for the same reason: it is a MEASUREMENT, it never
 * changes a bot decision, and it calls the same `applyBotAction` the engine does.
 *
 * Events are counted against a sequence watermark and NEVER off the end-of-game
 * `state.events`: EVENT_LOG_MAX is 400 and game.js splices it from the FRONT, so an
 * end-of-game filter silently drops every payment and every completed set from a long game's
 * early turns. That exact bug understated round 12's block rate by ~1pp before it was found.
 */
const I = Bot._internal || {};
for (const need of ['decideBotPlay', 'botRespondSync', 'findResponder', 'chooseDiscards',
  'setRng', 'applyBotAction']) {
  if (typeof I[need] !== 'function') {
    console.log(yellow(bold('  PENDING BOT')) + ` — Bot._internal.${need} is not exported`);
    process.exit(EXIT_SKIP);
  }
}
let G;
try { G = require(path.join(ROOT, 'game.js')); } catch { G = null; }

function economy(subject, games, gameSeed) {
  if (!G) return null;
  const tally = { turns: 0, sets: 0, lost: 0 };
  for (let g = 0; g < games; g++) {
    // The subject rotates through every seat here too, so the economy is not a seat artefact.
    const lineup = Array(seats).fill(OPPONENT);
    const me = 'p' + (g % seats);
    lineup[g % seats] = subject;
    const gs = `${gameSeed}:${g}`;
    I.setRng(G.makeRng('bot:' + gs));
    const state = G.createGame(
      lineup.map((m, i) => ({ id: 'p' + i, name: m.slice(0, 4) + i })),
      { seed: gs, winRule: 'finalApproach', setsToWin: 3 });
    const modeOf = (id) => lineup[Number(String(id).slice(1))];
    let lastSeq = 0, lastTurn = null, safety = 0;
    const drain = () => {
      const evs = state.events || [];
      for (let i = evs.length - 1; i >= 0; i--) {
        const e = evs[i];
        if (e.seq <= lastSeq) break;
        if (e.t === 'set_completed' && e.actor === me) tally.sets++;
        else if (e.t === 'payment' && e.from === me) {
          for (const c of (e.cards || [])) {
            if (c.type === 'property' || c.type === 'wild_property') tally.lost++;
          }
        }
      }
      if (evs.length) lastSeq = Math.max(lastSeq, evs[evs.length - 1].seq);
    };
    while (state.phase === 'playing' && safety++ < 12000) {
      drain();
      if (state.pendingAction) {
        const rid = I.findResponder(state);
        if (rid) { I.botRespondSync(state, rid, modeOf(rid)); continue; }
        state.pendingAction = null; state.turnPhase = 'play'; continue;
      }
      const cp = G.currentPlayer(state);
      if (!cp || cp.eliminated) { G.forceEndTurn(state); continue; }
      const mode = modeOf(cp.id);
      if (state.turnPhase === 'draw') { G.drawPhase(state, cp.id); continue; }
      if (state.turnCounter !== lastTurn) {
        lastTurn = state.turnCounter;
        if (cp.id === me) tally.turns++;
      }
      const action = I.decideBotPlay(state, cp.id, mode);
      if (action) {
        const res = I.applyBotAction(state, cp.id, action);
        if (res && res.error) {
          const ids = cp.hand.length > G.HAND_LIMIT
            ? I.chooseDiscards(cp, cp.hand.length - G.HAND_LIMIT, mode) : undefined;
          G.endTurn(state, cp.id, ids);
        }
        continue;
      }
      const ids = cp.hand.length > G.HAND_LIMIT
        ? I.chooseDiscards(cp, cp.hand.length - G.HAND_LIMIT, mode) : undefined;
      const r = G.endTurn(state, cp.id, ids);
      if (r && r.error) G.forceEndTurn(state);
    }
    drain();
  }
  I.setRng(null);
  if (!tally.turns) return null;
  return { sets: (tally.sets / tally.turns) * 100, lost: (tally.lost / tally.turns) * 100 };
}

const rows = [];
const started = Date.now();
let totalPlayed = 0, turnSum = 0, stalemates = 0;

for (const subject of subjects) {
  // Every seat, so seat order cannot flatter or punish the subject. runMatches seats players
  // in the order given, so rotating the lineup rotates the subject.
  const perSeat = Math.max(1, Math.round(totalGames / subjects.length / seats));
  let wins = 0, games = 0, turns = 0, stale = 0;
  const seatWinrates = [];
  for (let s = 0; s < seats; s++) {
    const lineup = Array(seats).fill(OPPONENT);
    lineup[s] = subject;
    const res = sim.runMatches({
      players: lineup, games: perSeat, seed: `${seed}-${subject}-s${s}`,
      rules: { winRule: 'finalApproach', setsToWin: 3 },
    });
    // `wins` is keyed by mode string; the subject holds exactly one seat, so its seat win
    // count is the honest numerator even when the subject IS humanlike (self-play sanity).
    wins += res.seatWins[s];
    games += res.games;
    turns += res.avgTurns * res.games;
    stale += res.stalemates;
    seatWinrates.push((res.seatWins[s] / res.games) * 100);
    process.stdout.write(dim('.'));
  }
  const pct = (wins / games) * 100;
  const [lo, hi] = wilson(wins, games);
  rows.push({ subject, pct, lo, hi, wins, games, seatWinrates });
  totalPlayed += games; turnSum += turns; stalemates += stale;
}
process.stdout.write('\n');

const fair = 100 / seats;

console.log('  ' + bold(
  'subject'.padEnd(15) + 'winrate'.padStart(8) + '95% CI'.padStart(16) +
  'games'.padStart(8) + '   vs fair share ' + fair.toFixed(1) + '%'));
for (const r of rows) {
  const skew = r.pct - fair;
  const bar = '█'.repeat(Math.max(0, Math.round(r.pct / 2)));
  const tag = skew >= 0 ? green(`+${skew.toFixed(1)}pp`) : yellow(`${skew.toFixed(1)}pp`);
  console.log('  ' + r.subject.padEnd(15) + `${r.pct.toFixed(1)}%`.padStart(8) +
    `[${r.lo.toFixed(1)}, ${r.hi.toFixed(1)}]`.padStart(16) + String(r.games).padStart(8) +
    '   ' + dim(bar) + ' ' + tag);
}

/* The two board-economy numbers the corpus says actually separate a person from a planner.
 * Reported per 100 OWN turns so they are directly comparable with the production figures
 * quoted in BOT-STRATEGY.md round 12b (human 41.2 sets / 34.7 property lost; neutral 29.3 /
 * 66.1). Measured on one representative seat rather than all of them, because the seat is
 * rotated inside the winrate loop above and the economy does not depend on seat order. */
console.log('\n  ' + bold('board economy, per 100 own turns'.padEnd(40) + 'sets'.padStart(8) + 'prop lost'.padStart(12)));
for (const r of rows) {
  const t = economy(r.subject, Math.max(40, Math.round(totalGames / subjects.length / 6)), `${seed}-econ-${r.subject}`);
  console.log('  ' + r.subject.padEnd(40) +
    (t ? t.sets.toFixed(1) : dim('—')).padStart(8) +
    (t ? t.lost.toFixed(1) : dim('—')).padStart(12));
}

console.log(dim(
  `  ${totalPlayed} games, avg ${(turnSum / (totalPlayed || 1)).toFixed(1)} turns, ` +
  `stalemates ${((stalemates / (totalPlayed || 1)) * 100).toFixed(2)}%, ` +
  `${((Date.now() - started) / 1000).toFixed(1)}s`));
console.log(dim(
  '  humanlike is a BEHAVIOURAL proxy, not a strength-matched one: a real player won 42% of '
  + 'the paired\n  4-seat production games and this proxy wins ~25% of the same lineup, so '
  + 'these winrates are\n  optimistic. Rank changes with them; do not certify a difficulty '
  + 'target with them.'));

if (wantMd) {
  console.log('\n' + dim('── README table ──'));
  console.log(`| subject | winrate vs ${seats - 1}× humanlike | 95% CI | games |`);
  console.log('|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.subject} | ${r.pct.toFixed(1)}% | ${r.lo.toFixed(1)}–${r.hi.toFixed(1)}% | ${r.games} |`);
  }
  console.log(`\nFair share ${fair.toFixed(1)}%. ${totalPlayed} games, seed \`${seed}\`, ${seats} seats.`);
}

/* This tool is a MEASUREMENT, not a gate: there is no threshold a subject can fail, because
 * nobody has established what winrate against a proxy person is the right one. It exits 0 as
 * long as it produced numbers, and 1 only if it could not. `npm run verify` should treat it
 * as reportable, the way §3 treats first-player advantage. */
process.exit(rows.length && rows.every((r) => r.games > 0) ? EXIT_PASS : EXIT_FAIL);
