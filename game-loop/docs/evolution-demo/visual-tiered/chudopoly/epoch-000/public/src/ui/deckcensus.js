// ui/deckcensus.js — "what is left in the deck?", derived honestly.
//
// OWNER REQUEST (P8): "we need an easier discard view … knowing what has been
// spent is genuine strategy: how many OPSEC are gone, whether the CHUD card is
// still live, which rents have been used."
//
// The snapshot already carries everything needed EXCEPT the deck's composition,
// which is a fixed, known constant of the game (game.js buildDeck, 106 cards).
// So:
//
//     unseen(kind) = total(kind) − discarded(kind) − visible(kind)
//
// where `visible` is every card this player can actually see — their own hand,
// every bank, every property zone, every upgrade — and `unseen` is therefore
// "in the deck OR in a hidden hand". That distinction is stated in the UI; the
// view never claims to know what is in the deck specifically, because it cannot.
//
// ── WHAT IS MIRRORED FROM game.js, AND WHY IT IS THE MINIMUM ───────────────
// Three of the five totals need no mirror at all:
//   • properties  — COLORS[c].size IS the number of property cards of that
//                   colour in the deck (2/3/3/3/3/3/3/2/4/2 = 28). Free.
//   • actions     — core/cards.js ACTION_COUNTS already mirrors them (36).
//   • rent        — core/cards.js RENT_COUNTS already mirrors them (13).
// Only MONEY denominations and WILD pairs are new here, plus the rent pair list
// (which ui/help.js already hard-codes separately). 20 + 9 numbers.
// test/deck-census.test.js cross-checks every one of them against buildDeck(),
// which is the only reason a mirror is allowed to exist at all.

import {
  COLORS, COLOR_KEYS, ACTION_COUNTS, RENT_COUNTS, colorName, cardName,
} from '../core/cards.js';

/** game.js buildDeck() money block. */
export const MONEY_COUNTS = Object.freeze({ 1: 6, 2: 5, 3: 3, 4: 3, 5: 2, 10: 1 });

/** game.js buildDeck() rent block: five colour pairs, RENT_COUNTS.pair each. */
export const RENT_PAIRS = Object.freeze([
  ['brown', 'lightblue'], ['pink', 'orange'], ['red', 'yellow'],
  ['green', 'darkblue'], ['base', 'intel'],
]);

/**
 * game.js buildDeck() wild block. NOTE the deck contains BOTH
 * 'Wild: Drone/Training' (brown,lightblue) and 'Wild: Training/Drone'
 * (lightblue,brown) — two separate cards for the same pair, which is why this
 * table is keyed on the SORTED pair and brown+lightblue is 2.
 */
export const WILD_COUNTS = Object.freeze({
  any: 2,
  'brown|lightblue': 2,
  'orange|pink': 1,
  'red|yellow': 1,
  'darkblue|green': 1,
  'base|intel': 1,
  'base|green': 1,
});

const pairKey = (colors) => colors.slice().sort().join('|');

/**
 * The identity of a card KIND — the unit the census counts. Two Creech AFBs and
 * a Cannon AFB are all "Drone Ops property", because "how many Drone Ops cards
 * are still out there" is the question a player actually has.
 * @returns {string|null} null for a card shape the census cannot place
 */
export function kindKey(card) {
  if (!card) return null;
  switch (card.type) {
    case 'money': return `money:${card.value}`;
    case 'property': return `prop:${card.color}`;
    case 'wild_property':
      return card.colors?.[0] === 'any' ? 'wild:any' : `wild:${pairKey(card.colors || [])}`;
    case 'rent':
      return card.colors?.[0] === 'any' ? 'rent:any' : `rent:${pairKey(card.colors || [])}`;
    case 'action': return `act:${card.action}`;
    default: return null;
  }
}

/** An upgrade sitting in `player.upgrades[color]` may be a card or a bare kind
 *  string (game.js upgradeKinds tolerates both). Both are one action card. */
function upgradeKey(u) {
  if (!u) return null;
  if (typeof u === 'string') return u === 'hotel' ? 'act:foc' : 'act:upgrade';
  return kindKey(u) || (u.upgradeType === 'hotel' ? 'act:foc' : 'act:upgrade');
}

/* ── the totals table (the whole deck, by kind) ───────────────────────────── */

function buildTotals() {
  const t = new Map();
  for (const color of COLOR_KEYS) t.set(`prop:${color}`, COLORS[color].size);
  for (const [k, n] of Object.entries(WILD_COUNTS)) t.set(`wild:${k}`, n);
  for (const [v, n] of Object.entries(MONEY_COUNTS)) t.set(`money:${v}`, n);
  for (const pair of RENT_PAIRS) t.set(`rent:${pairKey(pair)}`, RENT_COUNTS.pair);
  t.set('rent:any', RENT_COUNTS.any);
  for (const [action, n] of Object.entries(ACTION_COUNTS)) t.set(`act:${action}`, n);
  return t;
}

export const DECK_TOTALS = buildTotals();

/** 106 — the STOCK deck. Still a checkable claim, and still checked; it is just no
 *  longer the only deck a game can be played with (see totalsFor). */
export const DECK_SIZE = [...DECK_TOTALS.values()].reduce((a, b) => a + b, 0);

/* ── custom decks (§3 deck knob) ──────────────────────────────────────────
 *
 * The whole census rests on "total(kind) is a known constant". A lobby can now
 * change thirteen of those constants, so the constant is per-GAME rather than
 * per-build, and the snapshot carries it: getPlayerView ships the resolved
 * ruleset, and `rules.deck` is the count map the deck was built from.
 *
 * Without this the panel silently lies on any custom deck — a third Inspector
 * General reads as "1 gone, 1 live" out of a total of 2, and the conservation
 * line stops adding up. It is the same failure the file's own header warns
 * about ("a mirror nobody checks is a lie with a timer on it"), so the mirror
 * is extended rather than left to rot.
 *
 * WILD_PAIR_ORDER is the one genuinely new mirror: game.js WILD_PAIRS is an
 * ORDERED list and `wildPairs: n` takes the first n, so the client cannot know
 * which pairs a count of 8 means without knowing the order. Pinned against the
 * real deck, at several counts, by test/deckconfig.test.js.
 */
export const WILD_PAIR_ORDER = Object.freeze([
  'brown|lightblue', 'orange|pink', 'red|yellow', 'darkblue|green',
  'base|intel', 'base|green', 'brown|lightblue', 'orange|pink', 'red|yellow',
].map(k => k.split('|').sort().join('|')));

/** The count map's keys, so an unknown field cannot silently become a card. */
const DECK_ACTION_KINDS = Object.freeze(Object.keys(ACTION_COUNTS));

/**
 * The totals table for the deck THIS GAME is played with.
 * @param {object|null|undefined} deck  `snapshot.rules.deck`; absent ⇒ the stock deck
 * @returns {Map<string, number>}
 */
export function totalsFor(deck) {
  if (!deck || typeof deck !== 'object') return DECK_TOTALS;
  const t = new Map(DECK_TOTALS);
  for (const kind of DECK_ACTION_KINDS) {
    if (Number.isInteger(deck[kind])) t.set(`act:${kind}`, deck[kind]);
  }
  if (Number.isInteger(deck.wildAny)) t.set('wild:any', deck.wildAny);
  if (Number.isInteger(deck.wildPairs)) {
    for (const key of new Set(WILD_PAIR_ORDER)) t.set(`wild:${key}`, 0);
    for (const key of WILD_PAIR_ORDER.slice(0, deck.wildPairs)) {
      t.set(`wild:${key}`, (t.get(`wild:${key}`) || 0) + 1);
    }
  }
  return t;
}

/** The size of the deck this game is played with. */
export function sizeOf(totals) {
  return [...totals.values()].reduce((a, b) => a + b, 0);
}

/* ── labels ───────────────────────────────────────────────────────────────── */

const ACTION_LABELS = Object.freeze({
  chud: 'THE CHUD CARD', inspector_general: 'Inspector General',
  midnight_requisition: 'Midnight Requisition', tdy_orders: 'TDY Orders',
  finance_office: 'Finance Office', roll_call: 'Roll Call',
  surge_ops: 'Surge Operations', pcs_orders: 'PCS Orders',
  upgrade: 'Upgrade (House)', foc: 'Full Op Capability', opsec: 'OPSEC',
});

/**
 * pairKey() sorts the colour KEYS so a pair has one identity whichever order it
 * arrives in — that is a lookup key and it must stay sorted. It is not a reading
 * order: 'orange|pink' printed "Rent: Test & Eval / Space Force" while core/cards.js
 * cardName() (which every other surface uses) prints the card's own colour order,
 * "Rent: Space Force / Test & Eval". COLOR_KEYS is that order — it is the deck's
 * order in game.js buildDeck() and the column order on every board — so the label
 * is rendered in it and the key is left alone.
 */
const pairName = (key) => key.split('|')
  .sort((a, b) => COLOR_KEYS.indexOf(a) - COLOR_KEYS.indexOf(b))
  .map(colorName).join(' / ');

export function kindLabel(key) {
  const [kind, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  switch (kind) {
    case 'prop': return colorName(rest);
    case 'wild': return rest === 'any' ? 'Wild: any colour' : `Wild: ${pairName(rest)}`;
    case 'rent': return rest === 'any' ? 'Rent: any colour' : `Rent: ${pairName(rest)}`;
    case 'money': return `${rest}M note`;
    case 'act': return ACTION_LABELS[rest] || rest;
    default: return key;
  }
}

/** The colour a row belongs to, for the swatch. null for colourless kinds. */
export function kindColor(key) {
  if (key.startsWith('prop:')) return key.slice(5);
  return null;
}

/* ── groups, in the order a player cares about them ───────────────────────── */

// The five cards that decide a final approach (help.js "How you break someone"),
// plus the one that stops them. These lead, because "is the CHUD still live?"
// is the question the owner actually named.
const THREAT = ['act:chud', 'act:inspector_general', 'act:opsec',
  'act:midnight_requisition', 'act:tdy_orders'];

const GROUPS = [
  { id: 'threat', title: 'Set-breakers & OPSEC', keys: () => THREAT },
  {
    id: 'action',
    title: 'Other actions',
    keys: () => Object.keys(ACTION_COUNTS).map(a => `act:${a}`).filter(k => !THREAT.includes(k)),
  },
  {
    id: 'rent',
    title: 'Rent',
    keys: () => ['rent:any', ...RENT_PAIRS.map(p => `rent:${pairKey(p)}`)],
  },
  { id: 'prop', title: 'Property', keys: () => COLOR_KEYS.map(c => `prop:${c}`) },
  { id: 'wild', title: 'Wilds', keys: () => Object.keys(WILD_COUNTS).map(k => `wild:${k}`) },
  {
    id: 'money',
    title: 'Money',
    keys: () => Object.keys(MONEY_COUNTS).sort((a, b) => a - b).map(v => `money:${v}`),
  },
];

/* ── the count ────────────────────────────────────────────────────────────── */

function bump(map, key, n = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + n);
}

/**
 * @param {object} snapshot  the live game view
 * @param {string} selfId
 * @returns {{
 *   total:number, gone:number, visible:number, unseen:number,
 *   deckCount:number, hiddenHands:number,
 *   groups:Array<{id:string,title:string,rows:Array<
 *     {key:string,label:string,color:string|null,total:number,gone:number,live:number}>}>
 * }}
 *   `live` is "not in the discard and not on a table you can see" — deck plus
 *   hidden hands. It is clamped at 0: a snapshot the client half-applied must
 *   not be able to print a negative count.
 */
export function census(snapshot, selfId) {
  // Per-GAME totals, not the build's constants — a custom deck must not make this
  // panel print numbers that do not add up (§3 deck knob).
  const totals = totalsFor(snapshot?.rules?.deck);
  const deckSize = sizeOf(totals);
  const gone = new Map();
  const seen = new Map();

  for (const card of snapshot?.discardPile || []) bump(gone, kindKey(card));

  let hiddenHands = 0;
  for (const player of snapshot?.players || []) {
    if (Array.isArray(player.hand)) for (const c of player.hand) bump(seen, kindKey(c));
    else hiddenHands += player.handCount || 0;
    for (const c of player.bank || []) bump(seen, kindKey(c));
    for (const color of COLOR_KEYS) {
      for (const c of player.properties?.[color] || []) bump(seen, kindKey(c));
      for (const u of player.upgrades?.[color] || []) bump(seen, upgradeKey(u));
    }
  }

  const groups = GROUPS.map(g => ({
    id: g.id,
    title: g.title,
    // A kind the deck was built with ZERO of is not a row worth printing — an
    // MD Faithful table has no CHUD card and should not be told "0 of 0 live".
    rows: g.keys().filter(key => (totals.get(key) || 0) > 0).map((key) => {
      const total = totals.get(key) || 0;
      const g0 = gone.get(key) || 0;
      const s0 = seen.get(key) || 0;
      return {
        key,
        label: kindLabel(key),
        color: kindColor(key),
        total,
        gone: g0,
        live: Math.max(0, total - g0 - s0),
      };
    }),
  }));

  const goneTotal = (snapshot?.discardPile || []).length;
  const visible = [...seen.values()].reduce((a, b) => a + b, 0);
  return {
    total: deckSize,
    gone: goneTotal,
    visible,
    unseen: Math.max(0, deckSize - goneTotal - visible),
    deckCount: snapshot?.deckCount || 0,
    hiddenHands,
    groups,
  };
}

/* ── the pile, grouped for browsing ───────────────────────────────────────── */

export const FILTERS = Object.freeze([
  { id: 'all', label: 'All', match: () => true },
  { id: 'action', label: 'Actions', match: (c) => c.type === 'action' },
  { id: 'rent', label: 'Rent', match: (c) => c.type === 'rent' },
  { id: 'property', label: 'Property', match: (c) => c.type === 'property' || c.type === 'wild_property' },
  { id: 'money', label: 'Money', match: (c) => c.type === 'money' },
]);

/** Newest first — getPlayerView already reverses `discardPile` for us. */
export function pileCards(snapshot, filterId = 'all') {
  const f = FILTERS.find(x => x.id === filterId) || FILTERS[0];
  return (snapshot?.discardPile || []).filter(c => c && f.match(c));
}

/** A card's display name, so the census and the pile agree. */
export const pileCardName = cardName;
