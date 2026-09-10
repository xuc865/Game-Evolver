// server/broadcast.js — Room broadcasting and connection utilities

let G, Bot;

function init(deps) {
  G = deps.G;
  Bot = deps.Bot;
}

function broadcastRoom(room) {
  if (room.state) {
    const integrity = G.validateState(room.state);
    if (!integrity.ok && !room.state.integrityError) {
      console.error(`[GAME] ${room.code} stopped: ${integrity.error}`);
      room.state.integrityError = integrity.error;
      room.state.phase = 'finished';
      room.state.pendingAction = null;
      room.state.turnPhase = 'finished';
      G.logLine(room.state, 'Game stopped because its state failed an integrity check.');
    }
    // Every ending — win, stalemate, scoop-out, integrity stop — is followed by a
    // broadcast, so this is the one hook that catches all of them. It records at most once
    // per game and can never throw into the room.
    require('./gamelog').recordFinished(room, G);

    // …and the same hook is the one place that can honestly say "this table is no longer
    // playing". `room.phase` went to 'playing' in startRoomGame and was NEVER reset, so a
    // room was frozen at its first ruleset for life: after one game `set_rules`, `add_bot`,
    // `remove_bot` and `kick` were all permanently refused and `rematch` silently re-used
    // room.rules. Trying Blitz after one Chudopoly game meant dissolving the room and
    // re-inviting everybody — which defeats the entire point of the lobby's picker.
    //
    // A FINISHED game is not a LIVE game. The round-2 guard that stops `start_game` wiping a
    // game in progress keys off this same flag, and it keeps working exactly as measured:
    // room.phase only returns to 'lobby' once room.state.phase has left 'playing', so a live
    // table is still unconfigurable and still un-restartable.
    if (room.state.phase !== 'playing' && room.phase === 'playing') {
      room.phase = 'lobby';
      console.log(`[ROOM] ${room.code} game finished — room is configurable again`);
    }
  }
  const timerInfo = room.turnTimeout > 0 && room.turnStartedAt
    ? { timeout: room.turnTimeout, startedAt: room.turnStartedAt }
    : null;
  // The answer clock is PER SEAT, because the deadlines are (see server/timers.js). A single
  // room-level `startedAt` was a lie the moment a pending action owed answers from more than
  // one player: one target answering restamped it, and the two seats who had done nothing
  // watched their countdown jump back to full. Each seat is now shown the clock it is
  // actually running against; a seat that owes nothing is shown the next deadline the TABLE
  // is waiting on, which is the honest answer to "how long until something happens".
  const timers = require('./timers');
  const fallbackResponseAt = room.responseTimeout > 0 ? (room.responseStartedAt || null) : null;
  const responseTimerFor = (pid) => {
    if (!(room.responseTimeout > 0)) return null;
    const startedAt = timers.responseDeadlineFor(room, pid)
      ?? timers.earliestResponseDeadline(room)
      ?? fallbackResponseAt;
    return startedAt ? { timeout: room.responseTimeout, startedAt } : null;
  };
  room.players.forEach(p => {
    if (p.ws?.readyState === 1) {
      const view = room.state ? G.getPlayerView(room.state, p.id) : null;
      const responseTimerInfo = responseTimerFor(p.id);
      p.ws.send(JSON.stringify({
        type: 'state', code: room.code,
        phase: room.phase,
        players: room.players.map(x => ({
          id: x.id, name: x.name,
          connected: x.isBot || x.ws?.readyState === 1,
          isBot: !!x.isBot, botMode: x.botMode || null,
        })),
        hostId: room.hostId,
        game: view,
        turnTimer: timerInfo,
        responseTimer: responseTimerInfo,
        // The SETTINGS, always present, as distinct from the two live countdowns above
        // (which exist only while a deadline is actually running). Without these the client
        // could not tell a player what clock the table is on until it was already ticking —
        // "45s to answer" has to be legible before the charge lands, not after.
        // 0 means that clock is off. Seconds.
        timers: { turn: room.turnTimeout ?? null, response: room.responseTimeout ?? null },
        // The RULESET, always present, and the one field that makes the lobby's rules picker
        // legible to a seat that is not the host. `game` is null in a lobby, so before this
        // there was nowhere at all to carry a ruleset that had not started yet: a non-host
        // could not see what they were about to play, only "the host is choosing".
        // `pendingRules` is the lobby's intent (set by the host's `set_rules`); `rules` is
        // what a live game actually resolved to. startRoomGame re-points pendingRules at
        // rules the instant a game starts, so the two can never disagree on the wire.
        rules: room.pendingRules || room.rules || null,
        // The host's own choice reflected back, so the lobby can SAY the room
        // is listed. Never secret — a public room's code is public by the
        // host's choice, and a private room's `false` reveals nothing.
        public: !!room.public,
      }));
    }
  });
}

// Schedule-only: the bot arming half of broadcastAndScheduleBot, without the
// fan-out. Exists for the wedge watchdog (server/handlers.js), which must be
// able to re-arm a stalled bot move on a room whose state has NOT changed —
// broadcasting an unchanged state to every seat once per sweep would be noise.
// scheduleBotAction is idempotent (it returns if a move is already scheduled)
// and self-selecting (it schedules only when a bot actually holds the turn or
// owes an answer), so calling this is always safe.
function ensureBotScheduled(room) {
  const timers = require('./timers');
  Bot.scheduleBotAction(room, {
    broadcast: (r) => { timers.syncTimers(r); broadcastRoom(r); },
    startTimer: timers.startTurnTimer,
    clearTimer: timers.clearTurnTimer,
  });
}

function broadcastAndScheduleBot(room) {
  const timers = require('./timers');
  // Bots create pending actions without going through a message handler, so timer state is
  // reconciled here rather than only in the handlers. Without this a bot's charge in a
  // turnTimeout=0 room armed no response deadline at all.
  //
  // ORDER MATTERS, and getting it wrong is invisible in testing: sync BEFORE broadcasting.
  // A pending action against a human produces no further broadcast until it resolves, so a
  // state serialised before `responseStartedAt` is set carries `responseTimer: null` — and
  // that null is the only value the client will ever see. Measured: the countdown was
  // structurally invisible for 100% of bot-initiated attacks, while human attacks were fine
  // because `case 'play_action'` arms the timer before broadcasting. That asymmetry is
  // exactly why this survived every test we had.
  timers.syncTimers(room);
  broadcastRoom(room);
  ensureBotScheduled(room);
}

function send(ws, msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

function transferHost(room) {
  const connected = room.players.filter(x => x.ws?.readyState === 1 && x.id !== room.hostId && !x.isBot);
  if (connected.length === 0) return;
  const newHost = connected[Math.floor(Math.random() * connected.length)];
  room.hostId = newHost.id;
  console.log(`[ROOM] ${room.code} host transferred to ${newHost.name}`);
}

function isConnected(room, pid) {
  const p = room.players.find(x => x.id === pid);
  if (p?.isBot) return true;
  return p?.ws?.readyState === 1;
}

module.exports = {
  init, broadcastRoom, broadcastAndScheduleBot, ensureBotScheduled, send, transferHost, isConnected,
};
