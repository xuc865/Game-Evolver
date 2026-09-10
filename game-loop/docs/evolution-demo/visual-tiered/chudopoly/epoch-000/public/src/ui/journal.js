// ui/journal.js — the game record the player can actually read.
//
// OWNER (P8): they lost a final approach they thought they had won and could
// not reconstruct what happened, from the UI or afterwards. The Mission Log was
// a 40-line prose tail in a drawer that is CLOSED BY DEFAULT, so the decisive
// beat — someone breaking your approach, a payment costing you a set card —
// scrolled past unseen while the animation was still running.
//
// Three things here, in the order they matter:
//
//   1. ACCUMULATION. `getPlayerView` ships the last 120 events and the last 40
//      log lines. A long game is far more than that (measured: a 3-player
//      seeded game runs 900–2,600 events), so a client that renders the tail
//      renders a keyhole. Every broadcast is merged by `seq` — monotonic per
//      game — so the journal is the whole game even though no single snapshot
//      is. Gaps (reconnect, a missed broadcast) are RECORDED as gaps rather
//      than papered over; a log that quietly omits things is the exact failure
//      being fixed.
//   2. BEATS, NOT PROSE. Built from `game.events` (§4's structured channel), so
//      each beat knows its actor, its cards and its weight. Set completions,
//      arming, disarming, steals, whole-set seizures, OPSEC blocks, insolvency
//      and the ending are TURNING POINTS and look nothing like a bank or a
//      draw. game.log's prose is kept as a secondary transcript for the handful
//      of lines that have no event (upgrades banked on a break, etc.).
//   3. THE DISARM IS UNMISSABLE. `final_approach_broken` is the specific event
//      that burned the owner, so it also fires a full-width announcement over
//      the felt that does not need the drawer to be open.
//
// Cards named in a beat are real faces through the shipped renderer (the same
// route ui/discard.js takes) and carry `data-peek-card`, so any card in the log
// is readable without leaving it.

import { $, el, clear, setClass, setText, setAttr } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { store, seatName } from '../state/store.js';
import { colorName, cardName, COLORS } from '../core/cards.js';
import { buildFace, refresh } from '../table/cardnode.js';
import * as pointer from '../interact/pointer.js';
import { openSheet, sheetOpen } from './screens.js';
import { detailBody } from './details.js';
import * as recorder from '../state/recorder.js';
import { stats } from '../state/stats.js';

/* ── the record ───────────────────────────────────────────────────────────── */

const MAX_BEATS = 900;           // ~a 400-turn game; 24 bytes-ish per beat
const beats = [];                // {seq, ev, turn}
let maxSeq = 0;
let gaps = 0;                    // broadcasts whose tail did not reach maxSeq+1
let turn = 0;

export function reset() {
  beats.length = 0;
  maxSeq = 0;
  gaps = 0;
  turn = 0;
  // The logbook's per-game latch hangs off the same reset the record does: a
  // rematch reuses the room code AND restarts `eventSeq`, so "a new game began"
  // is a fact only this module holds. See state/recorder.js `newGame()`.
  recorder.newGame();
}

/**
 * Merge a broadcast's event tail. Idempotent, ordered, and honest about gaps.
 *
 * EXPORTED for test/stats-logbook.test.js, which replays real games out of
 * `logs/games.jsonl` a broadcast at a time. The logbook is folded from this
 * accumulator, so a test that reimplemented the merge would be proving a copy
 * correct rather than this. The rest of the client still reaches it only via the
 * STATE_APPLIED subscription in `mount()`.
 */
export function ingest(snapshot) {
  const tail = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const seq = Number(snapshot?.eventSeq) || 0;
  // A rematch restarts `eventSeq` at 0; so does a different room.
  if (seq && seq < maxSeq) reset();
  if (!tail.length) return;
  if (maxSeq > 0 && tail[0].seq > maxSeq + 1) gaps++;
  for (const ev of tail) {
    if (!ev || typeof ev.seq !== 'number' || ev.seq <= maxSeq) continue;
    if (ev.t === 'game_start') { reset(); }
    if (ev.t === 'turn_start') turn++;
    beats.push({ seq: ev.seq, ev, turn });
    maxSeq = Math.max(maxSeq, ev.seq);
  }
  if (beats.length > MAX_BEATS) beats.splice(0, beats.length - MAX_BEATS);
}

export function entries() { return beats; }
export function gapCount() { return gaps; }

/* ── weights ──────────────────────────────────────────────────────────────── */

// TURNING POINTS: the beats that change who is winning. These are what the
// owner could not find. Everything else is texture.
const TURNING = new Set([
  'final_approach', 'final_approach_broken', 'final_approach_pending',
  'contest_open', 'contest_held', 'contest_closed',
  'set_completed', 'set_stolen',
  'steal', 'swap', 'scoop', 'win', 'stalemate', 'insolvent', 'action_blocked',
]);
const ATTACK = new Set(['rent_charged', 'demand', 'payment', 'opsec', 'play_action']);
// `final_approach_pending` is NOT texture. game.js resolveFinalApproach()
// (495-521) emits it at the exact moment a real player reported as "I had 3
// sets, I finished my turn, and someone else won" — an armed own-turn that
// falls INSIDE the grace window and does not convert. It is the engine's own
// answer to the most confusing moment in the game, and it was being dropped on
// the floor by the one screen built to explain that moment.
const SKIP = new Set(['deal', 'turn_start', 'turn_end', 'draw']);

function weight(t) {
  if (TURNING.has(t)) return 'turn';
  if (ATTACK.has(t)) return 'attack';
  return 'routine';
}

/* ── beat copy ────────────────────────────────────────────────────────────── */

const who = (id) => seatName(id);
const ACTION_TITLE = {
  rent: 'Rent', finance_office: 'Finance Office', roll_call: 'Roll Call',
  midnight_requisition: 'Midnight Requisition', chud: 'THE CHUD CARD',
  inspector_general: 'Inspector General', tdy_orders: 'TDY Orders',
  opsec: 'OPSEC', upgrade: 'Upgrade', foc: 'FOC', surge_ops: 'Surge Operations',
  pcs_orders: 'PCS Orders',
};

/** The surge multiplier the engine actually used. `doubled` alone cannot say it:
 *  chargeAmount() (game.js:994-1000) multiplies by 2**stack, and `multiplier` now
 *  travels on `rent_charged` and `demand`. */
function surgeNote(ev) {
  if (!ev?.doubled) return '';
  const m = Number(ev.multiplier);
  return Number.isFinite(m) && m > 1 ? ` (SURGED ×${m})` : ' (SURGED)';
}

/** What an OPSEC depth means, in words. `depth` is respondToAction()'s counter
 *  (game.js:1283-1285): odd = the defender's block is on top, even = the
 *  attacker's counter is. Depth 1 is the ordinary case and needs no rider. */
function opsecChainNote(ev) {
  const depth = Number(ev?.depth) || 0;
  if (depth <= 1) return '';
  return depth % 2 === 0
    ? ' — countering the block'
    : ' — countering the counter';
}

/**
 * One event → a readable line plus the cards it involved.
 * @returns {{text:string, cards:Array, mark:string, color:string|null}|null}
 *   null means "no beat for this event" (the ones SKIP covers, or a shape the
 *   client does not recognise — an unknown event is never invented into prose).
 */
function describe(ev) {
  const me = store.self.id;
  const mine = (id) => id === me;
  const nameOf = (id) => (mine(id) ? 'You' : who(id));
  // "You's whole Space Force set" and "You is on FINAL APPROACH" both shipped
  // before these existed — measured on the arc fixture.
  const poss = (id) => (mine(id) ? 'your' : `${who(id)}'s`);
  const Poss = (id) => (mine(id) ? 'Your' : `${who(id)}'s`);
  const be = (id) => (mine(id) ? 'are' : 'is');
  const s3 = (id, verb) => (mine(id) ? verb : `${verb}s`);
  switch (ev.t) {
    case 'game_start':
      return { text: 'Game start.', cards: [], mark: '▸' };
    case 'shuffle':
      return { text: `Discard reshuffled into the deck — cycle ${ev.cycle || '?'}, `
        + `${ev.deckCount} cards.`, cards: [], mark: '↻' };
    case 'play_money':
      return { text: `${nameOf(ev.actor)} banked ${cardName(ev.card)}.`, cards: [ev.card], mark: '$' };
    case 'play_property':
      return { text: `${nameOf(ev.actor)} played ${cardName(ev.card)} onto ${colorName(ev.color)}.`,
        cards: [ev.card], mark: '▪', color: ev.color };
    case 'banked_property':
      return { text: `${Poss(ev.actor)} ${cardName(ev.card)} had no legal set left and was `
        + 'banked at face value.', cards: [ev.card], mark: '$' };
    case 'play_action':
      return { text: `${nameOf(ev.actor)} played ${ACTION_TITLE[ev.action] || cardName(ev.card)}.`,
        cards: [ev.card], mark: '!' };
    // "(DOUBLED)" was printed off the boolean `doubled` for every stack depth, so a
    // ×4 surge was logged as DOUBLED directly under the engine's own "SURGED x4"
    // line. chargeAmount() (game.js:994-1000) ships `multiplier` on both events now.
    case 'rent_charged': {
      const n = (ev.targets || []).length;
      return { text: `${nameOf(ev.actor)} charged ${ev.amount}M rent on ${colorName(ev.color)}`
        + surgeNote(ev) + ` — ${n} player${n === 1 ? '' : 's'} billed.`,
      cards: [], mark: '⇢', color: ev.color };
    }
    case 'demand':
      return { text: `${nameOf(ev.actor)} demanded ${ev.amount}M from ${nameOf(ev.target)}`
        + surgeNote(ev) + ` — ${ACTION_TITLE[ev.reason] || ev.reason}.`,
      cards: [], mark: '⇢' };
    // "(depth 1)" is `entry.depth` — an engine counter, printed raw at a player.
    // What the number MEANS is whose card is on top of the chain, and that reads as
    // a sentence: respondToAction() (game.js:1283-1285) makes an odd depth "the
    // defender's block is standing" and an even one "the attacker's counter is".
    case 'opsec':
      return { text: `${nameOf(ev.actor)} played OPSEC against `
        + `${ACTION_TITLE[ev.action] || ev.action}${opsecChainNote(ev)}.`,
      cards: ev.card ? [ev.card] : [], mark: '⛨' };
    case 'action_blocked':
      return { text: `${Poss(ev.source)} ${ACTION_TITLE[ev.action] || ev.action} was BLOCKED `
        + `by ${poss(ev.target)} OPSEC.`, cards: [], mark: '⛨' };
    case 'payment': {
      const n = (ev.cards || []).length;
      return { text: `${nameOf(ev.from)} paid ${nameOf(ev.to)} ${ev.total}M `
        + `with ${n} card${n === 1 ? '' : 's'}.`, cards: ev.cards || [], mark: '→' };
    }
    case 'insolvent':
      return { text: `${nameOf(ev.from)} had nothing to pay ${nameOf(ev.to)} with — `
        + 'the debt is written off.', cards: [], mark: '∅' };
    case 'steal':
      return { text: `${nameOf(ev.actor)} took ${cardName(ev.card)} from ${nameOf(ev.from)}`
        + `${ev.action === 'chud' ? ' with THE CHUD CARD' : ''}.`,
      cards: [ev.card], mark: '✂', color: ev.toColor };
    case 'set_stolen':
      return { text: `${nameOf(ev.actor)} SEIZED ${poss(ev.from)} whole `
        + `${colorName(ev.color)} set.`, cards: ev.cards || [], mark: '✂', color: ev.color };
    case 'swap':
      return { text: `${nameOf(ev.actor)} swapped ${cardName(ev.gave)} for `
        + `${poss(ev.target)} ${cardName(ev.took)}.`,
      cards: [ev.gave, ev.took].filter(Boolean), mark: '⇄' };
    case 'upgrade':
      return { text: `${nameOf(ev.actor)} added ${cardName(ev.card)} to ${colorName(ev.color)}.`,
        cards: [ev.card], mark: '▲', color: ev.color };
    case 'upgrade_banked':
      return { text: `${Poss(ev.actor)} ${colorName(ev.color)} set broke — `
        + `${cardName(ev.card)} went to the bank.`, cards: [ev.card], mark: '▽', color: ev.color };
    case 'move_property':
      return { text: `${nameOf(ev.actor)} moved ${cardName(ev.card)} from `
        + `${colorName(ev.from)} to ${colorName(ev.to)}${ev.forced ? ' (forced — no room)' : ''}.`,
      cards: [ev.card], mark: '↔', color: ev.to };
    case 'move_upgrade':
      return { text: `${nameOf(ev.actor)} moved ${cardName(ev.card)} from `
        + `${colorName(ev.from)} to ${colorName(ev.to)}.`, cards: [ev.card], mark: '↔' };
    case 'set_completed':
      return { text: `${nameOf(ev.actor)} COMPLETED ${colorName(ev.color)} — `
        + `${ev.total} set${ev.total === 1 ? '' : 's'}.`, cards: [], mark: '★', color: ev.color };
    case 'final_approach':
      return { text: `${nameOf(ev.actor)} ${be(ev.actor)} on FINAL APPROACH with ${ev.sets} sets — `
        + `${ev.opponentTurnsRemaining ?? '?'} opponent turn`
        + `${ev.opponentTurnsRemaining === 1 ? '' : 's'} to break it.`, cards: [], mark: '⚑' };
    // resolveFinalApproach() (game.js:495-521) — the armed player's own turn
    // started INSIDE the grace window, so it does not convert. `checkpointTurn`
    // is the absolute turn number of the one that will.
    case 'final_approach_pending': {
      const n = ev.opponentTurnsRemaining;
      return { text: `${Poss(ev.actor)} final approach did NOT convert this turn — `
        + `${nameOf(ev.actor)} still ${s3(ev.actor, 'hold')} ${ev.sets} sets, `
        + `and the win locks in at the start of ${mine(ev.actor) ? 'your' : 'their'} turn on `
        + `turn ${ev.checkpointTurn ?? '?'}`
        + (typeof n === 'number' ? `, after ${n} more opponent turn${n === 1 ? '' : 's'}` : '')
        + '. Own turns inside the window do not count as answers.',
      cards: [], mark: '⧗' };
    }
    case 'final_approach_broken':
      return { text: `${Poss(ev.actor)} final approach was BROKEN`
        + `${ev.by ? ` by ${nameOf(ev.by)}` : ''}.`, cards: [], mark: '✖' };
    case 'discard': {
      const n = (ev.cards || []).length;
      return { text: `${nameOf(ev.actor)} discarded ${n} card${n === 1 ? '' : 's'} `
        + 'at the hand limit.', cards: ev.cards || [], mark: '▾' };
    }
    case 'scoop':
      return { text: `${nameOf(ev.actor)} SCOOPED OUT — everything they owned went to the `
        + 'discard.', cards: [], mark: '☠' };
    case 'win':
      return { text: `${nameOf(ev.actor)} ${s3(ev.actor, 'WIN')} with ${ev.sets} complete sets.`,
        cards: [], mark: '★' };
    // endInStalemate() (game.js:1694-1712) ranks by sets, then net worth, then
    // seat order — and reports 'unopposed' when there was no runner-up to rank
    // against at all. That fourth basis had no wording here and came out as
    // "took it on completed sets", which is a different claim.
    case 'stalemate': {
      const BASIS = {
        sets: 'completed sets', net_worth: 'net worth', turn_order: 'seat order',
        unopposed: 'being the only player left to rank',
      };
      if (!ev.winner) {
        return { text: `Game ended on points (${ev.reason === 'deck_cycles' ? 'deck cycled out'
          : 'deck and discard dry'}) — a draw, with nobody left to take it.`,
        cards: [], mark: '★' };
      }
      return { text: `Game ended on points (${ev.reason === 'deck_cycles' ? 'deck cycled out'
        : 'deck and discard dry'}) — ${nameOf(ev.winner)} took it on `
        + `${BASIS[ev.basis] || 'completed sets'}.`, cards: [], mark: '★' };
    }
    case 'turn_restart':
      return { text: `${Poss(ev.actor)} turn restarted — ${ev.plays} plays.`, cards: [], mark: '↻' };
    // §3.10b contested approach. game.js syncContest() opens/closes the contest
    // and resolveFinalApproach() holds a reached checkpoint; the vocabulary is
    // SUDDEN_DEATH_COPY's (ui/ruleset.js) — the card the table was picked with.
    case 'contest_open': {
      const names = (ev.actors || []).map(nameOf).join(' and ') || 'Two players';
      const RIDER = {
        oneLap: 'the win is suspended for one full lap, then turn order decides',
        escalate: `winning now takes ${ev.bar ?? '?'} sets — pull ahead or nobody converts`,
        points: `after ${ev.lapCap ?? '?'} laps the game is decided on points`,
      };
      return { text: `CONTESTED FINAL APPROACH — ${names} are armed at once; `
        + `${RIDER[ev.mode] || 'nobody converts while the approach is contested'}.`,
      cards: [], mark: '⚔' };
    }
    case 'contest_held': {
      const REASON = {
        escalate: `the bar is ${ev.bar ?? '?'} sets while it stays contested`,
        oneLap: 'the win waits one full lap before turn order decides',
        points: 'nobody converts until an approach is broken',
      };
      return { text: `${nameOf(ev.actor)} reached the checkpoint with ${ev.sets ?? '?'} sets, `
        + `but the approach is CONTESTED — ${REASON[ev.reason] || 'the win is held'}.`,
      cards: [], mark: '⚔' };
    }
    case 'contest_closed': {
      const left = Array.isArray(ev.actors) && ev.actors.length === 1 ? ev.actors[0] : null;
      return { text: 'The final approach is no longer contested'
        + (left ? ` — ${nameOf(left)} ${be(left)} the only player still armed` : '') + '.',
      cards: [], mark: '⚔' };
    }
    default:
      return null;
  }
}

/** Does this beat concern me? Drives the "About me" filter and the emphasis. */
function touchesMe(ev) {
  const me = store.self.id;
  if (!me) return false;
  for (const k of ['actor', 'from', 'to', 'target', 'by', 'source', 'winner']) {
    if (ev[k] === me) return true;
  }
  // `contest_open`/`contest_closed` name their armed seats in `actors`.
  if (Array.isArray(ev.actors) && ev.actors.includes(me)) return true;
  return Array.isArray(ev.targets) && ev.targets.includes(me);
}

/* ── rendering ────────────────────────────────────────────────────────────── */

function cardChip(card) {
  if (!card || card.id == null) return null;
  return el('button', {
    class: 'jr-card',
    attrs: { type: 'button', 'aria-label': `${cardName(card) || card.name}, ${card.value ?? 0}M` },
    dataset: { action: 'journal-card', card: String(card.id), peekCard: String(card.id) },
  }, [
    card.color && COLORS[card.color]
      ? el('span', { class: 'brief-swatch', dataset: { color: card.color } }) : null,
    el('span', { text: cardName(card) || card.name || 'Card' }),
  ].filter(Boolean));
}

/** One beat as a DOM row. `full` adds the card chips (the drawer is too narrow). */
function beatRow(entry, { full = false } = {}) {
  const d = describe(entry.ev);
  if (!d) return null;
  const w = weight(entry.ev.t);
  const row = el('div', {
    class: `jr-beat is-${w}${touchesMe(entry.ev) ? ' is-mine' : ''}`
      + (entry.ev.t === 'final_approach_broken' ? ' is-alarm' : ''),
    dataset: entry.ev.color && COLORS[entry.ev.color] ? { color: entry.ev.color } : {},
  }, [
    el('span', { class: 'jr-mark', text: d.mark || '·' }),
    el('span', { class: 'jr-body' }, [
      el('span', { class: 'jr-text', text: d.text }),
      full && d.cards.length
        ? el('span', { class: 'jr-cards' }, d.cards.map(cardChip).filter(Boolean))
        : null,
    ].filter(Boolean)),
    full ? el('span', { class: 'jr-turn', text: `T${entry.turn}` }) : null,
  ].filter(Boolean));
  return row;
}

/* ── the live drawer (#log) ───────────────────────────────────────────────── */

let drawnSeq = 0;

function renderDrawer() {
  const box = $('log');
  if (!box) return;
  if (drawnSeq > maxSeq) { clear(box); drawnSeq = 0; }
  for (const entry of beats) {
    if (entry.seq <= drawnSeq) continue;
    drawnSeq = entry.seq;
    if (SKIP.has(entry.ev.t)) continue;
    const row = beatRow(entry);
    if (row) box.appendChild(row);
  }
  while (box.childElementCount > 140) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

/* ── the full log sheet ───────────────────────────────────────────────────── */

const FILTERS = [
  { id: 'turn', label: 'Turning points', keep: (e) => weight(e.ev.t) === 'turn' },
  { id: 'mine', label: 'About me', keep: (e) => touchesMe(e.ev) && !SKIP.has(e.ev.t) },
  { id: 'all', label: 'Everything', keep: (e) => !SKIP.has(e.ev.t) },
  { id: 'prose', label: 'Transcript', keep: () => false },
];

let filter = 'turn';
let host = null;
let reading = null;

function paintSheet() {
  if (!host?.isConnected) return;
  clear(host);

  const rail = el('div', { class: 'brief-tabs', attrs: { role: 'tablist', 'aria-label': 'Log views' } });
  for (const f of FILTERS) {
    rail.appendChild(el('button', {
      class: `brief-tab${filter === f.id ? ' is-on' : ''}`,
      attrs: { type: 'button', role: 'tab', 'aria-selected': filter === f.id ? 'true' : 'false' },
      dataset: { action: 'journal-filter', filter: f.id },
      text: f.label,
    }));
  }
  host.appendChild(rail);

  const panel = el('div', { class: 'jr-panel' });
  host.appendChild(panel);

  const reader = el('div', { class: 'jr-reader', attrs: { id: 'jr-reader' } });
  panel.appendChild(reader);
  paintReader(reader);

  if (gaps) {
    panel.appendChild(el('p', {
      class: 'brief-note',
      text: `${gaps} stretch${gaps === 1 ? '' : 'es'} of this game are missing from the record — `
        + 'the connection dropped or a broadcast was missed, and the server sends only the '
        + 'most recent events. Everything shown below is real.',
    }));
  }

  if (filter === 'prose') {
    const lines = store.snapshot?.log || [];
    panel.appendChild(el('p', { class: 'brief-note',
      text: 'The server\'s own wording, most recent 40 lines. The other tabs are built from '
        + 'the structured event stream: everything since you connected, and the most recent '
        + '120 events after a reload.' }));
    const list = el('div', { class: 'jr-list' });
    for (const line of lines) list.appendChild(el('div', { class: 'jr-prose', text: line }));
    panel.appendChild(list);
    return;
  }

  const f = FILTERS.find(x => x.id === filter) || FILTERS[0];
  // `describe()` returns null for an event this client does not know how to
  // word. Counting those would print "113 beats" over 100 rows.
  const rows = beats.filter(e => f.keep(e) && describe(e.ev));
  panel.appendChild(el('p', { class: 'dv-count',
    text: `${rows.length} beat${rows.length === 1 ? '' : 's'} · oldest first` }));
  const list = el('div', { class: 'jr-list' });
  if (!rows.length) {
    list.appendChild(el('p', { class: 'brief-note', text: 'Nothing here yet.' }));
  }
  for (const entry of rows) {
    const row = beatRow(entry, { full: true });
    if (row) list.appendChild(row);
  }
  panel.appendChild(list);
}

function findCard(id) {
  for (const entry of beats) {
    const d = describe(entry.ev);
    if (!d) continue;
    for (const card of d.cards) if (card && card.id === id) return card;
  }
  return null;
}

function paintReader(reader) {
  clear(reader);
  if (reading == null) return;
  const card = findCard(reading);
  if (!card) { reading = null; return; }
  const face = el('div', { class: 'card jr-face', dataset: { type: card.type || 'unknown' } });
  face.appendChild(buildFace(card));
  refresh(face, card);
  face.removeAttribute('aria-label');
  reader.appendChild(el('div', { class: 'dv-reader-head' }, [
    el('span', { class: 'dv-reader-name', text: cardName(card) || card.name || '' }),
    el('button', {
      class: 'btn btn-icon', text: '✕',
      attrs: { type: 'button', 'aria-label': 'Close the card reader' },
      dataset: { action: 'journal-card', card: String(card.id) },
    }),
  ]));
  reader.appendChild(face);
  const body = detailBody(card);
  if (body) reader.appendChild(body);
}

export function show(which) {
  if (FILTERS.some(f => f.id === which)) filter = which;
  reading = null;
  host = el('div', { class: 'brief jr' });
  openSheet('Mission log', host, { onClose: () => { host = null; reading = null; } });
  paintSheet();
}

export function isOpen() { return !!host?.isConnected && sheetOpen(); }

/* ── the recap (win overlay) ──────────────────────────────────────────────── */

/**
 * "How did that actually go?" — the turning points, plus the specific answer to
 * the question the owner could not answer: if you were ever armed, what
 * happened to that approach.
 * @returns {Element|null}
 */
export function recap() {
  if (!beats.length) return null;
  const me = store.self.id;
  const box = el('div', { class: 'jr-recap' });

  // The approach story first, because it is the one that gets asked about.
  const armings = beats.filter(b => b.ev.t === 'final_approach' && b.ev.actor === me);
  const breaks = beats.filter(b => b.ev.t === 'final_approach_broken' && b.ev.actor === me);
  if (armings.length) {
    const last = breaks[breaks.length - 1];
    const won = store.snapshot?.winner === me;
    box.appendChild(el('p', { class: 'jr-approach' + (won ? ' is-good' : ' is-bad') }, [
      el('b', { text: won ? 'YOUR FINAL APPROACH HELD. ' : 'YOUR FINAL APPROACH DID NOT CONVERT. ' }),
      el('span', {
        text: won
          ? `You armed ${armings.length === 1 ? 'once' : `${armings.length} times`} and converted.`
          : breaks.length
            ? `You armed ${armings.length === 1 ? 'once' : `${armings.length} times`}; it was broken `
              + `${breaks.length === 1 ? 'once' : `${breaks.length} times`}`
              + `${last?.ev.by ? `, last by ${who(last.ev.by)}` : ''}. `
              + 'Losing any complete set disarms you and the grace window restarts at zero.'
            : `You armed ${armings.length === 1 ? 'once' : `${armings.length} times`} but the `
              + 'game ended before your checkpoint came round.',
      }),
    ]));
  }

  const turning = beats.filter(b => weight(b.ev.t) === 'turn');
  // The last 14 turning points: enough to cover the endgame, short enough that
  // the overlay stays one scroll.
  const shown = turning.slice(-14);
  if (!shown.length) return box.childElementCount ? box : null;
  box.appendChild(el('div', { class: 'jr-recap-head', text: 'HOW IT WENT' }));
  const list = el('div', { class: 'jr-list is-recap' });
  for (const entry of shown) {
    const row = beatRow(entry);
    if (row) list.appendChild(row);
  }
  box.appendChild(list);
  if (turning.length > shown.length) {
    box.appendChild(el('button', {
      class: 'btn btn-ghost jr-more',
      text: `Open the full log (${turning.length} turning points)`,
      attrs: { type: 'button' },
      dataset: { action: 'open-log' },
    }));
  }
  return box;
}

/* ── the announcement: a disarm you cannot miss ───────────────────────────── */

// 2600ms: long enough to read two lines out loud, short enough that it is gone
// before the next turn's first card lands (the choreographer caps an event at
// 600ms and a bot turn is ~3 events).
const ANNOUNCE_MS = 2600;
let announceEl = null;
let announceTimer = 0;

function announce(kind, flag, line) {
  if (!announceEl?.isConnected) {
    announceEl = el('div', {
      class: 'announce',
      attrs: { role: 'status', 'aria-live': 'assertive' },
    });
    announceEl.hidden = true;
    ($('app') || document.body).appendChild(announceEl);
  }
  clear(announceEl);
  announceEl.className = `announce is-${kind}`;
  announceEl.appendChild(el('span', { class: 'announce-flag', text: flag }));
  announceEl.appendChild(el('span', { class: 'announce-text', text: line }));
  announceEl.hidden = false;
  requestAnimationFrame(() => setClass(announceEl, 'is-in', true));
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    setClass(announceEl, 'is-in', false);
    announceTimer = setTimeout(() => { if (announceEl) announceEl.hidden = true; }, 260);
  }, ANNOUNCE_MS);
}

/**
 * The beats that must land even with the drawer shut. Deliberately short: an
 * announcement for everything is an announcement for nothing.
 * fx/ already fires an `approach_broken` cue; this is the worded half.
 */
function announceFor(ev) {
  const me = store.self.id;
  if (ev.t === 'final_approach_broken') {
    if (ev.actor === me) {
      announce('bad', 'APPROACH BROKEN',
        `You dropped below the winning set count${ev.by ? ` — ${who(ev.by)} did it` : ''}. `
        + 'You are disarmed; rebuild and the grace window starts over from zero.');
    } else {
      announce('good', 'APPROACH BROKEN',
        `${who(ev.actor)} is disarmed${ev.by && ev.by === me ? ' — you broke it' : ''}.`);
    }
    return;
  }
  if (ev.t === 'final_approach') {
    if (ev.actor === me) {
      announce('mine', 'FINAL APPROACH',
        `You hold ${ev.sets} sets. Hold them through `
        + `${ev.opponentTurnsRemaining ?? '?'} more opponent turn`
        + `${ev.opponentTurnsRemaining === 1 ? '' : 's'} and you win.`);
    } else {
      announce('bad', 'BREAK THEM NOW',
        `${who(ev.actor)} holds ${ev.sets} sets and wins in `
        + `${ev.opponentTurnsRemaining ?? '?'} turn`
        + `${ev.opponentTurnsRemaining === 1 ? '' : 's'} unless a set is broken.`);
    }
    return;
  }
  if (ev.t === 'set_stolen' && ev.from === me) {
    announce('bad', 'SET SEIZED',
      `${who(ev.actor)} took your whole ${colorName(ev.color)} set — Upgrade and FOC included.`);
  }
}

/* ── wiring ───────────────────────────────────────────────────────────────── */

export function mount() {
  pointer.registerActions({
    'open-log': () => show('turn'),
    'journal-filter': (elx) => { filter = elx.dataset.filter || 'turn'; reading = null; paintSheet(); },
    'journal-card': (elx) => {
      const id = Number(elx.dataset.card);
      reading = reading === id ? null : id;
      paintSheet();
      document.getElementById('jr-reader')?.scrollIntoView({ block: 'nearest' });
    },
  });

  installLogButton();

  // Read the logbook off disk ONCE, at boot. `recordGame` would load it lazily
  // anyway, but a panel that reads `stats.data` before the first game of the
  // session would then be reading defaults over a full record. Never throws.
  stats.ensure();

  bus.on(EVENTS.STATE_APPLIED, ({ snapshot, fresh }) => {
    // Reset on `fresh` — the store's first-sight latch (store.js applyState
    // zeroes lastSeq on a leave, a kick, a room-code change and a rematch, and
    // on nothing else) — and NOT on `snap`. A same-game reconnect past event
    // 120 arrives snapped but not fresh, and the tail it carries overlaps this
    // accumulator by seq, so keeping it costs nothing and wiping it was the S2
    // defect: measured 2026-08-08, mid-game.json (eventSeq 141, tail seq
    // 22–141) staged on a fresh page left entries()===0 while comms.js reset
    // on every snap; under this latch the same staging keeps all 120 beats and
    // a reconnect duplicates none (ingest skips ev.seq <= maxSeq).
    if (fresh) {
      reset();
      drawnSeq = 0;                       // the drawer's watermark dies with the record
      const box = $('log');
      if (box) clear(box);
    }
    ingest(snapshot);
    // AFTER ingest, so the row is folded from the whole accumulated stream and
    // not from the 120-event tail this broadcast happened to carry. Latched and
    // exception-proof inside; a finished game re-broadcasts on every rematch
    // vote and host change.
    const banked = recorder.observe({
      snapshot,
      room: store.room,
      selfId: store.self.id,
      beats,
      gaps,
    });
    // At most once per game (the recorder's latch). The win screen reads this
    // to show the sortie-point award — it must fire BEFORE overlays' own
    // STATE_APPLIED handler builds the screen, which registration order
    // guarantees: overlays.mount() calls journal.mount() first.
    if (banked) bus.emit(EVENTS.GAME_BANKED, { row: banked });
    renderDrawer();
    installLogButton();
    if (isOpen()) paintSheet();
  });

  // The announcement rides the CHOREOGRAPHER, not the snapshot: it must land
  // with the cards it is describing, not 600ms before them.
  bus.on(EVENTS.CHOREO_EVENT, (ev) => { if (ev) announceFor(ev); });
}

/** The drawer is closed by default, so the full log needs a door of its own.
 *  public/index.html is architect-owned (§1); the button is built here. */
function installLogButton() {
  const head = document.querySelector('#side .side-head');
  if (!head || head.querySelector('[data-action="open-log"]')) return;
  const btn = el('button', {
    class: 'btn jr-open',
    text: 'Full log',
    attrs: { type: 'button' },
    dataset: { action: 'open-log' },
  });
  head.insertBefore(btn, head.lastElementChild);
  setAttr(head.firstElementChild, 'title', 'Live feed — "Full log" opens the whole record');
  setText(head.firstElementChild, 'MISSION LOG');
}
