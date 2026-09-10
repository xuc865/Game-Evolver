// tools/lib/replay.js — replay-based evaluation of bot policies against recorded games.
//
// The missing instrument BOT-STRATEGY round 12b names: `simbalance` divides a fixed pot
// among bots, so "stronger against a human" cannot appear in it, and production A/B at
// ~100 games/week cannot resolve a 3-5pp effect inside a season. This library rebuilds
// the exact engine states real games passed through — from the gamelog's recorded event
// stream — and prices a candidate policy with paired rollouts from those states.
//
// Three layers, each independently gated by test/replayeval.test.js:
//
//   1. RECONSTRUCTION. A record's event stream is replayed through the REAL engine —
//      every command is re-issued (game.js playAsMoney/playProperty/playAction/
//      respondToAction/endTurn/...), never re-implemented, with the deck "rigged" so
//      each draw yields the recorded cards. Every event the engine emits is compared
//      field-by-field against the record as it happens, and the final boards are
//      compared against the record's boards; a game that cannot be reproduced exactly
//      is REJECTED, not approximated.
//   2. DETERMINIZATION. At a decision point the only unknown is the deck order: hands
//      are known (draw/deal events are unredacted in the retained stream), and the
//      deck's multiset is buildDeck(rules.deck) minus every visible card. Each rollout
//      samples a fresh uniform order of exactly that multiset — the true conditional
//      distribution, given shuffles are uniform.
//   3. EVALUATION. Subject and baseline policies are rolled out from the same states
//      with the same determinization and the same seeded bot RNG (paired), and the
//      win-probability delta is aggregated with a cluster bootstrap BY GAME (decision
//      points within one game are not independent).
//
// Known limits (stated, not hidden — see docs/replayeval.md):
//   * Rollout opponents are bots (recorded botModes; `humanlike` stands in for human
//     seats), so deltas are priced under bot continuation play. Acknowledged proxy.
//   * Records whose event stream was truncated by game.js EVENT_LOG_MAX (400) cannot
//     be reconstructed (their opening deals are gone) and are skipped, counted.
//   * A pending action that was OPSEC-blocked never reveals its exact target card, so
//     the replay substitutes a legal one; the post-block state is identical either way.

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const G = require(path.join(__dirname, '..', '..', 'game.js'));
const Bot = require(path.join(__dirname, '..', '..', 'bot.js'));
const BI = Bot._internal;

/* ── record loading ──────────────────────────────────────────────────── */

function loadRecords(file, { minTurns = 5 } = {}) {
  const text = file.endsWith('.gz')
    ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')
    : fs.readFileSync(file, 'utf8');
  const records = [];
  const skipped = { unparseable: 0, botOnly: 0, short: 0, truncated: 0, noEvents: 0, legacyWalkover: 0 };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { skipped.unparseable++; continue; }
    if ((r.humanSeats || 0) === 0) { skipped.botOnly++; continue; }
    if ((r.turns || 0) < minTurns) { skipped.short++; continue; }
    const evs = Array.isArray(r.events) ? r.events : null;
    if (!evs || !evs.length) { skipped.noEvents++; continue; }
    // A truncated stream lost its opening deals; reconstruction is impossible.
    if (evs.length < (r.eventsTotal || evs.length) || evs[0].t !== 'game_start') {
      skipped.truncated++; continue;
    }
    // Pre-2026-08-11 walkovers (fixed in 779b1a1): the old absent.js hand-stamped the
    // winner with NO win event and a null endReason, so the record's own event stream
    // does not contain its ending — gamelog.js's header calls out exactly this defect.
    if (r.winner != null && r.endReason == null
      && !evs.some(e => e.t === 'win' || e.t === 'stalemate')) {
      skipped.legacyWalkover++; continue;
    }
    records.push(r);
  }
  return { records, skipped };
}

/* ── replay state construction ───────────────────────────────────────── */

// Fisher-Yates with rand() -> 1-eps picks j === i at every step: the engine's own
// reshuffleDiscard becomes an ORDER-PRESERVING concat ([...deck, ...discard]), which is
// what lets the driver stage the next recorded draw at the end of the discard pile and
// have it come off the top of the deck after the engine's own shuffle event fires.
const IDENTITY_RAND = () => 1 - Number.EPSILON;

let placeholderSeq = 0;
function placeholder() {
  return { id: 'ph:' + (++placeholderSeq), type: 'money', name: 'UNSEEN', value: 0 };
}

class ReplayError extends Error {
  constructor(msg, ctx) { super(msg); this.ctx = ctx; }
}

function cloneCard(c) { return { ...c }; }

// Build the state as of "after the first turn's draw" from the record's opening events.
// createGame() supplies every structural field (and keeps this constructor honest against
// engine drift); hands/deck/events are then re-pointed at what the RECORD says.
function makeRiggedState(record) {
  const evs = record.events;
  const start = evs[0];
  if (start.t !== 'game_start') throw new ReplayError('record does not open with game_start');
  const players = start.order.map(id => ({ id, name: start.names[id] }));
  const state = G.createGame(players, { ...record.rules, seed: 'replay:init', shuffleSeats: false });
  for (const p of state.players) p.hand = [];
  state.discardPile = [];
  state.deck = Array.from({ length: state.cardTotal }, placeholder);
  state._rng = IDENTITY_RAND;

  let i = 1;
  while (evs[i] && evs[i].t === 'deal') {
    const p = state.players.find(x => x.id === evs[i].to);
    if (!p || !Array.isArray(evs[i].cards)) throw new ReplayError('bad deal event', { seq: evs[i].seq });
    p.hand = evs[i].cards.map(cloneCard);
    state.deck.splice(0, evs[i].cards.length);
    i++;
  }
  if (!evs[i] || evs[i].t !== 'turn_start') throw new ReplayError('expected turn_start after deals');
  i++;
  if (!evs[i] || evs[i].t !== 'draw') throw new ReplayError('expected first draw');
  const cp = state.players.find(x => x.id === evs[i].to);
  cp.hand.push(...evs[i].cards.map(cloneCard));
  state.deck.splice(0, evs[i].cards.length);
  i++;

  state.turnPhase = 'play';
  state.playsRemaining = 3;
  state._handSnapshot = state.players.reduce((s, p) => s + p.hand.length, 0);
  state._idleTurns = 0;
  state.stats = { turns: 1, cardsPlayed: {}, payments: { count: 0, total: 0, biggest: 0 }, propertiesStolen: {} };
  state.events = evs.slice(0, i).map(e => ({ ...e }));
  state.eventSeq = evs[i - 1].seq;
  return { state, cursor: i };
}

// Seed-replay construction for the verification gate: createGame really is the game.
function makeSeededState(record) {
  const evs = record.events;
  const start = evs[0];
  const preShuffle = (record.seats || []).map(s => ({ id: s.id, name: s.name }));
  for (const shuffleSeats of [true, false]) {
    const state = G.createGame(preShuffle.map(p => ({ ...p })),
      { ...record.rules, seed: record.seed, shuffleSeats });
    if (state.players.map(p => p.id).join(',') === start.order.join(',')) {
      // Creation covered game_start + deals + turn_start + first draw; find the cursor.
      let i = 1;
      while (evs[i] && evs[i].t === 'deal') i++;
      i++; // turn_start
      if (!evs[i] || evs[i].t !== 'draw') throw new ReplayError('expected first draw');
      i++;
      // The creation events must already match the record (this IS the gate).
      compareEventRange(state.events, evs.slice(0, i), record);
      return { state, cursor: i };
    }
  }
  throw new ReplayError('seed replay cannot reproduce seat order', { code: record.code });
}

/* ── event comparison ────────────────────────────────────────────────── */

const idsOf = cards => (cards || []).map(c => (c && c.id !== undefined ? c.id : null));

// Field-by-field comparison on the parts of an event that describe the BOARD, ignoring
// prose and seq. Draw/deal card identity is the strongest check in the file.
function eventKey(ev) {
  const k = { t: ev.t };
  for (const f of ['actor', 'to', 'from', 'target', 'against', 'color', 'toColor', 'amount',
    'count', 'depth', 'action', 'reason', 'winner', 'sets', 'plays', 'cycle', 'deckCount',
    'swapHalf', 'swapWith']) {
    if (ev[f] !== undefined) k[f] = ev[f];
  }
  if (ev.card) k.card = ev.card.id;
  if (ev.cards) k.cards = idsOf(ev.cards);
  if (ev.gave) k.gave = ev.gave.id;
  if (ev.took) k.took = ev.took.id;
  if (ev.targets) k.targets = ev.targets.slice();
  return JSON.stringify(k);
}

function compareEventRange(got, want, record, at) {
  if (got.length !== want.length) {
    throw new ReplayError(`event count diverged: engine emitted ${got.length}, record has ${want.length}`,
      { code: record.code, at, got: got.map(e => e.t), want: want.map(e => e.t) });
  }
  for (let i = 0; i < got.length; i++) {
    const a = eventKey(got[i]), b = eventKey(want[i]);
    if (a !== b) {
      throw new ReplayError('event diverged from record', { code: record.code, seq: want[i].seq, got: a, want: b });
    }
  }
}

/* ── deck rigging ────────────────────────────────────────────────────── */

const COMMAND_EVENTS = new Set(['play_money', 'play_property', 'play_action', 'opsec',
  'payment', 'insolvent', 'action_blocked', 'set_stolen', 'steal', 'swap', 'scoop',
  'discard', 'turn_end', 'move_property', 'move_upgrade', 'turn_timeout', 'response_timeout']);

// Find the draw the upcoming engine call will perform (if any), and whether the engine
// will reshuffle the discard first. The record itself says: a `shuffle` event strictly
// between here and the draw means the rig goes through the discard pile.
//
// `chainSkips` names events that belong to the CURRENT call's own emission chain even
// though they normally begin a new call at the cursor — a `discard` command's chain is
// [discard, turn_end, turn_start, draw], and stopping at that turn_end left the
// turn-start draw unrigged (the deck popped placeholders; caught by the event compare
// on 63 of 154 production records before this parameter existed).
function upcomingDraw(evs, from, chainSkips = []) {
  let viaShuffle = false;
  const skips = [...chainSkips];
  for (let i = from; i < evs.length; i++) {
    const t = evs[i].t;
    if (t === 'draw') return { cards: evs[i].cards || [], viaShuffle };
    if (t === 'shuffle') { viaShuffle = true; continue; }
    if (t === 'win' || t === 'stalemate') return null;
    if (skips.length && skips[0] === t) { skips.shift(); continue; }
    if (COMMAND_EVENTS.has(t)) return null;
  }
  return null;
}

function takeCardById(pile, id) {
  const i = pile.findIndex(c => c.id === id);
  return i >= 0 ? pile.splice(i, 1)[0] : null;
}

function takePlaceholder(state) {
  const i = state.deck.findIndex(c => typeof c.id === 'string' && c.id.startsWith('ph:'));
  if (i < 0) return null;
  return state.deck.splice(i, 1)[0];
}

// Fisher-Yates driven to a plan: hand the engine a rand() stream whose first `need.length`
// draws park need[t] at slot n-1-t (the pop order) and whose remainder walks the identity.
// This is what lets a draw be rigged THROUGH the engine's own reshuffle even when the
// same call pushes cards onto the discard first (PCS Orders discards itself, endTurn
// discards to the hand limit, a scoop dumps a whole board) — the pre-shuffle array is
// predicted appends-included, and the permutation places the recorded cards on top.
function planShuffleRng(predicted, need, record) {
  const ids = predicted.map(c => c.id);
  const n = ids.length;
  const jseq = [];
  for (let t = 0; t < need.length; t++) {
    const i = n - 1 - t;
    if (i < 1) break;                    // a 1-slot remainder is forced by elimination
    const jj = ids.indexOf(need[t].id);
    if (jj < 0) throw new ReplayError('rig: card missing from predicted shuffle pool',
      { code: record.code, card: need[t].id });
    jseq.push((jj + 0.5) / (i + 1));     // floor(r*(i+1)) === jj exactly
    [ids[i], ids[jj]] = [ids[jj], ids[i]];
  }
  let k = 0;
  return () => (k < jseq.length ? jseq[k++] : 1 - Number.EPSILON);
}

// Stage `cards` so the engine's own pops yield them in order. Conservation is strict:
// every staged card either replaces one placeholder (first sighting) or is already in
// the deck, the discard, or the cards the call itself is about to append to the discard.
function rigDraw(state, cards, viaShuffle, record, appends = []) {
  const need = [];
  for (const c of cards) {
    let real = state.deck.find(x => x.id === c.id)
      || state.discardPile.find(x => x.id === c.id)
      || appends.find(x => x.id === c.id);
    if (!real) {
      const ph = takePlaceholder(state);
      if (!ph) throw new ReplayError('rig: card unseen but no placeholder left', { code: record.code, card: c.id });
      real = cloneCard(c);
      state.deck.push(real);             // takes the consumed placeholder's slot
    }
    need.push(real);
  }
  if (viaShuffle) {
    // The engine will run shuffle([...deck, ...discard, ...appends]) with state._rng;
    // hand it the planned permutation instead of the identity for this one call.
    state._rng = planShuffleRng([...state.deck, ...state.discardPile, ...appends], need, record);
    return;
  }
  // No reshuffle: pops come straight off the deck end.
  for (const card of need) takeCardById(state.deck, card.id);
  for (let i = need.length - 1; i >= 0; i--) state.deck.push(need[i]);
}

// What a call pushes onto the discard pile BEFORE any reshuffle it triggers — needed to
// predict the reshuffle pool. Orders mirror the engine exactly (scoop(): upgrades, then
// hand popped, then bank popped, then each property zone popped).
function predictAppends(state, t, ev) {
  const p = ev.actor !== undefined ? G.getPlayer(state, ev.actor) : null;
  if (t === 'play_action') {
    const card = p ? p.hand.find(c => c.id === ev.card.id) : null;
    return card ? [card] : [];
  }
  if (t === 'discard') {
    return idsOf(ev.cards).map(id => p.hand.find(c => c.id === id)).filter(Boolean);
  }
  if (t === 'scoop' && p) {
    const out = [];
    for (const ups of Object.values(p.upgrades || {})) for (const u of ups) if (u && typeof u === 'object') out.push(u);
    out.push(...[...p.hand].reverse());
    out.push(...[...p.bank].reverse());
    for (const cards of Object.values(p.properties || {})) out.push(...[...cards].reverse());
    return out;
  }
  return [];
}

/* ── the driver ──────────────────────────────────────────────────────── */

function handIndexOf(state, playerId, cardId) {
  const p = G.getPlayer(state, playerId);
  const i = p ? p.hand.findIndex(c => c.id === cardId) : -1;
  if (i < 0) throw new ReplayError('card not in hand', { playerId, cardId });
  return i;
}

// Scan forward for the event that resolves (or blocks) the pending action a play_action
// is about to open, to recover the opts playAction() needs up front.
function scanResolution(evs, from, types) {
  for (let i = from; i < evs.length; i++) {
    if (types.has(evs[i].t)) return evs[i];
  }
  return null;
}

function anyCompleteSetColor(target) {
  for (const col of Object.keys(target.properties || {})) {
    if (G.isSetComplete(target, col)) return col;
  }
  return null;
}

function anyStealableCard(target, { requisitionableOnly }) {
  for (const [col, cards] of Object.entries(target.properties || {})) {
    if (!cards.length) continue;
    if (requisitionableOnly && !G.zoneRequisitionable(target, col)) continue;
    return cards[0].id;
  }
  return null;
}

function playActionOpts(state, record, cursor, ev) {
  const evs = record.events;
  const action = ev.action;
  const actor = ev.actor;
  // DEFINITIVE outcomes only. `opsec` and `response_timeout` are waypoints, not endings:
  // an OPSEC'd steal that is counter-OPSEC'd still RESOLVES, and treating the first
  // opsec as "blocked, target set unknowable" replayed 9 of 154 production games with a
  // substituted target that the real chain then went on to contradict. Every pending
  // ends in its resolution event, an action_blocked (concede and timeout-concede both
  // emit it), or a scoop unwinding it — scan for exactly those.
  const blockedTypes = new Set(['action_blocked', 'scoop']);

  if (action === 'pcs_orders' || action === 'roll_call' || action === 'surge_ops') return {};
  if (action === 'upgrade' || action === 'foc') {
    const up = scanResolution(evs, cursor + 1, new Set(['upgrade']));
    if (!up) throw new ReplayError('upgrade play without upgrade event', { seq: ev.seq });
    return { targetColor: up.color };
  }
  if (action === 'finance_office') {
    const d = scanResolution(evs, cursor + 1, new Set(['demand']));
    if (!d) throw new ReplayError('finance_office without demand event', { seq: ev.seq });
    return { targetId: d.target };
  }
  if (action === 'rent') {
    const r = scanResolution(evs, cursor + 1, new Set(['rent_charged']));
    if (!r) throw new ReplayError('rent play without rent_charged event', { seq: ev.seq });
    const isWild = (ev.card.colors || [])[0] === 'any';
    return { targetColor: r.color, targetId: isWild ? r.targets[0] : undefined };
  }
  const victimOf = res => res.t === 'scoop' ? res.actor : res.t === 'action_blocked' ? res.target : null;
  if (action === 'inspector_general') {
    const res = scanResolution(evs, cursor + 1, new Set(['set_stolen', ...blockedTypes]));
    if (!res) throw new ReplayError('inspector_general never resolves', { seq: ev.seq });
    if (res.t === 'set_stolen') return { targetId: res.from, targetColor: res.color };
    const targetId = victimOf(res);
    const target = G.getPlayer(state, targetId);
    // A blocked IG never reveals which set was named; any complete set reproduces the
    // exact post-block state (the pendingAction is transient and the block clears it).
    return { targetId, targetColor: anyCompleteSetColor(target) };
  }
  if (action === 'midnight_requisition' || action === 'chud') {
    const res = scanResolution(evs, cursor + 1, new Set(['steal', ...blockedTypes]));
    if (!res) throw new ReplayError(action + ' never resolves', { seq: ev.seq });
    if (res.t === 'steal') return { targetId: res.from, targetCardId: res.card.id };
    const targetId = victimOf(res);
    const target = G.getPlayer(state, targetId);
    return {
      targetId,
      targetCardId: anyStealableCard(target, { requisitionableOnly: action === 'midnight_requisition' }),
    };
  }
  if (action === 'tdy_orders') {
    const res = scanResolution(evs, cursor + 1, new Set(['swap', ...blockedTypes]));
    if (!res) throw new ReplayError('tdy_orders never resolves', { seq: ev.seq });
    if (res.t === 'swap') return { targetId: res.target, myCardId: res.gave.id, targetCardId: res.took.id };
    const targetId = victimOf(res);
    const target = G.getPlayer(state, targetId);
    const actorP = G.getPlayer(state, actor);
    return {
      targetId,
      myCardId: anyStealableCard(actorP, { requisitionableOnly: true }),
      targetCardId: anyStealableCard(target, { requisitionableOnly: true }),
    };
  }
  throw new ReplayError('unknown action ' + action, { seq: ev.seq });
}

// The seat's recorded choice, in applyBotAction-compatible shape (indices resolved later).
function recordedActionOf(state, record, cursor, ev) {
  switch (ev.t) {
    case 'play_money': return { type: 'play_money', cardId: ev.card.id };
    case 'play_property': return { type: 'play_property', cardId: ev.card.id, targetColor: ev.color };
    case 'play_action': {
      const opts = playActionOpts(state, record, cursor, ev);
      return { type: 'play_action', cardId: ev.card.id, action: ev.action, ...opts };
    }
    case 'move_property':
      if (ev.swapWith !== undefined && ev.swapHalf === 0) {
        return { type: 'swap', cardIdA: ev.card.id, cardIdB: ev.swapWith };
      }
      return { type: 'rearrange', cardId: ev.card.id, toColor: ev.to };
    case 'move_upgrade': return { type: 'rearrange', cardId: ev.card.id, toColor: ev.to };
    case 'discard': return { type: 'end_turn', discardIds: idsOf(ev.cards) };
    case 'turn_end': return { type: 'end_turn', discardIds: undefined };
    case 'scoop': return { type: 'scoop' };
    default: return null;
  }
}

// Drive one record through the engine. `rigged` states rig their draws from the record;
// seeded states draw from their real deck (and the event comparison proves the seed
// reproduces the recorded game). onDecision(state, meta) fires at every play-phase
// decision of a focus seat, BEFORE the recorded command executes.
// Events a call emits BEFORE its anchor event: a payment or steal transferring property
// to a full board shifts a wild (`move_property {forced:true}`) or banks the overflow
// (`banked_property`), and breaking the payer's set banks its upgrades (`upgrade_banked`)
// — all emitted before the `payment`/`steal` event itself, and swapProperties banks a
// stranded upgrade before its own two move_property events. At the cursor these are not
// commands; the command is the next non-passive event, and the whole chain (prefix
// included) is verified against the record after the call runs.
function isPassivePrefix(ev) {
  return ev.t === 'banked_property' || ev.t === 'upgrade_banked'
    || (ev.t === 'move_property' && ev.forced === true);
}

function drive(record, ctx, { focusSeats = null, onDecision = null } = {}) {
  const evs = record.events;
  const state = ctx.state;
  let decisionIndex = 0;

  while (ctx.cursor < evs.length && state.phase === 'playing') {
    let cmdIdx = ctx.cursor;
    while (cmdIdx < evs.length && isPassivePrefix(evs[cmdIdx])) cmdIdx++;
    if (cmdIdx >= evs.length) throw new ReplayError('record ends inside a passive prefix', { code: record.code });
    const ev = evs[cmdIdx];
    const t = ev.t;

    // Timer-authored narration: emitted by server/timers.js, not by any engine command.
    // Mirrored verbatim so event alignment holds; the induced endTurn/accept follows as
    // ordinary discard/turn_end/payment events.
    if (t === 'turn_timeout' || t === 'response_timeout') {
      const { seq, ...payload } = ev;
      G.emit(state, t, payload);
      ctx.cursor++;
      continue;
    }

    const before = state.eventSeq;
    let call = null;   // () => engine result
    let kind = t;

    switch (t) {
      case 'play_money':
        call = () => G.playAsMoney(state, ev.actor, handIndexOf(state, ev.actor, ev.card.id));
        break;
      case 'play_property':
        call = () => G.playProperty(state, ev.actor, handIndexOf(state, ev.actor, ev.card.id), ev.color);
        break;
      case 'play_action': {
        const opts = playActionOpts(state, record, cmdIdx, ev);
        call = () => G.playAction(state, ev.actor, handIndexOf(state, ev.actor, ev.card.id), opts);
        break;
      }
      case 'opsec':
        call = () => G.respondToAction(state, ev.actor, 'opsec');
        break;
      case 'payment':
        call = () => G.respondToAction(state, ev.from, 'accept', idsOf(ev.cards));
        break;
      case 'insolvent':
        call = () => G.respondToAction(state, ev.from, 'accept');
        break;
      case 'action_blocked': case 'set_stolen': case 'steal': case 'swap': {
        // A resolution reached by an ACCEPT: the responder is whatever seat the live
        // pending entry currently points at (depth parity decides who that is).
        const victim = ev.target ?? ev.from;
        const entry = (state.pendingAction?.targets || []).find(x => x.id === victim);
        if (!entry) throw new ReplayError('no pending entry for ' + t, { code: record.code, seq: ev.seq });
        call = () => G.respondToAction(state, entry.responderId, 'accept');
        break;
      }
      case 'move_property':
        if (ev.swapWith !== undefined) {
          call = () => G.swapProperties(state, ev.actor, ev.card.id, ev.swapWith);
        } else {
          call = () => G.moveProperty(state, ev.actor, ev.card.id, ev.to);
        }
        break;
      case 'move_upgrade':
        call = () => G.moveProperty(state, ev.actor, ev.card.id, ev.to);
        break;
      case 'discard': case 'turn_end': {
        const ids = t === 'discard' ? idsOf(ev.cards) : undefined;
        kind = 'end_turn';
        call = () => {
          const res = G.endTurn(state, ev.actor, ids);
          // server/handlers, timers and absent.js all fall back to forceEndTurn when
          // endTurn refuses; the record was produced under that recovery, so mirror it.
          if (res?.error) return G.forceEndTurn(state);
          return res;
        };
        break;
      }
      case 'scoop':
        call = () => G.scoop(state, ev.actor);
        break;
      case 'win':
        // server/absent.js ends a table by walkover through G.finishGame directly when
        // every other seat has left — a server-originated event, like the timer pair.
        call = () => (G.finishGame(state, ev.actor, ev.reason,
          'Walkover — all other players left (replay).'), { ok: true });
        break;
      default:
        throw new ReplayError('unexpected event at cursor: ' + t, { code: record.code, seq: ev.seq });
    }

    // Decision capture: the focus seat, on its own turn, free to play.
    if (onDecision && state.turnPhase === 'play' && !state.pendingAction
      && ev.actor !== undefined && G.currentPlayer(state).id === ev.actor
      && (!focusSeats || focusSeats.has(ev.actor))
      && ['play_money', 'play_property', 'play_action', 'discard', 'turn_end', 'scoop',
        'move_property', 'move_upgrade'].includes(t)) {
      onDecision(state, {
        game: record.code, ts: record.ts, seat: ev.actor,
        turn: state.turnCounter, playsRemaining: state.playsRemaining,
        index: decisionIndex++,
        recorded: recordedActionOf(state, record, cmdIdx, ev),
      });
    }

    if (ctx.rigged) {
      // Events the current call will emit itself before its draw, and which must not
      // stop the lookahead: a discard's own turn_end, a scoop's own turn_end.
      const chainSkips = t === 'discard' ? ['turn_end'] : t === 'scoop' ? ['turn_end'] : [];
      const up = upcomingDraw(evs, cmdIdx + 1, chainSkips);
      if (up) rigDraw(state, up.cards, up.viaShuffle, record, predictAppends(state, t, ev));
    }

    const res = call();
    if (ctx.rigged) state._rng = IDENTITY_RAND;   // a planned shuffle rng is one-call only
    if (res?.error) {
      throw new ReplayError(`engine refused ${kind}: ${res.error}`, {
        code: record.code, seq: ev.seq, turnPhase: state.turnPhase,
        pending: state.pendingAction ? state.pendingAction.action : null,
        current: G.currentPlayer(state).id, actor: ev.actor,
      });
    }

    const emitted = state.eventSeq - before;
    const got = state.events.slice(-emitted);
    const want = evs.slice(ctx.cursor, ctx.cursor + emitted);
    compareEventRange(got, want, record, ev.seq);
    ctx.cursor += emitted;
  }

  if (ctx.cursor < evs.length) {
    throw new ReplayError('game finished before record did', { code: record.code, at: evs[ctx.cursor].seq });
  }
  return state;
}

/* ── final-board verification ────────────────────────────────────────── */

// Color keys are SORTED: object insertion order is presentation, not state (a zone
// emptied by a steal and re-created later lands in a different slot), and the recorded
// board's order reflects the original game's insertion history which a replay cannot
// and need not reproduce. Card order WITHIN a zone is preserved and compared.
function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function boardProjection(p) {
  return {
    id: p.id,
    eliminated: !!p.eliminated,
    finalApproach: !!p.finalApproach,
    handCount: (p.hand || []).length,
    bank: idsOf(p.bank),
    properties: sortKeys(Object.fromEntries(Object.entries(p.properties || {})
      .map(([c, cards]) => [c, idsOf(cards)]).filter(([, ids]) => ids.length))),
    upgrades: sortKeys(Object.fromEntries(Object.entries(p.upgrades || {})
      .map(([c, ups]) => [c, (ups || []).map(u => u.upgradeType || 'upgrade')])
      .filter(([, u]) => u.length))),
  };
}

function verifyFinalBoards(state, record) {
  const got = state.players.map(boardProjection);
  const want = (record.boards || []).map(b => ({
    id: b.id, eliminated: !!b.eliminated, finalApproach: !!b.finalApproach,
    handCount: b.handCount, bank: b.bank || [],
    properties: sortKeys(b.properties || {}), upgrades: sortKeys(b.upgrades || {}),
  }));
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) throw new ReplayError('final boards diverge from record', { code: record.code, got: a, want: b });
  if (state.winner !== record.winner || state.endReason !== record.endReason
    || state.turnCounter !== record.turns) {
    throw new ReplayError('final outcome diverges from record', {
      code: record.code,
      got: { winner: state.winner, endReason: state.endReason, turns: state.turnCounter },
      want: { winner: record.winner, endReason: record.endReason, turns: record.turns },
    });
  }
}

// The full comparable projection, for the seeded-vs-rigged cross-check. The deck is
// compared by LENGTH only: a rigged state's undrawn cards are placeholders by design.
function stateProjection(state) {
  return {
    phase: state.phase, turnPhase: state.turnPhase,
    currentPlayerIndex: state.currentPlayerIndex,
    playsRemaining: state.playsRemaining,
    rearrangesRemaining: state.rearrangesRemaining,
    turnCounter: state.turnCounter,
    shuffleCount: state.shuffleCount || 0,
    deckLength: state.deck.length,
    discard: idsOf(state.discardPile),
    surge: state._surgeOps || 0,
    pending: state.pendingAction ? {
      type: state.pendingAction.type, action: state.pendingAction.action,
      sourceId: state.pendingAction.sourceId, amount: state.pendingAction.amount,
      targets: (state.pendingAction.targets || []).map(x => ({ id: x.id, depth: x.depth, responderId: x.responderId })),
    } : null,
    winner: state.winner, endReason: state.endReason,
    players: state.players.map(p => ({ ...boardProjection(p), hand: idsOf(p.hand) })),
  };
}

/* ── reconstruction entry points ─────────────────────────────────────── */

// Rigged reconstruction of one record; throws ReplayError on any divergence.
// Returns { state, decisions } where decisions are DEEP SNAPSHOTS taken before each
// play-phase command of the focus seats (events/log stripped to keep them light).
function reconstruct(record, { focusSeats = null, collect = true } = {}) {
  const ctx = { ...makeRiggedState(record), rigged: true };
  const decisions = [];
  const focus = focusSeats ? new Set(focusSeats) : null;
  const onDecision = collect ? (state, meta) => {
    decisions.push({ meta, snapshot: snapshotState(state) });
  } : null;
  const state = drive(record, ctx, { focusSeats: focus, onDecision });
  verifyFinalBoards(state, record);
  return { state, decisions };
}

// Seed-replay verification for seeded records: the same inferred commands drive a game
// created purely from (seed, rules, seats) — every emitted event, every drawn card and
// the final boards must match the record. Proves record fidelity AND command inference.
function verifySeeded(record) {
  const ctx = { ...makeSeededState(record), rigged: false };
  const state = drive(record, ctx, {});
  verifyFinalBoards(state, record);
  return state;
}

/* ── snapshots, clones, determinization ──────────────────────────────── */

function snapshotState(state) {
  const events = state.events, log = state.log;
  state.events = []; state.log = [];
  const snap = JSON.parse(JSON.stringify(state));
  state.events = events; state.log = log;
  snap.events = []; snap.log = [];
  return snap;
}

// JSON round-trips drop the non-enumerable determinism hooks createGame installs
// (_rng, per-player _rules); every clone must reinstall both or rulesOf() silently
// falls back to DEFAULT_RULES and the replayed ruleset changes under our feet.
function reviveState(snap, rng = Math.random) {
  const state = JSON.parse(JSON.stringify(snap));
  Object.defineProperty(state, '_rng', { value: rng, enumerable: false, writable: true });
  for (const p of state.players) {
    Object.defineProperty(p, '_rules', { value: state.rules, enumerable: false, writable: true });
  }
  return state;
}

// Replace the (placeholder) deck with a fresh uniform order of exactly the unseen
// multiset: buildDeck(rules.deck) minus every card visible anywhere in the state.
function determinize(state, seed) {
  const rng = G.makeRng('det:' + seed);
  const universe = G.buildDeck(state.rules.deck);
  const visible = new Set();
  const see = c => { if (c && c.id !== undefined) visible.add(c.id); };
  for (const p of state.players) {
    (p.hand || []).forEach(see); (p.bank || []).forEach(see);
    for (const cards of Object.values(p.properties || {})) cards.forEach(see);
    for (const ups of Object.values(p.upgrades || {})) ups.forEach(see);
  }
  (state.discardPile || []).forEach(see);
  for (const id of visible) {
    if (typeof id === 'string') throw new ReplayError('placeholder escaped the deck', { id });
  }
  const unseen = universe.filter(c => !visible.has(c.id));
  if (unseen.length !== state.deck.length) {
    throw new ReplayError(`determinize: conservation broken (${unseen.length} unseen vs deck ${state.deck.length})`);
  }
  state.deck = G.shuffle(unseen, rng);
  state._rng = rng;
  return state;
}

/* ── policies ────────────────────────────────────────────────────────── */

const BASE_MODES = ['random', 'conservative', 'neutral', 'aggressive', 'chud', 'humanlike'];

function modePolicy(mode) {
  const persona = mode.split('@')[0];
  return {
    name: mode, mode,
    decide(state, botId) {
      // chud's holdback lives in the caller, not decideBotPlay (botTakeTurn in prod,
      // the same 0.2 roll in simulate.js's loop) — mirrored here for fidelity.
      if (persona === 'chud' && state.playsRemaining > 0 && state.playsRemaining < 3 && BI.rnd() < 0.2) return null;
      return BI.decideBotPlay(state, botId, mode);
    },
    respondMode: mode,
    respond(state, botId) { return BI.botRespondSync(state, botId, mode); },
    discard(bot, excess) { return BI.chooseDiscards(bot, excess, mode); },
  };
}

// tuned:<dial>=<value>[,<dial>=<value>...]:<mode> — bot.js constants overridden through
// its inert setTuning hook, ARM-SCOPED around every decide/respond/discard exactly like
// the sandbag flag (responses matter here: the escrow's escort and the breaker bars are
// consulted from the response path too). Dials map to the persona's own entry:
//   urgency->BREAK_URGENCY  overpay->BREAK_OVERPAY  denyAt/escort->BREAKER_BAR
//   awareness->CARD_AWARENESS  bait->BAIT_PATIENCE  armedbank->ARMED_BANK_BIAS
//   order->ORDER_ATTENTION  cushionpress->CUSHION_PRESSURE
//   cushiongain->CUSHION_GAIN (global scalar)  selfmargin->BREAKER_SELF_MARGIN (global)
const TUNED_DIALS = {
  urgency: 'BREAK_URGENCY', overpay: 'BREAK_OVERPAY', awareness: 'CARD_AWARENESS',
  bait: 'BAIT_PATIENCE', armedbank: 'ARMED_BANK_BIAS', order: 'ORDER_ATTENTION',
  cushionpress: 'CUSHION_PRESSURE',
};

function tunedPolicy(dialSpec, baseMode) {
  const base = modePolicy(baseMode);
  const persona = baseMode.split('@')[0];
  const opts = { tables: {} };
  for (const pair of dialSpec.split(',')) {
    const [k, raw] = pair.split('=');
    const v = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
    if (TUNED_DIALS[k]) {
      (opts.tables[TUNED_DIALS[k]] ||= {})[persona] = v;
    } else if (k === 'denyAt' || k === 'escort') {
      (opts.tables.BREAKER_BAR ||= {})[persona] = { ...(opts.tables.BREAKER_BAR?.[persona] || {}), [k]: v };
    } else if (k === 'holdback') {
      (opts.tables.HOLDBACK ||= {})[persona] = [v, v];
    } else if (k === 'cushiongain') {
      opts.CUSHION_GAIN = v;
    } else if (k === 'selfmargin') {
      opts.BREAKER_SELF_MARGIN = v;
    } else {
      throw new Error('unknown tuning dial: ' + k);
    }
  }
  const scoped = (fn) => {
    BI.setTuning(opts);
    try { return fn(); } finally { BI.setTuning(null); }
  };
  return {
    ...base,
    name: `tuned:${dialSpec}:${baseMode}`,
    stats: { scopedCalls: 0 },
    tuningOpts: opts,
    decide(state, botId) { this.stats.scopedCalls++; return scoped(() => base.decide(state, botId)); },
    respond(state, botId) { return scoped(() => base.respond(state, botId)); },
    discard(bot, excess) { return scoped(() => base.discard(bot, excess)); },
  };
}

// ── evaluation-only candidates. These NEVER touch bot.js: they wrap a base policy's
// chosen action, which is exactly what makes them priceable without a live code change.

// Round 12b's rejected cash floor, resurrected for pricing: bank instead of laying
// property while the bank cannot cover the largest charge the table can print at us.
// (The measured indictment: neutral lays 118 property cards/100 turns and pays 66.1
// straight back out; humans bank 174M/100 turns and lose half as much board.)
function largestPrintableCharge(state, selfId) {
  let biggest = 5;                       // Finance Office is always printable
  for (const p of state.players) {
    if (p.id === selfId || p.eliminated) continue;
    for (const color of Object.keys(p.properties || {})) {
      const rent = G.calcRent(p, color);
      if (rent > biggest) biggest = rent;
    }
  }
  return biggest;
}

function cashFloorPolicy(baseMode) {
  const base = modePolicy(baseMode);
  return {
    ...base,
    name: 'cashfloor:' + baseMode,
    stats: { triggered: 0 },
    decide(state, botId) {
      const action = base.decide(state, botId);
      if (!action || action.type !== 'play_property') return action;
      const bot = G.getPlayer(state, botId);
      const bank = (bot.bank || []).reduce((s, c) => s + (c.value || 0), 0);
      if (bank >= largestPrintableCharge(state, botId)) return action;
      // Substitute a bank play — but never for the card that completes a set (the
      // always-on completer tier round 13 shipped applies to discards; a floor that
      // ate completions would be a strictly different, worse policy).
      const card = bot.hand[action.cardIndex];
      if (card) {
        const color = action.targetColor || card.color;
        const zone = (bot.properties[color] || []).length;
        const size = G.COLORS[color] ? G.COLORS[color].size : 99;
        if (zone + 1 >= size) return action;   // completing (or overfull-guarded) — keep it
      }
      const bankIdx = bot.hand.reduce((best, c, i) =>
        (c.type !== 'property' && c.type !== 'wild_property'
          && (best < 0 || c.value > bot.hand[best].value)) ? i : best, -1);
      if (bankIdx < 0) return action;
      this.stats.triggered++;
      return { type: 'play_money', cardIndex: bankIdx };
    },
  };
}

// The deliberately-lobotomized policy for the discrimination gate: refuses every
// set-completing property play (round 13's completer-discard defect, as a policy).
function noCompleterPolicy(baseMode) {
  const base = modePolicy(baseMode);
  return {
    ...base,
    name: 'nocompleter:' + baseMode,
    stats: { triggered: 0 },
    decide(state, botId) {
      const action = base.decide(state, botId);
      if (!action || action.type !== 'play_property') return action;
      const bot = G.getPlayer(state, botId);
      const card = bot.hand[action.cardIndex];
      if (!card) return action;
      const color = action.targetColor || card.color;
      const zone = (bot.properties[color] || []).length;
      const size = G.COLORS[color] ? G.COLORS[color].size : 99;
      if (zone + 1 < size) return action;          // not completing — allowed
      this.stats.triggered++;
      const bankIdx = bot.hand.findIndex(c => c.type !== 'property' && c.type !== 'wild_property');
      if (bankIdx >= 0) return { type: 'play_money', cardIndex: bankIdx };
      return null;                                  // nothing bankable: pass
    },
  };
}

// §3.10j sandbagging, priced through bot.js's OWN shelved implementation — setSandbag/
// sandbagGate/sandbagRoll — not a re-derivation. SANDBAG_ENABLED is process-global module
// state, so it is ARM-SCOPED: enabled immediately before every decide()/discard() this
// policy makes and restored to defaults immediately after, so it can never leak into the
// other arm, a baseline policy, or a continuation seat. Leak-proof is gated by a null
// test (sandbag@0 vs bare must be EXACTLY zero — a zero weight consumes no rnd() by
// sandbagGate's own design, so the streams must be identical) and by asserting the
// global flag is off after an evaluation.
function sandbagPolicy(weight, baseMode) {
  const base = modePolicy(baseMode);
  const persona = baseMode.split('@')[0];
  const w = Number(weight);
  if (!Number.isFinite(w) || w < 0 || w > 1) throw new Error('sandbag weight must be 0..1: ' + weight);
  const scoped = (fn) => {
    BI.setSandbag({ enabled: true, weights: { [persona]: w } });
    try { return fn(); } finally { BI.setSandbag(null); }
  };
  return {
    ...base,
    name: `sandbag@${w}:${baseMode}`,
    stats: { held: 0 },
    decide(state, botId) {
      return scoped(() => {
        const action = base.decide(state, botId);
        // Knob telemetry: sandbagRoll caches per (turn, bot, card), so this second query
        // costs no extra rnd() when the planner already rolled, and the same single roll
        // when it did not — either way it is part of THIS policy's stream, applied on
        // every decide, so pairing stays deterministic.
        const bot = G.getPlayer(state, botId);
        if (bot && BI.sandbagHeld(state, bot, botId, persona).length) this.stats.held++;
        return action;
      });
    },
    discard(bot, excess) {
      return scoped(() => base.discard(bot, excess));   // the absolute completer tier reads the flag too
    },
  };
}

// Round 12's closing note (§3.10f direction), as an evaluation-only policy. EXACT
// DEFINITION — the number this prices is only as meaningful as this paragraph:
// When the base policy chose a BUILD or BANK play (play_money, or a play_property that
// does not complete one of our sets), and some opponent W is IN THE WINDOW —
// non-eliminated, NOT on final approach, holding exactly setsToWin-1 completed sets
// (the note's "between the second set and the third"), bank value <= 9M (the note's
// "bank is still 4-9M"), and holding at least one payable card (round 10's rule: never
// a charge that collects nothing) — then substitute the best collectible charge in hand
// aimed at W, in priority order:
//   1. wild rent, targeted at W, charging our highest-rent color (rent > 0);
//   2. Finance Office at W (5M);
//   3. a color rent whose eligible color we can charge for rent > 0 (color rents hit
//      the whole table, W included);
//   4. Roll Call (2M from everyone, W included).
// Anything else the base policy chose — charges, completions, breaker shots, defense,
// rearranges, end-turn — passes through untouched. Deterministic; consumes no rnd().
function rentLeveragePolicy(baseMode) {
  const base = modePolicy(baseMode);
  return {
    ...base,
    name: 'rentlev:' + baseMode,
    stats: { triggered: 0 },
    decide(state, botId) {
      const action = base.decide(state, botId);
      if (!action) return action;
      const bot = G.getPlayer(state, botId);
      if (!bot) return action;

      const isBank = action.type === 'play_money';
      let isBuild = false;
      if (action.type === 'play_property') {
        const card = bot.hand[action.cardIndex];
        if (card) {
          const color = action.targetColor || card.color;
          const size = G.COLORS[color] ? G.COLORS[color].size : 99;
          isBuild = ((bot.properties[color] || []).length + 1) < size;   // completions pass through
        }
      }
      if (!isBank && !isBuild) return action;

      const win = G.setsToWinOf(state);
      const target = state.players.find(p => p.id !== botId && !p.eliminated
        && !p.finalApproach
        && G.completedSets(p) === win - 1
        && (p.bank || []).reduce((s, c) => s + (c.value || 0), 0) <= 9
        && G.payableCards(p).length > 0);
      if (!target) return action;

      const charge = bestChargeAt(state, bot, target);
      if (!charge) return action;
      this.stats.triggered++;
      return charge;
    },
  };
}

function bestChargeAt(state, bot, target) {
  let wildRent = null, finance = null, colorRent = null, rollCall = null;
  for (let i = 0; i < bot.hand.length; i++) {
    const c = bot.hand[i];
    if (c.type === 'rent') {
      const colors = (c.colors[0] === 'any')
        ? Object.keys(bot.properties || {})
        : c.colors.filter(col => (bot.properties[col] || []).length > 0);
      let bestColor = null, bestRent = 0;
      for (const col of colors) {
        const r = G.calcRent(bot, col);
        if (r > bestRent) { bestRent = r; bestColor = col; }
      }
      if (!bestColor) continue;
      if (c.colors[0] === 'any') {
        if (!wildRent || bestRent > wildRent.rent) {
          wildRent = { rent: bestRent, action: { type: 'play_action', cardIndex: i, targetColor: bestColor, targetId: target.id } };
        }
      } else if (!colorRent || bestRent > colorRent.rent) {
        colorRent = { rent: bestRent, action: { type: 'play_action', cardIndex: i, targetColor: bestColor } };
      }
    } else if (c.action === 'finance_office' && !finance) {
      finance = { action: { type: 'play_action', cardIndex: i, targetId: target.id } };
    } else if (c.action === 'roll_call' && !rollCall) {
      rollCall = { action: { type: 'play_action', cardIndex: i } };
    }
  }
  return (wildRent || finance || colorRent || rollCall)?.action || null;
}

// oracle:<mode> — the CHARGE-PLAY CEILING with today's deck, as an evaluation-only
// policy. It answers one question: if a bot spent its charge cards as well as the cards
// allow — window-aware, color-optimal, §3.1c-legal surge stacking, holding charges for
// the window — how much stronger does it get? EXACT DEFINITION:
//
// WINDOW: any opponent, non-eliminated, NOT armed, holding exactly setsToWin-1 completed
// sets, with >= 1 payable card (round 10: never a charge that collects nothing). Among
// several, the one with the highest total board+bank value. (No bank cap, unlike rentlev:
// the scorer below prefers board-biting charges instead of pre-filtering on bank.)
//
// IN THE WINDOW, when the base policy chose anything that is not already a charge:
//   * enumerate every legal charge play in hand under game.js's true targeting rules:
//     color rent (must own >= 1 card of an eligible color; hits every opponent, the
//     window seat included; amount = calcRent at the calcRent-maximal eligible color),
//     wild rent (targeted at the window seat, calcRent-maximal color), Finance Office
//     (5M, targeted), Roll Call (2M from everyone);
//   * score each by collectible-from-window (min(amount, their payable total)) plus
//     DOUBLE the board bite (max(0, collectible - their bank value) — set material is
//     the point, per the owner's original ask);
//   * SURGE (§3.1c: rent only, stacks, spends a play): if plays >= 2, a surge_ops is in
//     hand, and doubling the best rent either newly bites the board or adds >= 2M of
//     collectible, play surge_ops FIRST — the doubled rent follows at the next decide,
//     where this same logic re-selects it (state._surgeOps carries the stack).
//   * substitute the best charge if its collectible >= 1M; if the base action was
//     itself a charge, keep whichever scores higher.
//
// OUT OF THE WINDOW (holding — the multi-turn half rentlev lacked): if no opponent is
// armed, some opponent holds >= setsToWin-2 sets (a window is plausible), and the base
// chose to SPEND a charge asset — playing finance_office/roll_call/a rent whose
// collectible now is < 4M, or banking any charge card as money — then HOLD it: the card
// is hidden from the hand, the base policy re-decides without it (its own rnd stream,
// applied consistently), and the chosen alternative is played instead (a null re-decide
// means pass). At most 3 hides per decision. Charges the base fires for >= 4M, and
// every non-charge action, pass through untouched.
function oracleChargePolicy(baseMode, { hold = true } = {}) {
  const base = modePolicy(baseMode);
  const CHARGE_ACTIONS = new Set(['finance_office', 'roll_call']);
  const isChargeCard = c => c.type === 'rent' || CHARGE_ACTIONS.has(c.action);
  const bankOf = p => (p.bank || []).reduce((s, c) => s + (c.value || 0), 0);
  const payableOf = p => G.payableCards(p).reduce((s, c) => s + (c.value || 0), 0);

  function windowSeat(state, me) {
    const win = G.setsToWinOf(state);
    let best = null, bestVal = -1;
    for (const p of state.players) {
      if (p.id === me || p.eliminated || p.finalApproach) continue;
      if (G.completedSets(p) !== win - 1) continue;
      if (!G.payableCards(p).length) continue;
      const v = payableOf(p);
      if (v > bestVal) { best = p; bestVal = v; }
    }
    return best;
  }

  function bestRent(state, bot) {
    let best = null;
    for (let i = 0; i < bot.hand.length; i++) {
      const c = bot.hand[i];
      if (c.type !== 'rent') continue;
      const colors = c.colors[0] === 'any'
        ? Object.keys(bot.properties || {})
        : c.colors.filter(col => (bot.properties[col] || []).length > 0);
      for (const col of colors) {
        if (!(bot.properties[col] || []).length) continue;
        const r = G.calcRent(bot, col);
        if (r > 0 && (!best || r > best.rent)) best = { i, rent: r, color: col, wild: c.colors[0] === 'any' };
      }
    }
    return best;
  }

  function chargeMenu(state, bot, target) {
    const pay = payableOf(target), bank = bankOf(target);
    const surge = state._surgeOps || 0;
    const mult = 2 ** surge;
    const score = amount => {
      const collect = Math.min(amount, pay);
      return { collect, value: collect + 2 * Math.max(0, collect - bank) };
    };
    const menu = [];
    const rent = bestRent(state, bot);
    if (rent) {
      menu.push({
        ...score(rent.rent * mult), amount: rent.rent * mult, kind: 'rent',
        action: { type: 'play_action', cardIndex: rent.i, targetColor: rent.color,
          targetId: rent.wild ? target.id : undefined },
      });
    }
    for (let i = 0; i < bot.hand.length; i++) {
      const c = bot.hand[i];
      if (c.action === 'finance_office') {
        menu.push({ ...score(5), amount: 5, kind: 'finance',
          action: { type: 'play_action', cardIndex: i, targetId: target.id } });
      } else if (c.action === 'roll_call') {
        menu.push({ ...score(2), amount: 2, kind: 'rollcall',
          action: { type: 'play_action', cardIndex: i } });
      }
    }
    return { menu: menu.filter(m => m.collect >= 1).sort((a, b) => b.value - a.value), rent, pay, bank, mult };
  }

  return {
    ...base,
    name: 'oracle:' + baseMode,
    stats: { charged: 0, surged: 0, held: 0 },
    decide(state, botId) {
      const action = base.decide(state, botId);
      const bot = G.getPlayer(state, botId);
      if (!bot) return action;
      const win = G.setsToWinOf(state);

      const target = windowSeat(state, botId);
      if (target) {
        const { menu, rent, pay, bank } = chargeMenu(state, bot, target);
        // §3.1c surge stacking, when the doubling is what crosses the bar.
        const surgeIdx = bot.hand.findIndex(c => c.action === 'surge_ops');
        if (rent && surgeIdx >= 0 && state.playsRemaining >= 2) {
          const now = Math.min(rent.rent * (2 ** (state._surgeOps || 0)), pay);
          const doubled = Math.min(rent.rent * (2 ** ((state._surgeOps || 0) + 1)), pay);
          const bitesNow = now > bank, bitesDoubled = doubled > bank;
          if ((bitesDoubled && !bitesNow) || doubled - now >= 2) {
            this.stats.surged++;
            return { type: 'play_action', cardIndex: surgeIdx };
          }
        }
        if (menu.length) {
          const baseCard = action && action.cardIndex !== undefined ? bot.hand[action.cardIndex] : null;
          const baseIsCharge = action && action.type === 'play_action' && baseCard && isChargeCard(baseCard);
          if (!baseIsCharge) {
            this.stats.charged++;
            return menu[0].action;
          }
        }
        return action;
      }

      // Holding, outside the window. (oraclenh: disables this branch — the decomposition
      // arm that separates window-charging value from holding cost.)
      if (!hold) return action;
      if (!action) return action;
      const anyArmed = state.players.some(p => p.id !== botId && !p.eliminated && p.finalApproach);
      const windowSoon = state.players.some(p => p.id !== botId && !p.eliminated
        && G.completedSets(p) >= win - 2);
      if (anyArmed || !windowSoon) return action;

      let current = action;
      for (let hides = 0; hides < 3; hides++) {
        if (!current || current.cardIndex === undefined) return current;
        const card = bot.hand[current.cardIndex];
        if (!card || !isChargeCard(card)) return current;
        const spendingAsCharge = current.type === 'play_action';
        const bankingIt = current.type === 'play_money';
        if (!spendingAsCharge && !bankingIt) return current;
        if (spendingAsCharge) {
          // A charge the base fires for real money is not held. Collectible bound: the
          // best-paying opponent it can reach.
          const amount = card.type === 'rent'
            ? G.calcRent(bot, current.targetColor || card.color || '') * (2 ** (state._surgeOps || 0))
            : card.action === 'finance_office' ? 5 : 2;
          const reach = Math.max(0, ...state.players
            .filter(p => p.id !== botId && !p.eliminated).map(payableOf));
          if (Math.min(amount, reach) >= 4) return current;
        }
        // Hide the card, let the base pick its next-best play, restore, remap.
        const idx = current.cardIndex;
        const [hidden] = bot.hand.splice(idx, 1);
        let redecided;
        try { redecided = base.decide(state, botId); }
        finally { bot.hand.splice(idx, 0, hidden); }
        this.stats.held++;
        if (!redecided) return null;
        if (redecided.cardIndex !== undefined) {
          // Index was relative to the hidden hand; shift back over the restored card.
          if (redecided.cardIndex >= idx) redecided.cardIndex++;
        }
        current = redecided;
      }
      return current;
    },
  };
}

function makePolicy(spec) {
  if (typeof spec !== 'string') throw new Error('policy spec must be a string');
  if (spec.startsWith('oracle:')) return oracleChargePolicy(spec.slice('oracle:'.length));
  if (spec.startsWith('oraclenh:')) return oracleChargePolicy(spec.slice('oraclenh:'.length), { hold: false });
  if (spec.startsWith('cashfloor:')) return cashFloorPolicy(spec.slice('cashfloor:'.length));
  if (spec.startsWith('nocompleter:')) return noCompleterPolicy(spec.slice('nocompleter:'.length));
  if (spec.startsWith('rentlev:')) return rentLeveragePolicy(spec.slice('rentlev:'.length));
  const tuned = /^tuned:(.+):([a-z@0-9.]+)$/.exec(spec);
  if (tuned) return tunedPolicy(tuned[1], tuned[2]);
  const sandbag = /^sandbag@([0-9.]+):(.+)$/.exec(spec);
  if (sandbag) return sandbagPolicy(Number(sandbag[1]), sandbag[2]);
  const persona = spec.split('@')[0];
  if (!BASE_MODES.includes(persona)) throw new Error('unknown policy: ' + spec);
  return modePolicy(spec);
}

/* ── rollout ─────────────────────────────────────────────────────────── */

// Continuation seats: bot seats play their recorded botMode; ever-human seats play
// `humanlike` (round 13's instrument — a good behaviour clone, a poor strength clone,
// so absolute win rates are optimistic; DELTAS are what this instrument reports).
function continuationPolicies(record, overrides = {}) {
  const map = new Map();
  for (const s of record.seats || []) {
    const spec = overrides[s.id] || (s.everHuman ? 'humanlike' : (s.botMode || 'neutral'));
    map.set(s.id, typeof spec === 'string' ? makePolicy(spec) : spec);
  }
  return map;
}

const MAX_ROLLOUT_TURNS = 300;

// The shared playout loop (mirrors simulate.js runGame). Assumes bot RNG is seeded.
function runLoop(state, policies) {
  let safety = MAX_ROLLOUT_TURNS * 25;
  while (state.phase === 'playing' && safety-- > 0 && state.turnCounter <= MAX_ROLLOUT_TURNS) {
    if (state.pendingAction) {
      const rid = BI.findResponder(state);
      if (rid) {
        const pol = policies.get(rid) || modePolicy('neutral');
        // Through the policy, not straight to botRespondSync: tuned/oracle wrappers
        // must be able to scope their overrides around the RESPONSE path too.
        if (pol.respond) pol.respond(state, rid); else BI.botRespondSync(state, rid, pol.respondMode);
        continue;
      }
      state.pendingAction = null; state.turnPhase = 'play';
      continue;
    }
    const cp = G.currentPlayer(state);
    if (cp.eliminated) { G.advanceToNextActive(state); continue; }
    const pol = policies.get(cp.id) || modePolicy('neutral');
    if (state.turnPhase !== 'play') break;
    const action = pol.decide(state, cp.id);
    if (action) {
      const res = BI.applyBotAction(state, cp.id, action);
      if (!res || res.error) endTurnFor(state, cp.id, pol);
      continue;
    }
    endTurnFor(state, cp.id, pol);
  }
}

// One playout from a decision snapshot. `firstAction` (already index-resolved or in
// cardId form) is applied before the loop.
function rollout(snapshot, policies, { seed, firstAction = null, seatId }) {
  const state = reviveState(snapshot);
  determinize(state, seed);
  BI.setRng(G.makeRng('bot:' + seed));
  try {
    if (firstAction) applyResolvedAction(state, seatId, firstAction, policies.get(seatId));
    runLoop(state, policies);
  } finally {
    BI.setRng(null);
  }
  return { winner: state.winner, turns: state.turnCounter, endReason: state.endReason };
}

// A whole fresh game under wrapper policies — what lets benchstudy seat evaluation-only
// policies (oracle:, tuned:, …) that simulate.js's mode-string loop cannot.
function playFresh(specs, seed, rules = {}) {
  const players = specs.map((s, i) => ({ id: 'p' + i, name: 'seat' + i }));
  const state = G.createGame(players, { seed, ...rules });
  const policies = new Map(specs.map((s, i) => ['p' + i, typeof s === 'string' ? makePolicy(s) : s]));
  BI.setRng(G.makeRng('bot:' + seed));
  try { runLoop(state, policies); } finally { BI.setRng(null); }
  return { winner: state.winner, turns: state.turnCounter, endReason: state.endReason };
}

function endTurnFor(state, botId, pol) {
  const bot = G.getPlayer(state, botId);
  let discardIds;
  if (bot.hand.length > 7) discardIds = pol.discard(bot, bot.hand.length - 7);
  const res = G.endTurn(state, botId, discardIds);
  if (res?.error) G.forceEndTurn(state);
}

// Apply a first action that may be in recorded (cardId) form or decide() (cardIndex) form.
function applyResolvedAction(state, seatId, action, pol) {
  const a = { ...action };
  if (a.type === 'end_turn') {
    const bot = G.getPlayer(state, seatId);
    let ids = a.discardIds;
    if (bot.hand.length > 7 && (!ids || ids.length !== bot.hand.length - 7)) {
      ids = pol.discard(bot, bot.hand.length - 7);
    }
    const res = G.endTurn(state, seatId, ids);
    if (res?.error) G.forceEndTurn(state);
    return;
  }
  if (a.type === 'scoop') { G.scoop(state, seatId); return; }
  // Only hand-card plays are index-addressed; a rearrange/swap names board cards by id.
  const handTypes = a.type === 'play_money' || a.type === 'play_property' || a.type === 'play_action';
  if (handTypes && a.cardId !== undefined && a.cardIndex === undefined) {
    const bot = G.getPlayer(state, seatId);
    a.cardIndex = bot.hand.findIndex(c => c.id === a.cardId);
    if (a.cardIndex < 0) throw new ReplayError('first action card not in hand', { cardId: a.cardId });
  }
  const res = BI.applyBotAction(state, seatId, a);
  if (res?.error) endTurnFor(state, seatId, pol);
}

/* ── action canonicalization (divergence check) ──────────────────────── */

function canonicalAction(state, seatId, action) {
  if (!action) return { type: 'end_turn' };
  const a = { ...action };
  if (a.cardIndex !== undefined && a.cardId === undefined) {
    const bot = G.getPlayer(state, seatId);
    a.cardId = bot.hand[a.cardIndex] ? bot.hand[a.cardIndex].id : null;
  }
  const key = { type: a.type === 'end_turn' || a.type === 'scoop' ? a.type : a.type, card: a.cardId ?? a.cardIdA ?? null };
  for (const f of ['targetColor', 'targetId', 'targetCardId', 'myCardId', 'toColor', 'cardIdB']) {
    if (a[f] !== undefined) key[f] = a[f];
  }
  return key;
}

const sameAction = (x, y) => JSON.stringify(x) === JSON.stringify(y);

/* ── statistics ──────────────────────────────────────────────────────── */

function wilson(wins, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = wins / n, z2 = z * z;
  const den = 1 + z2 / n;
  const mid = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return [(mid - half) / den, (mid + half) / den];
}

// Cluster bootstrap by game: decision points inside a game share a trajectory and are
// not independent samples; resampling GAMES is the honest unit.
function clusterBootstrapCI(perGame, { B = 2000, seed = 'boot', alpha = 0.05 } = {}) {
  const games = Object.values(perGame).filter(g => g.n > 0);
  if (!games.length) return [0, 0];
  const rng = G.makeRng('ci:' + seed);
  const means = [];
  for (let b = 0; b < B; b++) {
    let s = 0, n = 0;
    for (let i = 0; i < games.length; i++) {
      const g = games[Math.floor(rng() * games.length)];
      s += g.sum; n += g.n;
    }
    means.push(n ? s / n : 0);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(means.length * (alpha / 2))];
  const hi = means[Math.min(means.length - 1, Math.floor(means.length * (1 - alpha / 2)))];
  return [lo, hi];
}

/* ── evaluation ──────────────────────────────────────────────────────── */

// Price `subject` against `baseline` at the focus seats' real decision points.
//   baseline 'recorded': one-step deviation — subject's first action vs the recorded
//     one, BOTH arms continuing under the same policies (humanlike at the seat), so the
//     delta isolates the decision itself.
//   baseline <policy>: whole-trajectory — each arm's seat plays its policy from the
//     decision point onward, which is what prices a persistent policy change.
function evaluate(records, {
  subject, baseline = 'recorded', rollouts = 16, seed = 'r14',
  maxPoints = Infinity, at = 'divergent', focus = 'human', onProgress = null,
} = {}) {
  const subjectPolicy = makePolicy(subject);
  const baselineIsRecorded = baseline === 'recorded';
  const baselinePolicy = baselineIsRecorded ? null : makePolicy(baseline);

  const out = {
    subject, baseline, rollouts, at,
    games: 0, reconstructFailures: 0, points: 0, divergent: 0, evaluated: 0,
    subjectWins: 0, baselineWins: 0, armN: 0,
    perGame: {}, failures: [],
  };
  const pickRng = G.makeRng('pick:' + seed);
  let budget = maxPoints;

  for (const record of records) {
    const focusSeats = (record.seats || [])
      .filter(s => focus === 'all' || (focus === 'human' ? s.everHuman : s.botMode === focus))
      .map(s => s.id);
    if (!focusSeats.length) continue;

    let decisions;
    try {
      ({ decisions } = reconstruct(record, { focusSeats }));
    } catch (e) {
      out.reconstructFailures++;
      out.failures.push({ code: record.code, error: e.message });
      continue;
    }
    out.games++;
    const g = (out.perGame[record.code + '|' + record.ts] ||= { sum: 0, n: 0 });

    for (const dp of decisions) {
      if (budget <= 0) break;
      out.points++;
      const seatId = dp.meta.seat;

      // What does each arm DO here? BOTH arms decide on the SAME seeded rng stream —
      // the null test (identical policies must return exactly zero) failed under
      // per-arm streams, because a policy's own holdback rolls differed between arms
      // and manufactured divergence out of nothing. Same stream = paired decisions.
      const decideSeed = `${seed}:${record.code}:${dp.meta.index}`;
      const subjectAction = decideAt(dp.snapshot, seatId, subjectPolicy, decideSeed);
      const baselineAction = baselineIsRecorded
        ? dp.meta.recorded
        : decideAt(dp.snapshot, seatId, baselinePolicy, decideSeed);

      const stateForCanon = reviveState(dp.snapshot);
      const diverges = !sameAction(
        canonicalAction(stateForCanon, seatId, subjectAction),
        canonicalAction(stateForCanon, seatId, baselineAction));
      if (diverges) out.divergent++;
      if (at === 'divergent' && !diverges) continue;

      budget--;
      out.evaluated++;
      const subjectSeat = { [seatId]: subjectPolicy };
      const baselineSeat = { [seatId]: baselineIsRecorded ? 'humanlike' : baselinePolicy };
      // One-step deviation: the subject arm also continues under the SAME seat policy
      // as the baseline arm, so the delta isolates the first action.
      const subjectCont = baselineIsRecorded
        ? continuationPolicies(record, {})
        : continuationPolicies(record, subjectSeat);
      const baselineCont = continuationPolicies(record, baselineIsRecorded ? {} : baselineSeat);

      let delta = 0;
      for (let r = 0; r < rollouts; r++) {
        const rSeed = `${seed}:${record.code}:${dp.meta.index}:${r}`;
        const sWin = rollout(dp.snapshot, subjectCont,
          { seed: rSeed, seatId, firstAction: subjectAction || { type: 'end_turn' } }).winner === seatId ? 1 : 0;
        const bWin = rollout(dp.snapshot, baselineCont,
          { seed: rSeed, seatId, firstAction: baselineAction || { type: 'end_turn' } }).winner === seatId ? 1 : 0;
        out.subjectWins += sWin; out.baselineWins += bWin; out.armN++;
        delta += sWin - bWin;
      }
      delta /= rollouts;
      g.sum += delta; g.n++;
    }
    if (onProgress) onProgress(out);
    if (budget <= 0) break;
    // consume one pick roll per game so subsetting is stable under maxPoints
    pickRng();
  }

  const games = Object.values(out.perGame).filter(x => x.n > 0);
  const totalN = games.reduce((s, x) => s + x.n, 0);
  out.meanDelta = totalN ? games.reduce((s, x) => s + x.sum, 0) / totalN : 0;
  out.ci95 = clusterBootstrapCI(out.perGame, { seed });
  out.subjectWinRate = out.armN ? out.subjectWins / out.armN : null;
  out.baselineWinRate = out.armN ? out.baselineWins / out.armN : null;
  out.subjectWilson = wilson(out.subjectWins, out.armN);
  out.baselineWilson = wilson(out.baselineWins, out.armN);
  out.divergenceRate = out.points ? out.divergent / out.points : 0;
  out.subjectPolicyStats = subjectPolicy.stats || null;
  return out;
}

function decideAt(snapshot, seatId, policy, seed) {
  const state = reviveState(snapshot);
  determinize(state, seed);
  BI.setRng(G.makeRng('bot:' + seed));
  try {
    return policy.decide(state, seatId);
  } finally {
    BI.setRng(null);
  }
}

module.exports = {
  loadRecords, reconstruct, verifySeeded, makeRiggedState, makeSeededState,
  stateProjection, boardProjection, snapshotState, reviveState, determinize,
  makePolicy, modePolicy, cashFloorPolicy, noCompleterPolicy, sandbagPolicy,
  rentLeveragePolicy, tunedPolicy, oracleChargePolicy, playFresh, continuationPolicies,
  rollout, evaluate, decideAt, canonicalAction, wilson, clusterBootstrapCI,
  ReplayError, drive, verifyFinalBoards,
};
