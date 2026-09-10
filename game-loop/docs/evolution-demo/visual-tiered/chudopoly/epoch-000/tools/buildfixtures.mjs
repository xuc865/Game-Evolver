#!/usr/bin/env node
/**
 * tools/buildfixtures.mjs — fixtures BUILT THROUGH ENGINE CALLS (§0.7's second
 * clause; the precedent is dragtest.mjs's boards, which ARCHITECTURE.md names).
 * HARNESS-AGENT-OWNED (§1, §8).
 *
 * Two states the surface census (tools/coverage.mjs) proved no gate had ever
 * seen, and that RECORDING structurally cannot reach:
 *
 *   approach-pay   the ARMED seat being CHARGED — `.prompt-why.is-approach`,
 *                  the "paying with a card out of a complete set ends it"
 *                  warning. Every transcript in tools/fixtures/ is recorded
 *                  from a seat that plays as hard as it can; that seat arms
 *                  and then WINS. Measured over the committed 137-broadcast
 *                  3p transcript: states where the local seat is on final
 *                  approach AND owes a payment = 0. The passive seat never
 *                  arms at all, so no camera angle a recording offers holds
 *                  this state.
 *
 *   win-points     a game DECIDED ON POINTS — `endReason: 'stalemate'`, the
 *                  win screen's `.is-decider` emphasis. The engine ends a game
 *                  this way after 16 deck cycles or a dry idle round; the
 *                  shipped bots close games out long before either (measured
 *                  stalemate rate 1.79% over 2,400 sims), so waiting for a
 *                  recording to produce one is a lottery ticket per run.
 *
 * HOW HONESTY IS KEPT, since no server sent these broadcasts:
 *   • Boards are furnished the way dragtest furnishes its boards (cards
 *     spliced from the game's own deck — conservation holds by construction),
 *     and every STATE TRANSITION the fixture is ABOUT goes through the
 *     engine's public API: the arming set is COMPLETED BY playProperty (so
 *     syncSets arms it), the charge is a real playAction, the stalemate is
 *     endTurn's own dry-idle ending. Nothing pokes `finalApproach`,
 *     `pendingAction`, `winner` or `endReason` by hand.
 *   • G.validateState must pass on the final state — the same integrity check
 *     server/broadcast.js runs before every real broadcast — and the engine
 *     result of every call is asserted, so a refused move fails the build
 *     instead of shipping a fixture the game disowns.
 *
 * Run: node tools/buildfixtures.mjs        (writes only if the build succeeds)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  ROOT, FIXTURE_DIR, ensureDir, green, red, dim, bold, EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';

const require = createRequire(path.join(ROOT, 'package.json'));
const G = require(path.join(ROOT, 'game.js'));

let code = EXIT_PASS;
const fail = (m) => { code = EXIT_FAIL; console.log(`  ${red('✗')} ${m}`); };
console.log(bold('buildfixtures') + dim('  engine-built states recording cannot reach (§0.7)'));

/* ── the dragtest board vocabulary ──────────────────────────────────────── */

function fresh(names, seed) {
  const state = G.createGame(names.map((n, i) => ({ id: `p${i + 1}`, name: n })), { seed });
  state.deck = G.buildDeck();
  state.discardPile = [];
  state.pendingAction = null;
  state.players.forEach((p) => { p.hand = []; p.bank = []; p.properties = {}; p.upgrades = {}; });
  state.turnPhase = 'play';
  state.currentPlayerIndex = 0;
  state.playsRemaining = 3;
  state.cardTotal = null;
  state._handSnapshot = 0;
  return state;
}

const take = (state, pick, what) => {
  const i = state.deck.findIndex(pick);
  if (i < 0) throw new Error(`the deck does not contain ${what}`);
  return state.deck.splice(i, 1)[0];
};
const putProperty = (state, p, color) => {
  const c = take(state, (x) => x.type === 'property' && x.color === color, `a ${color} property`);
  (p.properties[color] ||= []).push({ ...c, placedColor: color });
  return c;
};
const toHand = (state, p, pick, what) => {
  const c = take(state, pick, what);
  p.hand.push(c);
  return c;
};

/** The engine result guard: a refused move is a build failure, never a shrug. */
const must = (res, what) => {
  if (res && res.error) throw new Error(`engine refused ${what}: ${res.error}`);
  return res;
};

const stateMessage = (state, code_) => ({
  type: 'state',
  code: code_,
  phase: state.phase,
  players: state.players.map((p) => ({ id: p.id, name: p.name, connected: true, isBot: p.id !== 'p1' })),
  hostId: 'p1',
  game: G.getPlayerView(state, 'p1'),
  turnTimer: null,
  responseTimer: null,
});

function write(name, description, state) {
  const integrity = G.validateState(state);
  if (!integrity.ok) throw new Error(`validateState refused '${name}': ${integrity.error}`);
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({
    $schema: 'chud-fixture/1',
    name,
    description,
    builtBy: 'tools/buildfixtures.mjs (engine calls, §0.7; validateState-checked)',
    seed: `build:${name}`,
    selfId: 'p1',
    room: 'BUILT',
    recordedAt: new Date().toISOString(),
    states: [stateMessage(state, 'BUILT')],
  }, null, 1) + '\n');
  console.log(`  ${green('✓')} ${name.padEnd(16)} ${dim(`${Math.round(fs.statSync(file).size / 1024)}KB`)}`);
}

ensureDir(FIXTURE_DIR);

/* ── approach-pay ───────────────────────────────────────────────────────── */
try {
  const state = fresh(['HARNESS', 'KESTREL', 'VULTURE'], 'build:approach-pay');
  const [me, foe, third] = state.players;

  // Two complete sets down, the third one card short — then the arming card is
  // PLAYED, so syncSets does the arming exactly as it does in a live game.
  putProperty(state, me, 'darkblue'); putProperty(state, me, 'darkblue');       // 2/2
  putProperty(state, me, 'brown'); putProperty(state, me, 'brown');             // 2/2
  putProperty(state, me, 'lightblue'); putProperty(state, me, 'lightblue');     // 2/3
  const armer = toHand(state, me, (x) => x.type === 'property' && x.color === 'lightblue', 'the third lightblue');
  toHand(state, me, (x) => x.type === 'money', 'a money card');                 // something to pay WITH besides the sets
  toHand(state, me, (x) => x.type === 'money', 'a second money card');

  // The attacker's side: a couple of mats (a charge from an empty board is not
  // a state a real table produces) and ROLL CALL — the charge that needs no
  // target picks, aims at the whole table and creates a plain payment.
  putProperty(state, foe, 'red'); putProperty(state, foe, 'pink');
  putProperty(state, third, 'yellow');
  const rollCall = toHand(state, foe, (x) => x.type === 'action' && x.action === 'roll_call', 'Roll Call');

  must(G.playProperty(state, 'p1', me.hand.indexOf(armer), null), 'the arming play');
  if (!me.finalApproach) throw new Error('the third set completed but syncSets did not arm the seat');
  must(G.endTurn(state, 'p1', null), 'ending the armed turn');
  if (G.currentPlayer(state).id !== 'p2') throw new Error(`turn went to ${G.currentPlayer(state).id}, not the attacker`);
  must(G.playAction(state, 'p2', foe.hand.indexOf(rollCall), {}), 'the Roll Call charge');

  const pa = state.pendingAction;
  const responders = G.pendingResponders(state);
  if (!pa || pa.type !== 'payment') throw new Error(`no payment pending after Roll Call (${pa?.type})`);
  if (!responders.includes('p1')) throw new Error(`p1 not among responders (${responders.join(',')})`);
  if (!me.finalApproach) throw new Error('the charge disarmed the seat, which is not the state this exists for');

  write('approach-pay',
    'The ARMED seat being CHARGED: p1 completes its third set through playProperty (syncSets '
    + 'arms it), ends the turn, and the next seat plays Roll Call — a real pendingAction the '
    + 'armed seat must answer. The state prompt.js approachWarning() exists for, held by no '
    + 'recorded transcript (the recording seat arms and wins; the passive seat never arms).',
    state);
} catch (e) {
  fail(`approach-pay: ${e.message}`);
}

/* ── win-points ─────────────────────────────────────────────────────────── */
try {
  const state = fresh(['HARNESS', 'KESTREL', 'VULTURE'], 'build:win-points');
  const [me, foe, third] = state.players;

  // A table worth ranking: p1 leads on sets (the stalemate basis the engine
  // will pick), the others hold real boards.
  putProperty(state, me, 'darkblue'); putProperty(state, me, 'darkblue');
  putProperty(state, me, 'brown'); putProperty(state, me, 'brown');
  putProperty(state, me, 'red');
  putProperty(state, foe, 'lightblue'); putProperty(state, foe, 'lightblue'); putProperty(state, foe, 'lightblue');
  putProperty(state, foe, 'green');
  putProperty(state, third, 'yellow'); putProperty(state, third, 'pink');

  // Hands stay put (nobody plays in a dry idle round); the REST of the deck
  // sits in banks — which is what the endgame of an attrition table looks
  // like — so deck AND discard are genuinely empty, cards conserved.
  for (const p of state.players) for (let i = 0; i < 4; i++) toHand(state, p, () => true, 'a hand card');
  for (let i = 0; state.deck.length; i++) state.players[i % 3].bank.push(state.deck.pop());
  state._handSnapshot = state.players.reduce((n, p) => n + p.hand.length, 0);
  state._idleTurns = 0;

  // The ending is the ENGINE'S: a full idle round on a dry table, through
  // endTurn itself (game.js: _idleTurns >= activeCount → endInStalemate).
  for (let i = 0; i < 5 && state.phase === 'playing'; i++) {
    must(G.endTurn(state, G.currentPlayer(state).id, null), `idle end-turn ${i + 1}`);
  }
  if (state.phase !== 'finished') throw new Error('a full dry idle round did not end the game');
  if (state.endReason !== 'stalemate') throw new Error(`endReason '${state.endReason}', wanted 'stalemate'`);
  if (state.winner !== 'p1') throw new Error(`winner '${state.winner}', expected the sets leader p1`);

  write('win-points',
    'A game DECIDED ON POINTS: dry deck and discard, a full idle round, and endTurn\'s own '
    + 'stalemate ending ranks the table (sets, then net worth). The win screen\'s ATTRITION '
    + 'copy and .is-decider emphasis exist only under endReason \'stalemate\', which no '
    + 'recorded game reaches (measured 1.79% over 2,400 sims).',
    state);
} catch (e) {
  fail(`win-points: ${e.message}`);
}

console.log(code === EXIT_PASS ? green(bold('buildfixtures: PASS')) : red(bold('buildfixtures: FAIL')));
process.exit(code);
