// state/recorder.js — turns one finished game into one logbook row. Owner: state/.
//
// WHY THE EVENT STREAM AND NOT THE FINAL SNAPSHOT. `getPlayerView` ships only
// the last EVENT_TAIL (=120, game.js:318) events. Measured against
// logs/games.jsonl: of the 64 records that are real games (the other 671 are
// harness/abandon rows of 5–7 events), **64 of 64 exceed 120** — median 243,
// min 150, max 463. A recorder built on the final broadcast would therefore
// silently drop the first half of EVERY game, and would do it invisibly:
// the numbers would just be small.
//
// ui/journal.js already accumulates the whole stream, merging every broadcast by
// `seq` and counting the stretches it missed. This module reads `entries()` and
// `gapCount()` from it and does no accumulation of its own.
//
// THREE TRAPS, each verified against the source and pinned in
// test/stats-recorder.test.js:
//
//   1. `EVENTS.STATE_APPLIED` FIRES ON EVERY BROADCAST, and a FINISHED game is
//      re-broadcast constantly: rematch votes, `leave_room`, host transfer and
//      reconnect all end in `broadcast.broadcastRoom(room)` (server/handlers.js
//      :220, :396, :434, :449, :461, :495) and the finished view still carries
//      the `win` event in its tail. Without a latch a single game is recorded
//      once per lobby click. We latch on a stable key AND clear it only when a
//      new game starts — the same shape as the server's own `room.state._logged`
//      (server/gamelog.js:253).
//
//   2. **`win` EMITS `actor`; `stalemate` EMITS `winner`.** game.js finishGame()
//      (:936-943) branches on the reason and uses a different field name in each
//      arm. A recorder that reads `ev.actor` uniformly scores every stalemate as
//      a loss for everyone, including the player who took it on net worth.
//
//   3. A CLIENT THAT ARRIVED LATE HAS NO GAPS AND NO GAME. `gapCount()` counts
//      breaks BETWEEN broadcasts; a journal whose very first beat is a mid-game
//      event (reconnect straight into a finished table) has a perfectly clean
//      gap count over a record that is missing everything before it. So the row
//      is marked gapped unless the journal actually saw `game_start`.
//
// A gapped row is still banked — it is a real game and a real result — but it is
// excluded from every personal-best claim (see stats.js `recordGame`).

import { COLORS } from '../core/cards.js';
import { stats } from './stats.js';

/** The engine's two end events, and where each keeps its winner. Trap 2. */
export const END_EVENTS = Object.freeze({ win: 'actor', stalemate: 'winner' });

/**
 * The winner id an end event names, whichever field it used.
 * @param {{t?:string}} ev
 * @returns {string|null} null for an event that is not an ending, and for a
 *   stalemate that ended with nobody left to rank (game.js:2297 passes null).
 */
export function endWinner(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const field = END_EVENTS[ev.t];
  if (!field) return null;
  const id = ev[field];
  return typeof id === 'string' && id ? id : null;
}

/** Is this the event that ends a game? */
export function isEndEvent(ev) {
  return !!(ev && typeof ev === 'object' && Object.prototype.hasOwnProperty.call(END_EVENTS, ev.t));
}

/* ── derivation (pure) ────────────────────────────────────────────────────── */

/**
 * Fold a whole game's beats into one logbook row. PURE — no storage, no clock,
 * no bus. Everything it needs is an argument, which is what lets
 * test/stats-recorder.test.js replay real games out of logs/games.jsonl through
 * it and lets tools/statsfuzz.mjs feed it garbage.
 *
 * @param {object} args
 * @param {Array<{seq:number, ev:object}>} args.beats  journal entries, oldest first
 * @param {object|null} args.snapshot                  getPlayerView output at game over
 * @param {string} args.selfId                         this client's seat
 * @param {string} args.code                           room code
 * @param {Array<{id:string, human:boolean, botMode:string|null}>} args.seats
 *        Composition over the WHOLE game, not at the final frame — see
 *        `observe()` for why the two differ.
 * @param {number} args.gaps                           journal.gapCount()
 * @param {boolean} [args.sawStart]  did this client see `game_start` for THIS
 *   game? The live recorder passes its sticky `started` flag (set while the
 *   event is still in the ring, surviving the splice). When absent, the beats
 *   are scanned — correct only for callers that hand over the FULL stream.
 * @returns {import('./stats.js').StatsRow|null} null when the beats contain no
 *   ending at all (nothing finished, nothing to record).
 */
export function deriveRow(args) {
  try { return deriveRowUnguarded(args || {}); } catch { return null; }
}

/** The real body. Guarded by `deriveRow` because every field here comes off the
 *  wire or out of storage, and `Array.isArray` alone throws on a revoked Proxy
 *  (tools/statsfuzz.mjs found it). */
function deriveRowUnguarded({ beats = [], snapshot = null, selfId = '', code = '', seats = [],
  gaps = 0, sawStart = undefined }) {
  const list = Array.isArray(beats) ? beats : [];
  const seatList = Array.isArray(seats) ? seats : [];
  let endEv = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i] && list[i].ev;
    if (isEndEvent(ev)) { endEv = ev; break; }
  }
  // The snapshot is truth (§0.1) and it can say "finished" over a tail that has
  // rolled the ending off. Only a table that never finished is unrecordable.
  const finished = endEv || snapshot?.phase === 'finished';
  if (!finished) return null;

  const winner = endEv ? endWinner(endEv) : (snapshot?.winner || null);
  const end = endEv?.t === 'stalemate'
    ? 'stalemate'
    : (typeof endEv?.reason === 'string' ? endEv.reason : null)
      || (typeof snapshot?.endReason === 'string' ? snapshot.endReason : 'sets');

  // Trap 3: a record that never saw `game_start` starts mid-game. BUT the beat
  // ring is bounded (ui/journal.js MAX_BEATS) and `game_start` is beat #1, so
  // any game longer than the ring loses it FIRST — re-deriving "did we see the
  // start?" from the spliced ring scored every long COMPLETED game as
  // incomplete and excluded it from every personal best. The live recorder
  // watched the whole stream and passes `sawStart` in; scanning the beats is
  // only the fallback for a caller that replays the full, unspliced stream.
  const started = sawStart === undefined
    ? list.some(b => b?.ev?.t === 'game_start')
    : !!sawStart;
  const integrityGaps = Math.max(0, Number(gaps) || 0) + (started ? 0 : 1);

  const humans = seatList.filter(s => s && s.human).length;
  const bots = seatList.filter(s => s && !s.human).length;
  const botModes = seatList.filter(s => s && !s.human && s.botMode).map(s => s.botMode);

  const me = snapshot?.players?.find?.(p => p && p.id === selfId) || null;

  const row = {
    at: 0,                                   // stats.recordGame stamps it
    code: typeof code === 'string' ? code : '',
    won: !!(selfId && winner === selfId),
    end,
    winRule: snapshot?.winRule || 'finalApproach',
    setsToWin: Number(snapshot?.setsToWin) || 3,
    seats: seatList.length,
    humans,
    bots,
    botModes,
    turns: Number(snapshot?.turnNumber) || 0,
    sets: Number(me?.completedSets) || 0,
    armed: 0, broken: 0, shootdowns: 0,
    stolen: 0, lost: 0, setsStolen: 0, setsLost: 0,
    opsec: 0, opsecDepth: 0,
    insolvent: 0,
    charged: 0, paid: 0, biggest: 0,
    colors: {},
    gaps: integrityGaps,
  };

  for (const entry of list) {
    const ev = entry && entry.ev;
    if (!ev || typeof ev !== 'object') continue;
    switch (ev.t) {
      // The Final Approach record. `final_approach` fires once per ARMING —
      // rearming after a break emits it again, which is exactly the count we
      // want, because each arming is a separate thing that could be broken.
      case 'final_approach':
        if (ev.actor === selfId) row.armed++;
        break;
      case 'final_approach_broken':
        if (ev.actor === selfId) row.broken++;
        // `by` is absent when the engine cannot attribute the break (a set lost
        // to a payment the owner chose). An unattributed break scores nobody a
        // shootdown, which is the honest answer.
        if (ev.by && ev.by === selfId) row.shootdowns++;
        break;

      case 'set_completed':
        if (ev.actor === selfId && COLORS[ev.color]) {
          row.colors[ev.color] = (row.colors[ev.color] || 0) + 1;
        }
        break;

      case 'steal':
        if (ev.actor === selfId) row.stolen++;
        if (ev.from === selfId) row.lost++;
        break;
      case 'set_stolen': {
        // A seized set is BOTH n properties and one set. Counting only the set
        // would make "properties lost" disagree with the board.
        const n = Array.isArray(ev.cards) ? ev.cards.length : 0;
        if (ev.actor === selfId) { row.setsStolen++; row.stolen += n; }
        if (ev.from === selfId) { row.setsLost++; row.lost += n; }
        break;
      }
      // TDY Orders is a two-way trade: the initiator gives one and takes one, so
      // it is neither a theft nor a loss for either seat and is deliberately not
      // counted in `stolen`/`lost`.

      case 'opsec':
        if (ev.actor === selfId) {
          row.opsec++;
          const d = Number(ev.depth) || 0;
          if (d > row.opsecDepth) row.opsecDepth = d;
        }
        break;

      case 'insolvent':
        if (ev.from === selfId) row.insolvent++;
        break;

      case 'payment': {
        const total = Number(ev.total) || 0;
        if (ev.to === selfId) {
          row.charged += total;
          if (total > row.biggest) row.biggest = total;
        }
        if (ev.from === selfId) row.paid += total;
        break;
      }
      default:
        break;
    }
  }

  return row;
}

/* ── the live recorder (stateful, latched) ───────────────────────────────── */

/**
 * Composition over the whole game, not at the final frame. A human who
 * disconnects mid-game is replaced by a bot in place (server/handlers.js:789-793
 * flips `isBot` on the SAME seat), so the last broadcast reports fewer humans
 * than played. The server solves this with `_wasHuman`, which is not on the
 * wire; the client can solve it because it saw every broadcast — a seat that was
 * ever `isBot:false` was human. Same rule as server/gamelog.js `everHuman()`,
 * derived from what the client can actually see.
 * @type {Map<string, {id:string, human:boolean, botMode:string|null}>}
 */
let composition = new Map();

/** The game we have already banked. Cleared by `newGame()`. */
let latchedKey = null;

/** Set once a `game_start` (or a seq restart) has been seen this game. */
let started = false;

/** Reset for a new game. ui/journal.js calls this from its own `reset()`. */
export function newGame() {
  composition = new Map();
  latchedKey = null;
  started = false;
}

/** For tests and the report. */
export function latched() { return latchedKey; }

/**
 * The latch key. Room code alone is not enough (a rematch reuses the room), and
 * `eventSeq` alone is not enough (a rematch restarts it), so the key carries
 * both plus the outcome — and `newGame()` clears it on every fresh `game_start`,
 * which is what actually makes a same-room rematch a different game.
 */
function keyFor(code, winner, seq, turns) {
  return `${code || '?'}|${winner || 'none'}|${seq || 0}|${turns || 0}`;
}

/**
 * Feed one broadcast. Safe (and expected) to call on EVERY `STATE_APPLIED`;
 * records at most once per game. Never throws — a recorder that throws inside a
 * bus handler would take the snapshot apply with it.
 *
 * @param {object} args
 * @param {object|null} args.snapshot   store.snapshot after apply
 * @param {object} args.room            store.room ({code, players})
 * @param {string} args.selfId
 * @param {Array<{seq:number, ev:object}>} args.beats  journal.entries()
 * @param {number} args.gaps            journal.gapCount()
 * @param {object} [args.sink]          storage, injected in tests
 * @returns {import('./stats.js').StatsRow|null} the row banked, if this call banked one
 */
export function observe({ snapshot, room, selfId, beats, gaps, sink = stats }) {
  try {
    const players = Array.isArray(room?.players) ? room.players : [];
    for (const p of players) {
      if (!p || typeof p.id !== 'string') continue;
      const prev = composition.get(p.id);
      const human = !p.isBot;
      composition.set(p.id, {
        id: p.id,
        // Once human, always human — see the `composition` note.
        human: human || !!prev?.human,
        botMode: typeof p.botMode === 'string' ? p.botMode : (prev?.botMode || null),
      });
    }

    const list = Array.isArray(beats) ? beats : [];
    if (!started && list.some(b => b?.ev?.t === 'game_start')) started = true;

    if (!snapshot || snapshot.phase !== 'finished') return null;

    let endEv = null;
    for (let i = list.length - 1; i >= 0; i--) {
      if (isEndEvent(list[i]?.ev)) { endEv = list[i].ev; break; }
    }
    const winner = endEv ? endWinner(endEv) : (snapshot.winner || null);
    const key = keyFor(room?.code, winner, snapshot.eventSeq, snapshot.turnNumber);
    if (latchedKey === key) return null;

    const row = deriveRow({
      beats: list,
      snapshot,
      selfId,
      code: room?.code || '',
      seats: [...composition.values()],
      gaps,
      // The sticky flag, not a ring scan: `started` was set while `game_start`
      // was still in the bounded ring and survives the splice. Trap 3, fixed at
      // the only place that actually held the truth.
      sawStart: started,
    });
    if (!row) return null;

    latchedKey = key;
    // The SANITISED row, not the derived one — what the caller gets back must be
    // what was actually banked (sorted botModes, clamped counters), or a test or
    // a panel reading the return value is reading a different object from disk.
    return sink.recordGame(row).row;
  } catch {
    // A recorder is a bookkeeper. It is never worth a broken frame.
    return null;
  }
}
