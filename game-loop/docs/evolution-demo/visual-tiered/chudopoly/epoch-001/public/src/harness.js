// harness.js — the §9 test-only bridge, installed only with ?harness=1.
//
// Nothing in the shipped game may depend on this file: it observes, it injects
// recorded states, and it turns choreography instant so a tool never waits on a
// cinematic. driftCount is a live read of table/'s counter, so a tool can sample
// it between injections.

import * as table from './table/index.js';
import * as choreographer from './anim/choreographer.js';
import * as flight from './anim/flight.js';
import * as store from './state/store.js';
import * as audio from './audio/engine.js';
import * as fx from './fx/index.js';
import * as socket from './net/socket.js';
import * as interact from './interact/index.js';
import * as bus from './core/bus.js';
import * as clock from './core/clock.js';

export function isHarness() {
  try { return new URLSearchParams(location.search).has('harness'); } catch { return false; }
}

export function install(readyPromise, applyStateFn) {
  const bridge = {
    version: 1,
    ready: readyPromise,
    sfxLog: [],
    hapticLog: [],
    sentLog: socket.sentLog,
    lastError: null,
  };

  Object.defineProperty(bridge, 'driftCount', {
    get: () => table.driftCount(),
    enumerable: true,
  });
  // Read-only view of what the client believes, so a tool can say WHY it is
  // stuck instead of guessing from the DOM.
  Object.defineProperty(bridge, 'snapshot', {
    get: () => store.store.snapshot,
    enumerable: true,
  });
  Object.defineProperty(bridge, 'selfId', {
    get: () => store.store.self.id,
    enumerable: true,
  });
  // The interaction machine's current mode — P4's tools need to assert on
  // "the tap put us in targeting", which the DOM only shows indirectly.
  Object.defineProperty(bridge, 'mode', {
    get: () => ({
      kind: interact.mode.kind,
      cardId: interact.mode.cardId,
      intent: interact.mode.intent,
      needs: interact.mode.needs.slice(),
      picks: { ...interact.mode.picks },
      selected: [...interact.mode.selected],
      hint: interact.mode.hint,
    }),
    enumerable: true,
  });
  // Why the table is not moving. pending() alone cannot tell "the queue is
  // empty" from "the queue is empty because the drain is parked on a clock that
  // stopped", and the clock's own frame count is the only thing that says
  // whether frames are being delivered at all (backgrounded tab, §0.6).
  Object.defineProperty(bridge, 'choreo', {
    get: () => ({ pending: choreographer.pending(), running: choreographer.isRunning() }),
    enumerable: true,
  });
  Object.defineProperty(bridge, 'clock', {
    get: () => ({ now: clock.now(), frames: clock.frameCount(), subs: clock.subCount() }),
    enumerable: true,
  });
  Object.defineProperty(bridge, 'driftLog', {
    get: () => table.lastCorrections(),
    enumerable: true,
  });
  // ART §4's hitstop, countable from outside. flight.hitstopCount() was correct
  // and measured (40–58ms stalls, one per landing beat) while NO tool read it —
  // zeroing HITSTOP_MS shipped green. Additive; the §9 contract is unchanged.
  Object.defineProperty(bridge, 'hitstopCount', {
    get: () => flight.hitstopCount(),
    enumerable: true,
  });

  bridge.applyState = (msg) => {
    applyStateFn(msg, { harness: true });
    return true;
  };

  /**
   * Take the seat the fixture was RECORDED FROM, exactly as a real join does.
   *
   * MEASURED 2026-08-07: a lobby broadcast carries no `game`, and `game` is the
   * only thing store.applyState can infer a seat from (it looks for the one
   * player whose `hand` survived getPlayerView). So a lobby fixture left
   * `store.self.id` null, `store.room.hostId === store.self.id` was false, and
   * EVERY `lobby@*.png` in tools/shots was the GUEST view. Nothing in the whole
   * harness had ever rendered a host lobby, so nothing had ever seen that at
   * 1280×720 with four seats the host cannot reach Launch Mission.
   *
   * This is the same `joined` message the server sends before its first `state`
   * (server/handlers.js create_room / join_room / quick_play), pushed through
   * the same bus event main.js already wires, so the seat is adopted by the
   * client's own code path and not by a harness back door. Nothing here is
   * reachable without ?harness=1.
   */
  bridge.joinAs = (playerId, name) => {
    if (!playerId) return false;
    bus.emit(bus.EVENTS.NET_JOINED, { type: 'joined', playerId, name: name || null });
    return store.store.self.id === playerId;
  };

  bridge.drainEvents = () => {
    choreographer.clear();
    if (store.store.snapshot) table.reconcile(store.store.snapshot, { count: false, animate: false });
    // The table just settled outside the choreographer's drain loop — announce
    // it, or CHOREO_IDLE listeners (interaction marks) never re-run on fixtures.
    bus.emit(bus.EVENTS.CHOREO_IDLE, null);
    return true;
  };

  bridge.resetDrift = () => { table.resetDrift(); return true; };

  // P4 affordance: the motion agent needs the REAL timing path under the bridge,
  // and drift is only an honest metric when the animated reconcile runs.
  bridge.setInstant = (on) => { choreographer.setInstant(on); return true; };

  choreographer.setInstant(true);
  socket.setSendRecording(true);
  // `big` rides along: it selects a different voice/mix branch in audio/engine,
  // and without it no tool could assert the big-moment path ever fires (audio
  // agent, P7 round 1 — it had to wrap the recorder in a throwaway driver).
  audio.setRecorder((name, opts) => {
    bridge.sfxLog.push({
      name,
      t: Math.round(performance.now()),
      mine: !!opts?.mine,
      big: !!opts?.big,
    });
  });
  bridge.audio = audio.harnessApi();
  fx.setHapticRecorder((pattern) => {
    bridge.hapticLog.push({ pattern, t: Math.round(performance.now()) });
  });
  // fx/ self-attaches `bridge.fxLog` with its live cue log on first cue — do
  // not pre-create the key here, a foreign empty array would shadow the log.

  const record = (err) => {
    bridge.lastError = err && err.message ? `${err.message}` : String(err);
  };
  bus.setErrorSink((err) => { record(err); console.error(err); });
  window.addEventListener('error', (e) => record(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => record(e.reason));

  window.__CHUD = bridge;
  return bridge;
}
