// ui/peek.js — reading a card costs zero taps.
//
// Owner directive (P7 round 1): "I want a good hover state too at least on
// desktop / on mobile if you touch and hold, but it should render the card so
// you can actually view it and read what it does without having to click on it
// and then click on details."
//
// So: hover (desktop) or touch-and-hold (phone) raises a LARGE, fully legible
// rendering of the card with its real rule text and its live context — what
// that rent would charge right now, how far that set has come, where that wild
// can legally go. The peek is transient by construction: it appears while you
// are pointing at the card and it is gone the moment you are not. The details
// SHEET stays, as the deliberate act it always was (tap a table card, or the
// Details control on the strip).
//
// Three hard rules, all of them things a hover layer normally gets wrong:
//   • It never intercepts input. `.peek` is pointer-events:none, so a drag can
//     start from under it and a click passes straight through.
//   • It never covers the thing you are pointing at. placement() flips the card
//     to whichever side of the anchor has room, then clamps to the viewport.
//   • It never strobes. HOVER_IN_MS is an intent delay, so sweeping across a
//     fanned hand shows nothing until you stop on a card.
//
// ── THE FACE ───────────────────────────────────────────────────────────────
// The peek renders table/cardart.js's PEEK tier — a genuinely different
// composition from the in-game face, not the same face scaled up: it has room
// for the full property name, the whole rent ladder as leader-dot rows, and a
// paragraph of rule text, none of which fit on a 90px card. It renders from the
// card DATA, so a card with no node on the table (a culled discard) still peeks.
// `peek.setFaceRenderer(fn)` remains the seam. It no longer has a second job:
// the clone-the-live-node path it used to fall back to had been unreachable
// since this tier landed and has been deleted (see setFaceRenderer).

import { $, el, clear, setClass, prefersReducedMotion } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { faceNode } from '../table/cardart.js';
import { cardName, cardText, kindLabel, opsecFlag } from '../core/cards.js';
import * as sel from '../state/selectors.js';
import { contextRows } from './details.js';

// core/bus.js is architect-owned; these channels are requested in the report.
// Same defensive pattern interact/drag.js already uses for FX_CUE.
const UI_PEEK = EVENTS.UI_PEEK || 'ui:peek';
const UI_PEEK_END = EVENTS.UI_PEEK_END || 'ui:peek_end';

/* ── THE DELAY GROUP (ART §8, "the missing piece") ─────────────────────────
 *
 * §8's table asks for three numbers and this file shipped one of them, which is
 * exactly the failure §8 predicts: "a single timer can either stop lag or stop
 * strobing, not both". MEASURED before this existed, pointer parked on a
 * genuinely non-peekable point between reads: 226 / 196 / 197ms per card. A
 * 7-card fan is ~1.4s of dead hovering to read your own hand, every turn.
 *
 *   HOVER_IN_MS  140  the COLD open. An intent delay, so a sweep across a fan
 *                     on the way somewhere else shows nothing.
 *   GROUP_MS     600  the grace. Once one peek has been earned, the player is
 *                     READING — second-and-later peeks open at 0ms and
 *                     crossfade, and the group only lapses after 600ms with
 *                     nothing peeked. One intent delay per reading session
 *                     instead of one per card.
 *   HOVER_OUT_MS 160  the close delay, cancelled by re-entering ANY peekable.
 *                     Instant-out feels twitchy across the 2px gap between
 *                     fanned cards, and it is also what made the group
 *                     impossible: the peek was gone before the pointer had
 *                     arrived anywhere else.
 *
 * The two delays compose into one honest promise: reading costs 140ms once, and
 * nothing after that.
 */
const HOVER_IN_MS = 140;
const GROUP_MS = 600;
const HOVER_OUT_MS = 160;
const SWAP_MS = 130;             // the crossfade §8 asks a grouped open to do
const EDGE = 10;                 // px kept between the peek and the viewport

let host = null;
let showing = null;              // card id currently peeked
let inTimer = 0;
let outTimer = 0;
let closedAt = -1e9;             // when the group's grace window started
let anchorEl = null;

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** True while the player is READING: something is peeked, or something was
 *  peeked recently enough that the next card is part of the same sweep. */
function inGroup() { return showing !== null || (now() - closedAt) < GROUP_MS; }
/** The shipped renderer: table/cardart.js's peek tier, carrying the CANONICAL
 *  rule text. Passing cardText in rather than letting the face invent its own is
 *  what stops the face and the details sheet from ever disagreeing.
 *
 *  This also retires the clone path for the peek entirely, which quietly fixes
 *  the culled-discard case for free: table/reconcile() forgets every discard
 *  past DISCARD_VISIBLE, and a peek that had to clone a live node had nothing to
 *  clone. The peek tier renders from the card DATA, so a card with no node on
 *  the table still peeks. */
const DEFAULT_FACE = (card) => faceNode(card, 'peek', { rule: cardText(card) });

let faceRenderer = DEFAULT_FACE;

/** Swap in a different card-face renderer. A non-function restores the shipped
 *  one.
 *
 *  IT USED TO RESTORE THE CLONE PATH, and that was a regression wearing the
 *  word "fallback". `faceRenderer` has defaulted to DEFAULT_FACE since the
 *  cardart peek tier landed, so `null` was reachable only through this seam and
 *  nothing in the client, the harness or the tests ever passed it — the clone
 *  branches in faceOf() below were dead from their first line, and so were
 *  content.css's four `.peek .card.is-peek` rules, which is how
 *  tools/coverage.mjs came to list `class:is-peek` among its uncovered markers
 *  (def3dd9). Restoring cloning would also have restored the two defects the
 *  peek tier was built to fix: no canonical rule text, and nothing to clone for
 *  a discard past DISCARD_VISIBLE. So the seam keeps its one real job — swap
 *  the renderer — and has no path back to the worse one.
 *  @param {(card:object)=>Element|null} fn */
export function setFaceRenderer(fn) { faceRenderer = typeof fn === 'function' ? fn : DEFAULT_FACE; }

function container() {
  if (host?.isConnected) return host;
  host = el('div', { class: 'peek', attrs: { 'aria-hidden': 'true' } });
  host.hidden = true;
  ($('app') || document.body).appendChild(host);
  return host;
}

/* ── the face ──────────────────────────────────────────────────────────── */

/** The face for this card. Never the live node itself: that is the one
 *  persistent object for its id (§0.4) and reparenting it would take it off the
 *  table — which is why the renderer draws from card DATA instead of borrowing
 *  anything the table owns. */
function faceOf(card) {
  return faceRenderer(card);
}

/** @param {Element|null} face  the face already built for this card, so the body
 *  can drop whatever the face is now printing itself. A cardart peek face
 *  carries the kind band, the name and the rule; repeating them under it was
 *  the same three strings twice in one 250px column. What the body still owns
 *  is the LIVE half — what this rent would charge right now, whether the play
 *  is legal — which is not printed on a card and never should be. */
function body(card, face) {
  const printed = !!face && face.classList?.contains('ca-peek');
  const box = el('div', { class: 'peek-body' });
  if (!printed) {
    box.appendChild(el('div', { class: 'peek-kind', text: kindLabel(card) }));
    box.appendChild(el('div', { class: 'peek-name', text: cardName(card) || card.name || '' }));
    box.appendChild(el('p', { class: 'peek-rule', text: cardText(card) }));
  }

  const rows = contextRows(card);
  if (rows.length) {
    const live = el('div', { class: 'dt-rows peek-rows' });
    for (const row of rows) live.appendChild(row);
    box.appendChild(live);
  }

  if (card.type === 'action' || card.type === 'rent') {
    const flag = opsecFlag(card);
    box.appendChild(el('span', { class: `dt-tag is-${flag.kind}`, text: flag.text }));
  }

  // The single most useful sentence a hand card can carry: why you cannot play
  // it. It used to be reachable only by selecting the card and reading a
  // disabled button's tooltip, which a phone has no way to show at all.
  const why = sel.handCard(card.id) ? sel.blockedReason(card) : '';
  if (why) box.appendChild(el('p', { class: 'dt-why', text: why }));
  return box;
}

/* ── placement ─────────────────────────────────────────────────────────── */

/**
 * Put the peek beside its anchor, on whichever side has room, clamped to the
 * viewport. Never over the anchor: the player is pointing at that card and
 * covering it is the one thing a peek must not do.
 */
function place(rect) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = host.offsetWidth;
  const h = host.offsetHeight;

  const roomRight = vw - rect.right;
  const roomLeft = rect.left;
  const roomAbove = rect.top;

  let x;
  if (roomRight >= w + EDGE * 2) x = rect.right + EDGE;
  else if (roomLeft >= w + EDGE * 2) x = rect.left - w - EDGE;
  else x = Math.round((vw - w) / 2);           // no side room: centre and go vertical

  let y;
  if (x === rect.right + EDGE || x === rect.left - w - EDGE) {
    y = rect.top + rect.height / 2 - h / 2;    // beside: vertically centred on the card
  } else if (roomAbove >= h + EDGE * 2) {
    y = rect.top - h - EDGE;                   // above the finger — the thumb is below
  } else {
    y = rect.bottom + EDGE;
  }

  host.style.left = `${Math.round(Math.max(EDGE, Math.min(vw - w - EDGE, x)))}px`;
  host.style.top = `${Math.round(Math.max(EDGE, Math.min(vh - h - EDGE, y)))}px`;
}

/* ── show / hide ───────────────────────────────────────────────────────── */

export function show(cardId, node) {
  const card = sel.findCard(cardId) || node?.__card || null;
  if (!card) return false;
  // A face-down card has nothing to read, and showing one would leak the game.
  if (node?.getAttribute('data-facing') === 'down') return false;

  const box = container();
  if (showing === cardId && !box.hidden) { reposition(node); return true; }
  // Already up = this is a SWAP, not an entrance: the layer stays, its contents
  // change under a short crossfade. Dropping `is-in` and re-running the entrance
  // for every grouped open is the strobe §8 is trying to prevent — and it also
  // fired on every STATE_APPLIED rebuild, so a peek held open through a
  // snapshot used to flash once per broadcast.
  const swapping = !box.hidden;
  showing = cardId;
  anchorEl = node || null;

  clear(box);
  const face = faceOf(card);
  if (face) box.appendChild(face);
  box.appendChild(body(card, face));

  box.hidden = false;
  if (swapping) {
    reposition(node);
    crossfade(box);
    return true;
  }
  setClass(box, 'is-in', false);
  reposition(node);
  requestAnimationFrame(() => setClass(box, 'is-in', true));
  return true;
}

/** The crossfade, in JS rather than CSS on purpose: the peek's LOOK (its
 *  entrance transform, its opacity at rest) belongs to the design agent's
 *  stylesheet, and a competing `.is-swapping` rule here would be a second
 *  owner of the same property. A WAAPI keyframe borrows opacity for 130ms and
 *  hands it straight back. §0.9: reduced motion gets the instant swap. */
function crossfade(box) {
  if (prefersReducedMotion() || typeof box.animate !== 'function') return;
  box.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: SWAP_MS, easing: 'ease-out' });
}

function reposition(node) {
  const target = node || anchorEl;
  if (!host || host.hidden) return;
  const rect = target?.getBoundingClientRect();
  place(rect && rect.width
    ? rect
    : { left: window.innerWidth / 2, right: window.innerWidth / 2, top: window.innerHeight / 2, bottom: window.innerHeight / 2, width: 0, height: 0 });
}

export function hide() {
  clearTimeout(inTimer);
  clearTimeout(outTimer);
  inTimer = 0;
  outTimer = 0;
  // The grace window starts when the peek actually goes away, so the next card
  // in the same sweep opens at 0ms. An intent that never matured into a peek
  // does not earn one.
  if (showing !== null) closedAt = now();
  showing = null;
  anchorEl = null;
  if (!host || host.hidden) return;
  setClass(host, 'is-in', false);
  host.hidden = true;
  clear(host);
}

/** Leaving a peekable. §8's 160ms, cancelled by arriving at any other one. */
function armHide() {
  clearTimeout(inTimer);
  inTimer = 0;
  if (showing === null) return;
  if (outTimer) return;
  outTimer = setTimeout(() => { outTimer = 0; hide(); }, HOVER_OUT_MS);
}

function cancelHide() { clearTimeout(outTimer); outTimer = 0; }

export function isOpen() { return !!showing; }

/* ── wiring ────────────────────────────────────────────────────────────── */

/** `[data-peek-card]` is the identity-free hook: ui/discard.js renders real
 *  card faces that deliberately carry no `data-card-id` (§0.4 — one node per
 *  id), and they must still be readable on hover. */
function cardUnder(target) {
  const el2 = target instanceof Element ? target : null;
  return el2 ? el2.closest('[data-card-id],[data-peek-card]') : null;
}

function peekId(node) {
  return Number(node.getAttribute('data-card-id') ?? node.getAttribute('data-peek-card'));
}

/* ── THE FINGER IS BUSY (§P9 FEEL round 3) ─────────────────────────────────
 *
 * MEASURED with `.card.is-dragging` on the page: the peek was hidden on
 * pointerdown and back up ~0ms later, then open for the WHOLE gesture —
 * 28.2% of a 1440×900 viewport, parked on top of the drop targets the drag is
 * aiming at, still there 400ms in.
 *
 * Two things conspired. Pointer capture retargets every pointermove to the
 * dragged node, so the browser fires `pointerover` on it again the instant the
 * drag starts; and the delay group (correctly) opens second-and-later peeks at
 * 0ms, so that re-arm went STRAIGHT to show() with no intent delay to survive.
 * The hide on pointerdown was therefore undone within a frame, every time.
 *
 * A pointer that is DOWN is not pointing, it is acting. So the hover path is
 * closed for the whole press and only the hover path — the touch-and-hold peek
 * (UI_PEEK, which is a press by definition) still calls show() directly, and
 * the delay group's timings are untouched.
 */
let pressed = false;

/** True while a press/drag owns the pointer, or while a card is mid-drag. */
function busy() {
  return pressed || !!document.querySelector('.card.is-dragging');
}

function armHover(node) {
  const id = peekId(node);
  if (!Number.isInteger(id)) return;
  if (busy()) { clearTimeout(inTimer); inTimer = 0; return; }
  cancelHide();                                   // arriving cancels leaving
  if (showing === id) return;
  clearTimeout(inTimer);
  inTimer = 0;
  // Inside the group there is no intent to establish — the player has already
  // told us they are reading. Straight to the swap.
  if (inGroup()) { show(id, node); return; }
  inTimer = setTimeout(() => { inTimer = 0; show(id, node); }, HOVER_IN_MS);
}

export function mount() {
  // Hover is a pointing-device affordance only (§2 `@media (hover:hover)`); a
  // touch device synthesises mouseover on tap and would flash the peek on every
  // single tap.
  const hoverCapable = window.matchMedia?.('(hover: hover)')?.matches;

  if (hoverCapable) {
    document.addEventListener('pointerover', (e) => {
      if (e.pointerType === 'touch') return;
      const node = cardUnder(e.target);
      if (!node) { armHide(); return; }
      armHover(node);
    }, true);

    document.addEventListener('pointerout', (e) => {
      if (e.pointerType === 'touch') return;
      const node = cardUnder(e.target);
      const to = cardUnder(e.relatedTarget);
      if (node && to === node) return;                  // moving within the same card
      if (to) { armHover(to); return; }
      // Not `hide()`: §8's close delay is what makes the 2px gap between two
      // fanned cards survivable, and it is what gives the pointer time to
      // arrive somewhere else before the group has to be rebuilt.
      armHide();
    }, true);
  }

  // Anything that means "I am doing something now" ends the peek immediately:
  // a press starts a drag or a tap, a scroll moves the anchor out from under it.
  window.addEventListener('pointerdown', () => {
    pressed = true;
    if (showing !== null || inTimer) hide();
  }, true);
  // The press ends where the gesture ends — including the cancel a drag that is
  // torn down by a state broadcast produces, or the release would leave the
  // hover path closed for the rest of the game.
  const endPress = () => { pressed = false; };
  window.addEventListener('pointerup', endPress, true);
  window.addEventListener('pointercancel', endPress, true);
  window.addEventListener('blur', endPress);
  window.addEventListener('wheel', () => { if (showing !== null) hide(); }, { passive: true });
  window.addEventListener('scroll', () => { if (showing !== null) hide(); }, true);
  window.addEventListener('blur', () => hide());
  window.addEventListener('resize', () => hide());

  // Touch-and-hold, from interact/pointer.js's long-press recogniser. The press
  // hook fires at PEEK_MS with the finger still down; the release ends it.
  bus.on(UI_PEEK, ({ cardId, node }) => show(cardId, node));
  bus.on(UI_PEEK_END, () => hide());

  // A new snapshot can change what the peek is claiming (the rent it would
  // charge, whether the play is still legal), and it can delete the card.
  bus.on(EVENTS.STATE_APPLIED, () => {
    if (showing === null) return;
    if (!sel.findCard(showing)) { hide(); return; }
    const id = showing;
    showing = null;                                     // force a rebuild
    show(id, anchorEl);
  });
  bus.on(EVENTS.STATE_SCREEN, () => hide());
}
