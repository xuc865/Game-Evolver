// state/stats.js — the local logbook's storage layer. Owner: state/.
//
// ONE RULE ABOVE ALL: **this module never throws.** Not on load, not on write,
// not on a blob a newer build wrote, not on a half-flushed string from a tab the
// OS killed mid-`setItem`. A stats panel that throws takes the home screen with
// it, and it does so for exactly the players who cannot debug it — private
// browsing, a full quota, an iframe with third-party cookies blocked.
//
// This replaces the house pattern, which was three bare
// `try { localStorage… } catch {}` sites (ui/ruleset.js:327, ui/lobby.js:70,
// ui/home.js:95 and friends). Those are fine for one scalar. They are not fine
// for a record the player accumulates over months, because none of them
// sanitises, versions, coalesces, or flushes on exit — and **without a
// `pagehide` flush every mobile player loses their last session**, since
// backgrounding Safari never fires `beforeunload`.
//
// The read path is: string → JSON.parse (guarded) → `sanitize()` (total, pure)
// → done. `sanitize` is exported so `tools/statsfuzz.mjs` can hammer it in Node
// with no browser at all.
//
// FUTURE VERSIONS ARE READ-ONLY. A stored `version` greater than ours yields a
// fresh in-memory record and **persistence off for the session**. Silently
// losing one session is strictly better than silently deleting a year. (This is
// the specific bug in the Coup store this design was measured against: it falls
// through to `createEmptyStats()` on an unrecognised version, so a v2 blob read
// by an older client wipes the player's entire history.)
//
// UNKNOWN KEYS ARE DROPPED, NOT MERGED. A blob round-tripped through a newer
// build must not smuggle fields this build would then re-serialise as if it
// understood them — that is how a "forward compatible" store silently corrupts
// the newer build's data.
//
// WRITES ARE COALESCED (400ms) AND FLUSHED ON `pagehide`. `setItem` is
// synchronous; a write per recorded game is fine, but the debounce also means
// the recorder can call `write()` freely while it reconciles a game end that
// arrives on three consecutive broadcasts.
//
// TIME: `Date.now()` appears at exactly one call site (`stamp()`), for the
// `updatedAt`/`since` bookkeeping and the per-row timestamp. It never feeds
// simulation state, so §0.7 determinism is untouched. Gatecrash needs a
// `tools/checkTime.mjs` exemption for the equivalent file; **Chudopoly has no
// such gate**, so nothing has to be registered anywhere — noted here rather than
// left as a surprise for whoever adds one.
//
// SIZE, MEASURED, not estimated (`node tools/statsfuzz.mjs --size`, real rows
// modelled on the median record in logs/games.jsonl):
//
//     10 games   →   4,323 B
//    100 games   →  38,361 B   (ring full)
//   1000 games   →  38,381 B   ← flat forever, because the ring is capped and
//                                `totals` is a fixed block
//   (re-measured 2026-08-07 with `totals.sortiePoints` in the block: +18–20 B)
//
// 37.5 KB = 0.73% of a ~5 MB localStorage budget. The design note that preceded
// this file predicted ~200 B/row and ~20 KB; the real figure is 384 B/row,
// because these keys are spelled out instead of abbreviated. That is a
// deliberate trade taken AFTER measuring: 18 KB is 0.35% of the budget and buys
// nothing, while a blob whose fields are named `sd`/`ss`/`sl` costs every future
// reader — and the panel agent — a decoder ring.

import { COLOR_KEYS } from '../core/cards.js';

export const STATS_KEY = 'chud.stats.v1';
export const STATS_VERSION = 1;

/** Coalescing window for writes, in ms. */
export const WRITE_DEBOUNCE_MS = 400;

/** Rows kept in the ring. Measured: 100 × 384 B = 37.5 KB; see the SIZE note. */
export const RECENT_MAX = 100;

/** After this many consecutive write failures we stop trying (quota / revoked). */
const MAX_WRITE_FAILURES = 3;

/** Every end reason the engine can stamp on a game (game.js finishGame callers). */
export const END_REASONS = Object.freeze(['sets', 'last_standing', 'stalemate']);

/** game.js DEFAULT_WIN_RULE and its one alternative. */
export const WIN_RULES = Object.freeze(['finalApproach', 'instant']);

/** Bot personalities. STORED, NEVER DISPLAYED — owner's standing constraint is
 *  that bot personalities are hidden from players. Recording them costs 20 bytes
 *  a row and is the only way a later balance question can be asked at all; what
 *  a panel is allowed to show is a panel decision, and the answer is "not this".
 *
 *  'random' IS a host-seatable mode (server/handlers.js add_bot validates
 *  against ['random','conservative','neutral','aggressive','chud']) and this
 *  list omitting it was a live bug: the seat silently vanished from the stored
 *  row, leaving botModes.length < bots — and since random is the WEAKEST
 *  personality (winrate/fair-share ratio 0.59, BOT-STRATEGY.md), the missing
 *  entry would otherwise read as stronger opposition than was ever seated.
 *  Auto-filled bots (game start and disconnect takeover) draw only from
 *  conservative/neutral/aggressive, so this only ever bit host-chosen rosters
 *  — which is exactly where a rank farmer would be operating. */
export const BOT_MODES = Object.freeze(['random', 'conservative', 'neutral', 'aggressive', 'chud']);

// --------------------------------------------------------------------- coercion

function num(v, def, min, max) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return n < min ? min : n > max ? max : n;
}

function int(v, def, min, max) {
  return Math.floor(num(v, def, min, max));
}

function bool(v, def) {
  return typeof v === 'boolean' ? v : !!def;
}

/**
 * "Is this a thing with fields I can read?" — asked inside a try because
 * `Array.isArray` ITSELF throws on a revoked Proxy ("Cannot perform 'IsArray' on
 * a proxy that has been revoked"), which the fuzzer found on case 34 of its
 * first run. Every entry point below tests shape through this, never inline.
 */
function objectish(v) {
  try {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  } catch { return false; }
}

/** Same guard, for "is this a list I can iterate?" */
function listish(v) {
  try { return Array.isArray(v); } catch { return false; }
}

function str(v, def, allowed) {
  if (typeof v !== 'string') return def;
  if (v.length > 64) return def;
  return allowed && allowed.indexOf(v) === -1 ? def : v;
}

/** A YYYY-MM-DD date, or `def`. Stored rather than derived so "Since {date}" is
 *  stable across a clock the player changed. */
function isoDay(v, def) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return def;
  return v;
}

/** `{color: count}` over the known palette only. Unknown colours are dropped —
 *  a colour this build cannot name is a colour it cannot render a swatch for. */
function colorTally(raw, cap) {
  const out = {};
  if (!objectish(raw)) return out;
  for (const k of COLOR_KEYS) {
    const n = int(raw[k], 0, 0, cap);
    if (n > 0) out[k] = n;
  }
  return out;
}

function reasonTally(raw, cap) {
  const out = {};
  if (!objectish(raw)) return out;
  for (const k of END_REASONS) {
    const n = int(raw[k], 0, 0, cap);
    if (n > 0) out[k] = n;
  }
  return out;
}

const BIG = Number.MAX_SAFE_INTEGER;

// --------------------------------------------------------------------- defaults

/**
 * A brand-new logbook. Always a fresh object: callers mutate `stats.data`, so a
 * shared literal would let one reset leak into the next.
 *
 * `totals` accumulates for the life of the profile and is INDEPENDENT of
 * `recent` — a row rolling off the ring changes no total. That is the whole
 * reason the two exist separately.
 *
 * There is deliberately NO device id. Coup generates and persists one that is
 * never transmitted anywhere; in a no-account design it identifies nobody to
 * nothing and is pure liability.
 *
 * FACTS ONLY — no ratio is ever stored. A win rate on disk is a number that goes
 * wrong the moment either input is repaired; the panel divides on read.
 */
export function defaultStats() {
  return {
    version: STATS_VERSION,
    /** YYYY-MM-DD the logbook was created. The surface says "Since {date}",
     *  never "Lifetime" — this is a browser-local record and saying so is the
     *  honest framing, not a disclaimer. 0-length until the first write. */
    since: '',
    updatedAt: 0,
    totals: {
      games: 0,
      wins: 0,
      /** Games with at least one OTHER human seat, and wins among them. Bot
       *  games count toward `games` — all 733 of 735 records in logs/games.jsonl
       *  have humanSeats:1, so a logbook that excluded them would be empty. The
       *  ring lets the panel segment far more finely on read; these two exist so
       *  the LIFETIME number is still segmentable after rows roll off. */
      humanGames: 0,
      humanWins: 0,
      /** Table turns across your games (game.js state.turnCounter). */
      turns: 0,

      // The Final Approach record — the signature mechanic, and the only stat
      // in the set with a rivalry in it.
      armed: 0,        // times you reached FINAL APPROACH
      converted: 0,    // times an approach of yours became the win
      shotDown: 0,     // times yours was broken (`final_approach_broken.actor === you`)
      shootdowns: 0,   // times you broke someone else's (`.by === you`)

      setsCompleted: 0,
      propertiesStolen: 0,
      propertiesLost: 0,
      setsStolen: 0,
      setsLost: 0,
      opsecPlayed: 0,
      /** Deepest OPSEC chain you were part of. respondToAction() counts 1 for an
       *  ordinary block; >1 is a counter-war and is the number worth keeping. */
      opsecDepthBest: 0,
      timesInsolvent: 0,

      chargedTotal: 0,   // M collected from other seats (payment.to === you)
      paidTotal: 0,      // M handed over (payment.from === you)
      /** Biggest single charge you collected. A PERSONAL BEST: only rows with
       *  `gaps === 0` may move it (see `recordGame`). */
      biggestCharge: 0,
      /** Turns in your fastest win. 0 = none yet. Personal best, same rule. */
      fastestWinTurns: 0,

      /** SORTIE POINTS — the rank ladder's one stored integer. This is a FACT
       *  accrued at play time from information `totals` does not otherwise
       *  retain: the award depends on `botModes`, which lives only on the
       *  100-row ring, so lifetime SP becomes unrecomputable the moment rows
       *  roll off — the same reason `humanGames`/`humanWins` are stored rather
       *  than derived. Monotonic for free (`totals` only ever increments), so
       *  no decay and no demotion have to be enforced anywhere.
       *  Bounds, repaired: games ≤ sortiePoints ≤ games × SP_GAME_CAP. */
      sortiePoints: 0,
      /** Current run: +n consecutive wins, -n consecutive losses, 0 = fresh. */
      streak: 0,
      bestWinStreak: 0,
      worstLossStreak: 0,

      /** Sets completed by colour, over the profile. The favourite-colour claim
       *  is `max()` over this, computed on read. */
      setColors: {},
      /** How your games ended, by engine reason. */
      endReasons: {},
    },
    /** Newest LAST. Capped at RECENT_MAX; see `rowShape()` for the fields. */
    recent: [],
  };
}

/**
 * @typedef {ReturnType<typeof defaultStats>} StatsData
 * @typedef {ReturnType<typeof defaultRow>} StatsRow
 */

/**
 * One finished game, as stored. 384 bytes serialised, measured over 100 real
 * rows (`node tools/statsfuzz.mjs --size`).
 *
 * COMPOSITION IS ON EVERY ROW (`humans`/`bots`/`botModes`) so the panel can
 * segment ON READ and never on write. Coup's fatal mistake is storing no
 * opponent composition at all: no later build can offer the split, because the
 * information was thrown away at write time and cannot be recovered.
 */
export function defaultRow() {
  return {
    at: 0,            // seconds since epoch (not ms — 3 bytes a row, and the
                      // logbook has no use for sub-second resolution)
    code: '',         // room code, for "which game was that"
    won: false,
    end: 'sets',      // engine endReason
    winRule: 'finalApproach',
    setsToWin: 3,
    seats: 2,
    humans: 1,        // human seats INCLUDING you, over the whole game
    bots: 1,
    botModes: [],     // sorted, stored, never displayed (see BOT_MODES)
    turns: 0,
    sets: 0,          // your completed sets at the end
    armed: 0,
    broken: 0,        // your approaches that were broken
    shootdowns: 0,    // approaches you broke
    stolen: 0,        // properties you took
    lost: 0,          // properties taken from you
    setsStolen: 0,
    setsLost: 0,
    opsec: 0,
    opsecDepth: 0,
    insolvent: 0,
    charged: 0,
    paid: 0,
    biggest: 0,       // biggest single payment you collected
    colors: {},       // sets you completed this game, by colour
    /** Journal gap count at the moment of recording. **A row with `gaps > 0` is
     *  an UNDERCOUNT** — the connection dropped and the server only ships the
     *  last EVENT_TAIL (120) events, so whole stretches never reached this
     *  client. Such a row is excluded from every personal-best claim and the
     *  panel must mark it. Honesty about a hole is the feature; a quietly short
     *  number is the bug. */
    gaps: 0,
  };
}

// --------------------------------------------------------------------- sanitize

/**
 * TOTAL and PURE. Any input — `undefined`, `null`, a string, an array, a Proxy
 * whose getters throw — maps to a structurally valid StatsRow.
 * @param {unknown} raw
 * @returns {StatsRow}
 */
export function sanitizeRow(raw) {
  const r = defaultRow();
  if (!objectish(raw)) return r;
  try {
    r.at = int(raw.at, 0, 0, 4e9);
    // Room codes are 4 uppercase alnum (server genCode); anything else is
    // dropped rather than shown, because this string reaches the DOM.
    const code = str(raw.code, '', null);
    r.code = /^[A-Z0-9]{2,8}$/.test(code) ? code : '';
    r.won = bool(raw.won, false);
    r.end = str(raw.end, 'sets', END_REASONS);
    r.winRule = str(raw.winRule, 'finalApproach', WIN_RULES);
    r.setsToWin = int(raw.setsToWin, 3, 1, 10);
    r.seats = int(raw.seats, 2, 1, 12);
    r.humans = int(raw.humans, 1, 0, 12);
    r.bots = int(raw.bots, 0, 0, 12);
    if (listish(raw.botModes)) {
      r.botModes = raw.botModes
        .map(m => str(m, '', BOT_MODES))
        .filter(Boolean)
        .slice(0, 12)
        .sort();
    }
    r.turns = int(raw.turns, 0, 0, 100000);
    r.sets = int(raw.sets, 0, 0, 10);
    r.armed = int(raw.armed, 0, 0, 1000);
    r.broken = int(raw.broken, 0, 0, 1000);
    r.shootdowns = int(raw.shootdowns, 0, 0, 1000);
    r.stolen = int(raw.stolen, 0, 0, 1000);
    r.lost = int(raw.lost, 0, 0, 1000);
    r.setsStolen = int(raw.setsStolen, 0, 0, 1000);
    r.setsLost = int(raw.setsLost, 0, 0, 1000);
    r.opsec = int(raw.opsec, 0, 0, 1000);
    r.opsecDepth = int(raw.opsecDepth, 0, 0, 1000);
    r.insolvent = int(raw.insolvent, 0, 0, 1000);
    r.charged = int(raw.charged, 0, 0, 1e7);
    r.paid = int(raw.paid, 0, 0, 1e7);
    r.biggest = int(raw.biggest, 0, 0, 1e7);
    r.colors = colorTally(raw.colors, 10);
    r.gaps = int(raw.gaps, 0, 0, 100000);
  } catch {
    return defaultRow();
  }

  // Cross-field repair, row scale: a seat count that disagrees with its parts
  // loses to the parts, because the parts are what the composition split reads.
  if (r.humans + r.bots > 0) r.seats = Math.min(12, r.humans + r.bots);
  if (r.biggest > r.charged) r.charged = r.biggest;
  return r;
}

/**
 * TOTAL and PURE. Any input maps to structurally valid StatsData. Never throws,
 * never returns a shared object, never keeps a key it does not know.
 * @param {unknown} raw
 * @returns {StatsData}
 */
export function sanitize(raw) {
  const d = defaultStats();
  if (!objectish(raw)) return d;

  // A hostile or exotic object (Proxy, getters that throw, a revoked Proxy)
  // must not escape this function as an exception.
  try {
    d.version = int(raw.version, STATS_VERSION, 0, 1e9);
    d.since = isoDay(raw.since, '');
    d.updatedAt = int(raw.updatedAt, 0, 0, BIG);

    const t = raw.totals;
    if (objectish(t)) {
      const T = d.totals;
      T.games = int(t.games, 0, 0, BIG);
      T.wins = int(t.wins, 0, 0, BIG);
      T.humanGames = int(t.humanGames, 0, 0, BIG);
      T.humanWins = int(t.humanWins, 0, 0, BIG);
      T.turns = int(t.turns, 0, 0, BIG);
      T.armed = int(t.armed, 0, 0, BIG);
      T.converted = int(t.converted, 0, 0, BIG);
      T.shotDown = int(t.shotDown, 0, 0, BIG);
      T.shootdowns = int(t.shootdowns, 0, 0, BIG);
      T.setsCompleted = int(t.setsCompleted, 0, 0, BIG);
      T.propertiesStolen = int(t.propertiesStolen, 0, 0, BIG);
      T.propertiesLost = int(t.propertiesLost, 0, 0, BIG);
      T.setsStolen = int(t.setsStolen, 0, 0, BIG);
      T.setsLost = int(t.setsLost, 0, 0, BIG);
      T.opsecPlayed = int(t.opsecPlayed, 0, 0, BIG);
      T.opsecDepthBest = int(t.opsecDepthBest, 0, 0, 1000);
      T.timesInsolvent = int(t.timesInsolvent, 0, 0, BIG);
      T.chargedTotal = int(t.chargedTotal, 0, 0, BIG);
      T.paidTotal = int(t.paidTotal, 0, 0, BIG);
      T.biggestCharge = int(t.biggestCharge, 0, 0, 1e7);
      T.fastestWinTurns = int(t.fastestWinTurns, 0, 0, 100000);
      T.sortiePoints = int(t.sortiePoints, 0, 0, BIG);
      T.streak = int(t.streak, 0, -1e6, 1e6);
      T.bestWinStreak = int(t.bestWinStreak, 0, 0, 1e6);
      T.worstLossStreak = int(t.worstLossStreak, 0, 0, 1e6);
      T.setColors = colorTally(t.setColors, BIG);
      T.endReasons = reasonTally(t.endReasons, BIG);
    }

    if (listish(raw.recent)) {
      // Slice BEFORE sanitising: a hostile 10-million-entry array must cost us
      // 100 sanitize calls, not ten million.
      const src = raw.recent.slice(-RECENT_MAX);
      for (const row of src) d.recent.push(sanitizeRow(row));
    }
  } catch {
    return defaultStats();
  }

  repair(d);
  // The blob is ours now, whatever it claimed to be. A LOWER stored version is
  // read through the same sanitizer — every field it lacks takes its default,
  // which is what forward-compatible reading means here. A HIGHER one never
  // reaches this function; `load()` refuses it (see the header).
  d.version = STATS_VERSION;
  return d;
}

/**
 * CROSS-FIELD REPAIR. Internally inconsistent data is reconciled TOWARD THE
 * EVIDENCE OF PLAY: a row exists because a game was played, so a counter that
 * disagrees with the rows loses. Mutates in place; exported for the fuzzer,
 * which asserts the result is a fixed point.
 * @param {StatsData} d
 */
export function repair(d) {
  const T = d.totals;
  const rows = d.recent;

  // The ring is the evidence. A `games` counter below the number of rows we can
  // see means the counter was clipped, not that the games did not happen.
  if (rows.length > T.games) T.games = rows.length;
  const wonRows = rows.reduce((n, r) => n + (r.won ? 1 : 0), 0);
  if (wonRows > T.wins) T.wins = wonRows;
  if (T.wins > T.games) T.games = T.wins;

  const humanRows = rows.reduce((n, r) => n + (r.humans > 1 ? 1 : 0), 0);
  if (humanRows > T.humanGames) T.humanGames = humanRows;
  if (T.humanGames > T.games) T.humanGames = T.games;
  if (T.humanWins > T.humanGames) T.humanWins = T.humanGames;
  if (T.humanWins > T.wins) T.humanWins = T.wins;

  if (T.converted > T.armed) T.armed = T.converted;
  if (T.converted > T.wins) T.converted = T.wins;
  if (T.shotDown > T.armed) T.armed = T.shotDown;

  // A best that no win can support is a best from a wiped counter.
  if (T.wins === 0) { T.fastestWinTurns = 0; T.converted = 0; }
  if (T.games === 0) {
    T.streak = 0;
    T.bestWinStreak = 0;
    T.worstLossStreak = 0;
  }
  if (T.streak > T.wins) T.streak = T.wins;
  if (-T.streak > T.games - T.wins) T.streak = -(T.games - T.wins);
  if (T.bestWinStreak > T.wins) T.bestWinStreak = T.wins;
  if (T.streak > T.bestWinStreak) T.bestWinStreak = T.streak;
  if (T.worstLossStreak > T.games - T.wins) T.worstLossStreak = T.games - T.wins;
  if (-T.streak > T.worstLossStreak) T.worstLossStreak = -T.streak;

  // Sortie points, reconciled toward the evidence of play. Every banked game
  // earned at least the finish point (this floor is also what puts a LEGACY
  // logbook — recorded before the field existed — partway up the ladder on the
  // day it ships, the §2.8 re-entry moment), and no game can have paid past
  // the per-game cap. Both rules are trivially fixed-point. The cap product
  // cannot overflow into a non-integer: it only ever REPLACES the counter when
  // the counter exceeded it, which bounds games below BIG/SP_GAME_CAP.
  if (T.sortiePoints < T.games) T.sortiePoints = T.games;
  if (T.sortiePoints > T.games * SP_GAME_CAP) T.sortiePoints = T.games * SP_GAME_CAP;

  // Personal bests must be at least as large as anything a CLEAN row proves.
  for (const r of rows) {
    if (r.gaps > 0) continue;
    if (r.biggest > T.biggestCharge) T.biggestCharge = r.biggest;
    if (r.won && r.turns > 0 && (T.fastestWinTurns === 0 || r.turns < T.fastestWinTurns)) {
      T.fastestWinTurns = r.turns;
    }
    if (r.opsecDepth > T.opsecDepthBest) T.opsecDepthBest = r.opsecDepth;
  }
  return d;
}

// ------------------------------------------------------------------ the ladder
//
// BRONZE / SILVER / GOLD over SORTIE POINTS (owner override, 2026-08-07, on
// research-ranks/DESIGN.md: "simplify the ranking system … bronze silver gold,
// give some sort of meta progression between rounds"). The six aircrew codes
// went; the plumbing that survived simplification stayed:
//
//   * +1 SP to finish any game; a WIN pays 3×band + (seats−2) + 3×(other human
//     seats), capped at 15. The band is the MEAN tier of the seated bots,
//     quantized to three levels — mean, not sum, because a sum structurally
//     punishes heads-up tables (replayed over the 105 real games in
//     logs/games.jsonl: sum scored 99/105 ROUTINE; mean scores 2/99/4 and
//     rates "beat aggressive 1v1" HOSTILE, which is correct).
//   * Bot tiers come from measured winrate/fair-share ratios (BOT-STRATEGY.md
//     rounds 7/8): random .59 → 0, chud .63 → 0, conservative 1.07 → 1,
//     neutral 1.26 → 2, aggressive 1.46 → 3. A MISSING OR UNKNOWN mode is
//     tier 0 — unknown opposition earns the least. That defensive default is
//     the anti-farm: `bandFor` divides by the SEAT count, so a roster whose
//     modes were dropped (the pre-fix 'random' bug, or a personality added
//     later) averages DOWN, never up.
//   * THE BAND IS NON-INVERTIBLE, deliberately. Bot personalities are stored
//     and never displayed (see BOT_MODES); a per-game award that varied
//     per-seat would display them by arithmetic. Three lossy levels over the
//     mean mean a 9-SP win could be any of a dozen rosters. Surfaces show the
//     band NAME only — never the breakdown, never a "CHUD bots beaten" tally.
//   * MONOTONIC, no decay, no placement. Decay serves matchmaking accuracy
//     and there is no matchmaking; unexplained demotion is the one thing a
//     playmdeal player actually came to Reddit confused about.
//
// PACING, at the Quick Play bench (4 seats vs the auto-fill roster
// conservative/neutral/aggressive → mean 2.0 → CONTESTED; win = 3×2+2+0 = 8)
// and a realistic 25% win rate → 0.75×1 + 0.25×8 = 2.75 SP/game:
//
//   BRONZE  30 total ( 28 earned + 2 endowed) ≈  10 games — a first session
//   SILVER 200        (198 earned)            ≈  72 games — a committed player
//   GOLD   700        (698 earned)            ≈ 254 games — the long-term goal
//
// (The old six-tier cut put MQ at ~15 games and IP at ~237; Bronze lands a
// shade earlier than MQ did, Gold where IP was. Calibration caveat inherited
// from DESIGN.md: the bench winrate comes from 105 developer games — re-derive
// from logs/games.jsonl when real players exist.)
//
// ENDOWED_SP is added ON READ and never stored: the storage layer keeps facts
// (points actually earned), and the two free points are presentation — which
// is literally what the endowed-progress effect is (Nunes & Drèze 2006, JCR
// 32(4): 10-stamp cards with 2 pre-filled were redeemed at 34% vs 19% for
// 8-stamp cards from scratch).

/** Measured bot strength, quantized. Anything not in this table is 0. */
export const BOT_TIER = Object.freeze({
  random: 0, chud: 0, conservative: 1, neutral: 2, aggressive: 3,
});

/** The three difficulty bands over the mean bot tier. Ordered, ascending. */
export const BANDS = Object.freeze([
  Object.freeze({ key: 'routine', name: 'ROUTINE', mult: 1, maxMean: 0.5 }),
  Object.freeze({ key: 'contested', name: 'CONTESTED', mult: 2, maxMean: 2.0 }),
  Object.freeze({ key: 'hostile', name: 'HOSTILE', mult: 3, maxMean: Infinity }),
]);

/** The ladder. `at` is total SP (earned + endowed). Ordered, ascending. */
export const TIERS = Object.freeze([
  Object.freeze({ key: 'bronze', name: 'BRONZE', at: 30 }),
  Object.freeze({ key: 'silver', name: 'SILVER', at: 200 }),
  Object.freeze({ key: 'gold', name: 'GOLD', at: 700 }),
]);

/** The most one game can pay. Also the repair bound on the stored counter. */
export const SP_GAME_CAP = 15;

/** Free points, added on read (see the header). Never stored. */
export const ENDOWED_SP = 2;

/**
 * The difficulty band of one game's table. TOTAL — any input goes through
 * `sanitizeRow` first, so a hostile object costs a default row, never a throw.
 *
 * The mean divides by the SEAT count (`bots`), not by `botModes.length`:
 * a mode that was dropped or never recorded contributes 0 to the numerator
 * and still counts in the denominator. A humans-only table has no bots to
 * price and reads ROUTINE — the +3-per-human term carries that weight.
 *
 * @param {unknown} row
 * @returns {(typeof BANDS)[number]}
 */
export function bandFor(row) {
  const r = sanitizeRow(row);
  if (r.bots <= 0) return BANDS[0];
  let sum = 0;
  for (const m of r.botModes) sum += BOT_TIER[m] || 0;
  const mean = sum / r.bots;
  for (const band of BANDS) if (mean <= band.maxMean) return band;
  return BANDS[BANDS.length - 1];
}

/**
 * Sortie points for one banked game. TOTAL, PURE, and always in
 * [1, SP_GAME_CAP] — a garbage row is worth the finish point and nothing else.
 * @param {unknown} row
 * @returns {number}
 */
export function awardFor(row) {
  const r = sanitizeRow(row);
  if (!r.won) return 1;
  const win = 3 * bandFor(r).mult
    + Math.max(0, r.seats - 2)
    + 3 * Math.max(0, r.humans - 1);
  return Math.max(1, Math.min(SP_GAME_CAP, win));
}

/**
 * Where a given EARNED total sits on the ladder. TOTAL: any non-numeric or
 * negative input reads as 0 earned. `tier` is null below Bronze (the fresh
 * state); `next` is null at Gold. `progress` is 0..1 through the current rung.
 * @param {unknown} earned totals.sortiePoints
 */
export function rankFor(earned) {
  // `Number(Symbol())` THROWS — the fuzzer found it on the first run, which is
  // the whole reason this function is fuzz-gated rather than trusted.
  let n = 0;
  try { n = typeof earned === 'number' ? earned : Number(earned); } catch { n = 0; }
  const e = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), BIG) : 0;
  const sp = ENDOWED_SP + e;
  let tier = null;
  for (const t of TIERS) { if (sp >= t.at) tier = t; else break; }
  // indexOf(null) is -1, so the fresh state's `next` is TIERS[0] = Bronze.
  const next = TIERS[TIERS.indexOf(tier) + 1] || null;
  const floor = tier ? tier.at : 0;
  return {
    sp,
    tier,
    next,
    remaining: next ? Math.max(0, next.at - sp) : 0,
    progress: next ? Math.min(1, Math.max(0, (sp - floor) / (next.at - floor))) : 1,
  };
}

// --------------------------------------------------------------------- storage

/**
 * Probe for a *usable* Storage. `localStorage` can exist and still throw on
 * access (iframe, third-party cookies blocked) or on write (quota exhausted,
 * Safari private mode historically), so we test a real round trip rather than
 * a `typeof` check — which is what every one of the three bare try/catch sites
 * in this client gets wrong in the quiet way.
 * @returns {Storage|null}
 */
export function detectStorage() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    const probe = '__chud_probe__';
    localStorage.setItem(probe, '1');
    if (localStorage.getItem(probe) !== '1') return null;
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/** Wall clock. The ONE time call site in this file — see the TIME note above. */
function stamp() {
  try { return Date.now(); } catch { return 0; }
}

/** YYYY-MM-DD, local. Empty string if the clock is unavailable or absurd. */
function today(ms = stamp()) {
  try {
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  } catch { return ''; }
}

// ------------------------------------------------------------------------ store

class StatsStore {
  constructor() {
    /** @type {StatsData} */
    this.data = defaultStats();
    /** false once we have decided never to write (no storage / newer blob) */
    this.persistent = false;
    /** true after the first load() */
    this.loaded = false;
    /** why persistence is off, for the panel and for the report */
    this.status = 'unloaded';
    /** @type {Storage|null} */
    this._storage = null;
    this._timer = 0;
    this._dirty = false;
    this._failures = 0;
    this._listeners = new Set();
    this._hooked = false;
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Read the logbook. NEVER THROWS. Idempotent — safe to call twice.
   * @param {{storage?: Storage|null}} [opts] `storage` injects a shim for tests;
   *   pass `null` explicitly to simulate storage being unavailable.
   * @returns {StatsData}
   */
  load(opts = {}) {
    const explicit = Object.prototype.hasOwnProperty.call(opts, 'storage');
    this._storage = explicit ? (opts.storage || null) : detectStorage();
    this.loaded = true;
    this._failures = 0;
    this._dirty = false;

    if (!this._storage) {
      this.data = defaultStats();
      this.persistent = false;
      this.status = 'no-storage';
      this._emit();
      return this.data;
    }

    let text = null;
    try { text = this._storage.getItem(STATS_KEY); } catch { text = null; }

    if (text == null || text === '') {
      this.data = defaultStats();
      this.persistent = true;
      this.status = 'fresh';
      this._emit();
      return this.data;
    }

    let raw = null;
    let parsed = true;
    try { raw = JSON.parse(text); } catch { parsed = false; }

    if (!parsed) {
      // Corrupt or truncated. Overwriting is safe — there is nothing left to
      // lose — but the bad blob is QUARANTINED to a sidecar key so "what
      // happened to my record" is still an answerable question.
      this._quarantine(text);
      this.data = defaultStats();
      this.persistent = true;
      this.status = 'corrupt';
      this._emit();
      return this.data;
    }

    const storedVersion =
      raw && typeof raw === 'object' && Number.isFinite(Number(raw.version))
        ? Math.floor(Number(raw.version))
        : 0;

    if (storedVersion > STATS_VERSION) {
      // A newer build wrote this. Show nothing, record nothing, DELETE nothing.
      this.data = defaultStats();
      this.persistent = false;
      this.status = 'future-version';
      this._emit();
      return this.data;
    }

    this.data = sanitize(raw);
    this.persistent = true;
    this.status = 'ok';
    this._emit();
    return this.data;
  }

  /** Ensure `load()` has run at least once. */
  ensure() {
    if (!this.loaded) this.load();
    return this.data;
  }

  /** Mark dirty and schedule a coalesced flush. Cheap enough to call freely. */
  write() {
    this._dirty = true;
    this._emit();
    if (!this.persistent || !this._storage) return false;
    if (this._timer) return true;
    if (typeof setTimeout !== 'function') return this.flush();
    this._timer = setTimeout(() => { this._timer = 0; this.flush(); }, WRITE_DEBOUNCE_MS);
    // The tab can die between the mutation and the timer. Hook exit events
    // lazily so a Node consumer (the fuzzer, the tests) never touches `window`.
    this._hookUnload();
    return true;
  }

  /** Force the pending write out now. Returns true if the bytes landed. */
  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = 0; }
    if (!this._dirty) return true;
    if (!this.persistent || !this._storage) return false;
    if (this._failures >= MAX_WRITE_FAILURES) return false;

    let text;
    try {
      this.data.version = STATS_VERSION;
      this.data.updatedAt = stamp();
      if (!this.data.since) this.data.since = today(this.data.updatedAt);
      text = JSON.stringify(this.data);
    } catch {
      // Unserialisable means someone put a cycle in `data`. Stop trying; the
      // in-memory record still works for this session.
      this._failures = MAX_WRITE_FAILURES;
      this.status = 'serialize-failed';
      return false;
    }

    try {
      this._storage.setItem(STATS_KEY, text);
      this._dirty = false;
      this._failures = 0;
      this.status = 'ok';
      return true;
    } catch {
      // Quota or revoked storage. A transient quota can clear, so retry twice,
      // then give up permanently and keep playing.
      this._failures++;
      if (this._failures >= MAX_WRITE_FAILURES) {
        this.persistent = false;
        this.status = 'write-failed';
      }
      return false;
    }
  }

  /** Wipe the logbook, on disk and in memory. The settings surface's "clear". */
  reset() {
    this.data = defaultStats();
    this._failures = 0;
    if (this._storage && this.persistent) {
      try { this._storage.removeItem(STATS_KEY); } catch { /* nothing to do */ }
      try { this._storage.removeItem(STATS_KEY + '.corrupt'); } catch { /* ditto */ }
    }
    this._dirty = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = 0; }
    this._emit();
    return this.data;
  }

  // ------------------------------------------------------------------ record

  /**
   * Bank one finished game. The ONLY mutator the recorder needs.
   *
   * `totals` accumulates here and `recent` is pushed here, but they are
   * independent: the ring drops its oldest row at RECENT_MAX and no total moves.
   *
   * PERSONAL BESTS ARE GATED ON `gaps === 0`. A game recorded across a reconnect
   * that skipped events has undercounted every per-game number in it, so it may
   * not claim a fastest win or a biggest charge. It still counts as a game and a
   * win — those two facts survive any gap, because the final snapshot carries
   * them regardless of what the tail missed.
   *
   * THE RANK MOVEMENT rides the return value: `points` is this game's award,
   * `band` is the difficulty band's NAME (only — the mapping is deliberately
   * non-invertible, see the ladder header), and `from`/`to` are `rankFor`
   * before and after, so the end-of-game surface can show the tier-up or the
   * distance without re-deriving anything.
   *
   * @param {Partial<StatsRow>} rawRow
   * @returns {{row: StatsRow, best: {fastestWin:boolean, biggestCharge:boolean},
   *   rank: {points:number, band:string,
   *     from: ReturnType<typeof rankFor>, to: ReturnType<typeof rankFor>}}}
   */
  recordGame(rawRow) {
    this.ensure();
    const row = sanitizeRow(rawRow);
    if (!row.at) row.at = Math.floor(stamp() / 1000);
    const T = this.data.totals;
    const clean = row.gaps === 0;
    const spBefore = T.sortiePoints;

    T.games++;
    if (row.won) T.wins++;
    if (row.humans > 1) {
      T.humanGames++;
      if (row.won) T.humanWins++;
    }
    T.turns += row.turns;
    T.armed += row.armed;
    if (row.won && row.armed > 0 && row.winRule === 'finalApproach') T.converted++;
    T.shotDown += row.broken;
    T.shootdowns += row.shootdowns;
    T.propertiesStolen += row.stolen;
    T.propertiesLost += row.lost;
    T.setsStolen += row.setsStolen;
    T.setsLost += row.setsLost;
    T.opsecPlayed += row.opsec;
    if (row.opsecDepth > T.opsecDepthBest) T.opsecDepthBest = row.opsecDepth;
    T.timesInsolvent += row.insolvent;
    T.chargedTotal += row.charged;
    T.paidTotal += row.paid;
    for (const k of Object.keys(row.colors)) {
      T.setColors[k] = (T.setColors[k] || 0) + row.colors[k];
      T.setsCompleted += row.colors[k];
    }
    T.endReasons[row.end] = (T.endReasons[row.end] || 0) + 1;
    const points = awardFor(row);
    T.sortiePoints += points;

    // Streak: sign carries the kind, magnitude the length.
    T.streak = row.won ? Math.max(0, T.streak) + 1 : Math.min(0, T.streak) - 1;
    if (T.streak > T.bestWinStreak) T.bestWinStreak = T.streak;
    if (-T.streak > T.worstLossStreak) T.worstLossStreak = -T.streak;

    const best = { fastestWin: false, biggestCharge: false };
    if (clean) {
      if (row.biggest > T.biggestCharge) { T.biggestCharge = row.biggest; best.biggestCharge = true; }
      if (row.won && row.turns > 0 && (T.fastestWinTurns === 0 || row.turns < T.fastestWinTurns)) {
        T.fastestWinTurns = row.turns;
        best.fastestWin = true;
      }
    }

    this.data.recent.push(row);
    while (this.data.recent.length > RECENT_MAX) this.data.recent.shift();
    if (!this.data.since) this.data.since = today();

    this.write();
    return {
      row,
      best,
      rank: { points, band: bandFor(row).name, from: rankFor(spBefore), to: rankFor(T.sortiePoints) },
    };
  }

  // ----------------------------------------------------------- change signal

  /**
   * Subscribe to changes. NOT polling — the panel repaints the frame a game is
   * banked, and nothing runs a timer to find out.
   * @param {(data: StatsData) => void} fn
   * @returns {() => void} unsubscribe
   */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) {
      try { fn(this.data); } catch { /* a broken listener must not take the store down */ }
    }
  }

  // ---------------------------------------------------------------- internals

  _quarantine(text) {
    try {
      this._storage.setItem(STATS_KEY + '.corrupt', String(text).slice(0, 8192));
    } catch { /* quarantine is best-effort by definition */ }
  }

  _hookUnload() {
    if (this._hooked || typeof window === 'undefined' || !window.addEventListener) return;
    this._hooked = true;
    const flush = () => this.flush();
    // `pagehide` is the ONLY event that fires reliably on mobile Safari, and it
    // is why this file exists at all: without it, backgrounding the app loses
    // the last session for every phone player. `beforeunload` covers desktop
    // navigation; `visibilitychange` covers app-switching, which is how a phone
    // player actually leaves.
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
      });
    }
  }
}

/** The single logbook. state/, ui/ and the (later) panel all read this object. */
export const stats = new StatsStore();
