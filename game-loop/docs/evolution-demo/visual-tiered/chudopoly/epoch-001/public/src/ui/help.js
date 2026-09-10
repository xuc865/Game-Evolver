// ui/help.js — the mission brief: a paged rules sheet.
//
// §3.9 is the bar: no rule may exist that this screen does not state. Every
// claim below was read out of game.js before it was written, and the function
// that implements it is named in a comment beside it. When game.js and this
// file disagree, game.js wins and this file is the bug.
//
// Paged rather than one long scroll because the old client's single wall of
// text was skipped whole; each page is one question a player actually asks.

import { el, clear, setAttr, setClass } from '../core/dom.js';
import * as pointer from '../interact/pointer.js';
import { openSheet } from './screens.js';
import {
  COLORS, COLOR_KEYS, HAND_LIMIT, ACTION_RULES,
  RENT_COUNTS, colorName, opsecFlag, DECK_CYCLE_LIMIT, deckCycleNotice,
  REARRANGE_BUDGET, SWAP_COST,
} from '../core/cards.js';
import {
  activeRules, winRuleSummary, WIN_RULE_NAMES, SUDDEN_DEATH_COPY, sameDeck, DECK_BASE,
} from './ruleset.js';
import { totalsFor } from './deckcensus.js';
import { BOT_LABEL, BOT_BLURB, BOT_ORDER, botLabel, botBlurb } from '../core/bots.js';
import { store } from '../state/store.js';

/* ── small builders ──────────────────────────────────────────────────────── */

const p = (text, cls = '') => el('p', { class: cls || null, text });

function bullets(lines) {
  const list = el('ul', { class: 'brief-list' });
  for (const line of lines) list.appendChild(el('li', { text: line }));
  return list;
}

/** A labelled rule row: the claim in bold, the consequence under it. */
function rules(rows) {
  const box = el('dl', { class: 'brief-rules' });
  for (const [term, def] of rows) {
    box.appendChild(el('dt', { text: term }));
    box.appendChild(el('dd', { text: def }));
  }
  return box;
}

function note(text) { return el('p', { class: 'brief-note', text }); }

/** "third", not "threeth". countWord() gives the cardinal; this page needs the
 *  ordinal, and `countWord(3) + 'th'` shipped on the flagship Goal page. */
const ORDINALS = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'];
function ordinalWord(n) {
  if (ORDINALS[n]) return ORDINALS[n];
  const rem100 = n % 100;
  const suffix = (rem100 >= 11 && rem100 <= 13) ? 'th'
    : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suffix}`;
}

function swatch(color) {
  return el('span', { class: 'brief-swatch', dataset: { color } });
}

/** The per-turn board-move allowance. game.js getPlayerView ships
 *  `rearrangeBudget` (2395); the core/cards.js mirror covers the home-screen
 *  help, where there is no snapshot to read. */
function rearrangeBudget() {
  const n = store.snapshot?.rearrangeBudget;
  return Number.isInteger(n) && n > 0 ? n : REARRANGE_BUDGET;
}

/* ── page: goal & the ACTIVE win rule ─────────────────────────────────────
 *
 * P8: this page used to describe Final Approach unconditionally. The engine
 * resolves a per-game ruleset (game.js resolveRules) and broadcasts `winRule` +
 * `setsToWin`, so a game of Blitz was being explained to its own players as a
 * game of Chudopoly — §3.9's bar inverted. ui/ruleset.js reads the live values;
 * every branch below names the game.js function that implements it. */

/**
 * Which ruleset this page is describing, stated out loud. Without it the brief
 * silently changes its own content between games and the player has no way to
 * tell whether it is describing THIS table or the default.
 */
function ruleBadge(active) {
  const bits = [WIN_RULE_NAMES[active.winRule], `${active.setsToWin} sets to win`];
  // game.js zoneIsSet(): `cards.some(c => !isRainbowWild(c))` — one card that is not an
  // "any" wild, NOT "one real property". Under mdFaithful two "any" wilds in a 2-card zone
  // is NOT a set; two two-colour wilds IS one, which is what the 2025 card faces say.
  if (active.pureSetRequired) bits.push('rainbow wilds cannot finish a set on their own');
  // game.js respondToAction(): counterSpendsPlay() — the current seat only.
  if (active.counterCostsPlay) bits.push('OPSEC costs a play on your own turn');
  if (active.passGoRestartsTurn) bits.push('PCS Orders restarts your plays');
  // §3.10b rides the badge as well as the Goal row: a guest at a host-enabled
  // table meets the rule here first. game.js normalizeSuddenDeath forces 'off'
  // under 'instant', so the bit can never appear beside Blitz.
  if (active.suddenDeath && active.suddenDeath !== 'off') {
    bits.push(`contested approach: ${SUDDEN_DEATH_COPY[active.suddenDeath]?.label
      || active.suddenDeath}`);
  }
  // The deck knob (§3 amendment): `rules.deck` is the count map game.js
  // buildDeck() was handed. sameDeck/DECK_BASE are ui/ruleset.js's mirror,
  // pinned by test/deckconfig.test.js. MD Faithful ships a non-stock deck
  // (chud 0, wildPairs 9), so its badge carries this bit too — the Cards
  // page's counts follow the same map, so the two surfaces agree.
  if (active.deck && !sameDeck(active.deck, DECK_BASE)) bits.push('edited deck');
  return el('p', { class: 'brief-note' }, [
    el('b', { text: active.live ? 'THIS GAME: ' : 'DEFAULT RULES: ' }),
    el('span', { text: bits.join(' · ') }),
    el('span', {
      text: active.live ? '' : ' — the table you join decides; this page follows it.',
    }),
  ]);
}

/** The set-breaking cards. Shared by every win rule: under 'instant' they are
 *  the only defence there is, under the grace rules they are the counter-play.
 *
 *  FILTERED THROUGH THE DECK THIS GAME IS PLAYED WITH, exactly as pageCards()
 *  is: this list taught "THE CHUD CARD — the only card that can pull ONE card
 *  out of a set" unconditionally, including under the shipped MD Faithful
 *  preset (chud: 0) — two tabs away from the Cards page saying "Not in this
 *  table's deck: THE CHUD CARD". Rent and money are not editable
 *  (validateDeck), so the charge bullet never filters.
 *  @returns {Element[]} the list, plus the Cards-page absence note when a
 *  break card the player may have read about elsewhere is not in this deck. */
function breakBullets(active) {
  const totals = totalsFor(active.deck);
  const have = (action) => (totals.get(`act:${action}`) || 0) > 0;
  const lines = [];
  const absent = [];
  // playAction 'chud' (game.js:1173) is the ONLY steal left with no
  // zoneRequisitionable guard, and nothing goes back the other way. It is NOT
  // the only card that can be pointed at a complete set — Inspector General
  // (game.js:1082) REQUIRES one — so the claim is card-vs-set, not touch-at-all.
  if (have('chud')) {
    lines.push('THE CHUD CARD — takes a property straight out of a complete set and gives '
      + 'nothing back. It is the only card that can pull ONE card out of a set and break it.');
  } else absent.push(CARD_TITLES.chud);
  // playAction 'inspector_general' (game.js:1082) refuses anything that is not
  // already a complete set: "That set is not complete". executeEntry 'steal_set'.
  if (have('inspector_general')) {
    lines.push('Inspector General — seizes the whole set, Upgrade and FOC included. It can '
      + 'ONLY be aimed at a set that is already complete; an unfinished colour refuses it.');
  } else absent.push(CARD_TITLES.inspector_general);
  // processPayment: propCards come out of properties, then syncSets(payer).
  // Upgrades are payable now, so a big enough charge can also strip those.
  lines.push('Charge them more than their bank covers, so they must pay with a set card.');
  // playAction 'tdy_orders' (game.js:1123-1126) now runs zoneRequisitionable()
  // over BOTH sides; playAction 'midnight_requisition' (1101) over the target's.
  const locked = [
    have('tdy_orders') ? 'TDY Orders' : null,
    have('midnight_requisition') ? 'Midnight Requisition' : null,
  ].filter(Boolean);
  if (locked.length === 2) {
    lines.push('TDY Orders and Midnight Requisition cannot — both refuse any zone that is '
      + 'already a complete set. TDY refuses it on YOUR side of the trade too.');
  } else if (locked[0] === 'TDY Orders') {
    lines.push('TDY Orders cannot — it refuses any zone that is already a complete set, '
      + 'on YOUR side of the trade too.');
  } else if (locked[0] === 'Midnight Requisition') {
    lines.push('Midnight Requisition cannot — it refuses any zone that is already a '
      + 'complete set.');
  }
  const out = [bullets(lines)];
  if (absent.length) {
    // Named absent, not silently dropped — the same policy pageCards states:
    // a player who has read about THE CHUD CARD elsewhere deserves to know
    // this table has none rather than to infer it from an absence.
    out.push(note(`Not in this table's deck: ${absent.join(', ')}. `
      + 'The list above follows the deck this game was built with.'));
  }
  return out;
}

/** The armed board, drawn at whatever `setsToWin` this game is played to. */
function armedBoard(n) {
  // Enough distinct colours for any setsToWin the engine offers (3 or 5 today);
  // COLOR_KEYS is the fallback so a larger number still draws something true.
  const palette = ['red', 'darkblue', 'base', 'green', 'intel', 'orange', 'pink'];
  const colors = (palette.length >= n ? palette : COLOR_KEYS).slice(0, n);
  return el('div', { class: 'fa-board' }, [
    el('span', { class: 'fa-board-label', text: 'ARMED BOARD' }),
    el('div', { class: 'fa-cols' }, colors.map((color) =>
      el('div', { class: 'fa-col is-complete', dataset: { color } }, [
        el('span', { class: 'fa-col-name', text: COLORS[color].short }),
        el('span', { class: 'fa-col-pips' },
          Array.from({ length: COLORS[color].size }, () => el('i'))),
        el('span', { class: 'fa-col-tick', text: 'SET' }),
      ]))),
    el('span', { class: 'fa-board-count', text: `${n} / ${n} COMPLETE` }),
  ]);
}

const faStep = (kind, tag, text) => el('li', { class: `fa-step is-${kind}` }, [
  el('span', { class: 'fa-tag', text: tag }),
  el('span', { class: 'fa-text', text }),
]);

/**
 * The armed state, drawn. `setsToWin` complete sets do not win under the two
 * grace rules (game.js syncSets sets player.finalApproach instead of
 * finishing); the win resolves at the armed player's own turn start once
 * checkpointThreshold() turns have passed — activeCount for 'finalApproach',
 * exactly 1 for 'mdFaithful'.
 */
function approachDiagram(rules) {
  const n = rules.setsToWin;
  const md = rules.winRule === 'mdFaithful';
  return el('div', { class: 'fa-diagram' }, [
    armedBoard(n),
    el('ol', { class: 'fa-steps' }, [
      md
        ? faStep('arm', 'ARMED OFF-TURN', `Your ${ordinalWord(n)} set is handed to you during `
          + 'somebody else\'s turn — by a payment, a steal or a swap. That is the ONLY way to '
          + 'be armed here: complete it on your own turn and you have already won.')
        : faStep('arm', 'ARMED', `Your ${ordinalWord(n)} set completes. You do NOT win yet.`),
      // checkpointReached(): turnCounter − armedAtTurn >= checkpointThreshold().
      md
        ? faStep('wait', 'ONE TURN', 'You may not declare on someone else\'s turn — that is '
          + 'the actual Monopoly Deal sentence. The seats between you and your own next turn '
          + 'get to answer.')
        : faStep('wait', 'CYCLE', 'Every other player gets at least one full turn to break '
          + 'you — up to two each if you armed on someone else\'s turn.'),
      faStep('break', 'OR BREAK', 'Lose any set in that window and you are disarmed. '
        + 'Rebuild it and you re-arm — the count restarts at zero.'),
      // beginTurn() → resolveFinalApproach().
      faStep('win', 'CHECKPOINT', md
        ? `The start of your very next own turn. Still holding ${n}? That is the win.`
        : 'The first of your own turns to start after that full cycle. '
          + `Still holding ${n}? That is the win.`),
    ]),
  ]);
}

/** winRule 'instant' (Blitz): syncSets() finishes the game inline, from every
 *  path that can change a set count — so it can land on anyone's turn. */
function instantDiagram(n) {
  return el('div', { class: 'fa-diagram' }, [
    armedBoard(n),
    el('ol', { class: 'fa-steps' }, [
      faStep('arm', 'COMPLETE', `Your ${ordinalWord(n)} set completes — anywhere, `
        + 'on anyone\'s turn.'),
      faStep('win', 'WIN', 'The game ends immediately. No grace window, no banner, '
        + 'no chance to break it.'),
    ]),
  ]);
}

function pageGoal() {
  const active = activeRules();
  const n = active.setsToWin;
  const head = [
    p(`Complete ${n} property sets. ${winRuleSummary(active)}`, 'brief-lede'),
    ruleBadge(active),
  ];

  if (active.winRule === 'instant') {
    return [
      ...head,
      instantDiagram(n),
      rules([
        // syncSets(): the 'instant' branch returns before finalApproach is ever set.
        ['Nothing is ever armed',
          'There is no final approach under this ruleset, so there is no banner, no '
          + 'countdown and no window in which to break anybody.'],
        // syncSets() is called from playProperty, moveProperty, processPayment, both
        // steals and swap.
        ['It can land off your turn',
          'A set completed by a payment you received, a steal or a swap wins the game the '
          + 'instant it completes — it does not wait for your turn.'],
        ['Which means: break sets EARLY',
          'The only defence is not letting anyone reach the last card of a set. Once it '
          + 'lands, it is over.'],
      ]),
      el('h5', { class: 'brief-sub', text: 'How you break a set before it finishes' }),
      ...breakBullets(active),
    ];
  }

  const md = active.winRule === 'mdFaithful';
  return [
    ...head,
    approachDiagram(active),
    rules([
      // syncSets(): under mdFaithful an own-turn completion finishes the game INLINE; the
      // arming branch below it is reached only when it is not your turn.
      ...(md ? [['Your own turn wins on the spot',
        `Complete your ${ordinalWord(n)} set on your own turn and the game ends right there `
        + '— no banner, no window, nothing to break. Only a set that lands during somebody '
        + 'else\'s turn has to wait.']] : []),
      // syncSets(): sets >= setsToWin && !finalApproach → arm + emit final_approach.
      ['Arming is public',
        (md ? `The moment a set completes off-turn and leaves you on ${n}, the whole table `
            : `The moment you hold ${n} complete sets the whole table `)
        + 'is told, and a banner names you until it resolves.'],
      // checkpointThreshold(): activeCount, or 1 under mdFaithful.
      md
        ? ['The grace is one turn',
          'You win at your own next turn start. Everyone between you and it gets exactly '
          + 'one turn to answer — no more.']
        : ['The grace is a full cycle',
          'Not "one turn" — every other player is guaranteed a turn to answer, no matter '
          + 'when in the round you armed.'],
      // resolveFinalApproach() is called from beginTurn() and drawCards().
      ['The win lands on your turn start',
        `If you still hold ${n} complete sets when your own next turn begins after that `
        + (md ? 'turn' : 'cycle') + ', the game ends there.'],
      // The question every armed player asks. turnsSinceArming counts EVERY
      // seat's turn, so an own-turn inside the window is spent, not cashed.
      ...(md ? [] : [['"Why didn\'t I win on my own turn?"',
        'Because the cycle was not finished yet. Arm on somebody else\'s turn and one of '
        + 'your own turns falls inside the grace window — that turn passes without '
        + 'converting, and you win on the NEXT one. The banner never counts your own '
        + 'turns as answers.']]),
      // syncSets(): sets < setsToWin && finalApproach → disarm, delete armedAtTurn.
      ['Breaking resets everything',
        `Drop below ${n} and you are disarmed. Build back up and you re-arm, but the `
        + 'grace window starts over from zero.'],
      // armedPlayers() is a list; first player whose beginTurn passes the check wins.
      ['Several can be armed at once',
        `The first one to reach their own checkpoint still holding ${n} wins.`],
      // §3.10b — game.js syncContest() (774-793) opens a contest the moment TWO
      // seats are armed at once and closes it when the field drops back to one;
      // contestBlocks() (820-840) suspends the checkpoint while it is open, and
      // CONTEST_LAP_CAP = 2 bounds every mode. The sentence is ui/ruleset.js
      // SUDDEN_DEATH_COPY — the same one the lobby picker shows, so the two
      // surfaces cannot drift. Under 'escalate', getPlayerView's contestBar
      // (game.js:2419-2422) is setsToWin + 1 while the contest is live, and the
      // HUD reads that field — the number here says why it moved. The raised
      // bar LAPSES: contestBar() (809-814) drops back to setsToWin once
      // contestLaps >= CONTEST_LAP_CAP (2), and contestBlocks() (824-831) then
      // lets turn order resolve the still-open contest — the old sentence here
      // ("while the contest is live, converting takes N+1") claimed the raise
      // for the whole contest and stated no fallback at all.
      ...(active.suddenDeath && active.suddenDeath !== 'off' ? [[
        `Contested approach — ${SUDDEN_DEATH_COPY[active.suddenDeath]?.label
          || active.suddenDeath}`,
        `On this table, two players armed at once suspend the win. ${
          SUDDEN_DEATH_COPY[active.suddenDeath]?.line || ''}${
          active.suddenDeath === 'escalate'
            ? ` For those two rounds, converting takes ${n + 1} complete sets here, `
            + `not ${n} — the HUD's win count follows it, and drops back to ${n} when `
            + 'the cap lapses.'
            : ''}`,
      ]] : []),
    ]),
    el('h5', { class: 'brief-sub', text: 'How you break someone on final approach' }),
    ...breakBullets(active),
  ];
}

/* ── page: your turn ─────────────────────────────────────────────────────── */

function pageTurn() {
  const active = activeRules();
  const instant = active.winRule === 'instant';
  return [
    // beginTurn() draws automatically; drawCards(): count = hand.length === 0 ? 5 : 2.
    p('Your cards are dealt for you, then up to three plays, then get down to the hand limit.',
      'brief-lede'),
    rules([
      ['1 · The deal is automatic',
        'Two cards land in your hand the moment your turn starts — five if your hand was '
        + 'empty. There is nothing to press.'],
      // playsRemaining = 3; playAsMoney / playProperty / playAction each decrement it.
      ['2 · Up to 3 plays', 'A play is: bank a card for its value, place a property, play an '
        + 'action or rent card, or add an Upgrade / FOC to a complete set.'],
      // moveProperty() never touches playsRemaining — and §3.1b routes
      // moveUpgrade() (game.js:1517-1541) through the same command, so an
      // Upgrade/FOC relocates on the same free terms. Verified with
      // playsRemaining at 0: the move still returns ok. FREE OF PLAYS is not
      // UNLIMITED, which is what this row used to claim: rearrangesLeft()
      // (game.js REARRANGE_BUDGET, 347) allows 12 accepted board moves a turn,
      // swapProperties() draws SWAP_COST = 2 for its two cards (game.js:352),
      // a refused move spends nothing, and beginTurn() refills the allowance.
      // The 13th accepted move returns "No free rearranges left this turn —
      // end your turn to reset them" (game.js:1987-1989).
      ['Free — costs no play', 'Moving a wild that is already on your board from one set to '
        + 'another costs none of your three plays. Neither does moving an Upgrade or FOC from '
        + 'one of your complete sets to another — the target set has to be complete, and an '
        + `FOC needs an Upgrade already standing there. You get ${rearrangeBudget()} such `
        + `board moves a turn (a two-card swap counts as ${SWAP_COST} of them), and the `
        + 'allowance resets when your next turn starts.'],
      // endTurn(): hand.length > HAND_LIMIT → needDiscard with the excess.
      [`3 · Hand limit ${HAND_LIMIT}`, `End your turn holding at most ${HAND_LIMIT} cards. `
        + 'Over the limit, you choose what goes to the discard.'],
      // server/timers.js onTurnTimeout (36-43): the turn is force-ended and the
      // excess over the hand limit auto-discarded, narrated as `turn_timeout`.
      // onResponseTimeout (218-236): the demand is auto-accepted and
      // autoPickPayment (274-315) settles it cheapest-first — bank, then
      // upgrades, then properties, each sorted by ascending value. Quick Play
      // runs with the turn clock off, so the row is worded conditionally.
      ['Clocks, where the table runs them',
        'Run out the turn clock and your turn ends itself — anything over the hand limit is '
        + 'discarded for you. Run out the answer clock on a demand and it is accepted for '
        + 'you, paid with your cheapest cards first.'],
    ]),
    note('Money cards are only ever banked — there is nothing else to do with them.'),
    bullets([
      // §3.1c — endTurn() deletes the COUNTER, so a x4 stack expires whole.
      'Surge Operations expires when your turn ends, spent or not — and it only ever doubles '
      + 'RENT. Two copies make one rent x4.',
      // respondToAction runs whenever pendingAction lists you, regardless of turn.
      'You can be charged and you can play OPSEC on anyone\'s turn. Demands are answered '
      + 'the moment they land.',
      // syncSets() is reached from playProperty, moveProperty, processPayment,
      // both steals and swap — so an off-turn completion counts either way. What
      // it DOES there depends on the ruleset: 'instant' finishes the game inline;
      // the grace rules arm instead.
      instant
        ? 'A set you complete on someone else\'s turn — from a payment, a steal, a swap — wins '
          + 'the game on the spot under this ruleset. Nothing is ever armed.'
        : 'A set you complete on someone else\'s turn — from a payment, a steal, a swap — arms '
          + 'your final approach right then.',
    ]),
  ];
}

/* ── page: sets & rent ───────────────────────────────────────────────────── */

/** COLORS in game.js is the source; core/cards.js mirrors it (see its header). */
function setsTable() {
  const head = el('tr', {}, [
    el('th', { text: 'Set' }),
    el('th', { class: 'num', text: 'Cards' }),
    el('th', { text: 'Rent per card held' }),
  ]);
  const rows = COLOR_KEYS.slice()
    .sort((a, b) => COLORS[a].size - COLORS[b].size
      || COLORS[a].rent[COLORS[a].rent.length - 1] - COLORS[b].rent[COLORS[b].rent.length - 1])
    .map((color) => {
      const info = COLORS[color];
      const ladder = el('td', { class: 'ladder' }, info.rent.map((amount, i) =>
        el('span', { class: `rung${i === info.rent.length - 1 ? ' is-full' : ''}` }, [
          el('i', { text: `${i + 1}` }),
          el('b', { text: `${amount}M` }),
        ])));
      return el('tr', {}, [
        el('td', { class: 'setname' }, [swatch(color), el('span', { text: info.name })]),
        el('td', { class: 'num', text: String(info.size) }),
        ladder,
      ]);
    });
  return el('div', { class: 'brief-scroll' }, [
    el('table', { class: 'brief-table' }, [el('thead', {}, head), el('tbody', {}, rows)]),
  ]);
}

function pageSets() {
  const active = activeRules();
  return [
    // calcRent(): rent = info.rent[min(count, len) - 1] — count, not completeness.
    p('Rent is charged on a colour, not on a finished set. One card of a colour already '
      + 'charges the first rung.', 'brief-lede'),
    setsTable(),
    rules([
      ['Rent scales with what you hold',
        'Two Fighters charge 3M. You never need the complete set to charge rent.'],
      // zoneFull() in playProperty / moveProperty.
      ['A zone holds its set size and no more',
        'You cannot stack a fourth Fighter as armour. Extra copies stay in your hand or go '
        + 'on a wild\'s other colour.'],
      // receiveProperty(): no zone can be forced past its size any more. It
      // tries the preferred colour, then the fullest legal one, then
      // shiftWildToMakeRoom() — the rearrange you could have made yourself —
      // and only then banks the card and emits `banked_property`.
      ['A property with nowhere to go becomes money',
        'A payment or steal that has no legal zone left first slides one of your own wilds '
        + 'aside to make room. If even that fails, the card is banked at face value instead. '
        + 'No zone is ever pushed past its size.'],
      // playAction 'upgrade'/'foc' require isSetComplete; foc requires 'house'.
      ['Upgrade +3M, FOC +4M',
        'Complete sets only, one of each per set, and FOC needs the Upgrade in place first.'],
      // §3.1b, three rules reversed at once. payableCards() (game.js:710-717)
      // includes upgrades; playerNetWorth() === playerTotalValue() (706-708);
      // bankUpgradeCard() (783) BANKS them on a break, stripping upgradeType so
      // what lands is an ordinary card; moveUpgrade() (1517-1541) relocates one
      // between complete sets for no play.
      ['Upgrades ARE money',
        'An Upgrade is worth 3M and an FOC 4M, and you may hand either over as payment like '
        + 'any other card — net worth and paying power are the same number. If the set under '
        + 'them breaks they are not lost: they drop into your own bank at face value.'],
      ['And they move',
        'On your turn you may shift an Upgrade or FOC from one of your complete sets to '
        + 'another for free — it costs no play. The destination must already be a complete '
        + 'set, an FOC needs an Upgrade waiting there, and an Upgrade cannot leave its own '
        + 'FOC stranded behind it.'],
      // The same invariant, the other way round. moveUpgrade() REFUSES to strand an
      // FOC; normalizeUpgrades() (game.js:806-830) does not refuse a payment, it
      // banks the FOC behind the Upgrade you spent. Stating only the refusal read
      // as a promise that the FOC is safe.
      ['An FOC never stands alone',
        'That rule has a second half: nothing REFUSES a payment made with the Upgrade under '
        + 'an FOC. The Upgrade goes to whoever charged you and the FOC drops into your own '
        + 'bank behind it, so the set keeps standing at 7M less rent.'],
      // executeEntry 'steal_set' (game.js:1743) routes a seized set's upgrades
      // through mergeUpgrades() (1142-1153): a set carries at most one Upgrade
      // and one FOC, and a duplicate kind arriving with the seizure is BANKED to
      // the thief via bankUpgradeCard() — not discarded, not stacked. The rule
      // existed nowhere on this screen (§3.9).
      ['A seized set brings its Upgrades — duplicates become money',
        'Inspector General hands you the set\'s Upgrade and FOC with it. If that would give '
        + 'you two of a kind on one colour, the duplicate is banked to you at face value — '
        + 'a set never carries more than one of each.'],
      ['Wilds', 'A two-colour wild counts as either of its colours. The "any" wild counts as '
        + 'every colour but is worth 0M — that is what you pay for it.'],
      // zoneRequisitionable() (game.js:968-971) is COMPLETENESS-based, not
      // fullness-based, on purpose: under pureSetRequired a full zone of nothing
      // but wilds is not a SET, so the two set-guarded steals may still take from
      // it. Stated only when the toggle is on — on other tables a full zone of
      // wilds IS a complete set and the claim would be false.
      ...(active.pureSetRequired ? [['A full zone of RAINBOW wilds is not safe here',
        'On this table a colour filled with nothing but "any" wilds is NOT a complete set, '
        + 'so Midnight Requisition and TDY Orders can still take from it. Two-colour wilds '
        + 'are fine on their own — it is only the rainbows that cannot finish a set.']] : []),
      // receiveProperty(): `ordered` puts preferredColor first — every caller
      // passes card.placedColor, the colour it was on before — then the
      // remaining legal colours sorted by DESCENDING zoneCount, and takes the
      // first zone that is not full.
      ['Cards you RECEIVE place themselves',
        'A property handed to you by a payment, a steal or a swap is placed by the engine, '
        + 'not by you. It prefers the colour it was already on, and only then the colour you '
        + 'have most of — so an arriving wild can land somewhere that does NOT finish your '
        + 'set. Move it afterwards: rearranging a wild on your own board is free and costs '
        + 'no play.'],
    ]),
  ];
}

/* ── page: money & paying ────────────────────────────────────────────────── */

function pagePaying() {
  return [
    // payableCards() (game.js:710-717) = bank + properties + UPGRADES. Hand is
    // never touched. §3.1b added the third source, and a client that offered
    // only the first two could not surrender everything, which is the only
    // legal short payment — it wedged.
    p('You choose what to hand over — out of your bank, your properties and the Upgrades '
      + 'standing on your sets. Never out of your hand.', 'brief-lede'),
    rules([
      // playAsMoney() refuses property and wild_property; everything else banks.
      ['Anything but a property banks',
        'Action cards, rent cards and money cards can all be banked for their face value. '
        + 'That is one of your three plays.'],
      // processPayment() (game.js:1449): a short payment is only legal when
      // `selected.length === payable.length` — every card, upgrades included.
      ['Cover it, or hand over everything',
        'Pay at least what is owed, or surrender every card you own — zero-value wilds and '
        + 'the Upgrades on your sets included. There is no middle.'],
      // payable.length === 0 → emit 'insolvent', nothing changes hands.
      ['You never owe more than you have',
        'With an empty bank and no properties you pay nothing at all, and no debt is carried.'],
      ['No change is given',
        'Overpaying is legal and the surplus is gone. Pick your cards with that in mind.'],
      // propCards path in processPayment → bankUpgrades(payer, color) →
      // syncSets(payer) → can disarm. The upgrades are BANKED, not discarded.
      ['Paying with a property can break your set',
        'Any Upgrade or FOC standing on that set then falls into your bank at face value — '
        + 'you keep the money, you lose the rent. And the break can end a final approach, '
        + 'yours or theirs.'],
      // normalizeUpgrades() (game.js:806-830), reached from processPayment()'s
      // upgradeCards path. An FOC may not stand without an Upgrade beneath it, and
      // that rule fires on a PAYMENT as well as on a break. Measured: complete
      // Command + Upgrade + FOC charges 15M; pay 3M with the Upgrade and it charges
      // 8M with the set still complete — the FOC is in your own bank.
      ['Pay with an Upgrade and its FOC comes off too',
        'An FOC cannot stand on a set with no Upgrade under it. Hand the Upgrade over and the '
        + 'engine banks the FOC behind it at face value — the set stays complete, but you have '
        + 'given up 7M of rent to settle a 3M bill. Pay with something else if the set is '
        + 'earning.'],
      // upgradeCards path in processPayment (game.js:1467-1479): upgradeType and
      // placedColor are stripped, so it arrives as an ordinary card.
      ['An Upgrade you pay with stops being an Upgrade',
        'It lands in their bank as a plain 3M or 4M card, not on one of their sets.'],
    ]),
    note('Tap your bank, property and Upgrade cards to select them; the bar keeps the running '
      + 'total and turns green when it covers the demand.'),
  ];
}

/* ── page: the cards ─────────────────────────────────────────────────────── */

const CARD_ORDER = [
  'chud', 'inspector_general', 'midnight_requisition', 'tdy_orders',
  'finance_office', 'roll_call', 'surge_ops', 'pcs_orders',
  'upgrade', 'foc', 'opsec',
];

const CARD_TITLES = {
  chud: 'THE CHUD CARD', inspector_general: 'Inspector General',
  midnight_requisition: 'Midnight Requisition', tdy_orders: 'TDY Orders',
  finance_office: 'Finance Office', roll_call: 'Roll Call',
  surge_ops: 'Surge Operations', pcs_orders: 'PCS Orders',
  upgrade: 'Upgrade (House)', foc: 'Full Operational Capability',
  opsec: 'OPSEC',
};

// buildDeck() values, verified card by card.
const CARD_VALUES = {
  chud: 4, inspector_general: 5, midnight_requisition: 3, tdy_orders: 3,
  finance_office: 3, roll_call: 2, surge_ops: 1, pcs_orders: 1,
  upgrade: 3, foc: 4, opsec: 4,
};

function cardEntry({ title, value, count, qty, rule, flag, kind }) {
  return el('div', { class: `brief-card${kind ? ` is-${kind}` : ''}` }, [
    el('div', { class: 'brief-card-head' }, [
      el('span', { class: 'brief-card-name', text: title }),
      el('span', { class: 'brief-card-coin', text: `${value}M` }),
      el('span', { class: 'brief-card-qty', text: qty || `×${count}` }),
    ]),
    el('p', { class: 'brief-card-rule', text: rule }),
    el('span', { class: `brief-card-flag is-${flag.kind}`, text: flag.text }),
  ]);
}

function pageCards() {
  const active = activeRules();
  // The deck THIS game is played with, not the build's constant (§3 deck knob).
  // ui/deckcensus.js totalsFor() resolves `rules.deck` the way game.js
  // buildDeck() does — pinned against it by test/deck-census.test.js and
  // test/deckconfig.test.js. The frozen ACTION_COUNTS this page used to print
  // is the STOCK deck: under the shipped MD Faithful preset (chud: 0) it read
  // "THE CHUD CARD ×2" for a card that is not in the game. Rent and money are
  // not editable (validateDeck refuses them), so RENT_COUNTS stays a constant.
  const totals = totalsFor(active.deck);
  const out = [
    p('Face value is what the card is worth in the bank — the strongest cards are also the '
      + 'best money you will never want to spend.', 'brief-lede'),
    el('h5', { class: 'brief-sub', text: 'Rent cards' }),
  ];

  // buildDeck() rent block: five colour pairs ×2, plus ['any'] ×3 at value 3.
  const pairs = [['brown', 'lightblue'], ['pink', 'orange'], ['red', 'yellow'],
    ['green', 'darkblue'], ['base', 'intel']];
  out.push(cardEntry({
    title: 'Rent: a colour pair',
    value: 1,
    // buildDeck() makes RENT_COUNTS.pair of EACH of the five pairs. "×10" read
    // as "ten of this card" next to a list of per-card counts (§P7.20).
    qty: `×${RENT_COUNTS.pair} each · ${RENT_COUNTS.pair * pairs.length} total`,
    rule: 'Charge rent on one of the two colours printed on it — EVERY other player pays. '
      + 'Five pairs exist: ' + pairs.map(pair => pair.map(colorName).join('/')).join(', ') + '.',
    flag: opsecFlag({ type: 'rent' }),
    kind: 'rent',
  }));
  out.push(cardEntry({
    title: 'Rent: Any Colour',
    value: 3,
    count: RENT_COUNTS.any,
    // playAction rent branch, isWildRent: requires targetId, targets = [that player].
    rule: 'Charge rent on any ONE colour you own, from ONE player you name. It does not hit '
      + 'the table — that is what the higher face value buys.',
    flag: opsecFlag({ type: 'rent' }),
    kind: 'rent',
  }));

  out.push(el('h5', { class: 'brief-sub', text: 'Action cards' }));
  // A kind the deck holds ZERO of is not listed with a ×0 — the same policy
  // ui/deckcensus.js applies to its rows — but it is NAMED below, because a
  // player who has read about THE CHUD CARD elsewhere deserves to know this
  // table has none rather than to infer it from an absence.
  const absent = [];
  for (const action of CARD_ORDER) {
    const count = totals.get(`act:${action}`) || 0;
    if (!count) { absent.push(CARD_TITLES[action]); continue; }
    out.push(cardEntry({
      title: CARD_TITLES[action],
      value: CARD_VALUES[action],
      count,
      rule: ACTION_RULES[action],
      // One source for the OPSEC sentence — cards.js. The boolean this used to
      // take could not express OPSEC itself, which creates no pendingAction and
      // was therefore flagged "OPSEC CANNOT TOUCH IT" one line under its own
      // counter-OPSEC rule text (§P7.15).
      flag: opsecFlag({ type: 'action', action }),
      kind: action === 'chud' ? 'chud' : '',
    }));
  }
  if (absent.length) {
    out.push(note(`Not in this table's deck: ${absent.join(', ')}. `
      + 'The counts above follow the deck this game was built with.'));
  }
  out.push(note('Upgrade, FOC, Surge Operations and PCS Orders aim at nobody, so there is '
    + 'nothing for an OPSEC to answer. OPSEC itself is answered only by another OPSEC.'));
  return out;
}

/* ── page: OPSEC ─────────────────────────────────────────────────────────── */

/** respondToAction(): each OPSEC splices the card out of hand into the discard,
 *  increments entry.depth and flips entry.responderId. Accepting at an ODD depth
 *  means the defender's OPSEC stood (action_blocked); at an EVEN depth the
 *  target suffers it. */
function opsecChain() {
  const beat = (who, kind, text) => el('li', { class: `op-beat is-${kind}` }, [
    el('span', { class: 'op-who', text: who }),
    el('span', { class: 'op-text', text }),
  ]);
  return el('ol', { class: 'op-chain' }, [
    beat('BLAZE', 'attack', 'plays THE CHUD CARD on your F-22.'),
    beat('YOU', 'defend', 'play OPSEC. The card is spent and discarded. Now Blaze must answer.'),
    beat('BLAZE', 'attack', 'counters with a second OPSEC. Also spent. Back to you.'),
    beat('YOU', 'defend', 'have no third OPSEC, so you let it stand.'),
    beat('RESULT', 'result', 'The CHUD goes through and the F-22 changes hands. '
      + 'Both OPSEC cards are gone either way.'),
  ]);
}

function pageOpsec() {
  return [
    p('OPSEC is the only card you play on someone else\'s turn. It cancels an action aimed '
      + 'at you — and it can be countered.', 'brief-lede'),
    opsecChain(),
    rules([
      ['Whoever stops countering loses',
        'The chain ends when one side declines. If that is the attacker, the action is '
        + 'blocked; if it is you, it resolves in full.'],
      ['Every OPSEC played is spent',
        'It goes to the discard the moment you play it, win or lose the exchange.'],
      // startPending() builds one entry per target; each has its own depth chain.
      ['One chain per target',
        'Roll Call and colour rent charge the whole table, and each player answers alone. '
        + 'Your OPSEC protects you and nobody else.'],
      ['It cannot pre-empt',
        'You play it in response to a card already on the table, never ahead of one.'],
      // playAction: discardAndSpend() runs BEFORE startPending(), so the card
      // and the play are gone the instant it is played; chargeAmount() deletes
      // state._surgeOps at that same moment. A block refunds none of it.
      ['A blocked attack still costs the attacker everything',
        'Their card was discarded and one of their three plays was spent the moment they '
        + 'played it. If they had Surge Operations running, the doubling was burned on the '
        + 'charge too, and it does not come back. Blocking does not undo the play — it only '
        + 'stops the effect.'],
    ]),
    note('When an OPSEC is standing against you, the bar asks whether to let it stand or '
      + 'counter. "Let it stand" means your own action is cancelled.'),
  ];
}

/* ── page: endings ───────────────────────────────────────────────────────── */

function pageEndings() {
  const active = activeRules();
  const n = active.setsToWin;
  return [
    p('Three ways a game ends. Only one of them is a race to sets.', 'brief-lede'),
    rules([
      // finishGame(state, id, 'sets', …) — from syncSets() under 'instant',
      // from resolveFinalApproach() under the two grace rules.
      active.winRule === 'instant'
        ? ['Someone completes their last set',
          `A player reaches ${n} complete sets and the game ends on the spot, on whoever's `
          + 'turn it happened to be. The usual ending.']
        : active.winRule === 'mdFaithful'
          ? ['Someone completes their last set on their own turn',
            `A player reaches ${n} complete sets on their own turn and the game ends there. `
            + 'The usual ending; a set that landed off-turn instead converts at that '
            + 'player\'s next own turn start.']
          : ['Final approach converted',
            `An armed player reaches their own turn start still holding ${n} complete `
            + 'sets. The usual ending.'],
      // scoop() → activePlayers.length === 1 → finishGame(…, 'last_standing').
      ['Last one standing',
        'Scooping discards everything you own and takes you out for good. If everyone else '
        + 'scoops, the survivor wins on the spot — no cycle, no checkpoint.'],
      // endInStalemate(): ranked by completedSets, then playerNetWorth, and the
      // sort is stable over `state.players.filter(!eliminated)` — so a dead heat
      // on both numbers is settled by seat order, earliest seat first.
      ['Attrition — decided on points',
        'Most completed sets wins; net worth (bank + properties + upgrades) breaks the tie; '
        + 'and if two players match on both, the earlier seat at the table takes it.'],
    ]),
    el('h5', { class: 'brief-sub', text: 'What triggers attrition' }),
    bullets([
      // endTurn(): _idleTurns >= activeCount when deck and discard are both empty.
      'Deck and discard are both empty and a full round passes with nobody playing a card '
      + 'out of hand.',
      // endTurn(): shuffleCount >= DECK_CYCLE_LIMIT.
      `Or the discard has been reshuffled back into the deck ${DECK_CYCLE_LIMIT} times. `
      + 'The table has had long enough; it goes to points.',
    ]),
    el('h5', { class: 'brief-sub', text: 'What scooping actually does' }),
    bullets([
      // scoop() (game.js:2173-2186) checks ensurePlaying() and the seat, and
      // nothing else — no whose-turn guard, no turnPhase guard, no
      // pendingAction guard. A demand pointed at the scooper is unwound
      // (pa.targets filtered) rather than blocking the scoop.
      'You can scoop at any moment while the game is running — on your own turn or anybody '
      + 'else\'s, even with a demand pointed at you.',
      // scoop(): hand, bank and every property zone are emptied into discardPile,
      // then discardUpgrades() per colour.
      'Every card you own — hand, bank, properties and upgrades — goes to the discard pile, '
      + 'where it is shuffled back into the deck later. It is not removed from the game.',
      // scoop(): pa.targets filtered by playerId; pendingAction nulled when empty
      // or when the scooper was the source.
      'Any demand pointed at you dies with you. If you were the only target, the attacker\'s '
      + 'card is already spent and they get nothing.',
      // scoop(): activePlayers.length === 1 → finishGame(..., 'last_standing').
      'If you were the second-to-last player in, the survivor wins on the spot — no final '
      + 'approach, no checkpoint. Scooping out of a losing position can hand someone the game.',
      'There is no undo, and you cannot come back in.',
    ]),
    // ui/hud.js renders the chip at cycle >= deckCycleNotice() — 8 of 16.
    // "once the deck has been through it a few times" was unfalsifiable (§P7.20).
    note(`The HUD starts showing the deck-cycle count at ${deckCycleNotice()} of `
      + `${DECK_CYCLE_LIMIT}, and turns it gold in the last two, so an attrition finish is `
      + 'never a surprise.'),
  ];
}

/* ── page: controls ──────────────────────────────────────────────────────── */

function pageControls() {
  return [
    p('Cards are objects. Tap one to see its options — or just throw it where you want it.',
      'brief-lede'),
    rules([
      ['Tap a card in hand',
        'It lifts, and a strip appears above your hand: Play, Bank, Details.'],
      ['DRAG it instead',
        'Pick a card up and drop it where it goes — this is the fast way. Legal landing '
        + 'places light up while you drag.'],
      ['Drop on a set column', 'Places a property, or aims a rent card at that colour.'],
      ['Drop on an opponent\'s board', 'Aims a steal, swap or demand at that player.'],
      ['Drop on your bank', 'Banks the card for its face value.'],
      ['Drop in the middle of the table', 'Means "play it" — you then aim on the table.'],
      // Same engine facts as the Turn page's row: moveProperty() costs no play,
      // rearrangesLeft() caps accepted moves at the per-turn budget
      // (game.js REARRANGE_BUDGET, 347), and a swap draws two (SWAP_COST, 352).
      ['Drag a wild that is already on your board',
        `Move it to another set column. Free of plays — up to ${rearrangeBudget()} board `
        + `moves a turn, a swap into a full column counting as ${SWAP_COST}. An Upgrade or `
        + 'FOC moves the same way, between complete sets.'],
      ['Long-press any card', 'Opens its full rules card, wherever it is on the table.'],
      ['Targeting happens on the table',
        'Eligible boards, columns and cards glow. Tap the one you want.'],
      ['Paying', 'Your bank, your properties and the Upgrades on your sets all become '
        + 'selectable. The bar totals what you have picked; confirm when it is enough.'],
      // ui/hud.js routes Escape to #side when no sheet, drag or mode owns the
      // key — §3.9: the drawer close may not exist unstated here.
      ['Escape', 'Cancels a drag, then a selection, and closes any open sheet — or the '
        + 'comms drawer, when nothing else is open over it.'],
      ['Keyboard', 'Tab moves between controls, Enter or Space activates, Escape backs out.'],
    ]),
    note('Reduced-motion is honoured: cards fade instead of flying, and the sound stays.'),
  ];
}

/* ── page: the bots ──────────────────────────────────────────────────────── */

/**
 * WHO YOU ARE PLAYING, answerable AFTER launch.
 *
 * The five personalities existed only in the lobby's add-bot dropdown blurb —
 * host-only, one-mode-at-a-time, and gone the instant the game started. So the
 * single most common in-game question about the opposition ("why does Reaper
 * never block anything?") had no answer on any screen in the game. core/bots.js
 * is the one source; ui/lobby.js prints the seated bot's line on its seat row and
 * ui/overlays.js long-press opens this page's entry for one board.
 */
function pageBots() {
  const seated = (store.room?.players || []).filter(x => x.isBot);
  const out = [
    p('Every bot plays the same rules you do. What changes is how hard it hits, what it '
      + 'bothers to block, and how fast it thinks.', 'brief-lede'),
  ];
  // OWNER DIRECTIVE 2026-08-07: which personality a given seat is playing is NOT
  // disclosed. The five personalities are still documented — knowing what the
  // game can throw at you is fair, and it is what makes a bot's behaviour
  // readable once you have watched it — but which seat is which is something you
  // work out from play, not something the UI hands you before the first turn.
  if (seated.length) {
    out.push(el('h5', { class: 'brief-sub', text: 'Every personality' }));
  }
  out.push(rules(BOT_ORDER.map(mode => [BOT_LABEL[mode], BOT_BLURB[mode]])));
  out.push(note('Which seat is playing which personality is never shown — read the table, not '
    + 'the label. A seat a player leaves mid-game is taken over by a bot the same way.'));
  return out;
}

/** One bot's entry, for the long-press on their board. */
export function botBrief(playerId) {
  const seat = (store.room?.players || []).find(x => x.id === playerId) || null;
  if (!seat?.isBot) return null;
  // The personality stays hidden here too — this used to be the one place you
  // could look it up mid-game, which made every other concealment cosmetic.
  return {
    title: seat.name,
    body: el('div', { class: 'details' }, [
      el('p', { class: 'details-kind', text: 'Bot opponent' }),
      el('p', { class: 'details-rule', text: 'Its personality is not disclosed. Watch what it '
        + 'blocks, what it hoards, and how fast it hits back.' }),
      note('All five personalities are in the brief under Bots.'),
    ]),
  };
}

/* ── the sheet ───────────────────────────────────────────────────────────── */

const PAGES = [
  { id: 'goal', tab: 'Goal', title: 'Goal & final approach', build: pageGoal },
  { id: 'turn', tab: 'Turn', title: 'Your turn', build: pageTurn },
  { id: 'sets', tab: 'Sets', title: 'Sets & rent', build: pageSets },
  { id: 'paying', tab: 'Paying', title: 'Money & paying', build: pagePaying },
  { id: 'cards', tab: 'Cards', title: 'Every action card', build: pageCards },
  { id: 'opsec', tab: 'OPSEC', title: 'OPSEC chains', build: pageOpsec },
  { id: 'endings', tab: 'Endings', title: 'How games end', build: pageEndings },
  { id: 'bots', tab: 'Bots', title: 'Who you are playing', build: pageBots },
  { id: 'controls', tab: 'Controls', title: 'Controls', build: pageControls },
];

let current = 'goal';
let host = null;
let rail = null;

/**
 * Centre a tab in its own rail. NOT scrollIntoView: `.sheet-body` computes to
 * `overflow-x: auto` (it declares overflow-y), so scrollIntoView walked up and
 * scrolled the whole sheet sideways — measured on the 390px Controls page, the
 * heading and every bullet marker were clipped off the left edge.
 */
function reveal(tab) {
  if (!rail || !tab) return;
  const want = tab.offsetLeft - (rail.clientWidth - tab.offsetWidth) / 2;
  const max = rail.scrollWidth - rail.clientWidth;
  rail.scrollTo({ left: Math.max(0, Math.min(max, want)), behavior: 'smooth' });
}

function paint() {
  if (!host) return;
  const page = PAGES.find(x => x.id === current) || PAGES[0];
  clear(host);
  host.appendChild(el('h4', { class: 'brief-title', text: page.title }));
  for (const node of page.build()) host.appendChild(node);
  host.scrollTop = 0;
  for (const tab of rail ? rail.children : []) {
    const on = tab.dataset.page === page.id;
    setClass(tab, 'is-on', on);
    setAttr(tab, 'aria-selected', on ? 'true' : 'false');
    setAttr(tab, 'tabindex', on ? '0' : '-1');
  }
}

export function show(pageId) {
  if (pageId && PAGES.some(x => x.id === pageId)) current = pageId;
  rail = el('div', { class: 'brief-tabs', attrs: { role: 'tablist', 'aria-label': 'Rules sections' } },
    PAGES.map(page => el('button', {
      class: 'brief-tab',
      text: page.tab,
      attrs: { role: 'tab', type: 'button' },
      dataset: { action: 'help-page', page: page.id },
    })));
  host = el('div', { class: 'brief-page scroll-edge', attrs: { role: 'tabpanel', tabindex: '0' } });

  // Left/Right walk the rail, as a tablist must (§0.9).
  rail.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = PAGES.findIndex(x => x.id === current);
    const next = PAGES[(i + (e.key === 'ArrowRight' ? 1 : PAGES.length - 1)) % PAGES.length];
    current = next.id;
    paint();
    const on = rail.querySelector('.brief-tab.is-on');
    reveal(on);
    on?.focus({ preventScroll: true });
  });

  openSheet('Mission brief', el('div', { class: 'brief' }, [rail, host]));
  paint();
  reveal(rail.querySelector('.brief-tab.is-on'));
}

export function mount() {
  pointer.registerActions({
    'help-page': (elx) => {
      current = elx.dataset.page || current;
      paint();
      reveal(elx);
    },
  });
}
