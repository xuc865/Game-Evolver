// test/server-hardening.test.js — P7 round-1 robustness fixes that need a real socket.
// Frame-level WebSocket errors, socket liveness, room teardown, /health surface.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');
// The engine, only so a rule assertion can ask it what a legal deck is instead of
// restating thirteen counts a wire test has no business owning.
const G = require('../game');

const port = 34000 + (process.pid % 900);
const url = `ws://127.0.0.1:${port}`;
const httpUrl = `http://127.0.0.1:${port}`;
let serverProcess;
let serverOutput = '';
const clients = new Set();

// The heartbeat is 15s in production; the tests drive it at 250ms so a dead socket is
// reaped inside a normal test timeout rather than 30s later.
const PING_MS = 250;

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server start timeout')), 8000);
    const onData = data => {
      serverOutput += String(data);
      if (serverOutput.includes('Server running')) { clearTimeout(timeout); resolve(); }
    };
    serverProcess.stdout.on('data', onData);
    serverProcess.stderr.on('data', d => { serverOutput += String(d); });
    serverProcess.once('exit', code => reject(new Error(`server exited early (${code})`)));
  });
}

function openClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws._messages = [];
    ws.on('message', raw => { try { ws._messages.push(JSON.parse(raw)); } catch {} });
    ws.on('error', () => {});
    ws.once('open', () => { clients.add(ws); resolve(ws); });
    ws.once('error', reject);
  });
}

const send = (ws, msg) => ws.send(JSON.stringify(msg));
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  return { status: res.status, body: await res.json() };
}

async function stillAlive() {
  try { return (await health()).body.ok === true; } catch { return false; }
}

test.before(async () => {
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', CHUD_PING_MS: String(PING_MS) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
});

test.after(async () => {
  for (const ws of clients) { try { ws.terminate(); } catch {} }
  if (serverProcess) serverProcess.kill();
});

/* ── 1. frame-level WebSocket errors must not kill the process ───────── */
// Every vector below is unauthenticated: no join, no auth, first frame on the socket.
// Each one previously took the whole process down with an unhandled 'error' event.

async function survivesFrame(name, write) {
  const ws = await openClient();
  await write(ws);
  await sleep(400);
  assert.equal(await stillAlive(), true, `server died on: ${name}`);
  assert.equal(serverProcess.exitCode, null, `server process exited on: ${name}`);
  try { ws.terminate(); } catch {}
}

test('an oversized frame does not kill the server', async () => {
  await survivesFrame('17KB payload (maxPayload is 16KB)', ws => ws.send('x'.repeat(17 * 1024)));
});

test('an invalid UTF-8 text frame does not kill the server', async () => {
  await survivesFrame('invalid UTF-8', ws => {
    const body = Buffer.from([0xC0, 0x80, 0xFF, 0xFE]);
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(body.map((b, i) => b ^ mask[i % 4]));
    ws._socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]));
  });
});

test('an RSV1 bit set with no deflate does not kill the server', async () => {
  await survivesFrame('RSV1 set', ws => {
    const mask = Buffer.from([1, 2, 3, 4]);
    ws._socket.write(Buffer.concat([Buffer.from([0xC1, 0x81]), mask, Buffer.from([0x41 ^ 1])]));
  });
});

test('an unknown opcode does not kill the server', async () => {
  await survivesFrame('opcode 0x3', ws => {
    const mask = Buffer.from([1, 2, 3, 4]);
    ws._socket.write(Buffer.concat([Buffer.from([0x83, 0x80]), mask]));
  });
});

test('a TCP reset mid-frame does not kill the server', async () => {
  await survivesFrame('RST mid-frame', ws => {
    ws._socket.write(Buffer.from([0x81, 0xFF]));
    try { ws._socket.destroy(); } catch {}
  });
});

test('the server still serves real traffic after all of that', async () => {
  const ws = await openClient();
  send(ws, { type: 'quick_play', name: 'Survivor' });
  const joined = await waitFor(ws, m => m.type === 'joined');
  assert.ok(joined, 'a normal game can still be created');
  send(ws, { type: 'leave_room' });
  ws.close();
});

/* ── 2. socket liveness ──────────────────────────────────────────────── */

test('a half-open socket is reaped by the heartbeat and the seat is released', async () => {
  const ws = await openClient();
  send(ws, { type: 'quick_play', name: 'Dropout' });
  const joined = await waitFor(ws, m => m.type === 'joined');
  assert.ok(joined);
  await waitFor(ws, m => m.type === 'state' && m.phase === 'playing');

  // No FIN, no RST: exactly a phone losing signal. readyState stays 1 on the server.
  ws._socket.pause();

  // Without ping/pong the seat stays locked until the OS keepalive (~2h) and reconnect is
  // refused forever with "That player is already connected".
  const deadline = Date.now() + 6000;
  let reclaimed = null;
  while (Date.now() < deadline && !reclaimed) {
    const probe = await openClient();
    send(probe, { type: 'reconnect', code: joined.code, playerId: joined.playerId, resumeToken: joined.resumeToken });
    reclaimed = await waitFor(probe, m => m.type === 'joined', 600);
    if (!reclaimed) { probe.close(); await sleep(200); } else { probe.close(); }
  }
  assert.ok(reclaimed, 'the dead socket was never reaped; the seat stayed locked');
  try { ws._socket.resume(); ws.terminate(); } catch {}
});

test('the server pings and a live client stays connected', async () => {
  const ws = await openClient();
  let pings = 0;
  ws.on('ping', () => { pings++; });
  await sleep(PING_MS * 4);
  assert.ok(pings >= 2, `expected heartbeat pings, saw ${pings}`);
  assert.equal(ws.readyState, 1, 'a responsive client is never terminated');
  ws.close();
});

/* ── 3. rejected commands neither reset the deadline nor fan out state ── */

test('a rejected respond returns an error and broadcasts nothing', async () => {
  const ws = await openClient();
  send(ws, { type: 'quick_play', name: 'Bystand' });
  const joined = await waitFor(ws, m => m.type === 'joined');
  await waitFor(ws, m => m.type === 'state' && m.phase === 'playing');
  await sleep(300);

  const statesBefore = ws._messages.filter(m => m.type === 'state').length;
  const errorsBefore = ws._messages.filter(m => m.type === 'error').length;
  const JUNK = 12;
  for (let i = 0; i < JUNK; i++) { send(ws, { type: 'respond', response: 'accept' }); await sleep(40); }
  await sleep(300);

  const errors = ws._messages.filter(m => m.type === 'error').length - errorsBefore;
  const states = ws._messages.filter(m => m.type === 'state').length - statesBefore;
  assert.equal(errors, JUNK, 'every junk respond is answered with exactly one error');
  assert.ok(states <= 2, `a rejected command must not fan a full state to every seat (saw ${states})`);
  assert.ok(joined);
  send(ws, { type: 'leave_room' });
  ws.close();
});

/* ── 11. /health surface ─────────────────────────────────────────────── */

test('/health reports the build and uptime, not just {ok, rooms}', async () => {
  const { status, body } = await health();
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.rooms, 'number');
  assert.equal(typeof body.version, 'string');
  assert.equal(body.version, require('../package.json').version);
  assert.equal(typeof body.uptime, 'number');
  assert.equal(typeof body.startedAt, 'number');
  assert.equal(typeof body.sockets, 'number');
  assert.ok('commit' in body, 'a deploy must be able to identify the running build');
});

/* ── 2/7. timer floor and room teardown ──────────────────────────────── */

test('a room with two humans cannot be started with a zero turn clock', async () => {
  const host = await openClient();
  send(host, { type: 'create_room', name: 'Host' });
  const hostJoined = await waitFor(host, m => m.type === 'joined');
  const guest = await openClient();
  send(guest, { type: 'join_room', code: hostJoined.code, name: 'Guest' });
  await waitFor(guest, m => m.type === 'joined');
  await sleep(150);

  send(host, { type: 'start_game', turnTimeout: 0, responseTimeout: 0 });
  const state = await waitFor(host, m => m.type === 'state' && m.phase === 'playing');
  assert.ok(state.turnTimer, 'a multi-human table always gets a clock it can recover from');
  assert.ok(state.turnTimer.timeout >= 30);

  send(host, { type: 'leave_room' });
  send(guest, { type: 'leave_room' });
  host.close(); guest.close();
});

test('a solo table keeps its no-clock Quick Play mode', async () => {
  const ws = await openClient();
  send(ws, { type: 'quick_play', name: 'Lone' });
  await waitFor(ws, m => m.type === 'joined');
  const state = await waitFor(ws, m => m.type === 'state' && m.phase === 'playing');
  assert.equal(state.turnTimer, null, 'one human = no turn clock, by design');
  send(ws, { type: 'leave_room' });
  ws.close();
});

/* ── owner directive: every match answers on a 45s clock by default ──── */

test('start_game with no responseTimeout gives the table the 45s default', async () => {
  const host = await openClient();
  send(host, { type: 'create_room', name: 'Defaults' });
  const joined = await waitFor(host, m => m.type === 'joined');
  assert.ok(joined);
  send(host, { type: 'add_bot', mode: 'neutral' });
  await sleep(150);

  // Neither clock is supplied — exactly what an older client, or a lobby that has not been
  // touched, sends. "Unspecified" must mean the default, not "off".
  send(host, { type: 'start_game' });
  const state = await waitFor(host, m => m.type === 'state' && m.phase === 'playing');
  assert.ok(state, 'the game starts without either timer field');
  assert.equal(state.timers.response, 45, 'the answer clock defaults to 45s');
  assert.equal(state.timers.turn, 60, 'and the turn clock to 60s');
  send(host, { type: 'leave_room' });
  host.close();
});

test('Quick Play runs a 45s answer clock even though its turn clock is off', async () => {
  const ws = await openClient();
  send(ws, { type: 'quick_play', name: 'Quick' });
  assert.ok(await waitFor(ws, m => m.type === 'joined'));
  const state = await waitFor(ws, m => m.type === 'state' && m.phase === 'playing');
  assert.equal(state.turnTimer, null, 'one human = no turn clock, by design');
  assert.equal(state.timers.turn, 0);
  assert.equal(state.timers.response, 45,
    'but a bot\'s charge is still answered on a deadline — that is the whole point');
  send(ws, { type: 'leave_room' });
  ws.close();
});

test('the lobby setting wins over the default, and 0 still means OFF on a solo table', async () => {
  for (const [picked, expected] of [[15, 15], [30, 30], [45, 45], [60, 60], [90, 90], [0, 0]]) {
    const host = await openClient();
    send(host, { type: 'create_room', name: 'Pick' + picked });
    assert.ok(await waitFor(host, m => m.type === 'joined'));
    send(host, { type: 'add_bot', mode: 'neutral' });
    await sleep(120);
    send(host, { type: 'start_game', turnTimeout: 60, responseTimeout: picked });
    const state = await waitFor(host, m => m.type === 'state' && m.phase === 'playing');
    assert.equal(state.timers.response, expected, `the host picked ${picked}`);
    send(host, { type: 'leave_room' });
    host.close();
    await sleep(100);
  }
});

test('the two-human floor raises an OFF answer clock rather than fighting the default', async () => {
  const host = await openClient();
  send(host, { type: 'create_room', name: 'Floor' });
  const joined = await waitFor(host, m => m.type === 'joined');
  const guest = await openClient();
  send(guest, { type: 'join_room', code: joined.code, name: 'FloorG' });
  await waitFor(guest, m => m.type === 'joined');
  await sleep(150);

  send(host, { type: 'start_game', turnTimeout: 0, responseTimeout: 0 });
  const state = await waitFor(host, m => m.type === 'state' && m.phase === 'playing');
  assert.equal(state.timers.response, 15,
    'a deliberate OFF on a multi-human table is floored, never left unrecoverable');
  assert.ok(state.timers.response < 45, 'the floor only ever bites below the default');
  send(host, { type: 'leave_room' }); send(guest, { type: 'leave_room' });
  host.close(); guest.close();
});

test('the answer clock is sticky across a rematch', async () => {
  const host = await openClient();
  send(host, { type: 'create_room', name: 'StickyC' });
  assert.ok(await waitFor(host, m => m.type === 'joined'));
  send(host, { type: 'add_bot', mode: 'neutral' });
  await sleep(150);
  send(host, { type: 'start_game', turnTimeout: 60, responseTimeout: 90 });
  const first = await waitFor(host, m => m.type === 'state' && m.phase === 'playing');
  assert.equal(first.timers.response, 90);

  send(host, { type: 'scoop' });
  assert.ok(await waitFor(host, m => m.type === 'state' && m.game?.phase === 'finished', 4000));
  host._messages.length = 0;
  send(host, { type: 'rematch' });
  const again = await waitFor(host, m => m.type === 'state' && m.game?.phase === 'playing', 4000);
  assert.ok(again, 'rematch started');
  assert.equal(again.timers.response, 90, 'the rematch inherits the clock the host chose');
  send(host, { type: 'leave_room' });
  host.close();
});

test('an out-of-range clock is still refused rather than silently clamped', async () => {
  for (const bad of [{ responseTimeout: 121 }, { responseTimeout: -1 }, { responseTimeout: 45.5 },
    { turnTimeout: 301 }, { responseTimeout: '45' }]) {
    const host = await openClient();
    send(host, { type: 'create_room', name: 'BadClock' });
    await waitFor(host, m => m.type === 'joined');
    send(host, { type: 'add_bot', mode: 'neutral' });
    await sleep(120);
    send(host, { type: 'start_game', ...bad });
    const err = await waitFor(host, m => m.type === 'error', 1500);
    assert.ok(err, `${JSON.stringify(bad)} must be refused`);
    assert.match(err.message, /timer setting/i);
    assert.equal(host._messages.find(m => m.type === 'state' && m.phase === 'playing'), undefined,
      'and the game must not start');
    send(host, { type: 'leave_room' });
    host.close();
    await sleep(100);
  }
});

test('leaving a lobby deletes the room and leaves no timer running', async () => {
  const before = (await health()).body.rooms;
  const ws = await openClient();
  send(ws, { type: 'create_room', name: 'Ghost' });
  const joined = await waitFor(ws, m => m.type === 'joined');
  assert.ok(joined);
  send(ws, { type: 'add_bot', mode: 'neutral' });
  await sleep(150);
  assert.equal((await health()).body.rooms, before + 1);

  send(ws, { type: 'leave_room' });
  await sleep(300);
  assert.equal((await health()).body.rooms, before, 'the room is gone');

  // A deleted room whose turn timer kept re-arming used to keep playing forever.
  const quiet = serverOutput.length;
  await sleep(1200);
  assert.equal(serverOutput.length, quiet, 'nothing is still driving the deleted room');
  ws.close();
});

/* ── §3.10 win-rule toggle: the lobby payload over the wire ──────────── */

async function startTwoHumanRoom(name, extra) {
  const host = await openClient();
  send(host, { type: 'create_room', name });
  const joined = await waitFor(host, m => m.type === 'joined');
  const guest = await openClient();
  send(guest, { type: 'join_room', code: joined.code, name: name + 'G' });
  await waitFor(guest, m => m.type === 'joined');
  await sleep(150);
  send(host, { type: 'start_game', turnTimeout: 60, responseTimeout: 30, ...extra });
  const state = await waitFor(host, m => m.type === 'state' && m.phase === 'playing');
  return { host, guest, joined, state };
}

test('start_game carries winRule and getPlayerView reports the active mode', async () => {
  for (const rule of ['finalApproach', 'mdFaithful', 'instant']) {
    const { host, guest, state } = await startTwoHumanRoom('WR', { winRule: rule });
    assert.equal(state.game.winRule, rule, `room should run ${rule}`);
    assert.ok(state.game.events.some(e => e.t === 'game_start' && e.winRule === rule));
    if (rule === 'instant') assert.deepEqual(state.game.armedIds, []);
    send(host, { type: 'leave_room' }); send(guest, { type: 'leave_room' });
    host.close(); guest.close();
    await sleep(120);
  }
});

test('an omitted winRule is accepted and means finalApproach', async () => {
  const { host, guest, state } = await startTwoHumanRoom('Legacy', {});
  assert.equal(state.game.winRule, 'finalApproach');
  send(host, { type: 'leave_room' }); send(guest, { type: 'leave_room' });
  host.close(); guest.close();
});

test('an invalid winRule is refused without starting the game', async () => {
  const host = await openClient();
  send(host, { type: 'create_room', name: 'BadRule' });
  const joined = await waitFor(host, m => m.type === 'joined');
  send(host, { type: 'add_bot', mode: 'neutral' });
  await sleep(150);
  send(host, { type: 'start_game', turnTimeout: 60, responseTimeout: 30, winRule: 'sudden_death' });
  const err = await waitFor(host, m => m.type === 'error', 1500);
  assert.ok(err, 'a bad win rule is rejected at the protocol boundary');
  assert.match(err.message, /win rule/i);
  assert.ok(joined);
  send(host, { type: 'leave_room' });
  host.close();
});

test('the win rule is sticky across a rematch', async () => {
  const host = await openClient();
  send(host, { type: 'create_room', name: 'Sticky' });
  const joined = await waitFor(host, m => m.type === 'joined');
  send(host, { type: 'add_bot', mode: 'neutral' });
  await sleep(150);
  send(host, { type: 'start_game', turnTimeout: 60, responseTimeout: 30, winRule: 'instant' });
  const first = await waitFor(host, m => m.type === 'state' && m.phase === 'playing');
  assert.equal(first.game.winRule, 'instant');

  // End it deterministically: scooping out of a 2-seat table leaves the bot last standing.
  send(host, { type: 'scoop' });
  const finished = await waitFor(host, m => m.type === 'state' && m.game?.phase === 'finished', 4000);
  assert.ok(finished, 'the game reached an ending');
  assert.ok(joined);

  host._messages.length = 0;
  send(host, { type: 'rematch' });
  const again = await waitFor(host, m => m.type === 'state' && m.game?.phase === 'playing', 4000);
  assert.ok(again, 'rematch started');
  assert.equal(again.game.winRule, 'instant', 'the room setting survives the rematch');
  send(host, { type: 'leave_room' });
  host.close();
});

test('a preset is resolved server-side and shipped as the whole ruleset', async () => {
  const expected = {
    chudopoly:  { winRule: 'finalApproach', setsToWin: 3, pureSetRequired: false, counterCostsPlay: false, passGoRestartsTurn: false },
    mdFaithful: { winRule: 'mdFaithful',    setsToWin: 3, pureSetRequired: true,  counterCostsPlay: true,  passGoRestartsTurn: false },
    blitz:      { winRule: 'instant',       setsToWin: 3, pureSetRequired: false, counterCostsPlay: false, passGoRestartsTurn: true },
    longGame:   { winRule: 'finalApproach', setsToWin: 5, pureSetRequired: false, counterCostsPlay: false, passGoRestartsTurn: false },
  };
  for (const [preset, rules] of Object.entries(expected)) {
    const { host, guest, state } = await startTwoHumanRoom('RP', { preset });
    // The SCALAR ruleset. `suddenDeath` and `deck` are asserted separately below rather
    // than pinned here: this test is about a preset surviving the wire, and restating the
    // whole 13-count deck in it would make it a second copy of the preset table.
    const { deck, suddenDeath, ...scalars } = state.game.rules;
    assert.deepEqual(scalars, { preset, ...rules }, preset);
    assert.equal(suddenDeath, 'off', `${preset} ships §3.10b off`);
    assert.ok(deck && typeof deck === 'object', `${preset} ships its deck composition`);
    assert.equal(G.deckSize(deck), 106, `${preset} deck is 106 cards`);
    assert.equal(state.game.setsToWin, rules.setsToWin, `${preset} legacy scalar agrees`);
    assert.equal(state.game.winRule, rules.winRule);
    send(host, { type: 'leave_room' }); send(guest, { type: 'leave_room' });
    host.close(); guest.close();
    await sleep(120);
  }
});

test('individual toggles override a preset over the wire and the label becomes custom', async () => {
  const { host, guest, state } = await startTwoHumanRoom('RT', { preset: 'blitz', setsToWin: 5 });
  assert.equal(state.game.rules.preset, 'custom', 'a mixed ruleset is never labelled as a preset');
  assert.equal(state.game.rules.winRule, 'instant');
  assert.equal(state.game.rules.setsToWin, 5);
  send(host, { type: 'leave_room' }); send(guest, { type: 'leave_room' });
  host.close(); guest.close();
});

test('an invalid rule field is refused without starting the game', async () => {
  for (const bad of [{ preset: 'nope' }, { setsToWin: 6 }, { pureSetRequired: 'yes' }, { passGoRestartsTurn: 1 }]) {
    const host = await openClient();
    send(host, { type: 'create_room', name: 'BadCfg' });
    await waitFor(host, m => m.type === 'joined');
    send(host, { type: 'add_bot', mode: 'neutral' });
    await sleep(120);
    send(host, { type: 'start_game', turnTimeout: 60, responseTimeout: 30, ...bad });
    const err = await waitFor(host, m => m.type === 'error', 1500);
    assert.ok(err, `${JSON.stringify(bad)} must be refused`);
    const started = host._messages.find(m => m.type === 'state' && m.phase === 'playing');
    assert.equal(started, undefined, 'and the game must not start');
    send(host, { type: 'leave_room' });
    host.close();
    await sleep(100);
  }
});

test('the whole ruleset is sticky across a rematch', async () => {
  const host = await openClient();
  send(host, { type: 'create_room', name: 'StickyR' });
  const joined = await waitFor(host, m => m.type === 'joined');
  send(host, { type: 'add_bot', mode: 'neutral' });
  await sleep(150);
  send(host, { type: 'start_game', turnTimeout: 60, responseTimeout: 30, preset: 'longGame' });
  const first = await waitFor(host, m => m.type === 'state' && m.phase === 'playing');
  assert.deepEqual(first.game.rules.preset, 'longGame');

  send(host, { type: 'scoop' });
  assert.ok(await waitFor(host, m => m.type === 'state' && m.game?.phase === 'finished', 4000));
  host._messages.length = 0;
  send(host, { type: 'rematch' });
  const again = await waitFor(host, m => m.type === 'state' && m.game?.phase === 'playing', 4000);
  assert.ok(again, 'rematch started');
  assert.deepEqual(again.game.rules, first.game.rules, 'the ruleset survives untouched');
  assert.ok(joined);
  send(host, { type: 'leave_room' });
  host.close();
});

/* ── a finished game is not a live game ──────────────────────────────── */
//
// `room.phase` went to 'playing' in startRoomGame and was never reset, so a room was frozen
// at its first ruleset for life: after one game `set_rules`, `add_bot`, `remove_bot` and
// `kick` were all permanently refused and `rematch` silently replayed room.rules. Wanting to
// try Blitz after one Chudopoly game meant dissolving the room and re-inviting everyone.
// The guard that must NOT regress is the other half of the same flag: a game actually in
// progress stays unconfigurable and un-restartable.

test('a live game is unconfigurable, and a finished one hands the room back', async () => {
  const host = await openClient();
  send(host, { type: 'create_room', name: 'Reconfig' });
  const joined = await waitFor(host, m => m.type === 'joined');
  assert.ok(joined);
  send(host, { type: 'add_bot', mode: 'neutral' });
  await sleep(150);
  send(host, { type: 'start_game', turnTimeout: 60, responseTimeout: 30, preset: 'chudopoly' });
  const first = await waitFor(host, m => m.type === 'state' && m.phase === 'playing');
  assert.equal(first.game.rules.preset, 'chudopoly');

  // ── while it is LIVE: every configuration command is still refused ──
  const botId = first.players.find(p => p.isBot).id;
  for (const [msg, pattern] of [
    [{ type: 'set_rules', preset: 'blitz' }, /rules during a game/],
    [{ type: 'add_bot', mode: 'neutral' }, /bots during a game/],
    [{ type: 'remove_bot', targetId: botId }, /bots during a game/],
    [{ type: 'kick', targetId: botId }, /during a game/],
    [{ type: 'start_game' }, /already under way/],
  ]) {
    host._messages.length = 0;
    send(host, msg);
    const err = await waitFor(host, m => m.type === 'error' && pattern.test(m.message), 1500);
    assert.ok(err, `${msg.type} must still be refused mid-game`);
  }
  const live = host._messages.filter(m => m.type === 'state').pop()
    || first;
  assert.equal(live.game.rules.preset, 'chudopoly', 'and nothing about the live game changed');

  // ── end it: scooping out of a 2-seat table leaves the bot last standing ──
  send(host, { type: 'scoop' });
  const finished = await waitFor(host, m => m.type === 'state' && m.game?.phase === 'finished', 4000);
  assert.ok(finished, 'the game reached an ending');
  assert.equal(finished.phase, 'lobby', 'the room announces that it is configurable again');

  // ── now the picker, the bots and the roster all work again ──
  host._messages.length = 0;
  send(host, { type: 'set_rules', preset: 'blitz' });
  const ruled = await waitFor(host, m => m.type === 'state' && m.rules?.preset === 'blitz', 2000);
  assert.ok(ruled, 'the rules picker is usable after a game');
  send(host, { type: 'add_bot', mode: 'aggressive' });
  const grown = await waitFor(host, m => m.type === 'state' && m.players.length === 3, 2000);
  assert.ok(grown, 'and so is the bot roster');
  assert.equal(host._messages.some(m => m.type === 'error'), false, 'with no refusals at all');

  // ── and Rematch plays what the picker now says, instead of the old ruleset ──
  host._messages.length = 0;
  send(host, { type: 'rematch' });
  const again = await waitFor(host, m => m.type === 'state' && m.game?.phase === 'playing', 4000);
  assert.ok(again, 'rematch started');
  assert.equal(again.game.rules.preset, 'blitz', 'the NEW ruleset is what launched');
  assert.equal(again.phase, 'playing', 'and the room is locked down again while it runs');
  assert.equal(again.game.players.length, 3, 'the seat added between games is dealt in');

  send(host, { type: 'leave_room' });
  host.close();
});

test('a seat can still be reclaimed with its token after the game has finished', async () => {
  const host = await openClient();
  send(host, { type: 'create_room', name: 'ComeBack' });
  const joined = await waitFor(host, m => m.type === 'joined');
  send(host, { type: 'add_bot', mode: 'neutral' });
  await sleep(150);
  send(host, { type: 'start_game', turnTimeout: 60, responseTimeout: 30 });
  await waitFor(host, m => m.type === 'state' && m.phase === 'playing');
  send(host, { type: 'scoop' });
  assert.ok(await waitFor(host, m => m.type === 'state' && m.game?.phase === 'finished', 4000));
  host.close();
  await sleep(150);

  // The room is back in 'lobby', and the seat is still on the roster — so the reclaim path
  // has to be tried BEFORE the "that call sign is already in use" check, or a player who
  // blinked at the end of a game could never get back into their own room.
  const back = await openClient();
  send(back, {
    type: 'join_room', code: joined.code, name: 'ComeBack',
    playerId: joined.playerId, resumeToken: joined.resumeToken,
  });
  const rejoined = await waitFor(back, m => m.type === 'joined', 2000);
  assert.ok(rejoined, 'the token got the seat back');
  assert.equal(rejoined.playerId, joined.playerId, 'the same seat, not a second one');
  const view = await waitFor(back, m => m.type === 'state', 2000);
  assert.equal(view.players.length, 2, 'and no duplicate seat was created');

  // A wrong token still buys nothing.
  const thief = await openClient();
  send(thief, {
    type: 'join_room', code: joined.code, name: 'Thief',
    playerId: joined.playerId, resumeToken: 'x'.repeat(43),
  });
  const stolen = await waitFor(thief, m => m.type === 'joined', 1200);
  assert.ok(!stolen || stolen.playerId !== joined.playerId, 'a wrong token never gets that seat');
  send(back, { type: 'leave_room' });
  back.close(); thief.close();
});

/* ── owner directive: automatic turn draw over the wire ──────────────── */

test('a reconnecting player never draws twice and never sees a draw phase', async () => {
  const ws = await openClient();
  send(ws, { type: 'quick_play', name: 'Rejoin' });
  const joined = await waitFor(ws, m => m.type === 'joined');
  // Seat order is SHUFFLED (964d382) — the human is first only 1-in-4, so wait
  // for the state where the turn is actually theirs before asserting the
  // auto-draw. Same pattern as server.integration.test.js's myTurn(). But the
  // bots acting first can CHARGE this raw client, and an unanswered charge
  // holds the table for the full 45s response clock (timers.js auto-resolve) —
  // measured 3-in-10 blowing a 20s wait. So answer each charge once: a seat
  // that has never had a turn owns nothing payable, so a bare accept resolves
  // it insolvent and the turn train keeps moving.
  const answered = new Set();
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw);
      if (m.type !== 'state' || !m.game?.pendingAction) return;
      if (!(m.game.responders || []).includes(joined.playerId)) return;
      const key = JSON.stringify(m.game.pendingAction);
      if (answered.has(key)) return;
      answered.add(key);
      send(ws, { type: 'respond', response: 'accept', paymentCards: [] });
    } catch { /* not JSON — not ours */ }
  });
  const first = await waitFor(ws, m => m.type === 'state' && m.phase === 'playing'
    && m.game?.currentPlayerId === joined.playerId, 30000);
  const me = first.game.players.find(p => p.id === joined.playerId);
  assert.equal(first.game.turnPhase, 'play');
  assert.equal(me.hand.length, 7, 'auto-drawn without any client command');

  // An old client sending `draw` must get neither an error nor a second draw.
  const errorsBefore = ws._messages.filter(m => m.type === 'error').length;
  send(ws, { type: 'draw' });
  await sleep(300);
  assert.equal(ws._messages.filter(m => m.type === 'error').length, errorsBefore,
    '`draw` is accepted as a harmless no-op');

  ws._socket.destroy();
  const back = await openClient();
  send(back, { type: 'reconnect', code: joined.code, playerId: joined.playerId, resumeToken: joined.resumeToken });
  const rejoined = await waitFor(back, m => m.type === 'joined');
  assert.ok(rejoined, 'reconnect accepted');
  const resumed = await waitFor(back, m => m.type === 'state' && m.game);
  const seat = resumed.game.players.find(p => p.id === joined.playerId);
  assert.equal(seat.hand.length, 7, 'no second draw on reconnect');
  assert.notEqual(resumed.game.turnPhase, 'draw');
  back.close();
});

/* ── P8 round 3 — the server must never die without saying why ────────────
 *
 * The play server has been found dead more than once with a log that simply stops: no
 * stack, no [FATAL], no last line, and every client on ERR_CONNECTION_REFUSED. These
 * tests pin the two paths that produce exactly that signature, and the forensics that
 * make any future death self-explaining.
 *
 * Each spawns its own short-lived process rather than sharing the suite's server,
 * because the thing under test IS the process lifecycle.
 */

const net = require('node:net');
const ROOT = path.join(__dirname, '..');

function spawnServer(env = {}) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', ...env },
  });
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  const ended = new Promise(resolve => proc.on('exit', (code, signal) => resolve({ code, signal })));
  return { proc, logs: () => out, ended };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
  });
}

async function waitUntil(fn, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return true; await sleep(50); }
  return false;
}

test('a server that cannot take its port says so and fails — it does not vanish with code 0', async () => {
  // The measured pre-fix behaviour, and the whole reason a death could look like nothing
  // at all: `ws` re-emits the HTTP server's error, so wss.on('error') swallowed the
  // EADDRINUSE before uncaughtException could ever see it; the listen handle then went
  // away and, with the heartbeat and the room reaper both unref'd, Node simply ran out of
  // work and exited 0. One line of log, success code, no port, no clue.
  const taken = await freePort();
  const blocker = net.createServer();
  await new Promise((resolve, reject) => { blocker.on('error', reject); blocker.listen(taken, resolve); });
  try {
    const s = spawnServer({ PORT: String(taken) });
    const exit = await Promise.race([s.ended, sleep(6000).then(() => null)]);
    assert.ok(exit, 'the process must not linger holding no port — that is a server that refuses everything');
    assert.notEqual(exit.code, 0, 'exiting 0 tells a supervisor everything went fine');
    assert.match(s.logs(), /\[FATAL\] cannot listen on :\d+ — EADDRINUSE/,
      'the log must name the port and the reason');
    assert.match(s.logs(), /\[EXIT\] code=/, 'and the exit itself must be recorded');
  } finally {
    await new Promise(r => blocker.close(r));
  }
});

test('a stray SIGURG does not end a game in progress', async () => {
  // One observed death exited 144 — 128+16 — which is SIGURG on macOS and SIGSTKFLT on
  // Linux. Neither is a shutdown request from any supervisor. Installing a handler is
  // exactly what makes such a signal non-fatal, because a signal with a JS listener stops
  // taking its default action.
  const p = await freePort();
  const s = spawnServer({ PORT: String(p) });
  const alive = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(1000) });
      return (await res.json()).ok === true;
    } catch { return false; }
  };
  try {
    assert.ok(await waitUntil(alive), 'server came up');

    // A real table, so the signal lands on a process with a game in it.
    const ws = new WebSocket(`ws://127.0.0.1:${p}`);
    ws.on('error', () => {});
    const joined = new Promise(resolve => ws.on('message', raw => {
      const m = JSON.parse(raw); if (m.type === 'joined') resolve(m);
    }));
    await new Promise(r => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'quick_play', name: 'Signal' }));
    await joined;
    assert.ok(await waitUntil(async () => {
      const res = await fetch(`http://127.0.0.1:${p}/health`);
      return (await res.json()).rooms === 1;
    }), 'the room exists');

    s.proc.kill('SIGURG');
    await sleep(500);

    assert.equal(s.proc.exitCode, null, 'SIGURG must not end the process');
    assert.equal(s.proc.signalCode, null, 'nor kill it by signal');
    assert.equal(await alive(), true, 'and the server is still serving');
    const res = await fetch(`http://127.0.0.1:${p}/health`);
    assert.equal((await res.json()).rooms, 1, 'the game in progress survived it');
    assert.match(s.logs(), /\[SIGNAL\] SIGURG received and IGNORED/,
      'and the signal is on the record, so the next one is not a mystery');
    try { ws.terminate(); } catch {}
  } finally {
    s.proc.kill('SIGKILL');
  }
});

test('a shutdown signal is named in the log before the process goes', async () => {
  // SIGTERM is a legitimate request and is still obeyed — but a death that says nothing is
  // indistinguishable from a crash, and that ambiguity is what cost the last three
  // investigations. It now names the signal, reports what it was holding, and exits 128+n.
  const p = await freePort();
  const s = spawnServer({ PORT: String(p) });
  try {
    assert.ok(await waitUntil(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(1000) });
        return (await res.json()).ok === true;
      } catch { return false; }
    }), 'server came up');

    s.proc.kill('SIGTERM');
    const exit = await Promise.race([s.ended, sleep(5000).then(() => null)]);
    assert.ok(exit, 'SIGTERM is obeyed');
    assert.equal(exit.code, 143, 'and reports the conventional 128+15');
    assert.match(s.logs(), /\[SIGNAL\] SIGTERM — shutting down \(uptime \d+s, \d+ rooms, \d+ sockets\)/);
    assert.match(s.logs(), /\[EXIT\] code=143/);
  } finally {
    s.proc.kill('SIGKILL');
  }
});
