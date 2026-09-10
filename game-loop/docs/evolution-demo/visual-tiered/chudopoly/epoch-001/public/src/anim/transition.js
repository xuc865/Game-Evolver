// anim/transition.js — the ONE wrapper around the View Transitions API.
//
// ART §4 asks for a view transition on SCREEN CHANGES: home → lobby → table,
// and the table → the victory screen. MEASURED before this file existed:
// `grep -r startViewTransition public/` returned nothing, and both changes were
// hard cuts — the win overlay appeared between two consecutive captured frames
// with no transition at all, and lobby → table was a 33ms cut.
//
// ── WHAT IT IS NOT FOR ────────────────────────────────────────────────────
// Never a card. §10 requires card motion to stay interruptible and anim/
// flight.js owns it; a view transition freezes a snapshot of the old page and
// blocks input for its duration, which is the exact opposite of interruptible.
// This is for changes where the WHOLE screen is replaced and there is nothing
// to interrupt.
//
// ── THE THREE GUARDS ──────────────────────────────────────────────────────
//   • capability — Firefox and older Safari have no startViewTransition, so the
//     mutation runs bare. It is a progressive enhancement, never a dependency:
//     `run` is called synchronously in that case, so no caller can end up in a
//     state where its DOM change did not happen.
//   • §0.9 reduced motion — the transition is skipped entirely and the change
//     is instant. The cues around it are somebody else's and are unaffected.
//   • re-entrancy — a second call while one is running skips rather than queues.
//     Screen changes arrive in bursts on a reconnect (home → lobby → game in
//     one tick) and chaining 300ms transitions would hold the screen on a stale
//     frame for the better part of a second.
//
// A fourth guard is ui/screens.js's, because only it knows the answer: a screen
// that was never CHANGED into — the first one ever painted, or one teleported to
// by a reconnect/resume/fixture — never reaches this file at all.
//
// The LOOK of the transition (durations, easings, which pseudo-elements move)
// lives in public/style/motion.css under ::view-transition-*; this file only
// decides whether one happens at all.
//
// ── WHY THE CLEANUP IS PARANOID (§P9 FEEL round 4) ────────────────────────
// A running view transition TAKES HIT-TESTING AWAY FROM THE WHOLE DOCUMENT.
// Measured on the shipped build: `document.elementFromPoint(x, y)` anywhere on
// the page returns `<html>` for the entire life of the transition, because the
// live subtree is captured and the ::view-transition pseudo tree is what is on
// screen. Every card, every button, every mat is unreachable to a pointer for
// as long as it lasts.
//
// That is acceptable for 280ms of a screen change the player asked for. It is
// not acceptable one millisecond longer, and it makes `running` the most
// dangerous flag in the client: leave it true and the class stays on <html>,
// the input-dead state stays with it, and every later screen change is skipped
// as well. `t.finished` is the only thing that clears it, and it is a promise
// from an API that can decline to settle (a transition abandoned by a
// navigation, a document that stops producing frames). So cleanup here happens
// on the resolve path, the reject path, the throw path AND on a watchdog — four
// ways in, and it is idempotent so all four may fire.
//
// The class is also removed from the SAME element it was added to, captured in
// the closure, so nothing can remove it from a different root than it landed on.

import { prefersReducedMotion } from '../core/dom.js';

let running = false;

/* Longest declared ::view-transition animation in motion.css is 320ms
   (vt-seat). The watchdog is deliberately far beyond it: it is not a duration,
   it is the answer to "the promise never settled", and it must never fire
   before a healthy transition has finished on a slow frame. */
const WATCHDOG_MS = 1500;

/** Is a view transition possible right now? Exposed for the harness. */
export function supported() {
  return typeof document !== 'undefined'
    && typeof document.startViewTransition === 'function';
}

/**
 * Run `mutate` inside a view transition when that is possible and wanted.
 *
 * @param {() => void} mutate the DOM change. ALWAYS runs, exactly once.
 * @param {string} [name] a class put on <html> for the duration, so motion.css
 *        can give different screen changes different choreography.
 * @returns {boolean} true if a transition was actually started.
 */
export function screenChange(mutate, name = '') {
  if (typeof mutate !== 'function') return false;
  if (running || !supported() || prefersReducedMotion()) { mutate(); return false; }

  const root = document.documentElement;
  const cls = name ? `vt-${name}` : '';
  let cleaned = false;
  let watchdog = 0;
  // ONE exit for every path, idempotent, and it can never throw on a caller.
  const done = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(watchdog);
    running = false;
    if (cls) root.classList.remove(cls);
  };

  running = true;
  if (cls) root.classList.add(cls);

  let t;
  try {
    t = document.startViewTransition(() => { mutate(); });
  } catch {
    // A browser that has the method but refuses the call (a transition already
    // in flight in another frame) must still get its DOM change — and must not
    // be left wearing the class. `mutate` runs AFTER the tidy-up so a caller
    // that reads the class sees the resting document.
    done();
    mutate();
    return false;
  } finally {
    // No handle at all — a shim that returns undefined, or the throw above.
    // Nothing will ever settle, so this is the only cleanup there is. (On the
    // healthy path `t` is truthy and this is a no-op; `cleaned` makes every
    // ordering of these paths safe.)
    if (!t) done();
  }

  // Belt: the ordinary end of a transition, resolved or rejected. `finished`
  // rejects when the callback throws or the transition is abandoned, and a
  // rejection that skipped the class removal is exactly the state that made
  // the whole document unreachable to hit-testing. A handle without a
  // `finished` at all is treated as a promise that never settles: the watchdog
  // below is then the only thing standing between the player and a dead page.
  try { t.finished.then(done, done); } catch { /* the watchdog has it */ }
  // Braces: a promise that never settles at all. Nothing in the API guarantees
  // one will, and the cost of being wrong is a permanently input-dead page.
  // skipTransition() first, so the FROZEN SNAPSHOT ends too and not just the
  // bookkeeping about it — tidying the class off a document that is still
  // showing a stale capture would hide the failure rather than end it.
  watchdog = setTimeout(() => { try { t.skipTransition?.(); } catch { /* already over */ } done(); }, WATCHDOG_MS);
  return true;
}
