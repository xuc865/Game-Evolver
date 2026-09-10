// interact/pointer.js — the ONE delegated listener (§2: no inline handlers).
//
// Everything clickable in the client is either [data-action="name"] (a control)
// or [data-card-id] / [data-targetable] (the table). Both routes are keyboard
// operable: Enter/Space activate, Escape cancels (§0.9).
//
// P4 adds the pointer layer on the same principle: ONE window-level
// pointerdown/move/up set recognises press → drag / press → long-press for any
// card node, and hands the result to whoever registered onGesture(). Nothing is
// ever bound to an individual card, so a card node stays a plain reparentable
// object (§0.4).
//
// The listeners sit on `window` with capture:true for two reasons: capture sees
// the event even if a panel stops propagation, and tools/touchtest.mjs
// dispatches its synthetic pointermove/pointerup ON window (an event dispatched
// at window never reaches a document-level listener at all).

import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';

const handlers = new Map();

export function registerAction(name, fn) { handlers.set(name, fn); }
export function registerActions(map) { for (const k in map) handlers.set(k, map[k]); }

let cardTap = () => {};
let targetTap = () => {};
let escape = () => {};

export function onCardTap(fn) { cardTap = fn; }
export function onTargetTap(fn) { targetTap = fn; }
export function onEscape(fn) { escape = fn; }

/* ── gesture recognition ───────────────────────────────────────────────── */

const SLOP = 8;                 // px of travel before a press becomes a drag
// 300ms, down from 450 (owner directive P7): the hold now raises a PEEK of the
// card rather than committing to a sheet, and a peek that takes half a second
// to appear is not a peek. Still comfortably above the ~120ms a deliberate tap
// takes, so a tap never accidentally peeks.
const LONG_PRESS_MS = 300;
// The compatibility click lands in the same task as the release (the 300ms
// legacy delay needs a missing viewport meta, and index.html has one), and it
// always lands at the release point. Both conditions are checked: a window
// alone would eat the next genuine tap after a drag that produced no click at
// all, which is exactly what a synthetic touch drag does.
const CLICK_SUPPRESS_MS = 250;
const CLICK_SUPPRESS_PX = 25;

/**
 * onGesture({ press, release, dragStart, dragMove, dragEnd, dragCancel, longPress })
 *   press(cardId, node, press) → fired SYNCHRONOUSLY inside the pointerdown
 *     handler, before anything is decided. This is the ≤1-frame acknowledgement
 *     (§P7.2): a fresh critic measured lifted:false / sfx:0 / fx:0 at +54ms,
 *     +107ms, +213ms and +427ms after pointerdown because the first feedback in
 *     the client was the CLICK. Nothing here may be async.
 *   release(cardId, node, {moved}) → the press ended (up or cancel), whatever it
 *     became. Undoes whatever press() painted.
 *   dragStart(cardId, node, press) → truthy to take the drag, falsy to refuse
 *     (a refused press still ends as a plain tap: the click is not suppressed).
 *   dragMove(dx, dy, x, y) / dragEnd(x, y) / dragCancel() / longPress(cardId, node)
 */
let hooks = {};
export function onGesture(map) { hooks = map || {}; }

let press = null;               // the one live pointer, or null
let suppress = null;            // {t, x, y} of the last handled gesture's release

export function dragging() { return !!press && press.phase === 'drag'; }

/** Swallow the click the browser synthesises after a handled gesture. Without
 *  this a drag that started on a hand card also fires the tap path on release
 *  and the action strip opens behind the card that just flew away. */
function suppressClick(x, y) { suppress = { t: performance.now(), x, y }; }

function onClickCapture(e) {
  if (!suppress) return;
  const { t, x, y } = suppress;
  suppress = null;
  if (performance.now() - t > CLICK_SUPPRESS_MS) return;
  const dx = e.clientX - x;
  const dy = e.clientY - y;
  if (dx * dx + dy * dy > CLICK_SUPPRESS_PX * CLICK_SUPPRESS_PX) return;
  e.stopPropagation();
  e.preventDefault();
}

function onDown(e) {
  if (press) return;
  if (e.isPrimary === false) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return;
  // Controls keep their own click semantics; only card objects are draggable.
  if (el.closest('[data-action], button, input, textarea, select, a')) return;
  const node = el.closest('[data-card-id]');
  if (!node) return;
  const cardId = Number(node.getAttribute('data-card-id'));
  if (!Number.isInteger(cardId)) return;

  press = {
    id: e.pointerId, cardId, node, phase: 'press', captured: false,
    pointerType: e.pointerType || 'mouse',
    x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
    timer: setTimeout(onLongPress, LONG_PRESS_MS),
  };
  // Synchronous, in the same task as the pointerdown: the acknowledgement is
  // not allowed to wait for the drag/tap decision (§P7.2).
  hooks.press?.(cardId, node, press);
}

function onLongPress() {
  if (!press || press.phase !== 'press') return;
  press.timer = 0;
  press.phase = 'held';
  hooks.longPress?.(press.cardId, press.node);
}

function onMove(e) {
  if (!press || e.pointerId !== press.id) return;
  press.x = e.clientX;
  press.y = e.clientY;
  const dx = e.clientX - press.x0;
  const dy = e.clientY - press.y0;

  // 'held' is included deliberately (owner directive P7): a hold raises the
  // peek, and moving on from there must still start the drag — otherwise a
  // player who pauses for half a second before dragging finds the card stuck.
  if (press.phase === 'press' || press.phase === 'held') {
    if (dx * dx + dy * dy < SLOP * SLOP) return;      // still a tap / still a hold
    if (press.phase === 'held') hooks.longPressEnd?.(press.cardId, press.node);
    clearTimeout(press.timer);
    press.timer = 0;
    const took = hooks.dragStart ? hooks.dragStart(press.cardId, press.node, press) : false;
    press.phase = took ? 'drag' : 'refused';
    if (took) {
      // Capture on the card, not on a synthetic layer: the pointer must keep
      // reporting to us when the finger leaves the card's own box, which is
      // every drag by definition.
      try { press.node.setPointerCapture(press.id); press.captured = true; } catch { /* not supported */ }
    }
  }

  if (press.phase !== 'drag') return;
  if (e.cancelable) e.preventDefault();
  hooks.dragMove?.(dx, dy, e.clientX, e.clientY);
}

function onUp(e) {
  if (!press || e.pointerId !== press.id) return;
  const p = press;
  press = null;
  if (p.timer) clearTimeout(p.timer);
  releaseCapture(p);
  // 'held' is a long-press that already opened the sheet; 'drag' just landed a
  // card. Both must not ALSO fire the tap path. 'press' falls through
  // deliberately: the click event is how a tap is delivered.
  if (p.phase === 'drag' || p.phase === 'held') suppressClick(e.clientX, e.clientY);
  if (p.phase === 'drag') hooks.dragEnd?.(e.clientX, e.clientY);
  hooks.release?.(p.cardId, p.node, { phase: p.phase });
}

function onCancel(e) {
  if (!press || (e && e.pointerId !== press.id)) return;
  const p = press;
  press = null;
  if (p.timer) clearTimeout(p.timer);
  releaseCapture(p);
  if (p.phase === 'drag') { suppressClick(p.x, p.y); hooks.dragCancel?.(); }
  hooks.release?.(p.cardId, p.node, { phase: p.phase });
}

function releaseCapture(p) {
  if (!p.captured) return;
  try { p.node.releasePointerCapture(p.id); } catch { /* already released */ }
}

/** Escape during a drag cancels the drag, not the mode behind it. */
export function abortDrag() {
  if (!press) return false;
  const wasDrag = press.phase === 'drag';
  onCancel(null);
  return wasDrag;
}

/* ── mount ─────────────────────────────────────────────────────────────── */

export function mount() {
  document.addEventListener('click', (e) => route(e));
  window.addEventListener('click', onClickCapture, true);
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (abortDrag()) return; escape(); return; }
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const el = e.target;
    if (!el || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'BUTTON') return;
    if (el.closest('[data-action], [data-card-id], [data-targetable]')) {
      e.preventDefault();
      route(e);
    }
  });
}

function route(e) {
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return;

  const targetable = el.closest('[data-targetable="1"]');
  if (targetable) {
    e.preventDefault();
    targetTap(targetable, e);
    return;
  }

  const actionEl = el.closest('[data-action]');
  if (actionEl) {
    const name = actionEl.dataset.action;
    const fn = handlers.get(name);
    bus.emit(EVENTS.ACTION, { name, el: actionEl });
    if (fn) { e.preventDefault(); fn(actionEl, e); }
    return;
  }

  const card = el.closest('[data-card-id]');
  if (card) {
    cardTap(Number(card.getAttribute('data-card-id')), card, e);
  }
}
