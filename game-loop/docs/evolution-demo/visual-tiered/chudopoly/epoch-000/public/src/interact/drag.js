// interact/drag.js — direct manipulation: the card follows the finger.
//
// This file owns the CHOREOGRAPHY of a drag (lift, drop-target marking,
// hit-testing, spring-back). It owns none of the rules: what may be picked up,
// where it may land and what a landing means all come from the mode machine in
// interact/index.js through the small api passed to mount(). A drop is
// therefore the same code path as a tap — select → play → satisfy a need —
// which is the only way the server ever hears about it (§5).
//
// Transform contract (§P4): while a card is `.is-dragging` this file drives
// --fx/--fy/--fs directly and the motion agent leaves it alone. On release the
// props are left where the finger dropped them, so the choreographer's FLIP
// measures its `first` rect AT THE DROP POINT and the card flies on from there
// instead of teleporting home first.

import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { el as mkEl, setAttr, setStyle, setClass, qsa, prefersReducedMotion } from '../core/dom.js';
import { subscribe } from '../core/clock.js';
import { clamp, damp } from '../core/math.js';
import * as table from '../table/index.js';
import * as pointer from './pointer.js';

// The motion agent owns this channel (anim/cues.js) and its payload shape
// {kind, mine, big, at:{x,y}}; the three interaction beats below are not in its
// CUE table yet, and a subscriber that switches on `kind` ignores what it does
// not know. Named by string so this file does not break if EVENTS predates it.
const FX_CUE = EVENTS.FX_CUE || 'fx:cue';
const CUE_PICKUP = 'card_pickup';
const CUE_DENIED = 'denied';        // the §P4 brief names this one
const CUE_DETAILS = 'card_details';
// The two travel beats. anim/cues.js owns both names; audio maps them to
// card_slide and card_snap, which is the second half of §P4's refusal chain.
const CUE_FLIGHT_START = 'card_flight_start';
const CUE_LANDED = 'card_landed';
// ui/peek.js listens on these. core/bus.js is architect-owned, so they follow
// the same "string literal until the constant exists" pattern as FX_CUE.
const UI_PEEK = EVENTS.UI_PEEK || 'ui:peek';
const UI_PEEK_END = EVENTS.UI_PEEK_END || 'ui:peek_end';

/** One cue per BEAT — two small allocations, never per frame (§0.8). */
function cue(kind, x, y) {
  bus.emit(FX_CUE, { kind, mine: true, big: false, at: { x: Math.round(x) || 0, y: Math.round(y) || 0 } });
}

function cueAt(kind, el) {
  const r = el ? el.getBoundingClientRect() : null;
  cue(kind, r ? r.left + r.width / 2 : 0, r ? r.top + r.height / 2 : 0);
}

const LIFT_RATIO = 0.62;    // of card height — a 5:7 card at 62% clears an adult thumb
const MOUSE_LIFT = 8;       // a cursor hides nothing; just enough to read as "held"
const SCALE = 1.06;
// ART §4: invalid drops "lerp home over 260ms, never teleport", settle
// `250ms cubic-bezier(.22,1,.36,1)`. anim/flight.js solves that exact bezier
// (settleEase); this is the CSS fallback for the board→board case flight.js is
// not asked to handle, so it names the same curve.
// The release pop (motion.css `.is-unpressing`). 190ms of curve plus a frame of
// slack: hold it any longer and a fast double-tap presses a card that is still
// unpressing, hold it shorter and the class is pulled mid-overshoot.
const UNPRESS_MS = 210;
const SPRING_MS = 260;
const SPRING_EASE = 'cubic-bezier(.22, 1, .36, 1)';
const COMMIT_HOLD_MS = 900;  // an accepted drop keeps its offset this long, then
                             // gives up on the server and springs home anyway

/* ── weight: the card lags the finger, a little ────────────────────────────
 *
 * Owner (P8): "better feedback for dragging cards … it should feel like it has
 * mass". table.dragCard() already supplies the ART §4 pose channel (velocity
 * lean `v*6deg` and `scaleX(1+|v|*0.08)`); this is the positional half.
 *
 * NOT a spring. A spring that TRACKS a moving target sits a constant
 * damping/stiffness × velocity behind it: at the ratified settle values
 * (520/38) that is 38×900/520 = 66px of lag at a brisk 900px/s, which is not
 * weight, it is a broken cursor. Exponential smoothing has lag = τ × velocity
 * with no oscillation, so the number is chosen directly:
 *
 *   τ = 1/FOLLOW_LAMBDA = 22ms  →  13px behind at 600px/s (a deliberate drag),
 *                                  20px at 900px/s (a flick), and it closes to
 *                                  under a pixel in ~100ms once the finger
 *                                  stops.
 *
 * The DROP is still resolved at the finger, never at the lagging card, so the
 * lag can never cost the player a target (drag.resolve / the landing ghost both
 * take the pointer position). anim/flight.js's own comment argues against
 * interposing a tween between finger and card; 22ms is deliberately at the
 * bottom of what reads as mass, and §0.9 turns it off entirely.
 */
const FOLLOW_LAMBDA = 45;   // 1/s → τ ≈ 22ms

let api = null;
let live = null;             // the active drag, or null
let unfollow = null;         // clock unsubscribe for the follow loop

export function mount(machineApi) {
  api = machineApi;
  pointer.onGesture({
    press, release, dragStart, dragMove, dragEnd, dragCancel, longPress, longPressEnd,
  });
}

/* ── the ≤1-frame acknowledgement (§P7.2) ──────────────────────────────────
 * Measured before this existed: pointerdown → first feedback of ANY kind was
 * 427ms+ (the click), sfxLog 0, fxLog 0, no class on the node. card_pickup
 * fired only past the 8px slop, so a tap-first player heard it 0 times in a
 * 274-sound game. The press paints and sounds; what the press MEANS is still
 * decided later by the tap/drag split. */
function press(cardId, node) {
  if (!node) return;
  clearTimeout(node.__unpressTimer);
  node.classList.remove('is-unpressing');
  node.classList.add('is-pressed');
  cueAt(CUE_PICKUP, node);
}

/**
 * The release is half of the press (§P9 FEEL round 1). `.is-pressed` used to be
 * removed and that was the end of it: the card snapped back to its rest pose in
 * one frame, with no transition, which is precisely the "no weight" the press
 * was measured as having. `.is-unpressing` keeps motion.css's press channel
 * alive for one back-out curve so the card springs through 1.0 and settles.
 *
 * NOT after a drag: from `phase === 'drag'` the card is already mid-flight or
 * mid-spring-back under anim/flight.js, and a second pose writer on the same
 * node is the one thing the transform contract forbids.
 */
function unpress(node, phase) {
  if (!node) return;
  node.classList.remove('is-pressed');
  clearTimeout(node.__unpressTimer);
  if (phase === 'drag') { node.classList.remove('is-unpressing'); return; }
  node.classList.add('is-unpressing');
  node.__unpressTimer = setTimeout(() => {
    node.__unpressTimer = 0;
    node.classList.remove('is-unpressing');
  }, UNPRESS_MS);
}

function release(cardId, node, info) {
  unpress(node, info?.phase);
  if (info?.phase === 'held') bus.emit(UI_PEEK_END, null);
}

/* ── hold → PEEK (owner directive P7; was: → details sheet, §P4.3) ────────
 *
 * "on mobile if you touch and hold ... it should render the card so you can
 * actually view it and read what it does without having to click on it and
 * then click on details."
 *
 * So the hold is now a PEEK: it appears while the finger is down and it is
 * gone on release. The full details sheet is still reachable, but only as a
 * deliberate act — tapping a table card, or the Details control on the strip. */
function longPress(cardId, node) {
  bus.emit(UI_PEEK, { cardId, node });
  cueAt(CUE_DETAILS, node);
}

function longPressEnd() {
  bus.emit(UI_PEEK_END, null);
}

/* ── drag ──────────────────────────────────────────────────────────────── */

function dragStart(cardId, node, press) {
  if (!api || live) return false;
  const plan = api.dragPlan(cardId);
  if (!plan) return false;                       // not draggable right now

  const rect = node.getBoundingClientRect();
  const lift = press.pointerType === 'touch' ? Math.round(rect.height * LIFT_RATIO) : MOUSE_LIFT;
  // The hand is a fan: every card rests at a NON-ZERO --fx/--fy/--tilt
  // (table/hand.js). A drag is a delta on that pose, never an absolute one,
  // or the card jumps to the fan's centre the moment it is picked up.
  const rx = restVar(node, '__rx', '--fx');
  const ry = restVar(node, '__ry', '--fy');
  live = {
    cardId, node, plan, lift, rx, ry,
    // target (finger) vs shown (lagging) offset — see FOLLOW_LAMBDA.
    tx: rx, ty: ry - lift,
    sx: rx, sy: ry - lift,
    px: 0, py: 0,                                // last pointer position
    snap: press.pointerType === 'touch' ? SNAP_TOUCH : SNAP_MOUSE,
    hover: null,
    ghost: null,
    // WHERE THE CARD CAME FROM. Read before liftCard() reparents the node.
    // A drag that ends where it began is a CANCEL — see resolve() step 0.
    home: plan.source === 'hand'
      ? document.getElementById('hand-dock')
      : node.closest?.('.propcol') || null,
  };

  clearTimeout(node.__dragTimer);
  node.style.transition = 'none';
  node.classList.add('is-dragging', 'is-lifted');
  document.body.classList.add('is-dragging-card');
  setStyle(node, '--fs', String(SCALE));

  // THE CARD RIDES ABOVE THE TABLE. table.liftCard() opens every clipping
  // ancestor the card sits inside (hand zone → dock → board → felt), refcounted
  // and restored with its scroll offsets on release, takes the card out of the
  // fan so the gap closes behind it, and retracts + flattens the hand to open
  // the lane (ART §5.5). Without this call the held card is drawn inside a
  // `overflow:hidden` box and z-index 60 cannot save it — measured: a hand card
  // dragged at the top of its arc was clipped by #hand-dock.
  table.liftCard(cardId, { fan: plan.source === 'hand' });

  // No pickup cue here: press() already fired it at pointerdown, ~380ms earlier
  // in a real drag. Two cues for one grab read as a stutter.
  // rank 2 is the whole felt — marking it "1" would draw a dashed outline round
  // the entire table, so it is marked and styled separately.
  for (const t of plan.targets) setAttr(t.el, 'data-droppable', t.rank === 2 ? '2' : '1');
  markIllegal(plan);
  markSource(plan);
  // The mats answer BEFORE the finger lets go: interact/index.js applyMarks()
  // paints its placement/TRADE chits for a live board drag off heldCardId().
  api?.refreshMarks?.();
  if (!unfollow && !prefersReducedMotion()) unfollow = subscribe(follow);
  return true;
}

/**
 * ART §5.1: "legal mats scale 1.04 + ring; ILLEGAL mats desaturate to 35% and
 * drop a rung." Only the legal half existed. The illegal half is the half that
 * answers "why is nothing happening when I aim here", so it is marked
 * explicitly rather than left as the absence of a mark.
 */
function markIllegal(plan) {
  if (!plan.myBoard) return;
  const legal = new Set(plan.targets.map(t => t.el));
  // THE COLUMN THE CARD CAME FROM IS NOT AN ILLEGAL TARGET — it is home.
  // resolve() step 0 already treats a release there as a change of mind rather
  // than a refusal, and dropRefusal() returns '' for `color === board.from`.
  //
  // It is also the one column that must not carry the illegal treatment, and
  // that is the whole of the second defect this round. MEASURED at 1280×720
  // under real CDP, a rainbow wild dragged out of a full Elite Programs mat:
  //   ancestors of the held card that establish a stacking context
  //   ["div.propcol[green] → filter: saturate(0.5) + opacity: 0.55",
  //    "div#self-board → z-index: 1"]
  // `opacity: .55` and `filter:` both create a stacking context, so `z-index:60`
  // on `.card.is-dragging` was being resolved INSIDE the mat the card had not
  // left — liftCard() opens the clipping chain, it deliberately does not
  // reparent — while the mat itself, `position: relative; z-index: auto`, paints
  // at the z-index-0 step of #self-board in TREE ORDER. Every mat later in
  // document order therefore drew over the card in the player's hand, and the
  // held card was additionally painted at 55% opacity and desaturated.
  // With the source column skipped the chain is ["div#self-board → z-index: 1"]
  // and `document.elementFromPoint` at the held card's own centre goes from
  // `card#20` — a card in the mat it was crossing — to the held card itself.
  const source = live?.node?.closest?.('.propcol') || null;
  for (const col of plan.myBoard.querySelectorAll('.propcol')) {
    if (col !== source && !legal.has(col)) setAttr(col, 'data-drop-illegal', '1');
  }
}

/** A wild leaving one of my own columns for another is an EXCHANGE, not a
 *  teleport: the column it is leaving is marked so both ends of the move read
 *  at once (owner: "hovering animation when swapping between them"). */
function markSource(plan) {
  if (plan.source !== 'board') return;
  const node = live?.node;
  const col = node?.closest?.('.propcol');
  if (col) setAttr(col, 'data-drop-source', '1');
}

/** One frame of follow-the-finger. Two guarded writes, no allocation (§0.8). */
function follow(dt) {
  if (!live) return;
  const step = dt > 0.05 ? 0.05 : dt;            // a backgrounded tab must not teleport
  live.sx = damp(live.sx, live.tx, FOLLOW_LAMBDA, step);
  live.sy = damp(live.sy, live.ty, FOLLOW_LAMBDA, step);
  setStyle(live.node, '--fx', `${Math.round(live.sx)}px`);
  setStyle(live.node, '--fy', `${Math.round(live.sy)}px`);
  // The lean relaxes while the pointer parks — table/ owns the velocity pose,
  // this subscriber is just the frame source (measured −4.2°/1.055 held
  // through a 260ms park before this call existed; see table.dragSettle).
  table.dragSettle(live.cardId, step);
}

function dragMove(dx, dy, x, y) {
  if (!live) return;
  live.tx = live.rx + dx;
  live.ty = live.ry + dy - live.lift;
  live.px = x; live.py = y;
  if (!unfollow) {                                // reduced motion: glued, no lag
    live.sx = live.tx; live.sy = live.ty;
    setStyle(live.node, '--fx', `${Math.round(live.sx)}px`);
    setStyle(live.node, '--fy', `${Math.round(live.sy)}px`);
  }
  // The pose (velocity lean + stretch), the unclip refresh and the hand's
  // open/close as the card comes back over the fan all live in table/.
  table.dragCard(live.cardId, x, y);
  hover(resolve(x, y));
}

/** The card's rest offset: the motion agent's number if it owns one, else
 *  whatever is on the node right now. */
function restVar(node, prop, cssVar) {
  if (typeof node[prop] === 'number') return node[prop];
  const v = parseFloat(node.style.getPropertyValue(cssVar));
  return Number.isFinite(v) ? v : 0;
}

/** Everything a drag put on the page, taken back off it. One place, because
 *  three call sites (drop, cancel, revalidate) all have to undo the same set. */
function teardown() {
  if (!live) return;
  const { node, plan } = live;
  hover(null);
  clearGhost();
  for (const t of plan.targets) setAttr(t.el, 'data-droppable', null);
  if (plan.myBoard) {
    for (const c of plan.myBoard.querySelectorAll('[data-drop-illegal]')) {
      c.removeAttribute('data-drop-illegal');
    }
  }
  for (const c of qsa('[data-drop-source]')) c.removeAttribute('data-drop-source');
  node.classList.remove('is-dragging');
  node.style.transition = '';                  // hand the transform back to the flight engine
  document.body.classList.remove('is-dragging-card');
  if (unfollow) { unfollow(); unfollow = null; }
}

function dragEnd(x, y) {
  if (!live) return;
  const hit = resolve(x, y);
  const { node, cardId, plan } = live;
  // Step 1a's mat, if that is what refused this drop — the ONE refusal this
  // file can name better than the plan can, because the plan's `reason` is
  // about the card and this one is about the column under the finger.
  const refusedMat = hit ? null : live.refused;
  // WHERE THE CARD IS, read off the node BEFORE releaseCard. On a refused drop
  // releaseCard's hand relayout (hand.reset → layout → setRest → writeRest)
  // rewrites --fx/--fy to the rest pose, and a springBack that read the vars
  // afterwards launched from a pose already home: measured, the card crossed
  // ~620px in one 13ms frame and then sat still for the 240ms "flight". The
  // capture is the whole fix — the spring is handed the drop point explicitly.
  const from = shownPose(node);
  teardown();
  live = null;
  // The clipping chain stays open on a tail timer (table.releaseCard) so the
  // flight the drop is about to start is not cut off at the zone's edge.
  table.releaseCard(cardId, { accepted: !!hit });

  api?.refreshMarks?.();                       // the drag's own mat chits come off with it
  const accepted = hit ? api.dropCommit(cardId, hit.drop) : false;
  if (accepted) {
    // A drop the MACHINE took but the SERVER has not heard about. The mode is
    // still collecting targets — §3.5's swapCard step is exactly this, and so is
    // a steal that has answered `player` and still needs `theirCard` — so there
    // is no broadcast on the way and nothing for the FLIP to continue.
    // `is-dropping` is `pointer-events: none` (interact.css), so holding the
    // card at the drop point left the card the question is ABOUT dead to the
    // finger for COMMIT_HOLD_MS. MEASURED: a drag started inside that window
    // produced no pointerdown and sent nothing at all. It goes home and waits
    // for its answer where it lives.
    if (api.targeting?.()) { springBack(node, cardId, plan.source, from); return; }
    node.classList.add('is-dropping');
    holdRelease(node, cardId, plan.source);
    return;                                    // the landing cue belongs to the flight
  }
  // The ANSWER first, then the card going home. Under reduced motion the spring
  // cues synchronously, so cueing the refusal after it put the game's "no"
  // third in its own chain — measured ["card_pickup","card_flight_start",
  // "card_landed","denied"]. The refusal is the reason the card is travelling.
  cue(CUE_DENIED, x, y);
  springBack(node, cardId, plan.source, from);
  // §P7.3 — a refusal is a sentence, never a shrug. The mat the finger was on
  // outranks the card-level reason: the player aimed somewhere specific.
  const said = refusedMat
    ? api?.dropRefusal?.(cardId, refusedMat.getAttribute('data-color'))
    : '';
  const reason = said || plan.reason;
  if (reason) bus.emit(EVENTS.TOAST, reason);
}

function dragCancel() {
  if (!live) return;
  const { node, cardId, plan } = live;
  // Same capture as dragEnd, same reason: releaseCard rewrites the vars first.
  const from = shownPose(node);
  teardown();
  live = null;
  api?.refreshMarks?.();
  table.releaseCard(cardId, { accepted: false });
  springBack(node, cardId, plan.source, from);
}

/** The pose actually painted on the node right now — the last frame the player
 *  saw. Read before anything downstream of releaseCard can rewrite it. */
function shownPose(node) {
  const x = parseFloat(node.style.getPropertyValue('--fx'));
  const y = parseFloat(node.style.getPropertyValue('--fy'));
  const s = parseFloat(node.style.getPropertyValue('--fs'));
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    s: Number.isFinite(s) ? s : 1,
  };
}

/* ── drop resolution: aim is not the game (owner feedback, P7 round 1) ─────
 *
 * "dragging cards on to the table just feels terrible since its a strip in the
 * middle of the table (at least just on desktop alone)."
 *
 * The old rule was "the element under the pointer decides": a release one pixel
 * outside a `.propcol` — measured 20px tall — or outside the ~64px-tall
 * #table-center strip resolved to null, which meant spring-back plus a refusal
 * for a gesture that was obviously aimed at something. Now:
 *
 *   1. INSIDE a precise target wins outright.
 *   2. INSIDE a REGION (rank 1 — "your side of the table", "the centre") routes
 *      to the nearest precise target that region contains, or means the region.
 *   3. Otherwise the NEAREST precise target within a snap radius wins, measured
 *      edge-to-point, so a near miss still lands.
 *   4. A playable non-property released anywhere else on the felt (rank 2, the
 *      whole #table) just plays and aims on the table, so the neutral drop is
 *      the entire felt instead of a strip.
 *
 * Containment must beat proximity, and that ordering is load-bearing: measured
 * with 3 → 1, a playable action released dead centre on the DISCARD PILE was
 * banked, because the bank happened to sit 100px away and won on distance. You
 * cannot be "near" something you are standing inside.
 *
 * The radius is bigger for a mouse than a finger only because a finger has a
 * 44px contact patch of its own; the effective forgiveness is about the same.
 */
const SNAP_MOUSE = 120;
const SNAP_TOUCH = 90;

/* ── magnetic snap: it snaps early and it STAYS (ART §5.2) ─────────────────
 *
 * "invisible hit radius 48px beyond visual bounds; snaps early and stays."
 * The radius was already generous (90/120) but it was RE-DECIDED from scratch
 * on every pointermove, so a finger sitting on the boundary between two columns
 * flickered the highlight — and, worse, the target could change between the
 * last move and the release. Once a target is held it keeps the drop until the
 * pointer is HOLD_SLACK past the radius that won it, or until the pointer is
 * standing inside a different precise target (containment always wins).
 * 48 is the ratified number and it is the slack, not the radius: it is what a
 * thumb wobbles by while it decides.
 */
const HOLD_SLACK = 48;

/** Distance from a point to a rect: 0 inside, edge distance outside. */
function rectDist(r, x, y) {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}

/** The nearest rank-0 target to (x,y), optionally restricted to a container. */
function nearestPrecise(x, y, within) {
  let best = null;
  let bestD = Infinity;
  for (const t of live.plan.targets) {
    if (t.rank !== 0) continue;
    if (within && !within.contains(t.el)) continue;
    const r = t.el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const d = rectDist(r, x, y);
    if (d < bestD) { bestD = d; best = t; }
  }
  return { best, dist: bestD };
}

function resolve(x, y) {
  if (!live) return null;
  // Cleared on EVERY pass, before any early return: a stale mat from a pointer
  // that has since moved on (or gone home) must not put words in dragEnd's
  // mouth. Only step 1a sets it, and only for the pass that refused.
  live.refused = null;

  // 0 — PUT IT BACK. A drag that ends where it started is a change of mind, and
  // this has to be decided before anything else because the rule that follows
  // it actively defeats it.
  //
  // Owner, live: "I was considering playing a card dragged it up then back down
  // but then it still played it to my bankroll." Reproduced: lifting a hand
  // card toward the bank latches it as `live.hover`, and step 1b then holds
  // that target for `snap + HOLD_SLACK` — 138px on touch, 168px on a mouse.
  // The hand sits well inside that of the bank, so dragging home never cleared
  // the commitment and the release banked a card the player had visibly
  // returned. Hysteresis is right for a thumb wobbling BETWEEN targets and
  // wrong for a pointer that has gone back to where it came from.
  //
  // The origin is never a drop: a hand card cannot be played to the hand, and a
  // board card dropped in the column it left is a no-op. So returning null here
  // is the cancel, and dragEnd() already springs the card home over 260ms.
  if (live.home) {
    const h = live.home.getBoundingClientRect();
    if ((h.width || h.height) && x >= h.left && x <= h.right && y >= h.top && y <= h.bottom) {
      return null;
    }
  }

  const { best, dist } = nearestPrecise(x, y);

  // 1 — standing inside a precise target.
  if (best && dist === 0) return best;

  // 1a — AIM BEATS FORGIVENESS on a mat this drag has already drawn as REFUSED.
  //
  // MEASURED (mid-game fixture, the rainbow wild sitting in Space Force): the
  // player releases dead centre on COMMAND, which is a complete 2/2 set and so
  // is refused by §3.5's zone cap — and the client sent
  // `move_property → lightblue`. Step 1b's hysteresis and step 3's snap radius
  // both look for the nearest LEGAL target, the mats are a ten-cell grid, and
  // every neighbour is well inside 120px. So an unambiguous aim at a refused
  // colour silently became a real move to a colour the player never chose. That
  // is worse than any refusal: the board changes, and it changes wrongly.
  //
  // Steps 2/3 exist for the NEAR MISS — "a release one pixel outside a 20px
  // column strip" — and this is not one. It is the same principle this file
  // already states for regions ("you cannot be near something you are standing
  // inside"), applied to the mats markIllegal() paints for exactly this reason.
  //
  // Scoped to a plan that is CHOOSING A COLOUR (it has mat targets of its own).
  // An action or a money card released over a mat still means "my board", and
  // step 2 must keep routing it to the bank.
  const over = document.elementFromPoint(x, y);
  const refusedMat = over && over.closest ? over.closest('.propcol[data-drop-illegal="1"]') : null;
  if (refusedMat && live.plan.targets.some(t => t.rank === 0 && t.el.classList?.contains('propcol'))) {
    live.refused = refusedMat;
    return null;
  }

  // 1b — HYSTERESIS. Nothing is standing inside anything, so the target that
  // is already committed keeps the drop while the pointer is anywhere near it.
  const held = live.hover ? live.plan.targets.find(t => t.el === live.hover) : null;
  if (held && held.rank === 0) {
    const r = held.el.getBoundingClientRect();
    if ((r.width || r.height) && rectDist(r, x, y) <= live.snap + HOLD_SLACK) return held;
  }

  // 2 — standing inside a region: route to the nearest precise target it holds.
  const hitEl = over && over.closest ? over.closest('[data-droppable="1"]') : null;
  const hit = hitEl ? live.plan.targets.find(t => t.el === hitEl) : null;
  if (hit && hit.rank === 0) return hit;
  if (hit) {
    const inside = nearestPrecise(x, y, hit.el);
    return inside.best || hit;
  }

  // 3 — near enough to a precise target that this is obviously what was meant.
  if (best && dist <= live.snap) return best;

  // 4 — the felt itself, for cards whose neutral meaning is "play it".
  const fallback = live.plan.targets.find(t => t.rank === 2);
  if (fallback) {
    const r = fallback.el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return fallback;
  }
  return null;
}

function hover(hit) {
  const target = hit ? hit.el : null;
  if (!live || live.hover === target) return;
  if (live.hover) setClass(live.hover, 'is-drop-hover', false);
  live.hover = target;
  if (target) setClass(target, 'is-drop-hover', true);
  placeGhost(hit);
}

/* ── the landing silhouette (ART §5.3) ─────────────────────────────────────
 *
 * "dashed card ghost at the exact final position and rotation." Only rank-0
 * targets get one: a ghost inside #table ("play it, I'll aim later") would be a
 * dashed card in the middle of the felt promising a place the card is not going.
 *
 * It is appended to the TARGET, never to a `.cardzone`: table/index.js's
 * reconcile orders and counts a zone's element children (orderChildren,
 * syncBacks), and a foreign node inside one would be counted as a card. A
 * `.propcol` holds the head, the cardzone and the upgrades zone, so it is the
 * safe host — and it is the box the player is aiming at anyway.
 */
function ghostEl() {
  if (!live) return null;
  if (!live.ghost) live.ghost = mkEl('div', { class: 'drop-ghost', attrs: { 'aria-hidden': 'true' } });
  return live.ghost;
}

function placeGhost(hit) {
  if (!live) return;
  const g = live.ghost;
  if (!hit || hit.rank !== 0) { if (g?.parentNode) g.parentNode.removeChild(g); return; }
  const host = hit.el.classList.contains('cardzone') ? (hit.el.parentElement || hit.el) : hit.el;
  const ghost = ghostEl();
  if (ghost.parentNode !== host) host.appendChild(ghost);
  // The rest pose in every drop target is (0,0,0deg) — table/reconcile calls
  // setRest(node,0,0,0) for every zone except the hand and the discard, neither
  // of which is ever a drop target. So "the exact final rotation" is upright,
  // and saying so beats inventing a tilt the card will not land at.
  setClass(ghost, 'is-on', true);
}

function clearGhost() {
  const g = live?.ghost;
  if (g?.parentNode) g.parentNode.removeChild(g);
  if (live) live.ghost = null;
}

/* ── landing ───────────────────────────────────────────────────────────── */

/** An accepted drop keeps the card where it was dropped so the choreographer's
 *  FLIP can continue the motion from there. If the server refuses (illegal
 *  actions get {type:'error'} and NO rebroadcast — net/socket.js) nothing would
 *  ever move it back, so the offset is only held for COMMIT_HOLD_MS. */
function holdRelease(node, cardId, source) {
  if (prefersReducedMotion()) { rest(node); return; }     // §0.9: no flourish to continue
  const parent = node.parentElement;
  clearTimeout(node.__dragTimer);
  node.__dragTimer = setTimeout(() => {
    node.classList.remove('is-dropping');
    if (node.classList.contains('is-flying')) return;     // the FLIP owns it now
    if (node.parentElement !== parent) { rest(node); return; }  // already re-homed, no flight to fake
    // `source`, not a hardcoded 'hand'. table.moveCard(id,'hand',{springBack})
    // APPENDS the node to the hand zone (table/index.js:204-205) before it
    // springs, so a BOARD card that was accepted but never answered by the
    // server — the swapCard step is exactly that, an accepted drop with no
    // frame behind it — was reparented into the fan after COMMIT_HOLD_MS.
    // "suddenly I have cards back in my hand when they were literally on the
    // board" (owner, ccea2c4) has a second cause, and this is it. A board card
    // takes the CSS spring below, which moves nothing but the transform.
    springBack(node, cardId, source);
  }, COMMIT_HOLD_MS);
}

/* ── §0.9: MOTION COLLAPSES, CUES DO NOT (§P9 FEEL round 3) ────────────────
 *
 * MEASURED: a refused drop normally cues `card_pickup, denied, card_slide,
 * card_snap` — the press, the refusal, the card travelling home, the card
 * arriving. Under prefers-reduced-motion only the first two fired. The travel
 * and the arrival were not "collapsed", they were DELETED, so the one player
 * who asked for less motion was also the one player with no evidence the card
 * had gone anywhere.
 *
 * table/index.js:238-253 already does this correctly for its own reduced-motion
 * FADE path. The spring-back does not go through it: moveCard's `springBack`
 * branch (table/index.js:204-213) short-circuits at
 * `if (reduceMotion || isDragging) { writeRest(node); return true; }` — it
 * writes the rest pose, reports success, and emits nothing. flight.springHome()
 * on the normal path is what cues the other 100% of the time, and under reduced
 * motion it is never reached. The CSS-spring branch below (every board→board
 * refusal) never cued at all, in either mode.
 *
 * So both beats are supplied here, exactly once, and only where nobody else is
 * already supplying them.
 *
 * @param {boolean} instant §0.9 collapses motion, it does not DELAY signal —
 *        table/moveCard's own reduced path fires LANDED in the same tick as
 *        FLIGHT_START for that reason, and this matches it.
 */
function cueSpring(node, instant) {
  cueAt(CUE_FLIGHT_START, node);
  clearTimeout(node.__springCue);
  if (instant) { cueAt(CUE_LANDED, node); return; }
  node.__springCue = setTimeout(() => {
    node.__springCue = 0;
    cueAt(CUE_LANDED, node);
  }, SPRING_MS);
}

/**
 * @param {{x:number, y:number, s:number}|null} [from] the pose the card was
 *        painted at when the gesture ended, captured by dragEnd/dragCancel
 *        BEFORE table.releaseCard could rewrite the vars to the rest pose.
 *        Omitted only by holdRelease's timeout path, where the vars really do
 *        still hold the drop point (an accepted drop keeps its offset).
 */
function springBack(node, cardId, source, from) {
  if (!node) return;
  const reduced = prefersReducedMotion();
  // §P4 contract: the motion agent's table.moveCard(id,'hand',{springBack:true})
  // springs the card from the captured drop pose to its rest pose in the fan.
  // A wild dragged around my own board never left its column, so that call
  // does not apply to it — the CSS spring below does.
  let handled = false;
  if (source === 'hand') {
    try {
      handled = table.moveCard(cardId, 'hand', {
        springBack: true, duration: SPRING_MS,
        fromX: from ? from.x : undefined,
        fromY: from ? from.y : undefined,
        fromScale: from ? from.s : undefined,
      }) === true;
    } catch { handled = false; }
  }
  if (handled) {
    // Taken by flight.springHome, which cues for itself — unless it was the
    // reduced-motion short-circuit, which cues for nobody.
    if (reduced) cueSpring(node, true);
    watchdog(node);
    return;
  }

  cueSpring(node, reduced);
  // The CSS spring transitions FROM the currently painted pose, so if anything
  // downstream of releaseCard rewrote the vars, the captured pose is put back
  // first — without a transition, and committed with one forced reflow (once
  // per release, never per frame) — so the transition has a true start point.
  if (!reduced && from && (from.x !== homeX(node) || from.y !== homeY(node))) {
    node.style.transition = 'none';
    setStyle(node, '--fx', `${Math.round(from.x * 10) / 10}px`);
    setStyle(node, '--fy', `${Math.round(from.y * 10) / 10}px`);
    void node.offsetWidth;
  }
  node.style.transition = `transform ${SPRING_MS}ms ${SPRING_EASE}`;
  setStyle(node, '--fx', `${homeX(node)}px`);
  setStyle(node, '--fy', `${homeY(node)}px`);
  setStyle(node, '--fs', '1');
  clearTimeout(node.__dragTimer);
  node.__dragTimer = setTimeout(() => rest(node), SPRING_MS + 40);
}

/** Last resort: whatever anyone else did, a card may not stay displaced. */
function watchdog(node) {
  clearTimeout(node.__dragTimer);
  node.__dragTimer = setTimeout(() => {
    if (node.classList.contains('is-flying')) return;
    rest(node);
  }, 500);
}

const homeX = (node) => (typeof node.__rx === 'number' ? Math.round(node.__rx * 10) / 10 : 0);
const homeY = (node) => (typeof node.__ry === 'number' ? Math.round(node.__ry * 10) / 10 : 0);

/** Back to the pose table/ says the card should be in, wherever it now lives. */
function rest(node) {
  node.style.transition = '';
  node.classList.remove('is-lifted', 'is-dropping');
  setStyle(node, '--fs', '1');
  setStyle(node, '--fx', `${homeX(node)}px`);
  setStyle(node, '--fy', `${homeY(node)}px`);
  // A refused drop can leave the card SELECTED (the strip is open on it): the
  // machine, not this file, decides whether it should still read as lifted.
  api?.refreshMarks?.();
}

/** A new snapshot can invalidate a live drag (the card was paid away, the turn
 *  passed, a target scooped). Only cancel when the card really stopped being
 *  draggable — a broadcast per bot turn must not shake the card out of a hand. */
export function revalidate() {
  if (!live || !api) return;
  if (api.dragCandidate(live.cardId)) return;
  const cardId = live.cardId;
  pointer.abortDrag();
  if (live) dragCancel();
  for (const el of qsa('[data-droppable]')) el.removeAttribute('data-droppable');
  // §P7.11: measured `dragging true→false, mode→payment, no toast` — the card
  // left the finger silently. Correct behaviour, unexplained, reads as a bug.
  api.yanked?.(cardId);
}

/** Is a card under the finger right now? Callers use it to tell "the state
 *  broadcast interrupted me" from "I put it down". */
export function holding() { return !!live; }

/** WHICH card, for the mat advice a drag has to print while it is still live
 *  (interact/index.js applyMarks). `null` when nothing is held. */
export function heldCardId() { return live ? live.cardId : null; }
