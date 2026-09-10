/**
 * tools/lib/wsclient.mjs — a raw WebSocket client that speaks the server
 * protocol directly, plus a trivial legal-move policy.
 *
 * WHY THIS EXISTS: fixtures must come from real games (§9), and the new client
 * (public/src/) does not exist yet. Driving `server.js` from Node with `ws`
 * gets real, server-validated, integrity-checked states today. When the P3
 * client lands, record.mjs can switch to browser capture without changing the
 * fixture format.
 *
 * PROTOCOL FACTS THE HARD WAY (server.js / server/handlers.js):
 *
 *   • Handshake: server.js verifyClient rejects an Origin-less socket when
 *     NODE_ENV === 'production'. `ws` from Node sends no Origin. serve.mjs
 *     therefore pins NODE_ENV=test. Symptom otherwise: silent 401, no message.
 *
 *   • Rate limit: 40 client→server messages per rolling 5s window, enforced per
 *     socket; exceeding it is a hard `ws.close(1008)`, not an error message.
 *     Hence SEND_GAP below. A naive driver blows this up inside two turns.
 *
 *   • Join → play sequence, exactly as observed:
 *       C→S {type:'quick_play', name}          (or create_room)
 *       S→C {type:'joined', code, playerId, resumeToken, name}
 *       S→C {type:'chat_history', scope:'global', msgs:[]}
 *       S→C {type:'state', code, phase, players[], hostId, game, turnTimer,
 *            responseTimer}                     ← the only message with game data
 *     `quick_play` also injects two bots and starts the game immediately
 *     (turnTimeout 0, responseTimeout 30). `create_room` leaves you in
 *     phase:'lobby' until the HOST sends start_game.
 *
 *   • There is no ack for a legal action: the server replies with the next
 *     broadcast `state`. An ILLEGAL action replies `{type:'error', message}`
 *     and does NOT rebroadcast — so a driver that waits for state after every
 *     send deadlocks on its first rejected move. The policy here is
 *     candidate-list based: on `error`, immediately try the next candidate.
 *
 *   • `respond` with no/insufficient paymentCards answers
 *     `{type:'need_payment', amount}` — again with no rebroadcast.
 *
 *   • playerId/roomCode live in per-socket server state. One socket = one seat.
 *     A second `quick_play` on the same socket answers
 *     `{type:'error', message:'Already joined to a room'}`.
 */
import { WebSocket } from 'ws';

/** 150ms → 33 messages per 5s window, comfortably under the server's 40. */
const SEND_GAP = 150;

export class ChudClient {
  /**
   * @param {string} wsUrl
   * @param {{name?:string, onState?:Function, onAny?:Function, verbose?:boolean}} opts
   */
  constructor(wsUrl, opts = {}) {
    this.wsUrl = wsUrl;
    this.name = opts.name || 'HARNESS';
    this.onState = opts.onState || (() => {});
    this.onAny = opts.onAny || (() => {});
    this.verbose = !!opts.verbose;
    this.playerId = null;
    this.roomCode = null;
    this.resumeToken = null;
    this.errors = [];
    this.closed = null;
    this._queue = [];
    this._sending = false;
    this._waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      const t = setTimeout(() => reject(new Error('ws connect timeout')), 10000);
      this.ws.on('open', () => { clearTimeout(t); resolve(); });
      this.ws.on('error', (e) => { clearTimeout(t); reject(e); });
      this.ws.on('close', (code, reason) => {
        this.closed = { code, reason: String(reason || '') };
        this._flushWaiters();
      });
      this.ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        this._handle(msg);
      });
    });
  }

  _handle(msg) {
    if (this.verbose) console.log(`    S→C ${msg.type}${msg.message ? ' ' + msg.message : ''}`);
    switch (msg.type) {
      case 'joined':
        this.playerId = msg.playerId;
        this.roomCode = msg.code;
        this.resumeToken = msg.resumeToken;
        break;
      case 'error':
        this.errors.push(msg.message);
        break;
      case 'kicked':
        this.errors.push('kicked');
        break;
    }
    this.onAny(msg, this);
    if (msg.type === 'state') this.onState(msg, this);
    this._flushWaiters(msg);
  }

  _flushWaiters(msg) {
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) {
      if (!msg) { w.reject(new Error(`socket closed (${this.closed?.code})`)); continue; }
      if (w.match(msg)) w.resolve(msg);
      else this._waiters.push(w);
    }
  }

  /** Resolve on the next message matching `match`. */
  waitFor(match, timeoutMs = 15000, label = 'message') {
    return new Promise((resolve, reject) => {
      const w = {
        match,
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter((x) => x !== w);
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      this._waiters.push(w);
    });
  }

  /** Rate-limit-safe send. Serialised with a fixed gap; never bursts. */
  send(msg) {
    return new Promise((resolve, reject) => {
      this._queue.push({ msg, resolve, reject });
      this._pump();
    });
  }

  async _pump() {
    if (this._sending) return;
    this._sending = true;
    while (this._queue.length) {
      const { msg, resolve, reject } = this._queue.shift();
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('socket not open'));
        continue;
      }
      if (this.verbose) console.log(`    C→S ${msg.type}`);
      this.ws.send(JSON.stringify(msg));
      resolve();
      await new Promise((r) => setTimeout(r, SEND_GAP));
    }
    this._sending = false;
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

/* ─────────────────────────── legal-move policy ─────────────────────────── */

/**
 * Harness-local mirror of game.js COLORS sizes. The view ships
 * `completedSets` as a COUNT, not a list of colors, so a driver that wants to
 * aim Inspector General has to work out completeness itself. Drift here costs
 * one rejected probe, never correctness — every move is server-validated and
 * the driver falls forward on `error`.
 */
const SET_SIZE = {
  brown: 2, lightblue: 3, pink: 3, orange: 3, red: 3,
  yellow: 3, green: 3, darkblue: 2, base: 4, intel: 2,
};
const ALL_COLORS = Object.keys(SET_SIZE);

const completeColors = (p) =>
  Object.entries(p?.properties || {})
    .filter(([color, cards]) => (cards || []).length >= (SET_SIZE[color] ?? 99))
    .map(([color]) => color);

function myView(stateMsg, selfId) {
  const g = stateMsg.game;
  if (!g) return null;
  return g.players.find((p) => p.id === selfId) || null;
}

function opponents(stateMsg, selfId) {
  return (stateMsg.game?.players || []).filter((p) => p.id !== selfId && !p.eliminated);
}

/** Mirrors server/timers.js autoPickPayment: bank ascending, then properties ascending. */
export function pickPayment(me, amount, { includeZero = false } = {}) {
  if (!amount || amount <= 0) return [];
  const bank = [...(me.bank || [])].filter((c) => includeZero || c.value > 0).sort((a, b) => a.value - b.value);
  const props = Object.values(me.properties || {}).flat().filter(Boolean)
    .filter((c) => includeZero || c.value > 0).sort((a, b) => a.value - b.value);
  const ids = [];
  let total = 0;
  for (const c of [...bank, ...props]) {
    if (total >= amount) break;
    ids.push(c.id);
    total += c.value;
  }
  // Short of the demand means "pay with everything you have" — the engine
  // accepts total === playerTotalValue. (game.js processPayment)
  return ids;
}

function payAll(me, { includeZero = true } = {}) {
  const bank = (me.bank || []).filter((c) => includeZero || c.value > 0);
  const props = Object.values(me.properties || {}).flat().filter(Boolean)
    .filter((c) => includeZero || c.value > 0);
  return [...bank, ...props].map((c) => c.id);
}

/**
 * Who owes a response right now.
 *
 * The P1 engine rewrite replaced the old `payment_all` + `opsecChains` shape
 * with ONE shape for every pending action:
 *     pendingAction = { type, action, sourceId, amount?, targets:[{id, depth, responderId}] }
 * and the view now ships a flat `responders` array. Both are read here, oldest
 * last, so this driver keeps working across the engine landing mid-run.
 */
function isMyResponse(g, selfId) {
  const pa = g?.pendingAction;
  if (!pa) return false;
  if (Array.isArray(g.responders)) return g.responders.includes(selfId);
  if (Array.isArray(pa.targets)) return pa.targets.some((t) => t.responderId === selfId);
  if (pa.type === 'payment_all') {
    if (Array.isArray(pa.pending) && pa.pending.includes(selfId)) return true;
    const chains = pa.opsecChains || {};
    if (chains[selfId]?.responderId === selfId) return true;
    return selfId === pa.sourceId && Object.values(chains).some((c) => c.responderId === selfId);
  }
  return pa.responderId === selfId;
}

/**
 * Ordered candidate messages for the current state. The driver sends [0] and
 * falls forward on `error`, so the list may contain optimistic moves — being
 * wrong costs one extra round trip, not a stall.
 *
 * @returns {{msgs:object[], reason:string}}
 */
export function planMoves(stateMsg, selfId, opts = {}) {
  const g = stateMsg.game;
  if (!g) {
    // Lobby: the host starts once there are enough seats.
    if (stateMsg.phase === 'lobby' && stateMsg.hostId === selfId && (stateMsg.players || []).length >= 2) {
      return {
        msgs: [{
          type: 'start_game',
          turnTimeout: opts.turnTimeout ?? 60,
          responseTimeout: opts.responseTimeout ?? 30,
        }],
        reason: 'start',
      };
    }
    return { msgs: [], reason: 'lobby-wait' };
  }
  if (g.phase !== 'playing') return { msgs: [], reason: g.phase };

  const me = myView(stateMsg, selfId);
  if (!me) return { msgs: [], reason: 'not-seated' };

  // ---- responding to a pending action -------------------------------------
  const pa = g.pendingAction;
  if (pa) {
    if (!isMyResponse(g, selfId)) return { msgs: [], reason: 'awaiting-others' };
    const amount = pa.amount || 0;
    const msgs = [];
    // Block thefts, pay charges. Not strategy — it is the only way a recorded
    // game ever produces an OPSEC chain to screenshot (§8 shot list), while
    // still letting rents and demands resolve into payment fixtures.
    const holdsOpsec = (me.hand || []).some((c) => c.action === 'opsec');
    const isTheft = ['steal_property', 'steal_set', 'chud', 'swap'].includes(pa.type)
      || ['midnight_requisition', 'inspector_general', 'chud', 'tdy_orders'].includes(pa.action);
    if (opts.opsec !== false && holdsOpsec && isTheft) {
      msgs.push({ type: 'respond', response: 'opsec' });
    }
    if (amount > 0) {
      msgs.push({ type: 'respond', response: 'accept', paymentCards: pickPayment(me, amount) });
      msgs.push({ type: 'respond', response: 'accept', paymentCards: pickPayment(me, amount, { includeZero: true }) });
      msgs.push({ type: 'respond', response: 'accept', paymentCards: payAll(me) });
    }
    msgs.push({ type: 'respond', response: 'accept' });
    return { msgs, reason: `respond:${pa.action || pa.type}` };
  }

  if (g.currentPlayerId !== selfId) return { msgs: [], reason: 'not-my-turn' };
  if (g.turnPhase === 'draw') return { msgs: [{ type: 'draw' }], reason: 'draw' };
  if (g.turnPhase !== 'play') return { msgs: [], reason: `phase:${g.turnPhase}` };

  const hand = me.hand || [];
  const msgs = [];

  /**
   * PASSIVE: draw, discard to the limit, end turn. Never play a card.
   *
   * This is not a strategy, it is a CAMERA ANGLE. Every fixture in tools/ was
   * recorded from a seat that plays as hard as it can, so the recorded seat
   * always won the race — across a full 3-player game (137 broadcasts, seed
   * 1337) no opponent ever held an Upgrade, no opponent ever reached six
   * colours, and the only player who ever armed was the seat holding the
   * camera. Three whole classes of OPPONENT rendering — the seat's upgrade
   * lane, its second mat row, the ARMED treatment on a collapsed seat — had
   * therefore never been drawn by any gate, and each of the three agents who
   * needed one had to hand-stage it.
   *
   * A seat that folds is a seat a real game reaches (§0.7): a player who
   * disconnects, times out on every turn, or simply refuses to act produces
   * exactly this transcript, and the server drives it identically — every state
   * below is still a real, validated, integrity-checked broadcast. What it buys
   * is bots with enough turns to finish what they start.
   */
  if (g.playsRemaining > 0 && !opts.passive) {
    const myColors = Object.keys(me.properties || {}).filter((c) => (me.properties[c] || []).length > 0);
    const foes = opponents(stateMsg, selfId);
    const richest = [...foes].sort(
      (a, b) => Object.values(b.properties || {}).flat().length - Object.values(a.properties || {}).flat().length
    )[0];
    const stealable = (p, includeComplete) => {
      const done = completeColors(p);
      const out = [];
      for (const [color, cards] of Object.entries(p?.properties || {})) {
        if (!includeComplete && done.includes(color)) continue;
        for (const c of cards || []) out.push({ color, card: c });
      }
      return out;
    };

    hand.forEach((card, i) => {
      if (card.type === 'property') {
        msgs.push({ type: 'play_property', cardIndex: i });
      } else if (card.type === 'wild_property') {
        const choices = card.colors?.[0] === 'any' ? (myColors.length ? myColors : ALL_COLORS) : card.colors;
        for (const color of choices.slice(0, 2)) msgs.push({ type: 'play_property', cardIndex: i, targetColor: color });
      } else if (card.type === 'rent') {
        const choices = (card.colors?.[0] === 'any' ? myColors : card.colors.filter((c) => myColors.includes(c)));
        for (const color of choices) msgs.push({ type: 'play_action', cardIndex: i, targetColor: color });
      } else if (card.type === 'action') {
        switch (card.action) {
          case 'pcs_orders':
          case 'surge_ops':
            msgs.push({ type: 'play_action', cardIndex: i });
            break;
          case 'roll_call':
            msgs.push({ type: 'play_action', cardIndex: i });
            break;
          case 'finance_office':
            if (richest) msgs.push({ type: 'play_action', cardIndex: i, targetId: richest.id });
            break;
          case 'inspector_general':
            for (const f of foes) {
              for (const color of completeColors(f)) {
                msgs.push({ type: 'play_action', cardIndex: i, targetId: f.id, targetColor: color });
              }
            }
            break;
          case 'midnight_requisition':
            for (const f of foes) {
              for (const s of stealable(f, false).slice(0, 2)) {
                msgs.push({ type: 'play_action', cardIndex: i, targetId: f.id, targetCardId: s.card.id });
              }
            }
            break;
          case 'chud':
            for (const f of foes) {
              for (const s of stealable(f, true).slice(0, 2)) {
                msgs.push({ type: 'play_action', cardIndex: i, targetId: f.id, targetCardId: s.card.id });
              }
            }
            break;
          case 'tdy_orders': {
            const mine = Object.values(me.properties || {}).flat()[0];
            if (mine) {
              for (const f of foes) {
                const s = stealable(f, false)[0];
                if (s) msgs.push({ type: 'play_action', cardIndex: i, targetId: f.id, targetCardId: s.card.id, myCardId: mine.id });
              }
            }
            break;
          }
          case 'upgrade':
          case 'foc':
            for (const color of completeColors(me)) {
              msgs.push({ type: 'play_action', cardIndex: i, targetColor: color });
            }
            break;
          default:
            break; // opsec is response-only
        }
      } else if (card.type === 'money') {
        msgs.push({ type: 'play_money', cardIndex: i });
      }
    });
  }

  // Always terminate the candidate list with a move that cannot be refused.
  const excess = hand.length - (g.handLimit ?? 7);
  if (excess > 0) {
    const discardIds = [...hand].sort((a, b) => a.value - b.value).slice(0, excess).map((c) => c.id);
    msgs.push({ type: 'end_turn', discardIds });
  }
  msgs.push({ type: 'end_turn' });
  return { msgs, reason: 'play' };
}

/**
 * Drive one seat to completion.
 *
 * @param {ChudClient} client
 * @param {{maxMs?:number, onState?:Function, onIdle?:Function, planOpts?:object}} opts
 */
export async function driveGame(client, opts = {}) {
  const maxMs = opts.maxMs ?? 300000;
  const deadline = Date.now() + maxMs;
  let candidates = [];
  let lastState = null;
  let stateCount = 0;
  let finished = false;
  let stall = null;

  const think = () => {
    if (!lastState) return;
    const plan = planMoves(lastState, client.playerId, opts.planOpts || {});
    candidates = plan.msgs.slice();
    if (candidates.length) advance();
  };
  const advance = () => {
    const next = candidates.shift();
    if (!next) return;
    client.send(next).catch(() => {});
  };

  client.onState = (msg) => {
    lastState = msg;
    stateCount++;
    opts.onState?.(msg, client);
    if (msg.game?.phase === 'finished') { finished = true; return; }
    candidates = [];
    think();
  };
  client.onAny = (msg) => {
    // No rebroadcast follows a rejection; fall forward immediately.
    if (msg.type === 'error' || msg.type === 'need_payment') advance();
  };

  // Priming matters: states received BEFORE driveGame installed its handler
  // (the lobby broadcasts each add_bot triggers) are invisible to it, and the
  // lobby only advances when the host sends start_game in response to one.
  // Without this the driver waits out its whole budget having never acted.
  if (opts.initialState) {
    lastState = opts.initialState;
    think();
  }

  // Watchdog on STATE ARRIVAL, not on the candidate queue. An earlier version
  // watched `candidates.length` and hung forever: a sent-but-ignored move
  // leaves candidates non-empty, which looked like healthy progress.
  let lastStateAt = Date.now();
  const originalOnState = client.onState;
  client.onState = (msg, c) => { lastStateAt = Date.now(); originalOnState(msg, c); };

  while (!finished && Date.now() < deadline && !client.closed) {
    await new Promise((r) => setTimeout(r, 250));
    const idleMs = Date.now() - lastStateAt;
    if (idleMs > (opts.idleMs ?? 20000)) {
      lastStateAt = Date.now();
      stall = (stall || 0) + 1;
      opts.onIdle?.(lastState, stall);
      if (stall >= 3) break; // three dead windows: the game is not going to move
      think();
    }
  }

  return { finished, stateCount, lastState, timedOut: !finished && Date.now() >= deadline };
}
