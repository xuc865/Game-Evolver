const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const port = 32000 + (process.pid % 1000);
const url = `ws://127.0.0.1:${port}`;
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
    const ws = new WebSocket(url);
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
    const waiter = { predicate, resolve, timeout:null };
    waiter.timeout = setTimeout(() => {
      ws._waiters = ws._waiters.filter(item => item !== waiter);
      reject(new Error('message timeout'));
    }, timeoutMs);
    ws._waiters.push(waiter);
  });
}

function send(ws, message) { ws.send(JSON.stringify(message)); }

test.before(async () => {
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT:String(port), NODE_ENV:'test', CHUD_SEED:'integration' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
});

test.after(() => {
  for (const ws of clients) try { ws.close(); } catch {}
  if (serverProcess && !serverProcess.killed) serverProcess.kill('SIGTERM');
});

test('malformed JSON values are rejected without crashing the server', async () => {
  const ws = await openClient();
  ws.send('null');
  const error = await waitMessage(ws, msg => msg.type === 'error');
  assert.match(error.message, /JSON object/);
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
  assert.equal((await response.json()).ok, true);
});

test('reconnect requires the private token and an available seat', async () => {
  const host = await openClient();
  send(host, { type:'create_room', name:'Host' });
  const joined = await waitMessage(host, msg => msg.type === 'joined');
  assert.ok(joined.resumeToken);

  const attacker = await openClient();
  send(attacker, { type:'reconnect', code:joined.code, playerId:joined.playerId, resumeToken:'x'.repeat(43) });
  const badToken = await waitMessage(attacker, msg => msg.type === 'error');
  assert.match(badToken.message, /Invalid resume credentials/);

  send(attacker, { type:'reconnect', code:joined.code, playerId:joined.playerId, resumeToken:joined.resumeToken });
  const occupied = await waitMessage(attacker, msg => msg.type === 'error');
  assert.match(occupied.message, /already connected/);

  host.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  const resumed = await openClient();
  send(resumed, { type:'reconnect', code:joined.code, playerId:joined.playerId, resumeToken:joined.resumeToken });
  const resumedJoined = await waitMessage(resumed, msg => msg.type === 'joined');
  assert.equal(resumedJoined.playerId, joined.playerId);
});

// FOUR seats since the 2026-08-07 owner ruling ("change default to 4 then"). Quick Play
// used to seat two bots, which made the configuration the owner actually played the ONE
// configuration BOT-STRATEGY.md's matrices never covered — and 3-player measured as a
// materially thinner game (final approaches shot down 19.5% against 47.5% at four seats,
// and a turn count so tight, SD 6.5, that every game felt the same). The seat count is
// asserted here rather than left to the handler because it is a ruling, not an accident.
test('quick play creates a live four-player game', async () => {
  const ws = await openClient();
  send(ws, { type:'quick_play', name:'Solo' });
  const joined = await waitMessage(ws, msg => msg.type === 'joined');
  const state = await waitMessage(ws, msg => msg.type === 'state' && msg.phase === 'playing');
  assert.equal(state.players.length, 4);
  assert.equal(state.players.filter(player => player.isBot).length, 3);
  // Still exactly one human, which is what keeps the 0 turn clock legitimate: only that
  // player can stall and only their own game suffers.
  assert.equal(state.players.filter(player => !player.isBot).length, 1);
  assert.equal(state.game.phase, 'playing');

  const me = state.game.players.find(player => player.id === joined.playerId);
  // 5 dealt + the automatic turn draw of 2 for whichever seat OPENS the game —
  // seats are shuffled at start (owner directive 2026-08-07), so the opener is
  // found from the broadcast rather than assumed to be the human.
  const openerId = state.game.currentPlayerId;
  assert.equal(me.hand.length, openerId === joined.playerId ? 7 : 5);
  assert.equal(state.game.turnPhase, 'play');
  assert.ok(state.game.events.some(event => event.t === 'draw' && event.to === openerId));
  assert.equal(state.game.players.filter(player => player.hand !== undefined).length, 1);
  assert.ok(state.game.events.some(event => event.t === 'game_start'));
  const foreignDeal = state.game.events.find(event => event.t === 'deal' && event.to !== joined.playerId);
  assert.equal(foreignDeal.cards, undefined);
  assert.equal(foreignDeal.count, 5);
});

test('CHUD_SEED makes the served shuffle reproducible', async () => {
  const hands = [];
  for (let i = 0; i < 2; i++) {
    const ws = await openClient();
    send(ws, { type:'quick_play', name:`Seeded${i}` });
    const joined = await waitMessage(ws, msg => msg.type === 'joined');
    const state = await waitMessage(ws, msg => msg.type === 'state' && msg.phase === 'playing');
    const me = state.game.players.find(player => player.id === joined.playerId);
    hands.push(me.hand.map(card => card.id).join(','));
    send(ws, { type:'leave_room' });
  }
  assert.equal(hands[0], hands[1]);
});

/* ── §3.5's atomic swap, over a real socket ─────────────────────────────────
 *
 * The engine, the protocol validator and the handler each have their own tests;
 * this is the only one that proves the three are WIRED. §0.1 says the server
 * decides, and the two things that has to mean on the wire are that a malformed
 * frame never reaches the engine and that an illegal one never changes the
 * board — both answered with an error frame and NO state broadcast, exactly like
 * `move_property` next to it.
 *
 * The refusals are the testable half over a live socket: reaching an actual
 * §3.5 deadlock requires a specific board, and a real game deals what it deals.
 * The accepting path is measured against the engine directly
 * (test/property-swap.test.js) and end to end through the client with real CDP
 * input, which is where a board can be staged.
 */
test('swap_property is refused by shape and by rule, and never rebroadcasts', async () => {
  const ws = await openClient();
  send(ws, { type:'quick_play', name:'Swapper' });
  const joined = await waitMessage(ws, msg => msg.type === 'joined');
  let state = await waitMessage(ws, msg => msg.type === 'state' && msg.phase === 'playing');
  // Seats are shuffled at start (owner directive 2026-08-07) and this test's
  // whole design needs the HUMAN on turn (its no-fan-out bound depends on no
  // bot broadcasting underneath the measurement) — so wait for the turn to
  // come around; quick-play bots act on their own timers within seconds.
  const myTurn = (m) => m.game?.currentPlayerId === joined.playerId;
  if (!myTurn(state)) state = await waitMessage(ws, (m) => m.type === 'state' && myTurn(m), 20000);
  const seq = state.game.eventSeq;

  // 1. SHAPE — server/protocol.js, before the engine is ever called.
  send(ws, { type:'swap_property', cardId:'3', withCardId:7 });
  assert.match((await waitMessage(ws, m => m.type === 'error')).message, /Invalid property swap/);
  send(ws, { type:'swap_property', cardId:3 });
  assert.match((await waitMessage(ws, m => m.type === 'error')).message, /Invalid property swap/);
  send(ws, { type:'swap_property', cardId:5, withCardId:5 });
  assert.match((await waitMessage(ws, m => m.type === 'error')).message, /Pick two different cards/);

  // 2. RULE — well-formed, routed to game.js, refused there. A fresh game has
  //    no property on any board, so neither id can be found.
  send(ws, { type:'swap_property', cardId:0, withCardId:1 });
  assert.match((await waitMessage(ws, m => m.type === 'error')).message,
    /not found in your properties/);

  // 3. NO FAN-OUT. Four refused commands must cost four ~60-byte error frames
  //    and not one ~13KB state — the same bound test/engine-hardening.test.js
  //    puts on a rearrange spam burst, checked here over the wire. The human
  //    holds the turn, so no bot can broadcast underneath this measurement.
  ws._messages.length = 0;
  await new Promise(resolve => setTimeout(resolve, 250));
  const broadcasts = ws._messages.filter(m => m.type === 'state');
  assert.equal(broadcasts.length, 0,
    `an illegal swap rebroadcast the room ${broadcasts.length} time(s)`);

  // And the game is still exactly where it was. `end_turn` is the next legal
  // command and it DOES broadcast, so the first state to arrive after it carries
  // the whole event tail those four refusals were supposed to have left in it.
  send(ws, { type:'end_turn' });
  const live = await waitMessage(ws, m => m.type === 'state' && m.game?.eventSeq > seq, 6000);
  assert.equal(live.game.events.some(e => e.t === 'move_property'), false,
    'a refused swap appended a card movement to the stream');
});
