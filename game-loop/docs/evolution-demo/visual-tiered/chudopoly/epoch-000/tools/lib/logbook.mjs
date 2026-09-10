/**
 * tools/lib/logbook.mjs — put a REAL logbook in a harness browser's storage.
 * HARNESS-AGENT-OWNED (ARCHITECTURE.md §1, §8).
 *
 * ── why this is not three lines of JSON.stringify ────────────────────────
 *
 * The flight log (ui/stats.js) renders `chud.stats.v1` out of localStorage, and
 * a panel tested only against a hand-written blob is a panel that has never met
 * its own recorder. Every field on this surface comes off state/recorder.js,
 * which folds a whole event stream — `final_approach` vs `final_approach_broken`
 * and its `by`, `set_stolen` counting n properties AND one set, `payment.to`
 * vs `.from`, the `gaps` integrity flag — and a fixture written by hand is a
 * fixture written by the same person who wrote the reader. It agrees with
 * itself and with nothing else.
 *
 * So `tools/recordlog.mjs` PLAYS REAL GAMES in a real browser against the real
 * server and dumps whatever state/stats.js ended up with, into
 * `tools/fixtures/logbook.json`. This file consumes that.
 *
 * ── and why the 300-flight case is still honest ──────────────────────────
 *
 * 300 real games is ~an hour of harness time, which is not a gate. So the deep
 * case REPLAYS the recorded rows — the genuine article, every field as the
 * recorder folded it — through THE REAL `StatsStore` (`recordGame`, imported
 * from public/src/state/stats.js and run in Node against an injected storage
 * shim). Nothing here reimplements the fold: the streak arithmetic, the
 * personal-best gate on `gaps === 0`, the ring's 100-row cap and the colour
 * tallies are all executed by the shipping code. Only the MULTIPLICITY of the
 * rows is synthetic, and that is stated rather than hidden.
 *
 * `since` and `updatedAt` are pinned to the recording's own, so the built blob
 * is byte-stable across days — a panel shot whose footer changed at midnight
 * would make both of screenshot.mjs's byte-identical rules unreadable.
 *
 * ── how it reaches the page ──────────────────────────────────────────────
 *
 * `installLogbooks(context)` adds ONE init script that seeds from a
 * `?logbook=<name>` query parameter. It must be installed AFTER
 * `pristineStorage`, because that one clears storage at document start on every
 * navigation and would otherwise wipe the seed — which is also why a driver
 * cannot simply write the key and reload.
 *
 * The client never reads `?logbook`. Only the harness sets it, and it selects a
 * blob this file built; the page sees nothing but a populated storage key,
 * exactly as a returning player's browser would present one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURE_DIR, readJSON } from './harness.mjs';
import { stats, STATS_KEY } from '../../public/src/state/stats.js';

export const LOGBOOK_FIXTURE = path.join(FIXTURE_DIR, 'logbook.json');

/** ui/home.js's saved call sign. See `installLogbooks`. */
const NAME_KEY = 'chud_name';
/** Matches home.js's own `[A-Za-z0-9][A-Za-z0-9 ._'-]{0,15}` and is the name
 *  tools/recordlog.mjs actually played under, so the greeting is not fiction. */
const CALL_SIGN = 'LOGBOOK';

/** The recorded article: `{ recordedAt, seed, games, blob }`, or null. */
export function readLogbook() {
  if (!fs.existsSync(LOGBOOK_FIXTURE)) return null;
  const f = readJSON(LOGBOOK_FIXTURE);
  return f && f.blob && Array.isArray(f.blob.recent) && f.blob.recent.length ? f : null;
}

/** A `Storage` the store can be handed in Node. `load({storage})` takes it. */
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

/**
 * A logbook of exactly `games` flights, banked through the shipping store.
 *
 * @param {number} games how many flights the blob should claim
 * @returns {object|null} the parsed blob, or null with no recording on disk
 */
export function buildLogbook(games) {
  const rec = readLogbook();
  if (!rec) return null;
  const rows = rec.blob.recent;
  const shim = new MemoryStorage();
  // A fresh load rebinds the singleton to the shim and resets `data` to
  // defaults — so each build starts from an empty logbook, not from the last.
  stats.load({ storage: shim });
  for (let i = 0; i < games; i++) stats.recordGame(rows[i % rows.length]);
  // Pinned, not stamped: see the header. `flush()` writes `since` only when it
  // is empty, and `recordGame` has already set it to today, so both are
  // overwritten before the bytes are taken.
  stats.data.since = rec.blob.since || '';
  stats.data.updatedAt = rec.blob.updatedAt || 0;
  stats.flush();
  const text = shim.getItem(STATS_KEY);
  // Put the singleton back on real storage semantics for anything later in the
  // process; every tool that uses this runs it before it opens a browser, but
  // leaving a module-level singleton bound to a dead shim is how a later import
  // gets a surprise.
  stats.load({ storage: null });
  return text ? JSON.parse(text) : null;
}

/**
 * The named populations the gates drive. Each is a real state a real player
 * reaches, and each renders a DIFFERENT panel — that is what makes them worth
 * separate cases rather than one shot of "the stats screen".
 */
export function logbookCases() {
  const rec = readLogbook();
  if (!rec) return {};
  const young = buildLogbook(3);
  const full = buildLogbook(40);
  const deep = buildLogbook(300);
  const cases = {};
  // 3 flights: bands 1 and 2 only, and the line naming what opens at 8.
  if (young) cases['3'] = JSON.stringify(young);
  // ~40: every band, nothing rolled off the ring yet.
  if (full) cases['40'] = JSON.stringify(full);
  // 300: the ring is full and `totals` has outrun it, so the footer names both
  // windows and the form line has its full twenty marks.
  if (deep) cases['300'] = JSON.stringify(deep);
  /* A logbook a NEWER BUILD wrote. Not a fabrication — it is the same recorded
   * blob with its version bumped, which is exactly what a player on an older
   * tab has in storage after the app updates in another one. state/stats.js
   * refuses it read-only: fresh record, persistence OFF, nothing deleted. The
   * panel must still open, must say so in a sentence, and must not look like a
   * crash — which is the whole reason this case is gated. */
  if (full) cases.future = JSON.stringify({ ...full, version: 99 });
  /* A half-written blob, which is what an OS-killed tab leaves behind mid
   * `setItem`. `load()` quarantines it to a sidecar key and starts fresh. */
  cases.corrupt = JSON.stringify(full || {}).slice(0, 220);
  return cases;
}

/**
 * Seed a browser context from `?logbook=<name>`.
 *
 * MUST be called after `pristineStorage(context)` — Playwright runs init
 * scripts in the order they were added, and that one clears localStorage.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {Record<string,string>} [cases] defaults to `logbookCases()`
 * @returns {Promise<string[]>} the case names installed
 */
export async function installLogbooks(context, cases = logbookCases()) {
  const names = Object.keys(cases);
  await context.addInitScript(([key, blobs, nameKey, callSign]) => {
    try {
      const want = new URLSearchParams(location.search).get('logbook');
      if (!want) return;
      if (want === 'none') { localStorage.removeItem(key); localStorage.removeItem(nameKey); return; }
      if (blobs[want]) localStorage.setItem(key, blobs[want]);
      /* A CALL SIGN COMES WITH THE LOGBOOK, because a player with a record is
       * by definition a returning one — `ui/home.js` saves the name on the
       * first Quick Play, so nobody can accumulate flights without one.
       *
       * This also closes a coverage hole nothing else could reach:
       * `pristineStorage` clears storage before every capture, so every gate
       * has only ever rendered the FIRST-TIMER home screen and
       * `.home.is-returning` / `#home-greet` were styled states no picture had
       * ever contained. ui.css says so in its own comment and could do nothing
       * about it, because the home shot has no state to seed from. It does
       * now. */
      if (callSign) localStorage.setItem(nameKey, callSign);
    } catch { /* private mode: the panel's own no-storage path is the subject */ }
  }, [STATS_KEY, cases, NAME_KEY, CALL_SIGN]);
  return names;
}
