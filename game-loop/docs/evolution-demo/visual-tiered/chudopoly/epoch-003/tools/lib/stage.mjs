/**
 * tools/lib/stage.mjs — "apply a fixture the way the server would".
 * HARNESS-AGENT-OWNED (ARCHITECTURE.md §1, §8).
 *
 * Why this file exists, in one measurement:
 *
 *   Every tool loaded a fixture with its own three lines of `readJSON` +
 *   `applyState`, and all three copies dropped the same field. A fixture
 *   records `selfId` — the seat the transcript was taken from — and nobody
 *   passed it to the client. For a fixture with a `game` that costs nothing,
 *   because store.applyState re-derives the seat from the one player whose
 *   `hand` survived getPlayerView. For a LOBBY broadcast there is no `game` at
 *   all, so `store.self.id` stayed null, `store.room.hostId === store.self.id`
 *   was false, `#lobby-host` stayed hidden — and every `lobby@*.png` on disk
 *   was the guest view. The busiest pre-game screen in the product had never
 *   been rendered by any gate in the state its own host sees.
 *
 * So: one loader, one stager, and the stager always takes the seat first
 * (`__CHUD.joinAs`, §9 — the same `joined` message the server sends before its
 * first broadcast). A gate cannot forget a step it does not perform.
 *
 * The second thing it owns is TRANSIENTS, and the measurement is the reason the
 * two-state `from` option exists at all.
 *
 * `ui/journal.js` raises a full-width `.announce` over the table for 2600ms off
 * CHOREO_EVENT, so it exists only as a REACTION to an event and never as part
 * of a snapshot. `final-approach.json` and `finished.json` both carry
 * `final_approach:214` in their tails, which looks like it should raise it —
 * and does not: store.applyState snaps a first sight of a game whose tail does
 * not begin at seq 1 (`snap = snap || !(tail.length && tail[0].seq === 1)`), so
 * a one-state fixture performs nothing and no announcement ever fired in any
 * capture. MEASURED: `.announce` absent on both fixtures, on a fresh page, at
 * 140ms. That is why the banner had no shot — not because nobody thought of it,
 * but because a one-state fixture structurally cannot produce it.
 *
 * `from` applies the PREVIOUS broadcast first, which sets `lastSeq`, and the
 * second application then arrives with a contiguous tail and is performed. The
 * banner appears, and the shot is taken inside its 2600ms.
 *
 * `quietTransients` is the other half: a capture that is NOT about a transient
 * must not have its bytes depend on whether one was still up. It is insurance
 * rather than a fix for an observed race — no current fixture raises a banner
 * on its first application — and it is cheap, because it returns immediately
 * when there is nothing up.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURE_DIR, readJSON } from './harness.mjs';

/**
 * @param {string} name  fixture basename, no extension
 * @returns {{name:string, states:object[], selfId:string|null}|null}
 */
export function loadFixture(name) {
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  const f = readJSON(file);
  const states = Array.isArray(f) ? f : f.states;
  if (!Array.isArray(states) || !states.length) return null;
  return { name, states, selfId: (Array.isArray(f) ? null : f.selfId) || null };
}

/** Resolve a possibly-negative / possibly-absent index against a state list. */
export function stateAt(states, at) {
  const i = at == null ? states.length - 1 : (at < 0 ? states.length + at : at);
  return states[Math.max(0, Math.min(states.length - 1, i))];
}

/**
 * Put the page into the fixture's state, from the fixture's own seat.
 *
 * `from` applies an EARLIER state first and lets the tail between the two
 * replay as new events. That is the only honest way to reach a client surface
 * that exists solely as a reaction to an event (the `.announce` banner): the
 * announcement is not in any snapshot, it is what the client does when an
 * event arrives, so the harness has to make the event arrive.
 *
 * `timer` (seconds) REBASES the fixture's served clocks. A recorded broadcast
 * carries the server's own `turnTimer`/`responseTimer` `{timeout, startedAt}`
 * — a wall-clock envelope, not game state — and replaying it hours later makes
 * every countdown read 0s left, which is why no staged shot had ever shown
 * `#hud-timer` at all. Rebasing `startedAt` to `Date.now() - (timeout - N)*1000`
 * reproduces exactly what a live client observes N seconds before that same
 * timer expires; the game state is untouched, only the clock origin moves —
 * the same alignment every replay of a wall-clock field requires. It never
 * INVENTS a timer: a fixture whose broadcast carried none stays clockless.
 *
 * @param {import('playwright').Page} page
 * @param {{states:object[], selfId:string|null}} fx
 * @param {{at?:number, from?:number, drain?:boolean, timer?:number}} opts
 * @returns {Promise<{selfId:string|null, adopted:boolean}>}
 */
export async function stageFixture(page, fx, opts = {}) {
  const adopted = fx.selfId
    ? await page.evaluate(
      ([id]) => !!window.__CHUD.joinAs?.(id, null),
      [fx.selfId],
    )
    : false;

  if (opts.from != null) {
    await page.evaluate((s) => {
      window.__CHUD.applyState(s);
      window.__CHUD.drainEvents?.();
    }, stateAt(fx.states, opts.from));
    await page.waitForTimeout(120);
  }

  const state = stateAt(fx.states, opts.at);
  await page.evaluate(([s, drain, timerLeft]) => {
    if (timerLeft != null) {
      for (const k of ['turnTimer', 'responseTimer']) {
        if (s[k] && s[k].timeout > 0) {
          s = { ...s, [k]: { ...s[k], startedAt: Date.now() - (s[k].timeout - timerLeft) * 1000 } };
        }
      }
    }
    window.__CHUD.applyState(s);
    if (drain) window.__CHUD.drainEvents?.();
  }, [state, opts.drain !== false, opts.timer ?? null]);
  return { selfId: fx.selfId, adopted };
}

/**
 * How long ui/journal.js keeps the banner up (ANNOUNCE_MS 2600 + a 260ms fade
 * out). Read here rather than guessed: if that constant moves, this number is
 * the thing that has to move with it, and it is one place.
 */
export const ANNOUNCE_TOTAL_MS = 2600 + 260;

/**
 * Wait for the once-off layers a state application can raise to go away again,
 * so a capture that is not about them is reproducible. Returns which ones it
 * had to wait for, so "the shot was clean" and "the shot was cleaned" stay
 * distinguishable in a log.
 */
export async function quietTransients(page, budgetMs = ANNOUNCE_TOTAL_MS + 600) {
  const up = () => page.evaluate(() => {
    const vis = (el) => {
      if (!el || el.hidden) return false;
      const st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.05;
    };
    const out = [];
    if (vis(document.querySelector('.announce'))) out.push('announce');
    const t = document.getElementById('toast');
    if (t && t.classList.contains('is-on') && vis(t)) out.push('toast');
    return out;
  });
  const first = await up();
  if (!first.length) return [];
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    await page.waitForTimeout(150);
    if (!(await up()).length) break;
  }
  return first;
}
