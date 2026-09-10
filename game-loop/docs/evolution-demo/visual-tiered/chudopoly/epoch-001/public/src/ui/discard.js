// ui/discard.js — the discard pile, browsable, and the deck census with it.
//
// OWNER REQUEST (P8): "we need an easier discard view."
//
// Before this the discard pile had NO `data-action` anywhere in the client and
// no keyboard route: table/index.js renders the top DISCARD_VISIBLE (4) cards
// and culls the rest from the DOM entirely, so 90% of the pile was
// uninspectable even though `getPlayerView` ships the whole thing (newest
// first). In Monopoly Deal that is real hidden information: how many OPSEC are
// gone, whether a CHUD is still live, which rents have been spent.
//
// Two panels, because the pile answers a different question from the census:
//   PILE        — every discarded card, newest first, filterable by type, each
//                 one readable (peek on hover, tap for the inline reader).
//   WHAT'S LEFT — per card kind: how many are GONE and how many are still LIVE
//                 (ui/deckcensus.js: total − discarded − everything you can
//                 see, i.e. deck + hidden hands, and it says so).
//
// The cards here are NOT table card nodes. §0.4 gives one persistent node per
// card id and table/reconcile() has already forgotten every culled card, so
// these are freshly built faces through the SAME renderer
// (table/cardnode.js buildFace + refresh) and deliberately carry no
// `data-card-id` — a second node claiming an id is exactly what §0.4 forbids.
// `data-peek-card` is the parallel hook ui/peek.js reads.

import { el, clear, setClass, setAttr } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import { store } from '../state/store.js';
import { buildFace, refresh } from '../table/cardnode.js';
import { cardName, COLORS } from '../core/cards.js';
import * as pointer from '../interact/pointer.js';
import { openSheet, sheetOpen } from './screens.js';
import { detailBody } from './details.js';
import { census, pileCards, FILTERS } from './deckcensus.js';

let panel = 'pile';              // 'pile' | 'left'
let filter = 'all';
let host = null;                 // the sheet body we own while it is open
let reading = null;              // card id shown in the inline reader

/* ── the tappable pile (public/index.html is architect-owned, §1) ─────────── */

/**
 * Turn the centre-table discard stack into a control. It is put on the `.pile`
 * wrapper, not on the cards, so the label and the empty stack are part of the
 * same 44px target — and so a pile with nothing in it still answers the
 * question ("nothing has been discarded yet").
 */
export function install() {
  const zone = document.querySelector('[data-zone="discard"]');
  const pile = zone?.closest('.pile');
  if (!pile || pile.dataset.action) return;
  pile.dataset.action = 'open-discard';
  setAttr(pile, 'role', 'button');
  setAttr(pile, 'tabindex', '0');
  setAttr(pile, 'aria-label', 'Discard pile — browse every discarded card');
  setAttr(pile, 'title', 'Browse the discard pile and see what is left in the deck');
  setClass(pile, 'is-openable', true);
}

/* ── the sheet ────────────────────────────────────────────────────────────── */

const tab = (id, label, count) => el('button', {
  class: `brief-tab${panel === id ? ' is-on' : ''}`,
  attrs: { type: 'button', role: 'tab', 'aria-selected': panel === id ? 'true' : 'false' },
  dataset: { action: 'discard-panel', panel: id },
}, [
  el('span', { text: label }),
  count == null ? null : el('span', { class: 'dv-tab-n', text: String(count) }),
].filter(Boolean));

function filterRail(snap) {
  const rail = el('div', { class: 'dv-filters', attrs: { role: 'group', 'aria-label': 'Filter the pile' } });
  for (const f of FILTERS) {
    const n = pileCards(snap, f.id).length;
    rail.appendChild(el('button', {
      class: `chip dv-chip${filter === f.id ? ' is-on' : ''}${n ? '' : ' is-none'}`,
      attrs: { type: 'button', 'aria-pressed': filter === f.id ? 'true' : 'false' },
      dataset: { action: 'discard-filter', filter: f.id },
      text: `${f.label} ${n}`,
    }));
  }
  return rail;
}

/** A face through the shipped renderer, with no card identity attached. */
function faceNode(card) {
  const node = el('div', { class: 'card dv-face', dataset: { type: card.type || 'unknown' } });
  node.appendChild(buildFace(card));
  refresh(node, card);                       // --band colour, action kind, aria-label
  node.removeAttribute('aria-label');        // the button below carries it instead
  return node;
}

function pileCard(card, index) {
  const btn = el('button', {
    class: `dv-card${reading === card.id ? ' is-reading' : ''}`,
    attrs: {
      type: 'button',
      'aria-expanded': reading === card.id ? 'true' : 'false',
      'aria-label': `${cardName(card) || card.name}, ${card.value ?? 0}M`
        + `${index === 0 ? ' — most recently discarded' : ''}`,
    },
    dataset: { action: 'discard-read', card: String(card.id), peekCard: String(card.id) },
  }, [faceNode(card)]);
  if (index === 0) btn.appendChild(el('span', { class: 'dv-newest', text: 'NEWEST' }));
  // The name, under the card, always. MEASURED on the phone shot: at the mini
  // tier the face degrades to band + art + coin (table.css container queries),
  // so eleven discarded actions all read "ACTION 3M" and the pile answered
  // nothing — which is the whole point of the view.
  btn.appendChild(el('span', { class: 'dv-name', text: cardName(card) || card.name || '' }));
  return btn;
}

function pilePanel(snap) {
  const box = el('div', { class: 'dv-panel' });
  const cards = pileCards(snap, filter);
  box.appendChild(filterRail(snap));

  const reader = el('div', { class: 'dv-reader', attrs: { id: 'dv-reader' } });
  box.appendChild(reader);
  paintReader(reader, snap);

  if (!cards.length) {
    box.appendChild(el('p', {
      class: 'brief-note',
      text: (snap.discardPile || []).length
        ? 'Nothing of that kind has been discarded yet.'
        : 'Nothing has been discarded yet. Cards arrive here when they are played, '
          + 'spent as OPSEC, or dropped at the hand limit.',
    }));
    return box;
  }

  box.appendChild(el('p', { class: 'dv-count', text: `${cards.length} card${cards.length === 1 ? '' : 's'} · newest first` }));
  const grid = el('div', { class: 'dv-grid' });
  for (let i = 0; i < cards.length; i++) grid.appendChild(pileCard(cards[i], i));
  box.appendChild(grid);
  return box;
}

function paintReader(reader, snap) {
  clear(reader);
  if (reading == null) return;
  const card = (snap.discardPile || []).find(c => c.id === reading);
  if (!card) { reading = null; return; }
  const body = detailBody(card);
  reader.appendChild(el('div', { class: 'dv-reader-head' }, [
    el('span', { class: 'dv-reader-name', text: cardName(card) || card.name || '' }),
    el('button', {
      class: 'btn btn-icon', text: '✕',
      attrs: { type: 'button', 'aria-label': 'Close the card reader' },
      dataset: { action: 'discard-read', card: String(card.id) },
    }),
  ]));
  reader.appendChild(faceNode(card));
  if (body) reader.appendChild(body);
}

/* ── "what's left" ────────────────────────────────────────────────────────── */

function censusRow(row) {
  const dead = row.live === 0;
  return el('div', { class: `dv-row${dead ? ' is-dead' : ''}${row.gone ? ' is-spent' : ''}` }, [
    el('span', { class: 'dv-row-name' }, [
      row.color && COLORS[row.color]
        ? el('span', { class: 'brief-swatch', dataset: { color: row.color } })
        : null,
      el('span', { text: row.label }),
    ].filter(Boolean)),
    el('span', { class: 'dv-row-gone', text: `${row.gone} gone` }),
    el('span', {
      class: `dv-row-live${dead ? ' is-out' : ''}`,
      text: dead ? 'none left' : `${row.live} live`,
    }),
  ]);
}

function leftPanel(snap) {
  const c = census(snap, store.self.id);
  const box = el('div', { class: 'dv-panel' });

  // The honest definition, stated before any number is read. The client CANNOT
  // separate "in the deck" from "in someone's hand" — getPlayerView redacts
  // both — so it never claims to.
  box.appendChild(el('p', { class: 'brief-lede' },
    [el('b', { text: `${c.unseen} cards you cannot see` }),
      el('span', {
        text: ` — ${c.deckCount} in the deck and ${c.hiddenHands} in other players' hands. `
          + `${c.gone} are in the discard; ${c.visible} are face-up on the table or in your hand.`,
      })]));
  box.appendChild(el('p', {
    class: 'brief-note',
    text: '"Live" means not discarded and not visible — it is in the deck or in a hand. '
      + 'The 106-card deck composition is fixed, so these totals are exact.',
  }));

  for (const group of c.groups) {
    box.appendChild(el('h5', { class: 'brief-sub', text: group.title }));
    const list = el('div', { class: 'dv-rows' });
    for (const row of group.rows) list.appendChild(censusRow(row));
    box.appendChild(list);
  }
  return box;
}

/* ── paint ────────────────────────────────────────────────────────────────── */

function paint() {
  const snap = store.snapshot;
  if (!host?.isConnected || !snap) return;
  clear(host);
  const total = (snap.discardPile || []).length;
  host.appendChild(el('div', {
    class: 'brief-tabs', attrs: { role: 'tablist', 'aria-label': 'Discard views' },
  }, [tab('pile', 'Pile', total), tab('left', "What's left", null)]));
  host.appendChild(panel === 'pile' ? pilePanel(snap) : leftPanel(snap));
}

export function show(which) {
  if (which === 'pile' || which === 'left') panel = which;
  reading = null;
  host = el('div', { class: 'brief dv' });
  const total = (store.snapshot?.discardPile || []).length;
  openSheet(`Discard pile · ${total}`, host, { onClose: () => { host = null; reading = null; } });
  paint();
}

export function isOpen() { return !!host?.isConnected && sheetOpen(); }

export function mount() {
  install();
  pointer.registerActions({
    'open-discard': () => show('pile'),
    'discard-panel': (elx) => { panel = elx.dataset.panel === 'left' ? 'left' : 'pile'; paint(); },
    'discard-filter': (elx) => { filter = elx.dataset.filter || 'all'; reading = null; paint(); },
    'discard-read': (elx) => {
      const id = Number(elx.dataset.card);
      reading = reading === id ? null : id;
      paint();
      // Keep the reader on screen: the grid can be several screens long and the
      // reader is pinned at the top of the panel.
      document.getElementById('dv-reader')?.scrollIntoView({ block: 'nearest' });
    },
  });

  // The pile node is created by index.html and never rebuilt, but the seat
  // rebuild (layout.syncSeats) can run before this module mounts.
  bus.on(EVENTS.STATE_APPLIED, () => {
    install();
    if (isOpen()) paint();
  });
}
