// ui/hud.js — turn state, play counter, timers, and the turn-level controls.
//
// The timer is the only thing here that runs per frame, and it writes at most
// two guarded values per frame (§0.8): the ring fraction as a CSS var and the
// seconds text, both skipped when unchanged. Urgency fires once at 10s and once
// at 5s, not per tick (§5).

import { $, qs, setText, setAttr, setHidden, setClass } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { subscribe } from '../core/clock.js';
import { clamp } from '../core/math.js';
import { deckCycleNotice } from '../core/cards.js';
import * as send from '../net/send.js';
import * as socket from '../net/socket.js';
import { store, seatName, isMyTurn, selfPlayer } from '../state/store.js';
import * as sel from '../state/selectors.js';
import * as choreographer from '../anim/choreographer.js';
import * as interact from '../interact/index.js';
import * as pointer from '../interact/pointer.js';
import * as audio from '../audio/engine.js';
import { haptic, HAPTICS } from '../fx/index.js';
import { toast, openSheet, closeSheet, sheetOpen } from './screens.js';
import { el, clear } from '../core/dom.js';
import { SUDDEN_DEATH_COPY } from './ruleset.js';

let lastSeconds = -1;
let urgency = 0;

function activeTimer() {
  const snap = store.snapshot;
  if (!snap || snap.phase !== 'playing') return null;
  // §P9 round 3: the header printed a live "60s" turn countdown next to the
  // word DEALING, i.e. it was counting down a turn that had not visibly begun.
  // The clock belongs to the turn the player can SEE; until the narration has
  // landed for this game there is no such turn.
  if (!narrated) return null;
  if (snap.pendingAction && store.timers.response) return store.timers.response;
  if (!snap.pendingAction && store.timers.turn) return store.timers.turn;
  return null;
}

/** One ring, painted. Two guarded writes plus the class flips (§0.8). */
function paintRing(box, seconds, frac) {
  if (!box) return;
  setHidden(box, false);
  setText(box.firstElementChild, `${seconds}s`);
  box.style.setProperty('--frac', frac.toFixed(3));
  setClass(box, 'is-urgent', seconds <= 10);
  setClass(box, 'is-critical', seconds <= 5);
}

/**
 * §5 wants urgency at ≤10s and ≤5s where the decision is. When the countdown
 * belongs to a RESPONSE, the decision is the prompt bar at the bottom of the
 * phone, not the 2.35em ring in the top HUD — measured: the respond prompt
 * rendered with #hud-timer hidden entirely, so being attacked had no clock at
 * all (§P7.7). ui/prompt.js builds #prompt-timer; this is the one clock (§0.6)
 * and it paints both rings from the same tick.
 */
function tickTimer() {
  const timer = activeTimer();
  const box = $('hud-timer');
  const bar = $('prompt-timer');
  const left = timer
    ? clamp(timer.timeout - (Date.now() - timer.startedAt) / 1000, 0, timer.timeout)
    : 0;
  // A zero here means the server's timeout already fired and its broadcast is in
  // flight; showing "0s" for that gap reads as a hung clock.
  if (!timer || left <= 0) {
    if (box && !box.hidden) setHidden(box, true);
    if (bar && !bar.hidden) setHidden(bar, true);
    if (lastSeconds !== -1) { lastSeconds = -1; urgency = 0; }
    return;
  }
  const seconds = Math.ceil(left);
  if (seconds === lastSeconds && (!bar || !bar.hidden)) return;
  lastSeconds = seconds;
  const frac = timer.timeout ? left / timer.timeout : 0;
  paintRing(box, seconds, frac);
  paintRing(bar, seconds, frac);
  if (seconds <= 5 && urgency < 2) { urgency = 2; audio.play('timer_critical'); haptic(HAPTICS.targeted); }
  else if (seconds <= 10 && urgency < 1) { urgency = 1; audio.play('timer_warn'); }
  else if (seconds > 10) urgency = 0;
}

/* ── final approach + attrition strip (§3.10 / §3.11) ────────────────────
 *
 * The engine hands the client everything this needs: getPlayerView exposes
 * `armedIds`, per-player `finalApproach` / `finalApproachIn`
 * (= turnsUntilCheckpoint: activeCount − turnsSinceArming), and the
 * `deckCycle` / `deckCycleLimit` pair behind the §3.11 points ending. Nothing
 * here is derived or guessed.
 *
 * It lives inside #hud as a wrapped second row rather than as a floating layer:
 * a fixed overlay over a 390px table covers the opponent boards, which are
 * exactly what you are being told to attack.
 *
 * ── THE ROW IS RESERVED, NOT GROWN (P8, motion agent hand-off) ─────────────
 *
 * MEASURED before this change, mid-game fixture → final-approach fixture:
 *
 *   desktop 1280×720   #hud 55→93   #opponents y 62→100, h 147→118
 *   phone   390×844    #hud 54→96   #opponents y 59→101, h 209→132
 *   landscape 844×390  #hud 52→80   #opponents y 56→84,  h 217→190
 *
 * i.e. the whole felt jumped down 38/42/28px at the exact moment the player is
 * being told to read the table — and it happens FOUR times a game (arm, break,
 * arm, break). Worse, the box was unbounded: with three armed players and the
 * attrition chip the strip measured **589px tall on a 390px-wide phone** (hud
 * 651px — the header ate the entire screen).
 *
 * Two fixes, together:
 *   1. The strip is always in the layout and toggles `visibility` (`is-empty`),
 *      so the row's box exists from the first paint and nothing below it moves.
 *   2. Its height is FIXED (content.css `.hud-strip`) and its content is
 *      bounded: at most one named opponent plus a "+N" chip, and a two-line
 *      clamp on the sentence. The full sentence stays in `title`, and the strip
 *      is a control — tapping it opens the Goal page of the brief, which is the
 *      only explanation route a phone has (it cannot hover a title).
 */
let strip = null;
let stripKey = '';

function stripEl() {
  if (strip?.isConnected) return strip;
  // A DIV, not a button. It was a button (tap → the Goal page of the brief) for
  // exactly one touchtest run: at its reserved height it measured 379×12 …
  // 379×34, i.e. a control under §0.9's 44px floor on every surface, and
  // growing it to 44 would have doubled the permanent reserve this whole change
  // exists to minimise. The long sentence still has two phone-reachable routes:
  // ui/journal.js announces it full-length at the moment of arming, and the ?
  // button (a real 44px control) opens the brief's Goal page.
  strip = el('div', {
    id: 'hud-strip', class: 'hud-strip is-empty',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  $('hud')?.appendChild(strip);
  return strip;
}

/** Reserved-but-blank, never `hidden`: `display:none` is what made the felt jump. */
function stripBlank(box) {
  if (stripKey !== '') { stripKey = ''; clear(box); }
  setClass(box, 'is-empty', true);
  setAttr(box, 'title', null);
}

/* ── the countdown that is allowed to print a number (§P7.17) ──────────────
 *
 * `finalApproachIn` (= the old turnsUntilCheckpoint) is DEPRECATED and still
 * lies, in two measured ways against game.js:
 *
 *   • Armed on your own turn, 4 players: it printed 4, but only 3 opponent
 *     turns stand between you and the win. Off by one, always.
 *   • Armed on someone else's turn: one of your OWN turns falls inside the
 *     grace window and does not convert, so you need a second own turn. Worked
 *     example, 4 players, you seat 0, armed during seat 1's turn T: you take
 *     turns at T+3 (no win) and T+7 (win) — six opponent turns. The field read
 *     1 at T+3 and clamped to 0 at T+4, i.e. "wins the moment their turn
 *     begins" three whole turns early.
 *
 * The engine now publishes the honest one (P7 round-1 hardening, 65e36ef):
 * `opponentTurnsRemaining` — turns by OTHER players before the converting turn,
 * `null` unless armed, and `0` meaning the very next turn to start is theirs.
 * That is the ONLY number printed here. `finalApproachIn` is never read.
 */

/** @returns {number|null} turns other players get before this one converts. */
function opponentTurns(player) {
  const n = player?.opponentTurnsRemaining;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The engine's own "the next turn to start is theirs and it wins". */
function convertsNext(player) { return opponentTurns(player) === 0; }

function countdownText(player, mine) {
  const n = opponentTurns(player);
  if (n === 0) {
    return mine
      ? 'You win at the start of your next turn — unless you lose a set first.'
      : 'They win at the start of their next turn. This is your last turn to break them.';
  }
  if (n != null) {
    return mine
      ? `${n} more turn${n === 1 ? '' : 's'} of theirs to survive. Lose a set and it is off.`
      : `${n} turn${n === 1 ? '' : 's'} left to break them.`;
  }
  // No honest field on this snapshot (an older server, a hand-built fixture):
  // print the rule, never a number we cannot stand behind.
  return mine
    ? 'You convert at your own turn start, once every seat has had a turn. '
      + 'Lose a set and it is off.'
    : 'Converts at their own turn start, once every seat has had a turn.';
}

/**
 * The SHORT form, for the fixed-height row — ONE LINE at 390px.
 *
 * The long sentence is not lost: countdownText() puts it on the row's `title`
 * for a pointer, ui/journal.js announces it in full over the felt at the moment
 * of arming (which is where a phone actually reads it), and the brief's Goal
 * page has the rule. The reason it is this short is measured, twice:
 *   • unbounded, three armed players + attrition rendered a 589px strip on a
 *     390px phone;
 *   • at a two-line reserve, tools/touchtest.mjs measured `.self-board` 42px in
 *     landscape and 25px exposed bank cards in payment — the reserve was
 *     squeezing the whole table below §0.9's 44px floor.
 * Same numbers, same source (`opponentTurnsRemaining`), fewer words.
 */
function stripLine(player, mine) {
  const n = opponentTurns(player);
  if (mine) {
    if (n === 0) return 'You win at your next turn start';
    if (n != null) return `${n} opponent turn${n === 1 ? '' : 's'} to survive`;
    return 'Converts at your next own turn';
  }
  if (n === 0) return 'wins next turn — last chance';
  if (n != null) return `${n} turn${n === 1 ? '' : 's'} left to break them`;
  return 'converts at their own turn start';
}

/** @param {object|null} [view] the state the header is narrating — the strip
 *  is part of the narration and must describe the same table it does. */
function renderStrip(view) {
  const snap = view === undefined ? store.snapshot : view;
  const box = stripEl();
  if (!snap || snap.phase !== 'playing') { stripBlank(box); return; }

  const armed = (snap.players || []).filter(p => p.finalApproach && !p.eliminated);
  const mineArmed = armed.filter(p => p.id === store.self.id);
  const theirs = armed.filter(p => p.id !== store.self.id);
  const cycle = snap.deckCycle || 0;
  const limit = snap.deckCycleLimit || 0;
  // Half the allowance is the point where an attrition finish stops being
  // theoretical: healthy games spend 1.9 cycles (game.js DECK_CYCLE_LIMIT note).
  // The threshold lives in core/cards.js so ui/help.js can promise the same one.
  const attrition = limit > 0 && cycle >= deckCycleNotice(limit);

  if (!armed.length && !attrition) { stripBlank(box); return; }

  // The urgent one is the one with the fewest turns left. Only that one is
  // NAMED — three named opponents wrapped the row to 589px on a 390px phone.
  const urgency = (p) => { const n = opponentTurns(p); return n == null ? 99 : n; };
  const worst = theirs.slice().sort((a, b) => urgency(a) - urgency(b))[0] || null;

  // §3.10b — the fields getPlayerView ships for a contest (game.js:2419-2422):
  // `contested`, `contestLaps`, `contestBar`. contestBar is what a conversion
  // needs RIGHT NOW ("the HUD must never tell a player they need three when
  // they need four" — the engine's own comment), so it is the ONLY set count
  // this chip may print. No client surface read any of these before this.
  const contested = !!snap.contested;
  const bar = Number.isInteger(snap.contestBar) ? snap.contestBar : 0;
  const raised = contested && bar > (snap.setsToWin || 0);

  const stamp = (p) => `${p.id}:${opponentTurns(p)}`;
  const key = [
    mineArmed.map(stamp).join(','),
    theirs.map(stamp).join(','),
    attrition ? `${cycle}/${limit}` : '',
    contested ? `c${snap.contestLaps || 0}@${bar}` : '',
  ].join('|');
  if (key === stripKey) { setClass(box, 'is-empty', false); return; }
  stripKey = key;

  clear(box);
  setClass(box, 'is-empty', false);
  setClass(box, 'is-threat', theirs.length > 0);
  setClass(box, 'is-mine', theirs.length === 0 && mineArmed.length > 0);

  if (worst) {
    // Someone else can win. Name them, and say what to do about it.
    box.appendChild(el('span', { class: 'strip-flag', text: 'BREAK THEM NOW' }));
    box.appendChild(el('span', { class: 'strip-text' }, [
      el('b', { text: worst.name }),
      el('span', { text: ` ${stripLine(worst, false)}` }),
    ]));
    if (theirs.length > 1) {
      box.appendChild(el('span', {
        class: 'chip strip-chip',
        text: `+${theirs.length - 1} armed`,
        attrs: { title: theirs.slice(1).map(p => `${p.name}: ${countdownText(p, false)}`).join(' · ') },
      }));
    }
    if (mineArmed.length) {
      box.appendChild(el('span', {
        class: 'chip strip-chip',
        text: convertsNext(mineArmed[0]) ? 'You: win next turn' : 'You: armed',
        attrs: { title: countdownText(mineArmed[0], true) },
      }));
    }
    setAttr(box, 'title', `${worst.name} on final approach — ${countdownText(worst, false)}`);
  } else if (mineArmed.length) {
    box.appendChild(el('span', { class: 'strip-flag', text: 'FINAL APPROACH' }));
    // The caveat lives inside stripLine — repeating it here printed
    // "unless you lose a set first. Lose a set and it is off." (measured on the
    // final-approach phone shot).
    // No "HOLD THE LINE —" prefix: the flag chip beside it already says
    // FINAL APPROACH, and the words were costing a whole line at 390px.
    box.appendChild(el('span', { class: 'strip-text', text: stripLine(mineArmed[0], true) }));
    setAttr(box, 'title', countdownText(mineArmed[0], true));
  } else {
    setAttr(box, 'title', null);
  }

  if (contested) {
    // Reuses the strip's own chip classes; the mode's one-line rule rides the
    // title, worded by ui/ruleset.js SUDDEN_DEATH_COPY — the same sentence the
    // lobby and the help Goal page carry, so three surfaces cannot drift.
    const mode = snap.rules?.suddenDeath;
    const line = SUDDEN_DEATH_COPY[mode]?.line || 'Nobody converts while the approach is contested.';
    box.appendChild(el('span', {
      class: 'chip strip-chip is-hot',
      // Under 'escalate' the raised bar IS the news; under the other modes the
      // suspension is.
      text: raised ? `CONTESTED · ${bar} sets to convert` : 'CONTESTED · wins on hold',
      attrs: { title: line },
    }));
  }

  if (attrition) {
    box.appendChild(el('span', {
      class: `chip strip-chip${cycle >= limit - 2 ? ' is-hot' : ''}`,
      text: `DECK CYCLE ${cycle}/${limit}`,
      attrs: { title: 'At the limit the game ends on points: most sets, then net worth.' },
    }));
  }
}

/* §P7.12 — connection loss was an 8×8px dot whose only explanation lived in a
 * hover `title`, which a phone cannot produce. A word joins the dot. The node is
 * built here because public/index.html is architect-owned (§1). */
let connLabel = null;

function installConnLabel() {
  const dot = $('hud-conn');
  if (!dot || connLabel?.isConnected) return;
  connLabel = el('span', {
    class: 'conn-label',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  dot.parentElement?.insertBefore(connLabel, dot.nextSibling);
}

function renderConn() {
  // A client that is not TRYING to be connected is not disconnected — that is
  // every fixture-staged harness page, and it was painting a red dot and
  // "RECONNECTING…" across the whole screenshot review set.
  const lost = socket.wanted() && !store.connected;
  setClass($('hud-conn'), 'is-off', lost);
  setAttr($('hud-conn'), 'title', lost ? 'Reconnecting…' : 'Connected');
  installConnLabel();
  if (!connLabel) return;
  setText(connLabel, lost ? 'RECONNECTING…' : '');
  setClass(connLabel, 'is-on', lost);
}

/* ── the HUD does not lead the table (§P9 FEEL round 1) ────────────────────
 *
 * This used to render straight off the snapshot on STATE_APPLIED, and the
 * snapshot is the FUTURE: main.js applies it and only then hands the event tail
 * to the choreographer, so every word in the header was true several hundred
 * milliseconds before the felt showed it. Measured, twice, and both of them
 * spoilers:
 *
 *   DEAL  at t=100ms the header already read "YOUR TURN · 3 plays" and the dock
 *         read "HAND 7" — with the hand zone EMPTY and the first card still
 *         leaving the deck. The hand does not arrive until t≈1400ms
 *         (frames/deal/deal-006-t00100.jpg).
 *   WIN   the header wrote 'GAME OVER' 334ms before the gold flood on a lone
 *         win event, and ~870ms before it when the win was queued behind a
 *         turn_start. ui/overlays.js holds ITS reveal for the choreographer's
 *         win cue plus 850ms; the header simply gave the ending away first —
 *         and it gave it away in two neutral words that did not even say
 *         whether you had won.
 *
 * So the narration waits for the choreographer's word, exactly as the overlay
 * does. The rule is one line: if this payload carries events that are about to
 * be PERFORMED, paint nothing until they have been. Everything that is not
 * narration (the room code, the connection state, and the timer, which is on
 * its own clock) stays immediate.
 *
 * Three guards, all of them the difference between a delay and a hang:
 *   • a snapped state (reconnect, fixture, rematch join) has no performance
 *     coming and paints at once, which is also what keeps tools/screenshot.mjs
 *     and the harness's instant path reproducible;
 *   • FALLBACK_MS is re-armed by every CHOREO_EVENT, so it means "2.6s with no
 *     word from the choreographer", not "2.6s total" — a long steal caravan
 *     cannot trip it, a stalled queue always does;
 *   • the terminal hold is CELEBRATION_MS on top of idle, the same 850ms
 *     ui/overlays.js spends, so the header can only ever land WITH or AFTER the
 *     screen that is supposed to break the news.
 *
 * ── …AND IT MAY NOT NARRATE NOTHING EITHER (§P9 FEEL round 3) ─────────────
 *
 * The rule above was written against CHOREO_IDLE, and idle means "the queue is
 * EMPTY". A five-seat table of `chud` bots plays every 300–800ms, so on a real
 * fast table the queue is never empty and the header never got its word.
 * MEASURED, rAF-sampled, animation on, one broadcast every:
 *
 *            HUD names the wrong player   longest single stale run
 *   120ms              98.7%                       16,636ms
 *   250ms              98.1%                       31,857ms
 *   500ms              34.4%                        3,976ms
 *
 * — i.e. the fix for the spoiler had turned the header off. "Whose turn is it"
 * is the header's entire job, and 31 seconds of DEALING is a worse lie than a
 * 300ms spoiler.
 *
 * So the narration follows THE BEAT BEING SHOWN, which is a third thing,
 * neither the snapshot nor idle. Two sources, both of them published by the
 * choreographer and both of them statements about the felt rather than about
 * the server:
 *
 *   CHOREO_SETTLED(snapshot)  emitted right after table.reconcile(snapshot) —
 *                             the table has been MADE to equal that state, so
 *                             narrating it is describing what is on screen.
 *                             Bounds the header's lag at one job.
 *   CHOREO_EVENT turn_start   finer than a job: the turn pass is being
 *                             performed right now, so the name can change with
 *                             it instead of waiting for the job's last event.
 *
 * The ending keeps the old rule exactly — a `finished` view is not printed
 * while the queue is still running, so ui/overlays.js still breaks the news
 * first. Everything else is now allowed to keep up.
 */
const CELEBRATION_MS = 850;          // must match ui/overlays.js
const FALLBACK_MS = 2600;            // ditto — the promise that nothing is lost

// anim/choreographer.js publishes it; core/bus.js is architect-owned, so the
// same "string literal until the constant exists" pattern ui/peek.js uses.
const CHOREO_SETTLED = EVENTS.CHOREO_SETTLED || 'choreo:settled';

/* ── END TURN is sent once (P9 harness round 1) ────────────────────────────
 * MEASURED: a double-tap sent two `endTurn` frames on ~1 run in 6. The server
 * is authoritative so nothing was corrupted, but the reason the second tap
 * happened is the defect — between the tap and the broadcast that answers it
 * the button looked exactly as live as it had a moment earlier, and a control
 * that does not visibly take the press is a control a player presses again.
 *
 * Two halves, and the first one is the important one:
 *   • the button goes disabled SYNCHRONOUSLY inside the handler, so the press
 *     is acknowledged in the same task it arrived in (the same rule §P7.2 wrote
 *     for the card press);
 *   • a latch, because `disabled` lands on the next style resolution and a
 *     genuinely fast double-tap can beat it.
 * The latch is released by the TRUTH — the first snapshot that says the turn
 * has moved on — with a 1.2s ceiling so a dropped broadcast can never strand
 * the button. 1.2s is above the 900ms interact/drag.js already spends waiting
 * on the server before it gives up on a committed drop.
 */
const END_TURN_LOCK_MS = 1200;
let endTurnSent = false;
let endTurnTimer = 0;

function clearEndTurnLatch() {
  endTurnSent = false;
  clearTimeout(endTurnTimer);
  endTurnTimer = 0;
}

let holdTimer = 0;
let holding = false;
/** Has the narration been painted for the game that is currently on the table?
 *  False through the opening deal and again after an ending, which is what lets
 *  a rematch's deal show DEALING instead of the last game's result. */
let narrated = false;
/** The newest state the FELT has actually been reconciled to (CHOREO_SETTLED).
 *  This is what the header narrates while a performance is running — never
 *  store.snapshot, which is the future. */
let felt = null;
/** Whose turn the table is CURRENTLY showing. Set by every performed
 *  `turn_start` and by every settle, so it can run ahead of `felt` by the
 *  events inside the job that is playing — which is the point. */
let feltTurn;

function clearHold() { clearTimeout(holdTimer); holdTimer = 0; holding = false; }

function releaseHold(delay) {
  if (!holding) return;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => { clearHold(); renderNarration(); }, delay);
}

/** The ending, in words that say WHICH ending. 'GAME OVER' was identical
 *  whether you had taken it or been beaten to it, which is the one thing a
 *  result line must not be. Points and stalemate genuinely have no winner and
 *  keep the neutral form.
 *
 *  'MISSION COMPLETE', not the overlay's 'MISSION ACCOMPLISHED', for a measured
 *  reason: #hud-turn is a 160px box on a 390px phone and the long form needs
 *  188px (tools/screenshot.mjs caught it on win@phone). The short form measures
 *  149px in the same box. Same voice, same fact, and it does not pretend to be
 *  the headline — ui/overlays.js owns the headline, and it is on screen by the
 *  time this is painted. */
function endingLine(snap) {
  const winner = snap.winner;
  if (winner == null) return 'GAME OVER';
  return winner === store.self.id ? 'MISSION COMPLETE' : `${seatName(winner)} WINS`;
}

/** What the header says while it is waiting for a deal it has not seen yet.
 *  Only for the opening of a game: a mid-game hold keeps the last true line,
 *  because that line is still what is on the felt. */
function holdPlaceholder(snap) {
  if (snap.phase !== 'playing' || narrated) return;
  setText($('hud-turn'), 'DEALING');
  setClass($('hud-turn'), 'is-mine', false);
  setText($('hud-plays'), '');
  setText($('hand-count'), '0');
  // DEALING is nobody's turn on screen; the button appears with "YOUR TURN"
  // (renderNarration), never before it.
  setHidden($('btn-end-turn'), true);
}

/** The hand as of a GIVEN state — sel.myHand() only ever reads the live store,
 *  and the whole point of a settled view is that it is not the live store. */
function handOf(view) {
  const me = selfPlayer(view);
  return Array.isArray(me?.hand) ? me.hand : [];
}

/**
 * The state the header is describing.
 *
 * Not holding → the store, which is also what is on the felt (the queue is
 * empty or this payload had nothing to perform). Holding → the newest settled
 * state, i.e. the last thing the table was actually made to show. Holding with
 * nothing settled yet is only ever the opening deal, and DEALING is true.
 */
function narrationView() {
  return holding ? felt : store.snapshot;
}

function renderNarration() {
  const live = store.snapshot;
  if (!live) return;
  const snap = narrationView();
  if (!snap) { holdPlaceholder(live); return; }
  // The ending stays gated on the whole performance plus CELEBRATION_MS: the
  // overlay owns the news and the header must not scoop it (see the header
  // note). Everything else is narrated as soon as it is on the felt.
  if (snap.phase === 'finished' && holding) return;
  // `feltTurn` is the finer of the two: a turn_start inside the job that is
  // playing has already been performed, so the name may move before the job's
  // reconcile catches the rest of the state up.
  const turnId = holding && feltTurn !== undefined ? feltTurn : snap.currentPlayerId;
  const mine = turnId != null && turnId === store.self.id && snap.phase === 'playing';
  const turnName = snap.phase === 'finished'
    ? endingLine(snap)
    : (mine ? 'YOUR TURN' : `${seatName(turnId)}'s turn`);
  setText($('hud-turn'), turnName);
  setClass($('hud-turn'), 'is-mine', mine && snap.phase !== 'finished');
  // The counters describe the SETTLED state, so they may only be printed when
  // the turn they belong to is the turn being named. A turn_start performed
  // ahead of its job's reconcile has no play count yet, and inventing one is
  // how the header started narrating the future in the first place.
  const counted = turnId === snap.currentPlayerId;
  const hand = handOf(snap);
  setText($('hud-plays'),
    mine && counted && snap.turnPhase === 'play'
      ? `${snap.playsRemaining} play${snap.playsRemaining === 1 ? '' : 's'}` : '');
  setText($('hand-count'), String(hand.length));
  setClass($('hand-dock'), 'over-limit', hand.length > (snap.handLimit || 7));

  // #btn-draw is suppressed by ui/prompt.js — the draw is automatic now, so
  // there is no draw affordance anywhere (§P7.9). Nothing here touches it.
  // The controls ride with the narration on purpose: End Turn coming live while
  // your hand is still in the air is the same lie as the counter that says you
  // are holding it. Both actions re-check the store when they fire, so a late
  // disable can never let an illegal one through.
  //
  // OWNER, 2026-08-07: "hide end turn on screen unless it is actually your turn
  // — better player feedback if the button disappears." GONE, not greyed: the
  // dock reflows (flex row), which is the feedback. `mine` is the NARRATED
  // turn, so the button appears on the same beat as "YOUR TURN" rather than a
  // broadcast early. It stays through your own discard step (End Turn is what
  // entered that mode and confirm-discard is how it leaves) because the turn is
  // still yours; a response window on someone else's turn hides it, because the
  // turn is not. If the turn ends while the button holds keyboard focus, the
  // focus dies with the hidden control — parked back on the dock's next
  // control so Tab does not restart from <body> (§0.9).
  const endBtn = $('btn-end-turn');
  if (endBtn && endBtn.hidden !== !mine) {
    if (!mine && document.activeElement === endBtn) $('btn-emote')?.focus();
    setHidden(endBtn, !mine);
  }
  setAttr(endBtn, 'disabled',
    !mine || !counted || snap.turnPhase !== 'play' || endTurnSent ? true : null);
  setAttr($('btn-scoop'), 'disabled', snap.phase !== 'playing' ? true : null);
  setClass($('table'), 'surge-on', !!snap.surgeOps);
  renderStrip(snap);
  narrated = snap.phase === 'playing';
}

function render(payload) {
  const snap = store.snapshot;
  setText($('hud-room'), store.room.code || '');
  renderConn();
  if (!snap) return;

  // The latch is cleared by the snapshot, not by the narration: the moment the
  // server says the turn has moved on the button is free again, even though the
  // header is still waiting for the choreographer to catch up.
  if (endTurnSent && !(isMyTurn() && snap.turnPhase === 'play')) clearEndTurnLatch();

  const performing = !!payload
    && !payload.snap
    && (payload.events?.length || 0) > 0
    && !choreographer.isInstant();

  if (!performing) { clearHold(); felt = snap; feltTurn = snap.currentPlayerId; renderNarration(); return; }

  holding = true;
  // Not a blank: the last SETTLED state is still what is on the felt, so keep
  // narrating it. holdPlaceholder only takes over when there is no settled
  // state at all, which is the opening deal and nothing else.
  renderNarration();
  releaseHold(FALLBACK_MS);
}

/** The settings entry point. public/index.html is architect-owned (§1) and P6
 *  adds exactly one control, so the node is built here instead. */
function installSettingsButton() {
  const right = qs('.hud-right');
  if (!right || qs('[data-action="settings"]', right)) return;
  const gear = el('button', {
    class: 'btn btn-icon',
    text: '⚙',
    attrs: { type: 'button', 'aria-label': 'Sound and settings' },
    dataset: { action: 'settings' },
  });
  right.insertBefore(gear, right.lastElementChild);
}

export function mount() {
  installSettingsButton();
  installConnLabel();
  pointer.registerActions({
    // The engine draws at turn start (65e36ef) and accepts `draw` as a silent
    // no-op. Kept registered so a stray [data-action="draw"] anywhere — an old
    // fixture, a tool — cannot fall through to nothing.
    draw: () => { if (sel.canDraw()) send.draw(); },
    'end-turn': () => {
      const snap = store.snapshot;
      if (!snap || !isMyTurn()) { toast('Not your turn'); return; }
      const excess = sel.myHand().length - (snap.handLimit || 7);
      if (excess > 0) { interact.beginDiscard(excess); return; }
      if (endTurnSent) return;
      endTurnSent = true;
      clearTimeout(endTurnTimer);
      endTurnTimer = setTimeout(clearEndTurnLatch, END_TURN_LOCK_MS);
      // The tap is answered in the same task it arrived in. This is the whole
      // point: the round trip is not the bug, the SILENCE during it is, and a
      // control that still looks live is an invitation to hit it again.
      setAttr($('btn-end-turn'), 'disabled', true);
      send.endTurn();
    },
    scoop: () => {
      openSheet('Scoop out?', el('div', { class: 'sheet-confirm' }, [
        el('p', { text: 'Scooping discards everything you own and takes you out of the game. There is no undo.' }),
        el('button', { class: 'btn btn-danger', text: 'Scoop out', attrs: { 'data-action': 'confirm-scoop' } }),
        el('button', { class: 'btn btn-ghost', text: 'Stay in', attrs: { 'data-action': 'close-sheet' } }),
      ]));
    },
    'confirm-scoop': () => { send.scoop(); closeSheet(); },
    'toggle-side': () => {
      const side = $('side');
      if (side) setHidden(side, !side.hidden);
    },
    emote: () => {
      const list = el('div', { class: 'emote-grid' });
      for (const text of ['GG', 'Nice', 'Oof', 'Wow', 'Hurry!', 'CHUD!', 'o7', 'Sorry']) {
        list.appendChild(el('button', {
          class: 'btn', text,
          attrs: { 'data-action': 'send-emote', 'data-text': text },
        }));
      }
      openSheet('Emote', list);
    },
    'send-emote': (elx) => { send.emote(elx.dataset.text); closeSheet(); },
  });

  // §0.9 — Escape closes the comms drawer. `toggle-side` above only ever
  // flipped `hidden` from its two buttons, so #side was the one closable layer
  // with no Escape path at all (sheets: ui/screens.js:171; drag and the
  // interaction modes: interact/pointer.js:197 → abortDrag()/escape(); the
  // expanded seat: table/layout.js:209). Same priority discipline as those
  // handlers, so one press never answers two questions — every keydown listener
  // here runs on the same event, and each guard below names the layer that owns
  // the key instead:
  //   • an open sheet stacks over the drawer and screens.js closes it;
  //   • a live drag keeps the key for pointer.js's abortDrag();
  //   • an active interaction mode (strip/target/payment/discard) keeps it for
  //     escape() → interact.cancel(), and the targeting/payment glow guard is
  //     the same one table/layout.js uses for the expanded seat.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const side = $('side');
    if (!side || side.hidden) return;
    // BOTH sheet guards, because listener order decides which one fires:
    // screens.js's handler preventDefaults when it closes a sheet, and if it
    // ran first on this same event then sheetOpen() is already false here —
    // measured: one Escape closed the sheet AND the drawer under it. If this
    // handler runs first instead, sheetOpen() is still true and stands us down.
    if (e.defaultPrevented) return;
    if (sheetOpen()) return;
    if (document.querySelector('.card.is-dragging')) return;
    if (interact.mode.kind !== 'idle') return;
    if (document.querySelector('[data-targetable="1"], [data-payable="1"]')) return;
    setHidden(side, true);
  });

  bus.on(EVENTS.STATE_APPLIED, render);
  // The choreographer's word (§P9). CHOREO_EVENT re-arms the deadline, and a
  // performed `turn_start` moves the name with the beat that is being shown.
  bus.on(EVENTS.CHOREO_EVENT, (ev) => {
    releaseHold(FALLBACK_MS);
    if (ev?.t === 'turn_start' && ev.actor !== undefined && holding) {
      feltTurn = ev.actor;
      renderNarration();
    }
  });
  // The felt has been reconciled to this state — see the header. This is what
  // keeps the header alive on a table that never goes idle.
  bus.on(CHOREO_SETTLED, (snapshot) => {
    if (!snapshot) return;
    felt = snapshot;
    feltTurn = snapshot.currentPlayerId;
    if (holding) renderNarration();
  });
  bus.on(EVENTS.CHOREO_IDLE, () => {
    felt = store.snapshot;
    feltTurn = store.snapshot?.currentPlayerId;
    releaseHold(store.snapshot?.phase === 'finished' ? CELEBRATION_MS : 0);
  });
  bus.on(EVENTS.STATE_SCREEN, () => {
    clearHold();
    narrated = false;
    felt = null;
    feltTurn = undefined;
  });
  bus.on(EVENTS.NET_OPEN, renderConn);
  bus.on(EVENTS.NET_CLOSE, renderConn);
  subscribe(tickTimer);
}
