#!/usr/bin/env node
// simulate.js — Deep-analysis bot simulation harness for Chudopoly
// Captures per-turn decision data, early/mid/late game splits, targeting patterns,
// combo detection, card holdings at victory, and play sequencing.

const G = require('./game');
const Bot = require('./bot');
const { decideBotPlay, botRespondSync, findResponder, chooseDiscards, setRng } = Bot._internal;
const botRnd = Bot._internal.rnd;

const BOT_MODES = ['random', 'conservative', 'neutral', 'aggressive', 'chud'];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(botRnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// `rules` accepts either a winRule string (backward compatible) or a full ruleset/opts
// object ({preset} and/or individual toggles), exactly like createGame.
function toRuleOpts(rules) {
  if (rules === undefined || rules === null) return {};
  return typeof rules === 'string' ? { winRule: rules } : rules;
}

function createBotRoom(playerConfigs, seed, rules) {
  const players = playerConfigs.map((cfg, i) => ({
    id: 'p' + i, name: cfg.name, isBot: true, botMode: cfg.mode,
  }));
  const options = { ...toRuleOpts(rules) };
  if (seed !== undefined && seed !== null) options.seed = seed;
  const state = G.createGame(players.map(p => ({ id: p.id, name: p.name })), options);
  return { code: 'SIM', players, state, clients: {} };
}

function getBotMode(room, botId) {
  return room.players.find(x => x.id === botId)?.botMode || 'neutral';
}

/* ── Deep-analysis game runner ─────────────────────────────────────── */

function runGame(playerConfigs, maxTurns = 500, seed, rules) {
  const room = createBotRoom(playerConfigs, seed, rules);
  const state = room.state;

  // Per-player tracking
  const tracker = {};
  for (const p of room.players) {
    tracker[p.id] = {
      mode: p.botMode, name: p.name,
      // Per-turn decision records
      decisions: [],
      // Action counts by game phase
      early: {}, mid: {}, late: {},
      // Combo tracking
      combos: { surgeRent: 0, pcsFollowup: 0, stealAfterRent: 0 },
      // Targeting
      targetsChosen: [],
      // Plays per turn
      playsPerTurn: [],
      // Turn-by-turn set count
      setProgression: [],
      // Properties by color
      colorDistribution: {},
      // Banking decisions
      bankDecisions: { money: 0, action: 0, rent: 0 },
      // OPSEC
      opsec: { held: 0, played: 0, savedForBig: 0, wastedOnSmall: 0 },
      // Cards held at game end
      endState: null,
      // Play ordering within turns
      turnPlayOrder: [], // what was played 1st, 2nd, 3rd each turn
    };
  }

  let turnNum = 0;
  let maxArmed = 0, contestedTurns = 0;
  let lastTurnCounter = null;
  let currentTurnPlays = [];
  let currentTurnPlayer = null;
  let lastAction = null;
  let safetyCounter = 0;
  const MAX_ITERATIONS = maxTurns * 20;

  while (state.phase === 'playing' && safetyCounter < MAX_ITERATIONS) {
    safetyCounter++;

    // Resolve pending actions
    if (state.pendingAction) {
      const responderId = findResponder(state);
      if (responderId) {
        const mode = getBotMode(room, responderId);
        const pa = state.pendingAction;
        const bot = G.getPlayer(state, responderId);
        const hadOpsec = bot?.hand.some(c => c.action === 'opsec');

        botRespondSync(state, responderId, mode);

        // Track OPSEC decisions
        if (hadOpsec && bot) {
          const stillHasOpsec = bot.hand.some(c => c.action === 'opsec');
          if (!stillHasOpsec && hadOpsec) {
            // Played OPSEC
            tracker[responderId].opsec.played++;
            const isBig = ['inspector_general', 'chud', 'finance_office'].includes(pa.action) ||
              (pa.action === 'rent' && pa.amount >= 4);
            if (isBig) tracker[responderId].opsec.savedForBig++;
            else tracker[responderId].opsec.wastedOnSmall++;
          }
        }
        continue;
      }
      state.pendingAction = null;
      state.turnPhase = 'play';
      continue;
    }

    const cp = G.currentPlayer(state);
    if (cp.eliminated) {
      G.advanceToNextActive(state);
      continue;
    }

    const mode = getBotMode(room, cp.id);

    // TURN START. The draw is automatic in the engine now (game.js beginTurn), so this
    // bookkeeping hangs off the turn counter changing rather than off turnPhase==='draw',
    // which is no longer externally observable.
    if (state.turnCounter !== lastTurnCounter) {
      lastTurnCounter = state.turnCounter;
      // Save previous turn's play order
      if (currentTurnPlayer && currentTurnPlays.length > 0) {
        tracker[currentTurnPlayer].turnPlayOrder.push([...currentTurnPlays]);
        tracker[currentTurnPlayer].playsPerTurn.push(currentTurnPlays.length);
      }
      currentTurnPlays = [];
      currentTurnPlayer = cp.id;

      // Track set progression
      for (const p of state.players) {
        if (!p.eliminated) {
          tracker[p.id].setProgression.push(G.completedSets(p));
        }
      }

      // Track OPSEC held
      const opsecInHand = cp.hand.filter(c => c.action === 'opsec').length;
      if (opsecInHand > 0) tracker[cp.id].opsec.held++;

      // §3.10b — how often is a final approach CONTESTED? Sampled at every turn start,
      // which is the only moment the count can change a player's fate, so "turns spent
      // contested" is a count of real decision points and not of engine iterations.
      const armedNow = G.armedPlayers(state).length;
      if (armedNow > maxArmed) maxArmed = armedNow;
      if (armedNow >= 2) contestedTurns++;

      turnNum++;
      if (state.phase === 'finished') break;
      if (turnNum > maxTurns) break;
      lastAction = null;
      // fall through: the cards are already in hand, this is the play phase
    }

    // PLAY PHASE
    if (state.turnPhase === 'play') {
      if (mode === 'chud' && state.playsRemaining > 0 && state.playsRemaining < 3 && botRnd() < 0.2) {
        const bot = G.getPlayer(state, cp.id);
        let discardIds;
        if (bot.hand.length > 7) discardIds = chooseDiscards(bot, bot.hand.length - 7, mode);
        G.endTurn(state, cp.id, discardIds);
        continue;
      }

      const action = decideBotPlay(state, cp.id, mode);
      if (action) {
        const bot = G.getPlayer(state, cp.id);
        const card = bot?.hand[action.cardIndex];

        // Determine game phase for this decision
        const phase = turnNum <= 15 ? 'early' : (turnNum <= 40 ? 'mid' : 'late');

        let result;
        let actionName = 'unknown';
        switch (action.type) {
          case 'play_property':
            result = G.playProperty(state, cp.id, action.cardIndex, action.targetColor);
            actionName = 'property';
            if (result.ok && card) {
              const color = action.targetColor || card.color;
              tracker[cp.id].colorDistribution[color] = (tracker[cp.id].colorDistribution[color] || 0) + 1;
            }
            break;
          case 'play_money':
            result = G.playAsMoney(state, cp.id, action.cardIndex);
            actionName = 'bank';
            if (result.ok && card) {
              if (card.type === 'money') tracker[cp.id].bankDecisions.money++;
              else if (card.type === 'action') tracker[cp.id].bankDecisions.action++;
              else if (card.type === 'rent') tracker[cp.id].bankDecisions.rent++;
            }
            break;
          case 'play_action':
            result = G.playAction(state, cp.id, action.cardIndex, {
              targetId: action.targetId, targetColor: action.targetColor,
              targetCardId: action.targetCardId, myCardId: action.myCardId,
            });
            actionName = card?.action || (card?.type === 'rent' ? 'rent' : 'action');

            // Track targeting
            if (result.ok && action.targetId) {
              const targetMode = getBotMode(room, action.targetId);
              const targetSets = G.completedSets(G.getPlayer(state, action.targetId));
              tracker[cp.id].targetsChosen.push({
                action: actionName, targetMode, targetSets,
                isLeader: targetSets >= Math.max(...state.players.filter(p => !p.eliminated && p.id !== cp.id).map(p => G.completedSets(p))),
              });
            }

            // Track combos
            if (result.ok) {
              if (actionName === 'surge_ops') lastAction = 'surge';
              else if (actionName === 'rent' && lastAction === 'surge') {
                tracker[cp.id].combos.surgeRent++;
                lastAction = 'rent';
              } else if (actionName === 'pcs_orders') {
                lastAction = 'pcs';
              } else if (lastAction === 'pcs' && actionName !== 'pcs_orders') {
                tracker[cp.id].combos.pcsFollowup++;
                lastAction = actionName;
              } else if ((actionName === 'midnight_requisition' || actionName === 'chud') && lastAction === 'rent') {
                tracker[cp.id].combos.stealAfterRent++;
                lastAction = actionName;
              } else {
                lastAction = actionName;
              }
            }
            break;
          // §3.8 — free rearranging. It costs no play, so nothing about the turn loop
          // changes: the engine spends the per-turn rearrange budget and the bot comes
          // straight back with the same plays in hand.
          case 'rearrange':
            result = G.moveProperty(state, cp.id, action.cardId, action.toColor);
            actionName = 'rearrange';
            break;
          case 'swap':
            result = G.swapProperties(state, cp.id, action.cardIdA, action.cardIdB);
            actionName = 'swap';
            break;
        }

        if (result?.ok) {
          tracker[cp.id][phase][actionName] = (tracker[cp.id][phase][actionName] || 0) + 1;
          // A rearrange is not a play (§3.8), so it must not enter the plays-per-turn or
          // first-play-of-turn distributions — those measure how a bot spends its three
          // plays, and counting a free move as one would make every mode look busier.
          if (actionName !== 'rearrange' && actionName !== 'swap') currentTurnPlays.push(actionName);

          // Record decision
          tracker[cp.id].decisions.push({
            turn: turnNum, phase, action: actionName,
            playsLeft: state.playsRemaining,
            mySets: G.completedSets(bot),
            handSize: bot.hand.length,
          });
        }

        if (result?.error) {
          const bot2 = G.getPlayer(state, cp.id);
          let discardIds;
          if (bot2.hand.length > 7) discardIds = chooseDiscards(bot2, bot2.hand.length - 7, mode);
          G.endTurn(state, cp.id, discardIds);
        }
        if (state.phase === 'finished') break;
        continue;
      }

      // No play — end turn
      const bot = G.getPlayer(state, cp.id);
      let discardIds;
      if (bot.hand.length > 7) discardIds = chooseDiscards(bot, bot.hand.length - 7, mode);
      const endResult = G.endTurn(state, cp.id, discardIds);
      if (endResult.error) G.forceEndTurn(state);
      continue;
    }
    break;
  }

  // Save last turn's plays
  if (currentTurnPlayer && currentTurnPlays.length > 0) {
    tracker[currentTurnPlayer].turnPlayOrder.push([...currentTurnPlays]);
    tracker[currentTurnPlayer].playsPerTurn.push(currentTurnPlays.length);
  }

  // Record end state
  for (const p of state.players) {
    const t = tracker[p.id];
    t.endState = {
      sets: G.completedSets(p),
      handSize: p.hand.length,
      bankValue: p.bank.reduce((s, c) => s + c.value, 0),
      totalProps: Object.values(p.properties).reduce((s, cards) => s + cards.length, 0),
      colorsUsed: Object.keys(p.properties).filter(c => (p.properties[c] || []).length > 0).length,
      eliminated: !!p.eliminated,
    };
  }

  return {
    turns: turnNum, winner: state.winner,
    winnerMode: state.winner ? getBotMode(room, state.winner) : null,
    stalemate: state.endReason === 'stalemate' || turnNum > maxTurns - 1,
    endReason: state.endReason,
    // §3.10 telemetry: how many final approaches were armed, and how many were shot down.
    armings: state.events.filter(e => e.t === 'final_approach').length,
    breaks: state.events.filter(e => e.t === 'final_approach_broken').length,
    breaksByOpponent: state.events.filter(e => e.t === 'final_approach_broken' && e.by).length,
    shuffles: state.events.filter(e => e.t === 'shuffle').length,
    // §3.6/§3.11: WHICH points ending, not just that there was one. 'deck_dry' is the table
    // going still; 'deck_cycles' is the 16-reshuffle attrition cap. They are different
    // failures and a deck change can move one without touching the other.
    stalemateReason: (state.events.find(e => e.t === 'stalemate') || {}).reason || null,
    deckSize: state.cardTotal,
    // §3.10b: was the approach ever contested, and for how many turns.
    maxArmed, contestedTurns,
    armingsOffTurn: state.events.filter(e => e.t === 'final_approach' && e.onOwnTurn === false).length,
    tracker,
  };
}

/* ── Programmatic balance API (ARCHITECTURE §3 header) ─────────────── */

// runMatches({ players:['neutral','chud',...], games, seed })
//   → { games, wins, winrates, seatWins, seatWinrates, firstPlayerWin, avgTurns,
//       medianTurns, stalemates, stalemateRate, decided }
function runMatches({ players, games = 500, seed = null, maxTurns = 300, winRule, rules } = {}) {
  const ruleOpts = rules !== undefined ? rules : winRule;
  const modes = (players && players.length ? players : ['neutral', 'neutral', 'neutral', 'neutral']).slice();
  const configs = modes.map((mode, i) => ({ name: mode.slice(0, 4) + i, mode }));

  const wins = {};
  const seats = {};
  for (const m of modes) { wins[m] = 0; seats[m] = (seats[m] || 0) + 1; }
  const seatWins = new Array(modes.length).fill(0);

  let totalTurns = 0, stalemates = 0, decided = 0;
  let armings = 0, breaks = 0, breaksByOpponent = 0, armingsOffTurn = 0, maxTurns_ = 0;
  let deckDry = 0, deckCycles = 0, contestCap = 0, shuffleSum = 0;
  let contestedGames = 0, suspendedTurns = 0;
  const turnList = [];
  const shuffleList = [];

  for (let g = 0; g < games; g++) {
    const gameSeed = seed === null || seed === undefined ? undefined : `${seed}:${g}`;
    setRng(gameSeed === undefined ? null : G.makeRng('bot:' + gameSeed));
    const result = runGame(configs, maxTurns, gameSeed, ruleOpts);
    totalTurns += result.turns;
    turnList.push(result.turns);
    shuffleSum += result.shuffles;
    shuffleList.push(result.shuffles);
    armings += result.armings;
    breaks += result.breaks;
    breaksByOpponent += result.breaksByOpponent;
    armingsOffTurn += result.armingsOffTurn;
    if (result.turns > maxTurns_) maxTurns_ = result.turns;
    if (result.endReason === 'stalemate' || (!result.winner && result.stalemate)) stalemates++;
    if (result.stalemateReason === 'deck_cycles') deckCycles++;
    else if (result.stalemateReason === 'contested') contestCap++;
    else if (result.stalemateReason === 'deck_dry') deckDry++;
    if (result.maxArmed >= 2) contestedGames++;
    suspendedTurns += result.contestedTurns;
    if (result.winner) {
      decided++;
      const seat = Number(String(result.winner).slice(1));
      if (Number.isInteger(seat) && seat >= 0 && seat < modes.length) seatWins[seat]++;
      wins[modes[seat]]++;
    }
  }
  setRng(null);

  const sorted = turnList.slice().sort((a, b) => a - b);
  const shuffleSorted = shuffleList.slice().sort((a, b) => a - b);
  const winrates = {};
  for (const m of Object.keys(wins)) winrates[m] = +(wins[m] / games * 100).toFixed(2);

  return {
    games, players: modes, wins, winrates, seatCounts: seats,
    // §3.11 deck-cycle attrition: how hard this deck is actually working.
    avgShuffles: +(shuffleSum / games).toFixed(2),
    p90Shuffles: shuffleSorted[Math.min(shuffleSorted.length - 1, Math.floor(games * 0.9))],
    // The §3.6 points ending, split by cause: the deck going still, §3.11's 16-cycle
    // attrition cap, and §3.10b's contested-approach lap cap. `pointsRate` is the number
    // the owner watches — the share of games nobody actually won.
    deckDry, deckCycles, contestCap,
    pointsRate: +((deckDry + deckCycles + contestCap) / games * 100).toFixed(2),
    deckSize: G.deckSize(G.resolveRules(toRuleOpts(ruleOpts)).deck),
    // §3.10b — games in which two or more players were armed at the same turn start, and
    // the total number of turn starts spent that way.
    contestedGames, suspendedTurns,
    contestedRate: +(contestedGames / games * 100).toFixed(2),
    seatWins,
    seatWinrates: seatWins.map(w => +(w / games * 100).toFixed(2)),
    firstPlayerWin: +(seatWins[0] / games * 100).toFixed(2),
    avgTurns: +(totalTurns / games).toFixed(1),
    medianTurns: sorted[Math.floor(games / 2)],
    p90Turns: sorted[Math.min(sorted.length - 1, Math.floor(games * 0.9))],
    maxTurns: maxTurns_,
    turnList: sorted,
    rules: G.resolveRules(toRuleOpts(ruleOpts)),
    winRule: G.resolveRules(toRuleOpts(ruleOpts)).winRule,
    armings, breaks, breaksByOpponent, armingsOffTurn,
    offTurnArmRate: armings > 0 ? +(armingsOffTurn / armings * 100).toFixed(1) : 0,
    armingsPerGame: +(armings / games).toFixed(2),
    breakRate: armings > 0 ? +(breaks / armings * 100).toFixed(1) : 0,
    opponentBreakRate: armings > 0 ? +(breaksByOpponent / armings * 100).toFixed(1) : 0,
    stalemates,
    stalemateRate: +(stalemates / games * 100).toFixed(2),
    decided,
  };
}

/**
 * The lineups a mixed matrix is run over, at a given seat count: EVERY k-subset of the
 * 5-personality roster × EVERY rotation of that subset, so neither seat order nor a lucky
 * matchup can flatter a mode. That is the rule the 4-player matrix has always used, stated
 * once and generalised, rather than four special cases:
 *
 *   k=2 → C(5,2)=10 subsets × 2 rotations = 20 lineups
 *   k=3 → C(5,3)=10 × 3 = 30
 *   k=4 → C(5,4)= 5 × 4 = 20   (identical to the old drop-one loop, lineup for lineup)
 *   k=5 → C(5,5)= 1 × 5 =  5
 *
 * Seats beyond the roster size repeat personalities, which is the only honest option — a
 * 6-seat table cannot be five distinct modes.
 */
function lineupsFor(playerCount = 4) {
  const roster = BOT_MODES;
  const k = Math.max(2, playerCount);
  const lineups = [];
  if (k > roster.length) {
    const padded = Array.from({ length: k }, (_, i) => roster[i % roster.length]);
    for (let r = 0; r < k; r++) lineups.push(padded.slice(r).concat(padded.slice(0, r)));
    return lineups;
  }
  const subsets = [];
  const walk = (start, acc) => {
    if (acc.length === k) { subsets.push(acc.slice()); return; }
    for (let i = start; i < roster.length; i++) { acc.push(roster[i]); walk(i + 1, acc); acc.pop(); }
  };
  walk(0, []);
  for (const subset of subsets) {
    for (let r = 0; r < subset.length; r++) lineups.push(subset.slice(r).concat(subset.slice(0, r)));
  }
  return lineups;
}

// Every personality plays mixed games in every seat. `rules` is the full opts object
// createGame takes (preset, toggles, deck), so any variant is measurable through the same
// door the lobby uses — that is the whole point of making the deck a rule.
function mixedMatrix(totalGames = 500, seed = 'matrix', { rules, playerCount = 4 } = {}) {
  const lineups = lineupsFor(playerCount);
  const per = Math.max(1, Math.round(totalGames / lineups.length));
  const tally = {};
  for (const m of BOT_MODES) tally[m] = { wins: 0, games: 0 };
  let seat0 = 0, games = 0, turnSum = 0, stalemates = 0, decided = 0;
  let armings = 0, breaks = 0, armingsOffTurn = 0, maxTurns_ = 0;
  let deckDry = 0, deckCycles = 0, contestCap = 0, shuffleSum = 0, deckSize = 0;
  let contestedGames = 0, suspendedTurns = 0;
  const turns = [];

  lineups.forEach((order, i) => {
    const res = runMatches({ players: order, games: per, seed: `${seed}-mix${i}`, rules });
    for (const m of order) { tally[m].wins += res.wins[m]; tally[m].games += res.games; }
    seat0 += res.seatWins[0];
    armings += res.armings;
    breaks += res.breaks;
    armingsOffTurn += res.armingsOffTurn;
    deckDry += res.deckDry;
    deckCycles += res.deckCycles;
    contestCap += res.contestCap;
    shuffleSum += res.avgShuffles * res.games;
    deckSize = res.deckSize;
    contestedGames += res.contestedGames;
    suspendedTurns += res.suspendedTurns;
    if (res.maxTurns > maxTurns_) maxTurns_ = res.maxTurns;
    turns.push(...res.turnList);
    games += res.games;
    decided += res.decided;
    turnSum += res.avgTurns * res.games;
    stalemates += res.stalemates;
  });

  turns.sort((a, b) => a - b);
  return {
    games, tally, decided, deckSize,
    firstPlayerWin: seat0 / games * 100,
    avgTurns: turnSum / games,
    medianTurns: turns[Math.floor(turns.length / 2)],
    p90Turns: turns[Math.min(turns.length - 1, Math.floor(turns.length * 0.9))],
    stalemateRate: stalemates / games * 100,
    // §3.6/§3.11 points endings, split by cause. `pointsRate` is the number the owner
    // watches: the share of games nobody actually won.
    deckDry, deckCycles, contestCap,
    pointsRate: (deckDry + deckCycles + contestCap) / games * 100,
    avgShuffles: shuffleSum / games,
    maxTurns: maxTurns_,
    armings, breaks, armingsOffTurn,
    armingsPerGame: armings / games,
    breakRate: armings > 0 ? breaks / armings * 100 : 0,
    offTurnArmRate: armings > 0 ? armingsOffTurn / armings * 100 : 0,
    // §3.10b contested-approach telemetry.
    contestedGames,
    contestedRate: contestedGames / games * 100,
    suspendedTurns,
    suspendedPerContested: contestedGames > 0 ? suspendedTurns / contestedGames : 0,
    perMode: Object.fromEntries(BOT_MODES.map(m =>
      [m, tally[m].games > 0 ? tally[m].wins / tally[m].games * 100 : 0])),
  };
}

function printMatrix(games = 500, seed = 'matrix') {
  const mixed = mixedMatrix(games, seed);
  console.log(`\n── 4-PLAYER MIXED, every seat × every 4-subset (${mixed.games} games) ${'─'.repeat(6)}`);
  console.log('  ' + 'personality'.padEnd(16) + 'winrate   games   bound 8–60%');
  for (const m of BOT_MODES) {
    const pct = tally(mixed, m);
    const flag = pct > 60 ? ' ✗ HIGH' : pct < 8 ? ' ✗ LOW' : ' ✓';
    console.log('  ' + m.padEnd(16) + `${pct.toFixed(1)}%`.padStart(6) + String(mixed.tally[m].games).padStart(8)
      + '   ' + '█'.repeat(Math.round(pct / 2)) + flag);
  }
  console.log(`  first-player advantage: ${mixed.firstPlayerWin.toFixed(1)}% (fair share 25.0%)`);
  console.log(`  avg turns ${mixed.avgTurns.toFixed(1)}  max ${mixed.maxTurns}  stalemates ${mixed.stalemateRate.toFixed(2)}%  decided ${mixed.decided}/${mixed.games}`);
  console.log(`  final approach: ${mixed.armingsPerGame.toFixed(2)} armings/game, ` +
    `${mixed.breakRate.toFixed(1)}% shot down, ${(100 - mixed.breakRate).toFixed(1)}% converted, ` +
    `${mixed.offTurnArmRate.toFixed(1)}% armed off-turn`);

  console.log(`\n── EACH PERSONALITY vs 3 NEUTRAL (${games} games each) ${'─'.repeat(12)}`);
  for (const m of BOT_MODES) {
    const res = runMatches({ players: [m, 'neutral', 'neutral', 'neutral'], games, seed: `${seed}-vs3-${m}` });
    console.log('  ' + m.padEnd(16) + `${res.seatWinrates[0].toFixed(1)}%`.padStart(6) +
      `   (avg turns ${res.avgTurns}, stalemates ${res.stalemateRate}%)`);
  }
  console.log();
}

function tally(mixed, mode) {
  const t = mixed.tally[mode];
  return t.games > 0 ? t.wins / t.games * 100 : 0;
}

/* ── Aggregation and Analysis ──────────────────────────────────────── */

function runAndAnalyze(numGames = 500) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  CHUDOPOLY — BOT STRATEGY ANALYSIS`);
  console.log(`  ${numGames} simulated games, 5 bot modes`);
  console.log(`${'='.repeat(60)}\n`);

  const configs = BOT_MODES.map(mode => ({
    name: mode.charAt(0).toUpperCase() + mode.slice(1) + 'Bot', mode,
  }));

  // Aggregate containers
  const agg = {};
  for (const m of BOT_MODES) {
    agg[m] = {
      wins: 0, games: numGames,
      // Phase distributions
      early: {}, mid: {}, late: {},
      // Combos
      combos: { surgeRent: 0, pcsFollowup: 0, stealAfterRent: 0 },
      // Targeting
      targetLeaderPct: { count: 0, total: 0 },
      targetByMode: {},
      // Play order
      firstPlayCounts: {},
      playsPerTurn: [],
      turnsWithMaxPlays: 0, turnsTotal: 0,
      // Banking
      bankDecisions: { money: 0, action: 0, rent: 0 },
      // OPSEC
      opsec: { held: 0, played: 0, savedForBig: 0, wastedOnSmall: 0 },
      // Colors
      colorDistribution: {},
      // End state
      endSets: [], endBankValues: [], endPropCounts: [], endColorsUsed: [],
      // Winner card holdings
      winnerHoldings: [],
      // Set progression (turn-by-turn)
      setProgressionByTurn: {},
    };
  }

  let totalTurns = 0;
  let stalemates = 0;
  const turnDistribution = [];

  for (let g = 0; g < numGames; g++) {
    const result = runGame(configs, 300);
    totalTurns += result.turns;
    turnDistribution.push(result.turns);
    if (result.stalemate) stalemates++;
    if (result.winnerMode) agg[result.winnerMode].wins++;

    for (const p of configs) {
      const id = Object.keys(result.tracker).find(k => result.tracker[k].mode === p.mode);
      if (!id) continue;
      const t = result.tracker[id];
      const a = agg[p.mode];

      // Phase distributions
      for (const phase of ['early', 'mid', 'late']) {
        for (const [action, count] of Object.entries(t[phase])) {
          a[phase][action] = (a[phase][action] || 0) + count;
        }
      }

      // Combos
      a.combos.surgeRent += t.combos.surgeRent;
      a.combos.pcsFollowup += t.combos.pcsFollowup;
      a.combos.stealAfterRent += t.combos.stealAfterRent;

      // Targeting
      for (const tgt of t.targetsChosen) {
        a.targetByMode[tgt.targetMode] = (a.targetByMode[tgt.targetMode] || 0) + 1;
        a.targetLeaderPct.total++;
        if (tgt.isLeader) a.targetLeaderPct.count++;
      }

      // Play ordering
      for (const turnPlays of t.turnPlayOrder) {
        a.turnsTotal++;
        if (turnPlays.length >= 3) a.turnsWithMaxPlays++;
        a.playsPerTurn.push(turnPlays.length);
        if (turnPlays.length > 0) {
          a.firstPlayCounts[turnPlays[0]] = (a.firstPlayCounts[turnPlays[0]] || 0) + 1;
        }
      }

      // Banking
      a.bankDecisions.money += t.bankDecisions.money;
      a.bankDecisions.action += t.bankDecisions.action;
      a.bankDecisions.rent += t.bankDecisions.rent;

      // OPSEC
      a.opsec.held += t.opsec.held;
      a.opsec.played += t.opsec.played;
      a.opsec.savedForBig += t.opsec.savedForBig;
      a.opsec.wastedOnSmall += t.opsec.wastedOnSmall;

      // Colors
      for (const [color, count] of Object.entries(t.colorDistribution)) {
        a.colorDistribution[color] = (a.colorDistribution[color] || 0) + count;
      }

      // End state
      if (t.endState) {
        a.endSets.push(t.endState.sets);
        a.endBankValues.push(t.endState.bankValue);
        a.endPropCounts.push(t.endState.totalProps);
        a.endColorsUsed.push(t.endState.colorsUsed);
      }

      // Winner holdings
      if (result.winner === id) {
        a.winnerHoldings.push(t.endState);
      }

      // Set progression
      for (let turn = 0; turn < t.setProgression.length; turn++) {
        if (!a.setProgressionByTurn[turn]) a.setProgressionByTurn[turn] = [];
        a.setProgressionByTurn[turn].push(t.setProgression[turn]);
      }
    }
  }

  // ── Print Results ─────────────────────────────────────────────────

  const N = numGames;
  const avgTurns = (totalTurns / N).toFixed(1);
  const sortedTurns = [...turnDistribution].sort((a, b) => a - b);

  console.log(`\u2500\u2500 GAME LENGTH ${'─'.repeat(46)}`);
  console.log(`  Average: ${avgTurns} turns | Median: ${sortedTurns[Math.floor(N/2)]} | Range: ${sortedTurns[0]}-${sortedTurns[N-1]}`);
  console.log(`  Stalemates: ${stalemates} (${(stalemates/N*100).toFixed(1)}%)`);
  console.log();

  // Win rates
  console.log(`\u2500\u2500 WIN RATES ${'─'.repeat(48)}`);
  const sortedWins = Object.entries(agg).map(([m, a]) => [m, a.wins]).sort((a, b) => b[1] - a[1]);
  for (const [mode, wins] of sortedWins) {
    const pct = (wins / N * 100).toFixed(1);
    const bar = '\u2588'.repeat(Math.round(wins / N * 50));
    console.log(`  ${mode.padEnd(14)} ${String(wins).padStart(4)} wins (${pct.padStart(5)}%) ${bar}`);
  }
  console.log();

  // Early / Mid / Late game action distributions
  for (const phase of ['early', 'mid', 'late']) {
    const phaseName = phase === 'early' ? 'EARLY GAME (turns 1-15)' :
      phase === 'mid' ? 'MID GAME (turns 16-40)' : 'LATE GAME (turns 41+)';
    console.log(`\u2500\u2500 ${phaseName} ${'─'.repeat(50 - phaseName.length)}`);

    // Get all actions across modes
    const allActions = new Set();
    for (const m of BOT_MODES) {
      for (const a of Object.keys(agg[m][phase])) allActions.add(a);
    }
    if (allActions.size === 0) { console.log('  (no data)\n'); continue; }

    const actionList = [...allActions].sort();
    console.log('  ' + 'Action'.padEnd(24) + BOT_MODES.map(m => m.slice(0, 6).padStart(8)).join(''));

    for (const action of actionList) {
      let line = '  ' + action.padEnd(24);
      for (const m of BOT_MODES) {
        const count = agg[m][phase][action] || 0;
        const total = Object.values(agg[m][phase]).reduce((s, v) => s + v, 0);
        const pct = total > 0 ? (count / total * 100).toFixed(0) : '0';
        line += `${pct.padStart(5)}%  `;
      }
      console.log(line);
    }
    // Total actions per mode
    let totalLine = '  ' + 'TOTAL ACTIONS'.padEnd(24);
    for (const m of BOT_MODES) {
      const total = Object.values(agg[m][phase]).reduce((s, v) => s + v, 0);
      totalLine += `${String(total).padStart(6)}  `;
    }
    console.log(totalLine);
    console.log();
  }

  // Combo usage
  console.log(`\u2500\u2500 COMBO PLAYS (per game avg) ${'─'.repeat(31)}`);
  console.log('  ' + 'Combo'.padEnd(24) + BOT_MODES.map(m => m.slice(0, 6).padStart(8)).join(''));
  for (const combo of ['surgeRent', 'pcsFollowup', 'stealAfterRent']) {
    let line = '  ' + combo.padEnd(24);
    for (const m of BOT_MODES) {
      line += (agg[m].combos[combo] / N).toFixed(2).padStart(7) + ' ';
    }
    console.log(line);
  }
  console.log();

  // Play ordering — what's played first each turn
  console.log(`\u2500\u2500 FIRST PLAY OF TURN (% of turns) ${'─'.repeat(25)}`);
  const allFirstPlays = new Set();
  for (const m of BOT_MODES) {
    for (const a of Object.keys(agg[m].firstPlayCounts)) allFirstPlays.add(a);
  }
  console.log('  ' + 'First play'.padEnd(24) + BOT_MODES.map(m => m.slice(0, 6).padStart(8)).join(''));
  for (const action of [...allFirstPlays].sort()) {
    let line = '  ' + action.padEnd(24);
    for (const m of BOT_MODES) {
      const count = agg[m].firstPlayCounts[action] || 0;
      const total = agg[m].turnsTotal;
      const pct = total > 0 ? (count / total * 100).toFixed(0) : '0';
      line += `${pct.padStart(5)}%  `;
    }
    console.log(line);
  }
  console.log();

  // Plays per turn distribution
  console.log(`\u2500\u2500 PLAYS PER TURN ${'─'.repeat(43)}`);
  console.log('  ' + 'Metric'.padEnd(24) + BOT_MODES.map(m => m.slice(0, 6).padStart(8)).join(''));
  let avgLine = '  ' + 'Average plays/turn'.padEnd(24);
  let maxLine = '  ' + '3-play turns (%)'.padEnd(24);
  let oneLine = '  ' + '1-play turns (%)'.padEnd(24);
  let zeroLine = '  ' + '0-play turns (%)'.padEnd(24);
  for (const m of BOT_MODES) {
    const plays = agg[m].playsPerTurn;
    const avg = plays.length > 0 ? (plays.reduce((s, v) => s + v, 0) / plays.length).toFixed(1) : '0';
    const max3 = plays.length > 0 ? (plays.filter(p => p >= 3).length / plays.length * 100).toFixed(0) : '0';
    const one = plays.length > 0 ? (plays.filter(p => p === 1).length / plays.length * 100).toFixed(0) : '0';
    const zero = plays.length > 0 ? (plays.filter(p => p === 0).length / plays.length * 100).toFixed(0) : '0';
    avgLine += avg.padStart(7) + ' ';
    maxLine += (max3 + '%').padStart(7) + ' ';
    oneLine += (one + '%').padStart(7) + ' ';
    zeroLine += (zero + '%').padStart(7) + ' ';
  }
  console.log(avgLine);
  console.log(maxLine);
  console.log(oneLine);
  console.log(zeroLine);
  console.log();

  // Targeting analysis
  console.log(`\u2500\u2500 TARGETING PATTERNS ${'─'.repeat(39)}`);
  console.log('  ' + 'Target mode'.padEnd(24) + BOT_MODES.map(m => m.slice(0, 6).padStart(8)).join(''));
  for (const targetMode of BOT_MODES) {
    let line = '  ' + ('→ ' + targetMode).padEnd(24);
    for (const m of BOT_MODES) {
      const count = agg[m].targetByMode[targetMode] || 0;
      const total = agg[m].targetLeaderPct.total;
      const pct = total > 0 ? (count / total * 100).toFixed(0) : '0';
      line += `${pct.padStart(5)}%  `;
    }
    console.log(line);
  }
  let leaderLine = '  ' + 'Targets leader (%)'.padEnd(24);
  for (const m of BOT_MODES) {
    const pct = agg[m].targetLeaderPct.total > 0
      ? (agg[m].targetLeaderPct.count / agg[m].targetLeaderPct.total * 100).toFixed(0) : '0';
    leaderLine += `${pct.padStart(5)}%  `;
  }
  console.log(leaderLine);
  console.log();

  // Banking breakdown
  console.log(`\u2500\u2500 BANKING DECISIONS (total) ${'─'.repeat(33)}`);
  console.log('  ' + 'Card type banked'.padEnd(24) + BOT_MODES.map(m => m.slice(0, 6).padStart(8)).join(''));
  for (const type of ['money', 'action', 'rent']) {
    let line = '  ' + type.padEnd(24);
    for (const m of BOT_MODES) {
      line += String(agg[m].bankDecisions[type]).padStart(7) + ' ';
    }
    console.log(line);
  }
  console.log();

  // OPSEC economy
  console.log(`\u2500\u2500 OPSEC ECONOMY ${'─'.repeat(44)}`);
  console.log('  ' + 'Metric'.padEnd(24) + BOT_MODES.map(m => m.slice(0, 6).padStart(8)).join(''));
  for (const metric of ['held', 'played', 'savedForBig', 'wastedOnSmall']) {
    let line = '  ' + metric.padEnd(24);
    for (const m of BOT_MODES) {
      const val = agg[m].opsec[metric];
      line += String(val).padStart(7) + ' ';
    }
    console.log(line);
  }
  // Efficiency: % of OPSEC plays on big threats
  let effLine = '  ' + 'efficiency (%)'.padEnd(24);
  for (const m of BOT_MODES) {
    const played = agg[m].opsec.played;
    const big = agg[m].opsec.savedForBig;
    const pct = played > 0 ? (big / played * 100).toFixed(0) : 'N/A';
    effLine += `${String(pct).padStart(5)}%  `;
  }
  console.log(effLine);
  console.log();

  // Property color diversity
  console.log(`\u2500\u2500 PROPERTY COLOR DISTRIBUTION ${'─'.repeat(30)}`);
  const allColors = Object.keys(G.COLORS);
  console.log('  ' + 'Color'.padEnd(14) + 'Size' + BOT_MODES.map(m => m.slice(0, 6).padStart(8)).join(''));
  for (const color of allColors) {
    const info = G.COLORS[color];
    let line = '  ' + color.padEnd(14) + String(info.size).padStart(3) + ' ';
    for (const m of BOT_MODES) {
      const count = agg[m].colorDistribution[color] || 0;
      line += String(count).padStart(7) + ' ';
    }
    console.log(line);
  }
  // Average colors used at game end
  let colLine = '  ' + 'Avg colors used'.padEnd(18);
  for (const m of BOT_MODES) {
    const avg = agg[m].endColorsUsed.length > 0
      ? (agg[m].endColorsUsed.reduce((s, v) => s + v, 0) / agg[m].endColorsUsed.length).toFixed(1) : '0';
    colLine += avg.padStart(7) + ' ';
  }
  console.log(colLine);
  console.log();

  // Set completion curve
  console.log(`\u2500\u2500 SET COMPLETION CURVE (avg sets at turn N) ${'─'.repeat(16)}`);
  const checkpoints = [5, 10, 15, 20, 25, 30];
  console.log('  ' + 'Turn'.padEnd(10) + BOT_MODES.map(m => m.slice(0, 6).padStart(8)).join(''));
  for (const turn of checkpoints) {
    let line = '  ' + String(turn).padEnd(10);
    for (const m of BOT_MODES) {
      const data = agg[m].setProgressionByTurn[turn];
      const avg = data && data.length > 0
        ? (data.reduce((s, v) => s + v, 0) / data.length).toFixed(2) : 'N/A';
      line += String(avg).padStart(7) + ' ';
    }
    console.log(line);
  }
  console.log();

  // End state summary
  console.log(`\u2500\u2500 END STATE AVERAGES ${'─'.repeat(39)}`);
  console.log('  ' + 'Metric'.padEnd(24) + BOT_MODES.map(m => m.slice(0, 6).padStart(8)).join(''));
  for (const [label, key] of [['Completed sets', 'endSets'], ['Bank value', 'endBankValues'], ['Total properties', 'endPropCounts']]) {
    let line = '  ' + label.padEnd(24);
    for (const m of BOT_MODES) {
      const arr = agg[m][key];
      const avg = arr.length > 0 ? (arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1) : '0';
      line += avg.padStart(7) + ' ';
    }
    console.log(line);
  }
  console.log();

  // Key findings
  console.log(`\u2500\u2500 KEY FINDINGS ${'─'.repeat(45)}`);

  // 1. Mode differentiation
  const winSpread = sortedWins[0][1] - sortedWins[sortedWins.length - 1][1];
  if (winSpread < N * 0.08) console.log(`  \u26A0 Win rates too close \u2014 modes not differentiated enough (spread: ${winSpread})`);
  else if (winSpread > N * 0.5) console.log(`  \u26A0 One mode dominates \u2014 balance issue (spread: ${winSpread})`);
  else console.log(`  \u2713 Win spread healthy (${sortedWins[0][0]}:${sortedWins[0][1]} to ${sortedWins[sortedWins.length-1][0]}:${sortedWins[sortedWins.length-1][1]})`);

  // 2. Robotic patterns
  for (const m of BOT_MODES) {
    const plays = agg[m].playsPerTurn;
    const always3 = plays.filter(p => p >= 3).length / (plays.length || 1);
    if (always3 > 0.7) console.log(`  \u26A0 ${m}: plays all 3 cards ${(always3*100).toFixed(0)}% of turns \u2014 too mechanical`);

    const firstPlays = agg[m].firstPlayCounts;
    const totalFirst = Object.values(firstPlays).reduce((s, v) => s + v, 0);
    for (const [action, count] of Object.entries(firstPlays)) {
      if (count / totalFirst > 0.6) console.log(`  \u26A0 ${m}: always plays '${action}' first (${(count/totalFirst*100).toFixed(0)}%) \u2014 predictable`);
    }

    const leaderPct = agg[m].targetLeaderPct.total > 0
      ? agg[m].targetLeaderPct.count / agg[m].targetLeaderPct.total : 0;
    if (leaderPct < 0.2 && m !== 'chud' && m !== 'random')
      console.log(`  \u26A0 ${m}: rarely targets leader (${(leaderPct*100).toFixed(0)}%) \u2014 no threat awareness`);

    const opsecEff = agg[m].opsec.played > 0 ? agg[m].opsec.savedForBig / agg[m].opsec.played : 1;
    if (opsecEff < 0.3 && agg[m].opsec.played > 10)
      console.log(`  \u26A0 ${m}: OPSEC efficiency only ${(opsecEff*100).toFixed(0)}% \u2014 wastes defense on small threats`);
  }
  console.log();

  return agg;
}

/* ── Main ──────────────────────────────────────────────────────────── */

module.exports = { runMatches, runGame, printMatrix, runAndAnalyze, mixedMatrix, lineupsFor, BOT_MODES };

if (require.main === module) {
  const [first, second, third] = process.argv.slice(2);
  if (first === 'matrix') {
    printMatrix(parseInt(second) || 500, third || 'matrix');
  } else {
    runAndAnalyze(parseInt(first) || 500);
  }
}
