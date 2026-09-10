// core/cards.js — card + colour metadata for the CLIENT.
//
// Mirror of the COLORS table in game.js. It is duplicated rather than imported
// because game.js is CommonJS running on the server and §0.2 forbids a build
// step that could share it. game.js is the source of truth: if a set size or
// rent ladder disagrees, game.js wins and this file is the bug.
//
// The client needs it for three things the broadcast does not carry:
//   • set completeness per colour (game.completedSets is a COUNT, not a list)
//   • rent ladders shown on card faces and set columns
//   • which colours a wild may legally occupy

export const COLORS = Object.freeze({
  brown:     { name: 'Drone Ops',      short: 'DRONE',   size: 2, rent: [1, 2],       hue: '#8B4513', ink: '#fff' },
  lightblue: { name: 'Training',       short: 'TRAIN',   size: 3, rent: [1, 2, 3],    hue: '#87CEEB', ink: '#000' },
  pink:      { name: 'Space Force',    short: 'SPACE',   size: 3, rent: [1, 2, 4],    hue: '#FF69B4', ink: '#000' },
  orange:    { name: 'Test & Eval',    short: 'T&E',     size: 3, rent: [1, 3, 5],    hue: '#FF8C00', ink: '#000' },
  red:       { name: 'Fighters',       short: 'FIGHT',   size: 3, rent: [2, 3, 6],    hue: '#DC143C', ink: '#fff' },
  yellow:    { name: 'Mobility',       short: 'MOBIL',   size: 3, rent: [2, 4, 6],    hue: '#FFD700', ink: '#000' },
  green:     { name: 'Elite Programs', short: 'ELITE',   size: 3, rent: [2, 4, 7],    hue: '#228B22', ink: '#fff' },
  darkblue:  { name: 'Command',        short: 'CMD',     size: 2, rent: [3, 8],       hue: '#00308F', ink: '#fff' },
  base:      { name: 'Overseas Bases', short: 'BASES',   size: 4, rent: [1, 2, 3, 4], hue: '#2F4F4F', ink: '#fff' },
  intel:     { name: 'Intelligence',   short: 'INTEL',   size: 2, rent: [1, 2],       hue: '#708090', ink: '#fff' },
});

export const COLOR_KEYS = Object.freeze(Object.keys(COLORS));

export const HAND_LIMIT = 7;
export const SETS_TO_WIN = 3;
/** game.js DECK_CYCLE_LIMIT (§3.11). The live snapshot carries deckCycleLimit
 *  and always wins; this is the number the help sheet quotes when there is no
 *  game on screen. test/ui-contract.test.js cross-checks it against game.js. */
export const DECK_CYCLE_LIMIT = 16;

/** The cycle at which the HUD starts showing the counter. Half the allowance is
 *  where an attrition finish stops being theoretical (game.js: healthy games
 *  spend 1.9 cycles, p90 5). ui/hud.js and ui/help.js must agree, or the brief
 *  promises a warning the HUD does not give. */
export function deckCycleNotice(limit = DECK_CYCLE_LIMIT) {
  return Math.ceil((limit || DECK_CYCLE_LIMIT) / 2);
}

/** game.js REARRANGE_BUDGET (347): accepted board moves per turn, refilled by
 *  beginTurn() exactly like playsRemaining. The live snapshot carries
 *  `rearrangeBudget` and always wins; this is the number the help quotes with
 *  no game on screen. The brief said "Free, unlimited" while moveProperty()
 *  (game.js:1987-1989) refused the 13th move of a turn — measured, and the
 *  refusal copy names the rule the help never stated. */
export const REARRANGE_BUDGET = 12;

/** game.js SWAP_COST (352): the atomic two-card exchange moves TWO cards, so
 *  it draws TWO from the same budget. state/selectors.js canSwap() reads this
 *  mirror; test/property-swap.test.js pins the engine pair against each other. */
export const SWAP_COST = 2;

/** Which actions need what before play_action is legal (mirrors game.js playAction). */
export const ACTION_NEEDS = Object.freeze({
  pcs_orders:            [],
  surge_ops:             [],
  roll_call:             [],
  finance_office:        ['player'],
  inspector_general:     ['player', 'theirSet'],
  midnight_requisition:  ['player', 'theirCard'],
  chud:                  ['player', 'theirCard'],
  tdy_orders:            ['myCard', 'player', 'theirCard'],
  upgrade:               ['mySet'],
  foc:                   ['mySet'],
  opsec:                 null,          // response-only; never played from the strip
});

export function colorName(color) { return COLORS[color]?.name || color || '—'; }
export function setSize(color) { return COLORS[color]?.size || 0; }

/**
 * Mirror of game.js zoneIsSet()/isSetComplete() (game.js:351-356, 576-578).
 *
 * `rules` carries the resolved ruleset's flags; core/ is dependency-free by
 * design, so the caller supplies them (state/selectors.js activeRuleFlags()
 * reads them off the snapshot's `rules`). Under `pureSetRequired` — ON in the
 * MD Faithful preset — a FULL zone is only a SET if at least one card in it is
 * NOT a rainbow ("any") wild. Our 2-card zones make an all-rainbow set
 * otherwise trivial. Note what it does NOT ban: two-colour wilds may fill a
 * zone on their own, because Hasbro's 2025 printings say so on the card face
 * ("You may make a complete player set using only these cards"), and the
 * every-colour wild is the only one that carries "You may not".
 *
 * Without this, a client counting only `length >= size` disagreed with the
 * `completedSets` number the engine prints right beside its own swatches.
 */
export function isRainbowWild(card) {
  return !!card && card.type === 'wild_property' && !!card.colors && card.colors[0] === 'any';
}

export function isComplete(player, color, rules) {
  const size = setSize(color);
  const cards = player?.properties?.[color] || [];
  if (size === 0 || cards.length < size) return false;
  if (rules?.pureSetRequired && !cards.some(c => !isRainbowWild(c))) return false;
  return true;
}

export function completeColors(player, rules) {
  const out = [];
  for (const color of COLOR_KEYS) if (isComplete(player, color, rules)) out.push(color);
  return out;
}

/** A zone holds at most `size` property cards (§3.5). */
export function zoneFull(player, color) {
  const size = setSize(color);
  return size === 0 || (player?.properties?.[color]?.length || 0) >= size;
}

/**
 * Neither Midnight Requisition NOR TDY Orders may touch a complete set — and
 * for TDY that is true on both sides of the trade (§3.1, reversed 2026-08-06;
 * game.js playAction 'midnight_requisition':1101 and 'tdy_orders':1123-1126).
 *
 * CHUD is the only card that can take ONE CARD out of a complete set. It is NOT
 * "the only card that can touch a complete set at all": playAction
 * 'inspector_general' (game.js:1082) REQUIRES `isSetComplete(target, color)` and
 * refuses anything else with "That set is not complete". Measured both ways.
 * The distinction is card-vs-set, and every surface must say it that way.
 *
 * Mirrors game.js zoneRequisitionable() (590-593): `zoneCount > 0 && NOT a
 * set`. Expressed against isComplete() rather than `n < size` so it stays
 * right under pureSetRequired, where a full zone of nothing but wilds is not a
 * set and IS fair game.
 */
export function requisitionable(player, color, rules) {
  const n = player?.properties?.[color]?.length || 0;
  return n > 0 && !isComplete(player, color, rules);
}

/** Every Upgrade/FOC object on a player's board, in colour order. They are
 *  payable (game.js payableCards():710-717), so the payment selector needs
 *  them; `upgrades[color]` may hold bare strings in old fixtures. */
export function upgradeCards(player) {
  const out = [];
  for (const color of COLOR_KEYS) {
    for (const u of player?.upgrades?.[color] || []) if (u && typeof u === 'object') out.push(u);
  }
  return out;
}

export function legalColorsFor(card) {
  if (!card) return [];
  if (card.type === 'property') return [card.color];
  if (!card.colors) return [];
  return card.colors[0] === 'any' ? COLOR_KEYS.slice() : card.colors.slice();
}

export function rentFor(player, color) {
  const info = COLORS[color];
  if (!info) return 0;
  const count = player?.properties?.[color]?.length || 0;
  if (count === 0) return 0;
  let rent = info.rent[Math.min(count, info.rent.length) - 1];
  const kinds = upgradeKinds(player, color);
  if (kinds.includes('house')) rent += 3;
  if (kinds.includes('hotel')) rent += 4;
  return rent;
}

export function upgradeKinds(player, color) {
  return (player?.upgrades?.[color] || []).map(u => (typeof u === 'string' ? u : u?.upgradeType));
}

export function isPropertyCard(card) {
  return card?.type === 'property' || card?.type === 'wild_property';
}

/* ── card copy (§3.9: no rule may exist that the help does not state) ─────
 *
 * Every string below was read off game.js before it was written, and names the
 * function that implements it. The server ships a terse `description` on action
 * cards (game.js buildDeck); these supersede it because they carry the riders
 * the one-liner leaves out (what OPSEC can touch, what an Upgrade does when the
 * set breaks). If a line here and game.js disagree, game.js wins and this file
 * is the bug.
 */

export const ACTION_RULES = Object.freeze({
  // playAction case 'pcs_orders' — draws 2, no pendingAction, so nothing to counter.
  pcs_orders: 'Draw 2 more cards. It aims at nobody, so OPSEC cannot touch it.',
  // §3.1c — playAction case 'surge_ops' (game.js:1165) increments a COUNTER and
  // never refuses a second copy; chargeAmount() (game.js:994-1000) passes
  // surgeable:true from the RENT branch only, and multiplies by 2**stack.
  // Verified: 3 Fighters charge 6M → 12M with one, 24M with two; Finance Office
  // stays 5M and Roll Call stays 2M at every stack depth.
  surge_ops: 'Doubles the NEXT RENT you charge this turn — and only rent. Finance Office and '
    + 'Roll Call are untouched. It STACKS: play two and that rent is x4, for two of your three '
    + 'plays. Expires when your turn ends, spent or not.',
  // playAction case 'roll_call' — startPending over every other active player.
  roll_call: 'Every other player pays you 2M. Each of them answers on their own.',
  // playAction case 'finance_office' — single target, 5M.
  finance_office: 'One player you name pays you 5M.',
  // playAction case 'inspector_general' (game.js:1082) REQUIRES isSetComplete()
  // and refuses everything else with "That set is not complete" — measured both
  // ways. executeEntry case 'steal_set' then moves target.upgrades[col] across.
  inspector_general: 'Seize one whole COMPLETE set from a player — it is the only thing this '
    + 'card can be aimed at, and it takes the set entire. Its Upgrade and FOC come with it.',
  // playAction case 'midnight_requisition' + zoneRequisitionable().
  midnight_requisition: 'Take one property. Never out of a complete set.',
  // §3.1 REVERSED 2026-08-06 — playAction case 'tdy_orders' (game.js:1123-1126)
  // now runs zoneRequisitionable() over BOTH sides: "You cannot trade a card out
  // of one of your complete sets" and "TDY Orders cannot touch a complete set".
  // Both errors reproduced against the engine. Worded without naming CHUD: this
  // string renders on every table, including decks built with chud: 0 (the
  // shipped MD Faithful preset), where "separates it from CHUD" compared it to
  // a card that is not in the game.
  tdy_orders: 'Trade one of your properties for one of theirs. Neither card may come out of a '
    + 'complete set — yours or theirs. You always give a card back: it is a trade, never a '
    + 'one-way take.',
  // playAction case 'chud' (game.js:1173) — the ONLY steal with no
  // zoneRequisitionable guard left, and §3.1 removed the tax. It is not the only
  // card that can be pointed at a complete set (Inspector General must be), it is
  // the only one that can pull a SINGLE card out of one.
  chud: 'Commandeer Hardware Under Directive. TAKE any property, even out of a complete set, and '
    + 'give nothing back. It is the only card that can pull ONE card out of a complete set and '
    + 'break it — Midnight Requisition and TDY Orders are locked out of a complete set entirely, '
    + 'and Inspector General can only take one whole. No tax.',
  // §3.1b — playAction case 'upgrade' + calcRent(); payableCards() (game.js:710)
  // includes upgrades; bankUpgradeCard() (game.js:783) BANKS them on a break
  // rather than discarding; moveUpgrade() (game.js:1517) relocates them free.
  upgrade: '+3M rent on one complete set. It is real money: you may hand it over as payment, '
    + 'and if the set under it breaks it drops into your own bank at face value rather than '
    + 'being lost. Move it to another complete set for free on your turn. Pay with it and any '
    + 'FOC standing on that set goes to your bank too — it cannot stay without the Upgrade.',
  // playAction case 'foc' — requires 'house' first, one per set. moveUpgrade()
  // refuses to strand an FOC without its Upgrade, and normalizeUpgrades()
  // (game.js:806-830) enforces the same thing after a PAYMENT: hand over the
  // Upgrade and the engine banks the FOC behind it. Measured: a complete Command
  // set with both charges 15M; pay 3M with the Upgrade and it charges 8M, set
  // still complete. That is the whole surprise and it belongs on the card.
  foc: '+4M rent on a complete set that already has an Upgrade. Same terms: payable, and it '
    + 'banks itself if the set breaks. It moves free between complete sets too, but only onto '
    + 'one that already has an Upgrade — and it can never stand alone. Pay with the Upgrade '
    + 'beneath it and the FOC follows it straight into your bank, so a 3M payment can cost you '
    + '7M of rent on a set you still hold.',
  // respondToAction case 'opsec' — the card is spliced out and discarded before
  // the depth increments, so it is spent whichever way the chain ends.
  opsec: 'Cancels an action aimed at you. They may counter with their own OPSEC, and so on — '
    + 'whoever stops countering loses the exchange. Spent either way.',
});

/** How many of each action card the 106-card deck holds (game.js buildDeck,
 *  the `actions` table plus the two hand-written CHUD cards).
 *  test/ui-contract.test.js cross-checks these against buildDeck(). */
export const ACTION_COUNTS = Object.freeze({
  inspector_general: 2,
  opsec: 3,
  midnight_requisition: 3,
  tdy_orders: 3,
  finance_office: 3,
  roll_call: 3,
  pcs_orders: 10,
  upgrade: 3,
  foc: 2,
  surge_ops: 2,
  chud: 2,
});

/** Rent cards: five colour pairs at 2 each, the "any" rent at 3 (buildDeck). */
export const RENT_COUNTS = Object.freeze({ pair: 2, any: 3 });

/** Actions that create a pendingAction, i.e. the ones OPSEC can answer.
 *  Mirrors which playAction branches call startPending(). */
const BLOCKABLE = Object.freeze(new Set([
  'finance_office', 'roll_call', 'inspector_general',
  'midnight_requisition', 'tdy_orders', 'chud',
]));

export function blockableByOpsec(card) {
  if (!card) return false;
  if (card.type === 'rent') return true;
  return card.type === 'action' && BLOCKABLE.has(card.action);
}

/**
 * The one sentence that goes on a card's OPSEC flag. OPSEC itself is the case
 * the boolean above cannot express: it does not create a pendingAction, so
 * blockableByOpsec() is false — and the catalogue printed "OPSEC CANNOT TOUCH
 * IT" one line under the card's own rule text describing counter-OPSEC (§P7.15).
 * respondToAction case 'opsec' flips entry.responderId and increments depth, so
 * an OPSEC is answered by another OPSEC and by nothing else.
 */
export function opsecFlag(card) {
  if (card?.type === 'action' && card.action === 'opsec') {
    return { text: 'Answered only by another OPSEC', kind: 'chain' };
  }
  return blockableByOpsec(card)
    ? { text: 'OPSEC can cancel it', kind: 'block' }
    : { text: 'OPSEC cannot touch it', kind: 'noblock' };
}

/** Display name. game.js names rent cards off raw colour keys
 *  ("Rent: brown/lightblue"); nothing but this function should be shown. */
export function cardName(card) {
  if (!card) return '';
  if (card.type === 'rent') {
    return card.colors?.[0] === 'any'
      ? 'Rent: Any Colour'
      : `Rent: ${card.colors.map(colorName).join(' / ')}`;
  }
  return card.name || '';
}

/** Short label for the card's kind, used on the type band of the face. */
export function kindLabel(card) {
  if (!card) return '';
  switch (card.type) {
    case 'money': return 'BANK';
    case 'property': return COLORS[card.color]?.short || 'PROPERTY';
    case 'wild_property': return card.colors?.[0] === 'any' ? 'WILD · ANY' : 'WILD';
    case 'rent': return card.colors?.[0] === 'any' ? 'RENT · ANY' : 'RENT';
    case 'action': return card.action === 'chud' ? 'CHUD' : 'ACTION';
    default: return String(card.type || '').toUpperCase();
  }
}

/** Human sentence for what a card does — the help/details text (§3.9).
 *  ACTION_RULES beats the server's `description`: the wire text is the terse
 *  face blurb, these are the rule as implemented. */
export function cardText(card) {
  if (!card) return '';
  if (card.type === 'action') return ACTION_RULES[card.action] || card.description || '';
  if (card.type === 'money') return `Bank it for ${card.value}M of paying power.`;
  if (card.type === 'property') {
    const info = COLORS[card.color];
    return info
      ? `${info.name} — ${info.size} to complete. Rent ladder ${info.rent.join(' / ')}M.`
      : 'Property.';
  }
  if (card.type === 'wild_property') {
    // playProperty/moveProperty accept any colour for an 'any' wild; its value
    // is 0 in buildDeck, which is the whole cost of the card.
    return card.colors?.[0] === 'any'
      ? 'Stands in for any colour. Worth 0M as payment — that is its cost. '
        + 'Move it between your sets for free on your turn.'
      : `Stands in for ${card.colors.map(colorName).join(' or ')}. `
        + 'Move it between those two sets for free on your turn.';
  }
  if (card.type === 'rent') {
    // playAction rent branch: isWildRent → one named target; otherwise every
    // other active player. calcRent() scales with the count, complete or not.
    return card.colors?.[0] === 'any'
      ? 'Charge rent on any ONE colour you own, from ONE player you name. '
        + 'You do not need the complete set.'
      : `Charge rent on your ${card.colors.map(colorName).join(' or ')} — `
        + 'EVERY other player pays. You do not need the complete set.';
  }
  return card.description || '';
}
