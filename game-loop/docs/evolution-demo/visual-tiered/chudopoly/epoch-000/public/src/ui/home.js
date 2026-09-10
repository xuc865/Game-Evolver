// ui/home.js — call sign, create/join/quick play, and the deck on the table.

import { $, el, setText, setHidden, clear } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import * as socket from '../net/socket.js';
import * as send from '../net/send.js';
import { store } from '../state/store.js';
import * as pointer from '../interact/pointer.js';
import { faceNode, backNode } from '../table/cardart.js';
import { presetLabel } from './ruleset.js';
// The flight log's entry point is a mark on this screen's rail, so this screen
// mounts it. main.js is architect-owned (§1) and does not need a new import for
// a surface that only exists on the home rail.
import * as flightlog from './stats.js';

const NAME_KEY = 'chud_name';

/* ══ THE DECK ON THE TABLE ═══════════════════════════════════════════════
   index.html used to carry eleven hand-authored spans here: two stale copies
   of the Fighters and Space Force glyphs, a bespoke value coin pinned at
   left:8%/bottom:7% that matched no real card, and a back showing only the
   alignment target with the wordmark missing. The owner's verdict on the
   close-up was "tacky / not well made", and the cause is duplication rather
   than draughtsmanship: table/cardart.js has been redrawn three times since
   those copies were taken, so they were wrong the moment they were written and
   would go wrong again.

   So the menu builds REAL CARDS. faceNode()/backNode() return detached nodes
   parsed through cardart's own DOMParser path (§0.4 — nothing writes innerHTML),
   and the 'hand' tier is the one that is fully container-query relative, so the
   same markup that renders at 37px in a crowded fan renders at 250px here with
   every proportion preserved. That is also the answer to the coin: it sits
   where the card design puts it, at whatever size, because it IS the card.

   Decorative only. No [data-card-id] — every consumer in the client (pointer,
   choreographer, peek, prompt) selects on that attribute, so a node without one
   is invisible to all of them — no .card / .cardzone class, and the host is
   aria-hidden.

   WHICH CARDS. A property and an action, not two properties: the two halves of
   what the deck does. The F-22 is the game's signature glyph and its set is the
   one the wordmark's red is drawn from; the Inspector General is the card the
   whole table is afraid of, it is achromatic by §1 so it does not fight the
   red, and at 5M it carries the largest coin in the deck. */
const HOME_CARDS = [
  { id: 'home-a', type: 'property', color: 'red', name: 'F-22 Raptor', value: 3 },
  {
    id: 'home-b', type: 'action', action: 'inspector_general', name: 'Inspector General', value: 5,
    description: 'Steal a complete property set from any player. OPSEC can block it.',
  },
];

/** How many backs are in the pile. Four reads as "a deck"; three reads as
 *  "some cards" and five buys nothing but overdraw at this size. */
const DECK_DEPTH = 4;

function buildDeck() {
  const host = $('home-deck');
  if (!host || host.firstChild) return;

  // The pile. Each back gets its own box so the container query sizing the art
  // is the card, not the pile (cardart.css queries the nearest inline-size
  // container and .home-deck is far wider than one card).
  for (let i = 0; i < DECK_DEPTH; i++) {
    const box = el('div', { class: `home-cardbox home-back home-back-${i}` });
    box.appendChild(backNode('hand'));
    host.appendChild(box);
  }

  HOME_CARDS.forEach((card, i) => {
    const face = faceNode(card, 'hand');
    if (!face) return;
    const box = el('div', { class: `home-cardbox home-dealt home-dealt-${i}` });
    box.appendChild(face);
    host.appendChild(box);
  });
}

/* ══ SOUND, FROM THE MENU — NOW THE SETTINGS MARK ════════════════════════
   This file used to own a music toggle in the rail's right corner. It existed
   because §7 attaches the bed on the first pointerdown anywhere (main.js) and
   the only switch lived inside the game screen's HUD, so tapping Quick Play
   bought a bed you could not silence until the table loaded — it was a
   MITIGATION for a missing surface, and its own comment said so.

   ui/settings.js is now reachable from home, lobby and the table, and Sound
   and Music are its first two rows, so the same corner opens the whole sheet.
   Keeping both would have left two adjacent marks in one rail that both mean
   "audio", one a strict subset of the other (ART §3.2), and would have needed
   a third corner the phone's two-column rail has no room for.

   The ordering property the old mark had is KEPT, and it is why this is a
   `data-action` rather than a click handler: interact/pointer.js dispatches on
   window CAPTURE and main.js's audio unlock is a bubble-phase listener on the
   same window, so the sheet is open before init() ever runs. What that costs
   in practice is measured in ui/settings.js, not asserted here. */

function savedName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}

function rememberName(name) {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* private mode */ }
}

function nameOrComplain() {
  const input = $('name-input');
  const name = (input?.value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._'-]{0,15}$/.test(name)) {
    setText($('home-error'), 'Call sign: 1–16 letters, numbers, spaces or . _ - \'');
    input?.focus();
    return null;
  }
  setText($('home-error'), '');
  rememberName(name);
  store.self.name = name;
  return name;
}

function go(fn) {
  const name = nameOrComplain();
  if (!name) return;
  socket.connect();
  fn(name);
}

/* ══ OPEN TABLES — the public-rooms browse (owner directive 2026-08-07) ════
   GET /api/public-rooms on arrival, then a gentle poll while this screen is
   the one on show. The section renders ONLY when at least one public lobby
   exists — the owner's ruling, verbatim: "dont show browse games if there
   isnt any actual ones" — so with zero rooms the home screen is unchanged.
   Joining a row is send.joinRoom() with the row's code: byte-for-byte the
   same path a typed code takes, no new join semantics. Every string lands
   via el()'s textContent (XSS discipline); the host name is server-validated
   but that is defence in depth, not a licence. A 10s poll is a fetch, not a
   frame source, so §0.6's one-clock rule is not in play; the tick stands
   down entirely off-screen and in hidden tabs. */
const TABLES_POLL_MS = 10000;
let tablesTimer = 0;
let tablesKey = '';                  // last painted listing, to skip no-op repaints

function paintTables(list) {
  const host = $('home-tables');
  if (!host) return;
  const rooms = Array.isArray(list) ? list.slice(0, 8) : [];
  const key = rooms.map(r => `${r.code}:${r.seats}:${r.host}:${r.preset}`).join('|');
  if (key === tablesKey) return;
  tablesKey = key;
  clear(host);
  if (!rooms.length) { setHidden(host, true); return; }
  host.appendChild(el('p', { class: 'home-tables-label', text: 'OPEN TABLES' }));
  for (const room of rooms) {
    if (!/^[A-HJ-NP-Z2-9]{4}$/.test(String(room.code || ''))) continue;   // server said, but verify
    host.appendChild(el('button', {
      class: 'btn home-table-row',
      attrs: { type: 'button' },
      dataset: { action: 'join-public', code: room.code },
    }, [
      el('span', { class: 'home-table-host', text: String(room.host || 'Host') }),
      el('span', { class: 'home-table-meta', text: `${room.seats}/${room.capacity} seats · ${presetLabel(room.preset)}` }),
      el('span', { class: 'home-table-code mono', text: room.code }),
    ]));
  }
  setHidden(host, false);
}

async function refreshTables() {
  if (store.screen && store.screen !== 'home') return;
  if (document.hidden) return;
  try {
    const res = await fetch('/api/public-rooms');
    if (!res.ok) return;                       // rate limit / server trouble: keep what we have
    const data = await res.json();
    paintTables(data?.rooms);
  } catch { /* offline home stays a home screen */ }
}

function startTablesPoll() {
  if (tablesTimer) return;
  refreshTables();
  tablesTimer = setInterval(refreshTables, TABLES_POLL_MS);
}

/* ══ FIRST-TIMER vs RETURNING ════════════════════════════════════════════
   These looked identical, which is the gap: the returning player's call sign
   was silently prefilled and nothing on screen acknowledged it, so the field
   still read as the first thing to answer when it was already answered.

   The difference is deliberately NOT a reordering. Moving the answered field
   below the button is the tempting version and it breaks WCAG 2.4.3 — visual
   order and focus order would disagree. So the DOM order is fixed and the
   EMPHASIS moves: the greeting names them, and .is-returning narrows the
   answered call-sign row so the ink slab takes the width it gives up. */
function paintIdentity(name) {
  const home = document.querySelector('.home');
  const greet = $('home-greet');
  if (!home || !greet) return;
  home.classList.toggle('is-returning', !!name);
  if (name) setText(greet, `Welcome back, ${name}.`);
  greet.hidden = !name;
}

export function mount() {
  const input = $('name-input');
  const saved = savedName();
  if (input && !input.value) input.value = saved;
  paintIdentity(saved);
  buildDeck();
  // Registers `flight-log` and decides whether the rail's second reading mark
  // is on the screen at all. It reads state/stats.js, which never throws.
  flightlog.mount();

  const params = new URLSearchParams(location.search);
  const room = (params.get('room') || '').toUpperCase();
  if (room && $('code-input')) $('code-input').value = room;

  pointer.registerActions({
    'quick-play': () => go((name) => send.quickPlay(name)),
    // The public flag is read at the moment of creation, never remembered:
    // an opt-in that silently persisted across sessions would list a room
    // the host did not choose to list today.
    'create-room': () => go((name) => send.createRoom(name, !!$('public-toggle')?.checked)),
    'join-room': () => go((name) => {
      const code = ($('code-input')?.value || '').trim().toUpperCase();
      if (!/^[A-HJ-NP-Z2-9]{4}$/.test(code)) {
        setText($('home-error'), 'Room codes are 4 characters.');
        return;
      }
      send.joinRoom(code, name, socket.creds());
    }),
    // A row in OPEN TABLES: the ordinary join, with the row's code.
    'join-public': (elx) => go((name) => {
      const code = String(elx?.dataset?.code || '').toUpperCase();
      if (!/^[A-HJ-NP-Z2-9]{4}$/.test(code)) return;
      send.joinRoom(code, name, socket.creds());
    }),
  });
  startTablesPoll();

  // Enter submits from either field.
  for (const id of ['name-input', 'code-input']) {
    $(id)?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const code = ($('code-input')?.value || '').trim();
      if (code) $('btn-join-room')?.click();
      else $('btn-quick-play')?.click();
    });
  }

  bus.on(EVENTS.NET_ERROR, (msg) => {
    if (store.screen === 'home') setText($('home-error'), msg.message || 'Something went wrong');
  });
  bus.on(EVENTS.NET_JOINED, () => setText($('home-error'), ''));
}
