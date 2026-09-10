// ui/prompt.js — the one contextual bar above the hand.
//
// It is a bar and not a modal on purpose (§5): every prompt here needs the
// table visible behind it, because the answer is on the table — which card to
// pay with, which board to hit, which set to place on.
//
// P7: the bar is RECONCILED, never rebuilt. Measured before that: selecting
// four payment cards produced prompt node identities 1→2→3→4→5, and
// tools/touchtest.mjs documents the trap in its own comment — a state broadcast
// landing between pointerdown and click detaches the button and the tap is
// eaten by a node that is no longer in the document. Same rule as §0.4's card
// zones, for the same reason.
//
// ── P9 LEGIBILITY: THE BAR IS NEVER BLANK DURING A GAME ────────────────────
//
// Owner, after playing: "the main thing is it's just really unclear what is
// actually happening — it needs better player feedback and agency."
//
// A 100-second session was recorded through the real client against the shipped
// bots, one screenshot every 700ms, and read back frame by frame. The single
// worst finding was that this bar — the only surface in the game whose job is
// to say what you may do — rendered NOTHING for 96 of 116 frames. Specifically:
//
//   • ON YOUR OWN TURN it was hidden. `render()` produced items only once a
//     card had already been selected, so the very first thing a new player sees
//     is "YOUR TURN · 3 plays" in a 12px header and an empty bar. There is no
//     sentence anywhere on screen telling them to touch a card. In the first
//     session the player sat on their own turn for 70 seconds without acting,
//     because Quick Play runs with the turn clock off and nothing on screen
//     asked for anything.
//   • WHILE WAITING it was hidden, so "whose turn is it, what are they doing,
//     when do I get to act, why is everything dead" had no answer below the
//     header.
//   • UNDER ATTACK it lost the attacker. When a charge lands, interact/'s
//     syncMode() auto-enters payment mode from `owedAmount() > 0`, which means
//     the `iMustRespond()` branch — the ONLY branch that says who is charging
//     you, with what card, and for why — is skipped in the normal case. The
//     measured frame read, in full: "Owed 5M — tap your bank, properties and
//     Upgrades / 0M selected / Confirm payment". Not one word about Coyote, not
//     one word about Finance Office, and no clock.
//
// So the bar now answers, in every state a game can be in: whose turn it is,
// how many plays are left, what the game is waiting for, what your options are,
// and — when the answer is "nothing, wait for X" — it says that out loud
// instead of disappearing.

import { $, el, setHidden, setText, setAttr } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import * as send from '../net/send.js';
import { store, seatName, playerById, selfPlayer } from '../state/store.js';
import * as sel from '../state/selectors.js';
import * as interact from '../interact/index.js';
import { mode } from '../interact/index.js';
import * as pointer from '../interact/pointer.js';
import { colorName, cardName, upgradeKinds } from '../core/cards.js';
import { activeRules, PRESET_COPY, WIN_RULE_NAMES } from './ruleset.js';
import * as details from './details.js';
import * as deadline from './deadline.js';
import * as feed from './feed.js';

const ACTION_TITLE = {
  rent: 'Rent', finance_office: 'Finance Office', roll_call: 'Roll Call',
  midnight_requisition: 'Midnight Requisition', chud: 'THE CHUD CARD',
  inspector_general: 'Inspector General', tdy_orders: 'TDY Orders',
};

/* ── the item vocabulary ───────────────────────────────────────────────────
 * render() returns a list of these; paint() makes the DOM equal to it. A key is
 * stable across renders for the SAME control, which is the whole point. */

const text = (key, str, cls = 'prompt-text') => ({ key, tag: 'span', cls, text: str });
const chip = (key, str, cls, extra = {}) => ({ key, tag: 'span', cls, text: str, ...extra });
const button = (key, str, action, cls = 'btn', extra = {}) =>
  ({ key, tag: 'button', cls, text: str, action, ...extra });

/**
 * The surge on a charge, as the number the engine actually used.
 *
 * game.js chargeAmount() (994-1000) multiplies by `2 ** stack` and now ships that
 * `multiplier` on the pendingAction and on `rent_charged`/`demand`. Before it did,
 * the only thing on the wire was the boolean `doubled`, so a x4 charge was labelled
 * "(DOUBLED)" directly under the engine's own log line reading "SURGED x4". The
 * fallback keeps an older broadcast honest at the one value it can prove.
 */
function surgeLabel(pa) {
  if (!pa?.doubled) return '';
  const m = Number(pa.multiplier);
  return Number.isFinite(m) && m > 1 ? ` — SURGED x${m}` : ' — SURGED';
}

/** The card an id names, as its display title — '' when the snapshot cannot
 *  resolve it (an older broadcast, a half-applied state), so every caller can
 *  fall back to the generic sentence rather than print "undefined". */
function pendingCardName(cardId) {
  if (cardId == null) return '';
  return cardName(sel.findCard(cardId)) || '';
}

function describePending(pa) {
  const who = seatName(pa.sourceId);
  const title = ACTION_TITLE[pa.action] || pa.action;
  if (pa.type === 'payment') {
    const on = pa.color ? ` on ${colorName(pa.color)}` : '';
    return `${who} charges ${pa.amount}M — ${title}${on}${surgeLabel(pa)}`;
  }
  if (pa.type === 'steal_set') return `${who} is seizing your ${colorName(pa.color)} set — ${title}`;
  // The card at stake is on the wire — startPending ships `targetCardId` for
  // both steals (game.js:1508-1512, 1588-1592) and `myCardId` + `targetCardId`
  // for the swap (game.js:1532-1536), and the defender's own board is public in
  // every snapshot — but this bar never read the ids, so the one decision that
  // is ABOUT a specific card ("do I spend an OPSEC on this?") named no card.
  // Strings only, rendered through setText/textContent (§0.10): a card name is
  // player-adjacent data and must never be interpolated into markup.
  if (pa.type === 'steal_property') {
    const take = pendingCardName(pa.targetCardId);
    return take
      ? `${who} is taking your ${take} — ${title}`
      : `${who} is taking one of your properties — ${title}`;
  }
  if (pa.type === 'swap') {
    // `myCardId` is the ATTACKER's card (their side of the trade); this bar is
    // only ever read by the defender, so "your X for their Y".
    const take = pendingCardName(pa.targetCardId);
    const give = pendingCardName(pa.myCardId);
    return take && give
      ? `${who} wants your ${take} for their ${give} — ${title}`
      : `${who} wants to swap properties — ${title}`;
  }
  return `${who} plays ${title}`;
}

/**
 * A player on final approach who pays with a property loses the set and is
 * disarmed (processPayment → syncSets(payer)). Worth saying out loud at the one
 * moment it can happen by accident.
 */
function approachWarning() {
  const me = store.snapshot?.players?.find(p => p.id === store.self.id);
  if (!me?.finalApproach) return null;
  return text('approach',
    'You are on FINAL APPROACH — paying with a card out of a complete set ends it.',
    'prompt-why is-approach');
}

/**
 * An unstated rule that silently costs rent, warned about at the only moment it
 * can still be avoided: the tap before Confirm.
 *
 * game.js normalizeUpgrades() (806-830) runs over every colour the payment touched
 * and BANKS any FOC left without an Upgrade beneath it. So paying with an Upgrade
 * quietly takes its FOC off the set too. MEASURED against the engine: a complete
 * Command set carrying Upgrade + FOC charges 15M rent; settle a 2M Roll Call with
 * the Upgrade alone and the set is still complete, still 2/2 — and charges 8M. Two
 * cards left the board for a 2M bill, and the only trace was a `payment` line
 * saying "paid 3M".
 *
 * It fires only when the FOC is not ALSO in the selection: hand over both
 * deliberately and there is nothing to warn about, you already spent them.
 */
function focWarning() {
  const me = selfPlayer();
  if (!me) return null;
  // Deliberately NOT gated on isComplete(): normalizeUpgrades() does not ask whether
  // the set is still a set, only whether the FOC has an Upgrade under it.
  const losing = [];
  for (const card of sel.payableCards(me)) {
    if (card?.upgradeType !== 'house') continue;
    if (!mode.selected?.has(card.id)) continue;
    const color = card.placedColor;
    if (!color || !upgradeKinds(me, color).includes('hotel')) continue;
    const foc = (me.upgrades?.[color] || []).find(u => u?.upgradeType === 'hotel');
    if (foc && mode.selected.has(foc.id)) continue;    // spending both on purpose
    losing.push(colorName(color));
  }
  if (!losing.length) return null;
  return text('focwarn',
    `An FOC cannot stand without its Upgrade: paying with your ${losing.join(' and ')} `
    + 'Upgrade sends the FOC to your bank too — the set stays complete and loses 7M of rent.',
    'prompt-why is-approach');
}

/**
 * WHAT ARE WE PLAYING? — item 15. Until now the resolved preset lived only behind
 * ? → Goal, so a player dropped into a table under MD Faithful (where a full zone of
 * wilds is not a set) or Blitz (where the third set wins instantly, with no window
 * to break it) had no way to know from the table itself.
 *
 * ui/ruleset.js activeRules() reads game.js getPlayerView's resolved `rules` block
 * — the server's answer, not the lobby's guess — and falls back to the win rule's
 * name for a custom mix that matches no preset. It rides the idle states only,
 * beside the standings, for the reason leaderChip() gives: during a decision the
 * bar is asking a question.
 */
function rulesetChip() {
  const active = activeRules();
  if (!active.live) return null;
  const name = PRESET_COPY[active.preset]?.name || WIN_RULE_NAMES[active.winRule] || null;
  if (!name) return null;
  return chip('ruleset', name.toUpperCase(), 'chip prompt-ruleset');
}

/* ── the response deadline (§5, §P7.7, §P9) ────────────────────────────────
 *
 * MEASURED, twice. First round: the respond prompt rendered with #hud-timer
 * hidden, so the one moment §5 demands a ring with urgency — "you are under
 * attack, answer" — had no clock at all. That was fixed by drawing a ring here,
 * fed by ui/hud.js's single clock subscriber off `store.timers.response`.
 *
 * P9 found the fix was inert in the case that actually happens: for a charge
 * from a BOT the server never sends `responseTimer` at all (the broadcast is
 * serialised before the deadline is armed — see ui/deadline.js's header, and
 * the request in this agent's report), so `store.timers.response` is null for
 * the entire attack and the ring never appeared. ui/deadline.js derives an
 * honest countdown in that case; the id is its own so ui/hud.js, which hides
 * #prompt-timer whenever the server sent nothing, cannot fight it for the node.
 */
function deadlineItems(list) {
  if (!deadline.active()) return;
  list.push({
    key: 'deadline', tag: 'span', cls: 'timer prompt-timer',
    id: 'prompt-deadline', ring: true,
  });
  list.push({
    key: 'deadlinewhy', tag: 'span', cls: 'prompt-why is-deadline',
    id: 'prompt-deadline-why', text: deadline.consequence(),
  });
}

/* ── what is in my hand, and what can it actually do ──────────────────────
 *
 * "Why is that greyed out?" has to be answerable BEFORE the player taps and is
 * refused. state/selectors.js already computes the engine's own reasons; the
 * missing half was reaching them without a failed attempt. A count is the
 * cheapest honest form of that, and it is derived from exactly the predicate
 * the Play button will use one tap later, so the two can never disagree.
 */
/**
 * IS THE TABLE ACTUALLY HOLDING WHAT THE SNAPSHOT SAYS?
 *
 * MEASURED at t=77ms of a real deal: the header read DEALING, the hand zone held
 * ZERO card nodes, and this bar already read "YOUR TURN · 3 plays left · 3 playable
 * · 4 to bank" — because handOptions() below counts `sel.myHand()`, which is the
 * broadcast, and the broadcast lands ~1.7s before the choreographer finishes flying
 * the cards in. Same root cause as the ending spoiler above: a surface reading the
 * store while every other surface follows the choreographer.
 *
 * The fix is a DIFF against what the table is actually holding rather than another
 * timer, because a timer would have to be re-tuned every time the deal changes
 * length, and because in steady state the two numbers are equal — so this costs one
 * querySelectorAll over a ≤7-node zone and never flickers during ordinary play.
 * If the zone cannot be found at all we assume settled: a missing node must never
 * mute the one bar whose job is to speak.
 */
function handSettled() {
  const want = sel.myHand().length;
  if (!want) return true;
  const zone = document.querySelector('#zone-hand, [data-zone="hand"]');
  if (!zone) return true;
  return zone.querySelectorAll('[data-card-id]').length >= want;
}

function handOptions() {
  const hand = sel.myHand();
  let playable = 0;
  let bankable = 0;
  let stuck = 0;
  for (const card of hand) {
    // Properties and wilds have no bank move; everything else does, which is
    // why blockedReason() saying "Money cards are banked, not played" is a
    // playable card by this count and not a dead one.
    const isProperty = card.type === 'property' || card.type === 'wild_property';
    if (!sel.blockedReason(card)) playable++;
    else if (!isProperty) bankable++;
    else stuck++;
  }
  return { playable, bankable, stuck, total: hand.length };
}

/** "Who is winning?" in four words. §5's set counts are on every board already;
 *  what they do not say is how far anyone has to go, and the answer is only
 *  ever interesting on a seat that is not yours. */
function leaderChip() {
  const snap = store.snapshot;
  if (!snap || snap.phase !== 'playing') return null;
  // §3.10b — `contestBar` (game.js getPlayerView, 2419-2422) is what a
  // conversion needs RIGHT NOW, and under a live 'escalate' contest that is
  // setsToWin + 1. The engine's own comment beside the field: "the HUD must
  // never tell a player they need three when they need four." setsToWin is the
  // fallback for a snapshot predating the field.
  const need = Number.isInteger(snap.contestBar) && snap.contestBar > 0
    ? snap.contestBar
    : (snap.setsToWin || snap.rules?.setsToWin || 3);
  let best = null;
  for (const p of snap.players || []) {
    if (p.eliminated) continue;
    const n = Number(p.completedSets) || 0;
    if (!best || n > best.n) best = { n, id: p.id, name: p.name };
  }
  if (!best || best.n <= 0) return null;
  const isMe = best.id === store.self.id;
  const tied = (snap.players || []).filter(p => !p.eliminated && Number(p.completedSets) === best.n);
  const who = tied.length > 1 ? `${tied.length}-way tie` : (isMe ? 'You' : best.name);
  // "You 4/3 sets" is what the first cut printed on the final-approach fixture,
  // and a progress bar that has gone past its own end is not a progress bar.
  // Past the winning count the interesting fact is not the ratio, it is that
  // the seat is ARMED — the engine's own word (armedIds), and the one ui/hud.js's
  // strip uses for the same state. Read from armedIds first: under a raised
  // contest bar an armed seat can sit BELOW `need` (3 sets against a bar of 4),
  // and "3/4 sets" without the ARMED word would hide the one fact that matters.
  const armed = (snap.armedIds || []).includes(best.id) || best.n >= need;
  return chip('lead', armed ? `${who} ARMED · ${best.n} sets` : `${who} ${best.n}/${need} sets`,
    `chip prompt-lead${isMe && tied.length === 1 ? ' is-mine' : ''}`
    + (armed || best.n >= need - 1 ? ' is-hot' : ''));
}

/* ── the states the bar can be in ─────────────────────────────────────── */

/** My own turn, nothing selected. The state that used to render nothing at all. */
function myTurnItems(snap, items) {
  const plays = snap.playsRemaining || 0;
  items.push(chip('turn', 'YOUR TURN', 'chip prompt-turn is-mine'));
  items.push(chip('plays', `${plays} play${plays === 1 ? '' : 's'} left`,
    `chip prompt-plays${plays === 0 ? ' is-spent' : ''}`));

  // Every line below this point is a CLAIM ABOUT CARDS. While the deal is still
  // flying, the claim is about cards that are not on the table yet, so the bar
  // says the one thing that IS true and waits (see handSettled()).
  if (!handSettled()) {
    items.push(text('why', 'Dealing…'));
    return;
  }

  // CHIPS, NOT SENTENCES. Measured on a 390×844 phone: a two-clause sentence
  // here wrapped to three lines and made the bar 109px tall, in a state where
  // the bar is only meant to be a nudge. Counts belong in chips — they scan in
  // one saccade and they wrap onto one row.
  const opts = handOptions();
  if (!opts.total) {
    items.push(text('why', 'Hand empty — end your turn and draw two.'));
    return;
  }
  if (plays <= 0) {
    // 55a014f left this line as a known lie and this is the note it asked for.
    // §3.8: a rearrange costs NO play — game.js moveProperty() does not look at
    // `playsRemaining` at all — so "end your turn" was the client telling the
    // player their board was finished on the exact turn where the only free move
    // in the game is still available. The count is asked for rather than assumed
    // (state/selectors.js rearrangeableCards): on a board with no wild and no
    // Upgrade there really is nothing left, and inventing an option is the same
    // class of error as deleting one.
    const movable = sel.canRearrange() ? sel.rearrangeableCards().length : 0;
    items.push(text('why', movable
      ? 'No plays left — but rearranging your board is still free.'
      : 'No plays left — end your turn.'));
    if (movable) {
      items.push(chip('rearrange', `${movable} card${movable === 1 ? '' : 's'} can still move`,
        'chip prompt-count'));
    }
    return;
  }
  if (opts.playable > 0) {
    items.push(text('why', 'Tap or drag a card to play it.'));
    items.push(chip('playable', `${opts.playable} playable`, 'chip prompt-count'));
    if (opts.bankable) items.push(chip('bankable', `${opts.bankable} to bank`, 'chip prompt-count'));
  } else if (opts.bankable > 0) {
    items.push(text('why', 'Nothing can be PLAYED — tap a card to bank it, or end your turn.'));
  } else {
    items.push(text('why', 'No legal move in hand — end your turn.'));
  }
  // "Why is that greyed out?", answered before the tap. blockedReason() has the
  // sentence; this is the count that tells you to go and ask for it.
  if (opts.stuck > 0) {
    // The label carries its own reason. §P7.12's finding — an indicator whose
    // only explanation is a hover `title`, which a phone cannot produce — is
    // the trap here, so "3 stuck" (which explains nothing) is "3 with no set"
    // (which is the whole reason). The title is the long form, not the only form.
    items.push(chip('stuck', `${opts.stuck} with no set`, 'chip prompt-count is-stuck',
      { title: 'Every legal column for these is already full. Tap one for the exact reason.' }));
  }
}

/**
 * Somebody else is deciding. Includes the case where they are deciding about a
 * card *I* played, which is the one time waiting is genuinely tense.
 *
 * ── THE OPSEC CHAIN, SAID CORRECTLY ────────────────────────────────────────
 *
 * game.js respondToAction() (1283-1285) does NOT keep the responder fixed: on an
 * OPSEC it sets `entry.responderId = (playerId === pa.sourceId ? entry.id : pa.sourceId)`
 * and increments `entry.depth`. So at ODD depth the responder IS the source, and
 * `${responder} is answering ${sourceId}'s ${title}` reduces to "Shadow is
 * answering Shadow's TDY Orders" — captured twice in live play, both times right
 * after the critic played OPSEC. Verified against the engine: play TDY a→b, b
 * answers 'opsec', and the broadcast is
 * `responders:["a"], pendingAction.sourceId:"a", targets:[{id:"b",depth:1,responderId:"a"}]`.
 *
 * The DEFENDER is `entry.id` at every depth — the seat the action was aimed at —
 * and the depth's parity is the whole story:
 *   depth 0      the defender is deciding whether to block.
 *   depth odd    the defender's OPSEC is STANDING; the source may counter.
 *   depth even>0 the source countered; the defender may counter back.
 * The second of those never appeared anywhere in the client, so a player who had
 * just spent an OPSEC was never told it had worked.
 */
function pendingElsewhereItems(snap, items) {
  const pa = snap.pendingAction;
  const responder = (snap.responders || [])[0];
  const entry = (pa.targets || []).find(t => t.responderId === responder)
    || (pa.targets || [])[0] || null;
  const depth = Number(entry?.depth) || 0;
  const defender = entry?.id ?? null;
  const title = ACTION_TITLE[pa.action] || pa.action;
  const iAmSource = pa.sourceId === store.self.id;
  const iAmDefender = defender != null && defender === store.self.id;
  items.push(chip('turn', 'HOLD', 'chip prompt-turn is-waiting'));

  if (depth % 2 === 1) {
    // An OPSEC is standing. Name whose it is and who has to answer it.
    items.push(text('why', iAmDefender
      ? `Your OPSEC is standing — ${seatName(pa.sourceId)} is deciding whether to counter it.`
      : `${seatName(defender)} played OPSEC — ${seatName(pa.sourceId)} is deciding whether `
        + `to counter.`));
    if (iAmDefender) items.push(chip('opsecstand', 'OPSEC HELD', 'chip prompt-count is-stuck'));
    return;
  }
  if (depth >= 2) {
    // The source countered; it is back on the defender.
    items.push(text('why', iAmSource
      ? `Your counter-OPSEC is standing — ${seatName(defender)} is deciding whether to answer it.`
      : `${seatName(pa.sourceId)} countered with OPSEC — ${seatName(defender)} is deciding.`));
    return;
  }
  items.push(text('why', iAmSource
    ? `${seatName(responder)} is deciding whether to OPSEC your ${title}.`
    : `${seatName(responder)} is answering ${seatName(pa.sourceId)}'s ${title}.`));
}

/** Not my turn, nothing pending. The long middle of the game. */
function waitingItems(snap, items) {
  const now = playerById(snap.currentPlayerId);
  const plays = snap.playsRemaining || 0;
  items.push(chip('turn', `${now?.name || 'Someone'}'s turn`, 'chip prompt-turn is-waiting'));
  items.push(chip('plays', `${plays} play${plays === 1 ? '' : 's'} left`, 'chip prompt-plays'));
  // The chip has already named the seat, so the sentence does NOT repeat
  // sel.cannotPlayReason() verbatim ("Reaper's turn · It is Reaper's turn" was
  // the first cut, and reads as a stutter). What it adds is the part the chip
  // cannot say: that the wait is the whole of your options right now, and that
  // you will not miss anything aimed at you while it lasts.
  //
  // Twenty-six characters, because this is the state the game spends most of
  // its life in and every wrapped line here is permanent screen. Measured on a
  // 390×844 phone: the two-clause version made the bar 90px — 10.6% of the
  // display, all of it saying "wait". The OPSEC chip below carries the only
  // thing the sentence was still adding (that you can act off-turn), and it
  // carries it exactly when it is true.
  items.push(text('why', 'Nothing for you to do yet.'));
  // OPSEC is the ONE card that acts on somebody else's turn, so holding one
  // genuinely changes what waiting means.
  if (sel.hasOpsec()) items.push(chip('opsec', 'OPSEC ready', 'chip prompt-count'));
}

/**
 * Deliberately ONE LINE and no control. ui/overlays.js owns the ending and
 * ui/journal.js's recap already puts an "Open the full log" button on it; a
 * second [data-action="open-log"] in the bar behind that overlay is the §P7.9
 * duplicate-control defect wearing a different hat, and tools/touchtest.mjs
 * measured mine as a 186×44 button with 0px of itself reachable, on two
 * surfaces. All this has to do is not be blank once the overlay is dismissed.
 */
function finishedItems(snap, items) {
  const winner = snap.winner;
  items.push(chip('turn', 'GAME OVER', 'chip prompt-turn'));
  // §P7.1, again, on the surface that was still doing it. This branch ran on
  // STATE_APPLIED, which lands the instant the finished snapshot arrives — ~850ms
  // before ui/overlays.js and ui/hud.js release their choreographer hold. So the
  // one line in the game whose job is to say the least was announcing the winner
  // over a table still flying the last cards, which is the exact spoiler the HUD
  // was rewritten to prevent. Held on the same signal and the same clock.
  if (winHeld) {
    items.push(text('why', 'The table is settling…'));
    return;
  }
  items.push(text('why', winner == null
    ? 'The game ended on points.'
    : winner === store.self.id
      ? 'You took it.'
      : `${seatName(winner)} took it.`));
}

/* ── the choreographer's hold on the ending (§P7.1) ────────────────────────
 *
 * A faithful mirror of ui/overlays.js's own hold, deliberately duplicated rather
 * than imported: overlays.js opens a full-screen scrim and this opens one line of
 * text, so they must be able to diverge, and a bar that waits on another module's
 * private `pending` flag is a bar that hangs when that module changes its mind.
 * The constants are the same because the beat is the same one — fx/index.js
 * CUE.WIN's shake runs 400ms, the flash 800ms, the fanfare resolves at 270ms.
 */
const CELEBRATION_MS = 850;
const FALLBACK_MS = 2600;
let winHeld = false;
let winArmed = false;          // this ending has already been handled — never re-hold it
let winTimer = 0;

function releaseWin(delay) {
  if (!winHeld) return;
  clearTimeout(winTimer);
  winTimer = setTimeout(() => { winHeld = false; winTimer = 0; render(); }, delay);
}

/** Called on every applied state. Arms the hold the first time a finished snapshot
 *  arrives WITH a celebration queued; a snapped state (reconnect, fixture
 *  injection, catch-up drain) has nothing to wait for and must not be held. A
 *  released hold is never re-armed, or every later broadcast in a finished game
 *  would blank the line again. */
function syncWinHold(payload) {
  const snap = store.snapshot;
  if (!snap || snap.phase !== 'finished') {
    clearTimeout(winTimer);
    winTimer = 0;
    winHeld = false;
    winArmed = false;
    return;
  }
  if (winArmed) return;
  const celebrating = (payload?.events || []).some(ev => ev?.t === 'win' || ev?.t === 'stalemate');
  if (!celebrating) { winArmed = true; return; }
  winArmed = true;
  winHeld = true;
  releaseWin(FALLBACK_MS);                               // the screen can never be lost
}

function render() {
  const bar = $('prompt');
  if (!bar) return;
  const snap = store.snapshot;
  const items = [];
  let state = 'idle';

  // §P7.9 + owner directive: THE DRAW IS GONE FROM THE UI. The engine draws at
  // turn start for every seat (game.js beginTurn, 65e36ef), so `turnPhase` is
  // always broadcast as 'play' and there is nothing for a player to press.
  // Two enabled DRAW buttons 57px apart on every turn start — the measured
  // defect — cannot recur, because neither exists. #btn-draw in the hand bar is
  // suppressed here rather than in ui/hud.js so exactly one module decides.

  if (snap && sel.iMustRespond() && mode.kind !== 'payment') {
    const pa = snap.pendingAction;
    const entry = sel.myPendingEntry();
    if (pa && entry) {
      state = 'respond';
      deadlineItems(items);
      // The HUD narrates whose TURN it is, and during an attack that is the
      // attacker's — measured: "Coyote's turn" was the only turn word on screen
      // while the game sat waiting on the player for 88 seconds. This chip is
      // the bar saying the opposite thing out loud.
      items.push(chip('turn', 'YOUR ANSWER', 'chip prompt-turn is-alarm'));
      if (!sel.acceptMeansSuffer(entry)) {
        // respondToAction(): at an odd depth I am the attacker, and 'accept'
        // means the defender's OPSEC stands — my own card is cancelled.
        items.push(text('why', `${seatName(entry.id)} played OPSEC on your `
          + `${ACTION_TITLE[pa.action] || pa.action}. Letting it stand cancels your card.`));
        items.push(button('accept', 'Let it stand', 'respond-accept', 'btn btn-primary'));
        if (sel.canOpsec()) items.push(button('opsec', 'Counter OPSEC', 'respond-opsec'));
      } else if (pa.type === 'payment') {
        items.push(text('why', describePending(pa)));
        items.push(button('pay', 'Pay', 'begin-payment', 'btn btn-primary'));
        if (sel.canOpsec()) items.push(button('opsec', 'OPSEC', 'respond-opsec'));
        items.push(approachWarning());
      } else {
        items.push(text('why', describePending(pa)));
        items.push(button('accept', 'Accept', 'respond-accept', 'btn btn-primary'));
        if (sel.canOpsec()) items.push(button('opsec', 'OPSEC', 'respond-opsec'));
      }
    }
  } else if (mode.kind === 'payment') {
    state = 'payment';
    const total = interact.selectedTotal();
    const pa = snap?.pendingAction;
    deadlineItems(items);
    // P9: this branch used to open with "Owed 5M" and never name the attacker.
    // It is reached by interact/'s syncMode() auto-entry far more often than by
    // the Pay button, so in practice it WAS the attack screen, and it threw the
    // whole story away. describePending() is the same sentence the respond
    // branch shows, and it comes first.
    items.push(chip('turn', 'YOUR ANSWER', 'chip prompt-turn is-alarm'));
    if (pa) items.push(text('who', describePending(pa), 'prompt-text is-attack'));
    // §3.1b — payableCards() includes the Upgrades on your sets, and they light
    // up with everything else, so the bar has to name them too. The amount is
    // not repeated: describePending() above has just said "charges 5M".
    // Only until they have started. Once a card is chosen the instruction has
    // been obeyed and it is just three lines of phone height (measured: 141px
    // of an 844px screen, before the countdown was even in the bar).
    if (!total) items.push(text('why', 'Tap your bank, property and Upgrade cards.'));
    items.push(chip('total', `${total} / ${mode.amount}M`,
      `chip total${total >= mode.amount ? ' is-enough' : ''}`));
    items.push(chip('worth', `you hold ${interact.payableTotal()}M`, 'chip prompt-worth'));
    items.push(button('confirm', 'Confirm payment', 'confirm-payment', 'btn btn-primary'));
    if (interact.payableTotal() < mode.amount) {
      items.push(button('payall', 'Surrender everything', 'pay-all', 'btn btn-danger'));
    }
    if (sel.canOpsec()) items.push(button('opsec', 'OPSEC instead', 'respond-opsec'));
    items.push(approachWarning());
    items.push(focWarning());
  } else if (mode.kind === 'discard') {
    // §P8: the bar must say the number, show the running count, offer the
    // one-tap default, and make the confirm's state unmistakable WITHOUT
    // disabling it (§P7.3 — a disabled button cannot explain itself).
    state = 'discard';
    const need = mode.excess;
    const have = mode.selected.size;
    const why = interact.discardBlockedReason();
    const over = have > need;
    items.push(text('why',
      `Over the hand limit by ${need}. Pick ${need} card${need === 1 ? '' : 's'} to throw away.`));
    items.push(chip('count', `${have} / ${need} chosen`,
      `chip total${why ? (over ? ' is-over' : '') : ' is-enough'}`));
    items.push(button('confirm', why ? `Pick ${need}` : `Discard ${need}`, 'confirm-discard',
      `btn btn-primary${why ? ' is-refusing' : ' is-ready'}`, why ? { title: why } : {}));
    // The sensible default, one tap, still fully adjustable afterwards.
    if (sel.myHand().length > need) {
      items.push(button('auto', `Cheapest ${need}`, 'discard-cheapest', 'btn',
        { title: 'Selects your lowest face-value cards, keeping properties and OPSEC back. '
          + 'Adjust by tapping any card.' }));
    }
    if (have) items.push(button('clear', 'Clear', 'cancel-selection', 'btn btn-ghost'));
    if (why) items.push(text('reason', why, 'prompt-why'));
  } else if (mode.kind === 'target') {
    state = 'target';
    items.push(text('why', mode.hint));
    items.push(button('cancel', 'Cancel', 'cancel-targeting', 'btn btn-ghost'));
  } else if (mode.kind === 'strip' && mode.card) {
    state = 'card';
    const card = mode.card;
    const bankable = card.type !== 'property' && card.type !== 'wild_property';
    const playable = card.type !== 'money';       // money has exactly one move
    const reason = playable ? sel.blockedReason(card) : '';
    items.push(text('why', cardName(card)));
    if (playable) {
      // §P7.3: NOT disabled. A disabled button is the deadest possible refusal —
      // no shake, no cue, no haptic, no sentence. It stays live and refuses out
      // loud through interact.refuse(), so the player learns why.
      items.push(button('play', 'Play', 'play-card',
        `btn btn-primary${reason ? ' is-refusing' : ''}`,
        reason ? { title: reason } : {}));
    }
    if (bankable) {
      items.push(button('bank', `Bank ${card.value}M`, 'bank-card',
        playable ? 'btn' : 'btn btn-primary'));
    }
    items.push(button('details', 'Details', 'card-details'));
    items.push(button('cancel', 'Cancel', 'cancel-selection', 'btn btn-ghost'));
    if (reason) items.push(text('reason', reason, 'prompt-why'));
  } else if (snap && snap.phase === 'finished') {
    state = 'finished';
    finishedItems(snap, items);
  } else if (snap && snap.phase === 'playing') {
    // ── the states that used to render an empty bar ──────────────────────
    if (snap.pendingAction) {
      state = 'hold';
      pendingElsewhereItems(snap, items);
    } else if (snap.currentPlayerId === store.self.id) {
      state = 'myturn';
      myTurnItems(snap, items);
    } else {
      state = 'waiting';
      waitingItems(snap, items);
    }
    // The standings and the ruleset ride only the idle states: during a decision
    // the bar is asking a question and a scoreboard chip beside the answer buttons
    // is exactly the noise §5 warns about.
    if (state !== 'hold') items.push(rulesetChip());
    items.push(leaderChip());
  }

  const list = items.filter(Boolean);
  setHidden($('btn-draw'), true);

  if (!list.length) { setHidden(bar, true); setAttr(bar, 'data-state', null); paint(bar, []); return; }
  // The design agent owns every rule in public/style/; `data-state` is the hook
  // that lets a waiting bar be quieter material than a bar demanding an answer,
  // without this module knowing anything about how.
  setAttr(bar, 'data-state', state);
  paint(bar, list);
  setHidden(bar, false);
}

/* ── a floor for the classes this file invents ────────────────────────────
 *
 * public/style/ belongs to the design agent and the bar's material is theirs to
 * set. These rules exist only so the states added in P9 are not INVISIBLE while
 * that work lands: an unstyled `.chip is-alarm` beside an unstyled
 * `.chip is-waiting` is two identical grey pills, and "am I under attack" then
 * has the same appearance as "nothing is happening", which is the whole defect.
 * Everything here is a token, nothing here is a colour, and every rule is one
 * the design agent can override from a stylesheet with no !important anywhere.
 */
const CSS = `
/* The bar is now on screen for the WHOLE game, where it used to appear only
   during a decision, so its idle states have to cost as little vertical space
   as a line of type can. Measured: 33px desktop / 55px phone in myturn and
   waiting, against 54px / 122px when it is actually asking a question. The
   decision states are deliberately NOT shrunk — that is the one moment the bar
   is allowed to take room. Everything here is overridable; public/style/ owns
   the material. */
#prompt[data-state="waiting"],#prompt[data-state="myturn"],#prompt[data-state="hold"],
#prompt[data-state="finished"]{padding-block:.14em}
#prompt[data-state="waiting"] .prompt-text,#prompt[data-state="hold"] .prompt-text,
#prompt[data-state="finished"] .prompt-text{font-size:.94em}
#prompt .prompt-turn{font-weight:800;letter-spacing:.08em;white-space:nowrap}
#prompt .prompt-turn.is-mine{background:var(--accent);color:var(--act-fg);border-color:transparent}
#prompt .prompt-turn.is-alarm{background:var(--danger);color:var(--act-fg);border-color:transparent}
#prompt .prompt-plays.is-spent{opacity:.62}
/* The ruleset name is context, not news: quieter than everything beside it, and it
   sits before the standings so .prompt-lead's margin-left:auto still parks the
   scoreboard on the right. */
#prompt .prompt-ruleset{opacity:.72;letter-spacing:.06em;white-space:nowrap}
#prompt .prompt-lead{margin-left:auto}
#prompt .prompt-lead.is-hot{box-shadow:inset 0 0 0 2px var(--danger)}
#prompt .prompt-text.is-attack{font-weight:800}
#prompt .prompt-why.is-deadline{font-weight:700}
`;

function ensureStyle() {
  if (document.getElementById('chud-prompt-style')) return;
  const style = document.createElement('style');
  style.id = 'chud-prompt-style';
  style.textContent = CSS;                          // text, never HTML (§0.4)
  document.head.appendChild(style);
}

/* ── reconcile, never rebuild ──────────────────────────────────────────── */

function make(item) {
  const node = document.createElement(item.tag);
  node.dataset.key = item.key;
  if (item.id) node.id = item.id;
  if (item.action) node.dataset.action = item.action;
  if (item.tag === 'button') node.type = 'button';
  if (item.ring) node.appendChild(el('span', { class: 'timer-text', attrs: { id: `${item.id}-text` } }));
  return node;
}

function update(node, item) {
  if (node.className !== item.cls) node.className = item.cls || '';
  // The ring's text is written per tick by ui/deadline.js; never clobber it here.
  if (!item.ring) setText(node, item.text ?? '');
  if (item.action && node.dataset.action !== item.action) node.dataset.action = item.action;
  setAttr(node, 'title', item.title || null);
  // Never disabled (§P7.3) — a refusal must be able to speak.
  if (node.tagName === 'BUTTON' && node.disabled) node.disabled = false;
}

/**
 * Make `bar`'s children equal `items`, keeping every node whose key survives.
 * A node that survives keeps its identity, so a tap that started on it before a
 * broadcast still lands on it after.
 */
function paint(bar, items) {
  const have = new Map();
  for (const node of bar.children) if (node.dataset.key) have.set(node.dataset.key, node);

  let cursor = bar.firstChild;
  for (const item of items) {
    const node = have.get(item.key) || make(item);
    update(node, item);
    if (node === cursor) { cursor = cursor.nextSibling; continue; }
    bar.insertBefore(node, cursor);
  }

  const keep = new Set(items.map(i => i.key));
  for (const node of [...bar.children]) if (!keep.has(node.dataset.key)) node.remove();
}

export function mount() {
  ensureStyle();
  // Both are this agent's modules and neither is reachable from main.js, which
  // is not ours to edit; the bar is their natural owner because every one of
  // them exists to answer a question the bar is asked.
  deadline.mount();
  feed.mount();

  pointer.registerActions({
    'respond-accept': () => send.respond('accept'),
    'respond-opsec': () => { send.respond('opsec'); interact.reset(); },
    'begin-payment': () => interact.beginPayment(sel.owedAmount()),
    'pay-all': () => { interact.selectAllPayable(); interact.confirmPayment(); },
    'discard-cheapest': () => interact.suggestDiscard(),
    'card-details': () => details.show(mode.card),
  });
  bus.on(EVENTS.UI_DETAILS, (cardId) => details.show(sel.findCard(cardId)));
  bus.on(EVENTS.INTERACT_CHANGED, render);
  bus.on(EVENTS.STATE_APPLIED, (payload) => { syncWinHold(payload); render(); });
  // The choreographer's word, not the store's (§P7.1): `win`/`stalemate` are the
  // last events it plays, so the ending line waits for them the way the overlay
  // and the HUD do.
  bus.on(EVENTS.CHOREO_EVENT, (ev) => {
    if (ev?.t === 'win' || ev?.t === 'stalemate') releaseWin(CELEBRATION_MS);
  });
  // The waiting copy names the seat that is playing and counts its plays down,
  // and the choreographer is what makes that true on the felt — repainting on
  // its word keeps the bar with the cards rather than ahead of them, the same
  // rule ui/hud.js's narration follows. It is also the belt-and-braces release
  // for an ending whose cue a catch-up drain swallowed.
  bus.on(EVENTS.CHOREO_IDLE, () => { releaseWin(CELEBRATION_MS); render(); });
}
