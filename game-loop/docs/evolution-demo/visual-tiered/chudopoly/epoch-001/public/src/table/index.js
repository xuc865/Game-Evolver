// table/index.js — the §5 table API.
//
//   zoneFor(kind, ownerId, color)         → zone element
//   spawnCard(card, zoneKey)              → node, parented to the zone
//   moveCard(id, zoneKey, {animate, ...}) → reparent + measured flight
//   reconcile(snapshot, {expected})       → snapshot wins; count what surprised us
//
// The snapshot is truth and animation is presentation (§10). reconcile()
// therefore never asks how a card got somewhere — it computes where every card
// belongs and puts it there. `driftCount` counts only the corrections the
// choreographer did NOT claim: a nonzero count means the animation told the
// player a different story than the server did.
//
// P4: the FLIP invert is no longer a CSS transition. moveCard measures, then
// hands the invert to anim/flight.js, which owns --fx/--fy/--fs/--tilt on the
// one clock until the card lands on its rest pose (see cardnode.js).

import { orderChildren, setText, setAttr, setClass, prefersReducedMotion } from '../core/dom.js';
import { COLOR_KEYS } from '../core/cards.js';
import { hash1, clamp, damp } from '../core/math.js';
import { cardNode, getNode, allNodes, forgetNode, refresh, syncBacks, releaseBack, tilt, setRest } from './cardnode.js';
import * as layout from './layout.js';
import * as hand from './hand.js';
import * as flight from '../anim/flight.js';
import { cue, CUE } from '../anim/cues.js';

export const zoneFor = layout.zoneFor;
export const zoneKeyFor = layout.zoneKeyFor;
export const boardEl = layout.boardEl;
export const allBoards = layout.allBoards;

const DECK_DEPTH = 6;         // §5: a real stack, up to 6 back nodes + count
const HAND_BACKS = 9;         // §5: count-accurate to 9, then a counter
const DISCARD_VISIBLE = 4;    // deeper cards are invisible anyway; 50 nodes was 3ms/reconcile
const DECK_LIFT = -1.5;       // px per card of stack depth
const DISCARD_TILT = 7;       // §5: seeded per card id, deterministic

// Flight duration from measured distance (§6 wants 180–420ms). 0.42ms/px puts
// deck→hand (≈250px on a 390px phone) at 285ms and the longest cross-table
// steal (≈580px on desktop) at the 420 ceiling.
const MS_MIN = 180, MS_MAX = 420, MS_PER_PX = 0.42;

// Apex width of a hero flight (a steal, a set being taken, a swap). 92px puts
// the card's name band at ~13px on a 1280×720 table — the smallest size the
// name was still readable at in the frame captures. Bigger than ~110 and the
// card covers the board it is being taken from.
const HERO_APEX_PX = 92;

const EMPTY = new Set();

const metrics = { drift: 0, lastCorrections: [] };
let selfId = null;
let reduceMotion = false;

export function mount(mySeatId) {
  selfId = mySeatId;
  reduceMotion = prefersReducedMotion();
  if (typeof matchMedia === 'function') {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => { reduceMotion = mq.matches; if (reduceMotion) flight.finishAll(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
  layout.mount(document.getElementById('table'), mySeatId);
  watchDragClass();
}

export function setSelf(id) {
  selfId = id;
  // layout.js keys every zone off the seat id ('hand' vs 'hand:<uuid>'), and it
  // used to learn that id only at mount() — before `joined` arrives — and then
  // only inside syncSeats(), which first runs at the job-ENDING reconcile. The
  // whole opening deal therefore addressed `hand:<uuid>`, got null, and did not
  // move. Propagating here is the fix; see layout.setSelf.
  layout.setSelf(id);
}
export function driftCount() { return metrics.drift; }
export function resetDrift() { metrics.drift = 0; metrics.lastCorrections.length = 0; }
export function lastCorrections() { return metrics.lastCorrections.slice(); }
export function reducedMotion() { return reduceMotion; }

/**
 * Build the STRUCTURE a job's choreography is about to address, before any of
 * its events run. Nothing here places a card — it seats the boards and paints
 * the piles so that zoneEl()/boardEl() answer during the very first job.
 *
 * Measured: without it the first job of every game ran against zero boards, so
 * every cue anchored on boardEl(actor) fired at viewport (0,0) and the opening
 * deal had nowhere to deal TO. reconcile() called syncSeats itself, at the end,
 * which is 1.9s too late.
 */
export function prepare(snapshot) {
  if (!snapshot) return false;
  const rebuilt = layout.syncSeats(snapshot, selfId);
  if (rebuilt) structuralPending = true;
  // A deal has to come off a visible deck. The count is the POST-deal number —
  // the same "snapshot is truth" lie the whole animation tells — and it beats
  // the measured alternative, which was dealing 20 cards off a stack labelled
  // "DECK 0".
  syncBacks(layout.zoneEl('deck'), Math.min(snapshot.deckCount || 0, DECK_DEPTH), { lift: DECK_LIFT });
  setText(document.getElementById('deck-count'), String(snapshot.deckCount ?? 0));
  return rebuilt;
}
let structuralPending = false;

/**
 * Fly `count` face-down backs from the deck into a face-down zone (an opponent's
 * hand). Opponent deals and draws carry no card ids by design (§4 redaction), so
 * there is nothing for moveCard to move — before this they were a `break`, and
 * three of the four events in the opening deal animated nothing at all.
 *
 * The backs it flies ARE the backs reconcile will keep: syncBacks() pools by
 * count, so adding them here and letting the reconcile re-pose them costs no
 * churn and cannot drift (a pooled back has no card id).
 *
 * @returns {number} backs actually launched
 */
export function dealBacks(zoneKey, count, opts = {}) {
  if (!(count > 0)) return 0;
  const zone = layout.zoneEl(zoneKey);
  const deck = layout.zoneEl('deck');
  if (!zone || !deck) return 0;
  const dr = deck.getBoundingClientRect();
  if (!dr.width) return 0;
  const have = zone.childElementCount;
  const want = Math.min(have + count, HAND_BACKS);
  if (want <= have) return 0;
  syncBacks(zone, want, { tilt: 4 });
  if (reduceMotion) return 0;

  const dcx = dr.left + dr.width / 2, dcy = dr.top + dr.height / 2;
  const stagger = opts.stagger || 0;
  let i = 0, launched = 0;
  for (let child = zone.firstElementChild; child; child = child.nextElementSibling, i++) {
    if (i < have) continue;
    const r = child.getBoundingClientRect();
    if (!r.width) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = dcx - cx, dy = dcy - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    flight.fly(child, {
      dx, dy,
      scale: r.width > 0 ? dr.width / r.width : 1,
      dur: clamp(MS_MIN + dist * MS_PER_PX, MS_MIN, MS_MAX),
      delay: launched * stagger,
      spin: (hash1(i + 7) * 2 - 1) * 10,
      mine: false, big: false, key: i,
      cx0: dcx, cy0: dcy, cx1: cx, cy1: cy,
    });
    launched++;
  }
  return launched;
}

export function spawnCard(card, zoneKey, opts = null) {
  const node = cardNode(card);
  if (!node) return null;
  const zone = layout.zoneEl(zoneKey);
  if (zone && node.parentElement !== zone) {
    layout.revealZone(zone);
    zone.appendChild(node);
    setRest(node, 0, 0, 0);
  }
  if (opts && opts.faceDown) flight.setFacing(node, false);
  return node;
}

/** Flip a card face-up/face-down about its Y axis (anim/flight owns the turn). */
export function flipCard(id, faceUp, opts = {}) {
  const node = getNode(id);
  if (!node) return false;
  if (opts.animate === false || reduceMotion) { flight.setFacing(node, faceUp); return true; }
  const r = node.getBoundingClientRect();
  flight.flip(node, faceUp, {
    mine: !!opts.mine, big: !!opts.big, dur: opts.duration,
    cx0: r.left + r.width / 2, cy0: r.top + r.height / 2,
  });
  return true;
}

/**
 * Reparent a card into a zone and fly it there.
 *
 * measure (centroid + offsetWidth, both immune to the transform we are about
 * to write) → reparent → neutralise → measure → launch. Centroids rather than
 * rect corners because a rectangle's AABB centre is its centroid under any
 * rotate/scale, so a card leaving a fanned hand measures exactly.
 *
 * @param {number} id
 * @param {string} zoneKey
 * @param {{animate?:boolean, force?:boolean, springBack?:boolean, delay?:number,
 *          speed?:number, arc?:number, spin?:number, flip?:boolean,
 *          flipAt?:number, mine?:boolean, big?:boolean, hold?:number,
 *          onDone?:Function}} opts
 */
export function moveCard(id, zoneKey, opts = {}) {
  const node = getNode(id);
  const zone = layout.zoneEl(zoneKey);
  if (!node || !zone) return false;
  const same = node.parentElement === zone;

  // The interaction agent's drop-cancel: the card never left the hand, it is
  // just sitting wherever the finger let go of it. `fromX/fromY/fromScale` is
  // where that actually was: by the time this runs, releaseCard's hand relayout
  // has already rewritten the node's --fx/--fy to the REST pose (setRest →
  // retarget → writeRest), so springHome must be told the drop point rather
  // than left to read vars that no longer hold it — the un-told version was a
  // measured 620px/13ms teleport followed by 240ms of stationary "flight".
  if (opts.springBack) {
    if (!same) zone.appendChild(node);
    if (reduceMotion || flight.isDragging(node)) { flight.writeRest(node); return true; }
    const r = node.getBoundingClientRect();
    flight.springHome(node, {
      dur: opts.duration || 240, key: id,
      fromX: opts.fromX, fromY: opts.fromY, scale: opts.fromScale,
      cx1: r.left + r.width / 2, cy1: r.top + r.height / 2,
    });
    return true;
  }
  if (same && !opts.force) return false;

  // `mine` is EITHER END, not the destination. Destination-only got the two
  // moments that matter exactly backwards: your own property being stolen
  // (properties:<you>:<colour> → properties:<thief>:<colour>) and your own CHUD
  // hitting the discard both resolved false, so audio played them −7dB,
  // off-centre and lowpassed as if they had happened to somebody else.
  const fromKey = node.parentElement ? node.parentElement.getAttribute('data-zone') : null;
  const mine = opts.mine == null
    ? (layout.isMineZone(zoneKey) || layout.isMineZone(fromKey))
    : !!opts.mine;

  layout.revealZone(zone);

  if (opts.animate === false || flight.isDragging(node)) {
    zone.appendChild(node);
    flight.cancel(node);
    if (opts.flip != null) flight.setFacing(node, opts.flip);
    setRest(node, 0, 0, 0);
    flight.writeRest(node);
    return true;
  }

  // §0.9: motion collapses to a fade in place; the cue vocabulary does not.
  if (reduceMotion) {
    zone.appendChild(node);
    flight.cancel(node);
    if (opts.flip != null) flight.setFacing(node, opts.flip);
    setRest(node, 0, 0, 0);
    flight.writeRest(node);
    const r = node.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    cue(CUE.FLIGHT_START, mine, !!opts.big, cx, cy);
    // A card that turns over is still a beat even when it does not turn.
    if (opts.flip != null) cue(CUE.FLIP, mine, !!opts.big, cx, cy);
    // LANDED fires NOW, not on the fade's onDone. Under reduced motion the card
    // is already at its destination the instant it is reparented, so hanging the
    // snap 120ms off the back of a purely cosmetic opacity ramp put the sound
    // 120ms behind the truth — §0.9 collapses motion, it does not delay signal.
    cue(CUE.LANDED, mine, !!opts.big, cx, cy);
    flight.fade(node, { dur: 120 });
    return true;
  }

  const first = node.getBoundingClientRect();
  const w0 = node.offsetWidth;
  const t0 = currentTilt(node);

  flight.cancel(node);
  const fromZone = node.parentElement;
  reflowMeasure(fromZone, zone, node);
  zone.appendChild(node);
  reflowApply();
  setRest(node, 0, 0, 0);
  flight.writeRest(node);

  if (first.width === 0) {                       // was not rendered — nothing to invert
    if (opts.flip != null) flight.setFacing(node, opts.flip);
    return true;
  }

  const last = node.getBoundingClientRect();
  // The destination is not rendered (a hidden zone, a collapsed board). Inverting
  // against a 0×0 rect is what sent stolen cards flying to viewport (0,0) — the
  // card is placed and the beat is skipped rather than performed into a corner.
  if (last.width === 0) {
    if (opts.flip != null) flight.setFacing(node, opts.flip);
    return true;
  }

  const w1 = node.offsetWidth || w0;
  const dx = (first.left + first.width / 2) - (last.left + last.width / 2);
  const dy = (first.top + first.height / 2) - (last.top + last.height / 2);
  const scale = w1 > 0 ? w0 / w1 : 1;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 1 && Math.abs(scale - 1) < 0.02 && opts.flip == null) return true;

  // speed scales INSIDE the clamp: §6 caps a single flight at 420ms, and the
  // deliberate feel of a steal comes from its 120ms hold, not from a slower
  // card. (Outside the clamp, a 1.12× steal measured 470ms and pushed the
  // event's total commitment to 602ms.)
  const dur = clamp((MS_MIN + dist * MS_PER_PX) * (opts.speed || 1), MS_MIN, MS_MAX);
  // Deterministic per card so a screenshot run reproduces (§5).
  const spin = opts.spin == null
    ? (hash1(id + 3) * 2 - 1) * Math.min(12, 3 + dist * 0.02)
    : opts.spin;

  // HERO LIFT — a big-moment card has to be READABLE while it travels.
  // Measured on a 4-player 1280×720 table: a stolen property is a 14px-wide
  // miniature sliding between two 14px slots, illegible even at 2.8×
  // magnification of the capture, for the 480ms the choreographer spends
  // calling it drama. The bump is an extra scale on a sin envelope, so the card
  // swells at mid-flight and is back to exactly 1 when it lands — the measured
  // FLIP end state is untouched.
  //
  // HERO_APEX_PX is a target width at the apex, not a factor: the same +0.5 that
  // is right for a hand card would do nothing for a 14px mini.
  let bump = opts.bump || 0;
  if (!bump && (opts.hero || opts.apex)) {
    bump = clamp((opts.apex || HERO_APEX_PX) / Math.max(8, w1) - 1, opts.apex ? 0.1 : 0.22, 4);
  }
  // A magnified card must escape its ancestors; so must a card that takes off
  // from OUTSIDE them, which is every card played by drag (it leaves the finger
  // somewhere over the felt and flies into a 20px column scrollport) and every
  // card that crosses the table. Asking `escapes` costs one getComputedStyle
  // walk per event, never per frame, and answers false for the common case of a
  // card shuffling one slot inside the zone it already lives in.
  const cx0 = first.left + first.width / 2, cy0 = first.top + first.height / 2;
  if (bump > 0 || escapes(node, cx0, cy0)) unclip(node, dur + (opts.delay || 0) + 60);

  flight.fly(node, {
    dx, dy, scale, dur, bump,
    delay: opts.delay || 0,
    arc: opts.arc,
    spin,
    tiltFrom: t0,
    flipTo: opts.flip == null ? null : opts.flip,
    flipAt: opts.flipAt,
    mine,
    // ART §4's hitstop. Armed on the landings a player is meant to FEEL: their
    // own cards, and anything the choreographer already calls a big moment.
    // flight.js pays for the freeze out of the flight's own duration, so §10's
    // 600ms is unchanged (see HITSTOP_MS there).
    hit: opts.hit == null ? (mine || !!opts.big || !!opts.hero) : !!opts.hit,
    // A card that crossed a third of the viewport is an event you can feel.
    big: opts.big == null ? dist > Math.min(innerWidth, innerHeight) * 0.34 : !!opts.big,
    key: id,
    cx0: first.left + first.width / 2, cy0: first.top + first.height / 2,
    cx1: last.left + last.width / 2, cy1: last.top + last.height / 2,
    onDone: opts.onDone || null,
  });

  // THE FAN CLOSES NOW, not at the reconcile. A card played out of the hand
  // used to leave a hole in the fan for the whole event — 240ms for a
  // play_property, 560ms for a payment — because hand.layout only ran from
  // reconcile() at the END of the job. Measured on the desktop burst: the gap
  // was still open 9 frames after the card left. It goes last so the FLIP above
  // has already measured against the layout tighten() may change.
  const handZone = layout.zoneEl('hand');
  if (fromZone === handZone || zone === handZone) {
    if (fromZone === handZone) hand.forget(node);
    relayoutHand();
  }
  return true;
}

/** A there-and-back shove: the blocked action card, the OPSEC clash. */
export function shoveCard(id, dx, dy, opts = {}) {
  const node = getNode(id);
  if (!node || reduceMotion) return false;
  flight.punch(node, dx, dy, opts);
  return true;
}

/** The deck's riffle: the stack jitters in place. Pooled backs, no ids. */
export function riffleDeck() {
  const zone = layout.zoneEl('deck');
  if (!zone || reduceMotion) return false;
  let i = 0;
  for (let child = zone.firstElementChild; child; child = child.nextElementSibling, i++) {
    const side = i % 2 === 0 ? 1 : -1;
    child.classList.add('is-riffling');
    flight.punch(child, side * (3 + i * 1.6), -2 - i, {
      dur: 240, delay: i * 26, spin: side * (2 + i * 0.8), env: 0.8,
      onDone: (n) => n.classList.remove('is-riffling'),
    });
  }
  return i > 0;
}

/* ══ THE HELD CARD ═════════════════════════════════════════════════════════
 * The public contract with interact/ for the life of a direct-manipulation
 * drag. Three calls, and only the first and last are required:
 *
 *   table.liftCard(id, opts?)   → boolean   at drag start
 *   table.dragCard(id, x, y)    → void      on every pointer move (optional)
 *   table.releaseCard(id, opts?)→ boolean   at drop / cancel / abort
 *
 * liftCard is what makes a held card render above the entire table. It is the
 * hero flight's unclip() generalised to an unbounded lifetime: the card's whole
 * clipping ancestor chain — hand zone, dock, board, scroll boxes, the felt —
 * is opened and refcounted, and put back with its scroll offsets on release.
 * z-index is NOT this file's problem (interact.css already gives .is-dragging
 * 60, and neither #table nor #hand-dock creates a stacking context); `.is-held`
 * exists as the floor for a lift that is not also a pointer drag.
 *
 * It also takes the card out of the fan so hand.js can close the gap behind it,
 * and retracts the hand 24px + flattens it (ART §5.5) to open the lane to the
 * board.
 *
 * SAFETY. The three failure modes this is built against:
 *   • drop lands while a broadcast does — releaseCard downgrades the hold to a
 *     timed one (HOLD_TAIL_MS) instead of closing it, so the clip cannot shut
 *     on a card the choreographer has just put in the air; and it never writes
 *     --fx/--fy, so interact's drop offset survives for moveCard's FLIP.
 *   • reparented mid-drag — the chain opened at lift is released by identity,
 *     and dragCard re-opens whatever new chain the card has landed in.
 *   • nested clipping ancestors — the walk opens every one of them, not the
 *     first, and refcounts so two overlapping lifts cannot close each other's.
 *   • never released at all — sweepLifts() runs from reconcile() and drops any
 *     lift whose node is gone, has left the DOM, or has outlived LIFT_MAX_MS.
 */
const lifts = new Map();          // cardId -> {node, chain:[], t0, vx, vy, tms}
const LIFT_MAX_MS = 20000;        // a drag nobody ended; longer than any real one
const HOLD_TAIL_MS = 1100;        // > interact's COMMIT_HOLD_MS (900) + one flight

// ART-DIRECTION §4: drag tilt `rotate(v * 6deg)`, `scaleX(1 + |v| * 0.08)`.
// v is normalised against V_REF. 1.6px/ms measured: a deliberate hand→column
// drag on a 1280×720 table covers ~300px in ~310ms (0.97px/ms) and reads as
// v≈0.6 — a 3.6° lean, present but not a flourish; a flick off the fan peaks
// at 2.4px/ms and saturates, which is where the full 6° belongs.
const V_REF = 1.6;
const V_SMOOTH = 0.35;            // exponential smoothing; raw pointer deltas jitter ±40%

export function liftCard(id, opts = {}) {
  const node = getNode(id);
  if (!node) return false;
  let rec = lifts.get(id);
  if (rec) { rec.t0 = performance.now(); return true; }     // idempotent
  rec = { node, chain: [], t0: performance.now(), vx: 0, tms: 0, px: 0, py: 0, parent: node.parentElement };
  lifts.set(id, rec);
  openChain(node, 0, rec.chain);
  node.classList.add('is-held');
  node.__wdt = undefined; node.__wds = undefined;           // a fresh drag pose
  if (opts.fan !== false && node.parentElement === layout.zoneEl('hand')) {
    hand.setHeld(node);
    hand.setOpenness(0);
    hand.setRetracted(true, handRoom());
    relayoutHand();
  }
  return true;
}

/**
 * How far the fan may retract before it leaves the viewport. Measured here,
 * once per lift, and not inside hand.layout(): it is a rect per card and
 * layout() runs on every reconcile.
 *
 * Measured on the current build: desktop 1280×720 = 18px, phone 390×844 = 18px
 * — so §5.5's ratified 24 clamps to 18 on both until the §5 three-column table
 * lands and gives the fan the 150px it is specified to have. The flatten is
 * unclamped and does the larger half of the job anyway (12° → 0° removes 9.6px
 * of tilt overhang off the top of every outer card).
 */
function handRoom() {
  const zone = layout.zoneEl('hand');
  if (!zone) return 0;
  let bottom = 0;
  for (let c = zone.firstElementChild; c; c = c.nextElementSibling) {
    const r = c.getBoundingClientRect();
    if (r.bottom > bottom) bottom = r.bottom;
  }
  return bottom ? Math.max(0, innerHeight - bottom) : 0;
}

/**
 * Pointer moved. Optional — a caller that never invokes it still gets the
 * unclip and the closed gap, just no velocity lean and no hand-reopen.
 *
 * @param {number} id    the held card
 * @param {number} x     viewport px
 * @param {number} y     viewport px
 */
export function dragCard(id, x, y) {
  const rec = lifts.get(id);
  if (!rec) return;
  const node = rec.node;
  const now = performance.now();
  const dt = rec.tms ? now - rec.tms : 0;
  rec.tms = now;

  if (dt > 0 && dt < 120 && !reduceMotion) {
    const vx = (x - rec.px) / dt;
    rec.vx += (vx - rec.vx) * V_SMOOTH;
    const v = clamp(rec.vx / V_REF, -1, 1);
    flight.setDragPose(node, v * 6, 1 + Math.abs(v) * 0.08);
  }
  rec.px = x; rec.py = y;

  // Re-open whatever the card is inside NOW: a broadcast can reparent a held
  // card, and the chain opened at lift no longer covers where it lives.
  // (While the pointer moves, the pose above owns rec.vx; dragSettle() below
  // only decays it once the move stream stops.)
  if (node.parentElement !== rec.parent) {
    rec.parent = node.parentElement;
    openChain(node, 0, rec.chain);
  }

  // "when it hovers back they should open to receive it" — the fan reopens as
  // the card comes back over the hand and closes again as it leaves. Linear in
  // the distance from the hand zone's own box so it tracks the finger instead
  // of snapping at a boundary; 90px of run-in is one card width plus a thumb.
  if (hand.heldNode() === node) {
    const zone = layout.zoneEl('hand');
    if (zone) {
      const r = zone.getBoundingClientRect();
      const d = r.height ? Math.max(0, Math.max(r.top - y, y - r.bottom), Math.max(r.left - x, x - r.right)) : 1e9;
      const opened = hand.setOpenness(1 - clamp(d / 90, 0, 1));
      const pulled = hand.setRetracted(d > 24, undefined);
      if (opened || pulled) relayoutHand();
    }
  }
}

/* ── the lean relaxes when the pointer parks (§P10 FEEL) ───────────────────
 * dragCard() computes the velocity pose only on pointermove, so when the move
 * stream stopped the pose froze at its last value: MEASURED, a fast sweep
 * followed by a 260ms hold left the held card at −4.2° / scaleX 1.055 for the
 * whole hold — a card "moving" at full lean while visibly parked. The decay
 * runs from interact/drag.js's already-running follow() subscriber (one clock,
 * §0.6), gated on the move stream being idle so it never fights a live move.
 *
 * τ = 120ms (λ = 8.3/s): a saturated 6° lean is under 1° ~220ms after the
 * finger parks and under the pose writer's own 0.1° quantum by ~450ms —
 * relaxed, not snapped. IDLE_MS 40 is two missed 60Hz pointer frames: a
 * still-moving pointer delivers moves every frame, so the decay cannot
 * engage mid-sweep. No allocation; setDragPose's quantised guards make a
 * settled card cost 0 writes/frame (§0.8). */
const LEAN_DECAY_LAMBDA = 8.3;    // 1/s → τ ≈ 120ms
const LEAN_IDLE_MS = 40;

/**
 * One frame of lean decay for a parked pointer. Called by interact/drag.js
 * follow() — which only runs while a drag is live and motion is not reduced.
 * @param {number} id  the held card
 * @param {number} dt  clock seconds
 */
export function dragSettle(id, dt) {
  const rec = lifts.get(id);
  if (!rec || rec.vx === 0 || reduceMotion) return;
  if (rec.tms && performance.now() - rec.tms < LEAN_IDLE_MS) return;
  rec.vx = damp(rec.vx, 0, LEAN_DECAY_LAMBDA, dt);
  if (Math.abs(rec.vx) < 0.005) rec.vx = 0;      // done: back to 0 writes/frame
  const v = clamp(rec.vx / V_REF, -1, 1);
  flight.setDragPose(rec.node, v * 6, 1 + Math.abs(v) * 0.08);
}

/**
 * The finger let go (or the drag was cancelled, or the card was yanked). Never
 * writes --fx/--fy: interact/drag.js deliberately leaves the card at the drop
 * point so moveCard's FLIP measures its `first` rect there and the motion
 * continues instead of restarting.
 */
export function releaseCard(id, opts = {}) {
  const rec = lifts.get(id);
  if (!rec) return false;
  lifts.delete(id);
  const node = rec.node;
  node.classList.remove('is-held');
  // Downgrade, do not close: the card is usually about to fly somewhere, and
  // the flight it is about to take starts INSIDE the chain we opened.
  const tail = opts.tail == null ? HOLD_TAIL_MS : opts.tail;
  if (tail > 0) openChain(node, tail, null);
  closeChain(rec.chain);
  if (!reduceMotion && opts.settle !== false) flight.relaxDrag(node);
  else { node.__wds = undefined; node.style.removeProperty('--fsx'); }

  // A REFUSED drop springs the card home, so the fan has to be ready to take it
  // back: reset now and the gap reopens while the card is still travelling.
  // An ACCEPTED one is about to leave the hand for good, so the gap stays shut
  // — reopening it and closing it again 120ms later when the broadcast lands is
  // two reflows for one departure, and it reads as a flinch. Only the retract
  // is undone. hand.forget() (moveCard, reconcile) clears `held` the moment the
  // card actually leaves, and the watchdog covers a server that never answers.
  clearTimeout(handTimer);
  if (opts.accepted && hand.heldNode() === node) {
    if (hand.setRetracted(false)) relayoutHand();
    handTimer = setTimeout(() => { if (hand.reset()) relayoutHand(); }, tail || HOLD_TAIL_MS);
  } else if (hand.reset()) relayoutHand();
  return true;
}
let handTimer = 0;

/** Is this card (or any card) currently lifted above the table? */
export function isLifted(id) { return id == null ? lifts.size > 0 : lifts.has(id); }

/** A lift nobody ended must not hold the felt open for the rest of the game. */
function sweepLifts() {
  if (!lifts.size) return;
  const now = performance.now();
  for (const [id, rec] of lifts) {
    if (rec.node.isConnected && now - rec.t0 < LIFT_MAX_MS) continue;
    releaseCard(id, { tail: 0 });
  }
}

/** Re-fan the hand after the interaction agent lifts/picks a card. */
export function relayoutHand() {
  const zone = layout.zoneEl('hand');
  if (!zone) return;
  const nodes = [];
  for (let c = zone.firstElementChild; c; c = c.nextElementSibling) {
    if (c.hasAttribute('data-card-id')) nodes.push(c);
  }
  hand.layout(nodes, !reduceMotion);
}

/* ── the safety net ───────────────────────────────────────────────────────
 * interact/drag.js calls liftCard/dragCard/releaseCard directly (P8). This
 * watches the class it ALSO sets — `is-dragging-card` on <body> — so that a
 * gesture which ends by a path that never reaches releaseCard cannot leave the
 * felt's whole clipping chain open for the rest of the game. It fires as a
 * microtask, i.e. always after interact/'s own synchronous call, so in the
 * normal case both directions are already no-ops.
 *
 * ONE element, ONE attribute, no subtree — this is not a general DOM watcher
 * and it never sees a pointer event. The velocity lean and the hover-to-reopen
 * are deliberately NOT driven from here: they need the pointer stream, which
 * belongs to interact/, and faking it would cost a rect read per frame (§0.8).
 *
 * Idempotent both ways, so an interact/ that starts calling the API directly
 * simply makes this a no-op instead of double-firing.
 */
function watchDragClass() {
  if (typeof MutationObserver !== 'function' || !document.body) return;
  const obs = new MutationObserver(() => {
    const on = document.body.classList.contains('is-dragging-card');
    const node = on ? document.querySelector('.card.is-dragging') : null;
    const id = node ? Number(node.getAttribute('data-card-id')) : NaN;
    if (on && Number.isInteger(id)) { liftCard(id); return; }
    if (on) return;
    for (const [heldId, rec] of lifts) {
      releaseCard(heldId, { accepted: rec.node.classList.contains('is-dropping') });
    }
  });
  obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

/* ── cards escape their clipping ancestors ─────────────────────────────────
   Every container a card lands in clips: `.opponents .board` and
   `.board-bank` are overflow:hidden, `.opponents .board-props`, `.zone-hand`,
   `.opponents` and `.self-board` are scroll boxes, and `.table` itself is
   overflow:hidden. A card magnified to 92px inside a 14px slot is therefore
   invisible — which is the whole reason the magnification exists — and a card
   held 290px above the hand dock is invisible for the ENTIRE drag.

   Measured before this generalised (desktop 1280×720, a pink property dragged
   from the fan to the SPACE column, 80ms burst): frame 2 shows a 14px sliver of
   the card at the dock's top edge and frames 3–11 show NO CARD ANYWHERE. The
   same capture on a 390×844 phone with real CDP touch: identical, 6 frames of
   a drag with nothing under the finger. z-index was never the problem —
   interact.css already gives `.is-dragging` z-index 60, and `#hand-dock` and
   `#table` are both `position:relative; z-index:auto`, so neither traps a card
   in a stacking context. `overflow:hidden` was the whole of it.

   So the ancestor chain is opened and put back byte-for-byte, scroll offsets
   included. Precisely the chain, not a CSS class on #table: a blanket
   `overflow:visible` on the felt spills the opponents strip over the centre
   pile on a phone. Scrollbars are already `scrollbar-width:none` on every one
   of these, so opening them reflows nothing.

   Two lifetimes share one registry:
     • TIMED   (a flight) — an `until` deadline, swept by a timer.
     • HELD    (a drag)   — a refcount, released by table.releaseCard.
   An element closes only when it has no holds AND its deadline has passed, so
   a drag that ends while a broadcast is landing cannot re-clip a card the
   choreographer has just put in the air. */
const unclipped = new Map();      // element -> {overflow, sl, st, until, holds}
let unclipTimer = 0;

// A held chain is released by identity, never by re-walking: a card can be
// REPARENTED mid-drag (a broadcast lands, reconcile moves it), and re-walking
// at release time would then restore a chain that was never opened and leak
// the one that was.
function openChain(node, ms, chain) {
  const until = ms > 0 ? performance.now() + ms : 0;
  for (let e = node.parentElement; e && e !== document.body; e = e.parentElement) {
    let rec = unclipped.get(e);
    if (!rec) {
      const cs = getComputedStyle(e);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        rec = { overflow: e.style.overflow, sl: e.scrollLeft, st: e.scrollTop, until: 0, holds: 0 };
        unclipped.set(e, rec);
        e.style.overflow = 'visible';
      }
    }
    if (rec) {
      if (until > rec.until) rec.until = until;
      if (chain) { rec.holds++; chain.push(e); }
    }
    // A flight stops at the felt (the measured scoping above). A HELD card does
    // not: the hand dock is a SIBLING of #table, so a dragged hand card's chain
    // is #zone-hand → #hand-dock and stopping at #table would never reach it.
    if (!chain && e.id === 'table') break;
  }
  if (unclipped.size && !unclipTimer) unclipTimer = setTimeout(reclip, Math.max(40, ms) + 20);
}

function closeChain(chain) {
  if (!chain) return;
  for (let i = 0; i < chain.length; i++) {
    const rec = unclipped.get(chain[i]);
    if (rec && rec.holds > 0) rec.holds--;
  }
  chain.length = 0;
  if (!unclipTimer) unclipTimer = setTimeout(reclip, 40);
}

function unclip(node, ms) { openChain(node, ms, null); }

function reclip() {
  unclipTimer = 0;
  const now = performance.now();
  let soonest = 0;
  for (const [e, saved] of [...unclipped]) {
    if (saved.holds > 0 || saved.until > now) {
      if (saved.holds === 0 && (!soonest || saved.until < soonest)) soonest = saved.until;
      continue;
    }
    unclipped.delete(e);
    if (saved.overflow) e.style.overflow = saved.overflow;
    else e.style.removeProperty('overflow');
    if (e.scrollLeft !== saved.sl) e.scrollLeft = saved.sl;
    if (e.scrollTop !== saved.st) e.scrollTop = saved.st;
  }
  // Anything still held keeps the sweeper alive: a hold that is never released
  // (the interaction layer threw, the node was torn out from under it) must
  // still be reclaimed, and lifts.sweep() below is what does it.
  let holds = 0;
  for (const rec of unclipped.values()) if (rec.holds > 0) holds++;
  if (soonest) unclipTimer = setTimeout(reclip, Math.max(20, soonest - now) + 20);
  else if (holds) unclipTimer = setTimeout(reclip, 500);
}

/**
 * Would this flight spend most of its travel inside something that clips it?
 * Only the FIRST clipping ancestor is asked, and only about the take-off point:
 * a card leaving the hand for a property column starts ~290px outside the
 * column's scrollport and is invisible until it arrives, while a card shuffling
 * one slot along inside a column never leaves it and must not pay for a
 * getComputedStyle walk on every event.
 */
function escapes(node, cx0, cy0) {
  for (let e = node.parentElement; e && e !== document.body; e = e.parentElement) {
    const cs = getComputedStyle(e);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const r = e.getBoundingClientRect();
    if (!r.width) return false;
    return cx0 < r.left - 4 || cx0 > r.right + 4 || cy0 < r.top - 4 || cy0 > r.bottom + 4;
  }
  return false;
}

function currentTilt(node) {
  const v = parseFloat(node.style.getPropertyValue('--tilt'));
  return Number.isFinite(v) ? v : 0;
}

/* ── zone reflow: the cards a move DISPLACES ───────────────────────────────
   An exchange has to read as an exchange. Before this, moving a wild between
   two of your own columns was a teleport at both ends: the card it displaced
   in the destination and the cards that should have closed up behind it in the
   source both jumped to their new layout box in the same frame the reparent
   happened, with no motion at all — the reconcile at the END of the job wrote
   their rest poses, ~240–460ms later, by which time the jump was long over.

   So the displacement is measured AT THE REPARENT, which is the only frame the
   before and after both exist, and flown as a plain FLIP. Siblings already in
   the air are skipped: a layout change moves their landing box, and their own
   flight lands on the new one for free (flights land on the rest pose, §
   cardnode.js), whereas re-flying them would supersede the record and fire an
   unanswered FLIGHT_ABORT.

   The hand is excluded — hand.layout() owns the fan, and it is a pose reflow
   rather than a layout one. */
const rfNodes = [];
let rfX = new Float64Array(24);
let rfY = new Float64Array(24);
const REFLOW_MIN_PX = 2;
const REFLOW_MS = 200;

function reflowCollect(zone, skip) {
  if (!zone || zone === layout.zoneEl('hand')) return;
  for (let c = zone.firstElementChild; c; c = c.nextElementSibling) {
    if (c === skip || !c.hasAttribute('data-card-id')) continue;
    if (flight.isFlying(c) || flight.isDragging(c)) continue;
    rfNodes.push(c);
  }
}

function reflowMeasure(zoneA, zoneB, skip) {
  rfNodes.length = 0;
  if (reduceMotion) return;
  reflowCollect(zoneA, skip);
  if (zoneB !== zoneA) reflowCollect(zoneB, skip);
  const n = rfNodes.length;
  if (n > rfX.length) {
    let size = rfX.length;
    while (size < n) size *= 2;
    rfX = new Float64Array(size);
    rfY = new Float64Array(size);
  }
  for (let i = 0; i < n; i++) { rfX[i] = rfNodes[i].offsetLeft; rfY[i] = rfNodes[i].offsetTop; }
}

function reflowApply() {
  for (let i = 0; i < rfNodes.length; i++) {
    const node = rfNodes[i];
    const dx = rfX[i] - node.offsetLeft;
    const dy = rfY[i] - node.offsetTop;
    if (Math.abs(dx) < REFLOW_MIN_PX && Math.abs(dy) < REFLOW_MIN_PX) continue;
    // quiet: a card being shoved along by its neighbour did not land, and an
    // unanswered swish per displaced card would triple the game's sfx count.
    flight.fly(node, { dx, dy, dur: REFLOW_MS, arc: 0, quiet: true, key: i });
  }
  rfNodes.length = 0;
}

/* ── the pick-open fan opens as MOTION, not in a frame (§P10 FEEL) ─────────
 *
 * Entering a theirCard steal step is pure CSS layout: table.css's :has()
 * rules (~1346-1385) change grid spans, --card-w, negative margins and the
 * desktop seats track (fit-content 11.4em → 22em) the moment interact/ marks
 * the victim's cards. MEASURED before this existed (1280×720, dragtest §G's
 * stealBoard): the victim seat grew ~140 → ~250px, every fanned card moved
 * and changed width 26 → 44 in ONE frame, and no FLIP ran because nothing
 * reparents — the one card-layout change on the table with zero motion.
 *
 * So interact/ hands its whole mark pass here and it is FLIPped wholesale:
 * every strip card's rect before, rect after, inverted deltas flown on the
 * one clock (§0.6) exactly as moveCard does for a reparent. Interruptible
 * like any flight — a tap mid-open hits the card where it is painted, and a
 * re-mark retargets because flights land on the rest pose. Reduced motion
 * never reaches this function (the caller collapses to the instant layout
 * change — for a layout jump, instant IS the fade).
 *
 * Deliberately NOT flown: the self board's ~100px drop under the growing
 * seats track. Its mats, nameplates and chrome move with it in the same
 * frame, and flying only the .card nodes would detach every card from its
 * mat for 200ms — worse than the jump. Cards only, in the strip only.
 *
 * Cost: two rect passes over the strip's cards, and only on passes the
 * caller has already screened as fan-toggling — never per frame (§0.8;
 * the arrays are preallocated like the reflow's). */
const FLIP_MIN_PX = 2;
const FLIP_MS = 220;
const fpNodes = [];
let fpX = new Float64Array(48);
let fpY = new Float64Array(48);
let fpW = new Float64Array(48);

export function flipStrip(mutate) {
  const strip = document.getElementById('opponents');
  if (!strip || reduceMotion) { mutate(); return; }
  fpNodes.length = 0;
  // Backs too: the victim's hand-row backs ride the same seat growth. They
  // carry no id, so they key by index like the reflow's.
  for (const node of strip.querySelectorAll('[data-card-id], [data-back]')) {
    if (flight.isFlying(node) || flight.isGrabbed(node)) continue;
    fpNodes.push(node);
  }
  const n = fpNodes.length;
  if (n > fpX.length) {
    let size = fpX.length;
    while (size < n) size *= 2;
    fpX = new Float64Array(size);
    fpY = new Float64Array(size);
    fpW = new Float64Array(size);
  }
  for (let i = 0; i < n; i++) {
    const r = fpNodes[i].getBoundingClientRect();
    fpX[i] = r.left + r.width / 2;
    fpY[i] = r.top + r.height / 2;
    fpW[i] = r.width;
  }
  mutate();
  for (let i = 0; i < n; i++) {
    const node = fpNodes[i];
    if (!node.isConnected) continue;
    const r = node.getBoundingClientRect();
    if (!r.width || !fpW[i]) continue;
    const dx = fpX[i] - (r.left + r.width / 2);
    const dy = fpY[i] - (r.top + r.height / 2);
    const scale = fpW[i] / r.width;
    if (Math.abs(dx) < FLIP_MIN_PX && Math.abs(dy) < FLIP_MIN_PX
      && Math.abs(scale - 1) < 0.02) continue;
    // quiet: a fan opening is one gesture, not N landings — the acceptance
    // beat is interact/'s TARGET_STEP cue, fired once.
    flight.fly(node, { dx, dy, scale, dur: FLIP_MS, arc: 0, quiet: true, key: i });
  }
  fpNodes.length = 0;
}

/* ── the felt belongs to ONE game ──────────────────────────────────────────
 *
 * OWNER BUG: "when starting a new game it briefly shows your cards/hand from
 * the last game (says offline) then syncs."
 *
 * MEASURED, headless Chromium, quick play → Leave game → quick play: the seven
 * card nodes of the finished game were STILL PARENTED IN #zone-hand 300ms after
 * the leave (store.snapshot was already null), the game screen unhid 55ms after
 * the second Quick Play with all seven of them fanned face-up under a "Hand 0"
 * label, and the new deal then flew ON TOP of them — 11, then 12 cards in a
 * hand that holds 7. The last game stayed on the felt for 1.75s, until the
 * choreographer's TERMINAL reconcile finally culled it.
 *
 * The cause is that nothing in the client had ever removed a card node except
 * reconcile()'s step 2, and reconcile only runs when a NEW snapshot arrives —
 * so the felt outlived the session that drew it. store.reset() nulls the
 * snapshot; §10 says the snapshot is truth, so a null one has to mean an empty
 * table, and until now it did not.
 *
 * Everything a game left behind goes: keyed nodes, pooled backs, lifts,
 * flights, and the chrome that counts them. The boards themselves are
 * layout.syncSeats()'s business — a new roster rebuilds them, an identical one
 * (a rematch) keeps them and is repainted.
 *
 * Idempotent, and cheap on an already-empty felt: both callers may fire twice.
 */
export function clear() {
  for (const id of [...lifts.keys()]) releaseCard(id, { tail: 0 });
  flight.finishAll();
  for (const id of [...allNodes().keys()]) {
    const node = getNode(id);
    if (node) { flight.cancel(node); hand.forget(node); }
    forgetNode(id);
  }
  // Only [data-back] children: a zone's placeholders are CSS, but syncBacks()
  // counts childElementCount and would happily "release" anything else there.
  for (const key of [...layout.zoneKeys()]) {
    const zone = layout.zoneEl(key);
    if (!zone) continue;
    for (const child of [...zone.children]) if (child.hasAttribute('data-back')) releaseBack(child);
  }
  hand.reset();
  structuralPending = false;
  setText(document.getElementById('deck-count'), '0');
  setText(document.getElementById('discard-count'), '0');
  setClass(document.getElementById('table'), 'deck-empty', false);
}

/* ── reconcile ─────────────────────────────────────────────────────────── */

/**
 * @param {object} snapshot  getPlayerView output
 * @param {{expected?:Set<number>, count?:boolean, animate?:boolean}} opts
 * @returns {number} corrections counted this pass
 */
export function reconcile(snapshot, opts = {}) {
  if (!snapshot) return 0;
  sweepLifts();
  const expected = opts.expected || EMPTY;
  // prepare() may already have done the seating for this job; a rebuild is a
  // rebuild whoever ran it, and counting drift across one is meaningless.
  const structural = layout.syncSeats(snapshot, selfId) || structuralPending;
  structuralPending = false;
  const counting = opts.count !== false && !structural;
  const animate = !!opts.animate && !reduceMotion;

  // The two snap paths (reconnect/gap in the choreographer, drainEvents in the
  // harness) both call with count:false + animate:false. Nothing may still be
  // in the air after them, or the next frame animates a game that already
  // moved on. A plain no-event broadcast (count:true) must NOT settle: it
  // arrives mid-flight several times a turn.
  if (opts.count === false && !opts.animate) flight.finishAll();

  let corrections = 0;

  const desired = new Map();     // id -> zoneKey
  const cards = new Map();       // id -> card object
  const cull = new Set();        // in the snapshot but deliberately not rendered
  const order = new Map();       // zoneKey -> [id, ...]

  const put = (zoneKey, card) => {
    if (!card || card.id == null) return;
    desired.set(card.id, zoneKey);
    cards.set(card.id, card);
    let list = order.get(zoneKey);
    if (!list) { list = []; order.set(zoneKey, list); }
    list.push(card.id);
  };

  for (const player of snapshot.players || []) {
    const mine = player.id === selfId;
    if (mine && Array.isArray(player.hand)) {
      for (const card of player.hand) put(layout.zoneKeyFor('hand', player.id), card);
    }
    for (const card of player.bank || []) put(layout.zoneKeyFor('bank', player.id), card);
    for (const color of COLOR_KEYS) {
      for (const card of player.properties?.[color] || []) {
        put(layout.zoneKeyFor('properties', player.id, color), card);
      }
      for (const card of player.upgrades?.[color] || []) {
        put(layout.zoneKeyFor('upgrades', player.id, color), card);
      }
    }
  }

  const discard = snapshot.discardPile || [];
  for (let i = 0; i < discard.length; i++) {
    if (i < DISCARD_VISIBLE) put('discard', discard[i]);
    else if (discard[i]?.id != null) cull.add(discard[i].id);
  }

  // 1. every card the snapshot names goes where the snapshot says
  for (const [id, zoneKey] of desired) {
    const card = cards.get(id);
    let node = getNode(id);
    const isNew = !node;
    if (isNew) node = cardNode(card);
    else refresh(node, card);
    const zone = layout.zoneEl(zoneKey);
    if (!zone) continue;
    if (node.parentElement !== zone) {
      if (animate && expected.has(id)) moveCard(id, zoneKey, { animate: true });
      else { zone.appendChild(node); setRest(node, 0, 0, 0); flight.writeRest(node); }
      if (counting && !expected.has(id)) {
        corrections++;
        metrics.lastCorrections.push(`${isNew ? 'spawn' : 'move'} ${id} → ${zoneKey}`);
      }
    }
    // A card mid-flip is telling the truth on purpose (an opponent's play is
    // face-down until it lands); anything else the snapshot names is face-up.
    if (!flight.isFlipping(node) && !flight.isFlying(node)) flight.setFacing(node, true);
  }

  // 2. anything left over is gone from the game (reshuffled, or out of view)
  for (const id of [...allNodes().keys()]) {
    if (desired.has(id)) continue;
    const silent = cull.has(id) || expected.has(id);
    const node = getNode(id);
    if (node) { flight.cancel(node); hand.forget(node); }
    forgetNode(id);
    if (counting && !silent) {
      corrections++;
      metrics.lastCorrections.push(`remove ${id}`);
    }
  }

  // 3. order, stacking indices, and the rest pose of every zone
  for (const [zoneKey, ids] of order) {
    const zone = layout.zoneEl(zoneKey);
    if (!zone) continue;
    const isHand = zoneKey === 'hand';
    const isDiscard = zoneKey === 'discard';
    const nodes = ids.map(getNode).filter(Boolean);
    // getPlayerView reverses the discard, so ids[0] is the NEWEST card. The
    // pile is absolutely positioned and unlayered, so paint order is DOM order:
    // put the newest last or the top card of the pile is the one you cannot
    // see. It also matches where moveCard's appendChild leaves a fresh discard.
    orderChildren(zone, isDiscard ? nodes.slice().reverse() : nodes);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const value = String(i);
      if (node.style.getPropertyValue('--i') !== value) node.style.setProperty('--i', value);
      if (isDiscard) tilt(node, ids[i], DISCARD_TILT, 1);
      else if (!isHand) { setRest(node, 0, 0, 0); hand.forget(node); }
    }
    if (isHand) hand.layout(nodes, animate);
  }

  // 4. face-down populations: counts, never identities
  syncBacks(layout.zoneEl('deck'), Math.min(snapshot.deckCount || 0, DECK_DEPTH), { lift: DECK_LIFT });
  for (const player of snapshot.players || []) {
    if (player.id === selfId) continue;
    syncBacks(layout.zoneEl(layout.zoneKeyFor('hand', player.id)),
      Math.min(player.handCount || 0, HAND_BACKS), { tilt: 4 });
  }

  // 5. chrome
  setText(document.getElementById('deck-count'), String(snapshot.deckCount ?? 0));
  setText(document.getElementById('discard-count'), String(discard.length));
  for (const player of snapshot.players || []) layout.paintBoard(player, snapshot);
  setClass(document.getElementById('table'), 'deck-empty', (snapshot.deckCount || 0) === 0);

  if (counting && corrections) {
    metrics.drift += corrections;
    if (metrics.lastCorrections.length > 40) metrics.lastCorrections.splice(0, metrics.lastCorrections.length - 40);
  }
  return corrections;
}
