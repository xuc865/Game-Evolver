// ui/stats.js — THE FLIGHT LOG. Owner: ui/.
//
// The surface over state/stats.js. That module stores FACTS ONLY and says so at
// length; every ratio, every best, every "vs bots" split on this screen is
// derived here, on open, from `stats.data`. Nothing is cached between opens and
// nothing is written back.
//
// ── THREE RULES THE DATA LAYER REQUIRES OF ITS SURFACE ────────────────────
//
// 1. "SINCE {since}", NEVER "LIFETIME". This is a browser-local logbook. It is
//    per-profile, it is editable from devtools in ten seconds, and it goes with
//    site data. Calling it a lifetime record would be a claim the storage cannot
//    back, so the whole surface is framed as a LOGBOOK — a thing a pilot keeps,
//    which is true precisely because nobody else keeps it for them. Every
//    population state below carries the date and the count, and the one place
//    the word "record" appears it means "the thing you are reading", not "the
//    authoritative history".
//
// 2. A ROW WITH `gaps > 0` IS AN UNDERCOUNT. The connection dropped and the
//    server only ships the last 120 events (EVENT_TAIL), so whole stretches of
//    that game never reached this client. `recordGame` already refuses to let
//    such a row move a personal best. This file does the other half: it COUNTS
//    them and says so out loud on band 3, because every texture number below is
//    then a floor rather than a total. A short number nobody flags is the bug;
//    a short number that names itself is the feature.
//
// 3. `botModes` IS NEVER DISPLAYED. It is recorded so the split exists the day
//    the owner's hiding rule changes. Rendering it here would launder a
//    deliberately hidden attribute through a different screen, so this file does
//    not read the field at all — not in a tooltip, not in an aria-label, not as
//    a count of "how many CHUD bots you have beaten".
//
// ── WHICH WINDOW EACH BAND READS, AND WHY THEY DIFFER ─────────────────────
//
// `totals` accumulates forever; `recent` is a 100-row ring. They are
// independent by design (a row rolling off changes no total), and only `recent`
// carries the composition a "vs bots / vs people" split needs. So:
//
//   band 1 + 2   `totals`. Exact for the life of the logbook, and segmentable,
//                because `humanGames`/`humanWins` were stored for exactly this.
//                The one exception is LONGEST FLIGHT, which no total records —
//                it is a max over the ring, and the footer says so.
//   band 3       `totals` at All (exact, never rolls off) and the RING for a
//                segment (composition lives nowhere else). When the ring is no
//                longer the whole record, a line under the toggle names the
//                window rather than letting the numbers quietly shrink.
//
// ── WHY THE ENTRY POINT DISAPPEARS ────────────────────────────────────────
//
// At zero flights the mark is not rendered. A control that opens an empty box
// teaches a player not to press it, and this one would be pressed exactly once.
// It comes back the moment there is something to read — `stats.onChange` fires
// when a game is banked, which is the same frame the recorder writes.
//
// The one thing that DOES bring it back at zero games is a logbook that has
// something to explain: a blob a newer build wrote, or one that could not be
// parsed. Those players lost a record and are owed a sentence about it.
//
// ── NO COUNT-UP ANIMATION, DELIBERATELY ───────────────────────────────────
//
// A number that animates is claiming it just changed. A payout screen earns
// that; a record being consulted does not, and `tabular-nums` (base.css) means
// nothing reflows at 300 flights anyway, which is the only thing the animation
// would have been hiding.

import { $, el, clear, setHidden, setText } from '../core/dom.js';
import * as pointer from '../interact/pointer.js';
import { openSheet, closeSheet } from './screens.js';
import { stats, RECENT_MAX, rankFor, TIERS } from '../state/stats.js';
import { COLORS } from '../core/cards.js';

/**
 * Flights before band 3 unlocks. EIGHT, and the number is a hook rather than a
 * threshold for its own sake: a Final Approach record over three games is four
 * counters that are mostly zero, and a zero-filled band reads as a broken
 * screen rather than as a young one. Below it the panel says what unlocks and
 * how far away it is, which costs one string and gives a returning player a
 * reason to come back to a screen that is otherwise finished.
 */
export const TEXTURE_MIN = 8;

/** Marks in the form line. Twenty is ~a session and a half, and fits one row
 *  on a 390px phone at .62em per mark without wrapping into a second line. */
export const FORM_MAX = 20;

/** Below this there is no form to read — see `bandStrip`. */
export const FORM_MIN = 5;

/**
 * ALL IS THE DEFAULT AND HAS TO BE. Every recorded game in this project's own
 * logs has exactly one human seat (733 of 735 in logs/games.jsonl), so a
 * human-only default would open on an empty panel and teach the player the
 * feature is broken. The split exists because the ring stores composition; it
 * is not the thing the panel is about.
 */
const SCOPES = [
  { key: 'all', label: 'All' },
  { key: 'bots', label: 'vs bots' },
  { key: 'people', label: 'vs people' },
];

/** `humans` counts human seats INCLUDING you, over the whole game. */
function inScope(row, scope) {
  if (scope === 'people') return row.humans > 1;
  if (scope === 'bots') return row.humans <= 1;
  return true;
}

/**
 * Every `stats.status` value gets a sentence, because `no-storage` and
 * `future-version` are both things a real player reaches and neither may look
 * like a crash. `ok` and `fresh` are silent — there is nothing to explain about
 * a logbook that is working.
 */
const STATUS_NOTE = {
  corrupt: 'The logbook saved in this browser could not be read. It has been set aside rather '
    + 'than deleted, and this record starts again from today.',
  'future-version': 'A newer version of CHUDOPOLY wrote the logbook in this browser. It is being '
    + 'left completely alone — nothing from this session is being recorded, and nothing here can '
    + 'overwrite it. Reload once you are back on the newer build and your record returns.',
  'no-storage': 'This browser is not saving anything for CHUDOPOLY — private browsing, or storage '
    + 'is blocked. The flights below are this session only and go when the tab does.',
  'write-failed': 'The logbook stopped saving partway through this session — storage is full, or '
    + 'the browser withdrew it. What is below is right; it will not survive a reload.',
  'serialize-failed': 'The logbook could not be written to storage. What is below is right for '
    + 'this session only.',
};

/** Statuses worth a mark on the rail even with nothing recorded: each one means
 *  the player HAD a record, or cannot make one, and is owed the sentence. */
const SPEAKS_AT_ZERO = new Set(['corrupt', 'future-version']);

/* ══ derivation ═══════════════════════════════════════════════════════════ */

/**
 * Fold a set of rows into the same shape `totals` has. PURE.
 *
 * Gapped rows contribute to flights, wins and the streak — those two facts
 * survive any hole, because the final snapshot carries them regardless of what
 * the event tail missed — and to the texture counters as a FLOOR. They are
 * excluded from every personal best, which is the same rule `recordGame` and
 * `repair` apply to the stored ones.
 *
 * @param {import('../state/stats.js').StatsRow[]} rows oldest first
 */
export function foldRows(rows) {
  const o = {
    flights: rows.length, wins: 0, bestStreak: 0,
    armed: 0, converted: 0, shotDown: 0, shootdowns: 0,
    stolen: 0, lost: 0, setsStolen: 0, setsLost: 0, setsCompleted: 0,
    opsecDepthBest: 0, insolvent: 0,
    biggestCharge: 0, fastestWinTurns: 0, longestTurns: 0,
    setColors: {}, gapped: 0,
  };
  let run = 0;
  for (const r of rows) {
    if (r.won) {
      o.wins++;
      run = Math.max(0, run) + 1;
      if (run > o.bestStreak) o.bestStreak = run;
    } else {
      run = Math.min(0, run) - 1;
    }
    o.armed += r.armed;
    // The same test recordGame uses: a win off an arming, under the rule that
    // has an approach at all. `instant` games cannot convert anything.
    if (r.won && r.armed > 0 && r.winRule === 'finalApproach') o.converted++;
    o.shotDown += r.broken;
    o.shootdowns += r.shootdowns;
    o.stolen += r.stolen;
    o.lost += r.lost;
    o.setsStolen += r.setsStolen;
    o.setsLost += r.setsLost;
    o.insolvent += r.insolvent;
    if (r.turns > o.longestTurns) o.longestTurns = r.turns;
    for (const k of Object.keys(r.colors)) {
      o.setColors[k] = (o.setColors[k] || 0) + r.colors[k];
      o.setsCompleted += r.colors[k];
    }
    if (r.gaps > 0) { o.gapped++; continue; }
    if (r.biggest > o.biggestCharge) o.biggestCharge = r.biggest;
    if (r.opsecDepth > o.opsecDepthBest) o.opsecDepthBest = r.opsecDepth;
    if (r.won && r.turns > 0 && (o.fastestWinTurns === 0 || r.turns < o.fastestWinTurns)) {
      o.fastestWinTurns = r.turns;
    }
  }
  return o;
}

/** The set you have completed most often, or null. `colorTally` in the store
 *  has already dropped any colour this build cannot name, so `COLORS[key]`
 *  is guaranteed and no swatch can be asked to paint an unknown hue. */
function favouriteSet(tally) {
  let best = null;
  for (const key of Object.keys(tally)) {
    const n = tally[key];
    if (n > 0 && (!best || n > best.count)) best = { key, count: n };
  }
  return best;
}

/**
 * Everything the panel renders, for one scope. PURE — exported so a test can
 * hold it against a real recorded blob without a DOM.
 *
 * @param {import('../state/stats.js').StatsData} data
 * @param {'all'|'bots'|'people'} scope
 */
export function derive(data, scope) {
  const T = data.totals;
  const rows = data.recent.filter((r) => inScope(r, scope));
  const ring = foldRows(rows);
  const all = scope === 'all';

  // Band 1 + 2. Exact for the life of the logbook in all three scopes, because
  // `humanGames`/`humanWins` were stored so the split survives the ring.
  const flights = all ? T.games : (scope === 'people' ? T.humanGames : T.games - T.humanGames);
  const wins = all ? T.wins : (scope === 'people' ? T.humanWins : T.wins - T.humanWins);

  // Band 3. `totals` at All; the ring for a segment, because composition is
  // recorded per row and nowhere else.
  const t = all
    ? {
      armed: T.armed, converted: T.converted, shotDown: T.shotDown, shootdowns: T.shootdowns,
      stolen: T.propertiesStolen, lost: T.propertiesLost,
      setsStolen: T.setsStolen, setsLost: T.setsLost, setsCompleted: T.setsCompleted,
      opsecDepthBest: T.opsecDepthBest, insolvent: T.timesInsolvent,
      biggestCharge: T.biggestCharge, fastestWinTurns: T.fastestWinTurns,
      setColors: T.setColors,
    }
    : ring;

  return {
    scope,
    since: data.since,
    /* THE LADDER READS AT `all` ONLY. Sortie points are one counter accrued
     * across every composition, so a rank printed under a filter would be a
     * whole-logbook figure wearing a segment's clothes — the exact thing
     * bestStreak already refuses. Under a filter there simply is no rank.
     * `rankFor` returns tier names and thresholds and nothing else, so the
     * hidden-roster rule (see the header) holds by construction. */
    rank: all ? rankFor(T.sortiePoints) : null,
    flights,
    wins,
    losses: Math.max(0, flights - wins),
    rate: flights > 0 ? Math.round((wins / flights) * 100) : null,
    // A streak is a property of the WHOLE sequence of flights; carving the bot
    // games out of it and calling what is left a run would be arithmetic, not a
    // fact about anything that happened. So it is the logbook's best in every
    // scope, and the label says "all flights".
    bestStreak: T.bestWinStreak,
    // No total records this. Ring only, in every scope, and the footer says so.
    longestTurns: ring.longestTurns,
    fa: {
      armed: t.armed, converted: t.converted, shotDown: t.shotDown, shootdowns: t.shootdowns,
    },
    stolen: t.stolen,
    lost: t.lost,
    setsStolen: t.setsStolen,
    setsLost: t.setsLost,
    setsCompleted: t.setsCompleted,
    opsecDepthBest: t.opsecDepthBest,
    insolvent: t.insolvent,
    biggestCharge: t.biggestCharge,
    fastestWinTurns: t.fastestWinTurns,
    favourite: favouriteSet(t.setColors),
    // Provenance, so the surface can say which window it is quoting rather than
    // hoping the reader assumes the right one.
    detailed: rows.length,
    recorded: T.games,
    rolled: T.games > data.recent.length,
    gapped: ring.gapped,
    form: rows.slice(-FORM_MAX).map((r) => ({ won: r.won, gapped: r.gaps > 0, code: r.code })),
  };
}

/* ══ the entry point on the home rail ═════════════════════════════════════ */

/**
 * Should the mark be on the rail at all? Zero flights and a healthy logbook →
 * no. See the header: a mark that opens an empty box is pressed once.
 */
export function entryVisible() {
  const data = stats.ensure();
  if (data.totals.games > 0) return true;
  return SPEAKS_AT_ZERO.has(stats.status);
}

function paintEntry() {
  const mark = $('btn-flight-log');
  if (!mark) return;
  setHidden(mark, !entryVisible());
  // The tier rides the mark ("Flight log · BRONZE") — the home-screen surface
  // of the ladder, on the existing control, no new chrome. Below Bronze the
  // label is unchanged: the rail does not advertise a rank nobody has.
  const rank = rankFor(stats.ensure().totals.sortiePoints);
  setText(mark, rank.tier ? `Flight log · ${rank.tier.name}` : 'Flight log');
}

/* ══ building the panel ═══════════════════════════════════════════════════ */

let scope = 'all';
let unsubscribe = null;
let confirmingClear = false;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** A figure cell: the number in mono tabular, the label stencilled under it. */
function cell(value, label, title) {
  return el('div', { class: 'fl-cell', attrs: title ? { title } : null }, [
    el('span', { class: 'fl-cell-num mono', text: String(value) }),
    el('span', { class: 'fl-cell-label', text: label }),
  ]);
}

/** A label/value row. `value` may be a node so the swatch can ride in one. */
function row(label, value, title) {
  return el('div', { class: 'fl-row', attrs: title ? { title } : null }, [
    el('span', { class: 'fl-row-label', text: label }),
    typeof value === 'string'
      ? el('span', { class: 'fl-row-value mono', text: value })
      : value,
  ]);
}

/**
 * BAND 0 — the tier, and the road to the next one.
 *
 * Bronze / Silver / Gold as a stencilled name and three pips, in the apron's
 * own vocabulary: square marks, two ink weights, no colour, no badge, no
 * ribbon, no foil (ART §1 keeps foil for the victory modal; 32 C.F.R. §507.9
 * keeps drawn insignia out of the whole project — a plain word and three
 * squares imitate nobody's device). The progress bar is the meta progression
 * the ladder exists for: the line under it always names the distance, which
 * is the near-miss framing ("82 TO SILVER") DESIGN.md §2.8 recommends.
 */
function bandTier(d) {
  const filled = d.rank.tier ? TIERS.indexOf(d.rank.tier) + 1 : 0;
  const band = el('section', { class: 'fl-band fl-band-tier' });
  band.appendChild(el('div', { class: 'fl-tier' }, [
    el('span', {
      class: `fl-tier-name${d.rank.tier ? '' : ' is-untiered'}`,
      text: d.rank.tier ? d.rank.tier.name : 'NO TIER YET',
    }),
    el('span', { class: 'fl-pips', attrs: { 'aria-hidden': 'true' } },
      TIERS.map((_, i) => el('i', { class: `fl-pip${i < filled ? ' is-filled' : ''}` }))),
  ]));
  band.appendChild(el('div', { class: 'fl-tierbar', attrs: { 'aria-hidden': 'true' } }, [
    el('i', { class: 'fl-tierbar-fill', style: { width: `${Math.round(d.rank.progress * 100)}%` } }),
  ]));
  band.appendChild(el('p', {
    class: 'fl-tier-line',
    text: d.rank.next
      ? `${plural(d.rank.sp, 'sortie point', 'sortie points')} · ${d.rank.remaining} TO ${d.rank.next.name}`
      : `${plural(d.rank.sp, 'sortie point', 'sortie points')} · TOP TIER`,
  }));
  return band;
}

/**
 * BAND 1 — one number, with the denominator immediately adjacent.
 *
 * A 62% rendered at display size over three flights is a lie told in a large
 * typeface, and the only thing that stops it being one is the count sitting
 * against it. So the two are one block and the denominator is never optional:
 * there is no code path here that prints the percentage alone.
 */
function bandRate(d) {
  return el('section', { class: 'fl-band fl-band-rate' }, [
    el('p', { class: 'fl-rate mono', text: `${d.rate}%` }),
    el('p', {
      class: 'fl-rate-den',
      text: `Won ${d.wins} of ${plural(d.flights, 'flight', 'flights')}`,
    }),
  ]);
}

/**
 * BAND 2 — the record strip. Wraps on a phone; it is NEVER a horizontal
 * scroller. A stat strip you have to swipe is one nobody reads, and the reason
 * it can wrap without reflowing is that every figure is `tabular-nums` already.
 */
function bandStrip(d) {
  const strip = el('div', { class: 'fl-strip' }, [
    cell(d.flights, 'flights'),
    cell(d.wins, 'won'),
    cell(d.losses, 'lost'),
  ]);
  // BEST RUN IS NOT SEGMENTABLE, so it is not shown segmented. A streak is a
  // property of the whole sequence of flights; carving the bot games out of it
  // and calling what is left a run would be arithmetic about nothing that
  // happened. Rather than print a whole-logbook figure under a filter and
  // explain it in a `title` nobody on a touchscreen can reach, the cell simply
  // is not there when a filter is on.
  if (d.scope === 'all') strip.appendChild(cell(d.bestStreak, 'best run'));
  if (d.longestTurns > 0) {
    strip.appendChild(cell(d.longestTurns, 'longest',
      `Turns in the longest flight among the ${d.detailed} kept in detail. `
      + 'No running total records this one.'));
  }
  const band = el('section', { class: 'fl-band fl-band-strip' }, [strip]);
  // The form line belongs to the RECORD, not to the texture. It answers "how am
  // I doing lately", which is the question the strip above it answers over the
  // whole logbook — and putting it here keeps it above the fold at 300 flights,
  // where it was the one thing on the panel that had changed.
  //
  // FIVE, not two. Below five there is no "form" to read: three marks restate
  // the three figures directly above them and add only their order, and "Last
  // 3" printed under a strip that says 3 · 1 · 2 reads as padding.
  if (d.form.length >= FORM_MIN) band.appendChild(formLine(d));
  return band;
}

/**
 * BAND 3 — the texture, and the reason the panel is worth opening twice.
 *
 * The FINAL APPROACH record leads it because it is this game's signature
 * mechanic (§3.10) and the only statistic in the set with a rivalry in it. The
 * two-sided lines below it follow the same idea: one-sided is a score, two
 * sided is a grudge, and the schema stores both halves of every one of them.
 */
function bandTexture(d) {
  const band = el('section', { class: 'fl-band fl-band-texture' });

  band.appendChild(el('h4', { class: 'fl-head', text: 'Final approach' }));
  band.appendChild(el('div', { class: 'fl-strip fl-strip-fa' }, [
    cell(d.fa.armed, 'armed', 'Times you reached FINAL APPROACH.'),
    cell(d.fa.converted, 'converted', 'Approaches of yours that became the win.'),
    cell(d.fa.shotDown, 'shot down', 'Approaches of yours that were broken.'),
    cell(d.fa.shootdowns, 'shootdowns', "Approaches of somebody else's that you broke."),
  ]));
  // The one line of copy on this screen, and it is the point of the band.
  band.appendChild(el('p', {
    class: 'fl-rivalry',
    text: d.fa.shotDown === 0 && d.fa.shootdowns === 0
      ? 'Nobody has broken an approach of yours, and you have not broken one of theirs.'
      : `You have been shot down ${plural(d.fa.shotDown, 'time', 'times')}. `
        + `You have shot down ${d.fa.shootdowns}.`,
  }));

  const rows = el('div', { class: 'fl-rows' });
  rows.appendChild(row('Properties taken · lost', `${d.stolen} · ${d.lost}`,
    'Midnight Requisition, CHUD and Inspector General, both directions. A TDY Orders '
    + 'swap is a trade and counts as neither.'));
  rows.appendChild(row('Sets taken · lost', `${d.setsStolen} · ${d.setsLost}`));
  rows.appendChild(row('Sets completed', String(d.setsCompleted)));
  if (d.biggestCharge > 0) {
    rows.appendChild(row('Biggest single charge', `${d.biggestCharge}M`,
      'A personal best. Only a flight recorded with no gaps can set one.'));
  }
  if (d.fastestWinTurns > 0) {
    rows.appendChild(row('Fastest win', plural(d.fastestWinTurns, 'turn', 'turns'),
      'A personal best. Only a flight recorded with no gaps can set one.'));
  }
  if (d.opsecDepthBest > 0) {
    rows.appendChild(row('Deepest OPSEC chain', `${d.opsecDepthBest} deep`,
      'An ordinary block is 1. Anything above it is a counter-war.'));
  }
  rows.appendChild(row('Went insolvent', plural(d.insolvent, 'time', 'times')));
  const favSet = d.favourite && COLORS[d.favourite.key];
  if (favSet) {
    // THE ONE LEGITIMATE SET COLOUR ON THIS SCREEN (ART §1). Hue is set
    // identity, and a stats panel is the classic place a designer reaches for
    // ten of them; this is a card-colour swatch naming a card colour, which is
    // the only thing the reserved channel is allowed to say.
    rows.appendChild(row('Favourite set', el('span', { class: 'fl-row-value fl-fav' }, [
      el('i', { class: 'fl-swatch', attrs: { 'aria-hidden': 'true' },
        style: { '--band': `var(--set-${d.favourite.key})` } }),
      el('span', { text: `${favSet.name} ×${d.favourite.count}` }),
    ])));
  }
  band.appendChild(rows);

  // Rule 2, said out loud. Every counter above is a floor when this is nonzero.
  if (d.gapped > 0) {
    band.appendChild(el('p', {
      class: 'fl-caveat',
      text: `${plural(d.gapped, 'flight', 'flights')} lost events to a dropped connection, so `
        + 'the counts above are a floor rather than a total. Neither can set a personal best.',
    }));
  }
  return band;
}

/**
 * The last twenty, oldest left. Filled = won, hollow = lost, dashed = a flight
 * whose record has a hole in it. Not a chart and not a sparkline: it is the
 * stencil vocabulary the apron already uses, and it answers "how am I doing
 * lately" without another number.
 *
 * The marks are `aria-hidden` and the strip carries one accessible sentence —
 * twenty announced squares is not a reading experience.
 */
function formLine(d) {
  const won = d.form.filter((f) => f.won).length;
  const strip = el('div', {
    class: 'fl-form',
    attrs: {
      role: 'img',
      'aria-label': `Your last ${d.form.length} flights, oldest first: ${won} won, `
        + `${d.form.length - won} lost.`,
    },
  }, d.form.map((f) => el('i', {
    class: `fl-mark${f.won ? ' is-won' : ''}${f.gapped ? ' is-gapped' : ''}`,
    attrs: {
      'aria-hidden': 'true',
      title: `${f.code ? `${f.code} — ` : ''}${f.won ? 'won' : 'lost'}`
        + `${f.gapped ? ' (record incomplete)' : ''}`,
    },
  })));
  return el('div', { class: 'fl-formline' }, [
    el('span', { class: 'fl-form-label', text: `Last ${d.form.length}` }),
    strip,
  ]);
}

/** Below the threshold: one line naming what unlocks and when. */
function bandLocked(d) {
  const togo = TEXTURE_MIN - d.flights;
  return el('p', {
    class: 'fl-locked',
    text: `The flight record — final approach, thefts, personal bests — opens at `
      + `${TEXTURE_MIN} flights. ${plural(togo, 'flight', 'flights')} to go.`,
  });
}

/**
 * Zero flights. Reachable only when the logbook has something to explain (see
 * `entryVisible`), so this is a sentence and a way out, never a set of bands
 * filled with zeros.
 */
function bandEmpty() {
  const box = el('div', { class: 'fl-empty' }, [
    el('p', {
      class: 'fl-empty-text',
      text: 'Nothing recorded yet. Finish a game and it lands here — win rate, your final '
        + 'approach record, who has shot you down and who you have shot down.',
    }),
  ]);
  const go = el('button', {
    class: 'btn btn-primary', text: 'Quick play vs bots', attrs: { type: 'button' },
  });
  go.addEventListener('click', () => {
    closeSheet();
    $('btn-quick-play')?.click();
  });
  box.appendChild(go);
  return box;
}

/**
 * The footer. It carries the two things rule 1 is about — the date and the
 * count — and the one piece of provenance the bands cannot carry themselves:
 * which window each was read from, once they stop being the same window.
 */
function footer(d) {
  // Nothing recorded: there is no "since" to state, and inventing one ("since
  // this browser started keeping one") is a sentence about no data.
  const bits = [];
  if (d.recorded > 0) bits.push(d.since ? `Since ${d.since}` : 'Since your first flight');
  if (d.recorded > 0) bits.push(plural(d.recorded, 'flight', 'flights') + ' recorded');
  if (d.rolled) bits.push(`the last ${RECENT_MAX} kept beat by beat`);
  const lead = bits.length ? `${bits.join(' · ')}. ` : '';
  return el('p', {
    class: 'fl-foot',
    text: `${lead}Kept in this browser only — clearing site data clears it.`,
  });
}

/** Two taps to erase. `stats.reset()` refuses to touch a blob a NEWER build
 *  wrote (persistence is off there), so this cannot delete a future record. */
function clearControl(d, repaint) {
  if (!confirmingClear) {
    const btn = el('button', {
      class: 'btn btn-ghost fl-clear', text: 'Clear this logbook',
      attrs: { type: 'button' },
    });
    btn.addEventListener('click', () => { confirmingClear = true; repaint(); });
    return btn;
  }
  const yes = el('button', {
    class: 'btn fl-clear-yes', text: `Erase ${plural(d.recorded, 'flight', 'flights')}`,
    attrs: { type: 'button' },
  });
  yes.addEventListener('click', () => {
    stats.reset();
    confirmingClear = false;
    paintEntry();
    repaint();
  });
  const no = el('button', {
    class: 'btn btn-ghost', text: 'Keep it', attrs: { type: 'button' },
  });
  no.addEventListener('click', () => { confirmingClear = false; repaint(); });
  return el('div', { class: 'fl-confirm' }, [
    el('p', { class: 'fl-confirm-text', text: 'This cannot be undone.' }),
    el('div', { class: 'fl-confirm-row' }, [yes, no]),
  ]);
}

/**
 * The scope toggle. lobby.css already draws this exact control for "Sets to
 * win" and the settings sheet's theme row (`.rule-seg` / `.seg` / `.seg-face`
 * / `.rule-input`), so this is the app's existing segmented strip rather than a
 * fourth control shape — and the inputs stay real radios, so arrow keys
 * traverse the group without a line of key handling here (§0.9).
 */
function scopeStrip(repaint) {
  return el('div', {
    class: 'rule-seg fl-seg', attrs: { role: 'radiogroup', 'aria-label': 'Which flights' },
  }, SCOPES.map((s) => {
    const input = el('input', {
      class: 'rule-input',
      attrs: {
        type: 'radio', name: 'chud-flightlog-scope', value: s.key,
        ...(s.key === scope ? { checked: true } : {}),
      },
    });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      scope = s.key;
      repaint();
    });
    return el('label', { class: 'seg seg-wide' }, [
      input, el('span', { class: 'seg-face', text: s.label }),
    ]);
  }));
}

/* ══ show ═════════════════════════════════════════════════════════════════ */

export function show() {
  const root = el('div', { class: 'fl' });
  const note = STATUS_NOTE[stats.status];
  if (note) root.appendChild(el('p', { class: 'fl-note', text: note }));

  const body = el('div', { class: 'fl-body' });
  const repaint = () => {
    clear(body);
    const d = derive(stats.ensure(), scope);

    if (d.flights === 0) {
      // A segment can legitimately be empty while the logbook is not — you have
      // simply never played that way. That is a different sentence from "you
      // have never played", and it must not offer to start a game.
      body.appendChild(d.recorded === 0 ? bandEmpty() : el('p', {
        class: 'fl-locked',
        text: scope === 'people'
          ? 'No flights with another person in the seat yet. Create a room and send the link.'
          : 'No flights against bots only. Quick play deals one.',
      }));
    } else {
      if (d.rank) body.appendChild(bandTier(d));
      body.appendChild(bandRate(d));
      body.appendChild(bandStrip(d));
      if (d.flights >= TEXTURE_MIN) body.appendChild(bandTexture(d));
      else body.appendChild(bandLocked(d));
      // Only when the two windows have actually parted company. Before that the
      // ring IS the whole record and the sentence would be noise.
      if (scope !== 'all' && d.rolled) {
        body.appendChild(el('p', {
          class: 'fl-caveat',
          text: `The record above is read from the ${d.detailed} of your last ${RECENT_MAX} `
            + 'flights that match this filter — only those keep who was in the other seats.',
        }));
      }
    }

    /* THE FOOTER IS PINNED, and that is a §0.9 fix with a design dividend.
     *
     * MEASURED (tools/touchtest.mjs, iPhone, 300 flights): "Clear this logbook"
     * came out 136×44 with 14px of it reachable, and 0px once a filter shortened
     * the panel — a control on screen and not tappable, the same defect the win
     * recap hit and solved the same way (content.css `.win-summary .jr-more`).
     *
     * Pinning the WHOLE footer rather than just the button is what makes it
     * right instead of merely green: rule 1's sentence — the date, the count,
     * and "kept in this browser only" — is the one line on this panel that
     * should never scroll away from the numbers it qualifies. */
    const foot = el('div', { class: 'fl-footer' }, [footer(d)]);
    if (d.recorded > 0) foot.appendChild(clearControl(d, repaint));
    body.appendChild(foot);
  };

  // A filter over nothing is a control that cannot do anything. With no flights
  // recorded the panel is one sentence and a way out, and three segments above
  // it would be the panel pretending to have a shape it does not.
  if (stats.ensure().totals.games > 0) root.appendChild(scopeStrip(repaint));
  root.appendChild(body);
  repaint();

  // Live while the sheet is up. NOT polling — the store emits when a game is
  // banked, and a throwing listener is contained on its side.
  if (unsubscribe) unsubscribe();
  unsubscribe = stats.onChange(() => { paintEntry(); repaint(); });

  openSheet('Flight log', root, {
    onClose: () => {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      confirmingClear = false;
    },
  });
}

export function mount() {
  pointer.registerActions({ 'flight-log': () => show() });
  paintEntry();
  // The mark appears the frame a game is banked — the player who finishes their
  // first game and walks back to the menu finds it there, without a reload.
  stats.onChange(() => paintEntry());
}
