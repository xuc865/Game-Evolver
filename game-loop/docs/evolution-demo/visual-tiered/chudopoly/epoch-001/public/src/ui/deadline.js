// ui/deadline.js — the answer clock, and the alarm that goes with it.
//
// WHY THIS EXISTS, MEASURED (P9 legibility round).
//
// A real game was played through the real client against the shipped bots. At
// t=9.1s a bot played Finance Office and demanded 5M. The pending action then
// sat there — with the human as the only responder — for 45 seconds, and:
//
//   • `#hud-timer` was hidden for every one of those frames,
//   • `#prompt-timer` was hidden for every one of those frames,
//   • at t=54.1s the server auto-accepted the charge and paid it out of the
//     player's cheapest cards, and the client had never once shown a clock.
//
// The cause is not in the client. server/broadcast.js's broadcastAndScheduleBot
// serialises the room BEFORE it calls timers.syncTimers(), so `responseTimer` is
// still null in the very broadcast that first carries the pendingAction — and
// because a pending action against a human produces no further broadcast until
// it resolves, that null is the ONLY value the client ever sees. Verified over
// a raw socket: every state message in the whole attack carried
// `responseTimer: null`, while `timers: {turn:0, response:45}` was present in
// all of them. A human attacker's charge does not have the bug (the
// `play_action` handler arms the deadline before it broadcasts), so the
// countdown was working exactly in the case nobody plays and missing in the one
// everybody does.
//
// The one-line server fix is in this agent's report. This module makes the
// client correct either way:
//
//   1. If the server sent a live `responseTimer`, that is the truth and it is
//      used verbatim — same field, same arithmetic as ui/hud.js.
//   2. Otherwise the SETTING (`timers.response`, present in every broadcast) is
//      combined with the moment this client first SAW the pending action.
//
// (2) can only ever read LOW: the client sees the charge after the server
// created it, so the derived countdown reaches zero slightly before the server
// acts, never after. A clock that says "3s" when there are 3.4 is honest; one
// that says "3s" when there are none is the failure this replaces.
//
// The alarm is a separate promise: §5 wants urgency where the decision is, and
// a 2.9em ring is not "unmissable" on a 390px phone. So a fixed, pointer-events
// -free rail rings the whole viewport while the table is waiting on YOU, and
// only then — it is silent for a charge aimed at somebody else, which is most
// of them.

import { $, el, setText, setClass, setStyle } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { subscribe } from '../core/clock.js';
import { clamp } from '../core/math.js';
import { store } from '../state/store.js';
import * as sel from '../state/selectors.js';

/* ── the table's clock SETTINGS ────────────────────────────────────────────
 *
 * server/broadcast.js ships `timers: {turn, response}` — the settings, in
 * seconds, 0 meaning off — in every single broadcast, lobby included.
 * state/store.js keeps only the two live countdowns (`turnTimer`,
 * `responseTimer`), so the settings are read straight off the wire here. NET_STATE
 * is a fan-out channel; subscribing to it costs main.js nothing and touches no
 * file this agent does not own. */
const settings = { turn: null, response: null };

export function turnSeconds() { return settings.turn; }
export function responseSeconds() { return settings.response; }

/* ── when did THIS decision land in front of me? ───────────────────────── */

/**
 * Identity of the pending action as far as a deadline is concerned. The server
 * re-arms the response clock every time somebody answers (server/handlers.js
 * `respond`), so the responder set is part of the identity: when the queue moves
 * on to the next seat, the local clock has to move with it.
 */
function pendingKey(snap) {
  const pa = snap?.pendingAction;
  if (!pa) return '';
  return [
    pa.sourceId || '', pa.action || '', pa.type || '', pa.amount ?? '',
    (snap.responders || []).join(','),
  ].join('|');
}

let key = '';
let seenAt = 0;

/**
 * @returns {{left:number, total:number, exact:boolean}|null}
 *   `exact` false means the countdown is derived from the setting plus local
 *   arrival (see the header) rather than read off a server timestamp.
 */
export function read() {
  const snap = store.snapshot;
  if (!snap || snap.phase !== 'playing' || !snap.pendingAction) return null;

  const server = store.timers.response;
  if (server && server.timeout > 0) {
    const left = clamp(server.timeout - (Date.now() - server.startedAt) / 1000, 0, server.timeout);
    return { left, total: server.timeout, exact: true };
  }

  const total = settings.response;
  if (!(total > 0) || !seenAt) return null;
  const left = clamp(total - (Date.now() - seenAt) / 1000, 0, total);
  return { left, total, exact: false };
}

/** Is there a countdown to show at all? */
export function active() { return !!read(); }

/** Is the countdown MINE — i.e. is the table waiting on me? */
export function mine() { return sel.iMustRespond() && active(); }

/** The sentence that says what the clock will do if it runs out. §6 agency:
 *  a decision made FOR a player has to be announced before it is made, not
 *  only after. */
export function consequence() {
  const d = read();
  if (!d) return '';
  const owed = sel.owedAmount();
  const secs = Math.max(0, Math.ceil(d.left));
  // ZERO IS NOT A COUNTDOWN. The clock reaching 0 means the server's timeout has
  // already fired and its broadcast is in flight; ui/hud.js tickTimer() (64-67)
  // deliberately hides both rings for exactly that gap because "0s" reads as a hung
  // clock. This sentence kept printing "0s — answer now, or it is answered for you"
  // underneath the hidden ring — an instruction to act, at the one moment acting is
  // no longer possible. It says what is actually happening instead.
  if (d.left <= 0) return 'Time is up — the table is answering for you.';
  // Short on purpose. Measured on a 390×844 phone: the first draft of this
  // sentence ("45s answer clock: run it out and the 5M is accepted for you and
  // paid from your cheapest cards.") wrapped to three lines and took the prompt
  // bar past 140px — a sixth of the screen, on the one screen where the answer
  // is a card you have to be able to see and touch.
  if (secs <= 10) return `${secs}s — answer now, or it is answered for you.`;
  return owed > 0
    ? `${d.total}s to answer, or the ${owed}M is paid for you.`
    : `${d.total}s to answer, or it is accepted for you.`;
}

/* ── the rail ─────────────────────────────────────────────────────────────
 *
 * A fixed, non-interactive frame. It never enters layout, so it cannot fight
 * whatever the table is doing underneath it, and it sits BELOW the sheet
 * scrim (90) on purpose: with a sheet open the decision is not on the felt and
 * a flashing border around the sheet would be noise, not urgency.
 */
const CSS = `
#chud-alarm{position:fixed;inset:0;pointer-events:none;z-index:79;opacity:0;
  transition:opacity .16s linear}
#chud-alarm.is-on{opacity:1}
#chud-alarm i{position:absolute;inset:0;display:block;
  box-shadow:inset 0 0 0 .18rem var(--chud-alarm-ink),inset 0 0 2.4rem -.4rem var(--chud-alarm-ink)}
#chud-alarm{--chud-alarm-ink:var(--danger,#d2413a)}
#chud-alarm.is-urgent i{animation:chud-alarm 1s ease-in-out infinite}
#chud-alarm.is-critical i{animation-duration:.44s}
@keyframes chud-alarm{0%,100%{opacity:.42}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){#chud-alarm.is-urgent i,#chud-alarm.is-critical i{animation:none;opacity:.85}}
`;
/* The bar's countdown node keeps the shipped `.prompt-timer` class, so the ring
 * the design agent styles in public/style/content.css is the ring that appears.
 * Only the ID is new (#prompt-deadline), so ui/hud.js's single clock subscriber
 * — which HIDES #prompt-timer on every tick where the server sent no deadline —
 * can never fight this one for the same node. `.is-derived` is set on it when
 * the countdown came from the setting rather than a server timestamp; it is a
 * state marker for tools and for whoever styles the two cases differently, and
 * it is deliberately not a visual difference this file invents. */

let rail = null;

function ensureRail() {
  if (rail?.isConnected) return rail;
  if (!document.getElementById('chud-deadline-style')) {
    const style = document.createElement('style');
    style.id = 'chud-deadline-style';
    style.textContent = CSS;                        // text, never HTML (§0.4)
    document.head.appendChild(style);
  }
  rail = el('div', { id: 'chud-alarm', attrs: { 'aria-hidden': 'true' } }, [el('i')]);
  document.body.appendChild(rail);
  return rail;
}

/* ── the tick ─────────────────────────────────────────────────────────────
 *
 * Two guarded writes per frame at most, and every one of them is skipped when
 * the value has not changed (§0.8) — the seconds only change 1×/s and the ring
 * fraction is quantised to 1/200th, which is finer than a 2.9em ring can show.
 */
let lastSeconds = -1;
let lastFrac = -1;

function tick() {
  const box = ensureRail();
  const d = read();
  // The rail answers "is the table waiting on ME", which is true whether or not
  // a clock is running — a host can turn the answer clock OFF, and being under
  // attack is no less true for being untimed. Only the PULSE belongs to the
  // countdown.
  const isMine = sel.iMustRespond() && store.snapshot?.phase === 'playing';
  setClass(box, 'is-on', !!isMine);

  if (!d || d.left <= 0) {
    setClass(box, 'is-urgent', false);
    setClass(box, 'is-critical', false);
    const ring = $('prompt-deadline');
    if (ring) setText(ring.firstElementChild, '');
    // The ring is blanked here, but the SENTENCE under it is only rewritten on a
    // second boundary below — so it froze on whatever it last said ("1s — answer
    // now, or it is answered for you") and sat there under an empty ring for the
    // whole gap between the timeout firing and its broadcast landing. It is
    // rewritten on the way out too, so the two never disagree.
    if (lastSeconds !== -1) {
      const why = $('prompt-deadline-why');
      if (why) setText(why, consequence());
    }
    lastSeconds = -1;
    lastFrac = -1;
    return;
  }

  const seconds = Math.ceil(d.left);
  const frac = d.total ? Math.round((d.left / d.total) * 200) / 200 : 0;

  setClass(box, 'is-urgent', !!isMine && seconds <= 15);
  setClass(box, 'is-critical', !!isMine && seconds <= 5);

  const ring = $('prompt-deadline');
  if (ring) {
    if (seconds !== lastSeconds) setText(ring.firstElementChild, `${seconds}s`);
    if (frac !== lastFrac) setStyle(ring, '--frac', frac.toFixed(3));
    setClass(ring, 'is-urgent', seconds <= 15);
    setClass(ring, 'is-critical', seconds <= 5);
    setClass(ring, 'is-derived', !d.exact);
  }
  // The prompt bar rewrites its own sentence on a state change, not per frame,
  // so the last ten seconds are counted down here where the clock already is.
  if (seconds !== lastSeconds) {
    const why = $('prompt-deadline-why');
    if (why) setText(why, consequence());
  }
  lastSeconds = seconds;
  lastFrac = frac;
}

export function mount() {
  ensureRail();

  bus.on(EVENTS.NET_STATE, (msg) => {
    const t = msg?.timers;
    if (!t || typeof t !== 'object') return;
    settings.turn = Number.isFinite(t.turn) ? t.turn : settings.turn;
    settings.response = Number.isFinite(t.response) ? t.response : settings.response;
  });

  bus.on(EVENTS.STATE_APPLIED, ({ snapshot }) => {
    const next = pendingKey(snapshot);
    if (next === key) return;
    key = next;
    // A NEW decision starts a new clock; a cleared one stops it dead.
    seenAt = next ? Date.now() : 0;
    lastSeconds = -1;
    lastFrac = -1;
  });

  subscribe(tick);
}
