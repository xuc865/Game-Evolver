// main.js — the one entry (§0.2). Everything below is a real ES module import.
//
// Boot order matters exactly once: interact/pointer's delegated listener is
// mounted last, after every module has registered its data-action handlers.

import * as bus from './core/bus.js';
import { EVENTS } from './core/bus.js';
import { $, setText } from './core/dom.js';
import * as socket from './net/socket.js';
import * as store from './state/store.js';
import * as sel from './state/selectors.js';
import * as table from './table/index.js';
import * as choreographer from './anim/choreographer.js';
import * as interact from './interact/index.js';
import * as pointer from './interact/pointer.js';
import * as handpeek from './interact/handpeek.js';
import * as audio from './audio/engine.js';
import * as fx from './fx/index.js';
import * as screens from './ui/screens.js';
import * as home from './ui/home.js';
import * as lobby from './ui/lobby.js';
import * as hud from './ui/hud.js';
import * as prompt from './ui/prompt.js';
import * as comms from './ui/comms.js';
import * as peek from './ui/peek.js';
import * as overlays from './ui/overlays.js';
import { isHarness, install as installHarness } from './harness.js';

let resolveReady;
const ready = new Promise((resolve) => { resolveReady = resolve; });

/** The single funnel every `state` message goes through — socket or harness. */
function applyState(msg, opts = {}) {
  // `harness` travels too. harness.js has always set it and this funnel has
  // always dropped it, so an injected fixture was indistinguishable from a game
  // a player had just started — and ui/screens.js has to tell them apart, since
  // a view transition costs 320ms of document-wide hit-testing and a fixture
  // teleport buys nothing with it. It is NOT `snap`: the tools deliberately
  // exercise the animated reconcile (setInstant(false), driftCount), so the
  // choreography must stay exactly as it is.
  const result = store.applyState(msg, { snap: !!opts.snap, harness: !!opts.harness });
  table.setSelf(store.store.self.id);
  choreographer.setSelf(store.store.self.id);
  /* A GAME THIS FELT HAS NEVER SHOWN GETS AN EMPTY FELT (owner bug).
   *
   * The last game's card nodes live on until something removes them, and the
   * only thing that ever did was reconcile — which runs at the END of the
   * choreographer's job. So the opening deal of a new game was dealt on top of
   * the previous one's hand for 1.75 measured seconds. Same tick as the apply,
   * before enqueue and before any paint, so there is no frame in which the two
   * games are both on the table.
   *
   * choreographer.clear() first, for the same reason and one step earlier: a
   * job queued by the game that just ended would otherwise reconcile ITS
   * snapshot onto the new game's felt after we emptied it. */
  if (result.fresh) { choreographer.clear(); table.clear(); }
  if (result.snapshot) choreographer.enqueue(result.snapshot, result.events, { snap: result.snap });
  return result;
}

/* ── a session that cannot come back (§P7.21) ──────────────────────────────
 *
 * MEASURED: restart the server and the client sat on a frozen board claiming
 * "connected" forever. The reconnect loop worked perfectly — it just got
 * `{type:'error', message:'Room not found'}` every 2s from
 * server/handlers.js:114/160, which the client only ever TOASTED. clearCreds()
 * was reachable from exactly one place (NET_KICKED), so the dead resume token
 * was replayed for as long as the tab stayed open, and `connected` was true
 * because the transport was up — the indicator was telling the truth about the
 * socket and lying about the game.
 *
 * These two messages mean the seat is gone and no retry can bring it back.
 * They are the only ones treated as fatal: everything else is a refused move.
 */
const FATAL_SESSION = [
  'Room not found',                 // server/handlers.js join_room / reconnect
  'Invalid resume credentials',     // server/handlers.js reconnect
];

function isFatalSessionError(text) {
  return FATAL_SESSION.some(m => String(text).toLowerCase().includes(m.toLowerCase()));
}

/** Stop retrying, forget the seat, say so, and put the player somewhere real.
 *  Same teardown the Leave room control uses (ui/screens.js) — there is exactly
 *  one way out of a session. */
function endSession(why) {
  screens.endSession({
    error: `${why} — that game is over on the server (it restarted, or the room expired). `
      + 'Start a new one.',
    message: 'That room is gone. Starting fresh.',
  });
}

/**
 * The connection flag is wired BEFORE any screen mounts, because ui/hud.js
 * subscribes to the same two events and would otherwise paint the previous
 * value — the indicator was a frame behind the truth in both directions.
 */
function wireConnectionFlag() {
  bus.on(EVENTS.NET_OPEN, () => { store.store.connected = true; });
  bus.on(EVENTS.NET_CLOSE, () => { store.store.connected = false; });
}

function wireNet() {
  bus.on(EVENTS.NET_JOINED, (msg) => {
    store.setSelf(msg.playerId, msg.name);
    table.setSelf(msg.playerId);
    choreographer.setSelf(msg.playerId);
    setText($('home-error'), '');
  });

  bus.on(EVENTS.NET_STATE, (msg) => applyState(msg));

  bus.on(EVENTS.NET_ERROR, (msg) => {
    const text = msg?.message || 'Refused';
    if (isFatalSessionError(text)) { endSession(text); return; }
    screens.toast(text);
    if (msg.needDiscard) interact.beginDiscard(msg.excess || 1);
    if (msg.needPayment) interact.beginPayment(msg.amount || sel.owedAmount());
  });

  bus.on(EVENTS.NET_NEED_PAYMENT, (msg) => interact.beginPayment(msg.amount || sel.owedAmount()));

  // Being removed is a session ending, so it ends the same way every other one
  // does — "there is exactly one way out of a session" (ui/screens.js). Its own
  // hand-rolled teardown was the one that forgot the table: it reset the store
  // and left the room's cards on the felt for the next game to deal onto.
  bus.on(EVENTS.NET_KICKED, () => {
    screens.endSession({ message: 'You were removed from the room' });
  });

  // §7 sound dispatch is structured-event driven — never log prose (§0.5).
  // SFX_FOR_EVENT null means the FX_CUE channel owns that moment — don't fall
  // back to the raw event name. `ev` rides along so virtual families
  // (action/steal/set_progress) resolve without registration-order tricks.
  bus.on(EVENTS.CHOREO_SFX, ({ name, ev, mine }) => {
    const mapped = audio.SFX_FOR_EVENT[name];
    if (mapped !== null) audio.play(mapped || name, { mine, ev });
  });
  // Haptics live in fx/ off the cue channel — dispatching them here too would
  // just be eaten by fx's 300ms floor.
}

/* ── installed-app detection ───────────────────────────────────────────────
 *
 * The manifest asks for `display: standalone`, and an install that got it has
 * no URL bar, no tab strip, and (on iOS) no pull-to-refresh escape — a
 * different chrome geometry than the browser the CSS was measured in. The
 * class lets CSS and code branch on which one is really hosting the page:
 *
 *   html.is-pwa        set when the display-mode media query matches
 *                      (standalone or fullscreen — both mean "no browser
 *                      chrome"), or when iOS's pre-manifest signal
 *                      `navigator.standalone` is true. Browser-tab visits,
 *                      including minimal-ui, stay unclassed.
 *
 * MEASURED in a real standalone window (Chromium `--app=`, the same window
 * chrome an installed PWA gets — CDP cannot emulate `display-mode`, it is not
 * in setEmulatedMedia's feature set): the query matches and the class is on
 * <html> at load with no staging; a browser tab at the same 390×844 stays
 * unclassed. Layout needed no branch: home-rail bottom 844 and primary CTA
 * top 656 in BOTH modes, because .screen's env(safe-area-inset-*) padding
 * (the single owner — checkClient) is the only thing standalone geometry
 * moves, and env() reports it directly. The `change` listener covers a tab
 * popped into an installed window mid-session; no tool can stage that
 * transition, which is what __CHUD.setPWA is for.
 *
 * `pwaForced` is that §9 staging hook: setPWA(true|false) pins the class,
 * setPWA(null) returns to detection. Additive — the §9 contract is unchanged.
 */
let pwaForced = null;
let pwaMQ = null;

function applyPWA() {
  const detected = (pwaMQ ? pwaMQ.matches : false) || navigator.standalone === true;
  document.documentElement.classList.toggle('is-pwa', pwaForced ?? detected);
}

function wirePWA() {
  try { pwaMQ = matchMedia('(display-mode: standalone), (display-mode: fullscreen)'); } catch { pwaMQ = null; }
  applyPWA();
  pwaMQ?.addEventListener?.('change', applyPWA);
}

function boot() {
  wireConnectionFlag();
  wirePWA();
  table.mount(store.store.self.id);

  screens.mount();
  overlays.mount();
  home.mount();
  lobby.mount();
  hud.mount();
  prompt.mount();
  comms.mount();
  peek.mount();
  interact.mount();
  pointer.mount();
  // §3.13 — after pointer.mount() so the capture-phase listeners are ordered the same way
  // they were registered; handpeek only ever reads the event, it never stops propagation.
  handpeek.mount();

  wireNet();

  if (isHarness()) {
    const bridge = installHarness(ready, (msg, opts) => applyState(msg, opts));
    // Stage "this is the installed app" without an install: pins html.is-pwa
    // past any emulated-media flap; setPWA(null) hands back to detection.
    bridge.setPWA = (on) => {
      pwaForced = on == null ? null : !!on;
      applyPWA();
      return document.documentElement.classList.contains('is-pwa');
    };
  } else {
    // §7: no AudioContext before a gesture.
    //
    // Opening SETTINGS does not unlock. Measured by the settings agent: with the
    // settings mark as the session's first pointerdown, the procedural bed is
    // audible at t+145ms and the sheet opens within 3ms — so a player reaching
    // for the volume control gets a second of music first, which is the exact
    // thing they were reaching over to stop.
    //
    // NOT `{ once: true }`, and that is the whole point: `once` retires the
    // listener on the first call whatever the handler decides, so a skip would
    // have burned the unlock and left the game silent for the rest of the
    // session. It removes itself only on the call that actually unlocks.
    const unlock = (e) => {
      if (e.target?.closest?.('[data-action="settings"]')) return;
      audio.init();
      window.removeEventListener('pointerdown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
  }

  // Resume runs in harness mode too, so a tool exercises the same code a player
  // does on a page reload. A fresh harness context holds no credentials.
  const creds = socket.creds();
  if (creds.playerId && creds.code && creds.resumeToken) socket.resumeOrConnect();

  screens.showScreen(store.store.screen);
  resolveReady(true);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

export { ready };
