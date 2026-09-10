// handpeek.js — swipe the fan back up during a payment.
//
// §3.13, owner directive 2026-08-12. `4a8e282` folds the hand away whenever the prompt is a
// payment, because the hand is the ONE surface that cannot answer it (`payableCards`,
// game.js:1128, is bank + properties + upgrades) and on a phone the two surfaces that CAN were
// below the fold. That reasoning is about reach and it still holds.
//
// What it got wrong is treating "cannot answer" as "not worth seeing". Which cards you hold is
// exactly what tells you whether a property is worth defending — a 3M orange you can rebuild
// from hand is a very different thing to give up than one you cannot. So the fan stays FOLDED
// by default on a phone and stays REACHABLE: swipe up on the dock and it returns over the
// prompt without dismissing it.
//
// Deliberately not a button. The dock has four already (draw / end turn / emote / scoop) and a
// fifth that appears only during a payment would be the busiest control on the smallest screen
// at the moment of the hardest decision. A swipe costs no pixels.

import { on, emit, EVENTS } from '../core/bus.js';

// Vertical travel before it counts as a swipe rather than a tap or a scroll nudge. 24px is the
// same threshold interact/pointer.js uses to promote a press into a drag, so the two gestures
// agree on what "moved" means and a slow drag off a card cannot open the peek behind it.
const SWIPE_PX = 24;
// Beyond this the pointer is being dragged, not flicked, and the intent is ambiguous. Bounding
// it stops a long press-and-wander from opening the peek on release.
const SWIPE_MS = 700;

let dock = null;
let start = null;

function peeking() { return !!dock && dock.classList.contains('is-peeking'); }

function paying() {
  const prompt = document.getElementById('prompt');
  return !!prompt && prompt.dataset.state === 'payment';
}

// The fold is CSS keyed on the prompt state, so the peek is only ever meaningful while a
// payment is open AND the fold is actually in effect. Asking the element rather than
// re-deriving the media query keeps this file from owning a copy of the breakpoint: if
// style/table.css changes when it folds, this follows automatically.
function folded() {
  const zone = document.getElementById('zone-hand');
  if (!zone || !paying()) return false;
  if (peeking()) return true;                 // already open: the fold is what we are overriding
  // `pointer-events`, NOT height. The fold animates max-block-size/opacity/padding over 180ms,
  // so a height read taken while the prompt is still opening returns a half-collapsed 12px and
  // the swipe is ignored for the fifth of a second a player is most likely to try it — which
  // is exactly what the first version of this did. `pointer-events` is in the same rule and is
  // deliberately NOT in its transition list, so it flips the instant the fold applies, and
  // reading it still lets style/table.css own when the fold happens.
  return getComputedStyle(zone).pointerEvents === 'none';
}

function open() {
  if (!dock || peeking()) return;
  dock.classList.add('is-peeking');
  emit(EVENTS.INTERACT_CHANGED, { handPeek: true });
}

function close() {
  if (!dock || !peeking()) return;
  dock.classList.remove('is-peeking');
  emit(EVENTS.INTERACT_CHANGED, { handPeek: false });
}

function onDown(e) {
  if (!dock) return;
  const inDock = e.target instanceof Node && dock.contains(e.target);
  // A pointer that lands outside the dock while the peek is open closes it — the same
  // dismissal a sheet gets, so the prompt underneath stays reachable in one tap.
  if (!inDock) { if (peeking()) close(); return; }
  if (!folded()) { start = null; return; }
  start = { y: e.clientY, t: e.timeStamp };
}

function onUp(e) {
  if (!start || !dock) return;
  const dy = start.y - e.clientY;             // positive = upward
  const dt = e.timeStamp - start.t;
  start = null;
  if (dt > SWIPE_MS) return;
  if (dy >= SWIPE_PX) open();
  else if (dy <= -SWIPE_PX) close();
}

/**
 * Wire the peek. Idempotent, and safe to call before the dock exists.
 * Listeners are on window in the CAPTURE phase for the same reason pointer.js's are: the table
 * stops propagation on card pointerdowns, and a bubble-phase listener would never see them.
 */
export function mount() {
  dock = document.getElementById('hand-dock');
  if (!dock || mount.done) return;
  mount.done = true;
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', () => { start = null; }, true);
  // The peek is scoped to ONE payment. Any state change that could end it closes the peek, so
  // it can never survive into the next prompt and leave the dock stuck open.
  on(EVENTS.STATE_APPLIED, () => { if (!paying()) close(); });
}

export const _internal = { folded, open, close, peeking, SWIPE_PX, SWIPE_MS };
