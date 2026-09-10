// anim/choreographer.js — engine events become table motion, in order.
//
// Contract with the rest of the client (§5, §10):
//   1. events are consumed SERIALLY, oldest first, ≤600ms each;
//   2. every event declares which card ids it expects to move ("claims");
//   3. after the last event, table.reconcile(snapshot) corrects everything and
//      counts every correction that no claim predicted as DRIFT.
//
// So the claim table below is not decoration: a missing claim is a nonzero
// driftCount in tools/playtest.mjs, which is exactly the signal that the
// animation told the player something the server did not say. Three claims
// exist because the engine emits NO per-card event for them and never will:
// upgrades silently discarded when a set breaks, the discard pile folding into
// the deck on a reshuffle, and a scoop sweeping a whole board. P4 kept all
// three unchanged.
//
// STEP vs FLIGHT. `stepFor(ev)` is how long this event holds the queue before
// the next one starts — not how long its motion lasts. Flights are allowed to
// overlap the next event (a caravan's tail is still landing while the next
// card lifts), but no single event's own choreography may exceed 600ms (§10),
// which is why every stagger is capped rather than open-ended.

import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { wait } from '../core/clock.js';
import * as table from '../table/index.js';
import { getNode } from '../table/cardnode.js';
import { isPropertyCard } from '../core/cards.js';
import * as flight from './flight.js';
import { cueEl, CUE } from './cues.js';

const MAX_STEP = 600;                    // §10 — nothing uninterruptible over 600ms

/* ── "the felt now shows THIS state" (§P9 FEEL round 3) ────────────────────
 *
 * CHOREO_IDLE means "the queue is empty". On a five-seat table of `chud` bots
 * (300–800ms plays) the queue is NEVER empty, so every surface that waited for
 * idle before it was allowed to speak simply stopped speaking: measured with
 * 250ms between broadcasts, #hud-turn was stuck on DEALING for 98.0% of the
 * game and its longest single stale run was 31,857ms.
 *
 * The honest sync point was already here and was not published. runJobAsync
 * ends with table.reconcile(job.snapshot), and reconcile is the moment the felt
 * is made to EQUAL that snapshot — every card in its zone, every board seated.
 * So after it, "the table is showing job.snapshot" is not an estimate, it is
 * the definition of what reconcile just did.
 *
 * Emitting it costs nothing and gives the header a third option between the two
 * bad ones: not the store's snapshot (the future — that is the spoiler this
 * hold exists to prevent) and not an idle that never comes, but the newest
 * state that has actually been PERFORMED. Lag is therefore bounded by one job
 * rather than by the length of the game.
 *
 * core/bus.js is architect-owned; the channel follows the same "string literal
 * until the constant exists" pattern ui/peek.js and interact/drag.js use.
 */
export const CHOREO_SETTLED = EVENTS.CHOREO_SETTLED || 'choreo:settled';

/* Measured on the seeded playtest game (CHUD_SEED=1337, desktop 1280×720):
   the numbers are "the queue may move on", and each is the point where the
   card that matters has landed or is unambiguously on its way.

   deal      46ms/card — was 70. The opening deal is four of these back to back
                         and 70 made it 1.9s of table before the first turn;
                         46 × 5 + 70 = 300ms/hand, 1.2s for a 4-player table,
                         and the 285ms deck→hand flights overlap into a sweep.
   draw      82ms/card — was 60. Auto-draw made this the animation a player
                         sees most (twice a turn, every turn); at 60 the two
                         cards read as one thick card. 82×2+110 = 274ms.
   payment   70ms/card — same beat as the deal; the caravan has to read as a
                         procession, and a 5-card payment is the worst case.
   discard   55ms/card — up to 4 cards, and the turn is already over.
   set_stolen 45ms/card — the delays are 40 + i×45, UNCAPPED. They used to be
                         clamped to 150ms, which meant a 4-card seizure —the
                         biggest theft in the game— launched cards 3 and 4 in the
                         same frame and the audio bus (26ms rate floor) deleted
                         one of them: three cards landing and a ghost. 40+3×45 =
                         175ms, and flight.budgetDelay's room for a 420ms flight
                         is 180ms, so all four fit inside §10's 600ms with 45ms
                         of separation each.
   steal     480      — 120ms hold + a 420ms deliberate flight, §6's ceiling.
   shuffle   420      — fold (240 + 5×24 stagger) then the riffle overlaps it.

   NOTE for audio: these are the numbers its per-sound rate floors are tuned
   against. Changing one without telling it deletes every second card's sound. */
const STAGGER = { deal: 46, draw: 82, payment: 70, discard: 55, set_stolen: 45 };

/* ── EVENT PRIORITY (P7 round 1) ───────────────────────────────────────────
 * Backpressure used to be indiscriminate. Measured on the same 273-event game
 * replayed at 400ms and at 120ms between broadcasts:
 *
 *              400ms   120ms
 *   sfx cues     549     319     −42%
 *   set_completed 12       6     half the game's set completions SILENT
 *   payment_done  32      11
 *   final_approach 2       1     §3.10's peak, gone
 *   approach_broken 2      1
 *
 * A player on a fast table was not being shown a faster game, they were being
 * shown 42% less game. §10 says the snapshot is truth and animation is
 * presentation — it does not say presentation is optional.
 *
 * So collapsing now drops MOTION, never MEANING. An event in this set always
 * emits its FX cue and its CHOREO_SFX even when its cards are placed rather
 * than performed; everything else (card slides, draws, discards, turn passes)
 * may go silent, which is exactly where the 42% should come from.
 */
/* P9 FEEL round 1 adds the ACTION VOICES, and they belong here for exactly the
 * reason the set exists. Measured on the same 137-state transcript at 700ms and
 * at 120ms between broadcasts:
 *
 *                    700ms   120ms
 *   steal                6       6     ← protected, worked perfectly
 *   opsec                3       3     ← protected
 *   klaxon / fanfare     1       1     ← protected
 *   act_rent             5       0
 *   act_swap             3       0
 *   act_surge            1       0
 *   upgrade              1       0
 *   chud                 1       0     ← §7 names this card BY HAND
 *   demand              12       3
 *
 * Every card in audio/sfx.js's action vocabulary — the cross, the meter, the
 * flutter, and the CHUD sting — is a once-or-twice-a-game sound. §7 built them
 * so the game has more than one voice; the whole "1 sting per game → 34" gain
 * was the FIRST thing a fast table deleted, and what was left was the card
 * handling that already makes up 62% of the mix.
 *
 * `demand` and `rent_charged` come with them because they are the same beat's
 * second half — they are what says the card on the pile is pointed at YOU, and
 * an aimed action with no aim is just a discard.
 *
 * What is deliberately NOT here: play_money (`chip` 18→4) and play_property
 * (`prop_place` 33→7). Those are the 62%, they are the collapse working as
 * designed, and protecting them would leave backpressure with nothing to spend.
 */
const BIG = Object.freeze({
  set_completed: 1, steal: 1, set_stolen: 1, swap: 1, opsec: 1, action_blocked: 1,
  payment: 1, final_approach: 1, final_approach_broken: 1, win: 1, stalemate: 1,
  scoop: 1, insolvent: 1,
  play_action: 1, upgrade: 1, demand: 1, rent_charged: 1,
});
export function isBigMoment(t) { return !!BIG[t]; }

const queue = [];
let running = false;
let instant = false;
let selfId = null;
let catchUp = false;                     // dropping cinematics: place, do not perform

export function setSelf(id) { selfId = id; }
export function setInstant(on) { instant = !!on; }
export function isInstant() { return instant; }
export function pending() { return queue.length; }
/** Is the drain loop mid-job? Read by the §9 bridge — "the queue is 0 but the
 *  table is still performing" and "nothing is happening" look identical from
 *  pending() alone, and telling them apart is the whole of a stall diagnosis. */
export function isRunning() { return running; }

/**
 * Drop everything queued, and disown the job that is mid-performance.
 *
 * The queue was the easy half. A job already inside runJobAsync() is parked on
 * a clock between beats, and it ENDS with `table.reconcile(job.snapshot)` — so
 * a session torn down mid-animation (Leave room during the opening deal, a
 * kick, a dead resume token) would come back one beat later and rebuild the
 * dead game's cards onto a felt that had just been emptied. `epoch` is the
 * disown: the job plays out its remaining beats against nodes that no longer
 * exist, which is a no-op, and is refused the reconcile that would spawn them
 * again. Nothing else may touch it — a job the CURRENT session queued must
 * still finish, which is why this is not a flag on the module.
 */
export function clear() { queue.length = 0; epoch++; }
let epoch = 0;

/**
 * @param {object} snapshot
 * @param {Array} events   only events unseen by the store
 * @param {{snap?:boolean}} opts  snap = reconnect / fixture load → no animation
 */
export function enqueue(snapshot, events, opts = {}) {
  if (!snapshot) return;
  if (opts.snap) {
    queue.length = 0;
    table.reconcile(snapshot, { count: false, animate: false });
    bus.emit(EVENTS.CHOREO_IDLE, null);
    return;
  }
  if (!events || events.length === 0) {
    if (running) { queue.push({ snapshot, events: [] }); return; }
    table.reconcile(snapshot, { count: true, animate: false });
    bus.emit(CHOREO_SETTLED, snapshot);
    return;
  }
  if (instant) { runJob({ snapshot, events }); return; }

  queue.push({ snapshot, events });
  // Backpressure: multiplayer cannot wait on cinematics. Three jobs deep the
  // table is already a second behind the server, so collapse to the newest.
  //
  // Skipping a cinematic is not the same as not knowing about it: the dropped
  // jobs still declare their claims, carried into the surviving job, so
  // driftCount keeps meaning "the animation told a different story" rather
  // than "we fell behind".
  //
  // The claim on a claim: a job that ALREADY carries claims (it survived an
  // earlier collapse and then got collapsed itself) must hand them on. Missing
  // that merge is the whole of the drift this comment used to claim was zero —
  // measured at 6 corrections over a 273-event game replayed at 120ms, every
  // one of them a `move` the first collapse had claimed and the second dropped:
  //   move 56 → bank, move 10 → properties:orange, move 5 → properties:…:pink,
  //   move 10 → properties:…:orange, move 47 → bank, move 16 → properties:yellow
  if (queue.length > 3) {
    const newest = queue[queue.length - 1];
    const carry = newest.carry || (newest.carry = new Set());
    catchUp = true;
    try {
      for (let i = 0; i < queue.length - 1; i++) {
        const job = queue[i];
        if (job.carry) for (const id of job.carry) carry.add(id);
        for (const ev of job.events) safeApply(ev, job.snapshot, carry, false);
      }
    } finally { catchUp = false; }
    queue.length = 0;
    queue.push(newest);
  }
  if (!running) drain();
}

async function drain() {
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      await runJobAsync(job);
    }
  } catch (err) {
    bus.reportError(err);
  } finally {
    running = false;
    bus.emit(EVENTS.CHOREO_IDLE, null);
  }
}

/**
 * One event's choreography can never take the queue down with it. An event
 * type this build has never heard of (the engine may add rows to §4 at any
 * time) falls through to a 120ms pure-signal step; an event that THROWS is
 * reported and skipped, because a stalled queue means a table that stops
 * updating for the rest of the game — the one failure the player cannot
 * recover from without a reload.
 */
/* ── the two halves of one swap ────────────────────────────────────────────
 * §3.5's atomic swap is TWO `move_property` events carrying `swapWith` (the
 * OTHER card's id) and `swapHalf` (0 or 1). game.js emits them back to back and
 * this could index `i + 1`, but it searches: the pair is identified by its own
 * tags, so an engine that ever interleaves an overflow `banked_property`
 * between them still finds its mate instead of firing at a stranger.
 *
 * `swapHalf === 0` is the only entry point, so a job whose tail begins at half
 * 1 (a gap, a reconnect) plays that half alone rather than looking backwards
 * for an event this client never received.
 *
 * @returns {number} index of the second half, or -1
 */
function swapMate(events, i) {
  const ev = events[i];
  if (!ev || ev.t !== 'move_property' || ev.swapHalf !== 0 || ev.swapWith == null) return -1;
  for (let k = i + 1; k < events.length; k++) {
    const other = events[k];
    if (other && other.t === 'move_property' && other.swapHalf === 1
      && other.swapWith === ev.card?.id && other.card?.id === ev.swapWith) return k;
  }
  return -1;
}

function safeApply(ev, snapshot, expected, animate) {
  try {
    applyEvent(ev, snapshot, expected, animate);
  } catch (err) {
    bus.reportError(err);
  }
}

async function runJobAsync(job) {
  const expected = job.carry || new Set();
  const era = epoch;                       // see clear(): a torn-down session's job
  // Seat the boards and the deck BEFORE the first event runs (see table.prepare).
  table.prepare(job.snapshot);
  // `animate` means "this job is being PERFORMED", not "the player wants
  // motion". Under prefers-reduced-motion the performance still happens — the
  // cards fade into place in ≤120ms (table/moveCard) and every FX cue fires on
  // time, because §0.9 collapses motion and keeps sound. Only the instant path
  // (harness, catch-up) is unperformed.
  const animate = true;
  // Indices already played as the second half of a swap. A Set rather than a
  // splice: `job.events` is the job's own record and the backpressure path
  // re-reads it (collapse carries a dropped job's claims forward). Allocated
  // per JOB, not per frame — §0.8's hot path is the tick, and this loop awaits.
  const played = new Set();
  for (let i = 0; i < job.events.length; i++) {
    if (played.has(i)) continue;
    const ev = job.events[i];
    safeApply(ev, job.snapshot, expected, animate);
    bus.emit(EVENTS.CHOREO_EVENT, ev);
    // AN ATOMIC SWAP IS ONE BEAT. §3.5's swap emits TWO `move_property` events
    // (game.js:2158) tagged `swapWith`/`swapHalf` rather than a new verb, so
    // every consumer already renders it — but as two queue steps, which is not
    // what it is. Both halves are applied in the SAME synchronous burst here
    // and charged one step, and applyEvent gives them mirrored arcs (±34, the
    // `swap`/TDY treatment) so the picture is two cards passing.
    //
    // Firing them together is also what §10's new invariant needs — "a swap
    // changes no zone count and no set completion". Both counts are written by
    // layout.paintBoard at the job-ending reconcile and never mid-flight, so no
    // digit could ever flicker; what COULD be seen was the CARDS disagreeing
    // with them. Two steps meant 220ms in which one mat visibly held n−1 and
    // the other still held n — 13 frames at 60fps of a state the rules say does
    // not exist. Now it is zero frames: the reparents are two statements in one
    // task and the browser cannot paint between them.
    const mate = swapMate(job.events, i);
    if (mate >= 0) {
      played.add(mate);
      safeApply(job.events[mate], job.snapshot, expected, animate);
      bus.emit(EVENTS.CHOREO_EVENT, job.events[mate]);
    }
    // Reduced motion collapses the PACING too, not just the paths: a fade
    // finishes in 120ms, so holding the queue for a 480ms steal would leave a
    // player who asked for less motion staring at a table that has stopped for
    // no visible reason. 140ms still separates one beat's cue from the next.
    //
    // AND IT COMPRESSES WHEN IT IS BEHIND (§P9 FEEL round 3). Backpressure used
    // to be all-or-nothing: perform at full length until three jobs are stacked
    // up, then throw two of them away. In between, the table played every beat
    // at its leisurely best while falling further behind the server — which is
    // the whole of the header's residual lag on a fast table, and it is also
    // why the felt could sit a second behind a five-seat bot game.
    //
    // With a job already waiting, the beats play at half length (never under
    // 45ms, which is above audio's 26ms rate floor, so nothing is deleted from
    // the mix). Nothing is skipped and no claim changes — only the pacing —
    // and it reverts the moment the queue drains.
    const behind = queue.length >= 1;
    const step = table.reducedMotion()
      ? Math.min(140, stepFor(ev))
      : behind
        ? Math.max(45, Math.min(MAX_STEP, stepFor(ev)) * 0.5)
        : Math.min(MAX_STEP, stepFor(ev));
    if (step > 0) await wait(step);
    if (era !== epoch) return;             // the session this belonged to is over
  }
  if (era !== epoch) return;
  table.reconcile(job.snapshot, { expected, count: true, animate });
  // The felt is now this snapshot, by construction. See CHOREO_SETTLED.
  bus.emit(CHOREO_SETTLED, job.snapshot);
}

function runJob(job) {
  const expected = new Set();
  for (const ev of job.events) {
    safeApply(ev, job.snapshot, expected, false);
    bus.emit(EVENTS.CHOREO_EVENT, ev);
  }
  table.reconcile(job.snapshot, { expected, count: true, animate: false });
  bus.emit(CHOREO_SETTLED, job.snapshot);
}

function stepFor(ev) {
  const n = countOf(ev);
  switch (ev.t) {
    // The opening deal is FOUR of these back to back. At 480ms each it was
    // 1.9s of table before the first turn; at 46ms/card + 70 it is 4 × 300ms =
    // 1.2s, and because the flights (≈285ms deck→hand) overlap the next event,
    // it reads as one continuous sweep round the table instead of four pauses.
    case 'deal': return Math.min(320, STAGGER.deal * n + 70);
    case 'draw': return Math.min(320, STAGGER.draw * n + 110);
    case 'payment': return Math.min(560, STAGGER.payment * n + 140);
    case 'discard': return Math.min(420, STAGGER.discard * n + 160);
    case 'set_stolen': return Math.min(580, STAGGER.set_stolen * n + 400);
    // §3.5 overflow: receiveProperty had no legal colour zone left and put the
    // card in the bank instead. It is emitted BEFORE the steal/swap/payment that
    // caused it, so it owns the flight and the owning event's move is a no-op.
    case 'banked_property': return 260;
    case 'play_money': return 240;
    case 'play_property': return 240;
    case 'play_action': return 260;
    case 'upgrade': return 240;
    // 220 for one wild changing columns. A tagged swap is TWO of them fired in
    // the same task and charged ONCE (runJobAsync), so the pair gets 260 rather
    // than 440: the flights are simultaneous, not sequential, and 260 is the
    // hold the `banked_property`/`play_action` beats already use for a single
    // exchange. The second half never reaches this function.
    case 'move_property': return ev.swapWith == null ? 220 : 260;
    case 'opsec': return 300;
    case 'action_blocked': return 280;
    case 'steal': return 480;
    case 'swap': return 460;
    case 'shuffle': return 420;
    case 'set_completed': return 300;
    case 'scoop': return 300;
    case 'win': return 320;
    case 'stalemate': return 320;
    // The armed player's resolving turn gets a longer beat: the win lands on
    // the next event and it should land into stillness (§3.10).
    case 'turn_start': return ev.finalApproach ? 300 : 140;
    case 'turn_end': return 90;
    case 'final_approach': return 260;
    case 'final_approach_broken': return 260;
    case 'rent_charged': return 200;
    case 'demand': return 160;
    case 'insolvent': return 160;
    case 'game_start': return 120;
    default: return 120;
  }
}

function countOf(ev) {
  if (Array.isArray(ev.cards)) return ev.cards.length || 1;
  return Math.max(1, ev.count || 1);
}

/* ── primitives ────────────────────────────────────────────────────────── */

function claim(expected, id) { if (id != null) expected.add(id); }

/**
 * Move a card, spawning it at its origin if this client has never seen it.
 *
 * A node that does not exist yet is a card that was HIDDEN until now — an
 * opponent's hand card reaching the table, or a card off the deck. So the
 * spawn-and-flip rule needs no per-event bookkeeping: if we had no node, the
 * card enters face-down at its origin and turns over in flight.
 */
function move(card, zoneKey, expected, animate, originKey, o) {
  if (!card || card.id == null || !zoneKey) return;
  claim(expected, card.id);
  // Catching up: claim only, touch nothing. The job still running owns an
  // OLDER snapshot, and moving a card to where it will be in two states' time
  // makes that job's reconcile drag it back — which is exactly the drift this
  // path exists to avoid. The surviving job's reconcile places it, silently,
  // because the claim rode along in job.carry.
  if (catchUp) return;
  const known = !!getNode(card.id);
  if (!known) table.spawnCard(card, originKey || zoneKey, { faceDown: animate && !!originKey });

  const opts = o || {};
  opts.animate = animate;
  if (!known && animate && originKey) { opts.flip = true; if (opts.flipAt == null) opts.flipAt = 0.5; }
  table.moveCard(card.id, zoneKey, opts);
}

/** Every upgrade card a player currently holds — a broken set silently discards
 *  them and the engine emits no event for it (game.js discardUpgrades). */
function claimUpgradesOf(playerId, expected) {
  if (!playerId) return;
  const board = table.boardEl(playerId);
  if (!board) return;
  for (const zone of board.querySelectorAll('.zone-ups')) {
    for (const node of zone.children) {
      const id = Number(node.getAttribute('data-card-id'));
      if (Number.isInteger(id)) expected.add(id);
    }
  }
}

/**
 * The same claim, read from the SNAPSHOT instead of the felt.
 *
 * claimUpgradesOf() asks the DOM "what is on this player's board right now",
 * which is the right question on a performed job and the wrong one on a
 * collapsed batch: catch-up moves nothing, so if the `upgrade` that placed the
 * card and the event that breaks its set land in the SAME dropped batch, the
 * card is still sitting in a hand in the DOM and the claim finds an empty zone.
 *
 * Measured: 1 drift correction in 2 of 4 runs of the 273-event game at 120ms —
 * always `move 86 → discard`, always seq 68/69 (play_action upgrade → upgrade)
 * collapsed into the same batch as seq 76 (the swap that broke brown).
 *
 * An upgrade card lying on the discard pile is, by definition, a card no event
 * will ever move again — the engine has no per-card event for it and never will
 * (§4). Claiming those is therefore not a widened silence: it is the same claim,
 * sourced from the only description of the table that is always current.
 */
function claimDiscardedUpgrades(snapshot, expected) {
  for (const card of snapshot?.discardPile || []) {
    if (card && (card.action === 'upgrade' || card.action === 'foc')) claim(expected, card.id);
  }
}

function claimAllOf(playerId, expected) {
  const board = table.boardEl(playerId);
  if (!board) return;
  for (const node of board.querySelectorAll('[data-card-id]')) {
    const id = Number(node.getAttribute('data-card-id'));
    if (Number.isInteger(id)) expected.add(id);
  }
}

function claimDiscard(expected) {
  const zone = table.zoneFor('discard');
  if (!zone) return;
  for (const node of zone.children) {
    const id = Number(node.getAttribute('data-card-id'));
    if (Number.isInteger(id)) expected.add(id);
  }
}

const Z = table.zoneKeyFor;

/**
 * Where a property actually landed. `receiveProperty` (game.js) returns the
 * literal string 'bank' when the owner has no legal colour zone left, so
 * `steal.toColor`, `swap.gaveColor` and `swap.tookColor` are NOT always colours.
 * Addressing `properties:<pid>:bank` gets null from zoneEl and the card would
 * teleport at the reconcile instead of flying anywhere.
 */
function landing(playerId, color) {
  return color === 'bank' || !color ? Z('bank', playerId) : Z('properties', playerId, color);
}

/* ── geometry helpers (layout reads happen per EVENT, never per frame) ──── */

/**
 * An FX cue anchored on an element. Silent while we are catching up UNLESS the
 * event is a big moment (see BIG above): a final-approach arming is not as
 * droppable as a card slide, and treating them the same is what deleted 42% of
 * the game's feedback on a fast table.
 */
let loud = true;
function signal(kind, mine, big, el) {
  if (!loud) return;
  cueEl(kind, mine, big, el);
}

const centre = { x: 0, y: 0 };

function centreOf(el) {
  if (!el) { centre.x = innerWidth / 2; centre.y = innerHeight / 2; return centre; }
  const r = el.getBoundingClientRect();
  centre.x = r.left + r.width / 2;
  centre.y = r.top + r.height / 2;
  return centre;
}

// The action card in flight through a response window. `play_action` discards
// it before anyone can answer (game.js discardAndSpend), so by the time the
// engine says who it was aimed at — `demand`, `rent_charged` — or that it was
// blocked, the card is lying face-up on the pile. Remembering which one it is
// is the only way left to point it at anybody.
let actionCardId = null;

/**
 * Lunge a card `factor` of the way toward `el` and let it snap back.
 * Positive factor = it slides at the target; negative = it is knocked away.
 */
function lungeCard(id, el, factor, opts) {
  if (id == null || !el) return false;
  const node = getNode(id);
  if (!node) return false;
  const from = centreOf(node);
  const fx = from.x, fy = from.y;
  const to = centreOf(el);
  return table.shoveCard(id, (to.x - fx) * factor, (to.y - fy) * factor, opts);
}

/* ── the claim table + choreography ────────────────────────────────────── */

function applyEvent(ev, snapshot, expected, animate) {
  const sfx = ev.t;
  const mine = ev.actor === selfId;
  loud = !catchUp || !!BIG[ev.t];
  // Set pieces that are pure motion (a lunge, a fold, a column snapping shut)
  // have no reduced-motion form: they are skipped, and their cue carries the
  // beat instead.
  const motion = animate && !table.reducedMotion();
  // "Is there a cue at all?" — separate from "is there motion?". A collapsed
  // job performs nothing (animate === false) but a big moment still has to
  // SOUND and FLASH; signal() then filters to the BIG set. The harness's
  // instant path is animate:false with catchUp:false and stays cue-free, which
  // is what keeps tools/screenshot.mjs reproducible.
  const cued = animate || catchUp;

  switch (ev.t) {
    case 'deal':
    case 'draw': {
      const stagger = ev.t === 'deal' ? STAGGER.deal : STAGGER.draw;
      const zone = Z('hand', ev.to);
      if (Array.isArray(ev.cards)) {
        // AUTO-DRAW (engine, P7 round 1): the engine draws at turn start now, so
        // this is the most-seen animation in the game — every turn, every seat.
        // 30px of bow so the cards visibly come OFF the deck rather than sliding
        // through it, and the turn at 58% so the face is arriving, not arrived.
        for (let i = 0; i < ev.cards.length; i++) {
          move(ev.cards[i], zone, expected, animate, 'deck',
            { delay: i * stagger, flipAt: 0.58, arc: ev.t === 'draw' ? 30 : undefined });
        }
      } else if (animate && !catchUp) {
        // §4 redaction: an opponent's deal/draw carries a COUNT and no ids, so
        // there is nothing for move() to move. This used to `break` — which is
        // why three of the four events in the opening deal animated nothing at
        // all while the queue charged 440ms each for them: 1,320ms of measured
        // dead air at the very start of every game. Face-down backs off the deck
        // are the honest thing to show, and they are the only thing the player
        // is allowed to see.
        table.dealBacks(zone, countOf(ev), { stagger });
      }
      // Per-card landings already cue; deal_done is the "hands are out" beat.
      if (cued && ev.t === 'deal') signal(CUE.DEAL_DONE, ev.to === selfId, false, table.zoneFor('hand'));
      break;
    }

    case 'play_money':
      move(ev.card, Z('bank', ev.actor), expected, animate, Z('hand', ev.actor));
      break;

    // A property that could not fit anywhere legal and became money (§3.5).
    // Origin is deliberately null: it is already somewhere on the table (a
    // victim's column, a payer's board) and move() flies it from wherever it is.
    case 'banked_property':
      move(ev.card, Z('bank', ev.actor), expected, animate, null, { big: true, arc: 24 });
      break;

    case 'play_property':
      move(ev.card, Z('properties', ev.actor, ev.color), expected, animate, Z('hand', ev.actor));
      break;

    case 'play_action': {
      // upgrade/foc are placed by the `upgrade` event that follows; every other
      // action card is discarded by discardAndSpend() before the response window.
      if (ev.action === 'upgrade' || ev.action === 'foc') { claim(expected, ev.card?.id); break; }
      actionCardId = ev.card?.id ?? null;
      move(ev.card, 'discard', expected, animate, Z('hand', ev.actor),
        { big: ev.action === 'chud', arc: 26 });
      break;
    }

    // Who the card on the pile is pointed at. 34% of the way is as far as a
    // card can lunge before it reads as a second flight rather than a threat.
    case 'demand':
      if (motion) lungeCard(actionCardId, table.boardEl(ev.target), 0.34, { dur: 300, spin: 5 });
      break;

    case 'rent_charged':
      if (motion) lungeCard(actionCardId, table.boardEl((ev.targets || [])[0]), 0.3, { dur: 300, spin: 5 });
      break;

    case 'opsec': {
      // The clash: the OPSEC card comes in fast and shoves the card it answers
      // back off the pile's centre.
      if (motion) lungeCard(actionCardId, table.boardEl(ev.actor), -0.22, { dur: 280, spin: -9, delay: 90 });
      move(ev.card, 'discard', expected, animate, Z('hand', ev.actor), { speed: 0.85, big: true, arc: 30 });
      if (cued) signal(CUE.OPSEC_CLASH, mine || ev.against === selfId, true, table.zoneFor('discard'));
      break;
    }

    case 'upgrade':
      move(ev.card, Z('upgrades', ev.actor, ev.color), expected, animate, Z('hand', ev.actor));
      break;

    case 'action_blocked':
      if (motion) lungeCard(actionCardId, table.boardEl(ev.target), -0.3, { dur: 320, spin: -8 });
      if (cued) {
        signal(CUE.ACTION_BLOCKED, ev.target === selfId || ev.source === selfId, true,
          table.boardEl(ev.target));
      }
      actionCardId = null;
      break;

    case 'payment': {
      claimUpgradesOf(ev.from, expected);
      claimDiscardedUpgrades(snapshot, expected);
      const cards = ev.cards || [];
      const forMe = ev.to === selfId || ev.from === selfId;
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const zone = isPropertyCard(card)
          ? Z('properties', ev.to, card.placedColor || card.color)
          : Z('bank', ev.to);
        move(card, zone, expected, animate, Z('bank', ev.from), { delay: i * STAGGER.payment });
      }
      if (cued && cards.length) {
        signal(CUE.PAYMENT_DONE, forMe, cards.length >= 4, table.boardEl(ev.to));
      }
      break;
    }

    // The three thefts all use `hero: true` — table/moveCard swells the card to
    // a readable 92px at mid-flight and puts it back. Before it, the "480ms of
    // drama" was a 14px miniature sliding between two 14px slots on a 4-player
    // 1280×720 table: illegible in the capture even magnified 2.8×.
    //
    // And the cue is anchored on the CARD, not on the thief's board. The crime
    // is where the card is; anchoring on the board put the red flash and the
    // "CHUD!" label over a board on the far side of the table from the theft.
    case 'steal':
      claimUpgradesOf(ev.from, expected);
      claimUpgradesOf(ev.actor, expected);
      claimDiscardedUpgrades(snapshot, expected);
      // 120ms hold before it lifts: a theft you can see coming. Total 540ms.
      move(ev.card, landing(ev.actor, ev.toColor), expected, animate, Z('bank', ev.from),
        { delay: 120, speed: 1.12, big: true, hero: true });
      if (cued) signal(CUE.STEAL_LANDED, mine || ev.from === selfId, true, crimeEl(ev.card, ev.actor));
      break;

    case 'set_stolen': {
      claimUpgradesOf(ev.from, expected);
      claimUpgradesOf(ev.actor, expected);
      claimDiscardedUpgrades(snapshot, expected);
      const cards = ev.cards || [];
      for (let i = 0; i < cards.length; i++) {
        move(cards[i], Z('properties', ev.actor, ev.color), expected, animate,
          Z('properties', ev.from, ev.color),
          { delay: 40 + i * STAGGER.set_stolen, speed: 1.1, big: true, hero: i === 0 });
      }
      if (cued) signal(CUE.STEAL_LANDED, mine || ev.from === selfId, true, crimeEl(cards[0], ev.actor));
      break;
    }

    // AN EXCHANGE MUST READ AS AN EXCHANGE. Both halves used to leave at the
    // same instant on the same bow, so on a 1280×720 table the two cards
    // travelled the same corridor and overlapped for most of it: one blur
    // crossing the felt, indistinguishable from a single hero steal. Now they
    // bow to OPPOSITE sides (arc ±34) and the card the actor TAKES leaves 60ms
    // first, so the picture is two cards passing each other going opposite ways
    // — which is what a trade looks like. 100 + 60 + a 462ms flight = 622ms of
    // motion, but the queue's own step is 460ms and the tail overlaps the next
    // event, which §10 explicitly allows; the uninterruptible part is one
    // flight.
    case 'swap':
      claimUpgradesOf(ev.actor, expected);
      claimUpgradesOf(ev.target, expected);
      claimDiscardedUpgrades(snapshot, expected);
      move(ev.took, landing(ev.actor, ev.tookColor), expected, animate, null,
        { delay: 100, speed: 1.1, big: true, hero: true, arc: 34 });
      move(ev.gave, landing(ev.target, ev.gaveColor), expected, animate, null,
        { delay: 160, speed: 1.1, big: true, hero: true, arc: -34 });
      if (cued) signal(CUE.STEAL_LANDED, mine || ev.target === selfId, true, crimeEl(ev.took, ev.actor));
      break;

    // A wild moving between two of YOUR OWN columns. It was a 14px miniature
    // sliding 60px between two 20px slots in 216ms — the owner's word for it
    // was "teleport", and the capture agrees: at 80ms sampling it appears in
    // one frame in the old column and the next in the new one, with nothing in
    // between. `apex` gives it the hero treatment at a self-move scale (54px,
    // readable, not the 92px a theft gets) and the destination column's cards
    // now visibly shift to receive it (table/index.js reflowMeasure).
    case 'move_property':
      claimUpgradesOf(ev.actor, expected);
      claimDiscardedUpgrades(snapshot, expected);
      move(ev.card, Z('properties', ev.actor, ev.to), expected, animate, null,
        // A LONE wild moving between two of YOUR OWN columns bows 18°, on the
        // side flight.js picks. A SWAP HALF bows ±34 — the `swap`/TDY number
        // above, chosen there because at ±34 two cards crossing the same
        // corridor stop being one blur — and the sign is the half, so the two
        // arcs are mirrored by construction and cannot both pick the same side.
        // Both halves leave in the same task (runJobAsync) with no stagger:
        // this is an exchange inside ONE board, symmetric, unlike the TDY swap
        // where one card is taken and one is given and the 60ms offset says so.
        { speed: 0.9, apex: 54, big: true, arc: ev.swapWith == null ? 18 : (ev.swapHalf === 0 ? 34 : -34) });
      break;

    case 'discard': {
      const cards = ev.cards || [];
      for (let i = 0; i < cards.length; i++) {
        // Tumble: ±26° of spin on top of the seeded resting tilt it lands on.
        move(cards[i], 'discard', expected, animate, Z('hand', ev.actor), {
          delay: i * STAGGER.discard,
          spin: (i % 2 === 0 ? 1 : -1) * 26,
          arc: 22,
        });
      }
      break;
    }

    case 'shuffle': {
      claimDiscard(expected);                              // discard folds back into the deck
      if (motion) foldDiscardHome();
      signal(CUE.SHUFFLE, false, true, table.zoneFor('deck'));
      break;
    }

    case 'set_completed':
      if (motion) snapColumn(ev.actor, ev.color);
      signal(CUE.SET_COMPLETED, mine, true, columnEl(ev.actor, ev.color) || table.boardEl(ev.actor));
      break;

    case 'scoop':
      claimAllOf(ev.actor, expected);
      claimUpgradesOf(ev.actor, expected);
      claimDiscardedUpgrades(snapshot, expected);
      break;

    case 'turn_start':
      // §3.10: this is the turn the armed player's win resolves on. Settle the
      // table first — the beat of quiet before it lands is free here, because
      // finishAll only snaps what is already in the air.
      if (ev.finalApproach) flight.finishAll();
      signal(CUE.TURN_START, mine, mine || !!ev.finalApproach, table.boardEl(ev.actor));
      break;

    // §3.10 final approach: no card moves, the table just got very tense.
    case 'final_approach':
      signal(CUE.FINAL_APPROACH, mine, true, table.boardEl(ev.actor));
      break;

    case 'final_approach_broken':
      signal(CUE.APPROACH_BROKEN, mine || ev.by === selfId, true, table.boardEl(ev.actor));
      break;

    case 'win':
      // §5: the table settles. Everything in the air lands now and nothing new
      // takes off — the overlay is ui/'s and it must not open over moving cards.
      flight.finishAll();
      signal(CUE.WIN, mine, true, table.boardEl(ev.actor));
      break;

    case 'stalemate':
      flight.finishAll();
      signal(CUE.STALEMATE, ev.winner === selfId, true, table.zoneFor('deck'));
      break;

    default:
      break;                                               // pure signal events
  }

  if (loud) {
    bus.emit(EVENTS.CHOREO_SFX, { name: sfx, ev, mine });
    // fx/ resolves a steal's DIRECTION from the event, not the cue (it holds the
    // beat for exactly one event). Catch-up skips runJobAsync's emit, so without
    // this a steal against you during backpressure decayed to the neutral
    // "somebody stole something" form — and ui/ never saw the win.
    if (catchUp) bus.emit(EVENTS.CHOREO_EVENT, ev);
  }
}

/* ── set pieces ────────────────────────────────────────────────────────── */

/**
 * Where the crime is: the card itself if we have a rendered node for it, else
 * the board. The rect check is not defensive padding — a card node parked in a
 * zone that is not laid out measures 0×0, and cueEl would then anchor the red
 * flash and the "CHUD!" label at viewport (0,0).
 */
function crimeEl(card, fallbackPlayerId) {
  const node = card && card.id != null ? getNode(card.id) : null;
  if (node && node.getBoundingClientRect().width > 0) return node;
  return table.boardEl(fallbackPlayerId);
}

function columnEl(playerId, color) {
  const board = table.boardEl(playerId);
  return board ? board.querySelector(`.propcol[data-color="${color}"]`) : null;
}

/** The discard pile folds home to the deck, then the deck riffles. */
function foldDiscardHome() {
  const zone = table.zoneFor('discard');
  const deck = table.zoneFor('deck');
  if (!zone || !deck) return;
  const to = centreOf(deck);
  const tx = to.x, ty = to.y;
  let i = 0;
  for (let node = zone.lastElementChild; node; node = node.previousElementSibling, i++) {
    const from = centreOf(node);
    flight.flyOut(node, tx - from.x, ty - from.y, {
      dur: 240, delay: i * 24, scale: 0.86, turn: (i % 2 ? 12 : -12),
    });
  }
  table.riffleDeck();
}

/**
 * A completed set snaps together: every card in the column converges from
 * slightly splayed and slightly oversized onto its resting place. The pulse is
 * the cards themselves — nothing here touches the column's chrome, which is
 * the design agent's (the FX cue carries the beat for fx/).
 */
function snapColumn(playerId, color) {
  const zone = table.zoneFor('properties', playerId, color);
  if (!zone) return;
  const n = zone.childElementCount;
  if (!n) return;
  let i = 0;
  for (let node = zone.firstElementChild; node; node = node.nextElementSibling, i++) {
    const u = i - (n - 1) / 2;
    flight.fly(node, {
      dx: u * 9, dy: -5, scale: 1.06, dur: 260, delay: i * 18, arc: 0,
      spin: 0, quiet: true, key: i, mine: playerId === selfId,
    });
  }
}

/* ── the hand re-fans when the interaction agent lifts a card ───────────── */

bus.on(EVENTS.INTERACT_CHANGED, () => table.relayoutHand());
