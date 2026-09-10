// ui/hints.js — first-game contextual hints.
//
// Rules this obeys, from the P6 brief: never modal, never blocks input, at most
// three on screen, each shown once ever, and the moment the player does the
// thing the hint was teaching it disappears. The whole stack is
// pointer-events:none, so a hint can never eat a tap meant for a card.
//
// Storage is one localStorage key holding the ids already shown; when every id
// is in it the module stops subscribing to anything.

import { $, el, setClass } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { store } from '../state/store.js';
import * as sel from '../state/selectors.js';
import { mode } from '../interact/index.js';

const KEY = 'chud_hints_v1';
const MAX_ON_SCREEN = 3;
const LIFE_MS = 9000;

const HINTS = {
  // The peek is the one affordance nobody discovers by accident, and it is the
  // one that makes the game teach itself (owner directive, P7) — so it is the
  // FIRST thing said, before the drag.
  peek: 'Hold any card to read it — yours, theirs, anywhere on the table. On a mouse, just '
    + 'hover.',
  drag: 'Drag cards straight onto the table to play them — anywhere on the felt works.',
  // §3.1b — payableCards() (game.js:710-717) is bank + properties + UPGRADES.
  pay: 'Tap your bank, property and Upgrade cards to pay, then confirm. Overpaying gives no '
    + 'change.',
  armed: 'Someone is on FINAL APPROACH. Break one of their sets before their turn comes '
    + 'around, or they win.',
};

let seen = null;
let host = null;
const live = new Map();                  // id → {node, timer}

function load() {
  if (seen) return seen;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    seen = new Set(Array.isArray(raw) ? raw : []);
  } catch { seen = new Set(); }
  return seen;
}

function remember(id) {
  load().add(id);
  try { localStorage.setItem(KEY, JSON.stringify([...seen])); } catch { /* private mode */ }
}

function done() { return load().size >= Object.keys(HINTS).length; }

/**
 * How far off the bottom of the viewport the stack must sit.
 *
 * The first version lifted by the HAND DOCK's height alone and ignored #prompt.
 * MEASURED on a first-timer's first rent, 390×844: .hints occupied y603–648 and
 * the CONFIRM PAYMENT button y609–653, i.e. 146×39 of a 155×44 button covered,
 * for the full 9s life of the hint. The same bug hid 79% of DETAILS on the first
 * hand-card tap. Both were invisible to every tool because the stack is
 * pointer-events:none and elementsFromPoint therefore never reports it.
 *
 * So the lift is not a sum of guessed boxes: it is the distance from the bottom
 * of the viewport to the TOP of the highest thing docked down there. Anything
 * that later joins the dock is covered for free.
 */
function liftPx() {
  const bottom = window.visualViewport
    ? window.visualViewport.height + window.visualViewport.offsetTop
    : window.innerHeight;
  let top = bottom;
  for (const id of ['prompt', 'hand-dock']) {
    const node = $(id);
    if (!node || node.hidden) continue;
    const rect = node.getBoundingClientRect();
    if (rect.height > 0 && rect.top < top) top = rect.top;
  }
  return Math.max(8, Math.round(bottom - top) + 8);
}

/** Re-measure. Cheap (two getBoundingClientRect) and only while a hint is up. */
function relayout() {
  if (!host?.isConnected) return;
  host.style.setProperty('--hint-lift', `${liftPx()}px`);
}

function container() {
  if (!host?.isConnected) {
    host = el('div', { class: 'hints', attrs: { 'aria-live': 'polite' } });
    ($('app') || document.body).appendChild(host);
  }
  relayout();
  return host;
}

function dismiss(id) {
  const entry = live.get(id);
  if (!entry) return;
  live.delete(id);
  clearTimeout(entry.timer);
  setClass(entry.node, 'is-out', true);
  // 220ms matches the .hint-card transition in content.css.
  setTimeout(() => entry.node.remove(), 240);
}

function show(id) {
  if (!HINTS[id] || live.has(id) || load().has(id)) return;
  remember(id);
  if (live.size >= MAX_ON_SCREEN) dismiss(live.keys().next().value);
  const node = el('div', { class: 'hint-card' }, [
    el('span', { class: 'hint-mark', text: '›' }),
    el('span', { class: 'hint-body', text: HINTS[id] }),
  ]);
  container().appendChild(node);
  // Next frame so the entry transition has a start value to run from.
  requestAnimationFrame(() => setClass(node, 'is-in', true));
  live.set(id, { node, timer: setTimeout(() => dismiss(id), LIFE_MS) });
}

export function reset() {
  seen = new Set();
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
  for (const id of [...live.keys()]) dismiss(id);
}

/**
 * The prompt bar grows and shrinks under the hint (a strip is 99–109px, an idle
 * bar is hidden), and ui/prompt.js renders AFTER this module on the same bus
 * event — so re-measuring inside a bus handler would read the previous layout.
 * A ResizeObserver fires after layout, which is the only moment the number is
 * true.
 */
function watchDock() {
  if (typeof ResizeObserver !== 'function') return;
  const ro = new ResizeObserver(() => relayout());
  for (const id of ['prompt', 'hand-dock']) { const node = $(id); if (node) ro.observe(node); }
  window.visualViewport?.addEventListener('resize', relayout);
  window.addEventListener('resize', relayout);
}

export function mount() {
  if (done()) return;
  watchDock();

  // 1 · the player just tapped a hand card: teach the drag they did not use.
  bus.on(EVENTS.INTERACT_CHANGED, () => {
    if (mode.kind === 'strip') show('drag');
    else if (mode.kind !== 'idle') dismiss('drag');
    if (mode.kind === 'payment' && live.has('pay')) {
      // They are selecting cards — the hint has done its job.
      if (mode.selected.size) dismiss('pay');
    }
  });

  bus.on(EVENTS.STATE_APPLIED, () => {
    const snap = store.snapshot;
    if (!snap || snap.phase !== 'playing') {
      for (const id of [...live.keys()]) dismiss(id);
      return;
    }

    // 1 · the first hand they are ever dealt: how to READ a card.
    if (sel.myHand().length) show('peek');

    // 2 · first time money is demanded of them.
    if (sel.owedAmount() > 0) show('pay');
    else dismiss('pay');

    // 3 · first time an opponent arms (getPlayerView.armedIds — §3.10).
    const threat = (snap.armedIds || []).some(id => id !== store.self.id);
    if (threat) show('armed');
    else dismiss('armed');
  });
}
