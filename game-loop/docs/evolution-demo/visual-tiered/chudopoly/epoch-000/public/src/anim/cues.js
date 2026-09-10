// anim/cues.js — the FX cue bus. The ONE channel P5 (audio/, fx/) subscribes to.
//
// Why a second channel next to CHOREO_SFX: CHOREO_SFX carries the engine event
// (`{name:'payment', ev, mine}`) — one message for a five-card caravan, with no
// screen position. Sound and confetti need the opposite grain: one cue per card
// that actually lands, at the pixel where it landed, flagged for weight. So the
// choreographer emits SFX per EVENT and this file emits cues per PHYSICAL BEAT.
//
// Payload: { kind, mine, big, at:{x,y} }
//   kind — one of CUE below, and nothing else. Subscribers switch on it.
//   mine — it happened to or for the viewing player (§7: yours is louder/centred).
//   big  — this beat carries drama (a steal, a completed set, a win, or a card
//          that crossed more than a third of the screen). Not "loud" — the audio
//          agent decides what big means for its bus.
//   at   — viewport px, the centre of the thing that moved. fx/ anchors sparks,
//          floating text and shake epicentres on it.
//
// Cues fire under prefers-reduced-motion too: motion collapses, the game does
// not go silent (§0.9).

import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';

export const CUE = Object.freeze({
  // table motion (anim/)
  FLIGHT_START: 'card_flight_start',
  LANDED: 'card_landed',
  // A flight that began and will never land: the card was superseded in the air
  // (stolen while landing, re-flown by a reconcile, picked up by a finger). It
  // exists so that every FLIGHT_START has exactly one answer — measured at 173
  // slides against 159 snaps per game before it did.
  FLIGHT_ABORT: 'card_flight_abort',
  FLIP: 'card_flip',
  DEAL_DONE: 'deal_done',
  SHUFFLE: 'shuffle',
  SET_COMPLETED: 'set_completed',
  STEAL_LANDED: 'steal_landed',
  OPSEC_CLASH: 'opsec_clash',
  ACTION_BLOCKED: 'action_blocked',
  PAYMENT_DONE: 'payment_done',
  TURN_START: 'turn_start',
  FINAL_APPROACH: 'final_approach',      // §3.10 armed — the game's peak, big
  APPROACH_BROKEN: 'approach_broken',
  WIN: 'win',
  STALEMATE: 'stalemate',
  // interaction (interact/ emits these itself, same payload shape)
  PICKUP: 'card_pickup',
  DENIED: 'denied',
  DETAILS: 'card_details',
  // The mode machine ACCEPTED a targeting answer (Play armed a step, a pick
  // consumed one). §P10 FEEL: tapping Play and tapping a marked victim board
  // changed the mode with ZERO sfx/haptic until the broadcast returned — the
  // one interaction family whose acknowledgement was silence. Audio maps it to
  // the existing ui_tick (engine.js SFX_FOR_CUE, rate-limited there); fx/ gives
  // it the 6ms pickup pattern and nothing else.
  TARGET_STEP: 'target_step',
});

/**
 * One cue. Two small allocations per BEAT — never per frame.
 * `dx`/`dy` (optional) is the TRAVEL VECTOR of the thing that just moved, in
 * viewport px. A landing without it can only spray debris in a full circle,
 * which reads as sparkle; with it, fx/ can throw the impact the way the card
 * was going. Absent/zero = no direction known (reduced motion, a cue with no
 * card behind it) and the omnidirectional form is correct.
 */
export function cue(kind, mine, big, x, y, dx, dy) {
  bus.emit(EVENTS.FX_CUE, {
    kind,
    mine: !!mine,
    big: !!big,
    at: { x: Math.round(x) || 0, y: Math.round(y) || 0 },
    dx: dx || 0,
    dy: dy || 0,
  });
}

/** Cue anchored on an element's centre. Costs one layout read — beats only. */
export function cueEl(kind, mine, big, el) {
  if (!el) { cue(kind, mine, big, 0, 0); return; }
  const r = el.getBoundingClientRect();
  cue(kind, mine, big, r.left + r.width / 2, r.top + r.height / 2);
}
