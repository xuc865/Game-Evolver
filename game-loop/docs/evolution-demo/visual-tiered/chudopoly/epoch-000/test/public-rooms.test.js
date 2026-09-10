// Public rooms (owner directive 2026-08-07): an opt-in "list this room
// publicly" flag at creation, an HTTP listing the home screen reads, and —
// the test that matters — LEAK DISCIPLINE: a private room must be provably
// absent from the listing, and the listing must expose nothing beyond
// {code, host, seats, capacity, preset}.
//
// Same harness shape as test/server.integration.test.js: a real spawned
// server.js, real WebSocket clients, and here real HTTP GETs against the
// same process.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const port = 33000 + (process.pid % 1000);
const wsUrl = `ws://127.0.0.1:${port}`;
const httpUrl = `http://127.0.0.1:${port}`;
let serverProcess;
const clients = new Set();

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server start timeout')), 5000);
    const onData = data => {
      if (String(data).includes('Server running')) {
        clearTimeout(timeout);
        serverProcess.stdout.off('data', onData);
        resolve();
      }
    };
    serverProcess.stdout.on('data', onData);
    serverProcess.once('exit', code => reject(new Error(`server exited early (${code})`)));
  });
}

function openClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws._messages = [];
    ws._waiters = [];
    ws.on('message', raw => {
      const message = JSON.parse(raw);
      const waiterIndex = ws._waiters.findIndex(waiter => waiter.predicate(message));
      if (waiterIndex >= 0) {
        const [waiter] = ws._waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      } else {
        ws._messages.push(message);
      }
    });
    ws.once('open', () => { clients.add(ws); resolve(ws); });
    ws.once('error', reject);
  });
}

function waitMessage(ws, predicate, timeoutMs = 3000) {
  const existingIndex = ws._messages.findIndex(predicate);
  if (existingIndex >= 0) return Promise.resolve(ws._messages.splice(existingIndex, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, timeout: null };
    waiter.timeout = setTimeout(() => {
      ws._waiters = ws._waiters.filter(item => item !== waiter);
      reject(new Error('message timeout'));
    }, timeoutMs);
    ws._waiters.push(waiter);
  });
}

function send(ws, message) { ws.send(JSON.stringify(message)); }

async function listing() {
  const res = await fetch(`${httpUrl}/api/public-rooms`);
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

test.before(async () => {
  serverProcess = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    cwd: require('node:path').join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
});

test.after(() => {
  for (const ws of clients) { try { ws.close(); } catch { /* closing */ } }
  serverProcess?.kill();
});

test('a private room is provably absent; a public one lists exactly five fields', async () => {
  // Private (the default — `public` unstated) and public, side by side.
  const privHost = await openClient();
  send(privHost, { type: 'create_room', name: 'Private Pete' });
  const privJoined = await waitMessage(privHost, m => m.type === 'joined');

  const pubHost = await openClient();
  send(pubHost, { type: 'create_room', name: 'Open Olly', public: true });
  const pubJoined = await waitMessage(pubHost, m => m.type === 'joined');

  const { status, body } = await listing();
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.rooms), 'the listing is {rooms: [...]}');
  const codes = body.rooms.map(r => r.code);
  assert.ok(codes.includes(pubJoined.code), 'the opt-in room is listed');
  assert.equal(codes.includes(privJoined.code), false,
    'LEAK: a private room\'s code must never appear in the public listing');

  const row = body.rooms.find(r => r.code === pubJoined.code);
  assert.deepEqual(Object.keys(row).sort(), ['capacity', 'code', 'host', 'preset', 'seats'],
    'exactly the five agreed fields — nothing else rides along');
  assert.equal(row.host, 'Open Olly');
  assert.equal(row.seats, 1);
  assert.equal(row.capacity, 5);
  assert.equal(typeof row.preset, 'string');

  // Nothing in the whole payload may leak ids or resume tokens.
  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /[A-Za-z0-9_-]{32,}/,
    'no token-shaped string anywhere in the listing');
  assert.doesNotMatch(raw, /[a-f0-9]{8}-[a-f0-9]{4}/i, 'no player UUIDs in the listing');
});

test('a started public room leaves the listing; joining from the list is the ordinary join', async () => {
  const host = await openClient();
  send(host, { type: 'create_room', name: 'Roomy', public: true });
  const joined = await waitMessage(host, m => m.type === 'joined');

  // Joinable through the exact same join path a typed code uses.
  const guest = await openClient();
  send(guest, { type: 'join_room', code: joined.code, name: 'Walkin' });
  await waitMessage(guest, m => m.type === 'joined');
  let { body } = await listing();
  let row = body.rooms.find(r => r.code === joined.code);
  assert.ok(row, 'still listed while in lobby');
  assert.equal(row.seats, 2, 'the listing reflects the filled seat');

  // Start it: two humans suffice. Started games are not browseable.
  send(host, { type: 'start_game' });
  await waitMessage(host, m => m.type === 'state' && m.phase === 'playing', 5000);
  ({ body } = await listing());
  assert.equal(body.rooms.some(r => r.code === joined.code), false,
    'a room whose game has started is not in the listing');
});

test('a public lobby whose humans have all dropped is not advertised', async () => {
  const host = await openClient();
  send(host, { type: 'create_room', name: 'Ghost', public: true });
  const joined = await waitMessage(host, m => m.type === 'joined');
  let { body } = await listing();
  assert.ok(body.rooms.some(r => r.code === joined.code), 'listed while the host is connected');
  host.close();
  clients.delete(host);
  await new Promise(r => setTimeout(r, 200));
  ({ body } = await listing());
  assert.equal(body.rooms.some(r => r.code === joined.code), false,
    'a joiner must not be sent into a lobby with nobody in it');
});

test('the public flag is validated strictly, and the endpoint is rate-limited', async () => {
  const ws = await openClient();
  send(ws, { type: 'create_room', name: 'Strict', public: 'yes' });
  const err = await waitMessage(ws, m => m.type === 'error');
  assert.match(err.message, /public/i, 'a non-boolean public flag is refused, not coerced');

  // The listing must not be a scrape vector: hammer it and expect a 429.
  let limited = false;
  for (let i = 0; i < 80; i++) {
    const res = await fetch(`${httpUrl}/api/public-rooms`);
    if (res.status === 429) { limited = true; break; }
  }
  assert.equal(limited, true, 'the endpoint rate-limits a hammering client');
});
