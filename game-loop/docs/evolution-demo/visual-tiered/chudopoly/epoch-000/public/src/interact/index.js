// interact/index.js — the interaction state machine.
//
// One mode at a time, and the mode is data, not DOM state: ui/ renders from it
// and the table marks eligible things from it. §5's rule that targeting happens
// ON THE TABLE (not in a modal) is why picking a target is a `needs` queue
// consumed by taps on boards/columns/cards instead of a dialog per action.
//
// P3 ships tap. The drag path (P4, interaction agent) should push into the same
// machine: begin(card) → needs → dispatch, so nothing else has to change.

import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { el, setAttr, setClass, qsa, prefersReducedMotion } from '../core/dom.js';
import * as send from '../net/send.js';
import { store, selfPlayer, playerById } from '../state/store.js';
import * as sel from '../state/selectors.js';
import * as table from '../table/index.js';
import { getNode } from '../table/cardnode.js';
import {
  isPropertyCard, COLOR_KEYS, COLORS, colorName, setSize,
  legalColorsFor as coreLegalColors,
} from '../core/cards.js';
import * as pointer from './pointer.js';
import * as drag from './drag.js';
import { CUE, cueEl } from '../anim/cues.js';

export const mode = {
  kind: 'idle',            // idle | strip | target | payment | discard | details
  cardId: null,
  card: null,
  intent: null,            // 'property' | 'action' | 'move'
  needs: [],
  picks: {},
  selected: new Set(),
  amount: 0,
  excess: 0,
  hint: '',
};

const HINTS = {
  player: 'Tap a player board to choose your target',
  theirCard: 'Tap the property you want',
  theirSet: 'Tap the complete set to seize',
  myCard: 'Tap one of your properties to offer',
  mySet: 'Tap one of your complete sets',
  myColor: 'Tap the set column to place it on',
  // Names the COST, because this step is where a swap is consented to and a
  // player who meant "add this here" has to be able to recognise that it is not
  // what they are about to get. 48 characters — beginMove()'s own hint is 82 and
  // ui/prompt.js's 64px bar measurement is taken against that one.
  swapCard: 'Tap the card to TRADE places with — both move',
};

function changed() {
  applyMarks();
  bus.emit(EVENTS.INTERACT_CHANGED, mode);
}

/* ── refusal (§5 "invalid targets shake their head", §P7.3) ────────────────
 *
 * Before this existed, the ONLY refusal the client could express was
 * `<button disabled title="…">`: a measured full game produced 0 `denied`
 * sounds because CUE.DENIED fired from exactly one place (a failed drag-drop).
 * Every "no" now goes through here, so a refusal is a shake + the sour cue +
 * the haptic + the sentence, wherever it was asked for.
 *
 * @param {string} reason  the sentence — never empty, never a bare "invalid"
 * @param {Element|null} el  what to shake; the card node when nothing better
 */
export function refuse(reason, el) {
  const node = el || (mode.cardId != null ? getNode(mode.cardId) : null);
  shakeHead(node);
  cueEl(CUE.DENIED, true, false, node);
  if (reason) bus.emit(EVENTS.TOAST, reason);
}

/** One class, self-cleaning. Re-triggering mid-shake restarts it (a second
 *  refusal must be visible, not swallowed by the running animation). */
export function shakeHead(el) {
  if (!el) return;
  el.classList.remove('is-refused');
  void el.offsetWidth;                       // one forced reflow per refusal beat
  el.classList.add('is-refused');
  clearTimeout(el.__refuseTimer);
  el.__refuseTimer = setTimeout(() => el.classList.remove('is-refused'), 420);
}

export function reset() {
  mode.kind = 'idle';
  mode.cardId = null;
  mode.card = null;
  mode.intent = null;
  mode.needs = [];
  mode.picks = {};
  mode.selected = new Set();
  mode.amount = 0;
  mode.excess = 0;
  mode.hint = '';
  changed();
}

export function cancel() {
  if (mode.kind === 'payment' || mode.kind === 'discard') {
    mode.selected = new Set();
    changed();
    return;
  }
  reset();
}

/* ── entering modes ────────────────────────────────────────────────────── */

export function selectHandCard(cardId) {
  if (mode.kind === 'discard') { toggleSelected(cardId); return; }
  const card = sel.handCard(cardId);
  if (!card) return;
  if (mode.kind === 'strip' && mode.cardId === cardId) { reset(); return; }
  mode.kind = 'strip';
  mode.cardId = cardId;
  mode.card = card;
  mode.needs = [];
  mode.picks = {};
  mode.hint = '';
  changed();
}

/** "Play" on the action strip. Collects what the engine needs, then fires. */
export function playSelected() {
  const card = mode.card;
  if (!card) return;
  const reason = sel.blockedReason(card);
  if (reason) { refuse(reason); return; }

  if (isPropertyCard(card)) {
    mode.intent = 'property';
    if (card.type === 'property') return dispatch();
    const colors = sel.placementColors(card);
    if (colors.length === 1) { mode.picks.targetColor = colors[0]; return dispatch(); }
    mode.needs = ['myColor'];
  } else if (card.type === 'action' || card.type === 'rent') {
    mode.intent = 'action';
    const needs = sel.requirementsFor(card);
    if (!needs) { refuse('That card cannot be played now'); return; }
    // The same rule the property branch above has always had, applied to the
    // other card that asks the same question: never prompt for a decision with
    // one answer. MEASURED on the mid-game fixture — a Fighters/Mobility rent
    // card against a board holding only Mobility armed a myColor step with
    // exactly ONE marked mat and the prompt "Tap the set column to place it
    // on", so the player paid a tap and a sentence for a choice that did not
    // exist. The commitment already happened when they pressed Play; a wild
    // rent still stops for its `player` step, which is a real choice.
    if (card.type === 'rent' && needs[0] === 'myColor') {
      const colors = sel.rentColors(card);
      if (colors.length === 1) { mode.picks.targetColor = colors[0]; needs.shift(); }
    }
    mode.needs = needs;
  } else {
    refuse('Money cards are banked, not played');
    return;
  }

  if (mode.needs.length === 0) return dispatch();
  mode.kind = 'target';
  mode.hint = HINTS[mode.needs[0]] || 'Choose a target';
  changed();
  // §P10 FEEL: Play was ACCEPTED and targeting armed, and the only feedback
  // was the marks appearing — zero sfx/haptic until the broadcast returned.
  // The press cue never covers this tap (press() fires on CARDS, not on the
  // strip's buttons). ui_tick + the 6ms pattern, rate-limited in engine.js
  // and by haptics.js's floor.
  cueEl(CUE.TARGET_STEP, true, false, getNode(mode.cardId));
}

export function bankSelected() {
  const card = mode.card;
  if (!card) return;
  if (isPropertyCard(card)) { refuse('Properties cannot be banked'); return; }
  if (!sel.canPlay()) { refuse(sel.cannotPlayReason()); return; }
  const index = sel.handIndexOf(card.id);
  if (index < 0) return;
  send.playMoney(index);
  reset();
}

/**
 * Free rearrange — begins from a card already on my board.
 * §3.8 for a wild; §3.1b for an Upgrade/FOC, which game.js moveProperty()
 * (1543-1548) routes to moveUpgrade() off the same `move_property` command and
 * which likewise costs no play.
 */
export function beginMove(cardId) {
  const found = sel.boardMoveTarget(cardId);
  if (!found) return;
  // canRearrange(), NOT canPlay(): §3.8's rearrange costs no play and game.js
  // moveProperty() never looks at `playsRemaining`. Gating it on canPlay() made
  // every wild on the board dead for the rest of any turn whose three plays
  // were spent — see the note over canRearrange() in state/selectors.js.
  if (!sel.canRearrange()) { refuse(sel.cannotRearrangeReason(), getNode(cardId)); return; }
  const targets = offeredColors(found);
  if (!targets.length) {
    // A wild whose only destinations are TRADES it cannot afford gets the
    // budget's sentence, not "every other set is full" — the second is a claim
    // about the board and it would be false.
    if (!found.isUpgrade && found.swap.length && !sel.canSwap()) {
      refuse(sel.cannotSwapReason(), getNode(cardId));
      return;
    }
    refuse(found.isUpgrade
      ? 'Nowhere legal to move it — you need a second complete set that has room for it'
      : 'Nowhere legal to move it — every other set is full', getNode(cardId));
    return;
  }
  mode.kind = 'target';
  mode.intent = 'move';
  mode.cardId = cardId;
  mode.card = found.card;
  mode.needs = ['myColor'];
  mode.picks = {};
  mode.hint = found.isUpgrade
    ? 'Tap the complete set to move it onto'
    : `Tap the set column to move it to${leavingCost(found)}${swapOffer(found)}`;
  changed();
}

/* ── §3.5's atomic swap, carried by the gesture that already exists ─────────
 *
 * A full mat used to be a dead end: markIllegal() painted it refused and
 * dropRefusal() said "Command already holds a full set (2)". That is exactly the
 * mat a swap is for, so a full mat holding a card this wild can trade places
 * with becomes a LIVE TARGET instead — the same mat, the same tap, the same
 * drop, one more meaning. No new mode (ART §3.2), no confirmation sheet, no
 * "swap mode" toggle to discover: the offer appears on the surface the player
 * is already aiming at, and only while it is real.
 *
 * The mats are still the only colour picker in the game, so the choice of
 * DESTINATION is made exactly as it always was. The choice of PARTNER is a
 * second `needs` step — and only when there is a second answer. One partner is
 * dispatched without asking, which is this file's own standing rule for a
 * one-answer choice (see playSelected's note on the single-colour rent).
 */
function offeredColors(found) {
  if (!found) return [];
  if (!found.swap.length || !sel.canSwap()) return found.colors;
  return found.targets;
}

/**
 * The clause that announces the move exists, at the moment it does — §3.5's
 * discoverability requirement, paid for in eleven words rather than a tutorial.
 *
 * It is a clause and not a sentence deliberately: this string lands in the
 * prompt bar (ui/prompt.js `mode.hint`), and that file carries a measurement —
 * a two-clause sentence on a 390×844 phone wraps to three lines and makes the
 * bar 109px tall. So the WHAT lives here, once, and the WHICH MATS lives on the
 * mats themselves as the TRADE chit, where it costs no height at all.
 */
function swapOffer(found) {
  if (found.isUpgrade || !found.swap.length || !sel.canSwap()) return '';
  return '. A full set TRADES cards';
}

/**
 * The one fact a rearrange cannot print on a mat (§3.8, §3.9).
 *
 * Every legal destination gets its own chit, but the COLUMN THE CARD LEAVES is
 * not a target — moveColors() excludes it — so it carries no chit and cannot.
 * That is fine for the ranking (the loss is the same whichever destination you
 * pick, so it cannot reorder them) and it is not fine for the player, because
 * one of these losses is not like the others: pulling a wild out of a COMPLETE
 * set un-completes it, which costs a third of the win condition and re-opens
 * the zone to Midnight Requisition and TDY Orders (core/cards.js
 * requisitionable()). Any other departure just walks the source down its own
 * rent ladder, which is visible on the mat's tally.
 * So the sentence is spent only on the case that is worth a sentence.
 */
function leavingCost(found) {
  if (found.isUpgrade || !found.from) return '';
  if (!sel.myCompleteSets().includes(found.from)) return '';
  return ` — that breaks your ${colorName(found.from)} set`;
}

export function beginPayment(amount) {
  mode.kind = 'payment';
  mode.amount = amount || sel.owedAmount();
  mode.selected = new Set();
  mode.hint = `Select at least ${mode.amount}M to pay`;
  changed();
}

/* ── the end-of-turn discard (§P8, owner: "make it obviously easy") ─────────
 *
 * Before: beginDiscard set a mode, hand cards toggled, a Confirm button
 * appeared. Nothing said how many had to go, nothing said how many were chosen,
 * the confirm looked identical whether it would work or refuse, and there was
 * no default — every discard was N taps of arithmetic at the end of a turn.
 *
 * Now: the count is stated and live (ui/prompt.js), the confirm carries its own
 * refusal (§P7.3 — never `disabled`, always a sentence + shake + cue), the
 * chosen cards read as LEAVING rather than merely picked (`is-discarding`), and
 * one tap fills a sensible default the player can then adjust.
 */
export function beginDiscard(excess) {
  mode.kind = 'discard';
  mode.excess = excess;
  mode.selected = new Set();
  mode.hint = `Discard ${excess} card${excess === 1 ? '' : 's'} to reach the hand limit`;
  changed();
}

/**
 * "Discard my cheapest N" — the one-tap default.
 *
 * Face value ascending is the obvious rule and it is wrong on its own: the
 * `any` wild is 0M and is the single most valuable card in the deck, so a pure
 * value sort would offer it up first every time. So cards split into two bands
 * and the PROTECTED band is only touched when the unprotected one runs out:
 *   protected — properties and wilds (they are how you win) and OPSEC (it is
 *               the only card that answers an attack on someone else's turn)
 *   the rest  — money, rent, every other action: cheapest first
 * Within a band, ties break toward the card with the least reach (a rent card
 * for colours you do not own goes before one you can charge with).
 * It is a SUGGESTION: it fills the selection, and every card stays toggleable.
 */
export function suggestDiscard() {
  if (mode.kind !== 'discard') return;
  const protectedCard = (c) =>
    isPropertyCard(c) || (c.type === 'action' && c.action === 'opsec');
  const reach = (c) => (c.type === 'rent' ? sel.rentColors(c).length : 1);
  const ranked = sel.myHand().slice().sort((a, b) =>
    (protectedCard(a) ? 1 : 0) - (protectedCard(b) ? 1 : 0)
    || (a.value || 0) - (b.value || 0)
    || reach(a) - reach(b)
    || a.id - b.id);
  mode.selected = new Set(ranked.slice(0, mode.excess).map(c => c.id));
  changed();
}

/** The sentence the confirm refuses with, or '' when it will go through. */
export function discardBlockedReason() {
  const need = mode.excess;
  const have = mode.selected.size;
  if (have === need) return '';
  if (have < need) {
    const short = need - have;
    return `Choose ${short} more card${short === 1 ? '' : 's'} — ${have} of ${need} picked.`;
  }
  const over = have - need;
  return `That is ${over} too many — the engine takes exactly ${need}. Tap ${over} back.`;
}

/* ── selection ─────────────────────────────────────────────────────────── */

export function toggleSelected(cardId) {
  if (mode.selected.has(cardId)) mode.selected.delete(cardId);
  else mode.selected.add(cardId);
  changed();
}

/** "I cannot cover this" — the engine's only legal short payment is everything. */
export function selectAllPayable() {
  mode.selected = new Set(sel.payableCards().map(c => c.id));
  changed();
}

export function payableTotal() {
  let total = 0;
  for (const card of sel.payableCards()) total += card.value || 0;
  return total;
}

export function selectedTotal() {
  const me = selfPlayer();
  if (!me) return 0;
  let total = 0;
  for (const card of sel.payableCards(me)) if (mode.selected.has(card.id)) total += card.value || 0;
  return total;
}

export function confirmPayment() {
  if (mode.kind !== 'payment') return;
  const ids = [...mode.selected];
  const payable = sel.payableCards();
  const bar = document.getElementById('prompt');
  if (!ids.length && payable.length) {
    refuse('Tap your bank, property and Upgrade cards to choose what to hand over', bar);
    return;
  }
  if (selectedTotal() < mode.amount && ids.length < payable.length) {
    refuse(`${selectedTotal()}M is short of ${mode.amount}M — add cards, or surrender everything`, bar);
    return;
  }
  send.respond('accept', ids);
  reset();
}

export function confirmDiscard() {
  if (mode.kind !== 'discard') return;
  const why = discardBlockedReason();
  if (why) {
    // §P7.3: the button is never `disabled`, so the refusal can shake, sound
    // and say what is wrong instead of being a dead control.
    refuse(why, document.querySelector('[data-action="confirm-discard"]')
      || document.getElementById('prompt'));
    return;
  }
  send.endTurn([...mode.selected]);
  reset();
}

/* ── targeting ─────────────────────────────────────────────────────────── */

function advance() {
  mode.needs.shift();
  if (mode.needs.length === 0) return dispatch();
  mode.hint = HINTS[mode.needs[0]] || 'Choose a target';
  changed();
}

function dispatch() {
  const index = sel.handIndexOf(mode.cardId);
  if (mode.intent === 'move') {
    // Two commands, one intent. `withCardId` is set only by the swapCard step
    // (or by pick() skipping it when there was one answer), so the choice of
    // command is a fact about what the player answered, never a guess.
    if (mode.picks.withCardId != null) send.swapProperty(mode.cardId, mode.picks.withCardId);
    else send.moveProperty(mode.cardId, mode.picks.targetColor);
  } else if (index < 0) {
    refuse('That card left your hand before the play landed');
  } else if (mode.intent === 'property') {
    send.playProperty(index, mode.picks.targetColor);
  } else if (mode.intent === 'action') {
    send.playAction(index, mode.picks);
  }
  reset();
}

/**
 * Answer the current `needs` step with a value. The ONE place a pick is
 * recorded — a tap on the table, a drop on the table and (P4) a keyboard
 * activation all arrive here, so there is no second path to the server.
 * @returns {boolean} true when the step was consumed
 */
export function pick(step, value) {
  if (mode.kind !== 'target' || mode.needs[0] !== step) return false;
  switch (step) {
    case 'player':
      if (!value) return false;
      mode.picks.targetId = value;
      break;
    case 'myColor':
    case 'mySet':
    case 'theirSet':
      if (!value) return false;
      mode.picks.targetColor = value;
      // A FULL mat answered a rearrange: this is §3.5's swap, and the swapCard
      // step is ALWAYS taken, however few partners there are.
      //
      // It used to be skipped for a single partner, under this file's own
      // standing rule — never prompt for a decision with one answer. That rule
      // is right and it was answering the wrong question. It correctly answers
      // WHICH PARTNER: there is one, so do not ask. It does not answer DID YOU
      // WANT A SWAP AT ALL, and that question has two answers on every full mat
      // in the game, because the tap that chose the destination is byte-for-byte
      // the same gesture for a move and for a swap.
      //
      // They are not the same move. A move relocates one card and draws one
      // rearrange; a swap relocates TWO and draws TWO (selectors.js SWAP_COST).
      // Owner, live: "im trying to add a wild to one that has a dual color one
      // and they are just getting swapped over and over" — the swap fired
      // silently, the board changed in a way the player had not chosen, they put
      // it back, and the identical tap did it again. d05d523's own reasoning is
      // the argument against what it shipped: "a board change the player never
      // chose is worse than any refusal."
      //
      // So the step costs one tap and buys consent: no `swap_property` leaves
      // this client until the player has pointed at the card being traded with,
      // and the swapCard step is a thing a plain move never does. Rejected —
      // refusing the mat and offering the swap as an alternative (that is a
      // second surface, which ART §3.2 spends a clause refusing, and it makes
      // the deadlock §3.5 ruled in harder to reach than before it existed).
      if (mode.intent === 'move' && step === 'myColor'
          && sel.swapPartners(mode.cardId, value).length) {
        mode.needs.splice(1, 0, 'swapCard');
      }
      break;
    case 'swapCard':
      if (!Number.isInteger(value)) return false;
      // Re-checked against the board rather than trusted from the tap: the mark
      // could be one broadcast stale, and the engine's refusal costs a round trip.
      if (!sel.swapPartners(mode.cardId, mode.picks.targetColor).some(c => c.id === value)) return false;
      mode.picks.withCardId = value;
      break;
    case 'theirCard':
      if (!Number.isInteger(value)) return false;
      mode.picks.targetCardId = value;
      break;
    case 'myCard':
      if (!Number.isInteger(value)) return false;
      mode.picks.myCardId = value;
      break;
    default: return false;
  }
  // The acceptance beat (§P10 FEEL): a tap on a marked victim board changed
  // the mode with no sfx/haptic at all until the server answered. Fired HERE —
  // the ONE place every route (tap, keyboard, drop) records a pick — so the
  // three routes cannot disagree about what got acknowledged.
  cueEl(CUE.TARGET_STEP, true, false, stepAnchor(step, value));
  advance();
  return true;
}

/** Where the accepted answer lives on the felt, for the cue's pan/epicentre. */
function stepAnchor(step, value) {
  if (step === 'player') return table.boardEl(value);
  if (step === 'theirCard' || step === 'myCard' || step === 'swapCard') return getNode(value);
  // a colour step: the mat, on whichever board the step was about
  const ownerId = step === 'theirSet' ? mode.picks.targetId : store.self.id;
  return table.boardEl(ownerId)?.querySelector(`.propcol[data-color="${value}"]`) || null;
}

function handleTargetTap(el) {
  const step = mode.needs[0];
  if (!step) return;
  if (step === 'player') { pick(step, el.getAttribute('data-player')); return; }
  if (step === 'myColor' || step === 'mySet' || step === 'theirSet') {
    pick(step, el.getAttribute('data-color'));
    return;
  }
  pick(step, Number(el.getAttribute('data-card-id')));
}

/* ── drag (P4) ─────────────────────────────────────────────────────────── */

/** Boards this card may legally be aimed at — the same filter applyMarks uses. */
function playerEligible(card, player) {
  const action = card?.action;
  if (action === 'inspector_general') return sel.completeSetsOf(player.id).length > 0;
  if (action === 'midnight_requisition' || action === 'chud' || action === 'tdy_orders') {
    return sel.stealableCards(player.id, action).length > 0;
  }
  return true;
}

/** What a press on this card would pick up, or null if it is not draggable. */
export function dragCandidate(cardId) {
  if (mode.kind === 'payment' || mode.kind === 'discard') return null;   // tap-to-toggle owns these
  const inHand = sel.handCard(cardId);
  if (inHand) return sel.canPlay() ? { source: 'hand', card: inHand } : null;
  // A wild (§3.8) or an Upgrade/FOC (§3.1b) already on my board — both are
  // free rearranges over the same command.
  // A board card is picked up under the REARRANGE window, not the play window
  // (sel.canRearrange()) — a spent play must not weld a wild to its mat.
  const mine = sel.boardMoveTarget(cardId);
  if (mine && sel.canRearrange() && offeredColors(mine).length) {
    return { source: 'board', card: mine.card, from: mine.from };
  }
  return null;
}

/**
 * Legal landing places for a dragged card, as elements.
 *   rank 0 — a precise target: a set column, a board, the bank, a card
 *   rank 1 — a region that means "play it": your own board, the table centre.
 *   rank 2 — the whole felt, as the LAST resort, for cards whose neutral
 *            meaning is unambiguous ("play it and I will aim on the table").
 * drag.js resolves a release to the nearest rank-0 target within a snap radius
 * first, then to a region's nearest precise child, then to rank 2 — so a rough
 * drop still lands somewhere the player meant (owner feedback: aiming at a
 * 20px column strip "feels terrible").
 * An empty target list is legal: the card is draggable but nothing it could do
 * is legal right now, and `reason` says why.
 * `myBoard` rides along so interact/drag.js can mark the columns that are NOT
 * targets as illegal (ART §5.1) without re-deriving the seat.
 */
export function dragPlan(cardId) {
  const cand = dragCandidate(cardId);
  if (!cand) return null;

  const targets = [];
  const seen = new Set();
  const push = (el, drop, rank = 0) => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    targets.push({ el, drop, rank });
  };

  const myBoard = table.boardEl(store.self.id);
  const col = (color) => myBoard?.querySelector(`.propcol[data-color="${color}"]`);
  const card = cand.card;

  if (cand.source === 'board') {
    // A swap column ships the SAME drop kind as a move column. dropCommit's
    // 'move' branch runs beginMove() → pick('myColor'), and pick() is where the
    // move/swap fork lives — so the drag route cannot disagree with the tap
    // route about which command a mat means, because it does not decide.
    for (const color of offeredColors(sel.boardMoveTarget(cardId))) {
      push(col(color), { kind: 'move', value: color });
    }
    return { source: 'board', card, targets, reason: '', myBoard };
  }

  // `reason` is '' only when the card can be PLAYED. Money always has one
  // ("banked, not played") and a blocked action still banks fine, so the bank
  // target is decided separately from playability.
  const reason = sel.blockedReason(card);
  const bankable = !isPropertyCard(card);

  if (!reason && isPropertyCard(card)) {
    for (const color of sel.placementColors(card)) {
      push(col(color), { kind: 'need', step: 'myColor', value: color });
    }
    push(myBoard, { kind: 'play' }, 1);
  } else if (!reason) {
    // action / rent: the centre of the table always means "play it, I will aim
    // on the table"; every precise target answers the FIRST thing it needs.
    const step = (sel.requirementsFor(card) || [])[0];
    if (step === 'player') {
      for (const p of sel.opponents()) {
        if (playerEligible(card, p)) push(table.boardEl(p.id), { kind: 'need', step, value: p.id });
      }
    } else if (step === 'myColor') {
      for (const color of sel.rentColors(card)) push(col(color), { kind: 'need', step, value: color });
    } else if (step === 'mySet') {
      const needsHouse = card.action === 'foc';
      for (const color of sel.myCompleteSets({ needsHouse, needsNoHouse: !needsHouse })) {
        push(col(color), { kind: 'need', step, value: color });
      }
    } else if (step === 'myCard') {
      // 'myCard' is TDY Orders only, and §3.1 now guards MY side of the trade
      // too (game.js playAction 'tdy_orders': zoneRequisitionable(p, mine.color)
      // → "You cannot trade a card out of one of your complete sets"). Glowing
      // a complete-set card here promised a move the engine refuses.
      for (const { card: c } of sel.tradeableProps()) {
        push(getNode(c.id), { kind: 'need', step, value: c.id });
      }
    }
    push(document.getElementById('table-center'), { kind: 'play' }, 1);
    // The neutral "play it" target is the FELT, not the 64px-tall deck strip.
    push(document.getElementById('table'), { kind: 'play' }, 2);
  }

  if (bankable) {
    push(bankEl(), { kind: 'bank' });
    push(myBoard, { kind: 'bank' }, 1);
  }
  return { source: 'hand', card, targets, reason, myBoard };
}

function bankEl() {
  const zone = table.zoneFor('bank', store.self.id);
  return zone?.closest('.board-bank') || zone;
}

/**
 * A landed drag. Deliberately goes through selectHandCard → play/bank →
 * pick(): the drag is a shortcut for the taps, never a second route to
 * net/send.js.
 * @returns {boolean} true if the machine took it (dispatched, or now targeting)
 */
export function dropCommit(cardId, drop) {
  if (!drop) return false;

  if (drop.kind === 'move') {
    beginMove(cardId);
    return pick('myColor', drop.value);
  }

  // A tap may already have this card selected; selectHandCard would toggle it off.
  if (!(mode.kind === 'strip' && mode.cardId === cardId)) selectHandCard(cardId);
  if (mode.cardId !== cardId) return false;

  if (drop.kind === 'bank') {
    if (isPropertyCard(mode.card)) return false;
    bankSelected();
    return mode.kind === 'idle';
  }

  playSelected();
  if (mode.kind === 'strip') return false;                 // refused, still selected
  if (drop.step) pick(drop.step, drop.value);
  return true;
}

/**
 * Why THAT mat said no — drag.js step 1a, for a drop released on a column this
 * drag had already drawn as refused (`data-drop-illegal`).
 *
 * Only the machine can answer it: the reason lives in the engine's rules, not
 * in the DOM. The sentences are game.js moveProperty()'s own (1997-2001) and
 * playProperty()'s zone check, so the toast the player reads is the error the
 * server would have sent had the client fired the move anyway.
 *
 * @param {number} cardId  the card that was being dragged
 * @param {string} color   the refused column's colour key
 * @returns {string} a sentence, or '' when there is nothing specific to say
 */
export function dropRefusal(cardId, color) {
  if (!color || !COLORS[color]) return '';
  const name = colorName(color);
  const me = selfPlayer();
  const size = setSize(color);
  const held = me?.properties?.[color]?.length || 0;

  const board = sel.boardMoveTarget(cardId);
  if (board) {
    if (color === board.from) return '';                     // 'Already in that set' — a no-op, not a refusal
    if (board.isUpgrade) {
      return `${name} cannot take that — an Upgrade moves only onto another complete set that has room for it`;
    }
    if (!coreLegalColors(board.card).includes(color)) {
      return `That wild cannot go on ${name}`;
    }
    if (held >= size) {
      // §3.5's swap. A full mat holding a legal partner is a TARGET, not a
      // refusal, so the only thing left to say here is that the budget cannot
      // pay for it — and that must be said, because "already holds a full set"
      // would be true, unhelpful, and the wrong reason.
      if (sel.swapPartners(cardId, color).length) {
        return sel.canSwap() ? '' : sel.cannotSwapReason();
      }
      return `${name} already holds a full set (${size})`;
    }
    return '';
  }

  const hand = sel.handCard(cardId);
  if (hand && isPropertyCard(hand)) {
    if (!coreLegalColors(hand).includes(color)) return `That card cannot go on ${name}`;
    if (held >= size) return `${name} already holds a full set (${size})`;
  }
  return '';
}

/* ── marks ─────────────────────────────────────────────────────────────── */

function clearMarks() {
  for (const node of qsa('[data-targetable="1"]')) node.removeAttribute('data-targetable');
  // The mat's decision chit and the reach lent to the mat itself. Taken back
  // together and unconditionally: clearMarks() runs first on every applyMarks()
  // pass, so a mat that stops being a target in the same broadcast that made
  // another one a target cannot keep a stale answer or a stale tab stop.
  for (const node of qsa('.mat-advice')) node.remove();
  for (const node of qsa('.propcol[role="button"]')) {
    node.removeAttribute('role');
    node.removeAttribute('tabindex');
  }
  // The NAME comes off separately, because a live board drag paints the advice
  // (and therefore the sentence) on mats that were never promoted to buttons —
  // markPropColumns is a targeting-step thing and a drag is not one. Keyed on
  // the attribute rather than on the role, or a drag left ten stale sentences
  // on the board describing a card that is back in its column.
  for (const node of qsa('.propcol[aria-label]')) node.removeAttribute('aria-label');
  for (const node of qsa('[data-payable="1"]')) {
    node.removeAttribute('data-payable');
    // cardnode.js parks every card at tabindex -1; selection modes are the only
    // time a card is a control in its own right, so the reach is lent, not kept.
    if (node.getAttribute('tabindex') === '0') node.setAttribute('tabindex', '-1');
  }
  for (const node of qsa('.is-picked')) node.classList.remove('is-picked');
  for (const node of qsa('.is-discarding')) node.classList.remove('is-discarding');
  // A card under the finger keeps its lift: applyMarks runs on every snapshot
  // and a mid-drag state broadcast would otherwise drop the card flat.
  for (const node of qsa('.is-lifted')) {
    if (!node.classList.contains('is-dragging')) node.classList.remove('is-lifted');
  }
}

// `node`, not `el`: `el` is core/dom.js's element builder in this module now.
function mark(node) { if (node) setAttr(node, 'data-targetable', '1'); }

/* ── lending a card node keyboard focus (§0.9) ─────────────────────────────
 * table/cardnode.js parks every card at tabindex -1. Selection modes are the
 * only time a card is a control in its own right, so the reach is lent for the
 * mode and taken back in clearMarks().
 *
 * MEASURED: lending it unconditionally turned tools/touchtest.mjs's tap-target
 * scan red — a payment surface promoted 25×53 and 38×53 bank cards to controls
 * (§0.9 floor is 44), and landscape promoted 31×45 property cards. A card that
 * is too small to be a tap target must not become one by being focusable, so
 * the promotion is gated on the box the player would actually have to hit.
 * The hand cards the discard flow needs are 58px+ on a 390px phone and always
 * qualify. REQUEST to the table agent: `.zone-bank` cards expose a 23–25px
 * strip at the -0.35em overlap and `.opponents`/landscape `.propcol` cards run
 * to 31px — until those clear 44, payment selection has no keyboard route.
 */
const TAP_FLOOR = 44;

function lendFocus(node) {
  if (!node) return;
  const r = node.getBoundingClientRect();
  if (Math.min(r.width, r.height) >= TAP_FLOOR) setAttr(node, 'tabindex', '0');
}

function markPropColumns(ownerId, colors) {
  const board = table.boardEl(ownerId);
  if (!board) return;
  for (const color of colors) {
    const col = board.querySelector(`.propcol[data-color="${color}"]`);
    mark(col);
    // §0.9. A mat is the game's primary targeting surface and it was the only
    // target class with no keyboard route at all: table/layout.js gives a BOARD
    // `tabindex="0"` and cardnode.js parks cards at -1 for interact to lend
    // back, but a `.propcol` had neither — so every rent colour, every wild
    // rearrange and every set seizure was mouse-or-finger only, even though
    // pointer.js's Enter/Space handler has always routed `[data-targetable]`.
    // Lent for the step and taken back in clearMarks(), exactly like lendFocus.
    // No size gate here: table.css floors a mat at `min-height: var(--tap)` on
    // both axes, so unlike a 25px bank card it always clears §0.9's 44.
    if (col) {
      setAttr(col, 'role', 'button');
      setAttr(col, 'tabindex', '0');
      setAttr(col, 'aria-label', `${colorName(color)} — ${zoneTally(ownerId, color)}`);
    }
  }
}

/** "2 of 3" for a mat's accessible name, so the tally is spoken, not implied. */
function zoneTally(ownerId, color) {
  const player = playerById(ownerId);
  return `${player?.properties?.[color]?.length || 0} of ${setSize(color)}`;
}

/* ── what each mat would DO with the card you are holding ──────────────────
 *
 * §3.8 (free rearranging is a first-class VISIBLE interaction) and §3.9 (state
 * every rule) met on the same surface. Chudopoly has no modal colour picker —
 * the choice is made by TAPPING A MAT (`mode.needs = ['myColor']`, HINTS.myColor
 * "Tap the set column to place it on") — so the answer has to live on the mats,
 * and there is nowhere else it could go without inventing the panel ART §3.2
 * spends a whole clause refusing.
 *
 * THREE MARKS, no more, and each one is a thing the mat cannot already tell you:
 *   1. the RENT LADDER with the rung you would land on reversed out. It is one
 *      element doing two of the four jobs: which rung of how many IS the set
 *      progress (a ladder has exactly `size` rungs), and the rung's figure is
 *      the rent you would charge. The mat's own tally says where you ARE; this
 *      says where you would BE.
 *   2. SET, when the placement completes the set.
 *   3. BEST, on the single highest rent gain (state/selectors.js ranks it).
 * Everything else a player might want — the set name, the current tally, the
 * cards — is already on the mat, and ART §3.2's "panel proliferation" note is
 * about exactly this temptation.
 *
 * NO COLOUR IS SPENT (ART §1: hue belongs to set identity, and a mat is already
 * a saturated ground). The chit is card stock with ink on it — the same printed
 * material as every card in the game, IDENTICAL IN BOTH THEMES by ART §0's
 * thesis, so one measured contrast figure (17.08:1) covers light and dark and
 * all ten mats at once. The signals are value inversions of that same material:
 * the landing rung is reversed out, the BEST chit is reversed out whole (ART §1
 * files the achromatic ink slab as "the primary action" — during this step a mat
 * IS the primary action), and a completing chit carries the printed double rule
 * that `.propcol.is-complete .propcol-head` already uses for the same fact.
 *
 * It exists only while the step does: applyMarks() builds it, clearMarks()
 * removes it, and clearMarks() runs first on every single pass.
 */
function paintAdvice(card, colors, kind, swap = []) {
  const board = table.boardEl(store.self.id);
  if (!board) return;
  const rows = sel.placementAdvice(card, colors, kind, swap);
  for (const row of rows) {
    const col = board.querySelector(`.propcol[data-color="${row.color}"]`);
    if (!col) continue;
    // The chit is a picture of the sentence; the sentence is the mat's own
    // accessible name. Reading both aloud would be "Drone Ops one of two … one
    // two SET BEST", which is worse than either.
    setAttr(col, 'aria-label', sel.adviceSentence(row));
    col.appendChild(buildChit(row));
  }
}

function adviceKind() {
  if (mode.card?.type === 'rent') return 'rent';
  if (mode.intent === 'move' && sel.boardMoveTarget(mode.cardId)?.isUpgrade) return 'upgrade';
  return 'place';
}

function buildChit(row) {
  // §3.5's trade is the THIRD mark, and it is the one that makes the move
  // discoverable: a full mat that used to be painted refused now carries a word
  // saying what it would do instead. It is exclusive with the other two by
  // construction — a swap changes no count, so it can never complete a set, and
  // it gains no rent, so it can never be BEST (state/selectors.js excludes it
  // from the ranking rather than letting a tie-break put it there). `data-marks`
  // is what collapses the ladder to its landing rung on a 48px phone mat, and a
  // trade wants exactly that: the rung it stays on, plus the word.
  const trade = row.kind === 'swap';
  const marks = trade ? 1 : (row.completes ? 1 : 0) + (row.best ? 1 : 0);
  const chit = el('div', {
    class: 'mat-advice',
    // NOT aria-hidden. The mat carries `role="button"` + `aria-label`, and an
    // author-supplied name on a button role replaces its contents in the
    // accessibility tree, so the figures are already not read out twice.
    // aria-hidden would ALSO take them out of tools/lib/audit.mjs
    // auditTextContrast(), whose vis() drops `aria-hidden="true"` — hiding new
    // text from the contrast gate to solve a problem the label already solved.
    attrs: {
      'data-best': row.best ? '1' : null,
      'data-complete': row.completes ? '1' : null,
      // interact.css collapses the ladder to its landing rung when a WORD has
      // to share a 48px phone mat with it (see the tier note there).
      'data-marks': marks ? '1' : null,
    },
  });
  for (let i = 0; i < row.ladder.length; i++) {
    chit.appendChild(el('span', {
      class: i + 1 === row.landing ? 'mat-rung is-landing' : 'mat-rung',
      text: String(row.ladder[i]),
    }));
  }
  if (trade) chit.appendChild(el('span', { class: 'mat-mark', text: 'TRADE' }));
  if (row.completes) chit.appendChild(el('span', { class: 'mat-mark', text: 'SET' }));
  if (row.best) chit.appendChild(el('span', { class: 'mat-mark', text: 'BEST' }));
  return chit;
}

/* ── a target you cannot see is not a target (§P9 FEEL round 3, landscape) ──
 *
 * MEASURED on 844×390: `#opponents` is a 97px rail with 77% of its content
 * scrolled out of view, and picking a steal target marks boards whose CENTRE is
 * outside it. Three real taps aimed at a marked board sent nothing — correctly,
 * because the point tapped was not on the board — and the only recovery was
 * three blind flicks along a 97px rail with no indication of which way to go.
 * Nothing in the client called scrollIntoView when targeting armed.
 *
 * So arming a step brings its targets to the player. Two rules keep it from
 * being a nuisance:
 *   • it fires on a STEP CHANGE, never on a redraw — applyMarks() runs on every
 *     broadcast, and a rail that re-centres itself under the thumb once per bot
 *     turn is worse than one that never moves;
 *   • it does nothing when a target is already reachable (≥60% of one marked
 *     box on screen). The common case — a 3-player desktop table where every
 *     board is visible — never scrolls at all.
 * `block:'nearest'` so the horizontal rail moves and the page does not.
 */
let revealKey = '';

/* ── the payment brings its bank to the player (P10, MOBILE critic) ─────────
 * MEASURED at 390×844 on payment-pending: #self-board is a scroller and the
 * prompt says "tap your bank, property and Upgrade cards" while part of the
 * board sits past the pane's bottom edge, laid out under the very bar that is
 * asking — two value coins at 100% under #prompt in the cold frame. So
 * entering payment scrolls the bank mat into the pane, exactly as revealMarks
 * does for a targeting step, with the same two guards: once per payment (a
 * broadcast-driven re-mark must not re-centre the pane under the thumb), and
 * not at all when the bank is already substantially visible — the desktop
 * grid, whose bank is pinned as the pane's last row, never scrolls. */
let payRevealKey = '';

function revealPayment() {
  const key = `pay:${mode.amount}`;
  if (key === payRevealKey) return;
  const bank = document.querySelector('.board-self .board-bank')
    || table.zoneFor('bank', store.self.id);
  if (!bank) return;                       // board not built yet — next pass retries
  payRevealKey = key;
  if (visibleEnough(bank)) return;
  try {
    bank.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  } catch { bank.scrollIntoView(false); }
}

/* Visibility is measured against the CLIP CHAIN, not just the window.
 * ROUND-2 MOBILE #3: in landscape the #opponents rail is a ~100px scroller
 * inside a 390px viewport, so a seat scrolled out of the rail still has a rect
 * entirely inside the WINDOW — the old window-only intersection called it
 * "visible", revealMarks stayed its hand, and targeting armed with every
 * eligible seat hidden behind a flick. Measured on five-player@l844: a marked
 * seat at rect y158..247 (100% in-window) with 0% of it inside the rail's
 * y54..156 clip. So the rect is intersected with every overflow-clipping
 * ancestor on the way up; the ≥60% threshold and both callers' once-per-mode
 * contracts are unchanged, and the strip's no-snap/no-anchor ruling
 * (table.css) is untouched — this only ever ASKS for the scroll the two
 * reveal helpers already perform. */
function visibleEnough(el) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  let left = r.left;
  let top = r.top;
  let right = r.right;
  let bottom = r.bottom;
  for (let a = el.parentElement; a; a = a.parentElement) {
    const s = getComputedStyle(a);
    if (!/(auto|scroll|hidden|clip)/.test(s.overflowX + ' ' + s.overflowY)) continue;
    const c = a.getBoundingClientRect();
    left = Math.max(left, c.left);
    top = Math.max(top, c.top);
    right = Math.min(right, c.right);
    bottom = Math.min(bottom, c.bottom);
  }
  const x = Math.max(0, Math.min(right, window.innerWidth) - Math.max(left, 0));
  const y = Math.max(0, Math.min(bottom, window.innerHeight) - Math.max(top, 0));
  return (x * y) / (r.width * r.height) >= 0.6;
}

function revealMarks(key) {
  if (key === revealKey) return;
  revealKey = key;
  if (!key) return;
  // qsa() returns a raw NodeList (core/dom.js), which has forEach but NOT some —
  // this threw `marks.some is not a function` on every desktop and phone run,
  // and went unnoticed because the two gates that would have caught it were red
  // for unrelated layout reasons.
  const marks = [...qsa('[data-targetable="1"]')];
  if (!marks.length || marks.some(visibleEnough)) return;
  try {
    marks[0].scrollIntoView({
      block: 'nearest',
      inline: 'center',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  } catch { marks[0].scrollIntoView(false); }
}

/**
 * The pick-open fan (table.css's :has() rules over [data-targetable]) is a
 * LAYOUT change armed by this very mark pass, and it used to arrive in one
 * frame — no FLIP runs on a mark, because nothing reparents (§P10 FEEL,
 * measured in table.flipStrip's header). So a pass that opens, closes or
 * re-aims the fan is routed through table.flipStrip(), which measures the
 * strip's cards around the mutation and flies the deltas. Screened here so
 * the common pass (no fan involved) pays zero rect reads: the fan exists iff
 * a theirCard step is arming, or its marks are already in the strip's DOM.
 * Reduced motion collapses to the instant layout change (flipStrip bails).
 */
export function applyMarks() {
  const fanNext = mode.kind === 'target' && mode.needs[0] === 'theirCard';
  const fanNow = !!document.querySelector('.opponents .zone-props > .card[data-targetable="1"]');
  if (fanNext || fanNow) table.flipStrip(applyMarksNow);
  else applyMarksNow();
}

function applyMarksNow() {
  clearMarks();
  const snap = store.snapshot;
  if (!snap) return;
  const me = selfPlayer();

  if (mode.kind === 'strip' && mode.cardId != null) {
    const node = getNode(mode.cardId);
    if (node) node.classList.add('is-lifted');
  }

  if (mode.kind === 'target') {
    const step = mode.needs[0];
    if (step === 'player') {
      for (const p of sel.opponents()) {
        if (playerEligible(mode.card, p)) mark(table.boardEl(p.id));
      }
    } else if (step === 'theirCard') {
      for (const { card } of sel.stealableCards(mode.picks.targetId, mode.card?.action)) {
        const node = getNode(card.id);
        mark(node);
        // §0.9. The steal answer is a CARD NODE, and until table.css's
        // pick-open fan a seat card was 30px wide — below lendFocus's own
        // gate — so the theirCard step had no keyboard route at all. Fanned,
        // the card clears 44 and the same gated promotion payment, discard
        // and swapCard already use applies; taken back in clearMarks().
        lendFocus(node);
      }
    } else if (step === 'theirSet') {
      markPropColumns(mode.picks.targetId, sel.completeSetsOf(mode.picks.targetId));
    } else if (step === 'myCard') {
      // Same §3.1 guard as dragPlan(): my side of a TDY trade cannot come out
      // of one of my own complete sets. lendFocus for the same §0.9 reason as
      // theirCard above — the answer is a card node.
      for (const { card } of sel.tradeableProps()) {
        const node = getNode(card.id);
        mark(node);
        lendFocus(node);
      }
    } else if (step === 'mySet') {
      const needsHouse = mode.card?.action === 'foc';
      markPropColumns(store.self.id, sel.myCompleteSets({ needsHouse, needsNoHouse: !needsHouse }));
    } else if (step === 'swapCard') {
      // §3.5. The candidates are the cards INSIDE the full mat just chosen —
      // the same on-the-table targeting §5 uses for a steal, aimed at my own
      // board. No sheet, no list, no new surface.
      // §0.9. The step is no longer skippable — a swap cannot be dispatched
      // without answering it — so the cards that answer it have to be reachable
      // without a pointer. lendFocus is the same 44px-gated promotion payment
      // and discard use, and it is taken back in clearMarks().
      for (const card of sel.swapPartners(mode.cardId, mode.picks.targetColor)) {
        const node = getNode(card.id);
        mark(node);
        lendFocus(node);
      }
    } else if (step === 'myColor') {
      const found = mode.intent === 'move' ? sel.boardMoveTarget(mode.cardId) : null;
      const colors = found
        ? offeredColors(found)
        : (mode.card?.type === 'rent' ? sel.rentColors(mode.card) : sel.placementColors(mode.card));
      markPropColumns(store.self.id, colors);
      paintAdvice(mode.card, colors, adviceKind(), found && sel.canSwap() ? found.swap : []);
    }
  }

  /* ── the same answer, while the card is in the air ────────────────────────
   *
   * MEASURED, 1280×720 real CDP, a rainbow wild dragged out of a full green mat
   * onto a full darkblue mat: `document.querySelectorAll('.mat-advice').length`
   * was 0 for the whole gesture, and the only marks on the destination were
   * `data-droppable="1"` and `is-drop-hover` — the identical pair every ordinary
   * move target carries. So on the DRAG route a swap mat was not merely
   * under-explained, it was INDISTINGUISHABLE from a move mat, and the drag is
   * the route the owner reported from.
   *
   * The tap route has said TRADE on that mat since d05d523 (paintAdvice above,
   * armed by beginMove); the drag route never reaches beginMove until the finger
   * is already up. So the same chit is painted from the same function for a live
   * board drag — no new element, no new material, no new contrast figure, and
   * the mats answer before they are aimed at instead of after.
   *
   * Board drags only. A hand card's placement question is asked after Play is
   * pressed, and printing ten chits under a card that has not been committed to
   * yet is a different decision from the one this round is fixing. */
  if (mode.kind !== 'target') {
    const heldId = drag.heldCardId();
    const found = heldId == null ? null : sel.boardMoveTarget(heldId);
    if (found) {
      paintAdvice(found.card, offeredColors(found), found.isUpgrade ? 'upgrade' : 'place',
        sel.canSwap() ? found.swap : []);
    }
  }

  if (mode.kind === 'payment') {
    let marked = 0;
    for (const card of sel.payableCards()) {
      const node = getNode(card.id);
      if (!node) continue;
      setAttr(node, 'data-payable', '1');
      lendFocus(node);
      setClass(node, 'is-picked', mode.selected.has(card.id));
      marked++;
    }
    if (marked) revealPayment();
  } else {
    payRevealKey = '';
  }

  if (mode.kind === 'discard') {
    for (const card of sel.myHand()) {
      const node = getNode(card.id);
      if (!node) continue;
      const picked = mode.selected.has(card.id);
      setAttr(node, 'data-payable', '1');
      lendFocus(node);
      setClass(node, 'is-picked', picked);
      // A payment selection and a discard selection are different promises: one
      // buys you out of a demand, the other throws the card away. They must not
      // look the same (interact.css `.card.is-discarding`).
      setClass(node, 'is-discarding', picked);
    }
  }

  revealMarks(mode.kind === 'target'
    ? `${mode.needs[0] || ''}:${mode.cardId ?? ''}:${mode.picks.targetId ?? ''}`
    : '');
}

/* ── wiring ────────────────────────────────────────────────────────────── */

let explained = false;                 // one interruption sentence per broadcast

/** A live drag/selection that a server broadcast just invalidated (§P7.11). */
function yanked(cardId) {
  explained = true;
  refuse(`${interruptedBy()} — your card is back in your hand.`, getNode(cardId));
}

function interruptedBy() {
  const owed = sel.owedAmount();
  if (owed > 0) {
    const pa = store.snapshot?.pendingAction;
    const who = playerById(pa?.sourceId)?.name;
    return `${who || 'Someone'} charges you ${owed}M`;
  }
  return sel.cannotPlayReason();
}

export function mount() {
  drag.mount({
    dragPlan, dropCommit, dragCandidate, dropRefusal, refreshMarks: applyMarks, yanked,
    // "the machine took the drop but the server has not heard about it yet" —
    // drag.js has to tell a committed landing from a landing that is still
    // waiting on a step, and only this file knows which.
    targeting: () => mode.kind === 'target',
  });
  pointer.onEscape(() => cancel());
  pointer.onTargetTap((el) => handleTargetTap(el));
  pointer.onCardTap((id, node) => {
    if (mode.kind === 'payment' || mode.kind === 'discard') {
      if (node.getAttribute('data-payable') === '1') toggleSelected(id);
      return;
    }
    if (sel.handCard(id)) { selectHandCard(id); return; }
    // A wild or an Upgrade/FOC on my own board: tapping it begins the free
    // rearrange rather than opening the details sheet. A wild always claims the
    // tap so beginMove() can SAY why it cannot move (§P7.3); an Upgrade only
    // claims it when it has somewhere to go — most of the time it does not, and
    // a refusal there would just be a wall in front of the rules card.
    //
    // The claim is gated on rearrangeWindowOpen() — my turn, play phase — and
    // NOT on canRearrange(), so the one in-window refusal the engine can still
    // give (the spent rearrange budget) arrives as beginMove()'s sentence
    // instead of silently opening the rules card. Off-turn the rules card is
    // the better answer, so the tap is not claimed at all.
    const movable = sel.boardMoveTarget(id);
    if (movable && sel.rearrangeWindowOpen() && (!movable.isUpgrade || movable.colors.length)) {
      beginMove(id);
      return;
    }

    // Mid colour-choice, and the tap landed on a card sitting in one of MY
    // columns that is not on offer. MEASURED: aiming a wild at a complete 2/2
    // Command set did nothing at all — the mat is not `data-targetable`, so
    // pointer.js routed the tap to the card inside it and the rules sheet
    // opened over the decision. §P7.3 says a refusal is a sentence; this is
    // drag.js step 1a's answer given to the other route, in the same words.
    if (mode.kind === 'target' && mode.needs[0] === 'myColor') {
      const col = node.closest ? node.closest('.propcol') : null;
      if (col && col.getAttribute('data-owner') === store.self.id
          && col.getAttribute('data-targetable') !== '1') {
        const why = dropRefusal(mode.cardId, col.getAttribute('data-color'));
        if (why) { refuse(why, col); return; }
      }
    }
    bus.emit(EVENTS.UI_DETAILS, id);
  });

  pointer.registerActions({
    'play-card': () => playSelected(),
    'bank-card': () => bankSelected(),
    'cancel-selection': () => cancel(),
    'cancel-targeting': () => cancel(),
    'confirm-payment': () => confirmPayment(),
    'confirm-discard': () => confirmDiscard(),
  });

  // A new snapshot can invalidate the mode: the card was paid away, the target
  // scooped, the pending action resolved while the sheet was open. A reset here
  // must fall through to the owed check below — a snapshot can BOTH invalidate
  // the old mode and demand payment (fixture jumps, missed broadcasts).
  const syncMode = () => {
    // "I was holding something and the table took it away." Captured BEFORE the
    // mode is rewritten, because that is the only moment the difference between
    // "I put it down" and "it was taken" still exists (§P7.11).
    const wasBusy = mode.kind === 'strip' || mode.kind === 'target';
    if (mode.kind === 'strip' || mode.kind === 'target') {
      if (mode.intent !== 'move' && mode.cardId != null && !sel.handCard(mode.cardId)) reset();
    }
    if (mode.kind === 'payment' && sel.owedAmount() === 0) reset();
    if (mode.kind === 'discard' && sel.myHand().length <= (store.snapshot?.handLimit || 7)) reset();
    if (mode.kind === 'idle' && sel.owedAmount() > 0) {
      const held = wasBusy && !explained;
      beginPayment(sel.owedAmount());
      if (held) bus.emit(EVENTS.TOAST, `${interruptedBy()} — answer that first.`);
      return;
    }
    applyMarks();
  };
  bus.on(EVENTS.STATE_APPLIED, () => { explained = false; drag.revalidate(); syncMode(); });

  // On a fixture/snap load STATE_APPLIED fires before reconcile has created any
  // card node, so marks (and payment auto-entry) found nothing to act on.
  // Re-sync when the table settles.
  bus.on(EVENTS.CHOREO_IDLE, () => syncMode());
}
