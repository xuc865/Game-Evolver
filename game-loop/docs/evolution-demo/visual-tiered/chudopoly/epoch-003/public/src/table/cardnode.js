// table/cardnode.js — persistent card nodes, keyed by card id (§0.4).
//
// A card node is created once and then only ever REPARENTED. Its face is built
// once and cached on the node; the only per-reconcile writes are guarded
// attribute writes (placedColor on a wild, selection flags). Nothing in this
// file writes innerHTML — checkClient greps for it, and a rebuild mid-FLIP
// destroys the node the transform is running on.

import { el, setAttr, setText } from '../core/dom.js';
import { COLORS, kindLabel, isPropertyCard, cardName } from '../core/cards.js';
import { stableSpread } from '../core/rng.js';
import * as flight from '../anim/flight.js';
import { faceNode, backNode } from './cardart.js';

const nodes = new Map();      // cardId -> element
const backs = [];             // pooled face-down nodes (deck + opponent hands)

export function getNode(id) { return nodes.get(id); }
export function allNodes() { return nodes; }

export function forgetNode(id) {
  const node = nodes.get(id);
  if (node?.parentNode) node.parentNode.removeChild(node);
  nodes.delete(id);
}

export function cardNode(card) {
  if (!card || card.id == null) return null;
  let node = nodes.get(card.id);
  if (!node) {
    node = buildCard(card);
    nodes.set(card.id, node);
  } else {
    refresh(node, card);
  }
  return node;
}

/**
 * Structure (P4 — the flip needs it, style/motion.css gives it its 3D):
 *
 *   .card[data-facing]              ← the transform contract lives here
 *     .card-inner                   ← rotateY(var(--flip)) ONLY
 *       .card-face                  ← backface-visibility:hidden
 *       .card-back                  ← pre-rotated 180deg
 *
 * The wrapper exists so a flip never touches the outer transform. Everything
 * table.css says about .card-face / .card-back still applies — they are all
 * descendant selectors, and `.card > * { pointer-events:none }` still covers
 * the whole subtree because pointer-events inherits.
 */
function buildCard(card) {
  const node = el('div', {
    class: 'card',
    attrs: { 'data-card-id': card.id, 'data-facing': 'up', tabindex: '-1' },
    dataset: { type: card.type || 'unknown' },
  });
  node.__card = card;
  node.__rx = 0; node.__ry = 0; node.__rt = 0;
  node.appendChild(el('div', { class: 'card-inner' }, [
    buildFace(card),
    el('div', { class: 'card-back' }, [backNode('hand')]),
  ]));
  refresh(node, card);
  return node;
}

/**
 * The card FACE, standalone. Exported so nothing has to deep-clone a live card
 * node to render a big one: ui/peek.js was cloning a node and then stripping
 * data-card-id and the pose vars off the copy, which is one accidental
 * `querySelector('[data-card-id]')` away from a second node claiming a card id
 * that §0.4 says is unique. It is also the seam an SVG art renderer plugs into.
 */
export function buildFace(card) {
  const face = el('div', { class: 'card-face' });

  // table/cardart.js is that renderer. ONE face is built per card and then only
  // reparented, so the art cannot be re-rendered per zone — style/cardart.css
  // degrades this single face with container queries on the card's own width
  // (≤66 / ≤48 / ≤34px), which is what lets a hand card become a 38px board
  // chip and a 18px upgrade chip without anything touching the DOM.
  const art = faceNode(card, 'hand');
  if (art) {
    face.appendChild(art);
    return face;
  }

  // Fallback: the pre-art face. Reached only if cardart declines the card.
  face.appendChild(el('div', { class: 'card-band', text: kindLabel(card) }));
  face.appendChild(el('div', { class: 'card-name', text: cardName(card) || card.name || '' }));
  face.appendChild(el('div', { class: 'card-art' }));

  const foot = el('div', { class: 'card-foot' });
  foot.appendChild(el('span', { class: 'card-ladder', text: ladderText(card) }));
  foot.appendChild(el('span', { class: 'card-coin', text: `${card.value ?? 0}M` }));
  face.appendChild(foot);
  return face;
}

function ladderText(card) {
  if (card.type === 'property') {
    const info = COLORS[card.color];
    return info ? info.rent.join('/') : '';
  }
  if (card.type === 'wild_property') {
    return card.colors?.[0] === 'any' ? 'ANY' : card.colors.map(c => COLORS[c]?.short || c).join('/');
  }
  if (card.type === 'rent') {
    return card.colors?.[0] === 'any' ? 'ANY · 1 PLAYER' : card.colors.map(c => COLORS[c]?.short || c).join('/');
  }
  if (card.type === 'action') return (card.action || '').replace(/_/g, ' ').toUpperCase();
  return '';
}

/** Guarded refresh: a wild's placedColor is the only field that legitimately moves. */
export function refresh(node, card) {
  if (!node || !card) return;
  node.__card = card;
  const color = card.placedColor || card.color || (isPropertyCard(card) ? card.colors?.[0] : null);
  setAttr(node, 'data-color', color && COLORS[color] ? color : null);
  setAttr(node, 'data-action-kind', card.action || null);
  setAttr(node, 'aria-label', `${cardName(card) || card.name || 'Card'}, ${card.value ?? 0}M`);
  const band = node.querySelector('.card-band');
  if (band) setText(band, kindLabel(card));
}

/* ── rest pose ───────────────────────────────────────────────────────────
   Where a card SITS when nothing is animating it, as three numbers on the
   node: __rx/__ry (px offsets from its layout box) and __rt (degrees). Every
   flight lands on this pose rather than on zero, which is what lets the hand
   fan and the discard scatter survive a card flying into them. Changing the
   pose mid-flight retargets the flight instead of fighting it. */

export function setRest(node, x, y, deg) {
  if (!node) return;
  if (node.__rx === x && node.__ry === y && node.__rt === deg) return;
  node.__rx = x; node.__ry = y; node.__rt = deg;
  flight.retarget(node);
}

/** Deterministic scatter for the discard pile — never Math.random (§5). */
export function tilt(node, id, range, salt = 0) {
  setRest(node,
    stableSpread(id, 3.2, salt + 5),
    stableSpread(id, 3.2, salt + 9),
    stableSpread(id, range, salt));
}

/* ── Face-down pool ──────────────────────────────────────────────────────
   Deck stack and opponent hands are COUNTS, not identities. Pooling them keeps
   the id-keyed registry honest: a pooled back is never mistaken for a card that
   drifted, because it has no card id to drift with. */

export function takeBack() {
  // No .card-inner: a pooled back has no face, never flips, and keeping it flat
  // keeps it out of the 3D context the flip rules create.
  const node = backs.pop() || el('div', {
    class: 'card card-facedown',
    attrs: { 'data-back': '1', 'aria-hidden': 'true' },
  }, [el('div', { class: 'card-back' }, [backNode('hand')])]);
  return node;
}

export function releaseBack(node) {
  if (!node) return;
  flight.cancel(node);
  if (node.parentNode) node.parentNode.removeChild(node);
  node.style.cssText = '';
  node.__rx = 0; node.__ry = 0; node.__rt = 0;
  if (backs.length < 64) backs.push(node);
}

/**
 * Set a zone's face-down child count to exactly `count`, reusing pooled nodes.
 * @param {{tilt?:number, lift?:number}} opts  tilt = degrees per step (an
 *        opponent's fanned hand); lift = px per step (the deck's stack depth).
 */
export function syncBacks(zone, count, opts = null) {
  if (!zone) return;
  let have = zone.childElementCount;
  while (have > count) { releaseBack(zone.lastElementChild); have--; }
  while (have < count) {
    const back = takeBack();
    zone.appendChild(back);
    have++;
  }
  if (!opts) return;
  const tiltStep = opts.tilt || 0;
  const lift = opts.lift || 0;
  let i = 0;
  for (let child = zone.firstElementChild; child; child = child.nextElementSibling, i++) {
    setRest(child, 0, i * lift, tiltStep ? (i - (count - 1) / 2) * tiltStep : 0);
    const idx = String(i);
    if (child.style.getPropertyValue('--i') !== idx) child.style.setProperty('--i', idx);
  }
}
