// fx/index.js — the cue → effect map, and the four-call public interface.
//
// ── TWO INPUT CHANNELS, AND WHY ───────────────────────────────────────────
//
// anim/cues.js (FX_CUE) is the WHERE and WHEN: one message per physical beat,
// carrying viewport coordinates. It cannot carry direction — the choreographer
// flags a steal `mine` when EITHER the thief or the victim is you, because
// audio only needs to know "this concerns me".
//
// bus CHOREO_EVENT is the WHO and HOW MUCH: the engine event itself, with
// `from`/`to`/`total`/`action`. It is emitted by choreographer.runJobAsync
// IMMEDIATELY after applyEvent, in the SAME synchronous task as the cue, so a
// cue that needs direction can be held for exactly one event without ever
// crossing a frame boundary (`beat` below). If the event never arrives — an
// interact/-emitted cue, a cue the engine has no event for — `beat` expires on
// the next clock tick and the neutral form of the effect plays.
//
// Being red-shifted for the victim rather than for everyone is the whole point
// of the exercise: a table where every steal flashes red teaches the player
// nothing, and a table where only the ones aimed at them do is a table they can
// read out of the corner of their eye.
//
// ── RESTRAINT (the rule the tuning table below obeys) ─────────────────────
//
// Most beats get nothing. `card_landed` fires 40+ times a turn across a
// 5-player table; sparking on all of them makes the felt glitter permanently
// and destroys the signal value of the beats that matter. So: your card landing
// sparks, everyone else's does not. Opponents' turns are QUIET, and the game's
// three loud moments (a steal against you, the final approach, the win) stay
// loud because nothing else has spent the attention.
//
// ── THE TUNING TABLE ──────────────────────────────────────────────────────
// Sizes are CSS px, speeds px/s, lives ms, ring radii "from→to" px. Flash is a
// peak opacity on the screen-blend plate. Trauma decays at 1.5/s and displaces
// by trauma² × 15px (fx/shake.js) — so .30 is 1.4px and .60 is 5.4px.
//
// P7 round 1 changed the trauma column. Six of the ten shake triggers were
// under fx/shake.js's 0.1px write quantisation — set_completed was 0.22px for
// 80ms, steal-not-victim and approach_broken 0.10px for 53ms — i.e. dead code
// that still held a transform on #table. shake.add() now refuses anything below
// 0.141 trauma (0.30px) outright, and the beats that deserve to be felt were
// raised past it rather than deleted. Displacement is trauma² × 15px.
//
//  cue               condition       particles                              flash       trauma  haptic
//  ───────────────── ─────────────── ────────────────────────────────────── ─────────── ─────── ───────────
//  card_flight_start —               —                                      —           0       —
//  card_flight_abort —               — (logged only; every slide resolves)  —           0       —
//  card_landed       yours           5–7 dots ø7 in a 2.0rad fan along       —          .16     land 10ms
//                                    travel + contact ring 3→19 steel                   .24 big
//  card_landed       anyone else's   contact ring 3→15 steel α.22, 130ms    —           0       —
//  card_flip         yours + big     2 glints ø20, 380ms                    —           0       —
//  deal_done         —               —                                      —           0       —
//  shuffle           —               5 grey puffs 12→40, α.18               —           0       —
//  set_completed     any             flare ø74 + ring 14→78 gold lw4.2      gold .26*   .30*    setComplete*
//                                    440ms + 9 glints ø28, 620ms
//  steal_landed      you stole       ring 12→52 steel lw3.0 320ms + 6 dots  —           .20     —
//  steal_landed      neither of you  same, no shake                         —           0       —
//  steal_landed      AGAINST YOU     flare ø62 + ring 10→86 red lw5.5       red .30     .30     targeted
//                                    460ms + 12 red dots ø9.5, 250px/s
//  steal_landed      …by a CHUD      + 4 more dots, "CHUD!" float           red .38     .45     targeted
//  opsec_clash       involving you   4-arm spark cross 5/arm white ø8.5     steel .16   .30     targeted
//                                    360px/s + flare ø54; "OPSEC!" float
//  opsec_clash       others'         same cross, 3/arm at α.5, no flare     —           0       —
//  action_blocked    involving you   6 grey puffs 14→46, α.34, 550ms        —           .22     —
//  denied            —               2 red dots ø6.5, 220ms                 —           0       denied 12ms
//  payment_done      ≥4 cards        10 gold chips ø9 along the caravan     —           0       —
//  payment_done      you paid/were paid  float −NM red / +NM gold           —           0       —
//  turn_start        —               —                                      —           0       —
//  final_approach    any             ring 24→62% of the viewport diagonal   amber .22   .34     —
//                                    lw4.4, 800ms
//  final_approach    AGAINST YOU     + 6 amber glints ø32                   amber .26   .34     3×60ms
//  approach_broken   any             DOUBLE SNAP: ring 14→42% white lw5.0   steel .20   .28     —
//                                    420ms + ring 10→22% steel 280ms +
//                                    a 4-arm spark cross. Was a 3.0px steel
//                                    ring at α.8 that read as a grey hairline
//                                    against the arming's gold sweep.
//  win               yours           380 confetti 3.2s + a 130-piece second gold .30    .60     win
//                                    fall at +1.5s (the peak must not freeze)
//  win               someone else's  150 confetti, 2.6s                     gold .12    .26     —
//  stalemate         any             42 grey settle puffs, 1.0–1.8s         steel .14   0       —
//  card_pickup       yours           —                                      —           0       pickup 6ms
//  card_details      —               —                                      —           0       —
//
//  * set_completed's flash/trauma/haptic are yours only. Somebody else
//    completing a set gets the ring and the glints and nothing that touches
//    your hands or your screen.
//
// Everything in the "particles" column was doubled or tripled from a first pass
// that looked correct in the source and was invisible in the capture: a 3.4px
// additive dot and a 2.5px single-stroke ring do not exist against navy felt
// with SVG grain on it. The three fixes were plateau cores instead of gaussian
// ones, a two-stroke ring (band + filament), and a stationary flare at the
// epicentre of the two beats that have to be located precisely.
//
// ── §0.9 REDUCED MOTION ───────────────────────────────────────────────────
// Particles and shake are skipped entirely; the flash stays (softened to 55%
// and stretched 1.6×, which is an opacity-only cue) and floating text stays
// without the rise. Every cue is still logged, so the harness sees the same
// sequence either way.

import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { subscribe, unsubscribe } from '../core/clock.js';
import { prefersReducedMotion } from '../core/dom.js';
import { CUE } from '../anim/cues.js';
import * as choreographer from '../anim/choreographer.js';
import * as table from '../table/index.js';
import { store } from '../state/store.js';

import * as overlay from './overlay.js';
import * as P from './particles.js';
import { COL, KIND } from './particles.js';
import * as B from './bursts.js';
import * as shakeSys from './shake.js';
import * as floaters from './floaters.js';
import * as hap from './haptics.js';

/* ── reduced motion ─────────────────────────────────────────────────────── */

let reduced = prefersReducedMotion();
shakeSys.setReduced(reduced);
floaters.setReduced(reduced);
if (typeof matchMedia === 'function') {
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  const onChange = () => {
    reduced = mq.matches;
    shakeSys.setReduced(reduced);
    floaters.setReduced(reduced);
    if (reduced) P.clear();
  };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

/* ── harness cue log (§9) ───────────────────────────────────────────────── */

const CUE_LOG_CAP = 800;
export const cueLog = [];

function logCue(kind, mine, big, x, y) {
  cueLog.push({ kind, mine: !!mine, big: !!big, x, y, t: Math.round(performance.now()) });
  if (cueLog.length > CUE_LOG_CAP) cueLog.shift();
  // harness.js (§9, architect-owned) does not know about fx's log yet. Adopting
  // `fxLog` into the bridge alongside sfxLog/hapticLog is a P3 request in the
  // agent report; until then fx attaches it itself, test-only and idempotent.
  const bridge = typeof window !== 'undefined' ? window.__CHUD : null;
  if (bridge && !bridge.fxLog) bridge.fxLog = cueLog;
}

/* ── the clock pump ─────────────────────────────────────────────────────── */

let pumping = false;
let painted = false;

function busy() {
  return P.count() > 0 || painted || shakeSys.active()
    || shakeSys.flashActive() || floaters.active();
}

// setActive is OUTSIDE the `pumping` guard on purpose. It used to be inside,
// and the bug that produced was invisible effects: reset() hides the overlay
// without dropping the clock subscription, so the next spawn found pumping ===
// true, returned early, and painted a full chip caravan into a display:none
// canvas. Showing the overlay is idempotent and costs a class-list compare.
function pump() {
  overlay.ensure();
  overlay.setActive(true);
  if (pumping) return;
  pumping = true;
  subscribe(tick);
}

function tick(dt) {
  if (beat.live) expireBeat();

  const g = overlay.ctx();
  const live = P.count() > 0;
  if (g && (live || painted)) {
    overlay.clear();
    P.update(dt);
    P.draw(g);
    painted = P.count() > 0;
  }
  shakeSys.tick(dt);
  shakeSys.tickFlash(dt);
  floaters.tick(dt);

  if (!busy()) {
    pumping = false;
    unsubscribe(tick);
    overlay.setActive(false);
  }
}

/* ── public interface (unchanged signatures — call sites live outside fx/) ─ */

/**
 * Celebration burst at a screen point.
 * @param {number} x @param {number} y
 * @param {{count?:number, color?:number, kind?:number, confetti?:boolean,
 *          speed?:number, life?:number, size?:number}} [opts]
 */
export function burst(x, y, opts = null) {
  if (reduced) return;
  const o = opts || EMPTY;
  overlay.ensure();
  if (o.confetti) B.confetti(overlay.width(), overlay.height(), o.count || 300, o);
  else if (o.kind === KIND.GLINT) B.glints(x, y, o.count || 8, o.color == null ? COL.GOLD : o.color, o);
  else if (o.kind === KIND.PUFF) B.puff(x, y, o.count || 6, o.color == null ? COL.GRAY : o.color, o);
  else B.sparks(x, y, o.count || 6, o.color == null ? COL.WHITE : o.color, o);
  pump();
}
const EMPTY = Object.freeze({});

/**
 * Screen flash. `el` is a focus hint only — the gradient centres on it; the
 * plate is always full-viewport (fx/shake.js explains the screen blend).
 * @param {Element|{x:number,y:number}|null} el
 * @param {'gold'|'red'|'steel'|'amber'} [tone]
 * @param {number} [strength] peak opacity
 * @param {number} [dur] seconds
 */
export function flash(el, tone = 'gold', strength = 0.16, dur = 0.45) {
  overlay.ensure();
  shakeSys.flash(strength, tone, dur, focusOf(el));
  pump();
}

const _focus = { x: 0, y: 0 };
function focusOf(el) {
  if (!el) return null;
  if (typeof el.x === 'number') { _focus.x = el.x; _focus.y = el.y; return _focus; }
  if (typeof el.getBoundingClientRect !== 'function') return null;
  const r = el.getBoundingClientRect();
  _focus.x = r.left + r.width / 2;
  _focus.y = r.top + r.height / 2;
  return _focus;
}

/** Camera-style shake of the table root. @param {number} strength trauma 0..1 */
export function shake(strength) {
  if (!(strength > 0) || reduced) return;
  shakeSys.add(strength);
  pump();
}

/** Floating "+5M" style text at a point. */
export function floatText(text, x, y, tone = 'steel', scale = 1) {
  if (!text) return;
  overlay.ensure();
  floaters.spawn(text, x, y, tone, scale);
  pump();
}

export function setHapticRecorder(fn) { hap.setRecorder(fn); }
export const haptic = hap.haptic;
export const HAPTICS = hap.HAPTICS;

/** Test/driver affordance: what is actually live right now. */
export function stats() {
  return {
    particles: P.count(), peak: P.peakCount(), cap: P.CAP,
    floats: floaters.count(), trauma: shakeSys.level(),
    flash: shakeSys.flashActive(), cues: cueLog.length, haptics: hap.count(),
  };
}

export function reset() {
  clearTimeout(secondFall);
  secondFall = 0;
  P.clear();
  P.resetJitter();
  floaters.reset();
  shakeSys.reset();
  hap.reset();
  painted = false;
  beat.live = false;
  chudArmed = false;
  if (pumping) { pumping = false; unsubscribe(tick); }
  overlay.clear();
  overlay.setActive(false);
}

/* ── the second fall ────────────────────────────────────────────────────── */

let secondFall = 0;

/** A lighter confetti wave 1.5s after the win, so the celebration overlaps the
 *  overlay's own entrance instead of ending under it. Cleared by reset() — a
 *  rematch started inside the window must not rain on the new deal. */
function armSecondFall() {
  clearTimeout(secondFall);
  secondFall = setTimeout(() => {
    secondFall = 0;
    if (reduced) return;
    overlay.ensure();
    B.confetti(overlay.width(), overlay.height(), 130, { life: 2.9 });
    pump();
  }, 1500);
}

/* ── the held beat ──────────────────────────────────────────────────────── */

const beat = { live: false, kind: '', x: 0, y: 0, mine: false, big: false };

// A CHUD was played and its theft has not resolved yet (see onEvent).
let chudArmed = false;

function hold(kind, mine, big, x, y) {
  beat.live = true; beat.kind = kind; beat.x = x; beat.y = y;
  beat.mine = !!mine; beat.big = !!big;
}

/** No event claimed the beat — play the neutral form and move on. */
function expireBeat() {
  const kind = beat.kind;
  beat.live = false;
  if (kind === CUE.STEAL_LANDED) stealFx(beat.x, beat.y, false, false);
}

/* ── geometry ───────────────────────────────────────────────────────────── */

const _pt = { x: 0, y: 0 };
function centreOf(el) {
  if (!el) { _pt.x = overlay.width() / 2; _pt.y = overlay.height() / 2; return _pt; }
  const r = el.getBoundingClientRect();
  _pt.x = r.left + r.width / 2;
  _pt.y = r.top + r.height / 2;
  return _pt;
}

function diag() {
  const w = overlay.width(), h = overlay.height();
  return Math.sqrt(w * w + h * h);
}

/* ── the effects ────────────────────────────────────────────────────────── */

const _at = { x: 0, y: 0 };
function at(x, y) { _at.x = x; _at.y = y; return _at; }

function stealFx(x, y, victim, chud, thief) {
  if (!reduced) {
    if (victim) {
      // Harder than the neutral ring in all three dimensions a ring has:
      // 4px of stroke instead of 2.4, 86px of travel instead of 52, and 340ms
      // instead of 260 — it arrives slower and stays longer, which is what
      // makes it read as "this one was aimed at you" and not as more sparkle.
      B.flare(x, y, 62, COL.RED, 0.3);
      B.ring(x, y, 10, 86, COL.RED, 0.46, 5.5, 1);
      B.sparks(x, y, chud ? 16 : 12, COL.RED, { speed: 250, life: 0.44, size: 9.5, grav: 300 });
    } else {
      B.ring(x, y, 12, 52, COL.STEEL, 0.32, 3.0, 0.85);
      B.sparks(x, y, 6, COL.STEEL, { speed: 170, life: 0.32, size: 8 });
    }
  }
  if (victim) {
    flash(at(x, y), 'red', chud ? 0.38 : 0.30, 0.5);
    shake(chud ? 0.45 : 0.30);
    hap.haptic('targeted');
  } else if (thief) {
    // Taking something is a beat too — 0.20 = 0.60px. The old 0.08 (0.10px for
    // 53ms) was below fx/shake's perceptual floor and is now refused there, so
    // it was dead code that still ran the clock.
    shake(0.20);
  }
  // A theft between two other players gets the ring and the sparks and nothing
  // that touches your screen. §7's restraint rule.
  pump();
}

/**
 * CONTACT (P7 round 1). A landing used to be 5 white dots at 150px/s thrown
 * into a FULL CIRCLE (bursts.sparks defaults `spread` to TAU) with no ring, no
 * trauma and no squash. Measured timing was already right — the first spark was
 * ≤16.7ms behind card_snap — so the beat was not late, it was empty: a circular
 * scatter of dots reads as sparkle, and sparkle is what a card does when it
 * twinkles, not when it hits a table.
 *
 * Three things were added and each one does a different job:
 *   • the spray is DIRECTIONAL, a 2.0rad fan thrown along the travel vector
 *     (anim/cues carries it now) — dust pushed ahead of the card, so the eye
 *     reads which way the card came from even after it has stopped;
 *   • a small hard ring, 3→19px in 180ms — the only element that reads as a
 *     surface being struck rather than as material leaving;
 *   • trauma, on YOUR landings only, above fx/shake's 0.141 perceptual floor.
 * The squash lives in anim/flight.js (easeOutBack on scale), where the card is.
 */
const LAND_CEILING = 0.34;     // see CUE.LANDED — caravans must not stack to the cap

function landFx(x, y, dx, dy, big) {
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > 12) {
    B.sparks(x, y, big ? 7 : 5, COL.WHITE, {
      speed: big ? 210 : 165, life: 0.30, size: 7, grav: 380,
      dir: Math.atan2(dy, dx), spread: 2.0,
    });
  } else {
    B.sparks(x, y, 5, COL.WHITE, { speed: 150, life: 0.30, size: 7 });
  }
  B.ring(x, y, 3, big ? 26 : 19, COL.STEEL, 0.18, big ? 2.4 : 1.8, big ? 0.5 : 0.36);
}

function onCue(payload) {
  if (!payload) return;
  const { kind, mine, big } = payload;
  const x = payload.at ? payload.at.x : 0;
  const y = payload.at ? payload.at.y : 0;
  logCue(kind, mine, big, x, y);

  // The harness bridge sets choreographer instant mode: the table is being
  // PLACED from a fixture, not performed. Particles then depend on when the
  // tool happened to call applyState, which makes tools/screenshot.mjs
  // non-reproducible. Cues and haptics are still logged — only the pixels stop.
  if (choreographer.isInstant()) {
    // Recording is not vibrating. The instant path exists to stop PARTICLES
    // depending on when a tool called applyState; the haptic log is exactly the
    // thing a tool is trying to read, so every pattern still goes through the
    // same map the performed path uses. (It used to forward only win /
    // setComplete / land, which made `denied` and `targeted` unassertable by
    // any tool — a UI-agent repro: FX_CUE {kind:'denied'} under ?harness=1
    // recorded nothing, the same cue with setInstant(false) recorded 12ms.)
    const pattern = HAPTIC_FOR_CUE[kind];
    if (pattern && (mine || ALWAYS_HAPTIC[kind])) hap.haptic(pattern);
    return;
  }

  // THE PRESS (§P9 FEEL round 1). The most-performed interaction in the game —
  // ~200 pointerdowns per session — was the only one that reached the actuator
  // with nothing at all: a real-touch CDP press produced an EMPTY hapticLog.
  // 6ms is the shortest thing an actuator renders and deliberately below
  // `denied` (12ms), because a press is an acknowledgement, not an answer; at
  // priority 0 it can never displace a landing, a theft or the win, and
  // haptics.js's 300ms floor is what keeps a fast tapper from a rattle.
  // No particles and no trauma: the finger is already on the card.
  if (kind === CUE.PICKUP) { if (mine) hap.haptic('pickup'); return; }

  // A targeting answer the machine ACCEPTED (§P10 FEEL): same acknowledgement
  // contract as the press — the lightest pattern, priority 0, no particles.
  // The audible half is engine.js's ui_tick off the same cue.
  if (kind === CUE.TARGET_STEP) { if (mine) hap.haptic('pickup'); return; }

  // Guard BEFORE the overlay is built: the cues fx deliberately ignores are the
  // frequent ones (flight_start, deal_done, turn_start, details, and every card
  // landing that is not yours), and a game that only ever fires those must
  // never allocate a canvas backing store. §0.8's idle-cost rule.
  if (!EFFECTFUL[kind]) return;

  if (beat.live) expireBeat();
  overlay.ensure();

  switch (kind) {
    case CUE.LANDED:
      if (!mine) {
        // Everyone else's landings used to be NOTHING — on a 4-player table
        // that is ~90% of the 159 landings in a game rendered audio-only, so
        // the felt never acknowledged three quarters of the game. One thin
        // 130ms contact ring is the whole budget: it is present at the corner
        // of the eye and it does not compete with your own cards, which keep
        // the spray, the trauma and the tick.
        if (!reduced) B.ring(x, y, 3, 15, COL.STEEL, 0.13, 1.4, 0.22);
        break;
      }
      if (!reduced) landFx(x, y, payload.dx || 0, payload.dy || 0, big);
      // 0.16 → 0.38px, 0.24 → 0.86px (fx/shake: trauma² × 15). Above the 0.141
      // floor, below the point where reading the felt gets hard: a card you
      // played arriving is a thump you feel, not an earthquake.
      //
      // CEILING, not a raw add. Landings come in caravans — a 5-card payment
      // into your bank is five of them inside 350ms and trauma only decays at
      // 1.5/s, so five unconditional adds reach shake.js's 0.75 cap (8.4px) and
      // a routine payment shakes the table harder than the win (0.60). Above
      // LAND_CEILING a landing adds nothing, which puts a whole caravan at
      // ~0.50 (3.7px) and leaves the cap for the beats that earned it.
      if (shakeSys.level() < LAND_CEILING) shake(big ? 0.24 : 0.16);
      hap.haptic('land');
      break;

    case CUE.FLIP:
      if (!mine || !big || reduced) return;
      B.glints(x, y, 2, COL.GOLD_HI, { size: 20, life: 0.38, radius: 10 });
      break;

    case CUE.SHUFFLE:
      if (reduced) return;
      B.puff(x, y, 5, COL.GRAY, { size0: 12, size1: 40, alpha: 0.18, life: 0.55 });
      break;

    case CUE.SET_COMPLETED:
      if (!reduced) {
        B.flare(x, y, 74, COL.GOLD_HI, 0.34);
        B.ring(x, y, 14, 78, COL.GOLD, 0.44, 4.2, 1);
        B.glints(x, y, 9, COL.GOLD_HI, { size: 28, life: 0.62, radius: 30, rise: 26 });
      }
      if (mine) {
        flash(at(x, y), 'gold', 0.26, 0.55);
        shake(0.30);                       // was 0.12 = 0.22px for 80ms: invisible
        hap.haptic('setComplete');
      }
      break;

    case CUE.STEAL_LANDED:
      // Direction unknowable from the cue — see the two-channel note above.
      hold(kind, mine, big, x, y);
      return;

    case CUE.OPSEC_CLASH:
      // Two fans at right angles: metal met metal and neither gave way.
      if (!reduced) {
        B.sparkCross(x, y, mine ? 5 : 3, COL.WHITE, { speed: mine ? 360 : 260, size: 8.5, alpha: mine ? 1 : 0.5 });
        if (mine) B.flare(x, y, 54, COL.STEEL, 0.24);
      }
      if (mine) {
        flash(at(x, y), 'steel', 0.16, 0.34);
        shake(0.30);                       // was 0.14 = 0.29px
        hap.haptic('targeted');
      }
      break;

    case CUE.ACTION_BLOCKED:
      if (!reduced) B.puff(x, y, 6, COL.GRAY, { size0: 14, size1: 46, alpha: 0.34, life: 0.55 });
      // Was 0.10 = 0.15px, with a comment claiming it existed so four in a row
      // would be felt. Trauma decays at 1.5/s; four blocked actions never land
      // inside the same 400ms, so the stack it was budgeted for cannot happen.
      // An OPSEC chain resolving against you is a beat — 0.22 = 0.73px.
      if (mine) shake(0.22);
      break;

    case CUE.DENIED:
      if (!reduced) B.sparks(x, y, 2, COL.RED, { speed: 70, life: 0.22, size: 6.5, grav: 200 });
      hap.haptic('denied');
      break;

    case CUE.PAYMENT_DONE:
      hold(kind, mine, big, x, y);
      return;

    case CUE.FINAL_APPROACH: {
      // ONE sweep. §3.10's arming is a state, not an event you can loop on —
      // the ongoing tension belongs to the board treatment and to audio. A
      // particle loop here would still be running when the player has to make
      // the decision it is warning them about.
      if (!reduced) {
        B.ring(x, y, 24, diag() * 0.62, COL.GOLD, 0.8, 4.4, 0.95);
        if (!mine) B.glints(x, y, 6, COL.GOLD, { size: 32, life: 0.7, radius: 34, rise: 10 });
      }
      flash(at(x, y), 'amber', mine ? 0.22 : 0.26, 0.9);
      shake(0.34);                         // was 0.15 = 0.34px, on the game's peak
      if (!mine) hap.haptic('finalApproach');
      break;
    }

    case CUE.APPROACH_BROKEN:
      // §P9 FEEL round 3. MEASURED against the arming it answers: arming throws
      // a gold ring 4.4px wide across 62% of the diagonal at α.8; the BREAK
      // threw a 3.0px steel one across 34% at α.55, and on the capture it was a
      // faint 1px grey hairline — the single most relieving beat in the game
      // rendered as less than a card landing.
      //
      // It is not made louder by copying the arming. It is made DIFFERENT: the
      // arming is one slow sweep outward (a siren), the break is a hard double
      // snap — a fast bright shock, a second ring chasing it, and a spark cross
      // at the epicentre, all over in 420ms. A thing being broken is short.
      if (!reduced) {
        // ring(x, y, r0, r1, col, LIFE, lineW, alpha) — life is the 6th arg.
        B.ring(x, y, 14, diag() * 0.42, COL.WHITE, 0.42, 5.0, 0.85);
        B.ring(x, y, 10, diag() * 0.22, COL.STEEL, 0.28, 3.2, 0.70);
        B.sparkCross(x, y, 4, COL.STEEL, { speed: 320, size: 8, alpha: 0.9 });
      }
      flash(at(x, y), 'steel', 0.20, 0.30);
      shake(0.28);                         // was 0.08 = 0.10px for 53ms: nothing
      break;

    case CUE.WIN:
      if (!reduced) B.confetti(overlay.width(), overlay.height(), mine ? 380 : 150, { life: mine ? 3.2 : 2.6 });
      flash(null, 'gold', mine ? 0.30 : 0.12, mine ? 0.8 : 0.6);
      shake(mine ? 0.60 : 0.26);           // others' was 0.12 = 0.22px
      if (mine) hap.haptic('win');
      // THE PEAK MUST NOT FREEZE (§P9 FEEL round 3). MEASURED: the overlay
      // arrived, ~2.1s of confetti ran out, and then the screen was
      // BYTE-IDENTICAL for 1.8s — the stillest the game ever gets is the
      // moment it is trying to be loudest. motion.css deals the result rows in
      // for the first ~1.3s; this is the second half, a sparser fall that
      // starts as the first one thins and runs to ~4.4s. Sparser on purpose:
      // a repeat of the same 380 reads as a bug, a lighter fall reads as the
      // last of it coming down.
      if (mine && !reduced) armSecondFall();
      break;

    case CUE.STALEMATE:
      if (!reduced) B.settle(overlay.width(), overlay.height(), 42);
      // §0.9 kept the flash everywhere else and forgot it here, so the one
      // ending that is not a win had NO visual at all under reduced motion —
      // the game simply stopped. A steel wash is opacity-only and legal.
      flash(null, 'steel', 0.14, 0.9);
      break;

    default:
      return;
  }
  pump();
}

/**
 * The cues that can produce something. Everything absent from this map is
 * deliberately silent: flight_start (audio's beat), deal_done, turn_start (the
 * HUD already says whose it is), card_pickup and card_details (the finger under
 * the card is the feedback).
 */
/**
 * Cue → haptic, for the instant path only. The performed path keeps its
 * patterns inline in the switch above, where the rest of each effect lives; this
 * is the same table flattened so a harness run records what a player would have
 * felt. `denied` is in ALWAYS_HAPTIC because it is only ever emitted at the
 * player who was refused, and final_approach because §7's alarm fires when the
 * armed player is somebody ELSE.
 */
const HAPTIC_FOR_CUE = Object.freeze({
  [CUE.PICKUP]: 'pickup',
  [CUE.TARGET_STEP]: 'pickup',
  [CUE.LANDED]: 'land',
  [CUE.DENIED]: 'denied',
  [CUE.SET_COMPLETED]: 'setComplete',
  [CUE.OPSEC_CLASH]: 'targeted',
  [CUE.STEAL_LANDED]: 'targeted',
  [CUE.FINAL_APPROACH]: 'finalApproach',
  [CUE.WIN]: 'win',
});
const ALWAYS_HAPTIC = Object.freeze({ [CUE.DENIED]: 1, [CUE.FINAL_APPROACH]: 1 });

const EFFECTFUL = Object.freeze({
  [CUE.LANDED]: 1, [CUE.FLIP]: 1, [CUE.SHUFFLE]: 1, [CUE.SET_COMPLETED]: 1,
  [CUE.STEAL_LANDED]: 1, [CUE.OPSEC_CLASH]: 1, [CUE.ACTION_BLOCKED]: 1,
  [CUE.DENIED]: 1, [CUE.PAYMENT_DONE]: 1, [CUE.FINAL_APPROACH]: 1,
  [CUE.APPROACH_BROKEN]: 1, [CUE.WIN]: 1, [CUE.STALEMATE]: 1,
});

/* ── the event layer: who, and how much ─────────────────────────────────── */

function onEvent(ev) {
  if (!ev || choreographer.isInstant()) return;
  const self = store.self.id;

  switch (ev.t) {
    case 'steal':
    case 'set_stolen': {
      if (!claim(CUE.STEAL_LANDED)) break;
      const bx = beat.x, by = beat.y;
      const chud = ev.action === 'chud' || chudArmed;
      stealFx(bx, by, ev.from === self, chud, ev.actor === self);
      // "CHUD!" belongs at the CRIME. It used to be floated on `play_action`,
      // over the ACTOR's board, ~1.2s before the theft and — measured on a
      // 4-player 1280×720 table — a full board's width away from the card
      // actually being taken. The beat coordinate is the stolen card itself
      // (choreographer.crimeEl), so the label now lands on it.
      if (chud) floatText('CHUD!', bx, by - 18, 'red', 1.35);
      chudArmed = false;
      break;
    }

    case 'swap': {
      if (!claim(CUE.STEAL_LANDED)) break;
      stealFx(beat.x, beat.y, ev.target === self, false, ev.actor === self);
      break;
    }

    case 'payment': {
      if (!claim(CUE.PAYMENT_DONE)) break;
      const total = ev.total || 0;
      const from = centreOf(table.boardEl(ev.from));
      const fx0 = from.x, fy0 = from.y;
      const to = centreOf(table.boardEl(ev.to));
      // Chips only on the caravans that hurt (the cue's `big` = ≥4 cards).
      if (beat.big && !reduced) B.chipTrail(fx0, fy0, to.x, to.y, 10, COL.GOLD);
      if (total > 0) {
        if (ev.from === self) floatText(`-${total}M`, fx0, fy0, 'red');
        else if (ev.to === self) floatText(`+${total}M`, to.x, to.y, 'gold');
      }
      pump();
      break;
    }

    // No cue exists for play_action (the card is already on the discard pile by
    // the time the engine says who it was aimed at), so the CHUD label is armed
    // here and fired on the `steal` that follows, at the card being taken. If
    // the steal never comes — OPSEC blocked it — the arming expires below and
    // nothing is claimed, which is correct: nothing was stolen.
    case 'play_action':
      if (ev.action === 'chud') chudArmed = true;
      break;

    case 'action_blocked':
      chudArmed = false;
      break;

    // The engine now says how many sets that player holds AFTER this one
    // (set_completed.total, P7 round 1). Three is not one more than two — it is
    // the arming of §3.10's final approach, and the very next event is usually
    // `final_approach`. So the third gets a second ring on top of the cue's own
    // and, if it is yours, the gold goes up a stop. Nothing is added for a
    // first or second set: the escalation only means something if the earlier
    // ones did not already spend it.
    case 'set_completed': {
      if (!(ev.total >= 3)) break;
      const spot = centreOf(table.boardEl(ev.actor));
      if (!reduced) B.ring(spot.x, spot.y, 30, diag() * 0.34, COL.GOLD, 0.6, 3.4, 0.7);
      if (ev.actor === self) { flash(at(spot.x, spot.y), 'gold', 0.22, 0.7); shake(0.24); }
      pump();
      break;
    }

    case 'opsec': {
      chudArmed = false;
      const spot = centreOf(table.zoneFor('discard'));
      floatText('OPSEC!', spot.x, spot.y, 'steel', 1.35);
      break;
    }

    default:
      break;
  }
}

/** Consume the held beat if it is the one this event produced. */
function claim(kind) {
  if (!beat.live || beat.kind !== kind) return false;
  beat.live = false;
  return true;
}

/* ── wiring ─────────────────────────────────────────────────────────────── */
// Module scope, not a mount() call: nothing in the client calls fx.mount(), and
// a cue that arrives before a mount would be a silent hole. Subscribing costs
// two array pushes; the DOM and the canvas are still built lazily on the first
// effect, so the idle cost of importing fx/ is those two pushes.

bus.on(EVENTS.FX_CUE, onCue);
bus.on(EVENTS.CHOREO_EVENT, onEvent);

export { CUE, COL, KIND };
