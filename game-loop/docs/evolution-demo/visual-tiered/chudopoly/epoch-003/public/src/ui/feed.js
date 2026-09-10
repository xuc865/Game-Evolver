// ui/feed.js — the running account of what just happened, on the table.
//
// WHY A THIRD SURFACE IS NOT WHAT THIS IS.
//
// The client already had two places the game is written down: ui/journal.js's
// #log drawer, and its three announcements. Playing a real animated game
// against the shipped bots showed why neither lands:
//
//   • THE DRAWER IS SHUT. #side is hidden until you press the log button, and a
//     player watching cards fly does not press it. Measured over a 100s session:
//     between two of my turns, `Bandit` went from 0M to 8M and put three
//     properties on the table in under four seconds, and the ONLY trace of that
//     anywhere on screen was two numbers changing in a 12px chip.
//   • THE ANNOUNCEMENTS ARE THREE EVENTS. journal.js announceFor() fires for
//     final_approach, final_approach_broken and set_stolen — deliberately, and
//     correctly: "an announcement for everything is an announcement for
//     nothing". But that leaves the entire ordinary stream — every charge, every
//     payment, every steal, every block, every completed set — with no on-table
//     representation at all.
//
// So the gap is not a missing log. It is the missing MIDDLE between "silent"
// and "go and read something": a few transient lines, in the sentence-fragment
// register a scoreboard uses, that appear where you are already looking and
// take themselves away. Nothing here is scrollable, nothing here is a record —
// journal.js is still the record, and its copy is deliberately longer and
// fuller than this. This is the peripheral-vision version.
//
// It rides EVENTS.CHOREO_EVENT, not the snapshot, so a line lands WITH the card
// it describes rather than a few hundred milliseconds before it (the same rule
// ui/hud.js's narration hold and journal.js's announcements follow).
//
// TWO THINGS THIS ALSO FIXES:
//   • `response_timeout` and `turn_timeout` — the two events the server emits
//     when it makes a decision FOR a player — are not in journal.js's describe()
//     switch, so they return null and are dropped on the floor by the one screen
//     built to explain them. They are the loudest lines in this file, because a
//     board change nobody chose is the one that must be narrated (§6 agency).
//   • The "what did I miss?" problem. Beats are also accumulated by `seq` so
//     ui/prompt.js can open your turn with one line about everything that
//     happened while you were waiting.

import { $, el, setClass } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { store, seatName } from '../state/store.js';
import { colorName, cardName } from '../core/cards.js';

/* ── copy ─────────────────────────────────────────────────────────────────
 *
 * Fragment register: no full stops, no subordinate clauses, ≤ ~7 words. These
 * are read at a glance out of the corner of an eye while cards are moving, and
 * journal.js's full sentences measured at 90–140 characters — three lines on a
 * 390px phone, which is a paragraph, not a beat.
 */

const ACTION_TITLE = {
  rent: 'Rent', finance_office: 'Finance Office', roll_call: 'Roll Call',
  midnight_requisition: 'Midnight Req', chud: 'THE CHUD CARD',
  inspector_general: 'Inspector General', tdy_orders: 'TDY Orders',
  opsec: 'OPSEC', upgrade: 'Upgrade', foc: 'FOC', surge_ops: 'Surge Ops',
  pcs_orders: 'PCS Orders',
};

/** Weight decides how long a line lives and how loud it looks.
 *  'hit'  — it happened TO me
 *  'big'  — it changes who is winning
 *  'note' — ordinary table texture */
const LIFE = { hit: 7200, big: 6000, note: 4200 };

function title(ev) { return ACTION_TITLE[ev.action] || ev.action || 'a card'; }

/** Action cards whose effect arrives as its own event a beat later, so the
 *  "X played Y" line would only ever be the first half of a stutter. OPSEC is
 *  here for the same reason: game.js emits `opsec` right behind it. */
const SELF_NARRATING = new Set([
  'opsec', 'finance_office', 'roll_call', 'rent',
  'midnight_requisition', 'chud', 'inspector_general', 'tdy_orders',
]);

/**
 * Is the prompt bar already saying this, in bigger type, with a countdown?
 * ui/prompt.js states the pending action in full for the seat that has to
 * answer it, so the feed echoing the same charge one line above is noise at the
 * exact moment noise costs the most.
 */
function ownedByThePrompt(ev) {
  const snap = store.snapshot;
  const me = store.self.id;
  if (!snap?.pendingAction || !(snap.responders || []).includes(me)) return false;
  if (ev.t === 'demand') return ev.target === me;
  if (ev.t === 'rent_charged') return (ev.targets || []).includes(me);
  return false;
}

/**
 * The surge on a charge, as the number the engine used. game.js chargeAmount()
 * (994-1000) returns `2 ** stack`, and `multiplier` now travels on `rent_charged`
 * and `demand`; an older broadcast carries only `doubled`, and the honest thing to
 * say about a boolean is that it surged, not by how much.
 */
function surgeMark(ev) {
  if (!ev?.doubled) return '';
  const m = Number(ev.multiplier);
  return Number.isFinite(m) && m > 1 ? ` ×${m}` : ' SURGED';
}

/**
 * One engine event → one glanceable line, or null for "not worth a line".
 * @returns {{text:string, mark:string, weight:'hit'|'big'|'note', color?:string}|null}
 */
function line(ev) {
  const me = store.self.id;
  const isMe = (id) => id != null && id === me;
  const who = (id) => (isMe(id) ? 'You' : seatName(id));
  // OBJECT position. "Phantom paid You 6M" and "took a card from You" are the same
  // defect as the verb one below: `who()` is a SUBJECT, and a feed that names the
  // reader has to decline it. Measured across a full game, up to 25 lines a game
  // came out ungrammatical.
  const whom = (id) => (isMe(id) ? 'you' : seatName(id));
  const whose = (id) => (isMe(id) ? 'your' : `${seatName(id)}'s`);
  // THIRD-PERSON -s, or not, depending on whether the subject is the reader.
  // "You charges Phantom 5M" shipped on every demand and every rent charge — 25
  // chances a game in the measured session — because these two lines are the only
  // ones in the whole vocabulary written in the PRESENT tense. ui/journal.js has
  // carried this helper since it was measured saying "You is on FINAL APPROACH".
  const s3 = (id, verb) => (isMe(id) ? verb : `${verb}s`);
  const hit = (id) => (isMe(id) ? 'hit' : 'note');

  switch (ev.t) {
    /* the two decisions nobody chose — §6, and the loudest lines here */
    case 'response_timeout':
      return isMe(ev.actor)
        ? { mark: '⏰', weight: 'hit',
          text: ev.amount > 0
            ? `Your ${ev.timeout || ''}s ran out — ${ev.amount}M accepted and paid for you`
            : `Your ${ev.timeout || ''}s ran out — accepted for you` }
        : { mark: '⏰', weight: 'note', text: `${who(ev.actor)} ran out of time — auto-accepted` };
    case 'turn_timeout':
      return isMe(ev.actor)
        ? { mark: '⏰', weight: 'hit',
          text: `Your turn ran out — ended for you`
            + (ev.discarded ? `, ${ev.discarded} discarded` : '') }
        : { mark: '⏰', weight: 'note', text: `${who(ev.actor)}'s turn ran out` };

    /* charges and answers */
    // `×2` was hard-coded off the boolean `doubled`, one line under the engine's own
    // "SURGED x4" log line, because chargeAmount() (game.js:994-1000) multiplies by
    // 2**stack and only the boolean was on the wire. `multiplier` ships on both
    // events now; surgeMark() reads it and falls back for an older broadcast.
    case 'demand':
      return { mark: '⇢', weight: hit(ev.target),
        text: `${who(ev.actor)} ${s3(ev.actor, 'charge')} ${whom(ev.target)} ${ev.amount}M`
          + surgeMark(ev) + ` — ${title({ action: ev.reason })}` };
    case 'rent_charged':
      return { mark: '⇢', weight: (ev.targets || []).includes(me) ? 'hit' : 'note', color: ev.color,
        text: `${who(ev.actor)} ${s3(ev.actor, 'charge')} ${ev.amount}M rent on `
          + `${colorName(ev.color)}` + surgeMark(ev) };
    case 'payment':
      return { mark: '→', weight: isMe(ev.from) ? 'hit' : 'note',
        text: `${who(ev.from)} paid ${whom(ev.to)} ${ev.total}M` };
    case 'insolvent':
      return { mark: '∅', weight: hit(ev.from),
        text: `${who(ev.from)} had nothing to pay with — debt written off` };
    case 'opsec':
      return { mark: '⛨', weight: 'big',
        text: `${who(ev.actor)} played OPSEC on ${title(ev)}` };
    case 'action_blocked':
      return { mark: '⛨', weight: isMe(ev.source) ? 'hit' : 'big',
        text: `${whose(ev.source)} ${title(ev)} was BLOCKED` };

    /* things taken */
    case 'steal':
      return { mark: '✂', weight: hit(ev.from), color: ev.toColor,
        text: `${who(ev.actor)} took ${cardName(ev.card)} from ${whom(ev.from)}` };
    case 'set_stolen':
      return { mark: '✂', weight: isMe(ev.from) ? 'hit' : 'big', color: ev.color,
        text: `${who(ev.actor)} SEIZED ${whose(ev.from)} ${colorName(ev.color)} set` };
    case 'swap':
      return { mark: '⇄', weight: hit(ev.target),
        text: `${who(ev.actor)} swapped ${cardName(ev.gave)} for ${whose(ev.target)} ${cardName(ev.took)}` };
    case 'scoop':
      return { mark: '☠', weight: 'big', text: `${who(ev.actor)} SCOOPED OUT` };

    /* the race */
    // "— 1 sets" shipped on every FIRST completed set, which is most of them.
    // Same defect family as s3()/whom() above: a count in a template needs its
    // noun declined.
    case 'set_completed':
      return { mark: '★', weight: 'big', color: ev.color,
        text: `${who(ev.actor)} completed ${colorName(ev.color)} — ${ev.total} set${ev.total === 1 ? '' : 's'}` };
    // WHOSE turns. `opponentTurnsRemaining` counts turns by OTHER players before
    // the converting turn (game.js opponentTurnsRemaining / checkpointForecast)
    // — "hold 3 sets for 2 more turns" read as two of YOUR turns, which under
    // the full-cycle rule is exactly the misreading the engine's
    // final_approach_pending narration exists to correct.
    case 'final_approach': {
      const n = ev.opponentTurnsRemaining;
      return { mark: '⚑', weight: 'big',
        text: isMe(ev.actor)
          ? `FINAL APPROACH — hold ${ev.sets} set${ev.sets === 1 ? '' : 's'} for ${n ?? '?'} more enemy turn${n === 1 ? '' : 's'}`
          : `${who(ev.actor)} on FINAL APPROACH — ${n ?? '?'} turn${n === 1 ? '' : 's'} to break them` };
    }
    case 'final_approach_broken':
      return { mark: '✖', weight: isMe(ev.actor) ? 'hit' : 'big',
        text: `${whose(ev.actor)} final approach BROKEN${ev.by ? ` by ${whom(ev.by)}` : ''}` };
    case 'final_approach_pending':
      return { mark: '⧗', weight: 'big',
        text: `${whose(ev.actor)} approach did not convert this turn` };
    // §3.10b contested approach (game.js syncContest / resolveFinalApproach).
    // The held win is the line that happened TO its owner; open/close are race
    // state the whole table needs, same register as final_approach.
    case 'contest_open':
      return { mark: '⚔', weight: 'big',
        text: `CONTESTED — ${(ev.actors || []).map(who).join(' and ')} armed at once` };
    case 'contest_held':
      return { mark: '⚔', weight: isMe(ev.actor) ? 'hit' : 'big',
        text: `${whose(ev.actor)} win held — ` + (ev.reason === 'escalate'
          ? `bar now ${ev.bar ?? '?'} sets` : 'approach contested') };
    case 'contest_closed': {
      const left = Array.isArray(ev.actors) && ev.actors.length === 1 ? ev.actors[0] : null;
      return { mark: '⚔', weight: 'big',
        text: left ? `Contest over — ${who(left)} still armed` : 'Contest over — nobody armed' };
    }

    /* ordinary table texture */
    case 'play_money':
      return { mark: '$', weight: 'note', text: `${who(ev.actor)} banked ${ev.card?.value ?? 0}M` };
    case 'play_property':
      return { mark: '▪', weight: 'note', color: ev.color,
        text: `${who(ev.actor)} played ${cardName(ev.card)}` };
    case 'banked_property':
      return { mark: '$', weight: hit(ev.actor),
        text: `${whose(ev.actor)} ${cardName(ev.card)} had no set left — banked` };
    case 'play_action':
      // Most action cards are followed within a few events by the beat that
      // says what they DID — demand, rent_charged, steal, swap, set_stolen, or
      // opsec/action_blocked if they were stopped. Printing both gives
      // "Jester played Finance Office" immediately above "Jester charges You
      // 5M — Finance Office", which is the same sentence twice in a four-line
      // feed. Measured on the 390×844 phone take. Only the cards whose whole
      // effect is the play itself get a line here.
      return SELF_NARRATING.has(ev.action) ? null
        : { mark: '!', weight: 'note', text: `${who(ev.actor)} played ${title(ev)}` };
    case 'upgrade':
      return { mark: '▲', weight: 'note', color: ev.color,
        text: `${who(ev.actor)} added ${cardName(ev.card)} to ${colorName(ev.color)}` };
    case 'upgrade_banked':
      return { mark: '▽', weight: hit(ev.actor), color: ev.color,
        text: `${whose(ev.actor)} ${colorName(ev.color)} broke — ${cardName(ev.card)} banked` };
    case 'move_property':
    case 'move_upgrade':
      return { mark: '↔', weight: 'note', color: ev.to,
        text: `${who(ev.actor)} moved ${cardName(ev.card)} to ${colorName(ev.to)}` };
    case 'discard':
      return { mark: '▾', weight: 'note',
        text: `${who(ev.actor)} discarded ${(ev.cards || []).length} at the hand limit` };
    case 'turn_restart':
      return { mark: '↻', weight: 'note', text: `${whose(ev.actor)} turn restarted` };
    case 'shuffle':
      return { mark: '↻', weight: 'note', text: `Discard reshuffled — cycle ${ev.cycle ?? '?'}` };
    default:
      // deal / draw / turn_start / turn_end / game_start / win / stalemate:
      // either invisible bookkeeping or already owned by a bigger screen
      // (ui/overlays.js takes the ending, and it must not be pre-empted here).
      return null;
  }
}

/* ── the layer ────────────────────────────────────────────────────────────
 *
 * ZERO HEIGHT, ON PURPOSE. The stack is absolutely positioned inside a
 * height:0 host that sits in normal flow immediately above #prompt, so it is
 * anchored to the bar wherever the layout puts it and CANNOT move the table
 * when a line arrives. ui/hud.js documents what the alternative costs: a strip
 * that grew when it had something to say pushed the whole felt down 28–42px at
 * the exact moment the player was being told to read it.
 */
/* ── A BEAT IS A MARKING, NOT A PILL (§P9 FEEL round 4) ────────────────────
 *
 * The first cut of this stylesheet drew each line as a rounded, bordered,
 * shadowed plate floating over the felt, and landed it on the discard pile —
 * §3.7's named anti-pattern ("floating hint pills over the board"), which the
 * design agent had removed from the coach layer one round earlier. They had to
 * put the correction in content.css, behind an extra class (`.feed-stack
 * .feed-row`) purely to out-specify these rules, because this <style> is
 * injected into <head> AFTER their stylesheet and would otherwise win the tie.
 *
 * A module that has to be corrected from another agent's file is a module that
 * does not own its own look. Their verdict is folded in here verbatim and the
 * override can go:
 *
 *   MATERIAL  painted ON the apron, in the apron's own colour with a dashed
 *             stencil edge, exactly like .hint-card. The weight rail stays —
 *             it is the only thing carrying note/big/hit in grayscale — but as
 *             a hazard-width stencil rule, not a pill's rounded border.
 *   PLACE     on a wide screen it leaves the table entirely for the ~350×130 of
 *             dead concrete in the dock between the hand bar and the fan, the
 *             one region of that viewport nothing is ever placed on. On a phone
 *             there is no such column, so the feed becomes a ONE-LINE TICKER:
 *             MEASURED on five-player@phone, a three-row stack stood on the
 *             whole second row of the player's own mats and the buried-text
 *             count for that shot alone was 22. The rows are still built and
 *             still timed out — nothing above this comment changes — only the
 *             last one is shown.
 *
 * Tokens, not colours, and CARD tokens are not APP tokens: the very first cut
 * used --ink (dark stock ink, a card token) and rendered dark grey on the dark
 * apron, invisible in every frame of the play session it was built from.
 * --danger / --hazard-fine is hazard MATERIAL and is only ever spent on the
 * lines that happened to this player. */
const CSS = `
#chud-feed{position:relative;height:0;z-index:41}
#chud-feed .feed-stack{position:absolute;left:.5em;right:.5em;bottom:.3em;
  display:flex;flex-direction:column;align-items:flex-start;gap:.18em;
  pointer-events:none}
#chud-feed .feed-row{display:flex;align-items:baseline;gap:.42em;
  max-width:100%;padding:.3em .6em;border:0;border-radius:0;box-shadow:none;
  font:700 .82em/1.3 var(--font-body,system-ui,sans-serif);
  letter-spacing:.01em;color:var(--fg,#14161A);
  background:
    linear-gradient(var(--stencil-hi),var(--stencil-hi)) 0 0/3px 100% no-repeat,
    repeating-linear-gradient(90deg,var(--stencil-hi) 0 8px,transparent 8px 14px) 0 0/100% 2px no-repeat,
    repeating-linear-gradient(90deg,var(--stencil-hi) 0 8px,transparent 8px 14px) 0 100%/100% 2px no-repeat,
    var(--ground);
  opacity:0;transform:translateY(.3em);
  transition:opacity .16s linear,transform .16s ease-out}
#chud-feed .feed-row.is-in{opacity:1;transform:none}
#chud-feed .feed-row.is-out{opacity:0}
#chud-feed .feed-mark{flex:none;opacity:1;color:var(--fg-mute)}
#chud-feed .feed-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* the rail is the weight: ink for texture, foil for the race, hazard for you */
#chud-feed .feed-row.is-big{
  background:
    linear-gradient(var(--foil),var(--foil)) 0 0/3px 100% no-repeat,
    repeating-linear-gradient(90deg,var(--stencil-hi) 0 8px,transparent 8px 14px) 0 0/100% 2px no-repeat,
    repeating-linear-gradient(90deg,var(--stencil-hi) 0 8px,transparent 8px 14px) 0 100%/100% 2px no-repeat,
    var(--ground)}
#chud-feed .feed-row.is-hit{
  color:var(--fg,#14161A);
  background:
    var(--hazard-fine) 0 0/5px 100% no-repeat,
    repeating-linear-gradient(90deg,var(--stencil-hi) 0 8px,transparent 8px 14px) 0 0/100% 2px no-repeat,
    repeating-linear-gradient(90deg,var(--stencil-hi) 0 8px,transparent 8px 14px) 0 100%/100% 2px no-repeat,
    var(--ground)}
#chud-feed .feed-you{flex:none;font-size:.72em;letter-spacing:0;
  padding:0 .3em;border-radius:0;
  background:var(--danger,#AB2707);color:var(--card-stock,#FBF8F1)}
/* PHONE AND SHORT LANDSCAPE: one line, ~20px tall. The Mission Log has the rest. */
@media (max-width:759px){
  #chud-feed .feed-row:not(:last-child){display:none}
  #chud-feed .feed-row{font-size:.8em;padding:.18em .5em}}
@media (orientation:landscape) and (max-height:560px){
  #chud-feed .feed-row:not(:last-child){display:none}}
/* wide enough for a column, not yet wide enough for the dock's dead concrete */
@media (min-width:760px){#chud-feed .feed-stack{right:auto;max-width:34em}}
/* fixed, not absolute: the host is a height:0 div pinned above #prompt, and the
   dock is the box this belongs in. Bottom-anchored so the newest line is always
   the one nearest the hand. (.hints steps up to share the column — that rule is
   the design agent's and stays in content.css.) */
@media (min-width:1024px){
  #chud-feed.floaters .feed-stack{position:fixed;left:13.2em;right:auto;top:auto;
    bottom:calc(env(safe-area-inset-bottom) + .5em);max-width:21em}}
@media (prefers-reduced-motion:reduce){
  #chud-feed .feed-row{transition:none;transform:none}}
`;

let host = null;
let stack = null;

function ensure() {
  if (stack?.isConnected) return stack;
  if (!document.getElementById('chud-feed-style')) {
    const style = document.createElement('style');
    style.id = 'chud-feed-style';
    style.textContent = CSS;                        // text, never HTML (§0.4)
    document.head.appendChild(style);
  }
  const bar = $('prompt');
  if (!bar?.parentNode) return null;
  // `floaters` on the host as well as `floater` on each row: audit.mjs asks
  // `occluder.closest(VEIL)`, and the occluder is whichever node the hit test
  // lands on — a row, a `.feed-text` inside it, or the stack's own gap. One
  // class on the outermost node makes the whole layer answer the question the
  // same way, wherever inside it the test point falls.
  host = el('div', { id: 'chud-feed', class: 'floaters', attrs: { 'aria-hidden': 'true' } });
  stack = el('div', { class: 'feed-stack' });
  host.appendChild(stack);
  bar.parentNode.insertBefore(host, bar);
  return stack;
}

// Three. Four was measured on a 390×844 phone stacked under ui/hints.js's coach
// card and over the deck and discard piles: the top of the felt had four lines
// of chrome above a bar that already had four of its own, and a peripheral feed
// that has to be READ is not peripheral any more.
const MAX_ROWS = 3;

function push(beat) {
  const box = ensure();
  if (!box) return;
  // `floater` is not decoration and it is not a second class name for style —
  // it is the TAXONOMY this row belongs to, and tools/lib/audit.mjs is the
  // thing that reads it. That file splits text-occlusion findings two ways:
  // a transient layer the player is being shown ON PURPOSE (`.hints`, `#toast`,
  // `.floater`, `.burst`) WARNS, and the layout burying its own content FAILS.
  // Its own header explains why — "gating text on it too would make every phone
  // shot red for the coach layer doing its job and bury the structural finding
  // underneath". A self-dismissing, pointer-events-free notification stack is
  // exactly the first category, and without the class tools/screenshot.mjs
  // reported it as the second (measured: 14 card micro-labels across five
  // shots, gate red). The list is hand-maintained and cannot see a module that
  // did not exist when it was written; the request to key it off `#chud-feed`
  // instead is in this agent's report, and this line goes when that lands.
  const row = el('div', {
    class: `feed-row floater is-${beat.weight}`,
    dataset: beat.color ? { color: beat.color } : {},
  }, [
    el('span', { class: 'feed-mark', attrs: { 'aria-hidden': 'true' }, text: beat.mark }),
    beat.weight === 'hit' ? el('span', { class: 'feed-you', text: 'YOU' }) : null,
    el('span', { class: 'feed-text', text: beat.text }),
  ].filter(Boolean));
  box.appendChild(row);
  requestAnimationFrame(() => setClass(row, 'is-in', true));

  // Oldest out first, so the newest line is never the one that vanishes.
  //
  // Removed SYNCHRONOUSLY, not through retire(): retire() only starts a 200ms
  // fade, so `box.firstElementChild` and `childElementCount` were both still
  // the same on the next pass and this while-loop span the tab to death. It
  // crashed the renderer 10s into the first play session after this file
  // landed ("Target crashed"), which is exactly the sort of thing a feed that
  // only fills up during a fast bot turn hides until it is in front of a
  // player. A line being pushed off the top has no time to fade anyway.
  while (box.childElementCount > MAX_ROWS) {
    const oldest = box.firstElementChild;
    clearTimeout(oldest.__timer);
    oldest.remove();
  }

  row.__timer = setTimeout(() => retire(row), LIFE[beat.weight] || LIFE.note);
}

function retire(row) {
  if (!row) return;
  clearTimeout(row.__timer);
  setClass(row, 'is-out', true);
  setTimeout(() => row.remove(), 200);
}

export function clearAll() {
  if (!stack) return;
  for (const row of [...stack.children]) { clearTimeout(row.__timer); row.remove(); }
}

/* ── "what did I miss?" ───────────────────────────────────────────────────
 *
 * The transient rows answer "what just happened". They cannot answer "what
 * happened in the ninety seconds I was not looking", so the beats are also
 * accumulated by `seq` — the same merge ui/journal.js does, for the same reason
 * (the server ships a 120-event tail and a real game is far longer than that) —
 * and ui/prompt.js opens your turn with one line drawn from them.
 */
const since = [];          // beats since MY last turn started
let maxSeq = 0;
/** seq of my turn_start → the summary of what happened before it. Computed at
 *  INGEST because that is the only moment `since` still holds the right window,
 *  and spent later at CHOREO time so the line lands with the turn, not with the
 *  broadcast that is still several hundred milliseconds ahead of the felt. */
const missedAt = new Map();

function ingest(snapshot) {
  const tail = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const seq = Number(snapshot?.eventSeq) || 0;
  if (seq && seq < maxSeq) { since.length = 0; maxSeq = 0; missedAt.clear(); }
  for (const ev of tail) {
    if (!ev || typeof ev.seq !== 'number' || ev.seq <= maxSeq) continue;
    maxSeq = ev.seq;
    if (ev.t === 'game_start') { since.length = 0; missedAt.clear(); continue; }
    // My own turn starting is the fence: everything before it is "while I was
    // waiting", everything after is mine and I watched it happen.
    if (ev.t === 'turn_start' && ev.actor === store.self.id) {
      const summary = missedSummary();
      if (summary) missedAt.set(ev.seq, summary);
      // Only the most recent handful can still be waiting on the choreographer.
      if (missedAt.size > 4) missedAt.delete(missedAt.keys().next().value);
      since.length = 0;
      continue;
    }
    since.push(ev);
    if (since.length > 200) since.shift();
  }
}

/**
 * One line summarising everything since my last turn began — the answer to the
 * question a player asks every single time control comes back to them.
 * @returns {string} '' when nothing worth reporting happened.
 */
export function missedSummary() {
  const me = store.self.id;
  if (!me || !since.length) return '';
  const bits = [];
  let paid = 0;
  let lost = 0;
  const completedBy = new Map();

  for (const ev of since) {
    switch (ev.t) {
      case 'payment': if (ev.from === me) paid += ev.total || 0; break;
      case 'steal': if (ev.from === me) lost++; break;
      case 'set_stolen': if (ev.from === me) bits.push(`lost your whole ${colorName(ev.color)} set`); break;
      case 'swap': if (ev.target === me) lost++; break;
      case 'insolvent': if (ev.from === me) bits.push('you had nothing left to pay with'); break;
      case 'response_timeout': if (ev.actor === me) bits.push('your answer clock ran out'); break;
      case 'set_completed':
        if (ev.actor !== me) completedBy.set(ev.actor, (completedBy.get(ev.actor) || 0) + 1);
        break;
      case 'final_approach':
        if (ev.actor !== me) bits.push(`${seatName(ev.actor)} is on FINAL APPROACH`);
        break;
      case 'final_approach_broken':
        if (ev.actor === me) bits.push('your final approach was broken');
        break;
      case 'action_blocked': if (ev.source === me) bits.push('your card was blocked by OPSEC'); break;
      default: break;
    }
  }

  if (paid > 0) bits.unshift(`you paid out ${paid}M`);
  if (lost > 0) bits.unshift(`you lost ${lost} propert${lost === 1 ? 'y' : 'ies'}`);
  for (const [id, n] of completedBy) bits.push(`${seatName(id)} completed ${n} set${n === 1 ? '' : 's'}`);

  if (!bits.length) return '';
  // Three clauses is the most a single glanceable line can carry.
  const head = bits.slice(0, 3).join(' · ');
  return bits.length > 3 ? `${head} · +${bits.length - 3} more` : head;
}

/* ── wiring ───────────────────────────────────────────────────────────── */

export function mount() {
  ensure();
  bus.on(EVENTS.STATE_APPLIED, ({ snapshot, snap }) => {
    ingest(snapshot);
    // A snapped state (reconnect, fixture, rematch) performs nothing, so there
    // is nothing to narrate and the lines would all be about a past the player
    // never saw.
    if (snap) clearAll();
  });
  bus.on(EVENTS.STATE_SCREEN, (screen) => { if (screen !== 'game') clearAll(); });
  bus.on(EVENTS.CHOREO_EVENT, (ev) => {
    if (!ev || store.screen !== 'game') return;
    // "What did I miss?" — asked, and answered, at the exact moment control
    // comes back. This is the one line in the client that summarises a stretch
    // of the game rather than a single beat, and it exists because bot turns
    // resolve in seconds and there was previously no trace of them anywhere a
    // player would look.
    if (ev.t === 'turn_start' && ev.actor === store.self.id) {
      const summary = missedAt.get(ev.seq);
      if (summary) {
        missedAt.delete(ev.seq);
        push({ mark: '↩', weight: 'hit', text: `While you waited: ${summary}` });
      }
      return;
    }
    if (ownedByThePrompt(ev)) return;
    const beat = line(ev);
    if (beat) push(beat);
  });
}
