// test/server-authority.test.js — who is allowed to occupy a seat, who is allowed to
// restart a table, and what a room/socket costs the process.
//
// Every test here is a regression for a defect that a green `npm test` used to sail past,
// because nothing in the suite asserted seat authority over a real socket, and nothing
// asserted room-count or socket-count at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const port = 35000 + (process.pid % 900);
const url = `ws://127.0.0.1:${port}`;
const httpUrl = `http://127.0.0.1:${port}`;

// The reaper is 30s in production; driven at 1.2s here so an abandoned room is provably
// collected inside a normal test timeout instead of half a minute later.
const REAP_MS = 1200;
// The per-IP cap is 100 in production. Every socket in this file comes from 127.0.0.1, so
// it is lowered to something a test can actually reach.
const MAX_SOCKETS_PER_IP = 16;

let serverProcess;
let serverOutput = '';
const clients = new Set();

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server start timeout')), 8000);
    serverProcess.stdout.on('data', data => {
      serverOutput += String(data);
      if (serverOutput.includes('Server running')) { clearTimeout(timeout); resolve(); }
    });
    serverProcess.stderr.on('data', d => { serverOutput += String(d); });
    serverProcess.once('exit', code => reject(new Error(`server exited early (${code})`)));
  });
}

function openClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws._messages = [];
    ws._closeCode = null;
    ws.on('message', raw => { try { ws._messages.push(JSON.parse(raw)); } catch {} });
    ws.on('error', () => {});
    ws.on('close', code => { ws._closeCode = code; });
    ws.once('open', () => { clients.add(ws); resolve(ws); });
    ws.once('error', reject);
  });
}

const send = (ws, msg) => ws.send(JSON.stringify(msg));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shut = (...sockets) => { for (const ws of sockets) { try { ws.close(); } catch {} clients.delete(ws); } };

async function waitFor(ws, predicate, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = ws._messages.find(predicate);
    if (hit) return hit;
    await sleep(15);
  }
  return null;
}

async function health() {
  const res = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(2000) });
  return res.json();
}

// Rooms abandoned by earlier tests are still inside their own reap window, so a raw
// health().rooms is not a baseline. Wait for the count to stop falling first.
async function settledRooms() {
  let last = (await health()).rooms;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const now = (await health()).rooms;
    if (now === last && i >= 4) return now;
    last = now;
  }
  return last;
}

const lastState = ws => [...ws._messages].reverse().find(m => m.type === 'state');

// A live table: one human host, two bots, a real game under way.
async function tableWithBots(name) {
  const host = await openClient();
  send(host, { type: 'create_room', name });
  const joined = await waitFor(host, m => m.type === 'joined');
  assert.ok(joined, 'host joined');
  send(host, { type: 'add_bot', mode: 'neutral' });
  await sleep(80);
  send(host, { type: 'add_bot', mode: 'aggressive' });
  await sleep(80);
  send(host, { type: 'start_game', turnTimeout: 60, responseTimeout: 30 });
  const state = await waitFor(host, m => m.type === 'state' && m.phase === 'playing');
  assert.ok(state, 'game started');
  const bot = state.players.find(p => p.isBot);
  assert.ok(bot, 'the room has a bot seat');
  return { host, joined, botId: bot.id };
}

test.before(async () => {
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      CHUD_GAME_LOG: '0',
      CHUD_REAP_MS: String(REAP_MS),
      CHUD_MAX_SOCKETS_PER_IP: String(MAX_SOCKETS_PER_IP),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
});

test.after(() => {
  for (const ws of clients) { try { ws.terminate(); } catch {} }
  if (serverProcess) serverProcess.kill();
});

/* ── 1. seat authority ───────────────────────────────────────────────── */
// Every seat's UUID is broadcast to every room member, so a player id is public and proves
// nothing. Bots hold no resume token, and `undefined === undefined` used to match: quoting
// a bot's UUID with NO token at all handed over the seat, its private hand, and full
// command authority over it.

test('a bot seat cannot be claimed by quoting its public id with no resume token', async () => {
  const { host, botId } = await tableWithBots('Owner');

  const attacker = await openClient();
  send(attacker, { type: 'join_room', code: lastState(host).code, name: 'Ghost', playerId: botId });

  const refusal = await waitFor(attacker, m => m.type === 'error', 2000);
  assert.ok(refusal, 'the claim is refused');
  assert.match(refusal.message, /private resume key/i);
  assert.equal(attacker._messages.find(m => m.type === 'joined'), undefined, 'no seat handed over');
  assert.equal(attacker._messages.find(m => m.type === 'state'), undefined,
    'and no game state — the seat\'s hand never leaves the server');
  shut(host, attacker);
});

test('a bot seat cannot be claimed with a well-formed but wrong token, by either door', async () => {
  const { host, botId } = await tableWithBots('Owner2');
  const code = lastState(host).code;
  const forged = 'x'.repeat(43);

  for (const attempt of [
    { type: 'join_room', code, name: 'Ghost', playerId: botId, resumeToken: forged },
    { type: 'reconnect', code, playerId: botId, resumeToken: forged },
    // A reconnect quoting the bot id and a token that is real — but belongs to another seat.
    { type: 'reconnect', code, playerId: botId, resumeToken: null },
  ]) {
    if (attempt.resumeToken === null) attempt.resumeToken = (await waitFor(host, m => m.type === 'joined')).resumeToken;
    const attacker = await openClient();
    send(attacker, attempt);
    const refusal = await waitFor(attacker, m => m.type === 'error', 2000);
    assert.ok(refusal, `${attempt.type} refused`);
    assert.equal(attacker._messages.find(m => m.type === 'joined'), undefined,
      `${attempt.type} handed over a seat`);
    shut(attacker);
  }
  shut(host);
});

test('a refused hijack leaves the bot seat a bot — it is never converted to a human seat', async () => {
  const { host, botId } = await tableWithBots('Owner3');
  const code = lastState(host).code;

  // The escalation chain: claim the seat, leave it (which marks it _wasHuman), then
  // re-claim it through the reclaim branch to end up with an uncontested human seat still
  // wearing the bot's callsign.
  for (const name of ['Ghost1', 'Ghost2']) {
    const attacker = await openClient();
    send(attacker, { type: 'join_room', code, name, playerId: botId });
    const refusal = await waitFor(attacker, m => m.type === 'error', 2000);
    assert.ok(refusal, `${name} is refused`);
    assert.equal(attacker._messages.find(m => m.type === 'joined'), undefined,
      `${name} took the seat`);
    assert.equal(attacker._messages.find(m => m.type === 'state'), undefined,
      `${name} saw the table`);
    send(attacker, { type: 'leave_room' });
    await sleep(120);
    shut(attacker);
  }

  await sleep(300);
  const seat = lastState(host).players.find(p => p.id === botId);
  assert.equal(seat.isBot, true, 'the seat is still a bot');
  assert.ok(seat.botMode, 'and still has AI driving it');
  shut(host);
});

test('the seat\'s real owner still rejoins mid-game with the token, and takes it back from the bot',
  async () => {
    const ws = await openClient();
    send(ws, { type: 'quick_play', name: 'Owner4' });
    const joined = await waitFor(ws, m => m.type === 'joined');
    assert.ok(await waitFor(ws, m => m.type === 'state' && m.phase === 'playing'));

    ws._socket.destroy();                          // drop out: a bot takes the seat
    await sleep(200);

    const back = await openClient();
    send(back, { type: 'join_room', code: joined.code, name: 'Owner4', playerId: joined.playerId, resumeToken: joined.resumeToken });
    const rejoined = await waitFor(back, m => m.type === 'joined');
    assert.ok(rejoined, 'the legitimate owner is let back in');
    assert.equal(rejoined.playerId, joined.playerId);

    const state = await waitFor(back, m => m.type === 'state' && m.game);
    const seat = state.players.find(p => p.id === joined.playerId);
    assert.equal(seat.isBot, false, 'and the seat is reclaimed from the bot');
    assert.ok(state.game.players.find(p => p.id === joined.playerId).hand, 'the owner sees the hand');
    send(back, { type: 'leave_room' });
    shut(ws, back);
  });

/* ── 2. start_game is a lobby command ────────────────────────────────── */

test('start_game is refused once a game is under way, and the live game is untouched', async () => {
  const { host } = await tableWithBots('Restarter');
  const before = lastState(host).game;
  assert.ok(before);

  send(host, { type: 'start_game', turnTimeout: 0, responseTimeout: 0, preset: 'blitz', setsToWin: 5 });
  const refusal = await waitFor(host, m => m.type === 'error', 2000);
  assert.ok(refusal, 'the restart is refused');
  assert.match(refusal.message, /already under way/i);

  await sleep(300);
  const after = lastState(host).game;
  assert.deepEqual(after.rules, before.rules, 'the ruleset cannot be swapped under the table');
  assert.equal(after.winRule, before.winRule);
  assert.ok(after.turnNumber >= before.turnNumber,
    `and the game was not reset to turn 0 (${before.turnNumber} -> ${after.turnNumber})`);
  assert.ok(after.log.length >= before.log.length, 'the table\'s history was not wiped');
  shut(host);
});

/* ── 2b. set_rules — the lobby's ruleset, visible to every seat ───────── */
// The rules picker was host-only BY NECESSITY: a lobby broadcast carried code/phase/players/
// hostId/game/timers and `game` is null before a game exists, so there was nowhere at all to
// put a ruleset that had not started yet. A non-host was shown "the host is choosing" and
// could not tell what they were about to play. `set_rules` publishes it; the broadcast
// carries it as `rules`; start_game with no rule fields launches exactly it.

// A lobby with a host and one other human seat.
async function lobbyPair(hostName, guestName) {
  const host = await openClient();
  send(host, { type: 'create_room', name: hostName });
  const hostJoined = await waitFor(host, m => m.type === 'joined');
  assert.ok(hostJoined, 'host joined');
  const code = hostJoined.code;

  const guest = await openClient();
  send(guest, { type: 'join_room', code, name: guestName });
  const guestJoined = await waitFor(guest, m => m.type === 'joined');
  assert.ok(guestJoined, 'guest joined');
  await sleep(120);
  return { host, guest, code, hostJoined, guestJoined };
}

test('a lobby broadcast carries the ruleset from the very first frame', async () => {
  const { host, guest } = await lobbyPair('Seed1', 'Seed2');
  const seen = lastState(guest);
  assert.ok(seen, 'the guest sees the lobby');
  assert.equal(seen.game, null, 'and there is no game yet — this is the whole problem');
  assert.ok(seen.rules, 'yet the ruleset is already on the wire');
  assert.equal(seen.rules.preset, 'chudopoly', 'an untouched table says what it will play');
  send(host, { type: 'leave_room' });
  send(guest, { type: 'leave_room' });
  shut(host, guest);
});

test('a non-host sees the host\'s ruleset in its very next broadcast', async () => {
  const { host, guest } = await lobbyPair('Picker', 'Watcher');

  guest._messages.length = 0;
  send(host, { type: 'set_rules', preset: 'mdFaithful' });

  // The buffer was emptied, so the first `state` that arrives IS the next broadcast.
  const next = await waitFor(guest, m => m.type === 'state', 2000);
  assert.ok(next, 'the room is re-broadcast');
  assert.ok(next.rules, 'and it carries the ruleset');
  assert.equal(next.rules.preset, 'mdFaithful');
  assert.equal(next.rules.winRule, 'mdFaithful');
  assert.equal(next.rules.pureSetRequired, true);
  assert.equal(next.phase, 'lobby', 'no game was started by picking rules');
  assert.equal(next.game, null);

  send(host, { type: 'leave_room' });
  send(guest, { type: 'leave_room' });
  shut(host, guest);
});

test('start_game with no rule fields launches exactly the ruleset the lobby showed', async () => {
  const { host, guest } = await lobbyPair('Launcher', 'Bystander');

  // A mixed ruleset: a preset plus one override, so it can only have come from the picker.
  send(host, { type: 'set_rules', preset: 'blitz', setsToWin: 5 });
  const announced = await waitFor(guest, m => m.type === 'state' && m.rules?.setsToWin === 5, 2000);
  assert.ok(announced, 'the guest is told');
  assert.equal(announced.rules.preset, 'custom', 'a mixed ruleset is never labelled a preset');
  await sleep(300);

  // Not one rule field on the wire — the launch has to come from the pending ruleset.
  guest._messages.length = 0;
  send(host, { type: 'start_game', turnTimeout: 60, responseTimeout: 30 });
  const live = await waitFor(guest, m => m.type === 'state' && m.phase === 'playing', 3000);
  assert.ok(live, 'the game started');
  assert.deepEqual(live.rules, announced.rules, 'the picker and the launch cannot disagree');
  assert.deepEqual(live.game.rules, announced.rules, 'and the GAME really resolved that ruleset');
  assert.equal(live.game.winRule, 'instant');

  send(host, { type: 'leave_room' });
  send(guest, { type: 'leave_room' });
  shut(host, guest);
});

test('start_game that DOES name rules still wins outright (old clients are unaffected)', async () => {
  const { host, guest } = await lobbyPair('Override', 'Sitter');

  send(host, { type: 'set_rules', preset: 'blitz' });
  assert.ok(await waitFor(guest, m => m.type === 'state' && m.rules?.preset === 'blitz', 2000));
  await sleep(300);

  send(host, { type: 'start_game', turnTimeout: 60, responseTimeout: 30, preset: 'longGame' });
  const live = await waitFor(guest, m => m.type === 'state' && m.phase === 'playing', 3000);
  assert.ok(live, 'the game started');
  assert.equal(live.game.rules.preset, 'longGame', 'the message is authoritative when it speaks');
  assert.deepEqual(live.rules, live.game.rules, 'and the stale pending set never shadows it');

  send(host, { type: 'leave_room' });
  send(guest, { type: 'leave_room' });
  shut(host, guest);
});

test('a non-host cannot set the rules, and is told so rather than ignored', async () => {
  const { host, guest } = await lobbyPair('RealHost', 'Pretender');
  const before = lastState(guest).rules;

  send(guest, { type: 'set_rules', preset: 'longGame', setsToWin: 5 });
  const refusal = await waitFor(guest, m => m.type === 'error', 2000);
  assert.ok(refusal, 'the non-host is refused');
  assert.match(refusal.message, /only host/i);

  await sleep(300);
  assert.deepEqual(lastState(host).rules, before, 'and the room\'s ruleset is untouched');
  assert.deepEqual(lastState(guest).rules, before);

  send(host, { type: 'leave_room' });
  send(guest, { type: 'leave_room' });
  shut(host, guest);
});

test('set_rules is refused once a game is under way, and the live ruleset is untouched', async () => {
  const { host } = await tableWithBots('MidGame');
  const before = lastState(host).game.rules;

  send(host, { type: 'set_rules', preset: 'blitz', setsToWin: 5 });
  const refusal = await waitFor(host, m => m.type === 'error', 2000);
  assert.ok(refusal, 'the change is refused');
  assert.match(refusal.message, /during a game/i);

  await sleep(300);
  const after = lastState(host);
  assert.deepEqual(after.game.rules, before, 'the ruleset cannot be swapped under a live table');
  assert.deepEqual(after.rules, before, 'and the broadcast still reports the LIVE ruleset');
  shut(host);
});

test('a pending ruleset belongs to the ROOM, and survives a host transfer', async () => {
  const { host, guest, guestJoined } = await lobbyPair('Leaving', 'Successor');

  send(host, { type: 'set_rules', preset: 'longGame' });
  assert.ok(await waitFor(guest, m => m.type === 'state' && m.rules?.preset === 'longGame', 2000));
  await sleep(300);

  host._socket.destroy();                       // the host drops; the room does not
  const promoted = await waitFor(guest, m => m.type === 'state' && m.hostId === guestJoined.playerId, 3000);
  assert.ok(promoted, 'the guest is promoted to host');
  assert.equal(promoted.rules.preset, 'longGame',
    'the ruleset is the room\'s intent, not the departed host\'s');

  // And the new host launching with no rule fields gets the ruleset the room agreed on.
  send(guest, { type: 'start_game', turnTimeout: 60, responseTimeout: 30 });
  const live = await waitFor(guest, m => m.type === 'state' && m.phase === 'playing', 3000);
  assert.ok(live, 'the new host can start');
  assert.equal(live.game.rules.preset, 'longGame');
  assert.equal(live.game.rules.setsToWin, 5);

  send(guest, { type: 'leave_room' });
  shut(host, guest);
});

test('set_rules coalesces its fan-out and never loses the last value', async () => {
  const { host, guest } = await lobbyPair('Spammer', 'Fanned');
  await sleep(300);

  // 12 changes as fast as the socket allows — every one of them a DIFFERENT ruleset, so
  // the no-op guard cannot be what saves us. Inside the 40-frame/5s limit, but each one
  // would otherwise fan a full room state to every seat.
  guest._messages.length = 0;
  const sequence = ['chudopoly', 'blitz', 'mdFaithful', 'longGame'];
  for (let i = 0; i < 12; i++) {
    send(host, { type: 'set_rules', preset: sequence[i % sequence.length] });
    await sleep(10);
  }
  const last = sequence[11 % sequence.length];
  await sleep(700);

  const fanned = guest._messages.filter(m => m.type === 'state').length;
  assert.ok(fanned <= 4, `12 changes must not fan out 12 room states (saw ${fanned})`);
  assert.ok(fanned >= 1, 'but the room is still told');
  assert.equal(lastState(guest).rules.preset, last,
    'and coalescing never drops the final value — the picker still matches the launch');

  // A client that re-announces the ruleset it already has costs the room nothing at all.
  guest._messages.length = 0;
  for (let i = 0; i < 5; i++) { send(host, { type: 'set_rules', preset: last }); await sleep(30); }
  await sleep(500);
  assert.deepEqual(guest._messages, [], 'a no-op change is not a broadcast');

  send(host, { type: 'leave_room' });
  send(guest, { type: 'leave_room' });
  shut(host, guest);
});

/* ── 3. rooms are accounted for ──────────────────────────────────────── */
// `leave_room` during a live game nulled state.roomCode and returned, so handleClose bailed
// and NO reaper was ever armed. The room, its bots, its turn timer and its state lived
// forever, and every abandoned table kept playing to completion.

test('leaving a LIVE game reaps the room, exactly as a disconnect does', async () => {
  const before = await settledRooms();
  const ws = await openClient();
  send(ws, { type: 'quick_play', name: 'Leaver' });
  assert.ok(await waitFor(ws, m => m.type === 'joined'));
  assert.ok(await waitFor(ws, m => m.type === 'state' && m.phase === 'playing'));
  assert.equal((await health()).rooms, before + 1, 'the live room exists');

  send(ws, { type: 'leave_room' });
  await sleep(200);
  assert.equal((await health()).rooms, before + 1, 'and is kept briefly so the player can return');

  await sleep(REAP_MS + 800);
  assert.equal((await health()).rooms, before, 'then it is collected — it is not immortal');
  shut(ws);
});

test('quick_play/leave_room cycles do not accumulate rooms', async () => {
  const before = await settledRooms();
  const ws = await openClient();
  const CYCLES = 8;
  for (let i = 0; i < CYCLES; i++) {
    send(ws, { type: 'quick_play', name: 'Churn' + i });
    await waitFor(ws, m => m.type === 'joined', 2000);
    ws._messages.length = 0;
    send(ws, { type: 'leave_room' });
    await sleep(60);
  }
  assert.ok((await health()).rooms > before, 'the rooms really were created');

  await sleep(REAP_MS + 1200);
  assert.equal((await health()).rooms, before,
    `${CYCLES} abandoned rooms must all be collected, not leaked`);
  shut(ws);
});

// Production incident 2026-08-20 (room L2NR): office wifi killed every long-lived
// connection at once — all three humans dropped within 15s, flapped, and the room was
// deleted mid-game with the LAST player only 10s gone, because the one reap timer was
// armed by the FIRST drop and billed its whole window to whoever dropped last. A live
// multi-human table now gets CHUD_REAP_PLAYING_MS (default 4x the base window), measured
// from the last human departure.
test('a live multi-human game outlives the short reap window, measured from the LAST drop', async () => {
  const host = await openClient();
  send(host, { type: 'create_room', name: 'OfficeA' });
  const hj = await waitFor(host, m => m.type === 'joined');
  assert.ok(hj, 'host joined');
  const guest = await openClient();
  send(guest, { type: 'join_room', code: hj.code, name: 'OfficeB' });
  assert.ok(await waitFor(guest, m => m.type === 'joined'), 'guest joined');
  send(host, { type: 'start_game', turnTimeout: 60, responseTimeout: 30 });
  assert.ok(await waitFor(host, m => m.type === 'state' && m.phase === 'playing'), 'game started');

  // The office wifi scenario: both humans drop, the second one later than the first.
  host._socket.destroy();
  await sleep(Math.floor(REAP_MS * 0.6));
  guest._socket.destroy();

  // Past the SHORT window (which the OLD code would have enforced): still reclaimable.
  await sleep(REAP_MS + 500);
  const back = await openClient();
  send(back, { type: 'reconnect', code: hj.code, playerId: hj.playerId, resumeToken: hj.resumeToken });
  assert.ok(await waitFor(back, m => m.type === 'joined', 2000),
    'the seat survives a wifi blip longer than the base reap window');

  // And the long window is a grace, not immortality: once the last human is gone for the
  // full playing window, the room is collected like any other.
  back._socket.destroy();
  await sleep(REAP_MS * 4 + 1500);
  const probe = await openClient();
  send(probe, { type: 'join_room', code: hj.code, name: 'Probe' });
  const refusal = await waitFor(probe, m => m.type === 'error', 2000);
  assert.ok(refusal && /not found/i.test(refusal.message),
    'the abandoned multi-human room is eventually collected');
  shut(host, guest, back, probe);
});

test('a flapping connection arms one reaper per room, not one per disconnect', async () => {
  const ws = await openClient();
  send(ws, { type: 'quick_play', name: 'Flap' });
  const joined = await waitFor(ws, m => m.type === 'joined');
  assert.ok(await waitFor(ws, m => m.type === 'state' && m.phase === 'playing'));

  let live = ws;
  for (let i = 0; i < 3; i++) {
    live._socket.destroy();
    await sleep(120);
    const back = await openClient();
    send(back, { type: 'reconnect', code: joined.code, playerId: joined.playerId, resumeToken: joined.resumeToken });
    assert.ok(await waitFor(back, m => m.type === 'joined', 2000), `reconnect ${i} accepted`);
    live = back;
  }

  const mark = serverOutput.length;
  live._socket.destroy();
  await sleep(REAP_MS + 1000);
  const deletions = (serverOutput.slice(mark).match(new RegExp(`\\[ROOM\\] ${joined.code} deleted`, 'g')) || []).length;
  assert.equal(deletions, 1, 'the room is torn down exactly once, by exactly one timer');
  shut(ws, live);
});

/* ── 4. sockets are accounted for ────────────────────────────────────── */

test('one client cannot open unlimited sockets', async () => {
  const before = (await health()).sockets;
  const opened = [];
  for (let i = 0; i < MAX_SOCKETS_PER_IP + 8; i++) {
    try { opened.push(await openClient()); } catch { /* refused at handshake */ }
  }
  await sleep(400);

  const after = (await health()).sockets;
  assert.ok(after <= MAX_SOCKETS_PER_IP,
    `the per-IP cap must hold: opened ${opened.length}, server holds ${after} (was ${before})`);
  assert.ok(opened.some(ws => ws._closeCode === 1013),
    'the sockets over the cap are told why they were dropped');

  shut(...opened);
  await sleep(300);
});

/* ── 5. unauthenticated egress amplification ─────────────────────────── */
// chat_history required no room, no name and no auth: an untouched socket got ~30KB back
// for a 30-byte request, repeatable inside the frame rate limit.

test('chat_history gives an unseated socket nothing at all', async () => {
  const ws = await openClient();
  send(ws, { type: 'chat_history' });
  await sleep(500);
  assert.deepEqual(ws._messages, [], 'no room, no name, no auth => no bytes');
  shut(ws);
});

test('chat_history is cooled down and paginated for a seated socket', async () => {
  const ws = await openClient();
  send(ws, { type: 'create_room', name: 'Historian' });
  assert.ok(await waitFor(ws, m => m.type === 'joined'));
  await sleep(150);

  ws._messages.length = 0;
  send(ws, { type: 'chat_history' });
  const first = await waitFor(ws, m => m.type === 'chat_history', 2000);
  assert.ok(first, 'a seated socket can refill its history');
  assert.ok(first.msgs.length <= 20, 'a refill is a page, not the whole ring');

  ws._messages.length = 0;
  for (let i = 0; i < 10; i++) { send(ws, { type: 'chat_history' }); await sleep(30); }
  await sleep(400);
  assert.deepEqual(ws._messages, [], 'and a flood of refills costs the server no egress');
  send(ws, { type: 'leave_room' });
  shut(ws);
});

test('global chat has its own rate limit, far slower than room chat', async () => {
  const ws = await openClient();
  send(ws, { type: 'create_room', name: 'Loud' });
  assert.ok(await waitFor(ws, m => m.type === 'joined'));
  await sleep(150);

  ws._messages.length = 0;
  for (let i = 0; i < 4; i++) { send(ws, { type: 'chat', scope: 'global', text: 'z'.repeat(500) }); await sleep(600); }
  await sleep(400);
  const delivered = ws._messages.filter(m => m.type === 'chat').length;
  assert.equal(delivered, 1,
    `global chat crosses every room boundary and fans to every socket; only one may land (saw ${delivered})`);
  send(ws, { type: 'leave_room' });
  shut(ws);
});

test('emote has a cooldown', async () => {
  const ws = await openClient();
  send(ws, { type: 'quick_play', name: 'Emoter' });
  assert.ok(await waitFor(ws, m => m.type === 'joined'));
  await sleep(200);

  ws._messages.length = 0;
  for (let i = 0; i < 8; i++) { send(ws, { type: 'emote', text: 'spam' }); await sleep(50); }
  await sleep(400);
  const emotes = ws._messages.filter(m => m.type === 'emote').length;
  assert.ok(emotes <= 2, `8 emotes in 0.4s must not fan out 8 times (saw ${emotes})`);
  send(ws, { type: 'leave_room' });
  shut(ws);
});
