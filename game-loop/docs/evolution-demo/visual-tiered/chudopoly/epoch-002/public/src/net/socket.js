// net/socket.js — the socket, the reconnect, and the message router.
//
// Two measured server behaviours shape this file (server.js, harness P2):
//   • 40 messages per rolling 5s per socket, then close(1008) with no warning.
//     Outbound is therefore a FIFO drained at MIN_GAP; 150ms is the proven-safe
//     gap (≈33 msgs / 5s worst case).
//   • Legal commands get NO ack — the next state broadcast is the ack. Illegal
//     ones reply {type:'error'} and do NOT rebroadcast, so the client must never
//     wait for a state that will not come.

import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';

const MIN_GAP = 150;
const RETRY_MS = 2000;

const KEY_PID = 'chud_pid';
const KEY_ROOM = 'chud_room';
const KEY_RESUME = 'chud_resume';

let ws = null;
let connecting = false;
let retryTimer = 0;
let wantConnection = false;
let everOpened = false;          // an outage is only an outage after a first open
let pendingResume = null;        // the ONE armed NET_OPEN hook (see resumeOrConnect)
let queueNoticeAt = 0;

const outbox = [];
let drainTimer = 0;
let lastSentAt = 0;

/** Harness contract (§9 + tools/touchtest.mjs): every outbound message, in order. */
export const sentLog = [];
let recordSends = false;
export function setSendRecording(on) { recordSends = !!on; }

export function creds() {
  return {
    playerId: session(KEY_PID),
    code: session(KEY_ROOM),
    resumeToken: session(KEY_RESUME),
  };
}

export function storeCreds({ playerId, code, resumeToken }) {
  try {
    if (playerId) sessionStorage.setItem(KEY_PID, playerId);
    if (code) sessionStorage.setItem(KEY_ROOM, code);
    if (resumeToken) sessionStorage.setItem(KEY_RESUME, resumeToken);
  } catch { /* private mode: resume simply will not work */ }
}

export function clearCreds() {
  try {
    sessionStorage.removeItem(KEY_PID);
    sessionStorage.removeItem(KEY_ROOM);
    sessionStorage.removeItem(KEY_RESUME);
  } catch { /* ignore */ }
}

function session(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

export function isOpen() { return ws?.readyState === 1; }

/** Is this client TRYING to hold a connection? False before the first
 *  connect() and after disconnect() — a fixture-staged harness page, or a
 *  player who has left. "Not connected" only means something when we want to
 *  be: without this the connection indicator cried wolf on every screenshot. */
export function wanted() { return wantConnection; }

export function connect() {
  wantConnection = true;
  if (isOpen() || connecting) return;
  connecting = true;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket;
  try {
    socket = new WebSocket(`${proto}//${location.host}`);
  } catch (err) {
    connecting = false;
    bus.reportError(err);
    scheduleRetry();
    return;
  }
  ws = socket;

  socket.onopen = () => {
    connecting = false;
    everOpened = true;
    bus.emit(EVENTS.NET_OPEN, null);
    drain();
  };

  socket.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    route(msg);
  };

  socket.onerror = () => { connecting = false; };

  socket.onclose = (e) => {
    connecting = false;
    if (ws === socket) ws = null;
    bus.emit(EVENTS.NET_CLOSE, { code: e?.code || 0, reason: e?.reason || '' });
    if (wantConnection) scheduleRetry();
  };
}

/** @param {{flushFirst?:boolean}} opts flushFirst writes anything queued (a
 *  `leave_room`) before the socket goes down. WebSocket.close() sends its close
 *  frame after the buffered data, so the write is not lost. */
export function disconnect({ flushFirst = false } = {}) {
  wantConnection = false;
  /* AN OUTAGE IS ONLY AN OUTAGE AFTER A FIRST OPEN — AND THIS IS A NEW FIRST.
   *
   * OWNER BUG, second half: "it says offline". Quick play calls connect() and
   * send() in one tick (ui/home.js go()), so the message is queued before the
   * socket can possibly be open. announceQueue() suppresses that on a fresh
   * boot — but `everOpened` was per PAGE, not per session, so the SECOND game
   * of a tab greeted a deliberate Quick Play with "Offline — held, and sent the
   * moment the connection is back", measured 324ms after the leave. The player
   * is not offline; they just pressed a button.
   *
   * A dropped socket never comes through here (only endSession does), so the
   * mid-game outage this notice was written for is untouched. */
  everOpened = false;
  clearTimeout(retryTimer);
  retryTimer = 0;
  if (flushFirst) flush();
  outbox.length = 0;
  if (pendingResume) { pendingResume(); pendingResume = null; }
  try { ws?.close(); } catch { /* already gone */ }
  ws = null;
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = 0;
    if (!wantConnection) return;
    resumeOrConnect();
  }, RETRY_MS);
}

/**
 * Reconnect and immediately re-claim the seat if this tab holds resume creds.
 *
 * §P7.22 — the subscription lifecycle is the whole point. `bus.once()` only
 * unsubscribes when its event FIRES (core/bus.js), and NET_OPEN cannot fire
 * while the server is down; scheduleRetry() calls this every 2s. Measured: a
 * 60s outage armed 29 live hooks and pushed 29 identical `reconnect` frames
 * into the outbox on the one eventual open — 29 × 150ms of MIN_GAP, straight
 * into the server's 40-per-5s limiter, which closes the socket with 1008 and
 * starts the whole thing again. Exactly one hook is armed at a time.
 */
export function resumeOrConnect() {
  const { playerId, code, resumeToken } = creds();
  if (pendingResume) { pendingResume(); pendingResume = null; }
  if (playerId && code && resumeToken) {
    pendingResume = bus.once(EVENTS.NET_OPEN, () => {
      pendingResume = null;
      send({ type: 'reconnect', playerId, code, resumeToken });
    });
  }
  connect();
}

const ROUTES = {
  joined: EVENTS.NET_JOINED,
  state: EVENTS.NET_STATE,
  error: EVENTS.NET_ERROR,
  kicked: EVENTS.NET_KICKED,
  emote: EVENTS.NET_EMOTE,
  chat: EVENTS.NET_CHAT,
  chat_history: EVENTS.NET_CHAT_HISTORY,
  need_payment: EVENTS.NET_NEED_PAYMENT,
};

function route(msg) {
  if (msg?.type === 'joined') {
    storeCreds({ playerId: msg.playerId, code: msg.code, resumeToken: msg.resumeToken });
  }
  const channel = ROUTES[msg?.type];
  if (channel) bus.emit(channel, msg);
}

/**
 * Queue an outbound message. Never writes to the socket directly — see MIN_GAP.
 * sentLog records at ENQUEUE, not at flush: the harness question is "did that
 * touch ask the server for anything", and fixture-staged pages have no socket
 * to flush to at all.
 */
export function send(msg) {
  if (recordSends) sentLog.push({ ...msg, t: Math.round(performance.now()) });
  outbox.push(msg);
  if (!isOpen()) announceQueue();
  drain();
}

/**
 * §P7.12 — a DRAW tap during a measured 4s outage was queued in total silence
 * while the connection dot still read green. The queue is right; the silence is
 * not. Rate-limited so a burst of taps produces one sentence, and suppressed
 * before the first open so a normal boot never says "offline".
 */
function announceQueue() {
  if (!everOpened) return;
  const now = Date.now();
  if (now - queueNoticeAt < 3000) return;
  queueNoticeAt = now;
  bus.emit(EVENTS.TOAST, 'Offline — held, and sent the moment the connection is back');
}

/* ── the browser's own verdict on the network ──────────────────────────────
 * A dropped mobile connection does not always close the socket promptly (the
 * TCP session just stops answering), so the indicator can read "connected" for
 * a whole minute of nothing. navigator.onLine is the earliest honest signal
 * there is, and `online` is a better retry trigger than waiting out RETRY_MS. */
function onOffline() {
  if (!wantConnection) return;
  bus.emit(EVENTS.NET_CLOSE, { code: 0, reason: 'offline' });
}

function onOnline() {
  if (!wantConnection) return;
  if (isOpen()) { bus.emit(EVENTS.NET_OPEN, null); drain(); return; }
  clearTimeout(retryTimer);
  retryTimer = 0;
  resumeOrConnect();
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', onOffline);
  window.addEventListener('online', onOnline);
}

/**
 * Write everything queued RIGHT NOW, ignoring MIN_GAP.
 *
 * For teardown only. `send()` enqueues into an outbox drained at 150ms
 * intervals, so a `leave_room` followed immediately by a disconnect or a
 * navigation was discarded before it ever reached the wire — the server never
 * learned the player had left, and the seat stayed occupied (owner bug, P7).
 * A teardown is at most two frames, nowhere near the server's 40-per-5s limit,
 * and there is no later drain to rely on.
 * @returns {number} frames actually written
 */
export function flush() {
  if (!isOpen()) { outbox.length = 0; return 0; }
  clearTimeout(drainTimer);
  drainTimer = 0;
  let written = 0;
  while (outbox.length) {
    const msg = outbox.shift();
    try {
      ws.send(JSON.stringify(msg));
      written++;
      bus.emit(EVENTS.NET_SENT, msg);
    } catch (err) {
      bus.reportError(err);
      break;
    }
  }
  lastSentAt = Date.now();
  return written;
}

function drain() {
  if (drainTimer) return;
  if (!outbox.length) return;
  if (!isOpen()) return;                    // onopen re-enters drain()
  const wait = Math.max(0, MIN_GAP - (Date.now() - lastSentAt));
  if (wait > 0) {
    drainTimer = setTimeout(() => { drainTimer = 0; drain(); }, wait);
    return;
  }
  const msg = outbox.shift();
  lastSentAt = Date.now();
  try {
    ws.send(JSON.stringify(msg));
    bus.emit(EVENTS.NET_SENT, msg);
  } catch (err) {
    bus.reportError(err);
  }
  if (outbox.length) drain();
}
