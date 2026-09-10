// ui/screens.js — screen switching, toasts, and the one bottom sheet.
//
// Sheets are used for exactly what §5 allows: card details, help, settings,
// discard pick. Everything else (targeting, payment, the action strip) happens
// on the table or in the prompt bar.

import { $, clear, setHidden, setText, setClass } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import * as socket from '../net/socket.js';
import * as store from '../state/store.js';
import * as pointer from '../interact/pointer.js';
import * as transition from '../anim/transition.js';
import * as table from '../table/index.js';
import * as choreographer from '../anim/choreographer.js';

const SCREENS = ['home', 'lobby', 'game'];
let toastTimer = 0;
let sheetReturnFocus = null;

/**
 * ART §4 asks for a view transition on screen changes; MEASURED, lobby → table
 * was a 33ms hard cut and `grep startViewTransition public/` found nothing in
 * the build. anim/transition.js owns the capability and reduced-motion guards —
 * the mutation below always runs, transition or not.
 *
 * Only when the screen actually changes: showScreen() is called on every
 * STATE_SCREEN, and STATE_SCREEN repeats the current screen on a great many
 * broadcasts. Transitioning to where you already are would freeze a snapshot of
 * the table over the live one several times a turn.
 */
let shownScreen = '';

export function showScreen(name) {
  const paint = () => {
    for (const screen of SCREENS) setHidden($(`screen-${screen}`), screen !== name);
  };
  if (name === shownScreen) { paint(); return; }
  /* THE FIRST SCREEN IS A PAINT, NOT A CHANGE (§P9 FEEL round 4).
   *
   * boot() ends with showScreen(store.screen), and `shownScreen` is '' there,
   * so the very first screen the player ever sees was being transitioned INTO
   * — from a document with nothing in it. MEASURED on the shipped build: the
   * class went on <html> 39ms after navigation and came off at 322ms, and for
   * all 283ms of that `document.elementFromPoint()` returned <html> from every
   * coordinate on the page, because a running view transition captures the live
   * subtree and hit-tests against the pseudo tree instead. The whole UI was
   * unreachable to a pointer for a third of a second at boot, to cross-fade a
   * blank page into the home screen. The screenshot gate landed inside that
   * window and reported "4/4 hand cards are not hit-testable, first blocked by
   * html.vt-screen-home" on ten surfaces; a player who taps fast gets the same
   * dead third of a second, which is the part that is not a gate problem.
   *
   * There is nothing to transition FROM on the first paint, so there is no
   * transition. Everything after it is a real change and still gets one.
   *
   * AND A TELEPORT IS NOT A CHANGE EITHER. A reconnect, a resume after a
   * reload, a rematch, a fixture injected by a tool: store.setScreen marks all
   * of them, the choreographer refuses to animate the snapped ones and
   * ui/feed.js refuses to narrate them, for the one reason that covers this
   * file too — nothing was performed. MEASURED, phone, the discard-limit
   * fixture applied to a fresh document: 250ms after the state landed <html>
   * still carried `vt-screen-game`, `document.elementFromPoint()` over the
   * centre of an enabled, 85×44, un-occluded END TURN button returned <html>,
   * and a real CDP finger tap on it did nothing at all. That is a fair price
   * for a change the player asked for and is watching (Quick play, Start,
   * Leave room all still get one) and no price at all for arriving somewhere
   * they were already meant to be. */
  const first = !shownScreen;
  shownScreen = name;
  if (first || store.store.screenSnapped) { paint(); return; }
  transition.screenChange(paint, `screen-${name}`);
}

export function toast(message) {
  const el = $('toast');
  if (!el || !message) return;
  setText(el, message);
  setClass(el, 'is-on', true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setClass(el, 'is-on', false), 2600);
}

export function openSheet(title, body, { onClose } = {}) {
  const sheet = $('sheet');
  if (!sheet) return;
  setText($('sheet-title'), title);
  const host = $('sheet-body');
  clear(host);
  if (body) host.appendChild(body);
  sheet.__onClose = onClose || null;
  sheetReturnFocus = document.activeElement;
  setHidden(sheet, false);
  const focusable = sheet.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  focusable?.focus();
}

export function closeSheet() {
  const sheet = $('sheet');
  if (!sheet || sheet.hidden) return;
  setHidden(sheet, true);
  clear($('sheet-body'));
  const cb = sheet.__onClose;
  sheet.__onClose = null;
  if (typeof cb === 'function') cb();
  if (sheetReturnFocus?.isConnected) sheetReturnFocus.focus();
  sheetReturnFocus = null;
}

export function sheetOpen() { return !$('sheet')?.hidden; }

/* ── leaving, for real ─────────────────────────────────────────────────────
 *
 * OWNER BUG (P7, reproduced headlessly): pressing Leave room did nothing. Two
 * compounding causes, both here:
 *
 *   1. The handler navigated with `location.href = location.pathname` and never
 *      called clearCreds(). The reload re-ran boot(), boot() found chud_pid /
 *      chud_room / chud_resume still in sessionStorage and called
 *      resumeOrConnect() — which put the player straight back into the room
 *      they had just left. Measured after the click: screenGameVisible true,
 *      creds unchanged, URL unchanged, zero console errors.
 *   2. `leave_room` was only ENQUEUED. net/socket.js drains at MIN_GAP=150ms,
 *      and the navigation threw the outbox away before the frame was written,
 *      so the server never learned the seat was free.
 *
 * The fix is one teardown used by every exit — Leave room, and main.js's fatal
 * "Room not found" / "Invalid resume credentials" path. It does not reload:
 * a reload was only ever a way of avoiding this function.
 *
 * @param {{message?:string, error?:string, farewell?:Function}} opts
 *        farewell runs while the socket is still open and is flushed before it
 *        closes — that is where `leave_room` goes.
 */
export function endSession({ message = '', error = '', farewell = null } = {}) {
  if (typeof farewell === 'function') farewell();
  socket.disconnect({ flushFirst: true });
  socket.clearCreds();
  store.store.connected = false;
  store.reset();
  /* THE FELT GOES WITH THE SESSION (§10 — the snapshot is truth).
   *
   * store.reset() nulls the snapshot, and until this line that made the store
   * and the screen disagree: every card node of the game just left stayed
   * parented in its zone, invisible only because #screen-game is hidden, and
   * came back into view the moment the next game unhid it. The choreographer
   * goes first because a job queued by the game that is ending must not
   * reconcile a dead snapshot onto an emptied table. */
  choreographer.clear();
  table.clear();
  closeSheet();
  setHidden($('win-overlay'), true);
  store.setScreen('home');
  showScreen('home');                 // setScreen is a no-op if we were already 'home'
  setText($('home-error'), error);
  if (message) toast(message);
}

export function mount() {
  pointer.registerActions({
    'close-sheet': () => closeSheet(),
  });

  bus.on(EVENTS.TOAST, (message) => toast(message));
  bus.on(EVENTS.STATE_SCREEN, (name) => showScreen(name));

  // Focus trap (§0.9): Tab cycles inside an open sheet, Escape closes it.
  document.addEventListener('keydown', (e) => {
    const sheet = $('sheet');
    if (!sheet || sheet.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
    if (e.key !== 'Tab') return;
    const items = [...sheet.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // Scrim tap closes the sheet without swallowing taps inside the panel.
  $('sheet')?.addEventListener('click', (e) => {
    if (e.target === $('sheet')) closeSheet();
  });
}
