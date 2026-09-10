// ui/overlays.js — the win screen, and the wiring for the rules brief,
// settings and first-game hints.
//
// The win screen has one job beyond ceremony: say WHY the game ended. Three
// endings reach it (game.js finishGame) and two of them are not "someone got
// three sets", so a screen that only ever printed a name was lying by omission.

import { $, el, clear, setText, setHidden } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import * as send from '../net/send.js';
import { store, seatName } from '../state/store.js';
import { COLORS, COLOR_KEYS, isComplete } from '../core/cards.js';
import * as sel from '../state/selectors.js';
import { activeRules } from './ruleset.js';
import * as pointer from '../interact/pointer.js';
import * as screens from './screens.js';
import { closeSheet, sheetOpen } from './screens.js';
import * as help from './help.js';
import * as settings from './settings.js';
import * as hints from './hints.js';
// main.js is architect-owned (§1) and already delegates the ui/ sub-mounts to
// this file (help, settings, hints). The P8 surfaces join them here.
import * as discard from './discard.js';
import * as journal from './journal.js';
// The rank ladder's pure half. The overlay derives the movement itself from
// the banked row plus the store's counter — awardFor/bandFor/rankFor are the
// same functions the tests hold, so the screen cannot drift from the math.
import { stats, awardFor, bandFor, rankFor } from '../state/stats.js';

/**
 * finishGame() stamps state.endReason with 'sets' | 'last_standing' | 'walkover' |
 * 'stalemate'. The stalemate sub-reason ('deck_dry' | 'deck_cycles') rides on
 * the emitted event, not on the view, so read it off the event tail — falling
 * back to the deck-cycle counter, which getPlayerView does carry.
 */
function stalemateCause(snap) {
  for (let i = (snap.events || []).length - 1; i >= 0; i--) {
    const ev = snap.events[i];
    if (ev.t === 'stalemate') return ev.reason || 'deck_dry';
  }
  const limit = snap.deckCycleLimit || 0;
  return limit && (snap.deckCycle || 0) >= limit ? 'deck_cycles' : 'deck_dry';
}

/**
 * WHICH of the three tiebreaks actually decided it. endInStalemate() computes
 * this against the runner-up and publishes it as `stalemateBasis` (and on the
 * `stalemate` event as `basis`) — before that the screen said "most sets wins"
 * even when the game had been settled on net worth or on seat order, which is
 * the kind of quiet lie §3.9 exists to stop.
 */
function stalemateBasis(snap) {
  if (snap.stalemateBasis) return snap.stalemateBasis;
  for (let i = (snap.events || []).length - 1; i >= 0; i--) {
    if (snap.events[i].t === 'stalemate') return snap.events[i].basis || null;
  }
  return null;
}

function basisSentence(basis, player) {
  const sets = player?.completedSets ?? 0;
  switch (basis) {
    case 'sets':
      return `Most completed sets took it — ${player?.name || 'the winner'} finished on ${sets}.`;
    case 'net_worth':
      return `${player?.name || 'The winner'} tied on ${sets} set${sets === 1 ? '' : 's'} and `
        + `won on net worth, ${player?.netWorth ?? 0}M.`;
    case 'turn_order':
      return 'The table tied on completed sets AND on net worth, so the earliest seat took it '
        + '— the third and last tiebreak.';
    case 'unopposed':
      return `${player?.name || 'The winner'} was the only player left standing when the `
        + 'cards ran out.';
    default:
      return `Most completed sets wins — ${player?.name || 'the winner'} took it with ${sets}, `
        + `net worth ${player?.netWorth ?? 0}M breaking any tie, and seat order after that.`;
  }
}

function endingCopy(snap) {
  const winner = snap.winner;
  const player = (snap.players || []).find(p => p.id === winner) || null;
  const mine = winner && winner === store.self.id;

  if (!winner) {
    return { title: 'NO WINNER', tag: 'DRAW', reason: 'Nobody was left holding anything.' };
  }
  if (snap.endReason === 'last_standing') {
    return {
      title: mine ? 'LAST ONE STANDING' : `${seatName(winner)} SURVIVES`,
      tag: 'LAST STANDING',
      // scoop(): activePlayers.length === 1 → finishGame(..., 'last_standing').
      reason: 'Everyone else scooped out. The last player at the table wins immediately — '
        + 'no final approach, no checkpoint.',
    };
  }
  if (snap.endReason === 'walkover') {
    return {
      title: mine ? 'WON BY WALKOVER' : `${seatName(winner)} WINS BY WALKOVER`,
      tag: 'WALKOVER',
      // absent.js handleAbsent(): connected.length === 1 while active.length > 1.
      reason: 'Everyone else left the table. The last player connected takes it — '
        + 'not a win on sets, and the game log records it as one.',
    };
  }
  if (snap.endReason === 'stalemate') {
    const cause = stalemateCause(snap);
    return {
      title: mine ? 'DECIDED ON POINTS' : `${seatName(winner)} WINS ON POINTS`,
      tag: 'ATTRITION',
      // endInStalemate(): ranked by completedSets, then playerNetWorth, then
      // seat order — and it now says WHICH of the three decided it.
      reason: (cause === 'deck_cycles'
        // endTurn(): shuffleCount >= DECK_CYCLE_LIMIT.
        ? `The discard was reshuffled into the deck ${snap.deckCycleLimit || 16} times with `
          + 'nobody closing it out, so the game went to points. '
        // endTurn(): _idleTurns >= activeCount with deck and discard both empty.
        : 'Deck and discard both ran dry and a full round passed with nobody playing a card '
          + 'out of hand, so the game went to points. ')
        + basisSentence(stalemateBasis(snap), player),
      points: true,
      basis: stalemateBasis(snap),
    };
  }
  // 'sets' — syncSets() under 'instant', resolveFinalApproach() at the armed
  // player's own turn start under the two grace rules. P8: the screen used to
  // claim "FINAL APPROACH HELD" for every set win, including Blitz games where
  // nothing was ever armed.
  const active = activeRules();
  if (active.winRule === 'instant') {
    return {
      title: mine ? 'MISSION ACCOMPLISHED' : `${seatName(winner)} WINS`,
      tag: 'SETS COMPLETE',
      reason: `Completed ${active.setsToWin} sets. Under this ruleset that ends the game `
        + 'the moment it happens — there was no window to break it.',
    };
  }
  // MD Faithful is NOT Final Approach with a different name. Since 2026-08-08 it wins
  // INLINE on an own-turn completion (game.js syncSets) and only arms off-turn, where
  // checkpointThreshold() returns 1 — your very next own turn, not a full lap. So the two
  // endings read differently and the banner has to tell them apart: `armed` is the
  // engine's own flag for the seat, and it is only ever set by the off-turn path.
  if (active.winRule === 'mdFaithful') {
    // finishGame() does not clear the flag, so a seat that converted FROM an armed state is
    // still in armedIds on the final snapshot; a seat that won inline never entered it.
    const armed = (snap.armedIds || []).includes(winner);
    return {
      title: mine ? 'MISSION ACCOMPLISHED' : `${seatName(winner)} WINS`,
      tag: armed ? 'DECLARED ON THEIR OWN TURN' : 'SETS COMPLETE',
      reason: armed
        ? `Was handed the ${active.setsToWin}th set on somebody else's turn, waited for `
          + 'their own — the one thing Monopoly Deal makes you wait for — and the table '
          + 'did not break it.'
        : `Completed ${active.setsToWin} sets on their own turn. Monopoly Deal ends there `
          + 'and then: the wait only applies to a set that lands off-turn.',
    };
  }
  return {
    title: mine ? 'MISSION ACCOMPLISHED' : `${seatName(winner)} WINS`,
    tag: 'FINAL APPROACH HELD',
    reason: `Held ${active.setsToWin} complete sets through the whole grace window and `
      + 'converted at their own turn start. Nobody broke the approach.',
  };
}

/**
 * A player's complete colours, straight off the board in the snapshot.
 *
 * These swatches are printed on the same row as the engine's own
 * `completedSets` count, so they have to be counted the engine's way.
 * `length >= size` is only zoneIsSet() with pureSetRequired OFF: under MD
 * Faithful a full zone of nothing but RAINBOW wilds is NOT a set, and the row
 * would have shown three swatches beside the number 2.
 */
function completeColorsOf(player) {
  const rules = sel.activeRuleFlags();
  return COLOR_KEYS.filter(color => isComplete(player, color, rules));
}

function boardRow(player, { points, winner }) {
  const complete = completeColorsOf(player);
  const held = COLOR_KEYS.reduce((n, c) => n + (player.properties?.[c]?.length || 0), 0);
  const row = el('div', {
    class: `win-row${player.id === winner ? ' is-winner' : ''}`
      + `${player.eliminated ? ' is-out' : ''}`,
  }, [
    el('span', { class: 'win-name', text: player.name }),
    el('span', { class: `win-sets${points ? ' is-decider' : ''}`,
      text: `${player.completedSets} set${player.completedSets === 1 ? '' : 's'}` }),
    el('span', { class: 'win-marks' }, complete.map(color =>
      el('span', { class: 'brief-swatch', dataset: { color },
        attrs: { title: COLORS[color].name } }))),
    el('span', { class: `win-worth${points ? ' is-decider' : ''}`,
      text: `${player.netWorth}M` }),
  ]);
  row.appendChild(el('span', {
    class: 'win-detail',
    text: player.eliminated
      ? 'scooped'
      : `${held} propert${held === 1 ? 'y' : 'ies'} · bank ${player.bankValue}M`
        + (player.upgradeValue ? ` · upgrades ${player.upgradeValue}M` : ''),
  }));
  return row;
}

/* ── when the scrim is allowed to arrive (§P7.1) ───────────────────────────
 *
 * MEASURED before this existed: state applied → #win-overlay visible at +1ms,
 * but the `win` FX cue and the fanfare fired at +388ms. The overlay — z-index
 * 95 over rgba(2,5,10,.9) — therefore opened 387ms BEFORE its own celebration
 * and covered the table for all of it. The choreographer already calls
 * flight.finishAll() on `win` precisely so "the overlay must not open over
 * moving cards"; the overlay was simply not listening.
 *
 * So: build the content on STATE_APPLIED, unhide on the CHOREOGRAPHER's word.
 *   • CELEBRATION_MS — fx/index.js CUE.WIN adds 0.60 trauma to #table, and
 *     fx/shake.js DECAY is 1.5 trauma/s, so the shake runs 400ms. The gold
 *     flash is 0.8s. The audio agent retimed the fanfare to RESOLVE at 270ms
 *     (P7) precisely so the resolution lands on a visible table, with its held
 *     fifth and confetti crackle running to 1.18s as deliberate tail. 850ms
 *     covers the shake, the flash and the resolution, and leaves the tail —
 *     plus the confetti (3.2s life at z-index 97, above the scrim) — ringing
 *     under the overlay, which is where they read best.
 *   • A snapped state (reconnect, fixture injection) had no celebration to
 *     wait for — show it at once, or a reconnect into a finished game stares
 *     at a dead table.
 *   • FALLBACK_MS is the promise that the screen can never be lost: if no cue
 *     ever arrives the overlay opens anyway.
 */
const CELEBRATION_MS = 850;
const FALLBACK_MS = 2600;

/* ── the rank movement (owner override on DESIGN.md: meta progression between
 * rounds) ──────────────────────────────────────────────────────────────────
 *
 * One block under #win-reason, on win AND defeat: the sortie points this game
 * paid, the table's difficulty band NAME (only the name — the band is
 * deliberately non-invertible so the hidden bot roster cannot be read back out
 * of the award; see state/stats.js's ladder header), and the distance to the
 * next tier with a progress bar. It is built inside renderWin, so it rides the
 * EXISTING armReveal/reveal hold — no timer of its own, per the measured
 * 387ms-early-overlay bug that hold exists to keep fixed.
 *
 * `bankedRank` is derived on GAME_BANKED, which journal.js emits at most once
 * per game (the recorder's latch), synchronously BEFORE this file's
 * STATE_APPLIED handler runs for the same broadcast (registration order:
 * journal.mount() precedes the bus.on below). Rematch re-broadcasts re-render
 * the overlay without a new bank; the block persists off this cache and is
 * cleared the moment a live table is on screen again. */
let bankedRank = null;

function rememberBank(row) {
  const points = awardFor(row);
  const after = stats.ensure().totals.sortiePoints;
  // recordGame added exactly `points` to the counter this frame, so "before"
  // is arithmetic, not a second source of truth.
  bankedRank = {
    points,
    band: bandFor(row).name,
    from: rankFor(after - points),
    to: rankFor(after),
  };
}

function rankBlock() {
  const r = bankedRank;
  const promoted = !!r.to.tier && r.from.tier?.key !== r.to.tier.key;
  const goal = promoted ? `${r.to.tier.name} REACHED`
    : r.to.next ? `${r.to.remaining} TO ${r.to.next.name}`
      : 'TOP TIER';
  const pct = Math.round(r.to.progress * 100);
  const line = el('div', { class: 'win-rank-line' }, [
    el('span', { class: 'win-rank-points mono', text: `+${r.points} SP` }),
    el('span', { class: 'win-rank-band', text: r.band }),
    el('span', { class: 'win-rank-goal mono', text: goal }),
  ]);
  const bar = el('div', { class: 'win-rank-bar', attrs: { 'aria-hidden': 'true' } }, [
    el('i', { class: 'win-rank-fill', style: { width: `${pct}%` } }),
  ]);
  const label = `${r.points} sortie points earned, ${r.band.toLowerCase()} table. `
    + (promoted ? `${r.to.tier.name} reached.`
      : r.to.next ? `${r.to.remaining} more to ${r.to.next.name}.` : 'Top tier.');
  return el('div', { class: 'win-rank', attrs: { role: 'img', 'aria-label': label } }, [line, bar]);
}

/** The block sits between #win-reason and the summary, outside the scroller —
 *  the movement is the point of the screen, so it may not scroll away. The
 *  anchor is created once and repainted per render, because renderWin runs on
 *  every re-broadcast of a finished game. */
function paintRank() {
  let host = $('win-rank');
  if (!host) {
    const reason = $('win-reason');
    if (!reason) return;
    host = el('div', { attrs: { id: 'win-rank' } });
    reason.after(host);
  }
  clear(host);
  setHidden(host, !bankedRank);
  if (bankedRank) host.appendChild(rankBlock());
}

let pending = false;
let showTimer = 0;

function clearPending() {
  pending = false;
  clearTimeout(showTimer);
  showTimer = 0;
  window.removeEventListener('pointerdown', skipHold, true);
}

function reveal() {
  const overlay = $('win-overlay');
  clearPending();
  if (overlay) setHidden(overlay, false);
}

/** The player is allowed to be impatient: a tap during the hold opens it now. */
function skipHold() { if (pending) reveal(); }

function armReveal(delay) {
  if (!pending) return;
  clearTimeout(showTimer);
  showTimer = setTimeout(reveal, delay);
}

function renderWin(payload) {
  const overlay = $('win-overlay');
  const snap = store.snapshot;
  if (!overlay) return;
  if (!snap || snap.phase !== 'finished') {
    // A live table is on screen: whatever was banked belongs to the last game.
    bankedRank = null;
    clearPending();
    setHidden(overlay, true);
    return;
  }

  const copy = endingCopy(snap);
  setText($('win-title'), copy.title);
  setText($('win-reason'), copy.reason);
  paintRank();

  const summary = $('win-summary');
  clear(summary);
  summary.appendChild(el('div', { class: 'win-tag', text: copy.tag }));
  summary.appendChild(el('div', { class: 'win-head' }, [
    el('span', { text: 'FINAL BOARDS' }),
    el('span', { class: 'win-head-cols', text: 'SETS · NET' }),
  ]));

  const ranked = [...snap.players].sort((a, b) =>
    (a.id === snap.winner ? -1 : b.id === snap.winner ? 1 : 0)
    || (b.completedSets - a.completedSets)
    || (b.netWorth - a.netWorth));
  for (const player of ranked) {
    summary.appendChild(boardRow(player, { points: !!copy.points, winner: snap.winner }));
  }

  // §P8 recap: "how did that actually go?" — the turning points, and, if this
  // player was ever armed, what happened to that approach. Built from the
  // accumulated event journal, not from the 40-line prose tail.
  const recap = journal.recap();
  if (recap) summary.appendChild(recap);

  const stats = snap.stats;
  if (stats) {
    summary.appendChild(el('div', {
      class: 'win-stats',
      text: `${stats.turns} turns · ${stats.payments.count} payments · `
        + `biggest ${stats.payments.biggest}M · deck cycled ${snap.deckCycle || 0}×`,
    }));
  }
  $('btn-rematch').disabled = store.room.hostId !== store.self.id;

  if (!overlay.hidden) return;                 // already up: only the copy changed
  // Nothing to wait for unless a `win`/`stalemate` beat is actually queued to
  // play: a snapped state (reconnect, fixture injection, catch-up drain) has no
  // celebration coming, and holding the screen back for one would be a hang.
  const celebrating = (payload?.events || []).some(ev => ev?.t === 'win' || ev?.t === 'stalemate');
  if (!celebrating) { reveal(); return; }
  if (pending) return;
  pending = true;
  window.addEventListener('pointerdown', skipHold, true);
  armReveal(FALLBACK_MS);
}

export function mount() {
  help.mount();
  settings.mount();
  hints.mount();
  discard.mount();
  journal.mount();

  pointer.registerActions({
    help: () => help.show(),
    rematch: () => send.rematch(),
    // One handler for the HUD's ✕ and the win screen's "Leave room" — they
    // always shared it, and it always failed the same way. The farewell frame
    // is written before the socket closes (screens.endSession → socket.flush),
    // so the server really does free the seat: a finished game loses the seat,
    // a game in progress hands it to a bot.
    'leave-room': () => screens.endSession({
      farewell: () => send.leaveRoom(),
      message: 'You left the room',
    }),
  });
  // Emitted by journal.js at most once per game, before renderWin sees the
  // same broadcast (see the win-rank note above).
  bus.on(EVENTS.GAME_BANKED, ({ row }) => { if (row) rememberBank(row); });
  bus.on(EVENTS.STATE_APPLIED, renderWin);

  // The choreographer's word, not the store's (§P7.1). `win`/`stalemate` are the
  // last events it plays, and it calls flight.finishAll() on both, so by the
  // time this fires the table is settled and the celebration has started.
  bus.on(EVENTS.CHOREO_EVENT, (ev) => {
    if (!pending) return;
    if (ev?.t === 'win' || ev?.t === 'stalemate') armReveal(CELEBRATION_MS);
  });
  // Belt and braces: a catch-up drain can swallow the event (choreographer
  // skips cinematics when it is behind) and still reaches idle.
  bus.on(EVENTS.CHOREO_IDLE, () => armReveal(CELEBRATION_MS));

  // `/#help` is a deep link into the brief. hashchange matters as much as load:
  // navigating from `/?harness=1` to `/?harness=1#help` changes only the hash,
  // so the document is never re-created and boot() never runs again — which is
  // why tools/screenshot.mjs's `help` shot was capturing the home screen.
  // Symmetric: the hash leaving must close what its arrival opened, or a
  // same-document navigation away from #help strands the sheet open.
  const syncFromHash = () => { if (location.hash === '#help') help.show(); else if (sheetOpen()) closeSheet(); };
  window.addEventListener('hashchange', syncFromHash);
  if (location.hash === '#help') queueMicrotask(() => syncFromHash());

  /* ── long-press an opponent board → who is that? ────────────────────────
   *
   * The bot personalities were reachable only from the lobby's add-bot <select>,
   * so after launch nothing on any screen said what a WILDCARD does. table/
   * layout.js now prints the label in the board head and stamps `data-bot`; this
   * is the long form.
   *
   * `contextmenu` IS the long-press on touch and the right-click on desktop, and
   * using it costs no new control: interact/lib audit measures every `button` and
   * `[data-action]` against the 44px floor, and a tag in a 12px board head cannot
   * meet it. The default menu is suppressed only when there is actually a bot
   * brief to show, so a long-press on a human board still behaves normally.
   */
  document.addEventListener('contextmenu', (e) => {
    const board = e.target?.closest?.('.board[data-player]');
    if (!board) return;
    const brief = help.botBrief(board.dataset.player);
    if (!brief) return;
    e.preventDefault();
    screens.openSheet(brief.title, brief.body);
  });
}
