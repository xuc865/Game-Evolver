#!/usr/bin/env node
// tools/replayeval.mjs — price a bot-policy change against RECORDED games.
//
// The instrument BOT-STRATEGY round 12b names as missing: simbalance is a fixed pot among
// bots ("stronger against a human" cannot appear in it) and production A/B at ~100
// games/week cannot resolve a 3-5pp effect in a season. This tool reconstructs the exact
// engine states recorded games passed through and prices a candidate policy with paired,
// seeded rollouts from those states. See docs/replayeval.md for method, validation and
// limits; tools/lib/replay.js for the machinery; test/replayeval.test.js for the gates.
//
// Usage:
//   node tools/replayeval.mjs --log logs/games.jsonl --verify
//       Reconstruction gate: every record is replayed through the real engine and must
//       reproduce its event stream and final boards exactly; seeded records are ALSO
//       replayed from bare (seed, rules, seats) as the deeper fidelity proof.
//
//   node tools/replayeval.mjs --log logs/production-games.jsonl \
//       --subject cashfloor:neutral --baseline neutral --rollouts 24
//       Price a candidate against a baseline at the human seats' real decision points.
//       baseline `recorded` (default) = one-step deviation vs what was actually played,
//       both arms continuing identically; any policy name = whole-trajectory comparison.
//
// Policies: random | conservative | neutral | aggressive | chud | humanlike | persona@scale
//           cashfloor:<mode> | nocompleter:<mode>   (evaluation-only wrappers; no bot.js change)
//
// Flags: --focus human|all|<botMode> (whose decision points; default human)
//        --at divergent|all   rollout only where the arms disagree (default) or everywhere
//        --rollouts N (default 16)   --max-points N   --min-turns N (default 5)
//        --seed S (default r14)      --json

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = require(path.join(ROOT, 'tools', 'lib', 'replay.js'));

function parseArgs(argv) {
  const args = { log: null, verify: false, subject: null, baseline: 'recorded',
    rollouts: 16, maxPoints: Infinity, seed: 'r14', json: false, at: 'divergent',
    focus: 'human', minTurns: 5 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--log') args.log = next();
    else if (a === '--verify') args.verify = true;
    else if (a === '--subject') args.subject = next();
    else if (a === '--baseline') args.baseline = next();
    else if (a === '--rollouts') args.rollouts = Number(next());
    else if (a === '--max-points') args.maxPoints = Number(next());
    else if (a === '--min-turns') args.minTurns = Number(next());
    else if (a === '--seed') args.seed = next();
    else if (a === '--at') args.at = next();
    else if (a === '--focus') args.focus = next();
    else if (a === '--json') args.json = true;
    else { console.error('unknown flag: ' + a); process.exit(2); }
  }
  if (!args.log) { console.error('required: --log <games.jsonl>'); process.exit(2); }
  return args;
}

const pct = x => (x * 100).toFixed(1) + '%';
const pp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + 'pp';

function runVerify(records, args) {
  let riggedOk = 0, seededOk = 0, seeded = 0, points = 0;
  const failures = [];
  const t0 = Date.now();
  for (const record of records) {
    try {
      const { decisions } = R.reconstruct(record, { focusSeats: null });
      riggedOk++;
      points += decisions.length;
    } catch (e) {
      failures.push({ code: record.code, ts: record.ts, kind: 'rigged', error: e.message, ctx: e.ctx });
      continue;
    }
    if (record.seed != null) {
      seeded++;
      try { R.verifySeeded(record); seededOk++; }
      catch (e) { failures.push({ code: record.code, ts: record.ts, kind: 'seeded', error: e.message, ctx: e.ctx }); }
    }
  }
  const ms = Date.now() - t0;
  const out = { records: records.length, riggedOk, seeded, seededOk, decisionPoints: points, ms, failures };
  if (args.json) { console.log(JSON.stringify(out, null, 2)); }
  else {
    console.log(`replayeval --verify over ${records.length} records (${ms}ms)`);
    console.log(`  rigged reconstruction exact: ${riggedOk}/${records.length}`
      + `  (event stream + final boards, engine-authoritative)`);
    console.log(`  seed replay exact:           ${seededOk}/${seeded} seeded records`);
    console.log(`  decision points captured:    ${points}`);
    for (const f of failures.slice(0, 10)) {
      console.log(`  FAIL ${f.kind} ${f.code} ${f.ts || ''}: ${f.error}`);
    }
    if (failures.length > 10) console.log(`  ... and ${failures.length - 10} more failures`);
  }
  process.exit(failures.length ? 1 : 0);
}

function runEvaluate(records, args) {
  const t0 = Date.now();
  const res = R.evaluate(records, {
    subject: args.subject, baseline: args.baseline, rollouts: args.rollouts,
    seed: args.seed, maxPoints: args.maxPoints, at: args.at, focus: args.focus,
  });
  const ms = Date.now() - t0;
  if (args.json) {
    const { perGame, ...rest } = res;
    console.log(JSON.stringify({ ...rest, ms }, null, 2));
    return;
  }
  console.log(`replayeval — ${res.subject} vs ${res.baseline} at recorded decision points (${ms}ms)`);
  console.log(`  games reconstructed: ${res.games} (${res.reconstructFailures} failed and were excluded)`);
  console.log(`  decision points:     ${res.points} — arms disagree at ${res.divergent} (${pct(res.divergenceRate)})`);
  console.log(`  evaluated points:    ${res.evaluated} x ${res.rollouts} paired rollouts (at=${res.at})`);
  if (res.subjectPolicyStats) console.log(`  subject wrapper triggered: ${JSON.stringify(res.subjectPolicyStats)}`);
  if (!res.evaluated) { console.log('  nothing to evaluate.'); return; }
  console.log(`  win rate in rollouts: subject ${pct(res.subjectWinRate)} `
    + `[${pct(res.subjectWilson[0])}, ${pct(res.subjectWilson[1])}], `
    + `baseline ${pct(res.baselineWinRate)} [${pct(res.baselineWilson[0])}, ${pct(res.baselineWilson[1])}]`);
  console.log(`  MEAN DELTA (subject - baseline) per evaluated point: ${pp(res.meanDelta)}`);
  console.log(`  95% CI (cluster bootstrap by game): [${pp(res.ci95[0])}, ${pp(res.ci95[1])}]`);
  console.log('');
  console.log('  Read it like simhuman: deltas under bot continuation play RANK policies;');
  console.log('  they do not certify difficulty against a live human. A CI that excludes 0');
  console.log('  is a real ordering at these states; the magnitude is a proxy.');
}

const args = parseArgs(process.argv);
const { records, skipped } = R.loadRecords(args.log, { minTurns: args.minTurns });
// stderr, so --json output stays parseable
console.error(`loaded ${records.length} reconstructable records from ${args.log} `
  + `(skipped: ${Object.entries(skipped).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`);

if (args.verify || !args.subject) runVerify(records, args);
else runEvaluate(records, args);
