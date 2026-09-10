// fx/haptics.js — §7's haptic vocabulary and the two rules that keep it from
// becoming noise.
//
//   RULE 1 (§7, verbatim): never more than one pattern per event. Enforced
//   structurally — fx/index.js calls haptic() at most once per cue.
//
//   RULE 2: a 300ms floor between vibrations. A 5-card payment is five card
//   landings inside 350ms; without the floor that is five motor spin-ups the
//   phone renders as one long ugly rattle, and the actuator on an iPhone
//   ignores the tail anyway.
//
//   RULE 3 (P7 round 1, and the reason this file was rewritten): the floor is
//   PRIORITY-AWARE. It used to be a flat 300ms first-one-wins gate, and the
//   measured consequence was that the vocabulary collapsed to a single pattern:
//
//     live 150s 4-player game, 16 haptics fired, ALL of them `land` (10ms).
//     Zero targeted, zero setComplete, zero finalApproach — across 7 set
//     completions and 3 steals.
//
//   The mechanism: choreographer.stepFor('play_property') is 240ms, under the
//   300ms floor, so completing a set by playing its third property always
//   arrived behind the 10ms tick of that property landing, and lost. An earned
//   pattern being eaten by a cheap one is the floor working exactly backwards.
//
//   So: a HIGHER-priority pattern beats the floor and replaces whatever is
//   still playing (navigator.vibrate() replaces, it does not queue). An
//   equal-or-lower one is still dropped. The floor is then re-armed from the
//   winner, so the win pattern cannot be interrupted by a card landing.
//
// Under ?harness=1 nothing vibrates: harness.js installs a recorder and every
// pattern that PASSES the floor is appended to __CHUD.hapticLog, so the log is
// what a player would actually have felt rather than what fx tried to send.

const FLOOR_MS = 300;

let recorder = null;
let lastAt = -1e9;
let lastPri = 0;
let sent = 0;

export function setRecorder(fn) { recorder = fn; }
export function count() { return sent; }

/**
 * @param {number|number[]|string} pattern ms, an on/off/on… array, or a
 *        HAPTICS key ('setComplete'). A key carries its own priority.
 * @param {number} [priority] 0..4; overrides the key's own.
 * @returns {boolean} true if it went out (or was recorded)
 */
export function haptic(pattern, priority) {
  let p = pattern;
  let pri = priority;
  if (typeof p === 'string') {
    if (pri == null) pri = PRIORITY[p] || 0;
    p = HAPTICS[p];
  }
  if (p == null) return false;
  if (pri == null) pri = priorityOf(p);

  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - lastAt < FLOOR_MS && pri <= lastPri) return false;
  lastAt = now;
  lastPri = pri;
  sent++;
  if (recorder) { recorder(p); return true; }
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  try { navigator.vibrate(p); } catch { /* Safari, iOS: no vibrate API */ }
  return true;
}

/**
 * §7's four required patterns plus the two the P5 brief adds. Durations are ms.
 *
 *   land          10   — a tick, not a buzz. Your card touching the felt.
 *   targeted   30/40/30 — two knocks: something is being done TO you.
 *   setComplete 20/30/20 — the same shape, shorter and tighter, so "good thing"
 *                          and "bad thing" are distinguishable through a pocket.
 *   finalApproach 3×60 spaced 90 — an alarm. Only ever fires when the armed
 *                          player is somebody else, i.e. against you.
 *   win        40/60/40/60/200 — a roll into a long resolve.
 *   denied        12   — the shortest thing the actuator can render.
 *   pickup         6   — P9: the press. Below `denied` on purpose — a press is
 *                        an acknowledgement that the card heard you, not an
 *                        answer to anything, and it is the most frequent event
 *                        in the game (~200/session). Priority 0, so the 300ms
 *                        floor drops it behind absolutely everything.
 */
export const HAPTICS = Object.freeze({
  pickup: 6,
  land: 10,
  targeted: [30, 40, 30],
  setComplete: [20, 30, 20],
  finalApproach: [60, 90, 60, 90, 60],
  win: [40, 60, 40, 60, 200],
  denied: 12,
});

/**
 * What may interrupt what. The ladder is "how much of the game this beat is
 * worth", not "how loud": a set completing outranks the card that completed it,
 * and nothing outranks the win.
 */
export const PRIORITY = Object.freeze({
  pickup: 0,
  land: 0,
  denied: 1,
  targeted: 2,
  setComplete: 3,
  finalApproach: 4,
  win: 5,
});

/** Identity lookup for the call sites that still pass HAPTICS.x directly. */
function priorityOf(p) {
  for (const k in HAPTICS) if (HAPTICS[k] === p) return PRIORITY[k] || 0;
  return 0;
}

export function reset() { lastAt = -1e9; lastPri = 0; sent = 0; }
