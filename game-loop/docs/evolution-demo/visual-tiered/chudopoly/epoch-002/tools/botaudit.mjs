#!/usr/bin/env node
/**
 * tools/botaudit.mjs — hard-breaker / final-approach telemetry.
 *
 * The committed form of the three throwaway harnesses that produced
 * `docs/bot-foresight-research.md` (breakeraudit.js, headroom.js, cushion.js).
 * They each re-implemented simulate.js's runGame loop and each ran the whole
 * lineup grid on its own, so measuring one tree cost three full sims. This runs
 * the loop ONCE per game and collects every metric off the same games, which is
 * both ~3x faster and — more importantly — makes the numbers commensurable:
 * the no-threat share and the grace-cycle cushion now describe the same games
 * rather than three differently-seeded populations.
 *
 * MEASUREMENT ONLY. It never changes a bot decision: it reads state before a
 * decision is applied and after it resolves, and calls the same
 * `Bot._internal.applyBotAction` the engine uses. It always exits 0 — this is
 * an instrument, not a gate. `tools/simbalance.mjs` is the gate.
 *
 * Same lineup grid as simbalance (every 4-subset of the five personalities x
 * every rotation, so no mode is flattered by seat order) and the same
 * `setRng(G.makeRng('bot:' + gameSeed))` per game the source scripts used.
 *
 * Usage:
 *   node tools/botaudit.mjs [--games 400] [--seed audit] [--md] [--json]
 *
 * The default seed is `audit` because that is the seed breakeraudit.js used;
 * a default run reproduces §1.1–§1.4 of the research doc exactly. The
 * grace-cycle (§4) and cushion numbers came from scripts seeded `head`/`cu`,
 * so those move by sampling noise against the published figures — same
 * population size, different games. See BASELINES below.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  ROOT, parseArgs, green, red, yellow, dim, bold, EXIT_PASS, EXIT_SKIP,
} from './lib/harness.mjs';

const args = parseArgs();
const totalGames = Number(args.games || 400);
const seed = String(args.seed || 'audit');
const maxTurns = Number(args.maxTurns || 300);
const wantMd = !!args.md;
const wantJson = !!args.json;

const require = createRequire(import.meta.url);

let G, Bot;
try {
  G = require(path.join(ROOT, 'game.js'));
  Bot = require(path.join(ROOT, 'bot.js'));
} catch (e) {
  console.log(bold('botaudit'));
  console.log(yellow(bold('  PENDING ENGINE')) + ` — game.js/bot.js could not be loaded: ${e.message}`);
  process.exit(EXIT_SKIP);
}

const I = Bot._internal || {};
for (const need of ['decideBotPlay', 'botRespondSync', 'findResponder', 'chooseDiscards',
  'setRng', 'rnd', 'unseenCounts', 'disposableValue', 'applyBotAction']) {
  if (typeof I[need] !== 'function') {
    console.log(bold('botaudit'));
    console.log(yellow(bold('  PENDING BOT')) + ` — Bot._internal.${need} is not exported`);
    process.exit(EXIT_SKIP);
  }
}
const {
  decideBotPlay, botRespondSync, findResponder, chooseDiscards, setRng,
  unseenCounts, disposableValue, applyBotAction,
} = I;
const botRnd = I.rnd;

const MODES = ['random', 'conservative', 'neutral', 'aggressive', 'chud'];

/**
 * Published figures from docs/bot-foresight-research.md, 400 games. Printed
 * beside the live numbers so a drift is visible without opening the doc. The
 * `from` column names which throwaway script produced it, because only the
 * `audit`-seeded ones are expected to match to the game.
 */
const BASELINES = [
  ['no-threat share (nobody at 2+ sets, nobody armed)', 39.5, 'breakeraudit'],
  ['armings facing no breaker in any opponent hand', 71.6, 'breakeraudit'],
  ['breaker shots eaten by OPSEC', 14.7, 'headroom'],
  ['charges at an armed player payable from loose change', 88.2, 'breakeraudit'],
  ['armed while holding OPSEC', 22.2, 'cushion'],
];

/* ── helpers ────────────────────────────────────────────────────────── */

const isBreaker = (c) => !!c && (c.action === 'inspector_general' || c.action === 'chud');
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '—');
const num = (a, b, digits = 2) => (b ? (a / b).toFixed(digits) : '0');
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const bankValue = (p) => p.bank.reduce((s, c) => s + c.value, 0);
function looseValue(p) {
  let t = 0;
  for (const [col, cards] of Object.entries(p.properties)) {
    if (G.isSetComplete(p, col)) continue;
    for (const c of cards) t += c.value;
  }
  return t;
}
function maxOppSets(state, meId) {
  let m = 0;
  for (const p of state.players) if (p.id !== meId && !p.eliminated) m = Math.max(m, G.completedSets(p));
  return m;
}
/** headroom.js's proxy for "the biggest rent this bot could print right now". */
function bestRentFor(bot) {
  let best = 0;
  for (const c of bot.hand) {
    if (c.type !== 'rent') continue;
    const cols = c.colors[0] === 'any' ? Object.keys(G.COLORS) : c.colors;
    for (const col of cols) {
      if (!(bot.properties[col] || []).length) continue;
      best = Math.max(best, G.calcRent(bot, col));
    }
  }
  return best;
}

/* ── stats ──────────────────────────────────────────────────────────── */

function newStats() {
  return {
    games: 0, turns: 0, decided: 0, pointsEndings: 0,

    // 1 — breaker spend
    fired: 0, banked: 0, discardedAtEnd: 0, heldAtEnd: 0,
    firedByMaxOppSets: [0, 0, 0, 0], firedWhileArmed: 0, firedEarly: 0,
    firedOpsecUnseen: {},                                   // 3 — unseen OPSEC at firing

    // 2 — what the shot took
    firedTookFromSet: 0, firedCompletedOurs: 0, firedOrphan: 0,

    // NEW — did the shot advance the FIRING bot's own win, or only deny?
    shotsResolved: 0, shotsLanded: 0, shotsBlocked: 0,
    shotsAdvanced: 0, shotsDeniedOnly: 0,
    shotsToWin: 0, shotsToWinMinusOne: 0, shotsAdvancedOther: 0,
    byKind: {                                               // ig vs chud, of landed shots
      inspector_general: { fired: 0, landed: 0, advanced: 0, toWin: 0 },
      chud: { fired: 0, landed: 0, advanced: 0, toWin: 0 },
    },

    // 4 — per personality
    byMode: {},

    // 5 — armings (first arming per player, the breakeraudit definition)
    armings: 0, armedWithNoBreakerInAnyHand: 0,
    breakersDeadAtArming: 0, breakersTotalAtArming: 0,
    // 9 — arming cushion
    armBank: [], armLoose: [], armTurn: [], armWithOpsec: 0,
    // event-level arming counts (headroom's definition — includes re-armings)
    armingEvents: 0, armingsBroken: 0,

    // 6 — block rate
    opsecOnBreaker: 0, opsecOnBreakerTailOnly: 0,

    // 7 — grace-cycle sampling
    samples: 0, disposable: [], maxSingleCharge: [], maxStackCharge: [],
    couldDisarmByCharge: 0, actorHadBreaker: 0, armedHeldOpsec: 0,

    // 8 — charges landing on an armed player
    chargesAtArmed: 0, chargesPayableFromChange: 0,

    // 10 — leader bank by set count
    oneSetBank: [], twoSetBank: [], twoSetSamples: 0, twoSetAttacked: 0,
  };
}

function bumpMode(S, mode, key) {
  S.byMode[mode] = S.byMode[mode] || { fired: 0, firedEarly: 0, banked: 0, advanced: 0 };
  S.byMode[mode][key]++;
}

/**
 * Events are capped at EVENT_LOG_MAX (400) in state and spliced off the front,
 * so the throwaway scripts' end-of-game `state.events.filter(...)` silently
 * undercounts any game long enough to overflow. Drained by `seq` watermark on
 * every loop iteration instead; the tail-only count is kept alongside so the
 * discrepancy against the published block rate can be shown rather than hidden.
 */
function drainEvents(state, S, ctx) {
  const evs = state.events || [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const ev = evs[i];
    if (ev.seq <= ctx.lastSeq) break;
    if (ev.t === 'final_approach') S.armingEvents++;
    else if (ev.t === 'final_approach_broken') S.armingsBroken++;
    else if (ev.t === 'opsec' && (ev.action === 'inspector_general' || ev.action === 'chud')) {
      S.opsecOnBreaker++;
      if (ctx.shot) ctx.shot.sawOpsec = true;
    }
  }
  if (evs.length) ctx.lastSeq = Math.max(ctx.lastSeq, evs[evs.length - 1].seq);
}

/**
 * A breaker is always a pending action, so whether it LANDED is only knowable
 * after the OPSEC chain settles. Resolution is by card identity (did the card
 * we aimed at end up in our zones?) rather than by counting OPSEC parity —
 * chained counters make parity fragile, card location does not.
 */
function resolveShot(state, S, ctx) {
  const shot = ctx.shot;
  if (!shot) return;
  ctx.shot = null;
  const firer = G.getPlayer(state, shot.firerId);
  if (!firer) return;
  const mine = new Set();
  for (const cards of Object.values(firer.properties)) for (const c of cards) mine.add(c.id);
  const landed = shot.stolenIds.some((id) => mine.has(id));
  const setsAfter = G.completedSets(firer);
  const kind = S.byKind[shot.kind];

  S.shotsResolved++;
  if (!landed) { S.shotsBlocked++; return; }
  S.shotsLanded++;
  if (kind) kind.landed++;

  if (setsAfter > shot.setsBefore) {
    S.shotsAdvanced++;
    bumpMode(S, shot.mode, 'advanced');
    if (kind) kind.advanced++;
    if (setsAfter >= shot.setsToWin) { S.shotsToWin++; if (kind) kind.toWin++; }
    else if (setsAfter === shot.setsToWin - 1) S.shotsToWinMinusOne++;
    else S.shotsAdvancedOther++;
  } else {
    S.shotsDeniedOnly++;
  }
}

/* ── the loop (one copy, all metrics) ───────────────────────────────── */

function runGame(configs, gameSeed, S) {
  const players = configs.map((cfg, i) => ({ id: 'p' + i, name: cfg.name, isBot: true, botMode: cfg.mode }));
  const state = G.createGame(players.map((p) => ({ id: p.id, name: p.name })), { seed: gameSeed });
  const modeOf = (id) => players.find((p) => p.id === id).botMode;
  const setsToWin = G.setsToWinOf(state);

  const ctx = { lastSeq: 0, shot: null };
  const armedSeen = new Set();
  let turnNum = 0, lastTurn = null, safety = 0;
  const MAX_IT = maxTurns * 20;

  while (state.phase === 'playing' && safety < MAX_IT) {
    safety++;
    drainEvents(state, S, ctx);

    if (state.pendingAction) {
      const rid = findResponder(state);
      if (rid) { botRespondSync(state, rid, modeOf(rid)); continue; }
      state.pendingAction = null; state.turnPhase = 'play'; continue;
    }
    if (ctx.shot) resolveShot(state, S, ctx);

    const cp = G.currentPlayer(state);
    if (cp.eliminated) { G.advanceToNextActive(state); continue; }
    const mode = modeOf(cp.id);

    /* ── turn-start sampling ── */
    if (state.turnCounter !== lastTurn) {
      lastTurn = state.turnCounter;
      turnNum++;

      // 5 + 9 — the first turn start at which each player is seen armed.
      for (const p of state.players) {
        if (!p.finalApproach || p.eliminated || armedSeen.has(p.id)) continue;
        armedSeen.add(p.id);
        S.armings++;
        S.armBank.push(bankValue(p));
        S.armLoose.push(looseValue(p));
        S.armTurn.push(turnNum);
        if (p.hand.some((c) => c.action === 'opsec')) S.armWithOpsec++;
        const deck = (state.rules && state.rules.deck) || G.DECK_BASE;
        const total = deck.inspector_general + deck.chud;
        let inHands = 0, dead = 0;
        for (const q of state.players) {
          for (const c of q.hand) if (isBreaker(c) && q.id !== p.id) inHands++;
          for (const c of q.bank) if (isBreaker(c)) dead++;
        }
        for (const c of state.discardPile) if (isBreaker(c)) dead++;
        S.breakersDeadAtArming += dead;
        S.breakersTotalAtArming += total;
        if (inHands === 0) S.armedWithNoBreakerInAnyHand++;
      }

      // 7 — grace-cycle sample: an OPPONENT's turn start while somebody is armed.
      const armed = state.players.filter((p) => p.finalApproach && !p.eliminated && p.id !== cp.id);
      if (armed.length) {
        const v = armed[0];
        const disp = disposableValue(v);
        S.samples++;
        S.disposable.push(disp);
        const rent = bestRentFor(cp);
        const fin = cp.hand.some((c) => c.action === 'finance_office') ? 5 : 0;
        const roll = cp.hand.some((c) => c.action === 'roll_call') ? 2 : 0;
        const surge = cp.hand.some((c) => c.action === 'surge_ops');
        const single = Math.max(rent * (surge ? 2 : 1), fin, roll);
        const stack = [rent * (surge ? 2 : 1), fin, roll].reduce((a, b) => a + b, 0);
        S.maxSingleCharge.push(single);
        S.maxStackCharge.push(stack);
        if (stack > disp) S.couldDisarmByCharge++;
        if (cp.hand.some(isBreaker)) S.actorHadBreaker++;
        if (v.hand.some((c) => c.action === 'opsec')) S.armedHeldOpsec++;
      }

      // 10 — what a leader's bank looks like at 1 and at 2 sets.
      for (const p of state.players) {
        if (p.eliminated || p.id === cp.id) continue;
        const s = G.completedSets(p);
        if (s === 2) { S.twoSetSamples++; S.twoSetBank.push(bankValue(p)); }
        else if (s === 1) S.oneSetBank.push(bankValue(p));
      }

      if (turnNum > maxTurns) break;
    }

    if (state.turnPhase !== 'play') break;

    // chud's early bail-out, exactly as simulate.js/the source scripts model it.
    if (mode === 'chud' && state.playsRemaining > 0 && state.playsRemaining < 3 && botRnd() < 0.2) {
      const b = G.getPlayer(state, cp.id);
      G.endTurn(state, cp.id, b.hand.length > 7 ? chooseDiscards(b, b.hand.length - 7, mode) : undefined);
      continue;
    }

    const action = decideBotPlay(state, cp.id, mode);
    if (!action) {
      const b = G.getPlayer(state, cp.id);
      const r = G.endTurn(state, cp.id, b.hand.length > 7 ? chooseDiscards(b, b.hand.length - 7, mode) : undefined);
      if (r.error) G.forceEndTurn(state);
      continue;
    }

    /* ── observe the decision BEFORE applying it ── */
    const bot = G.getPlayer(state, cp.id);
    const card = bot.hand[action.cardIndex];
    const breaker = isBreaker(card);
    let pre = null;
    if (breaker && action.type === 'play_action') {
      const tgt = action.targetId ? G.getPlayer(state, action.targetId) : null;
      pre = {
        mx: maxOppSets(state, cp.id),
        armed: state.players.some((p) => p.id !== cp.id && p.finalApproach && !p.eliminated),
        opsecUnseen: unseenCounts(state, bot).opsec,
        fromSet: false,
        myNeed: false,
        kind: card.action,
        setsBefore: G.completedSets(bot),
        stolenIds: [],
      };
      if (tgt && action.targetColor) {
        pre.fromSet = G.isSetComplete(tgt, action.targetColor);
        pre.stolenIds = (tgt.properties[action.targetColor] || []).map((c) => c.id);
      }
      if (tgt && action.targetCardId) {
        for (const [col, cards] of Object.entries(tgt.properties)) {
          if (!cards.some((c) => c.id === action.targetCardId)) continue;
          pre.fromSet = G.isSetComplete(tgt, col);
          const info = G.COLORS[col];
          if (info && (bot.properties[col] || []).length === info.size - 1) pre.myNeed = true;
        }
        pre.stolenIds = [action.targetCardId];
      }
    }
    if (breaker && action.type === 'play_money') { S.banked++; bumpMode(S, mode, 'banked'); }

    const result = applyBotAction(state, cp.id, action);

    /* ── observe the outcome ── */
    if (result?.ok && action.type === 'play_action' && action.targetId) {
      const tgt = G.getPlayer(state, action.targetId);
      if (tgt?.finalApproach && state.pendingAction?.amount) {
        S.chargesAtArmed++;
        if (state.pendingAction.amount <= disposableValue(tgt)) S.chargesPayableFromChange++;
      }
      if (tgt && G.completedSets(tgt) >= 2) S.twoSetAttacked++;
    }

    if (pre && result?.ok) {
      S.fired++;
      bumpMode(S, mode, 'fired');
      if (S.byKind[pre.kind]) S.byKind[pre.kind].fired++;
      S.firedByMaxOppSets[Math.min(3, pre.mx)]++;
      if (pre.armed) S.firedWhileArmed++;
      if (pre.mx < 2 && !pre.armed) { S.firedEarly++; bumpMode(S, mode, 'firedEarly'); }
      S.firedOpsecUnseen[pre.opsecUnseen] = (S.firedOpsecUnseen[pre.opsecUnseen] || 0) + 1;
      if (pre.fromSet) S.firedTookFromSet++;
      if (pre.myNeed) S.firedCompletedOurs++;
      if (!pre.fromSet && !pre.myNeed) S.firedOrphan++;
      ctx.shot = { ...pre, firerId: cp.id, mode, setsToWin, sawOpsec: false };
      if (!state.pendingAction) resolveShot(state, S, ctx);
    }

    if (result?.error) {
      const b2 = G.getPlayer(state, cp.id);
      G.endTurn(state, cp.id, b2.hand.length > 7 ? chooseDiscards(b2, b2.hand.length - 7, mode) : undefined);
    }
    if (state.phase === 'finished') break;
  }

  drainEvents(state, S, ctx);
  if (ctx.shot) resolveShot(state, S, ctx);

  S.games++;
  S.turns += turnNum;
  if (state.winner) S.decided++; else S.pointsEndings++;
  for (const c of state.discardPile) if (isBreaker(c)) S.discardedAtEnd++;
  for (const p of state.players) for (const c of p.hand) if (isBreaker(c)) S.heldAtEnd++;
  // What the throwaway scripts saw: an end-of-game filter over a capped log.
  S.opsecOnBreakerTailOnly += (state.events || [])
    .filter((e) => e.t === 'opsec' && (e.action === 'inspector_general' || e.action === 'chud')).length;
}

/* ── drive the grid ─────────────────────────────────────────────────── */

const lineups = [];
for (let drop = 0; drop < MODES.length; drop++) {
  const base = MODES.filter((_, i) => i !== drop);
  for (let r = 0; r < base.length; r++) lineups.push(base.slice(r).concat(base.slice(0, r)));
}
const perLineup = Math.max(1, Math.round(totalGames / lineups.length));

console.log(bold('botaudit') + dim(`  breaker + final-approach telemetry — ${lineups.length} lineups x ${perLineup} games, seed "${seed}"`));

const S = newStats();
const started = Date.now();
lineups.forEach((order, li) => {
  const configs = order.map((m, i) => ({ name: m.slice(0, 4) + i, mode: m }));
  for (let g = 0; g < perLineup; g++) {
    const gs = `${seed}-l${li}:${g}`;
    setRng(G.makeRng('bot:' + gs));
    runGame(configs, gs, S);
  }
  process.stdout.write(dim(li % 5 === 4 ? '.' : ''));
});
setRng(null);
process.stdout.write('\n');

/* ── report ─────────────────────────────────────────────────────────── */

const spends = S.fired + S.banked;
const noThreatShare = S.fired ? 100 * S.firedEarly / S.fired : 0;
const noBreakerShare = S.armings ? 100 * S.armedWithNoBreakerInAnyHand / S.armings : 0;
const blockRate = S.fired ? 100 * S.opsecOnBreaker / S.fired : 0;
const blockRateTail = S.fired ? 100 * S.opsecOnBreakerTailOnly / S.fired : 0;
const payableShare = S.chargesAtArmed ? 100 * S.chargesPayableFromChange / S.chargesAtArmed : 0;
const armOpsecShare = S.armings ? 100 * S.armWithOpsec / S.armings : 0;

console.log(dim(`  ${S.games} games, avg ${num(S.turns, S.games, 1)} turns, ` +
  `decided ${pct(S.decided, S.games)}, points-endings ${pct(S.pointsEndings, S.games)}, ` +
  `${((Date.now() - started) / 1000).toFixed(1)}s`));

console.log('\n' + bold('HARD BREAKERS (Inspector General + THE CHUD CARD)'));
console.log(`  fired as actions : ${S.fired}  (${num(S.fired, S.games)}/game)`);
console.log(`  banked as money  : ${S.banked}  (${pct(S.banked, spends)} of all spends)`);
console.log(dim(`  in discard @end : ${S.discardedAtEnd}     held in hand @end: ${S.heldAtEnd}`));

console.log('\n  ' + bold('WHEN fired, by best opponent set count at that instant:'));
[0, 1, 2, 3].forEach((i) => console.log(
  `    ${i === 3 ? '3+' : ' ' + i} sets : ${String(S.firedByMaxOppSets[i]).padStart(5)}  ${pct(S.firedByMaxOppSets[i], S.fired).padStart(6)}`));
console.log(`    ${bold('nobody at 2+ sets and nobody armed')} : ${String(S.firedEarly).padStart(5)}  ${bold(pct(S.firedEarly, S.fired))}`);
console.log(`    an opponent was ARMED               : ${String(S.firedWhileArmed).padStart(5)}  ${pct(S.firedWhileArmed, S.fired)}`);

console.log('\n  ' + bold('WHAT the shot took:'));
console.log(`    out of a complete set : ${String(S.firedTookFromSet).padStart(5)}  ${pct(S.firedTookFromSet, S.fired).padStart(6)}`);
console.log(`    completed one of ours : ${String(S.firedCompletedOurs).padStart(5)}  ${pct(S.firedCompletedOurs, S.fired).padStart(6)}`);
console.log(`    neither (orphan grab) : ${String(S.firedOrphan).padStart(5)}  ${pct(S.firedOrphan, S.fired).padStart(6)}`);

console.log('\n  ' + bold('DID THE SHOT WIN US ANYTHING?') + dim(' — resolved by card location, after the OPSEC chain'));
console.log(`    landed                       : ${String(S.shotsLanded).padStart(5)}  ${pct(S.shotsLanded, S.shotsResolved).padStart(6)}`);
console.log(`    blocked                      : ${String(S.shotsBlocked).padStart(5)}  ${pct(S.shotsBlocked, S.shotsResolved).padStart(6)}`);
console.log(`    ${bold('advanced our own set count')}   : ${String(S.shotsAdvanced).padStart(5)}  ${bold(pct(S.shotsAdvanced, S.shotsLanded).padStart(6))} of landed`);
console.log(`      ...to setsToWin (won/armed): ${String(S.shotsToWin).padStart(5)}  ${pct(S.shotsToWin, S.shotsLanded).padStart(6)} of landed`);
console.log(`      ...to setsToWin - 1        : ${String(S.shotsToWinMinusOne).padStart(5)}  ${pct(S.shotsToWinMinusOne, S.shotsLanded).padStart(6)} of landed`);
console.log(`      ...other advance           : ${String(S.shotsAdvancedOther).padStart(5)}  ${pct(S.shotsAdvancedOther, S.shotsLanded).padStart(6)} of landed`);
console.log(`    ${bold('only denied (no set gained)')}  : ${String(S.shotsDeniedOnly).padStart(5)}  ${bold(pct(S.shotsDeniedOnly, S.shotsLanded).padStart(6))} of landed`);
for (const k of ['inspector_general', 'chud']) {
  const b = S.byKind[k];
  console.log(dim(`      ${k.padEnd(18)} fired ${String(b.fired).padStart(4)}  landed ${String(b.landed).padStart(4)}  ` +
    `advanced ${String(b.advanced).padStart(4)} ${pct(b.advanced, b.landed)}  to-win ${b.toWin}`));
}

console.log('\n  ' + bold('OPSEC unseen at the moment of firing:'));
Object.keys(S.firedOpsecUnseen).sort().forEach((k) => console.log(
  `    ${k} unseen : ${String(S.firedOpsecUnseen[k]).padStart(5)}  ${pct(S.firedOpsecUnseen[k], S.fired).padStart(6)}`));
console.log(`  breaker shots eaten by an OPSEC : ${S.opsecOnBreaker}  ${bold(blockRate.toFixed(1) + '%')}`);
if (S.opsecOnBreakerTailOnly !== S.opsecOnBreaker) {
  console.log(yellow(`  ! end-of-game event tail only sees ${S.opsecOnBreakerTailOnly} (${blockRateTail.toFixed(1)}%) — ` +
    `state.events is capped at 400, which is how the throwaway scripts counted`));
}

console.log('\n' + bold('PER PERSONALITY') + dim('  (breakers fired / at a no-threat table / banked / shot advanced us)'));
for (const m of MODES) {
  const b = S.byMode[m] || { fired: 0, firedEarly: 0, banked: 0, advanced: 0 };
  console.log(`  ${m.padEnd(13)} fired ${String(b.fired).padStart(4)}   no-threat ${String(b.firedEarly).padStart(4)} ` +
    `${pct(b.firedEarly, b.fired).padStart(6)}   banked ${String(b.banked).padStart(3)}   advanced ${String(b.advanced).padStart(4)}`);
}

console.log('\n' + bold(`ARMINGS: ${S.armings} first-armings, ${S.armingEvents} arming events, ` +
  `${S.armingsBroken} broken (${pct(S.armingsBroken, S.armingEvents)} of events)`));
console.log(`  hard breakers already DEAD (bank+discard) at arming : ` +
  `${num(S.breakersDeadAtArming, S.armings)} of ${num(S.breakersTotalAtArming, S.armings)}`);
console.log(`  armings where NO opponent held a breaker in hand    : ${S.armedWithNoBreakerInAnyHand}  ${bold(noBreakerShare.toFixed(1) + '%')}`);
console.log(`  at the moment of arming — bank median ${median(S.armBank)}M mean ${mean(S.armBank).toFixed(1)}M | ` +
  `loose property median ${median(S.armLoose)}M mean ${mean(S.armLoose).toFixed(1)}M`);
console.log(`  armed while holding an OPSEC : ${S.armWithOpsec}  ${bold(armOpsecShare.toFixed(1) + '%')}` +
  dim(`   (mean arming turn ${mean(S.armTurn).toFixed(1)})`));

console.log('\n' + bold(`GRACE CYCLE — sampled at every opponent turn start while somebody is armed: ${S.samples}`));
console.log(`  armed player's disposable value : median ${bold(median(S.disposable) + 'M')}  mean ${mean(S.disposable).toFixed(1)}M`);
console.log(`  actor's best SINGLE charge      : median ${median(S.maxSingleCharge)}M  mean ${mean(S.maxSingleCharge).toFixed(1)}M`);
console.log(`  actor's best STACKED charge     : median ${median(S.maxStackCharge)}M  mean ${mean(S.maxStackCharge).toFixed(1)}M`);
console.log(`  turns where a stack COULD exceed the cushion : ${S.couldDisarmByCharge}  ${pct(S.couldDisarmByCharge, S.samples)}`);
console.log(`  turns where the actor held a hard breaker    : ${S.actorHadBreaker}  ${pct(S.actorHadBreaker, S.samples)}`);
console.log(`  turns where the ARMED player held an OPSEC   : ${S.armedHeldOpsec}  ${pct(S.armedHeldOpsec, S.samples)}`);

console.log('\n' + bold(`CHARGES aimed at an armed player: ${S.chargesAtArmed}`));
console.log(`  payable out of loose change (disarmed nobody) : ${S.chargesPayableFromChange}  ${bold(payableShare.toFixed(1) + '%')}`);
console.log(dim(`  targeted actions that landed on a 2+-set player: ${S.twoSetAttacked}`));

console.log('\n' + bold('LEADER BANK BY SET COUNT') + dim('  (opponents observed at turn starts)'));
console.log(`  1 complete set  : median ${median(S.oneSetBank)}M  mean ${mean(S.oneSetBank).toFixed(1)}M  (n=${S.oneSetBank.length})`);
console.log(`  2 complete sets : median ${median(S.twoSetBank)}M  mean ${mean(S.twoSetBank).toFixed(1)}M  (n=${S.twoSetSamples})`);
console.log(`  the moment they arm : median ${median(S.armBank)}M bank + ${median(S.armLoose)}M loose`);

/* ── baseline check ─────────────────────────────────────────────────── */

const live = [noThreatShare, noBreakerShare, blockRate, payableShare, armOpsecShare];
console.log('\n' + bold('vs docs/bot-foresight-research.md (400 games)'));
BASELINES.forEach(([label, want], i) => {
  const got = live[i];
  const delta = got - want;
  const near = Math.abs(delta) <= Math.max(2.5, want * 0.08);
  const mark = near ? green('~') : yellow('!');
  console.log(`  ${mark} ${label.padEnd(52)} doc ${String(want).padStart(5)}%   now ${got.toFixed(1).padStart(5)}%   ` +
    dim(`${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp (${BASELINES[i][2]})`));
});
console.log(dim('  ~ = within noise. The doc\'s figures come from three separately-seeded scripts;'));
console.log(dim(`  only the breakeraudit ones are seed-identical at --seed audit.`));

/* ── machine-readable ───────────────────────────────────────────────── */

if (wantMd) {
  console.log('\n' + dim('── markdown ──'));
  console.log(`\n| Table state when the breaker is fired | Shots | Share |`);
  console.log('|---|---:|---:|');
  const labels = ['Nobody has a single complete set', 'Best opponent has 1 set',
    'Best opponent has 2 sets — the real threat band', 'Best opponent has 3+ sets'];
  labels.forEach((l, i) => console.log(`| ${l} | ${S.firedByMaxOppSets[i]} | ${pct(S.firedByMaxOppSets[i], S.fired)} |`));
  console.log(`| Somebody is on FINAL APPROACH | ${S.firedWhileArmed} | ${pct(S.firedWhileArmed, S.fired)} |`);
  console.log(`| **Nobody at 2+ sets and nobody armed** | **${S.firedEarly}** | **${pct(S.firedEarly, S.fired)}** |`);

  console.log(`\n| Mode | Breakers fired | Fired at a no-threat table | Banked for cash | Shots that advanced our own win |`);
  console.log('|---|---:|---:|---:|---:|');
  for (const m of MODES) {
    const b = S.byMode[m] || { fired: 0, firedEarly: 0, banked: 0, advanced: 0 };
    console.log(`| ${m} | ${b.fired} | ${b.firedEarly} (${pct(b.firedEarly, b.fired)}) | ${b.banked} | ${b.advanced} |`);
  }

  console.log(`\n| Landed breaker shots | Shots | Share of landed |`);
  console.log('|---|---:|---:|');
  console.log(`| Advanced our own set count | ${S.shotsAdvanced} | ${pct(S.shotsAdvanced, S.shotsLanded)} |`);
  console.log(`| ...to setsToWin (won or armed us) | ${S.shotsToWin} | ${pct(S.shotsToWin, S.shotsLanded)} |`);
  console.log(`| ...to setsToWin − 1 | ${S.shotsToWinMinusOne} | ${pct(S.shotsToWinMinusOne, S.shotsLanded)} |`);
  console.log(`| Only denied | ${S.shotsDeniedOnly} | ${pct(S.shotsDeniedOnly, S.shotsLanded)} |`);

  console.log(`\n| Grace cycle (${S.samples} samples) | median | mean |`);
  console.log('|---|---:|---:|');
  console.log(`| Armed player's disposable value | ${median(S.disposable)}M | ${mean(S.disposable).toFixed(1)}M |`);
  console.log(`| Best single charge available | ${median(S.maxSingleCharge)}M | ${mean(S.maxSingleCharge).toFixed(1)}M |`);
  console.log(`| Best stacked charge available | ${median(S.maxStackCharge)}M | ${mean(S.maxStackCharge).toFixed(1)}M |`);
  console.log(`\nCharge sequences that could exceed the cushion: ${S.couldDisarmByCharge} of ${S.samples} — ${pct(S.couldDisarmByCharge, S.samples)}.`);

  console.log(`\n| Leader's state | Their bank (median) |`);
  console.log('|---|---:|');
  console.log(`| 1 complete set | ${median(S.oneSetBank)}M |`);
  console.log(`| 2 complete sets | ${median(S.twoSetBank)}M |`);
  console.log(`| the moment they arm | ${median(S.armBank)}M (+${median(S.armLoose)}M loose property) |`);
  console.log(`\n${S.games} games, seed \`${seed}\`.`);
}

if (wantJson) {
  const out = {
    tool: 'botaudit', seed, games: S.games, perLineup, lineups: lineups.length,
    health: {
      games: S.games, avgTurns: S.turns / (S.games || 1),
      decided: S.decided, decidedShare: S.decided / (S.games || 1),
      pointsEndings: S.pointsEndings,
    },
    breakers: {
      fired: S.fired, banked: S.banked, discardedAtEnd: S.discardedAtEnd, heldAtEnd: S.heldAtEnd,
      firedPerGame: S.fired / (S.games || 1),
      firedByMaxOppSets: { 0: S.firedByMaxOppSets[0], 1: S.firedByMaxOppSets[1], 2: S.firedByMaxOppSets[2], '3+': S.firedByMaxOppSets[3] },
      firedWhileArmed: S.firedWhileArmed,
      firedNoThreat: S.firedEarly, noThreatShare,
      tookFromSet: S.firedTookFromSet, completedOurs: S.firedCompletedOurs, orphan: S.firedOrphan,
      opsecUnseenAtFiring: S.firedOpsecUnseen,
      blockedByOpsec: S.opsecOnBreaker, blockRate,
      blockedByOpsecTailOnly: S.opsecOnBreakerTailOnly, blockRateTailOnly: blockRateTail,
    },
    ownWin: {
      resolved: S.shotsResolved, landed: S.shotsLanded, blocked: S.shotsBlocked,
      advanced: S.shotsAdvanced, advancedShareOfLanded: S.shotsLanded ? S.shotsAdvanced / S.shotsLanded : 0,
      toSetsToWin: S.shotsToWin, toSetsToWinMinusOne: S.shotsToWinMinusOne, otherAdvance: S.shotsAdvancedOther,
      deniedOnly: S.shotsDeniedOnly, byKind: S.byKind,
    },
    byMode: S.byMode,
    armings: {
      firstArmings: S.armings, armingEvents: S.armingEvents, broken: S.armingsBroken,
      brokenShare: S.armingEvents ? S.armingsBroken / S.armingEvents : 0,
      breakersDeadAtArming: S.breakersDeadAtArming / (S.armings || 1),
      breakersTotal: S.breakersTotalAtArming / (S.armings || 1),
      noBreakerInAnyHand: S.armedWithNoBreakerInAnyHand, noBreakerShare,
      bankMedian: median(S.armBank), bankMean: mean(S.armBank),
      looseMedian: median(S.armLoose), looseMean: mean(S.armLoose),
      withOpsec: S.armWithOpsec, withOpsecShare: armOpsecShare,
      meanArmingTurn: mean(S.armTurn),
    },
    graceCycle: {
      samples: S.samples,
      disposableMedian: median(S.disposable), disposableMean: mean(S.disposable),
      singleChargeMedian: median(S.maxSingleCharge), singleChargeMean: mean(S.maxSingleCharge),
      stackChargeMedian: median(S.maxStackCharge), stackChargeMean: mean(S.maxStackCharge),
      couldDisarm: S.couldDisarmByCharge, couldDisarmShare: S.samples ? S.couldDisarmByCharge / S.samples : 0,
      actorHadBreaker: S.actorHadBreaker, actorHadBreakerShare: S.samples ? S.actorHadBreaker / S.samples : 0,
      armedHeldOpsec: S.armedHeldOpsec, armedHeldOpsecShare: S.samples ? S.armedHeldOpsec / S.samples : 0,
    },
    chargesAtArmed: {
      total: S.chargesAtArmed, payableFromChange: S.chargesPayableFromChange, payableShare,
      landedOnTwoSetPlayer: S.twoSetAttacked,
    },
    leaderBank: {
      oneSetMedian: median(S.oneSetBank), oneSetMean: mean(S.oneSetBank), oneSetSamples: S.oneSetBank.length,
      twoSetMedian: median(S.twoSetBank), twoSetMean: mean(S.twoSetBank), twoSetSamples: S.twoSetSamples,
    },
  };
  console.log('\n' + JSON.stringify(out, null, 2));
}

console.log('\n' + green(bold('botaudit: done')) + dim('  (measurement only — always exits 0)'));
process.exit(EXIT_PASS);
