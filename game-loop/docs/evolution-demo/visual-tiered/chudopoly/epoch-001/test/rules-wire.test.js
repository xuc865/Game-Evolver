// test/rules-wire.test.js — the rules pipeline end to end: picker offer → wire → launch.
//
// Two defects found by the 2026-08-08 audit (probe-rules-wire):
//   1. server/handlers.js RULE_FIELDS omitted 'suddenDeath', so set_rules and start_game
//      validated it (protocol.js) and the engine resolved it (game.js) but pickRuleOpts
//      silently dropped it — the rule could never be turned on over the wire.
//   2. public/src/net/send.js startGame whitelisted only five keys, dropping `deck` and
//      `suddenDeath` client-side — the lobby's 13 deck steppers and sudden-death radios
//      were dead controls (picker said "custom deck", the game launched stock).
//
// These tests pin all three joints: the raw-ws path (defect 1), the client send path
// (defect 2), and the drift guard that fails if the two whitelists ever disagree again.

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');
const protocol = require('../server/protocol');
const handlers = require('../server/handlers');

let server;
let startServer;
let ChudClient;
let sendjs;       // public/src/net/send.js (ESM — the real client senders)
let socket;       // public/src/net/socket.js (for sentLog capture)
let ruleset;      // public/src/ui/ruleset.js (for the payload the lobby builds)

test.before(async () => {
  ({ startServer } = await import('../tools/serve.mjs'));
  ({ ChudClient } = await import('../tools/lib/wsclient.mjs'));
  sendjs = await import('../public/src/net/send.js');
  socket = await import('../public/src/net/socket.js');
  ruleset = await import('../public/src/ui/ruleset.js');
  server = await startServer({ seed: 5 });
});

test.after(async () => { await server.stop(); });

/** A fresh lobby with a human host (a) and a human guest (b). */
async function lobby() {
  const a = new ChudClient(server.wsUrl, { name: 'ALPHA' });
  const b = new ChudClient(server.wsUrl, { name: 'BRAVO' });
  await a.connect(); await b.connect();
  await a.send({ type: 'create_room', name: 'ALPHA' });
  await a.waitFor((m) => m.type === 'joined', 5000, 'host joined');
  await b.send({ type: 'join_room', code: a.roomCode, name: 'BRAVO' });
  await b.waitFor((m) => m.type === 'joined', 5000, 'guest joined');
  return { a, b };
}

test('set_rules suddenDeath reaches the room, and a bare start_game launches it', async () => {
  const { a, b } = await lobby();
  try {
    await a.send({ type: 'set_rules', suddenDeath: 'oneLap' });
    // Defect 1, first half: pendingRules on the lobby wire must carry it — to the host…
    const hostLobby = await a.waitFor(
      (m) => m.type === 'state' && m.rules?.suddenDeath === 'oneLap', 5000, 'host lobby rules');
    assert.equal(hostLobby.rules.suddenDeath, 'oneLap');
    // …and to the guest, who otherwise cannot see what they are about to play.
    const guestLobby = await b.waitFor(
      (m) => m.type === 'state' && m.rules?.suddenDeath === 'oneLap', 5000, 'guest lobby rules');
    assert.equal(guestLobby.rules.suddenDeath, 'oneLap');

    // Defect 1, second half: start_game with NO rule fields must launch the pending
    // ruleset the lobby has been showing — suddenDeath included.
    await a.send({ type: 'start_game' });
    const started = await a.waitFor(
      (m) => m.type === 'state' && m.game?.phase === 'playing', 8000, 'game start');
    assert.equal(started.game.rules.suddenDeath, 'oneLap');
  } finally {
    a.close(); b.close();
  }
});

test('a deck override on start_game lands in the actual game state', async () => {
  const { a, b } = await lobby();
  try {
    await a.send({ type: 'start_game', deck: { chud: 0, pcs_orders: 4 } });
    const started = await a.waitFor(
      (m) => m.type === 'state' && m.game?.phase === 'playing', 8000, 'game start');
    const game = started.game;
    // The resolved ruleset names the override…
    assert.equal(game.rules.deck.chud, 0);
    assert.equal(game.rules.deck.pcs_orders, 4);
    // …and the game itself is built from it: card conservation across deck, hands,
    // banks, boards and discard must total the CUSTOM deck's size (105), not stock 106.
    // Rules.deck is fully normalized by resolveRules, so its size is the ground truth.
    const expected = G.deckSize(game.rules.deck);
    assert.equal(expected, 98); // 106 - 2 CHUD - 6 PCS Orders (base 10 → 4)
    const onTable = game.deckCount + game.discardPile.length + game.players.reduce((n, p) => n
      + p.handCount + p.bank.length
      + Object.values(p.properties).reduce((m, cards) => m + cards.length, 0)
      + (p.upgrades ? Object.values(p.upgrades).flat().length : 0), 0);
    assert.equal(onTable, expected);
  } finally {
    a.close(); b.close();
  }
});

test('the payload send.js actually builds survives the server intact', async () => {
  // Build the rules object exactly the way the lobby does (ui/lobby.js start-game:
  // rulesPayload(pending) after stepper/radio edits), then send it through the REAL
  // startGame sender and capture the exact frame off socket.js's sentLog.
  const pending = ruleset.normalizeRules({ suddenDeath: 'oneLap', deck: { chud: 0, pcs_orders: 4 } });
  const payload = ruleset.rulesPayload(pending);
  assert.equal(payload.preset, undefined); // a custom ruleset goes as full toggles, not a name
  socket.setSendRecording(true);
  socket.sentLog.length = 0;
  sendjs.startGame(60, 45, payload);
  assert.equal(socket.sentLog.length, 1);
  const frame = socket.sentLog[0];
  delete frame.t;

  // Defect 2: the frame must CARRY deck and suddenDeath, not drop them client-side.
  assert.equal(frame.suddenDeath, 'oneLap');
  assert.deepEqual(frame.deck, payload.deck);

  // The frame passes strict protocol validation…
  const verdict = protocol.validateMessage(frame);
  assert.equal(verdict.ok, true, verdict.error);

  // …and every rule key the client sent survives the server's pickRuleOpts — nothing
  // the sender put on the wire may be dropped on the floor.
  const picked = handlers.pickRuleOpts(frame);
  for (const key of Object.keys(payload)) {
    assert.deepEqual(picked[key], payload[key], `pickRuleOpts dropped ${key}`);
  }
  // And it resolves to the ruleset the picker was showing.
  const resolved = G.resolveRules(picked);
  assert.equal(resolved.suddenDeath, 'oneLap');
  assert.equal(resolved.deck.chud, 0);
  assert.equal(resolved.deck.pcs_orders, 4);
});

test('client RULE_WIRE_KEYS and server RULE_FIELDS cannot drift apart', () => {
  // The two whitelists are not importable across the client/server boundary, so this
  // is the contract: same set of keys, or the suite goes red.
  assert.deepEqual([...sendjs.RULE_WIRE_KEYS].sort(), [...handlers.RULE_FIELDS].sort());
  // Every key ruleset.js can put in a payload (the four toggles, suddenDeath, deck)
  // is one the server will pick up.
  for (const key of [...ruleset.RULE_KEYS, 'deck']) {
    assert.ok(handlers.RULE_FIELDS.includes(key), `server RULE_FIELDS is missing ${key}`);
  }
});
