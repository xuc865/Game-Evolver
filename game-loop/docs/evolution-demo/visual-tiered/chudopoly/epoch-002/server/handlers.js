// server/handlers.js — WebSocket message handlers

let G, Bot, broadcast, timers, absent;
let rooms, globalChat, CHAT_MAX, chatIdRef, genCode, genId, genResumeToken, wss;

function init(deps) {
  G = deps.G;
  Bot = deps.Bot;
  broadcast = deps.broadcast;
  timers = deps.timers;
  absent = deps.absent;
  rooms = deps.rooms;
  globalChat = deps.globalChat;
  CHAT_MAX = deps.CHAT_MAX;
  chatIdRef = deps.chatIdRef;
  genCode = deps.genCode;
  genId = deps.genId;
  genResumeToken = deps.genResumeToken;
  wss = deps.wss;
}

function sendJoined(ws, room, player) {
  broadcast.send(ws, {
    type: 'joined', code: room.code, playerId: player.id,
    resumeToken: player.resumeToken, name: player.name,
  });
}

/* ── Seat authority ──────────────────────────────────────────────────── */

// The ONLY way to sit down in a seat that already exists. Every seat's UUID is broadcast to
// every room member, so a player id is public and proves nothing; the private resume token
// is the whole credential.
//
// This used to be `find(x => x.id === msg.playerId && x.resumeToken === msg.resumeToken)`.
// Bots are minted with NO resumeToken and the protocol allowed the field to be omitted, so
// `undefined === undefined` matched: quoting a bot's public UUID with no token at all handed
// over the seat, its private hand, and full command authority over it. `leave_room` then set
// `_wasHuman`, and a second join hit the reclaim branch and converted the bot into an
// uncontested human seat still wearing the bot's callsign.
//
// Three independent conditions, all required:
//   1. the presented credential is a non-empty string (never undefined/null/'');
//   2. the SEAT holds a non-empty token too (a bot seat holds none, so it can never match);
//   3. the seat is not a bot that no human has ever occupied — those belong to nobody.
function findClaimableSeat(room, playerId, resumeToken) {
  if (typeof playerId !== 'string' || playerId === '') return null;
  if (typeof resumeToken !== 'string' || resumeToken === '') return null;
  const seat = room.players.find(x => x.id === playerId);
  if (!seat) return null;
  if (typeof seat.resumeToken !== 'string' || seat.resumeToken === '') return null;
  if (seat.resumeToken !== resumeToken) return null;
  if (seat.isBot && !seat._wasHuman) return null;
  return seat;
}

// A seat a human held before the takeover comes back to that human, AI and all.
//
// THE CANCEL IS NOT OPTIONAL AND NEITHER IS THE RESCHEDULE (owner bug, 2026-08-07:
// "I tabbed out of a bot game … went back in and everything really froze and doesnt
// let me play cards"). There is ONE bot timeout per room (bot.js `room._botTimeout`),
// so cancelling the move a seat-that-is-no-longer-a-bot was about to make also throws
// away the move whichever OTHER bot currently holds the turn was about to make. Nothing
// re-arms it: every caller of this function finished with `broadcastRoom`, which does
// not schedule, and no later message can schedule one either — every path that does is
// reached by a LEGAL move from the current player, and the current player is a bot that
// is never going to move again. The room stops dead on that bot's turn, permanently,
// and survives a reload (the second reclaim is a no-op, so nothing schedules then
// either). Measured on quick play: drop the socket, reconnect 2.5s later, and eventSeq
// is frozen at the same number 12s on with `phase: 'playing'` — a table nobody can act
// on, which is exactly what the owner was looking at.
//
// So callers must broadcast with `broadcastAndScheduleBot`. Rescheduling is safe and
// idempotent: bot.js's scheduleBotAction returns immediately if a timeout already
// exists, and it schedules for whoever currently holds the turn — which, after the
// lines above, is by definition not this seat.
function reclaimFromBot(room, seat, code, how) {
  if (!seat.isBot || !seat._wasHuman) return;
  seat.isBot = false;
  delete seat._wasHuman;
  delete seat.botMode;
  Bot.cancelBotTimeout(room);
  console.log(`[BOT] ${code} ${seat.name} reclaimed from bot (${how})`);
}

/* ── Bot watchdog ────────────────────────────────────────────────────── */

// Defence in depth for the owner's 2026-08-07 freeze, SEV-1 round 2. A Quick Play room runs
// turnTimeout 0, so the ONE thing that ever advances a bot's turn is `room._botTimeout` —
// if it is ever unarmed while a bot holds the turn (or owes the only outstanding answer),
// NOTHING recovers: no clock, no later message, no reload. reclaimFromBot's cancel was one
// proven way to reach that state; this sweep exists so the NEXT cancel-without-re-arm bug —
// whatever shape it takes — costs one sweep interval instead of the table.
//
// The sweep is deliberately dumb and unconditionally safe: scheduleBotAction is idempotent
// (returns if a move is already scheduled) and self-selecting (schedules only when a bot has
// something to do), so the only real condition is "playing and nothing armed". It never
// broadcasts. 0 disables it — that is how its own regression test proves the wedge is real.
const BOT_WATCHDOG_MS = Math.max(0, Number(process.env.CHUD_BOT_WATCHDOG_MS ?? 5000));

function armBotWatchdog(room) {
  if (!BOT_WATCHDOG_MS || room._botWatchdog) return;
  room._botWatchdog = setInterval(() => {
    if (rooms.get(room.code) !== room) { clearBotWatchdog(room); return; }
    if (!room.state || room.state.phase !== 'playing') return;
    if (room._botTimeout) return;
    broadcast.ensureBotScheduled(room);
    // Visibility, not control flow: if this line ever prints outside a test, some path
    // cleared the bot timeout without re-arming and should be hunted down.
    if (room._botTimeout) console.log(`[BOT] ${room.code} watchdog re-armed a stalled bot move`);
  }, BOT_WATCHDOG_MS);
  room._botWatchdog.unref?.();
}

function clearBotWatchdog(room) {
  if (room._botWatchdog) { clearInterval(room._botWatchdog); room._botWatchdog = null; }
}

/* ── Room reaping ────────────────────────────────────────────────────── */

// How long an abandoned room is kept alive so a dropped player can come back.
const REAP_DELAY_MS = Math.max(50, Number(process.env.CHUD_REAP_MS) || 30000);
// A LIVE game between two or more humans gets a longer window. Production incident,
// 2026-08-20 ~17:58 UTC (room L2NR): the office network dropped every long-lived
// connection at once while short HTTP kept flowing — all three humans fell off within
// 15 seconds, flapped back, dropped again, and the room was deleted mid-game with the
// last player only 10s gone. A multi-human table is the most expensive thing on the
// server to lose and the cheapest to keep; solo/quick-play rooms stay on the SHORT
// window on purpose, so an abandoned bot table is still collected before it can play
// itself out and pollute the game log (see the immortal-rooms defect below).
const REAP_PLAYING_GRACE_MS = Math.max(REAP_DELAY_MS,
  Number(process.env.CHUD_REAP_PLAYING_MS) || REAP_DELAY_MS * 4);

function reapDelayFor(room) {
  const humanSeats = room.players.filter(p => !p.isBot || p._wasHuman).length;
  if (room.state?.phase === 'playing' && humanSeats >= 2) return REAP_PLAYING_GRACE_MS;
  return REAP_DELAY_MS;
}

// ONE reaper per room, armed by every path that can leave a room without a live human in it.
//
// Two defects lived here. (a) `leave_room` during a live game — the normal ✕ / "Leave room"
// button — nulled state.roomCode and returned, so handleClose bailed at `if (!roomCode)` and
// nothing was ever scheduled: the room, its bots, its turn timer and its state object lived
// forever, and each abandoned table still played its bot game to completion and wrote a
// gamelog record (measured: 300 immortal rooms in 8.5s from 10 sockets; ~600x disk-write
// amplification). (b) handleClose armed a fresh uncancelled 30s timeout on EVERY disconnect,
// so a flapping connection stacked them; the `_reapTimerId` guard makes it at most one.
//
// The grace is measured from the LAST human departure, not from whenever the one timer
// happened to be armed. Every call stamps `_lastHumanLeftAt` (even while other humans are
// still connected — the stamp only matters once nobody is), and a firing timer that finds
// the room emptied more recently than its full window re-arms for the remainder instead of
// deleting. Without this, the timer armed by the FIRST drop billed its whole window to
// whoever dropped last — in L2NR that turned a 30s promise into 10s of actual grace.
function scheduleRoomReap(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room._lastHumanLeftAt = Date.now();
  if (room._reapTimerId) return;
  armRoomReap(room, roomCode, reapDelayFor(room));
}

function armRoomReap(room, roomCode, delayMs) {
  room._reapTimerId = setTimeout(() => {
    const r = rooms.get(roomCode);
    if (!r) return;
    r._reapTimerId = null;
    if (!r.players.every(x => x.isBot || !x.ws || x.ws.readyState !== 1)) {
      broadcast.broadcastRoom(r);
      return;
    }
    const remaining = reapDelayFor(r) - (Date.now() - (r._lastHumanLeftAt || 0));
    if (remaining > 50) { armRoomReap(r, roomCode, remaining); return; }
    timers.clearTurnTimer(r);            // otherwise the deleted room keeps playing forever
    clearBotWatchdog(r);
    rooms.delete(roomCode);
    console.log(`[ROOM] ${roomCode} deleted (empty)`);
  }, delayMs);
  room._reapTimerId.unref?.();
}

function deleteRoom(roomCode, room) {
  if (room._reapTimerId) { clearTimeout(room._reapTimerId); room._reapTimerId = null; }
  if (room._rulesBroadcastTimer) { clearTimeout(room._rulesBroadcastTimer); room._rulesBroadcastTimer = null; }
  clearBotWatchdog(room);
  timers.clearTurnTimer(room);
  rooms.delete(roomCode);
  console.log(`[ROOM] ${roomCode} deleted (empty)`);
}

let seedWarned = false;

// Dev/harness determinism hook (ARCHITECTURE §0.7). Refused in production so a
// misconfigured deploy can never hand every room the same deck.
function seedFromEnv(env = process.env) {
  const raw = env.CHUD_SEED;
  if (raw === undefined || raw === null || raw === '') return null;
  if (env.NODE_ENV === 'production') {
    if (!seedWarned) {
      seedWarned = true;
      console.warn('[SEED] CHUD_SEED is ignored in production');
    }
    return null;
  }
  return String(raw);
}

// A clock of 0 means "no clock". That is fine when exactly one human is at the table
// (Quick Play, solo-vs-bots) — only that player can stall, and only their own game suffers;
// if their socket dies the heartbeat reaps it and a bot takes the seat over.
// With two or more humans a 0 clock is a griefing tool: one player can freeze the table for
// everyone with no recovery path at all. Those rooms get a floor instead.
const MIN_HUMAN_TURN_TIMEOUT = 30;
const MIN_HUMAN_RESPONSE_TIMEOUT = 15;

/* ── Match clocks ────────────────────────────────────────────────────── */
// Owner directive: EVERY match answers a charge on a clock — Quick Play, solo-vs-bots and
// lobby games alike. 45s is the default everywhere a room is created; the lobby's REPLY
// select overrides it and whatever the host picks is what arms.
//
// These two and the floors above never fight: 45 > MIN_HUMAN_RESPONSE_TIMEOUT and
// 60 > MIN_HUMAN_TURN_TIMEOUT, so the floors only ever bite on a host who deliberately
// picks OFF or something very short on a table with two or more humans.
const DEFAULT_TURN_TIMEOUT = 60;
const DEFAULT_RESPONSE_TIMEOUT = 45;
const MAX_TURN_TIMEOUT = 300;
const MAX_RESPONSE_TIMEOUT = 120;

// `undefined`/`null` means "the host did not say" => the default. An explicit 0 means OFF
// and is honoured. The old code was `Math.max(0, Math.min(max, Number(v) || 0))`, which
// collapsed "unspecified" and "off" into the same 0 — that is why omitting the field gave a
// room no answer clock at all instead of the default.
function clampSeconds(value, max, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(max, Math.trunc(n)));
}

/* ── Egress cooldowns ────────────────────────────────────────────────── */
// Everything below is a command whose REPLY is far larger than the request, so the frame
// rate limit in server.js (40 per 5s) is not a bound on bytes leaving the process.
const CHAT_HISTORY_COOLDOWN_MS = Math.max(0, Number(process.env.CHUD_HISTORY_COOLDOWN_MS) || 5000);
const GLOBAL_CHAT_COOLDOWN_MS = Math.max(0, Number(process.env.CHUD_GLOBAL_CHAT_MS) || 3000);
const EMOTE_COOLDOWN_MS = Math.max(0, Number(process.env.CHUD_EMOTE_MS) || 1000);
// A history refill is a page, not the whole ring.
const CHAT_PAGE = 20;
// `set_rules` is a 60-byte request that fans a full room state to every seat, so it belongs
// in the same family. It is NOT dropped like chat_history though: dropping it would leave
// the picker and the launch disagreeing, which is the whole defect it exists to fix. The
// ruleset is therefore ALWAYS stored, and only the BROADCAST is coalesced — leading edge
// immediately, then at most one trailing broadcast per window carrying the final value. A
// host dragging a select produces one fan-out per window instead of one per keystroke.
const SET_RULES_COOLDOWN_MS = Math.max(0, Number(process.env.CHUD_SET_RULES_MS) || 250);

/* ── Lobby ruleset ───────────────────────────────────────────────────── */

// The seven fields `set_rules` and `start_game` share. Kept as a list so "did the host say
// anything about the rules?" is one question with one answer in both places.
// `suddenDeath` was the seventh only on paper until 2026-08-08: protocol.js validated it
// and game.js resolved it, but this list omitted it, so pickRuleOpts dropped it on the
// floor and neither command could ever turn it on (probe-rules-wire: requested 'oneLap',
// launched 'off'). Exported alongside pickRuleOpts so test/rules-wire.test.js can pin the
// client's send-side key list to this one — a drift in either fails the suite.
const RULE_FIELDS = ['preset', 'winRule', 'setsToWin', 'pureSetRequired', 'counterCostsPlay', 'passGoRestartsTurn', 'suddenDeath', 'deck'];

function pickRuleOpts(msg) {
  const opts = {};
  for (const key of RULE_FIELDS) if (msg[key] !== undefined) opts[key] = msg[key];
  return opts;
}

function sameRules(a, b) {
  if (!a || !b) return false;
  return a.preset === b.preset && a.winRule === b.winRule && a.setsToWin === b.setsToWin
    && a.pureSetRequired === b.pureSetRequired && a.counterCostsPlay === b.counterCostsPlay
    && a.passGoRestartsTurn === b.passGoRestartsTurn
    && a.suddenDeath === b.suddenDeath
    // Reference equality is wrong for the deck and would make every set_rules look like a
    // change, defeating the coalescer above and fanning a full room state per keystroke.
    && G.sameDeck(a.deck, b.deck);
}

// Leading-edge broadcast, then one coalesced trailing broadcast per window. The trailing
// timer is unref'd and re-checks that the room is still registered, so a room reaped inside
// the window can never be resurrected or hold the process open.
function broadcastRulesChange(room) {
  const now = Date.now();
  const since = now - (room._rulesBroadcastAt || 0);
  if (since >= SET_RULES_COOLDOWN_MS) {
    room._rulesBroadcastAt = now;
    broadcast.broadcastRoom(room);
    return;
  }
  if (room._rulesBroadcastTimer) return;      // a trailing broadcast is already queued
  room._rulesBroadcastTimer = setTimeout(() => {
    room._rulesBroadcastTimer = null;
    if (rooms.get(room.code) !== room) return;
    room._rulesBroadcastAt = Date.now();
    broadcast.broadcastRoom(room);
  }, SET_RULES_COOLDOWN_MS - since);
  room._rulesBroadcastTimer.unref?.();
}

function startRoomGame(room, turnTimeout, responseTimeout, ruleOpts) {
  // Unconditional, and BEFORE the new state exists. This used to arm the turn timer only
  // when turnTimeout > 0, so restarting a table with a 0 clock left the OLD timer armed
  // against the NEW state: syncTimers saw a truthy turnTimerId, declined to re-arm, and a
  // spurious timeout fired against a game it knew nothing about.
  timers.clearTurnTimer(room);
  room.phase = 'playing';
  // Room ruleset, chosen in the lobby next to the timers. A preset supplies the base and
  // any individual toggle overrides it; resolution happens HERE, server-side, so a preset
  // is never a client-side illusion. Sticky across rematches (ruleOpts undefined = keep).
  room.rules = ruleOpts === undefined
    ? (room.rules || G.resolveRules({}))
    : G.resolveRules(ruleOpts);
  room.winRule = room.rules.winRule;   // legacy field, kept in sync
  // The lobby's PENDING ruleset is re-pointed at what actually launched, so the field the
  // broadcast carries (pendingRules || rules) is the live ruleset for the rest of the
  // room's life — including every rematch, which keeps room.rules and so keeps this too.
  // Without it a start_game that overrode the picker would leave a stale pendingRules
  // shadowing the real rules on the wire.
  room.pendingRules = room.rules;
  if (room._rulesBroadcastTimer) { clearTimeout(room._rulesBroadcastTimer); room._rulesBroadcastTimer = null; }
  room.turnTimeout = clampSeconds(turnTimeout, MAX_TURN_TIMEOUT, DEFAULT_TURN_TIMEOUT);
  room.responseTimeout = clampSeconds(responseTimeout, MAX_RESPONSE_TIMEOUT, DEFAULT_RESPONSE_TIMEOUT);
  const humans = room.players.filter(p => !p.isBot).length;
  if (humans > 1) {
    if (room.turnTimeout < MIN_HUMAN_TURN_TIMEOUT) room.turnTimeout = MIN_HUMAN_TURN_TIMEOUT;
    if (room.responseTimeout < MIN_HUMAN_RESPONSE_TIMEOUT) room.responseTimeout = MIN_HUMAN_RESPONSE_TIMEOUT;
  }
  room.gameCount = (room.gameCount || 0) + 1;
  const seedBase = seedFromEnv();
  const options = { ...room.rules };
  if (seedBase !== null) options.seed = `${seedBase}#${room.gameCount}`;
  // Every real table shuffles seats (owner directive) — quick play included,
  // where the host otherwise always sat first and always carried the measured
  // ~24.5% first-player advantage into their own stats and the game log.
  // CHUD_NO_SEAT_SHUFFLE=1 is a TEST hook only: touchtest's drag-play section
  // measures gesture mechanics (does real touch reach the client past
  // touch-action) and needs the local seat on turn deterministically, which a
  // 1-in-4 shuffle denies within its wait budget. Never set in production.
  options.shuffleSeats = process.env.CHUD_NO_SEAT_SHUFFLE !== '1';
  room.state = G.createGame(room.players.map(p => ({ id: p.id, name: p.name })), options);
  if (room.turnTimeout > 0) timers.startTurnTimer(room);
  armBotWatchdog(room);
  broadcast.broadcastAndScheduleBot(room);
}

function handleMessage(ws, msg, state) {
  const playerId = state.playerId;
  const roomCode = state.roomCode;

  switch (msg.type) {

    case 'create_room': {
      if (state.playerId) { broadcast.send(ws, { type: 'error', message: 'Already joined to a room' }); break; }
      const code = genCode();
      state.playerId = genId();
      state.roomCode = code;
      const player = { id: state.playerId, resumeToken: genResumeToken(), name: msg.name, ws };
      // The clocks are seeded at creation, not at start_game, so the LOBBY broadcast already
      // says what this table will run on and the REPLY select can show the real default.
      // Same reasoning for the RULESET: seeded at creation so the first lobby broadcast
      // already tells every seat — host or not — which ruleset this table plays if nobody
      // touches the picker. `set_rules` replaces it; start_game launches whatever it holds.
      const room = { code, phase: 'lobby', hostId: state.playerId, players: [player], state: null, chat: [],
        turnTimeout: DEFAULT_TURN_TIMEOUT, responseTimeout: DEFAULT_RESPONSE_TIMEOUT,
        pendingRules: G.resolveRules({}),
        // Opt-in, DEFAULT OFF (owner directive 2026-08-07): only `public: true`
        // — validated strictly boolean in protocol.js — puts this room's code
        // in GET /api/public-rooms (server.js). A private room's code never
        // leaves the people the host gave it to; test/public-rooms.test.js
        // pins the absence.
        public: msg.public === true };
      rooms.set(code, room);
      sendJoined(ws, room, player);
      broadcast.send(ws, { type: 'chat_history', scope: 'global', msgs: globalChat.slice(-CHAT_MAX) });
      broadcast.broadcastRoom(room);
      console.log(`[ROOM] ${code} created by ${player.name}${room.public ? ' (public)' : ''}`);
      break;
    }

    case 'quick_play': {
      if (state.playerId) { broadcast.send(ws, { type: 'error', message: 'Already joined to a room' }); break; }
      const code = genCode();
      state.playerId = genId();
      state.roomCode = code;
      const player = { id: state.playerId, resumeToken: genResumeToken(), name: msg.name, ws };
      const room = { code, phase: 'lobby', hostId: player.id, players: [player], state: null, chat: [],
        turnTimeout: 0, responseTimeout: DEFAULT_RESPONSE_TIMEOUT };
      // THREE bots, not two — OWNER RULING 2026-08-07 ("change default to 4 then"), and the
      // measurement that produced the question is the reason the ruling is right.
      //
      // Quick Play seated two bots, so the configuration the owner actually played was a
      // 3-player table — the one configuration BOT-STRATEGY.md's matrices never covered
      // (every seat × every 4-subset, with 5 players only for the cost analysis). So every
      // number this project quotes described a table nobody was sitting at. Measured, 4000
      // games per bench, seat 0 held by `neutral` as a stand-in for a competent human:
      //
      //   bench                              seat0 win   avg turns  p90  SD  shot down  contested
      //   neutral+aggressive        (3p, old)    31.9%       24.8    33  6.5     19.5%      8.0%
      //   neutral+aggressive+conservative (4p)   21.5%       32.4    47 13.0     47.5%     19.7%
      //
      // Three players is not merely a shorter game, it is a thinner one. FINAL APPROACH —
      // the mechanic the whole win rule is built around — barely functions: four of every
      // five approaches simply convert, against slightly better than half at four seats.
      // And the turn count is nearly CONSTANT (SD 6.5, median 25, p10 17, p90 33), which is
      // exactly the owner's "right now every game is 20-25ish points": that number is the
      // TURN COUNTER, not net worth, which sits at a median of 9M. Four seats doubles the
      // spread (SD 13.0, median 30, p10 20, p90 46).
      //
      // WHY `conservative` FOR THE THIRD SEAT. It builds where `aggressive` attacks and
      // `neutral` balances, so the bench is three different opponents rather than two plus a
      // duplicate — and it measured best on the axis that matters: highest shot-down rate
      // (47.5% vs 43.9% seating `chud`, 42.4% seating `random`) and the most contested
      // approaches (19.7%). `random` also makes the table measurably easier (seat 0 wins
      // 26.8%). Personalities stay unlabelled in-game per the owner's standing constraint;
      // this chooses the bench, it does not announce it.
      //
      // DOUBLE `aggressive`, DROP `neutral` — OWNER DIRECTIVE 2026-08-20 ("somewhat harder
      // bots", solo human target 30-40%), measured in docs/harder-bots-study.md. Production
      // truth: humans won 46.2% of 104 solo games against the old bench, and per-seat,
      // aggressive is the ONLY near-fair-share bot against real players (26-28% of its
      // games) while neutral is the weakest (10.7% in round 12b's paired tables). Priced
      // with tools/benchstudy.mjs (the §3.12 human-proxy instrument, seat-rotated, 6,000
      // games per bench, paired decks): this bench cuts the proxy's win 22.9% -> 19.7%,
      // projecting the real-human solo rate to ~39.8% — the top edge of the target band —
      // while IMPROVING the round-7 axes above: shot-down 50.7% vs 48.0%, contested 22.7%
      // vs 22.2%, avg turns +0.6. Composition saturates here: even 3x aggressive only
      // projects 38.5%, at the cost of a monotone table, and every parameter dial priced
      // at real production states is worth ~+1pp per seat (docs/harder-bots-study.md) —
      // reaching the band's lower half needs new bot capability, not seating.
      for (const mode of ['aggressive', 'aggressive', 'conservative']) {
        room.players.push({ id: genId(), name: absent.generateBotName(room), ws: null, isBot: true, botMode: mode });
      }
      rooms.set(code, room);
      sendJoined(ws, room, player);
      broadcast.send(ws, { type: 'chat_history', scope: 'global', msgs: globalChat.slice(-CHAT_MAX) });
      // Turn clock 0 by design: still exactly ONE human at the table after the fourth seat
      // was added (the three new seats are all bots), so only that player can stall and only
      // their own game suffers — the reasoning is unchanged by the seat count, and was
      // re-checked rather than assumed when it changed. The ANSWER clock is not optional
      // though — the third argument is omitted so Quick Play takes the same 45s default
      // every other match gets, and a bot's charge is answered on a deadline like anyone
      // else's.
      startRoomGame(room, 0);
      console.log(`[GAME] ${code} quick play started for ${player.name} `
        + `(response clock ${room.responseTimeout}s)`);
      break;
    }

    case 'join_room': {
      if (state.playerId) { broadcast.send(ws, { type: 'error', message: 'Already joined to a room' }); break; }
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { broadcast.send(ws, { type: 'error', message: 'Room not found' }); break; }
      // Reclaiming a seat you hold the private token for is tried FIRST, in every phase.
      // It used to be reachable only while room.phase !== 'lobby', which was harmless while
      // a room never left 'playing' — but a room that correctly returns to the lobby when
      // its game ends would then answer a legitimate reconnect with "That call sign is
      // already in use", because the seat is still on the roster. Same credential gate, same
      // refusals; only the order changed.
      const dc = findClaimableSeat(room, msg.playerId, msg.resumeToken);
      if (!dc && room.phase !== 'lobby') {
        broadcast.send(ws, { type: 'error', message: 'Game in progress. This browser does not have the private resume key for that seat.' });
        break;
      }
      if (dc) {
        if (dc.ws?.readyState === 1) { broadcast.send(ws, { type: 'error', message: 'That player is already connected' }); break; }
        dc.ws = ws;
        reclaimFromBot(room, dc, code, 'rejoin');
        state.playerId = dc.id;
        state.roomCode = code;
        sendJoined(ws, room, dc);
        broadcast.send(ws, { type: 'chat_history', scope: 'global', msgs: globalChat.slice(-CHAT_MAX) });
        if (room.chat.length) broadcast.send(ws, { type: 'chat_history', scope: 'room', msgs: room.chat.slice(-CHAT_MAX) });
        // …AndScheduleBot, not broadcastRoom: reclaimFromBot above may have just
        // cancelled the room's ONE bot timeout. See its header.
        broadcast.broadcastAndScheduleBot(room);
        console.log(`[ROOM] ${code} ~${dc.name} rejoined game`);
        break;
      }
      if (room.players.length >= 5) { broadcast.send(ws, { type: 'error', message: 'Room is full (max 5)' }); break; }
      if (room.players.some(p => p.name.toLowerCase() === msg.name.toLowerCase())) {
        broadcast.send(ws, { type: 'error', message: 'That call sign is already in use' }); break;
      }
      state.playerId = genId();
      state.roomCode = code;
      const name = msg.name;
      const player = { id: state.playerId, resumeToken: genResumeToken(), name, ws };
      room.players.push(player);
      sendJoined(ws, room, player);
      broadcast.send(ws, { type: 'chat_history', scope: 'global', msgs: globalChat.slice(-CHAT_MAX) });
      if (room.chat.length) broadcast.send(ws, { type: 'chat_history', scope: 'room', msgs: room.chat.slice(-CHAT_MAX) });
      broadcast.broadcastRoom(room);
      console.log(`[ROOM] ${code} +${name} (${room.players.length} players)`);
      break;
    }

    case 'reconnect': {
      if (state.playerId) { broadcast.send(ws, { type: 'error', message: 'Already joined to a room' }); break; }
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { broadcast.send(ws, { type: 'error', message: 'Room not found' }); break; }
      // Same single gate as join_room: a public UUID is not a credential, and a bot seat
      // nobody has ever sat in is not claimable at any price.
      const p = findClaimableSeat(room, msg.playerId, msg.resumeToken);
      if (!p) { broadcast.send(ws, { type: 'error', message: 'Invalid resume credentials' }); break; }
      if (p.ws?.readyState === 1) { broadcast.send(ws, { type: 'error', message: 'That player is already connected' }); break; }
      p.ws = ws;
      reclaimFromBot(room, p, code, 'reconnect');
      state.playerId = p.id;
      state.roomCode = code;
      sendJoined(ws, room, p);
      broadcast.send(ws, { type: 'chat_history', scope: 'global', msgs: globalChat.slice(-CHAT_MAX) });
      if (room.chat.length) broadcast.send(ws, { type: 'chat_history', scope: 'room', msgs: room.chat.slice(-CHAT_MAX) });
      // …AndScheduleBot, not broadcastRoom: reclaimFromBot above may have just
      // cancelled the room's ONE bot timeout. See its header.
      broadcast.broadcastAndScheduleBot(room);
      console.log(`[ROOM] ${code} ~${p.name} reconnected`);
      break;
    }

    case 'kick': {
      const room = rooms.get(roomCode);
      if (!room || room.hostId !== playerId) { broadcast.send(ws, { type: 'error', message: 'Only host can kick' }); break; }
      if (room.phase !== 'lobby') { broadcast.send(ws, { type: 'error', message: 'Cannot kick during a game' }); break; }
      const target = room.players.find(x => x.id === msg.targetId);
      if (!target) break;
      if (target.id === playerId) { broadcast.send(ws, { type: 'error', message: 'Cannot kick yourself' }); break; }
      if (target.ws) { broadcast.send(target.ws, { type: 'kicked' }); try { target.ws.close(); } catch {} }
      room.players = room.players.filter(x => x.id !== msg.targetId);
      broadcast.broadcastRoom(room);
      console.log(`[ROOM] ${roomCode} host kicked ${target.name}`);
      break;
    }

    case 'add_bot': {
      const room = rooms.get(roomCode);
      if (!room || room.hostId !== playerId) { broadcast.send(ws, { type: 'error', message: 'Only host can add bots' }); break; }
      if (room.phase !== 'lobby') { broadcast.send(ws, { type: 'error', message: 'Cannot add bots during a game' }); break; }
      if (room.players.length >= 5) { broadcast.send(ws, { type: 'error', message: 'Room is full (max 5)' }); break; }
      const mode = ['random', 'conservative', 'neutral', 'aggressive', 'chud'].includes(msg.mode) ? msg.mode : 'neutral';
      const botId = genId();
      const botName = absent.generateBotName(room);
      const bot = { id: botId, name: botName, ws: null, isBot: true, botMode: mode };
      room.players.push(bot);
      broadcast.broadcastRoom(room);
      console.log(`[ROOM] ${roomCode} +BOT ${botName} [${mode}] (${room.players.length} players)`);
      break;
    }

    case 'remove_bot': {
      const room = rooms.get(roomCode);
      if (!room || room.hostId !== playerId) { broadcast.send(ws, { type: 'error', message: 'Only host can remove bots' }); break; }
      if (room.phase !== 'lobby') { broadcast.send(ws, { type: 'error', message: 'Cannot remove bots during a game' }); break; }
      const target = room.players.find(x => x.id === msg.targetId && x.isBot);
      if (!target) break;
      room.players = room.players.filter(x => x.id !== msg.targetId);
      broadcast.broadcastRoom(room);
      console.log(`[ROOM] ${roomCode} -BOT ${target.name}`);
      break;
    }

    case 'leave_room': {
      const room = rooms.get(roomCode);
      if (!room) break;
      const lp = room.players.find(x => x.id === playerId);
      if (!lp) break;
      const wasHost = room.hostId === playerId;

      if (room.phase === 'playing') {
        lp.ws = null;
        lp.isBot = true;
        lp._wasHuman = true;
        lp.botMode = ['conservative', 'neutral', 'aggressive'][Math.floor(Math.random() * 3)];
        console.log(`[BOT] ${roomCode} bot took over for ${lp.name} [${lp.botMode}]`);
        if (wasHost) broadcast.transferHost(room);
        absent.handleAbsent(room);
        broadcast.broadcastAndScheduleBot(room);
        // The seat this socket is abandoning is the last thing tying the room to a live
        // connection. state.roomCode is nulled below, so handleClose will bail out and this
        // is the only chance to arm the reaper — without it the room was immortal.
        scheduleRoomReap(roomCode);
      } else {
        room.players = room.players.filter(x => x.id !== playerId);
        console.log(`[ROOM] ${roomCode} -${lp.name} left`);
        if (room.players.length === 0 || room.players.every(x => x.isBot)) {
          // Without this the re-arming turn timer kept driving the deleted room forever:
          // measured 3 further turns in 4s on a 1s clock, and the state object never freed.
          deleteRoom(roomCode, room);
        } else {
          if (wasHost) broadcast.transferHost(room);
          broadcast.broadcastRoom(room);
        }
      }
      state.playerId = null;
      state.roomCode = null;
      break;
    }

    // The lobby's rules picker was host-only BY NECESSITY, not by design: broadcastRoom had
    // no field that could carry a ruleset before a game existed, so every non-host saw
    // "the host is choosing" and could not tell what they were about to play. This is the
    // one command that fixes that — it changes nothing about the game, it only publishes
    // the host's choice to the whole room ahead of start_game.
    case 'set_rules': {
      const room = rooms.get(roomCode);
      // Host-only, same shape as kick/add_bot/start_game — and REFUSED, not silently
      // ignored, so a client that has lost the host badge learns it immediately instead of
      // showing a ruleset the room will never play.
      if (!room || room.hostId !== playerId) {
        broadcast.send(ws, { type: 'error', message: 'Only host can change the rules' });
        break;
      }
      // Refused only while a game is actually LIVE — the ruleset of a table in play is
      // fixed. `room.phase` returns to 'lobby' the moment a game finishes (see
      // server/broadcast.js), so the picker, the bot buttons and kick all come back for the
      // next game instead of the room being frozen at its first ruleset for life.
      if (room.phase !== 'lobby') {
        broadcast.send(ws, { type: 'error', message: 'Cannot change the rules during a game' });
        break;
      }
      const next = G.resolveRules(pickRuleOpts(msg));
      // A no-op costs nothing at all: re-sending the ruleset the room already has fans
      // nothing out. This is what makes a client that echoes its selects on every render
      // harmless.
      if (sameRules(room.pendingRules, next)) break;
      room.pendingRules = next;
      broadcastRulesChange(room);
      break;
    }

    case 'start_game': {
      const room = rooms.get(roomCode);
      if (!room || room.hostId !== playerId) { broadcast.send(ws, { type: 'error', message: 'Only host can start' }); break; }
      // `rematch` has always guarded on phase; this had NO guard at all, so the host could
      // wipe a live game at any instant and swap the whole ruleset under everyone
      // (measured: turn 3, boards [2,1] -> turn 0, boards [0,0], winRule replaced).
      // Restarting a finished table is what `rematch` is for.
      if (room.phase !== 'lobby') {
        broadcast.send(ws, { type: 'error', message: 'A game is already under way in this room' });
        break;
      }
      if (room.players.length < 2) { broadcast.send(ws, { type: 'error', message: 'Need at least 2 players' }); break; }
      // If the message says ANYTHING about the rules it is authoritative in full — exactly
      // today's behaviour, so a client that never sends set_rules is unaffected. If it says
      // nothing, the ruleset the lobby has been showing every seat is what launches, so the
      // picker and the launch cannot disagree. resolveRules is idempotent on its own output
      // (a 'custom' preset falls back to the default base and all four toggles override it),
      // so replaying pendingRules through it yields the identical ruleset.
      const said = RULE_FIELDS.some(key => msg[key] !== undefined);
      const ruleOpts = said ? pickRuleOpts(msg) : (room.pendingRules ? { ...room.pendingRules } : {});
      startRoomGame(room, msg.turnTimeout, msg.responseTimeout, ruleOpts);
      console.log(`[GAME] ${roomCode} started with ${room.players.length} players, timeout=${room.turnTimeout}s, responseTimeout=${room.responseTimeout}s, rules=${JSON.stringify(room.rules)}`);
      break;
    }

    case 'rematch': {
      const room = rooms.get(roomCode);
      if (!room || room.hostId !== playerId) { broadcast.send(ws, { type: 'error', message: 'Only host can start a rematch' }); break; }
      if (room.state?.phase !== 'finished') { broadcast.send(ws, { type: 'error', message: 'Current game is not finished' }); break; }
      timers.clearTurnTimer(room);
      // Sticky by default and re-pickable on purpose. startRoomGame re-points pendingRules
      // at whatever launched, so pendingRules === rules unless the host has actually chosen
      // something else since the game ended — which they now can, because the room is back
      // in a configurable state. Passing it makes Rematch honour that choice instead of
      // silently replaying the old ruleset under a picker that says otherwise.
      startRoomGame(room, room.turnTimeout, room.responseTimeout,
        room.pendingRules ? { ...room.pendingRules } : undefined);
      console.log(`[GAME] ${roomCode} rematch started`);
      break;
    }

    case 'draw': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      // The draw is automatic at turn start (game.js beginTurn), so this command only ever
      // arrives from an old client or a reconnect race. It is accepted and treated as a
      // silent no-op — never an error, never a second draw. Turn/phase/pending guards live
      // inside G.drawCards so no caller can orphan a pendingAction by forcing 'play'.
      const drawRes = G.drawCards(room.state, playerId);
      if (drawRes.alreadyDrawn) break;
      if (drawRes.error) { broadcast.send(ws, { type: 'error', message: drawRes.error }); break; }
      if (drawRes.autoWin) timers.clearTurnTimer(room);
      broadcast.broadcastAndScheduleBot(room);
      break;
    }

    case 'play_money': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      const res = G.playAsMoney(room.state, playerId, msg.cardIndex);
      if (res.error) { broadcast.send(ws, { type: 'error', message: res.error }); break; }
      broadcast.broadcastAndScheduleBot(room);
      break;
    }

    case 'play_property': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      const res = G.playProperty(room.state, playerId, msg.cardIndex, msg.targetColor);
      if (res.error) { broadcast.send(ws, { type: 'error', message: res.error }); break; }
      broadcast.broadcastAndScheduleBot(room);
      break;
    }

    case 'move_property': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      const res = G.moveProperty(room.state, playerId, msg.cardId, msg.toColor);
      if (res.error) { broadcast.send(ws, { type: 'error', message: res.error }); break; }
      broadcast.broadcastAndScheduleBot(room);
      break;
    }

    // §3.5's atomic two-card exchange. Same discipline as its neighbour above:
    // the engine is the only thing that decides, an illegal request costs one
    // error frame and NO rebroadcast, and a legal one fans out exactly one state.
    // The seat is the SOCKET's `playerId`, never the message's.
    case 'swap_property': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      const res = G.swapProperties(room.state, playerId, msg.cardId, msg.withCardId);
      if (res.error) { broadcast.send(ws, { type: 'error', message: res.error }); break; }
      broadcast.broadcastAndScheduleBot(room);
      break;
    }

    case 'play_action': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      const res = G.playAction(room.state, playerId, msg.cardIndex, {
        targetId: msg.targetId,
        targetColor: msg.targetColor,
        targetCardId: msg.targetCardId,
        myCardId: msg.myCardId,
      });
      if (res.error) { broadcast.send(ws, { type: 'error', message: res.error }); break; }
      if (room.state.pendingAction) {
        if (room.turnTimerId) { clearTimeout(room.turnTimerId); room.turnTimerId = null; }
        room.turnStartedAt = null;
        timers.startResponseTimer(room);
      }
      broadcast.broadcastAndScheduleBot(room);
      break;
    }

    case 'respond': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      const res = G.respondToAction(room.state, playerId, msg.response, msg.paymentCards);
      // The missing `break` here fell through to startResponseTimer below: any bystander
      // spamming `respond` pushed the only deadline protecting a stalled table back
      // indefinitely (measured +14.3s over 70 messages) and fanned a 22.3KB state to every
      // seat per junk message (~0.87MB/s from one socket, inside the rate limit).
      if (res.error) {
        broadcast.send(ws, { type: 'error', message: res.error });
        if (res.needPayment) broadcast.send(ws, { type: 'need_payment', amount: res.amount });
        break;
      }
      if (res.needPayment) { broadcast.send(ws, { type: 'need_payment', amount: res.amount }); break; }
      if (!room.state.pendingAction) {
        timers.clearResponseTimer(room);
        timers.startTurnTimer(room);
      } else {
        timers.startResponseTimer(room);
      }
      broadcast.broadcastAndScheduleBot(room);
      break;
    }

    case 'emote': {
      const room = rooms.get(roomCode);
      if (!room) break;
      const emotePlayer = room.players.find(x => x.id === playerId);
      if (!emotePlayer) break;
      // Emotes fan out to every seat and had no cooldown at all (8/s x room fan-out).
      // Dropped silently rather than answered with an error: an error reply is itself
      // egress, and a spammer would only be trading one fan-out for another.
      const emoteNow = Date.now();
      if (state.lastEmoteAt && emoteNow - state.lastEmoteAt < EMOTE_COOLDOWN_MS) break;
      state.lastEmoteAt = emoteNow;
      const text = (msg.text || '').slice(0, 30);
      room.players.forEach(p => {
        if (p.ws?.readyState === 1) {
          p.ws.send(JSON.stringify({ type: 'emote', playerId, name: emotePlayer.name, text }));
        }
      });
      break;
    }

    case 'chat': {
      if (!playerId) break;
      const now = Date.now();
      if (state.lastChatAt && now - state.lastChatAt < 500) {
        broadcast.send(ws, { type: 'error', message: 'Please slow down' });
        break;
      }
      state.lastChatAt = now;
      const text = (msg.text || '').slice(0, 500);
      if (!text) break;
      const scope = msg.scope === 'global' ? 'global' : 'room';
      // Global chat crosses every room boundary and fans to wss.clients — one 520-byte
      // message reached 400 sockets for 254,000 B (x489). The room cooldown above is far
      // too loose for that, so global gets its own, much slower one.
      if (scope === 'global') {
        if (state.lastGlobalChatAt && now - state.lastGlobalChatAt < GLOBAL_CHAT_COOLDOWN_MS) {
          broadcast.send(ws, { type: 'error', message: 'Please slow down' });
          break;
        }
        state.lastGlobalChatAt = now;
      }
      const room = rooms.get(roomCode);
      const cp = room?.players.find(x => x.id === playerId);
      const name = cp?.name || 'Anon';
      const entry = { id: ++chatIdRef.value, ts: Date.now(), pid: playerId, name, text, scope };
      if (scope === 'global') {
        globalChat.push(entry);
        if (globalChat.length > CHAT_MAX) globalChat.shift();
        wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'chat', msg: entry })); });
      } else {
        if (!room) break;
        room.chat.push(entry);
        if (room.chat.length > CHAT_MAX) room.chat.shift();
        room.players.forEach(rp => {
          if (rp.ws?.readyState === 1) rp.ws.send(JSON.stringify({ type: 'chat', msg: entry }));
        });
      }
      break;
    }

    case 'chat_history': {
      // The single worst amplifier on the wire: an untouched socket — no room, no name, no
      // auth of any kind — got 30,790 B back for a 30 B request, and could repeat it at the
      // frame limit for ~240 KB/s per socket. Three gates now:
      //   * the socket must actually hold a seat (an anonymous socket gets nothing at all);
      //   * one refill per COOLDOWN, dropped silently so the refusal costs no egress;
      //   * a page of CHAT_PAGE, not the whole ring.
      if (!playerId) break;
      const historyNow = Date.now();
      if (state.lastHistoryAt && historyNow - state.lastHistoryAt < CHAT_HISTORY_COOLDOWN_MS) break;
      state.lastHistoryAt = historyNow;
      const room = rooms.get(roomCode);
      broadcast.send(ws, { type: 'chat_history', scope: 'global', msgs: globalChat.slice(-CHAT_PAGE) });
      if (room) broadcast.send(ws, { type: 'chat_history', scope: 'room', msgs: room.chat.slice(-CHAT_PAGE) });
      break;
    }

    case 'scoop': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      const res = G.scoop(room.state, playerId);
      if (res.error) { broadcast.send(ws, { type: 'error', message: res.error }); break; }
      if (room.state.phase === 'finished') timers.clearTurnTimer(room);
      else timers.startTurnTimer(room);
      broadcast.broadcastAndScheduleBot(room);
      break;
    }

    case 'end_turn': {
      const room = rooms.get(roomCode);
      if (!room?.state) break;
      const res = G.endTurn(room.state, playerId, msg.discardIds);
      if (res.error) {
        broadcast.send(ws, { type: 'error', message: res.error, needDiscard: res.needDiscard, excess: res.excess });
        break;
      }
      timers.startTurnTimer(room);
      broadcast.broadcastAndScheduleBot(room);
      break;
    }
  }
}

function handleClose(state, ws) {
  const { playerId, roomCode } = state;
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;
  const p = room.players.find(x => x.id === playerId);
  // A stale socket's late close event used to null out the seat's CURRENT socket and hand
  // the seat to a bot, undoing a reconnect that had already succeeded. Only the socket that
  // still owns the seat may tear it down.
  if (p && ws !== undefined && p.ws !== ws) return;
  if (p) {
    p.ws = null;
    if (room.phase === 'playing' && !p.isBot) {
      p.isBot = true;
      p._wasHuman = true;
      p.botMode = ['conservative', 'neutral', 'aggressive'][Math.floor(Math.random() * 3)];
      console.log(`[BOT] ${roomCode} bot took over for ${p.name} [${p.botMode}]`);
    }
  }
  console.log(`[ROOM] ${roomCode} -${p?.name || '?'} disconnected`);
  if (playerId === room.hostId) broadcast.transferHost(room);
  absent.handleAbsent(room);
  scheduleRoomReap(roomCode);
  broadcast.broadcastAndScheduleBot(room);
}

// RULE_FIELDS/pickRuleOpts are exported for test/rules-wire.test.js, which pins the
// client's send-side key list (public/src/net/send.js RULE_WIRE_KEYS) to this one.
module.exports = { init, handleMessage, handleClose, seedFromEnv, RULE_FIELDS, pickRuleOpts };
