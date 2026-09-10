// table/layout.js — the felt: player boards, colour columns, piles.
//
// Boards are STRUCTURE, not content. This file builds the containers once per
// seating change and hands out zone elements; every card that lands in them is
// placed by table/index.js. Rebuilding is keyed on the seat list, so a normal
// turn never touches this code and never orphans a card node mid-FLIP.

import { el, clear, setText, setAttr, setClass, setHidden } from '../core/dom.js';
import { COLORS, COLOR_KEYS, isComplete } from '../core/cards.js';
import { botLabel } from '../core/bots.js';
import { store } from '../state/store.js';
import * as sel from '../state/selectors.js';

const zones = new Map();          // zoneKey -> element
const boards = new Map();         // playerId -> board element

let seatKey = '';
let selfId = null;
let root = null;

/* ══ THE COLLAPSED SEAT ════════════════════════════════════════════════════
   MEASURED on five-player@phone (390×844, ui-scale 1, the fixture the review
   set photographs), before this:

     strip port 376×254   scrollHeight 416    →  162px of seat below the fold
     Bolt   185×166  1 mat   3 property cards, 3 visible
     Cobra  185×166  1 mat   1 property card, 1 visible
     Jester 185×240  4 mats  4 property cards, 0 FULLY VISIBLE
     Shadow 185×240  4 mats  6 property cards, 0 FULLY VISIBLE

   Two of four opponents showed no properties at all; 10 of 14 property cards
   and 8 of 10 mats on the table were below the scrollport. The interface-scale
   slider does not fix it — at 0.80 the strip is 379×314 around scrollHeight
   466 and Shadow still shows 0 of 6. Four opponent boards do not fit a phone at
   the 44px floor and no scale factor makes them.

   So a seat has two states, and the split is Hearthstone Battlegrounds' (8 live
   opponents on one screen): APPROXIMATE WHEN COLLAPSED, exact on expand. A
   collapsed seat answers "how threatening is this player" — which colours, how
   close, how much they are worth, how many cards they are holding, whether they
   are armed — from a 44px row that never scrolls out of view. The expanded seat
   answers "exactly what do they hold", with mats twice the size the strip could
   ever afford to give four of them at once.

   §0.4: collapse creates, destroys and reparents NOTHING. Every card node stays
   exactly where reconcile put it; the seat's three detail children are
   `display:none`, and table/index.js's moveCard already has the guard for that
   case by name ("The destination is not rendered (a hidden zone, a collapsed
   board)") — it places the card and skips the flight rather than inverting
   against a 0×0 rect. `display:none` and not a clip, deliberately: moveCard's
   unclip() walks a flying card's ancestors and sets `overflow: visible` on
   every one of them, so a concealment built on `overflow:hidden` would tear
   itself open for ~400ms every time a card landed on a seat.

   THE COST, stated: a card landing on a collapsed seat does not fly. Against
   what it replaces — a beat that is already invisible for two of four seats
   because they are below the fold, with the OUTCOME invisible too — the trade
   is a beat nobody could see for a result everybody can. */

/** The one expanded seat, or null. An accordion: the strip never spends more
 *  than one seat's worth of height on detail. */
let expandedId = null;
/** Is collapse the mode at this viewport? Written by the media listener below. */
let collapsing = false;
let strip = null;

export function zoneEl(key) { return zones.get(key) || null; }
export function boardEl(playerId) { return boards.get(playerId) || null; }
export function allBoards() { return boards; }
export function zoneKeys() { return zones.keys(); }

/**
 * zoneFor(kind, ownerId, color) — the §5 addressing scheme.
 * Own zones get the short key ('bank'); everyone else is suffixed by id. The
 * short form is what tools/touchtest.mjs selects on ([data-zone="bank"],
 * [data-zone^="properties"]), and it keeps CSS for "my side of the table" simple.
 */
export function zoneKeyFor(kind, ownerId, color) {
  const mine = !ownerId || ownerId === selfId;
  switch (kind) {
    case 'deck': return 'deck';
    case 'discard': return 'discard';
    case 'hand': return mine ? 'hand' : `hand:${ownerId}`;
    case 'bank': return mine ? 'bank' : `bank:${ownerId}`;
    case 'properties': return mine ? `properties:${color}` : `properties:${ownerId}:${color}`;
    case 'upgrades': return mine ? `upgrades:${color}` : `upgrades:${ownerId}:${color}`;
    default: return null;
  }
}

export function zoneFor(kind, ownerId, color) {
  return zoneEl(zoneKeyFor(kind, ownerId, color));
}

/**
 * An opponent's empty colour column is `display:none` (table.css hides
 * `.board-opponent .propcol[data-empty="1"]`; a seat's mat grid is a fixed
 * number of 44px columns at a fixed row height, and ten of them do not fit the
 * 171px a 1280×720 strip has — the arithmetic is in table.css's seat-grid
 * block). paintBoard clears the flag — but only at the RECONCILE, at the end of
 * the job, which is after the choreography that put a card there.
 *
 * Measured consequence: a property stolen into a colour the thief did not have
 * yet was reparented into a zero-size box, so table/moveCard's FLIP measured
 * `last` at 0×0, the card flew to viewport (0,0), and the steal_landed cue
 * anchored there too — four of the ten steals in the recorded game fired their
 * red flash in the top-left corner of the screen with no card anywhere near it.
 *
 * A column with a card in it is not empty. Saying so here, at the moment the
 * card arrives, is the truth; reconcile recomputes it either way.
 */
export function revealZone(zone) {
  if (!zone || !zone.closest) return;
  const col = zone.closest('.propcol[data-empty="1"]');
  if (col) col.removeAttribute('data-empty');
}

/**
 * Does this zone belong to the viewing player? Falls out of the key scheme
 * above: my zones are never suffixed with a seat id. Drives the `mine` flag on
 * every FX cue (§7 wants your own cards louder and centred), so it has to be
 * derivable without the caller knowing whose event it was.
 * 'deck' and 'discard' belong to nobody.
 */
export function isMineZone(key) {
  if (!key) return false;
  if (key === 'hand' || key === 'bank') return true;
  const i = key.indexOf(':');
  if (i < 0) return false;                                  // deck / discard
  const kind = key.slice(0, i);
  const rest = key.slice(i + 1);
  if (kind === 'properties' || kind === 'upgrades') return rest.indexOf(':') < 0;
  return false;                                             // hand:PID / bank:PID
}

export function mount(rootEl, mySeatId) {
  root = rootEl;
  selfId = mySeatId;
  zones.set('deck', document.querySelector('[data-zone="deck"]'));
  zones.set('discard', document.querySelector('[data-zone="discard"]'));
  zones.set('hand', document.querySelector('[data-zone="hand"]'));
  mountSeatMode();
}

/* ── WHEN COLLAPSE IS THE MODE ─────────────────────────────────────────────
 * ≤1023px, which is every phone in both orientations plus the tablet band that
 * already uses the portrait stack. NOT desktop: measured at 1280×720 with four
 * opponents a seat is 257×147 and the strip's scrollHeight is 165 in a 165px
 * port — nothing scrolls and nothing is cut, so there is no problem to collapse
 * away, and a mode that only exists on phones is the honest shape of a defect
 * that only exists on phones.
 *
 * The breakpoint is read in JS as well as CSS because the TOGGLE is a real
 * <button>: tools/lib/audit.mjs measures every button against the 44px floor,
 * and a desktop seat cannot fund a 44px header (the seats track is
 * fit-content(11.4em) = 189px against a 147px seat, and the 24px of slack is
 * already spent closing the payment overlap on .board-self). So above the
 * breakpoint the button is `display:contents` — no box, invisible to the audit
 * — and `disabled`, so it is not a dead tab stop either.
 */
function mountSeatMode() {
  strip = document.getElementById('opponents');
  if (!strip) return;
  const mq = typeof matchMedia === 'function' ? matchMedia('(max-width: 1023px)') : null;
  const apply = () => {
    collapsing = mq ? mq.matches : false;
    setAttr(strip, 'data-seatmode', collapsing ? 'collapse' : 'full');
    if (!collapsing) expandedId = null;
    paintSeatStates();
  };
  if (mq) {
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply);
  }
  apply();

  /* THE TAP, and how it does not fight targeting.
   *
   * interact/pointer.js's router tests `closest('[data-targetable="1"]')`
   * BEFORE `[data-action]`, so at the seat level targeting already outranks
   * every control in the client. This listener sits on the strip — a
   * descendant of `document`, so it bubbles FIRST — and therefore has to make
   * the same ruling itself, explicitly: while a seat is a live target, a tap on
   * it means CHOOSE THIS TARGET and never EXPAND.
   *
   * The other half of the answer is in table.css, not here: a seat that
   * CONTAINS a live target (the `theirCard` and `theirSet` steps mark card
   * nodes and .propcols inside a seat, not the seat) expands from a `:has()`
   * rule. That cannot fall out of sync with interact/, because the thing it
   * keys on IS interact/'s mark.
   */
  strip.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t || t.closest('[data-targetable="1"]')) return;
    const btn = t.closest('[data-seat-toggle]');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const board = btn.closest('.board');
    const id = board?.getAttribute('data-player');
    if (!id) return;
    expandedId = expandedId === id ? null : id;
    paintSeatStates();
    if (expandedId) board.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  });

  /* Escape closes the seat — but only when nothing on the table is a live
   * target. interact/'s own Escape handler cancels targeting/payment, and a key
   * that did both at once would answer a question the player did not ask. */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || expandedId == null) return;
    if (document.querySelector('[data-targetable="1"], [data-payable="1"]')) return;
    expandedId = null;
    paintSeatStates();
  });
}

/** Push `expandedId` + the mode onto every seat. Guarded; safe to call often. */
function paintSeatStates() {
  for (const [id, board] of boards) {
    if (board.classList.contains('board-self')) continue;
    const open = !collapsing || expandedId === id;
    setAttr(board, 'data-collapsed', open ? '0' : '1');
    const btn = board.querySelector('[data-seat-toggle]');
    if (!btn) continue;
    btn.disabled = !collapsing;
    setAttr(btn, 'aria-expanded', open ? 'true' : 'false');
  }
}

/**
 * The seat id arrives AFTER mount(): main.js boots the table with
 * store.self.id (null) and only learns the id from the `joined` message.
 *
 * Measured on the bug this exists for (P7 round 1, scratchpad/frames/deal):
 * without it, zoneKeyFor('hand', myId) answered `hand:<uuid>` for the whole
 * opening deal, zoneEl() returned null, moveCard() bailed, and the first
 * 1,916ms of every game was a frozen table reading "DECK 0" followed by 26
 * cards teleporting in at the job-ending reconcile — the first thing a player
 * ever sees, and it did not animate at all.
 *
 * Clearing seatKey rather than trusting it: the key embeds selfId, so a rebuild
 * would happen anyway at the next syncSeats, but zones registered under the old
 * keys are unreachable until then and that is exactly the hole above.
 */
export function setSelf(id) {
  if (id === selfId) return false;
  selfId = id;
  seatKey = '';
  return true;
}

/** Rebuild boards only when the seating changes. Returns true if it rebuilt. */
export function syncSeats(snapshot, mySeatId) {
  if (!root) return false;
  selfId = mySeatId || selfId;
  const players = snapshot?.players || [];
  const key = players.map(p => p.id).join(',') + '|' + selfId;
  if (key === seatKey) return false;
  seatKey = key;

  const opponents = document.getElementById('opponents');
  const selfSlot = document.getElementById('self-board');
  if (!opponents || !selfSlot) return false;

  // Detach every card node before the containers go away, so nothing is
  // destroyed by the clear() — the registry in cardnode.js still owns them and
  // reconcile puts them back this same frame.
  for (const zone of zones.values()) {
    if (!zone || zone.dataset.zone === 'hand') continue;
    while (zone.firstChild) zone.removeChild(zone.firstChild);
  }
  for (const k of [...zones.keys()]) if (k !== 'deck' && k !== 'discard' && k !== 'hand') zones.delete(k);
  boards.clear();
  clear(opponents);
  clear(selfSlot);

  // A seat that no longer exists cannot stay expanded, and a new table opens
  // resting: collapsed everywhere collapse is the mode.
  expandedId = null;

  for (const player of players) {
    const isSelf = player.id === selfId;
    const board = buildBoard(player, isSelf);
    boards.set(player.id, board);
    (isSelf ? selfSlot : opponents).appendChild(board);
  }
  paintSeatStates();
  return true;
}

/* ── THE GIST: what survives collapse, and what each thing bought ──────────
 *
 *   SET METERS, one per colour held — the whole trick, and the only thing here
 *     that is deliberately APPROXIMATE. A segmented bar in the set's own hue
 *     says WHICH colours and HOW CLOSE without a single card face: "Fighters
 *     2 of 3, Command complete, Bases 1 of 4" is the entire decision input for
 *     "who do I hit and what do I deny". At this size a rendered bar beats
 *     digits — five bars read in one saccade where five "2/3"s do not, and the
 *     hue carries the colour identity the exact digits would still need a label
 *     to carry. Colours the player does not hold are not rendered, exactly as
 *     their empty mats are not (table.css `.board-opponent .propcol[data-empty]`).
 *   COMPLETE + UPGRADED are marked ON the meter. A complete set is the win
 *     condition and an upgraded one doubles what their rent costs you; both
 *     change what you do this turn, and neither is derivable from the bar's
 *     fill (an Upgrade is not a property, so 3/3 with a House looks identical
 *     to 3/3 without one).
 *   HAND COUNT survives because a hand is what can happen TO you: a seat
 *     holding 0 cards cannot Chud your rent, cannot steal and cannot charge.
 *     It costs one digit here against the ~90px fan of card backs it replaces —
 *     measured on five-player@phone, that fan was the single tallest thing in
 *     Bolt's seat and said nothing the digit does not.
 *   ARMED survives because §3.10's Final Approach is the state a player who
 *     cannot see it will misplay, and the brief makes it non-negotiable. It is
 *     belt AND braces: the seat's own hazard treatment (stripes inside the box,
 *     klaxon on its shadow, name in danger ink) is on `.board` and survives
 *     collapse untouched — this is the word, for a 44px row read at a glance.
 *
 * NOT here, and why: the bank's exact denominations (that is "exactly what do
 * they hold", i.e. the expand); a second money figure beside `.board-worth` —
 * netWorth already answers "can they pay, and will it hurt", and two totals six
 * pixels apart that can disagree is the exact defect the `is-complete` note
 * below records; the bot's personality (owner directive, paintBoard).
 *
 * Built ONCE per seat, ten meters and all, and painted by attribute afterwards
 * (§0.8 guarded writes): the gist re-renders on every broadcast and must not
 * churn nodes to do it.
 */
/* ── THE MINI-TIER LETTER CODE (ART §6 amendment) ──────────────────────────
 * ROUND-2 LOOK #2: a collapsed seat's meters were bare coloured squares —
 * hue-only signalling, which §1 bans, dropped exactly where the cards are
 * smallest (mid-game@phone). The §6 amendment gives the smallest tier to a
 * LETTER/short code per set — the MIL-STD-2525 split (air platform type as a
 * Sector-1 letter) — so the code, not the hue, is the colourblind channel here.
 * Derived from the set names, disambiguated the way 2525 does it: one letter
 * where one is unique, two where it is not (Training owns T, so Test & Eval is
 * TE; Space Force's S would collide with nothing today but SF is its own
 * service's mark). Painted --band-ink on the raw set colour: ART §2 certifies
 * white-on-set at 5.07:1 (Mobility, the worst) to 11.04:1. */
const SET_CODE = Object.freeze({
  brown: 'D', lightblue: 'T', pink: 'SF', orange: 'TE', red: 'F',
  yellow: 'M', green: 'E', darkblue: 'C', base: 'OB', intel: 'I',
});

function buildGist() {
  const gist = el('div', { class: 'seat-gist' });
  gist.appendChild(el('span', { class: 'gist-armed', text: 'ARMED', attrs: { hidden: true } }));
  for (const color of COLOR_KEYS) {
    const meter = el('span', {
      class: 'gist-meter',
      attrs: { 'data-color': color, 'data-size': COLORS[color].size, 'data-have': '0', hidden: true },
    });
    // The code leads the segments — "F ▮▮▯" reads as a 2525 designator with a
    // fill state, and the letter is on screen exactly when the mats are not.
    meter.appendChild(el('b', { class: 'gm-code', text: SET_CODE[color] || '?' }));
    for (let i = 0; i < COLORS[color].size; i++) meter.appendChild(el('i', { class: 'gm-seg' }));
    gist.appendChild(meter);
  }
  gist.appendChild(el('span', { class: 'gist-hand', text: '0' }));
  return gist;
}

/** Repaint one seat's gist from the snapshot. All writes guarded. */
function paintGist(board, player, rules) {
  const gist = board.querySelector('.seat-gist');
  if (!gist) return;
  for (const color of COLOR_KEYS) {
    const meter = gist.querySelector(`.gist-meter[data-color="${color}"]`);
    if (!meter) continue;
    const have = player.properties?.[color]?.length || 0;
    setHidden(meter, have === 0);
    // Clamped to the set size: a wild can be counted into a zone the engine
    // already considers full, and a meter cannot show 4 of 3.
    setAttr(meter, 'data-have', String(Math.min(have, COLORS[color].size)));
    setAttr(meter, 'data-complete', isComplete(player, color, rules) ? '1' : null);
    setAttr(meter, 'data-up', (player.upgrades?.[color]?.length || 0) > 0 ? '1' : null);
  }
  setText(gist.querySelector('.gist-hand'), String(player.handCount ?? 0));
  setHidden(gist.querySelector('.gist-armed'), board.getAttribute('data-final-approach') !== '1');
}

function buildBoard(player, isSelf) {
  const board = el('section', {
    class: `board${isSelf ? ' board-self' : ' board-opponent'}`,
    attrs: { 'data-player': player.id, 'data-self': isSelf ? '1' : '0', tabindex: '0' },
  });

  const head = el('div', { class: 'board-head' }, [
    el('span', { class: 'board-name', text: player.name || '' }),
    // WHO IS THIS. server/broadcast.js ships `isBot`/`botMode` on every room
    // player, in the lobby AND for the whole game — the client simply never read
    // it once the table was up, so a seat called "Reaper" that never blocks
    // anything was indistinguishable from a human who never blocks anything.
    // A SPAN, not a button: tools/lib/audit.mjs measures every `button`/
    // `[data-action]` against the 44px floor and a 12px tag in a board head is a
    // gate failure, not an affordance. The full personality is one long-press
    // away (ui/overlays.js botBriefFromEvent) and always in ? → Bots.
    el('span', { class: 'board-bot', attrs: { hidden: true } }),
    el('span', { class: 'board-sets', text: '0/3' }),
    el('span', { class: 'board-worth', text: '0M' }),
  ]);

  if (isSelf) {
    board.appendChild(head);
  } else {
    // The nameplate and the gist ride INSIDE the toggle, so the whole collapsed
    // seat is one control and the 44px floor lands on the box a thumb aims at
    // rather than on a 17px strip of text. Everything inside is already
    // `pointer-events: none` (.board-head), so nothing under it loses a tap.
    board.appendChild(el('button', {
      class: 'seat-toggle',
      attrs: { type: 'button', 'data-seat-toggle': '', 'aria-expanded': 'false' },
    }, [head, buildGist()]));
    board.appendChild(el('div', {
      class: 'cardzone zone-hand-oppo',
      attrs: { 'data-zone': zoneKeyFor('hand', player.id) },
    }));
    zones.set(zoneKeyFor('hand', player.id), board.lastElementChild);
  }

  const bankWrap = el('div', { class: 'board-bank' }, [
    el('span', { class: 'zone-tag', text: 'BANK' }),
    el('div', { class: 'cardzone zone-bank', attrs: { 'data-zone': zoneKeyFor('bank', player.id) } }),
  ]);
  board.appendChild(bankWrap);
  zones.set(zoneKeyFor('bank', player.id), bankWrap.lastElementChild);

  const props = el('div', { class: 'board-props' });
  for (const color of COLOR_KEYS) {
    const info = COLORS[color];
    const col = el('div', {
      class: 'propcol',
      attrs: { 'data-color': color, 'data-owner': player.id, 'data-empty': '1' },
    });
    col.appendChild(el('div', { class: 'propcol-head' }, [
      el('span', { class: 'propcol-name', text: info.short }),
      el('span', { class: 'propcol-count', text: `0/${info.size}` }),
    ]));
    const cards = el('div', {
      class: 'cardzone zone-props',
      attrs: { 'data-zone': zoneKeyFor('properties', player.id, color) },
    });
    const ups = el('div', {
      class: 'cardzone zone-ups',
      attrs: { 'data-zone': zoneKeyFor('upgrades', player.id, color) },
    });
    col.appendChild(cards);
    col.appendChild(ups);
    props.appendChild(col);
    zones.set(zoneKeyFor('properties', player.id, color), cards);
    zones.set(zoneKeyFor('upgrades', player.id, color), ups);
  }
  board.appendChild(props);
  return board;
}

/** Per-reconcile text/state on the board chrome. All writes guarded. */
export function paintBoard(player, snapshot) {
  const board = boards.get(player.id);
  if (!board) return;
  setText(board.querySelector('.board-name'), player.name);
  // The seat's nature, from the ROOM list (getPlayerView carries no `isBot`; the
  // `state` frame's `players` array does, for the whole game). `data-bot` is also
  // what ui/overlays.js's long-press reads to open that bot's brief.
  const seat = (store.room?.players || []).find(x => x.id === player.id) || null;
  const botTag = board.querySelector('.board-bot');
  if (botTag) {
    if (seat?.isBot) {
      // OWNER DIRECTIVE 2026-08-07: a bot's PERSONALITY is not shown at the
      // table. Knowing a seat is "aggressive" before it has done anything tells
      // you how to play against it for free — you should have to read the table,
      // not the label. The seat still says it is a bot (you can see it never
      // hesitates); `data-bot` stays generic so styling and the long-press brief
      // keep working without leaking the mode.
      setText(botTag, 'BOT');
      botTag.hidden = false;
      setAttr(board, 'data-bot', 'bot');
    } else {
      botTag.hidden = true;
      setAttr(board, 'data-bot', null);
    }
  }
  setText(board.querySelector('.board-sets'), `${player.completedSets}/${snapshot.setsToWin || 3} SETS`);
  setText(board.querySelector('.board-worth'), `${player.netWorth}M`);
  setClass(board, 'is-turn', snapshot.currentPlayerId === player.id && snapshot.phase === 'playing');
  // §3.10 final approach: this player has the sets and the table has one turn
  // cycle to break them. The alarm treatment is table.css's; the fact is the
  // engine's — read the per-player flag, fall back to the game-level list.
  const armed = player.finalApproach != null
    ? !!player.finalApproach
    : Array.isArray(snapshot.armedIds) && snapshot.armedIds.includes(player.id);
  setAttr(board, 'data-final-approach', armed ? '1' : null);
  setClass(board, 'is-out', !!player.eliminated);
  setClass(board, 'is-winner', snapshot.winner === player.id);

  // `is-complete` is the SET badge, and a set is not a full zone.
  //
  // MEASURED under MD Faithful: two "any" wilds in Command is a full 2/2 zone that
  // game.js zoneIsSet() (351-356) refuses, because `pureSetRequired` takes at least
  // one real property. The engine's own `completedSets` beside it on this very board
  // read 0/3 SETS while this column read "2/2" with the complete treatment on it —
  // the number and the swatch it labels, disagreeing, six pixels apart.
  //
  // isComplete() is the client mirror of zoneIsSet(); ui/overlays.js already counts
  // the win screen's swatches with it, and this is the same question asked of the
  // same board, so it is asked the same way.
  const rules = sel.activeRuleFlags();
  for (const color of COLOR_KEYS) {
    const col = board.querySelector(`.propcol[data-color="${color}"]`);
    if (!col) continue;
    const cards = player.properties?.[color] || [];
    const size = COLORS[color].size;
    setAttr(col, 'data-empty', cards.length === 0 ? '1' : null);
    setClass(col, 'is-complete', isComplete(player, color, rules));
    // A zone that is FULL but not a set is its own state, and it is the one a player
    // has to be told about: nothing more can be played there and it still is not a
    // set. Without it the column just reads 2/2 and looks like a bug.
    setClass(col, 'is-fullnotset', cards.length >= size && !isComplete(player, color, rules));
    setText(col.querySelector('.propcol-count'), `${cards.length}/${size}`);
  }
  // After data-final-approach is written above: the gist's ARMED word reads the
  // seat's own flag rather than recomputing it, so the word and the hazard
  // stripes can never disagree.
  if (!board.classList.contains('board-self')) paintGist(board, player, rules);
}
