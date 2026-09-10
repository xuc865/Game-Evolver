// table/hand.js — the fan. Your hand is the only zone that is a SHAPE rather
// than a stack, and it is laid out entirely in rest-pose numbers (--tilt/--fy
// per card) because the transform contract (§5) leaves .card's transform to the
// flight engine. No CSS rule fans anything; the flex row still owns the
// horizontal spacing, this file owns the arc.
//
// Measurements (390×844 phone, hand card 66×92px in a 379px-wide zone):
//   the zone's own -28% overlap needs 414px at 8 cards — one over the hand
//   limit and the hand becomes a horizontal scroller, so tighten() takes the
//   step down instead (see below).
//   Fan spread capped at 24° total: at 4.6°/card an 8-card hand reached 32°
//   and the outermost card's tilt cost 18px of the zone's 126px height.
//   Edge drop 0.055 × card height, centred: below 0.04 the arc is invisible at
//   66px wide; hanging it all downward put the outer cards at the dock's edge.

import { setRest } from './cardnode.js';
import { setStyle } from '../core/dom.js';
import { DEG } from '../core/math.js';
import * as flight from '../anim/flight.js';

const SPREAD_PER_CARD = 4.6;      // degrees
const SPREAD_MAX = 24;            // degrees, total
const EDGE_DROP = 0.055;          // × card height
const LIFT = 0.20;                // × card height, for .is-lifted (tap-selected)
const PICK_LIFT = 0.11;           // × card height, for .is-picked (pay/discard)
const REFLOW_MIN = 2;             // px — under this a "shift" is rotation noise
const REFLOW_TILT_MIN = 0.8;      // deg — the flatten has to survive this floor

// ART-DIRECTION §5.5: "Hand retracts 24px and flattens on drag start, opening
// the path." Retract is +y because the dock is at the BOTTOM of the screen —
// away from the board is down. The flatten is the same 24° of fan going to 0,
// which on a 92px card moves the outermost card's top corner 9.6px inboard and
// is what actually opens the lane, more than the 24px does.
//
// CLAMPED TO THE ROOM THERE ACTUALLY IS (table.liftCard measures it). §10's
// ship gate already records "Phone: is the hand fully on-screen? Current: no",
// and pushing the fan a further 24px down would deepen the one defect the gate
// is watching. Measured room under the fan on the current build: desktop
// 1280×720 = 18px, phone 390×844 = 18px — so the ratified 24 clamps to 18 on
// both until §5's three-column table gives the hand the 150px it specifies.
// The flatten is NOT clamped and does the larger half of the job: 12° → 0°
// takes 9.6px of tilt overhang off the top of every outer card.
const RETRACT_PX = 24;

/* ── …AND THE CLAMP HAD EATEN IT (§P9 FEEL round 3) ────────────────────────
 *
 * The 18px above was measured against a layout that has since moved. RE-
 * MEASURED on the current build, mid-drag with the finger well clear of the
 * fan: desktop 1440×900 fy 2.5px → 6.6px, phone 390×844 fy 2.0px → 5.3px —
 * i.e. FOUR pixels of a ratified twenty-four, because handRoom() now finds only
 * ~4px of viewport under the fan's lowest corner. The flatten was doing its
 * whole job (12° → 0° on every card, measured) and the retract was doing 17% of
 * its own, which is why §5.5's lane read as "nothing happened".
 *
 * A drag is not the resting state, and the clamp was written for the resting
 * state. During a drag the fan may go this much PAST the viewport edge: the
 * bottom 14px of a 130px hand card is blank stock below the art, every card is
 * already overlapped at -28%, the whole thing is restored on release
 * (table.releaseCard → reset()), and §10's ship-gate question ("is the hand
 * fully on-screen?") is about the hand you are reading, not the hand you have
 * one card out of. tools/touchtest.mjs measures the hand-strip tap targets cold,
 * so this cannot move them.
 *
 * 14 + the ~4 that exists = 18px, which is the number this file was already
 * documented as producing.
 */
const DRAG_CLIP_PX = 14;

// Preallocated: reflow runs on every reconcile and must not allocate (§0.8).
let lx = new Float64Array(32);
let ly = new Float64Array(32);

function grow(n) {
  if (n <= lx.length) return;
  let size = lx.length;
  while (size < n) size *= 2;
  lx = new Float64Array(size);
  ly = new Float64Array(size);
}

/* ── the fan's three modal states ──────────────────────────────────────────
   All three are POSE, never layout: nothing here writes a margin, a width or a
   display, so a card under a finger keeps the layout box its --fx/--fy delta
   was captured against (interact/drag.js dragStart) and cannot jump.

   held     the node currently out of the fan (a finger has it)
   openness 1 = the fan still holds a slot for it, 0 = the gap is closed
   retracted the whole hand is back 24px and flat (§5.5) */
let held = null;
let openness = 1;
let retracted = false;

export function heldNode() { return held; }
export function isRetracted() { return retracted; }

/** @returns {boolean} true if the fan's shape changed and needs a relayout. */
export function setHeld(node) {
  if (held === node) return false;
  held = node || null;
  return true;
}

/** 0 = closed over the gap, 1 = open and waiting to receive the card back. */
export function setOpenness(v) {
  const o = v < 0 ? 0 : v > 1 ? 1 : v;
  if (o === openness) return false;
  openness = o;
  return true;
}

/**
 * @param {boolean} on
 * @param {number} [roomPx] how far the fan may travel before it leaves the
 *        viewport. Measured once per lift by table.liftCard, not here: it costs
 *        one rect per card and layout() runs on every reconcile.
 */
export function setRetracted(on, roomPx) {
  const v = !!on;
  const r = roomPx == null
    ? retractRoom
    : Math.max(0, Math.min(RETRACT_PX, roomPx + DRAG_CLIP_PX));
  if (v === retracted && r === retractRoom) return false;
  retracted = v;
  retractRoom = r;
  return true;
}
let retractRoom = RETRACT_PX;

/** The retract actually applied, in px. Measurement hook. */
export function retractPx() { return retracted ? retractRoom : 0; }

/** Everything back to the resting fan. Called by table.releaseCard. */
export function reset() {
  const changed = held !== null || openness !== 1 || retracted;
  held = null; openness = 1; retracted = false; retractRoom = RETRACT_PX;
  return changed;
}

/**
 * Fan `nodes` (already in DOM order inside the hand zone) and animate any card
 * whose LAYOUT box moved — that is the reflow when a card enters or leaves.
 *
 * offsetLeft/offsetTop, not getBoundingClientRect: they are immune to both the
 * transform we are about to write and to the zone's horizontal scroll, so a
 * player scrolling their hand does not trigger a table-wide settle.
 *
 * @param {Element[]} nodes
 * @param {boolean} animate
 */
export function layout(nodes, animate) {
  const n = nodes.length;
  if (n === 0) { cancelDefer(); if (held && !held.isConnected) reset(); return; }
  grow(n);

  /* ── A HAND LAID OUT AGAINST A HIDDEN SCREEN IS LAID OUT AGAINST NOTHING ──
   * (§P9 FEEL round 4, measured on a 390×844 phone, discard-limit cold)
   *
   * `tighten()` bailed on EVERY cold entry into the table with
   *   n 8, w 0, zoneW −8.61
   * — the card's offsetWidth was 0 and the zone's clientWidth was 0, because
   * `#screen-game` still had its `hidden` attribute when the first reconcile
   * ran. anim/transition.js is why: a view transition performs its DOM
   * mutation in a CALLBACK at the next rendering opportunity, so ui/screens.js's
   * unhide had not happened yet when store.applyState's own listeners went on to
   * reconcile the table in the same tick.
   *
   * The consequence was not "one bad frame". It was permanent: nothing re-fans
   * the hand after the screen appears, so the squeeze never ran at all and an
   * 8-card hand shipped 482px of content in a 379px zone — a horizontal
   * scroller, which is the single defect this whole function exists to prevent.
   * It is also exactly the order-dependence tools/touchtest.mjs documents in its
   * own header ("applied as the FIRST state … applied after any other state"):
   * any interaction at all triggers a second layout, and the second one is the
   * only one that could see the zone.
   *
   * So an unmeasurable zone is not a layout, it is a NOT-YET. Nothing is
   * written (a rest pose computed from zeroes is a pose the next real pass
   * would have to animate away from) and the same nodes are re-offered a frame
   * later. Bounded, because a hand that is never shown must not hold a rAF
   * loop for the rest of the session. */
  if (!measurable(nodes[0])) { defer(nodes, animate); return; }
  cancelDefer();

  // Squeeze before scrolling. table.css fans the hand at a fixed -28% overlap,
  // which measured 414px of content in a 379px zone at 8 cards on a 390×844
  // phone — the eighth card sat off the right edge and the hand became a
  // scroller at one card over the limit. Tightening the step keeps every card
  // on screen down to a strip of --tap (see MIN_STRIP_FALLBACK: the old 26px
  // floor was measured shipping 40–43px strips, under the thumb minimum, on the
  // one surface a player has to hit). This runs BEFORE the offset reads below,
  // because it is what those offsets have to measure.
  const zone = nodes[0].parentElement;
  const w = nodes[0].offsetWidth || 0;
  const h = nodes[0].offsetHeight || 0;
  const innerW = innerWidthOf(zone);              // sets minStrip too — call first
  const span = spanFor(n, w, h, innerW);

  // The outermost cards are TILTED, and a tilted card is wider than its layout
  // box by about (h/2)·sin(θ) — 9.6px at 12° on a 92px card. Unreserved, that
  // is exactly what hung over the zone edge and got clipped by its overflow.
  const overhang = (h / 2) * Math.sin(span / 2 * DEG);
  tighten(nodes, n, w, innerW - 2 * overhang, biteFor(n, h, span));

  // Read every geometry first, then write every pose — one layout flush each.
  for (let i = 0; i < n; i++) {
    lx[i] = nodes[i].offsetLeft;
    ly[i] = nodes[i].offsetTop;
  }

  /* ── the gap ────────────────────────────────────────────────────────────
     `out` is the DOM index of the card a finger is holding, or −1. With the
     gap CLOSED the remaining n−1 cards form a complete (n−1)-card fan: the row
     is one step narrower, so re-centring moves its left edge +step/2 and every
     card past the hole moves back one step. That is the whole reflow:

         x(i) = step/2 + (virtualIndex(i) − i) · step
              = +step/2   for i < out
              = −step/2   for i > out

     and the fan's own u/tilt/drop are recomputed over n−1 cards so the arc
     re-forms rather than keeping a notch in it. `openness` lerps that against
     the untouched n-card fan, which is what "opens to receive it" means when
     the card hovers back over the hand.

     A pose, not a layout change: nothing here writes a margin, so the held
     card's own layout box — the origin its --fx delta was captured against —
     cannot move under the finger. */
  const out = held ? nodes.indexOf(held) : -1;
  const step = n > 1 ? lx[1] - lx[0] : 0;
  const closing = out >= 0 ? 1 - openness : 0;
  const vn = n - closing;                                   // fractional on purpose
  const spanV = spanFor(vn, w, h, innerW);
  const flat = retracted ? 0 : 1;
  // The fan's lowest point is the OUTERMOST card (+EDGE_DROP·h/2); that is what
  // has to stay inside the zone, not the centre card.
  const pull = retracted ? retractRoom : 0;

  // Pass 2: write.
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    if (i === out) { node.__vx = undefined; continue; }     // the finger owns it

    // Virtual slot: the card's index in the fan the player is looking at.
    const vi = out >= 0 && i > out ? i - closing : i;
    const half = (vn - 1) / 2;
    const u = half > 0 ? (vi - half) / half : 0;            // -1 … 1
    const x = out >= 0 ? closing * (step / 2) * (i < out ? 1 : -1) : 0;
    // Centred on the row (−half at the middle, +half at the edges) instead of
    // hanging below it: measured on a 390×844 phone, the dock leaves a hand
    // card 93px of a needed 84px, so a fan that only pushed DOWN clipped its
    // outermost cards at the viewport edge.
    let y = EDGE_DROP * h * (u * u - 0.5) + pull;
    // The physical rise for BOTH selection states lives here: the transform
    // contract allows exactly one transform declaration on .card, so design
    // can only light a lifted card (shadow, rim, brightness) — the height has
    // to come from the rest pose.
    if (node.classList.contains('is-lifted')) y -= LIFT * h;
    else if (node.classList.contains('is-picked')) y -= PICK_LIFT * h;
    const deg = (spanV / 2) * u * flat;

    // VISUAL position, not layout position. The old reflow compared offsetLeft
    // alone, which is blind to every pose above — closing the gap moves a card
    // 27px without moving its layout box by a pixel, so it would have snapped.
    const pvx = node.__vx, pvy = node.__vy, pvt = node.__vt;
    setRest(node, x, y, deg);
    const vx = lx[i] + x, vy = ly[i] + y;
    node.__vx = vx; node.__vy = vy; node.__vt = deg;
    if (pvx === undefined) continue;                        // first sight
    if (!animate || flight.isFlying(node) || flight.isDragging(node)) continue;
    const dx = pvx - vx;
    const dy = pvy - vy;
    const dt = pvt - deg;
    if (Math.abs(dx) < REFLOW_MIN && Math.abs(dy) < REFLOW_MIN
      && Math.abs(dt) < REFLOW_TILT_MIN) continue;
    // 190ms: the reflow must be over before the next event's flight starts
    // (draw stagger is 60ms/card, so two draws = 120ms of runway).
    flight.fly(node, {
      dx, dy, dur: 190, arc: 0, quiet: true, key: i, mine: true,
      tiltFrom: deg + dt,
    });
  }
}

/* ── the retry, for a zone that cannot be measured yet ────────────────────── */
const DEFER_FRAMES = 90;          // ~1.5s at 60Hz, then give up rather than spin
let deferHandle = 0;
let deferLeft = 0;
let deferNodes = null;            // ALWAYS the most recent request, never a stale one
let deferAnimate = false;

/** Does this card have a box yet? offsetWidth is 0 inside `display:none`. */
function measurable(node) {
  const zone = node.parentElement;
  return node.offsetWidth > 0 && !!zone && zone.clientWidth > 0;
}

function cancelDefer() {
  if (deferHandle) cancelAnimationFrame(deferHandle);
  deferHandle = 0;
  deferLeft = 0;
  deferNodes = null;
}

function deferTick() {
  deferHandle = 0;
  const nodes = deferNodes;
  const animate = deferAnimate;
  // The hand may have been replaced or emptied while we waited; the reconcile
  // that replaced it owns the new nodes and this pass has nothing to say.
  if (!nodes || !nodes.length || !nodes[0].isConnected) { cancelDefer(); return; }
  if (measurable(nodes[0])) { cancelDefer(); layout(nodes, animate); return; }
  if (--deferLeft <= 0) { cancelDefer(); return; }
  deferHandle = requestAnimationFrame(deferTick);
}

function defer(nodes, animate) {
  // A second reconcile arriving while the screen is still hidden REPLACES the
  // pending one: the newest node list is the true hand, and retrying the old
  // one would fan a set of cards that is no longer in the zone.
  deferNodes = nodes;
  deferAnimate = animate;
  deferLeft = DEFER_FRAMES;
  if (!deferHandle) deferHandle = requestAnimationFrame(deferTick);
}

/* MIN_STRIP was 26px, and 26px is not a tap target. MEASURED on the 390×844
 * phone at the hand limit: four cards with 40–43px of exposed strip against a
 * 44px --tap floor — one pixel short, on the primary surface of the game. The
 * floor is now the token itself, read off the zone so it can never drift from
 * variables.css, with 26 kept only as the answer for a document that has not
 * defined it. A fan that cannot fit at a thumb's width scrolls instead, which
 * is honest — UP TO EIGHT CARDS. Past that the scroll is a lie no thumb can
 * reach (interact.css's touch-action: none owns every pixel of the zone), and
 * tighten() fits the fan instead; see its comment for the measurements. */
const MIN_STRIP_FALLBACK = 26;
let minStrip = MIN_STRIP_FALLBACK;
let cssStep = 0;                  // the stylesheet's natural step, learned once
let padW = -1, padPx = 0;         // zone padding, re-read only when width changes

/* ── the arc has to pay for itself ────────────────────────────────────────
 *
 * Two neighbours in the fan differ by span/(n−1) degrees, and the steeper of the
 * pair throws its rotated corner (h/2)·sin(Δθ) further left than its layout box.
 * That is a bite out of the uncovered strip the thumb gets: the strip is the
 * step MINUS the bite, not the step. MEASURED on a 390×844 phone at eight cards
 * with the step floored at 44px exactly — strips of 46.9 47.1 47.2 44.8 42.4
 * 42.5 42.6 — the four cards on the steepening side came out under the floor by
 * the predicted ~2.4px, so the bite has to be paid for in step.
 *
 * And it can only be paid for out of room the zone HAS. Eight 60px cards in a
 * 369px content box leave (369−60)/7 = 44.14px of step, of which --tap wants 44
 * — 0.14px of change. Charging the full 24° fan's 2.5px bite on top of that
 * bought tappable cards and spent 26px of horizontal scroll doing it, which is
 * the §10 ship-gate question ("Phone: is the hand fully on-screen?") answered
 * the wrong way to fix a different one.
 *
 * So the SPREAD is what gives, and only by as much as it must: the fan bends as
 * far as the leftover room can pay for at a thumb's width, and no further. On
 * anything with room — every desktop, every landscape, any hand of five or six
 * — `afford` is tens of pixels and this returns the full spread untouched. It
 * only bites where the arithmetic genuinely does not close, and there the honest
 * answer is a flatter fan rather than a card you cannot hit or cannot see.
 *
 * When even a flat fan will not fit (`afford` < 0) the spread is left alone:
 * flattening would cost the arc and still not fit, so the zone scrolls instead
 * and the fan stays a fan.
 */
function biteFor(n, h, span) {
  return n > 1 ? (h / 2) * Math.sin((span / (n - 1)) * DEG) : 0;
}

function spanFor(n, w, h, innerW) {
  if (n <= 1) return 0;
  const span = Math.min(SPREAD_MAX, SPREAD_PER_CARD * (n - 1));
  if (!(w > 0) || !(h > 0) || !(innerW > 0)) return span;
  const afford = (innerW - w) / (n - 1) - minStrip;      // px of bite available
  if (afford < 0 || biteFor(n, h, span) <= afford) return span;
  return (Math.asin(Math.min(1, (2 * afford) / h)) / DEG) * (n - 1);
}

/** clientWidth is the padding box; the cards live in the content box. Missing
 *  that was 8.6px of overflow — one card's worth of scroll at eight cards. */
function innerWidthOf(zone) {
  if (!zone) return 0;
  const w = zone.clientWidth;
  if (w !== padW) {
    const cs = getComputedStyle(zone);
    padPx = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    // Same read, same cache: --tap is a :root token and is inherited here.
    minStrip = parseFloat(cs.getPropertyValue('--tap')) || MIN_STRIP_FALLBACK;
    padW = w;
  }
  return w - padPx;
}

/**
 * Narrow the gap between hand cards until the whole hand fits the zone, and
 * not one pixel narrower — an inline margin is only written while the CSS
 * default would overflow, so the stylesheet stays in charge of the normal case.
 *
 * THE FLOOR IS A THUMB, NOT THE ZONE — UP TO THE HAND LIMIT. At n ≤ 8 the fan
 * stops squeezing at `minStrip + bite` and lets the zone scroll the rest: a
 * hand that scrolls costs a swipe; a hand whose cards are 42px wide costs the
 * wrong card, and §0.9 gates the second one for the same reason a player would.
 *
 * AT n ≥ 9 THE SCROLL ANSWER IS A LIE. The zone is `overflow-x: auto`, but
 * interact.css gives `#hand-dock .card` `touch-action: none` and the fan covers
 * every pixel of the zone, so no thumb can ever scroll it — MEASURED at 390×844
 * with nine cards: scrollWidth 446 against clientWidth 379, the ninth card's
 * layout box at x 371–431, entirely past the 379px port; only ~5px of its
 * rotated corner showed. And the floor cannot be paid anyway: nine cards at
 * 44px strips need 60 + 8×44 = 412px of a 364px content box. So past eight
 * cards the step IS the room: every card stays on screen — MEASURED after:
 * scrollWidth 379 === clientWidth 379, covered strips 36–37px, the outermost
 * card's whole 60px face on the port (was ~5px of rotated corner). Even 15px
 * strips were proven to SELECT on real CDP taps (touch-triage fan-probe, 9/9). The over-limit hand
 * is a temporary state you are about to spend; tappable beats off-screen.
 * The n ≤ 8 layouts are bit-for-bit what they were — the committed fixtures
 * stage up to 8 and the screenshot gates hash them.
 *
 * @param {number} bite px of the strip the NEXT card's rotated corner takes.
 */
function tighten(nodes, n, w, zoneW, bite = 0) {
  if (n < 2 || !w || !zoneW) return;
  if (!cssStep && !nodes[1].style.marginLeft) cssStep = nodes[1].offsetLeft - nodes[0].offsetLeft;
  const natural = cssStep || w * 0.72;
  const room = (zoneW - w) / (n - 1);
  const fits = room >= natural;
  const step = fits ? natural
    : n > 8 ? room
    : Math.max(minStrip + bite, room);
  for (let i = 1; i < n; i++) {
    // Two decimals, not Math.round: the tight case is decided to a tenth of a
    // pixel (44.14px of step against a 44px floor) and rounding the margin down
    // spends that tenth on the wrong side of the gate.
    setStyle(nodes[i], 'margin-left', fits ? '' : `${(step - w).toFixed(2)}px`);
  }
}

/** A card left the hand: forget its pose so it does not "reflow" back. */
export function forget(node) {
  if (!node) return;
  node.__vx = undefined;
  node.__vy = undefined;
  node.__vt = undefined;
  if (held === node) held = null;
}
