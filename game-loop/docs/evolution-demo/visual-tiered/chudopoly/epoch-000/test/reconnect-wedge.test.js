// test/reconnect-wedge.test.js — a resume must never leave the table with nobody to move.
//
// OWNER BUG, 2026-08-07: "I tabbed out of a bot game earlier went back in and everything
// really froze and doesnt let me play cards."
//
// The mechanism has nothing to do with the tab. Tabbing out (a frozen renderer that stops
// answering the server's 15s WebSocket ping, a sleeping laptop, a wifi blip) drops the
// socket; server/handlers.js handleClose hands the seat to a bot; net/socket.js reconnects
// 2s later with the stored resume token; handlers.js reclaimFromBot then calls
// Bot.cancelBotTimeout(room).
//
// There is exactly ONE bot timeout per room (bot.js `room._botTimeout`), so that cancel
// also throws away the move whichever OTHER bot currently holds the turn was about to make
// — and the reclaim paths finished with broadcastRoom(), which does not schedule. Nothing
// else ever can: every path that schedules a bot is reached by a legal move from the
// current player, and the current player is a bot that will never move again. The room
// stops on that bot's turn for good, and a reload does not help (the second reclaim is a
// no-op, so it schedules nothing either).
//
// The invariant, stated so it cannot rot: AFTER A RESUME, A ROOM WHOSE TURN IS HELD BY A
// BOT MUST HAVE A BOT MOVE SCHEDULED. It is asserted here against the real modules rather
// than over a socket, because the wire can only see the symptom (a frozen eventSeq) and
// only after waiting out a bot's think-time, which is a flake waiting to happen.

const test = require('node:test');
const assert = require('node:assert/strict');

// SEV-1 round 2: the watchdog sweep interval, read by server/handlers.js at load. 40ms so
// the recovery test below runs in milliseconds rather than the production 5s. `??=` so an
// explicit CHUD_BOT_WATCHDOG_MS=0 from the command line still disables it — that run is the
// proof this test fails without the fix (§8: a gate must be proven able to fail).
process.env.CHUD_BOT_WATCHDOG_MS ??= '40';

const G = require('../game');
const Bot = require('../bot');
const broadcast = require('../server/broadcast');
const timers = require('../server/timers');
const absent = require('../server/absent');
const handlers = require('../server/handlers');

const rooms = new Map();

function initModules() {
  broadcast.init({ G, Bot });
  timers.init({ G, Bot, broadcast });
  absent.init({ G, broadcast });
  handlers.init({
    G, Bot, broadcast, timers, absent, rooms,
    globalChat: [], CHAT_MAX: 50, chatIdRef: { value: 0 },
    genCode: () => 'TEST', genId: () => `id-${Math.random().toString(16).slice(2)}`,
    genResumeToken: () => `tok-${Math.random().toString(16).slice(2)}`,
    wss: { clients: new Set() },
  });
}

/** A socket that is open enough for broadcast.send and isConnected. */
function fakeSocket() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } };
}

/** A live Quick Play shape: one human seat, three bots, a game in progress. */
function makeRoom(humanWs) {
  const human = {
    id: 'human-1', name: 'OWNER', ws: humanWs,
    resumeToken: 'resume-token-1',
  };
  const players = [human];
  for (let i = 0; i < 3; i++) {
    players.push({ id: `bot-${i}`, name: `Bot${i}`, ws: null, isBot: true, botMode: 'neutral' });
  }
  const room = {
    code: 'TEST', phase: 'playing', hostId: human.id, players, chat: [],
    turnTimeout: 0, responseTimeout: 45, state: null,
  };
  room.state = G.createGame(players.map(p => ({ id: p.id, name: p.name })), { seed: '1337' });
  rooms.set(room.code, room);
  return { room, human };
}

/** Put the turn on a bot and give that bot a scheduled move, the way every
 *  broadcast does. */
function handTurnToABot(room) {
  // Seats are SHUFFLED at game start (createGame shuffleSeats, owner directive
  // 2026-08-07), so a roster index is not a state index — resolve by id.
  const botIds = new Set(room.players.filter(p => p.isBot).map(p => p.id));
  room.state.currentPlayerIndex = room.state.players.findIndex(p => botIds.has(p.id));
  room.state.turnPhase = 'play';
  broadcast.broadcastAndScheduleBot(room);
  assert.ok(room._botTimeout, 'setup: a bot holds the turn and its move is scheduled');
}

/** The seat whose turn it is, as the engine sees it. */
function turnHolder(room) {
  return room.state.players[room.state.currentPlayerIndex];
}

function cleanup(room) {
  Bot.cancelBotTimeout(room);
  timers.clearTurnTimer(room);
  if (room._botWatchdog) { clearInterval(room._botWatchdog); room._botWatchdog = null; }
  rooms.delete(room.code);
}

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

test.before(initModules);

test('a reconnect that reclaims a seat from a bot leaves the table playable', () => {
  const ws = fakeSocket();
  const { room, human } = makeRoom(ws);
  try {
    handTurnToABot(room);

    // The tab went away: handleClose gives the seat to a bot.
    handlers.handleClose({ playerId: human.id, roomCode: room.code }, ws);
    assert.equal(human.isBot, true, 'the abandoned seat is played by a bot');
    assert.equal(human._wasHuman, true);

    // …and comes back, with the token net/socket.js kept in sessionStorage.
    const ws2 = fakeSocket();
    handlers.handleMessage(ws2, {
      type: 'reconnect', code: room.code, playerId: human.id, resumeToken: human.resumeToken,
    }, { playerId: null, roomCode: null });

    assert.ok(!human.isBot, 'the seat is a human seat again');
    assert.ok(ws2.sent.some(m => m.type === 'joined'), 'the resume was accepted');

    const holder = room.players.find(p => p.id === turnHolder(room).id);
    if (holder?.isBot && room.state.phase === 'playing' && !room.state.pendingAction) {
      assert.ok(room._botTimeout,
        'a bot holds the turn after the resume and has NO move scheduled — the room is '
        + 'wedged: nothing will ever broadcast again and the player cannot act on a turn '
        + 'that is not theirs');
    }
  } finally {
    cleanup(room);
  }
});

test('a rejoin (join_room with the resume token) leaves the table playable too', () => {
  const ws = fakeSocket();
  const { room, human } = makeRoom(ws);
  try {
    handTurnToABot(room);
    handlers.handleClose({ playerId: human.id, roomCode: room.code }, ws);

    const ws2 = fakeSocket();
    handlers.handleMessage(ws2, {
      type: 'join_room', code: room.code, name: 'OWNER',
      playerId: human.id, resumeToken: human.resumeToken,
    }, { playerId: null, roomCode: null });

    assert.ok(ws2.sent.some(m => m.type === 'joined'), 'the rejoin was accepted');
    const holder = room.players.find(p => p.id === turnHolder(room).id);
    if (holder?.isBot && room.state.phase === 'playing' && !room.state.pendingAction) {
      assert.ok(room._botTimeout,
        'a bot holds the turn after the rejoin and has NO move scheduled — the room is wedged');
    }
  } finally {
    cleanup(room);
  }
});

// SEV-1 round 2: the two tests above pin the ONE cancel-without-re-arm path we know about
// (reclaimFromBot). This one pins the CLASS. A Quick Play room runs turnTimeout 0, so a
// bot's `room._botTimeout` is the only thing that can ever move the table — the staged
// condition below (phase playing, a bot holds the turn, no pendingAction, no bot move
// scheduled) is exactly the terminal wedge, however a future bug reaches it. The watchdog
// armed by startRoomGame must re-arm the bot's move within one sweep.
//
// Proof the gate can fail (§8): CHUD_BOT_WATCHDOG_MS=0 node --test test/reconnect-wedge.test.js
// disables the watchdog and this test alone goes red.
test('a room whose bot move was cancelled without a re-arm recovers by watchdog', async () => {
  const ws = fakeSocket();
  const state = { playerId: null, roomCode: null };
  // The REAL Quick Play path, so the watchdog is armed the way production arms it.
  handlers.handleMessage(ws, { type: 'quick_play', name: 'OWNER' }, state);
  const room = rooms.get('TEST');
  try {
    assert.ok(room?.state, 'quick play produced a live game');
    assert.equal(room.turnTimeout, 0, 'quick play runs with no turn clock — the premise of the wedge');
    handTurnToABot(room);

    // The wedge, staged: whatever future bug cancels the room's one bot timeout without
    // re-arming it leaves exactly this state — and with turnTimeout 0 nothing else can act.
    Bot.cancelBotTimeout(room);
    assert.equal(room._botTimeout, undefined, 'staged: a bot holds the turn, nothing is scheduled');

    // Several sweep intervals, far below any bot think-delay (>=500ms), so what this waits
    // on is the watchdog and only the watchdog.
    await sleep(250);
    assert.ok(room._botTimeout,
      'the watchdog did not re-arm the bot move — the room is wedged for good: no turn '
      + 'clock, no pending answer, and no message can ever legally reach a scheduler');
  } finally {
    cleanup(room || { code: 'TEST', players: [] });
  }
});
