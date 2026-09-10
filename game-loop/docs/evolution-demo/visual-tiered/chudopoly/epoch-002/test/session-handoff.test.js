// test/session-handoff.test.js — one game must not end up on the next one's table.
//
// OWNER BUG, 2026-08-07: "when starting a new game it briefly shows your
// cards/hand from the last game (says offline) then syncs."
//
// MEASURED on the shipped build (headless Chromium, real server, quick play →
// Leave game → quick play): the seven card nodes of the finished game were
// still parented in #zone-hand 300ms after the leave — store.snapshot was
// already null — the game screen unhid 55ms after the second Quick Play with
// all seven of them fanned face-up under a "Hand 0" label, and the new deal
// then flew ON TOP of them (11, then 12 cards in a hand that holds 7). The last
// game stayed on the felt for 1.75 seconds.
//
// The felt outlived its snapshot because nothing in the client had ever removed
// a card node except reconcile()'s step 2, and reconcile only runs when a new
// snapshot arrives — at the END of the choreographer's job. §10 says the
// snapshot is truth; a null snapshot therefore has to mean an empty table.
//
// THE RULE THIS FILE PINS is the one the DOM fix hangs off: store.applyState
// now reports `fresh` — "this broadcast is the first sight of a game the felt
// has never shown" — and main.js empties the felt when it sees it. Getting
// `fresh` wrong in either direction is a real defect, so both directions are
// probed against REAL engine states rather than hand-written literals:
//
//   fresh   a first game; a game after a leave/kick (reset); a rematch, whose
//           eventSeq restarts inside the same room; a different room entirely.
//   NOT     every continuation broadcast; a RECONNECT into the same game, whose
//           felt is still valid and whose card nodes must survive — clearing
//           there would throw away the identities a resume exists to keep.
//
// tools/handoff.mjs is the other half: it drives two real Quick Play sessions
// in a browser and asserts the DOM consequence, frame by frame.
//
// public/src/ is native ESM (§0.2) and this suite is CommonJS, so the client
// module loads through a dynamic import(), the same way test/property-swap.js
// does.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

const G = require('../game.js');

const url = (p) => pathToFileURL(join(__dirname, '..', p)).href;
const loadStore = () => import(url('public/src/state/store.js'));

/** A `state` broadcast, shaped exactly like server/broadcast.js writes one. */
function broadcast(state, code, selfId) {
  return {
    type: 'state',
    code,
    phase: 'playing',
    players: state.players.map(p => ({ id: p.id, name: p.name, connected: true, isBot: false })),
    hostId: state.players[0].id,
    game: G.getPlayerView(state, selfId),
  };
}

function newGame(seed) {
  return G.createGame([{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }], { seed });
}

/** Move a game forward `n` turns without caring what anybody plays — this file
 *  is about sequence numbers, not tactics. */
function playTurns(state, n) {
  for (let i = 0; i < n; i++) {
    const id = state.players[state.currentPlayerIndex].id;
    const player = state.players.find(p => p.id === id);
    // Under the hand limit first, or endTurn refuses and the seq stops moving.
    const over = player.hand.length - (state.rules?.handLimit ?? 7);
    const discardIds = over > 0 ? player.hand.slice(0, over).map(c => c.id) : undefined;
    G.endTurn(state, id, discardIds);
  }
}

/** A fresh module instance per test: the store is a singleton by design. */
async function freshStore() {
  // A query string makes the ESM loader hand back a NEW module instance, so one
  // test's session cannot leak into the next through the singleton.
  const mod = await import(`${url('public/src/state/store.js')}?t=${Math.random()}`);
  return mod;
}

test('the opening broadcast of a game is a first sight', async () => {
  const S = await freshStore();
  const state = newGame('handoff-1');
  const result = S.applyState(broadcast(state, 'AAAA', 'p1'));
  assert.equal(result.fresh, true, 'the very first game a page ever sees is fresh');
  assert.equal(result.snapshot.eventSeq > 0, true, 'a live game has always emitted its deal');
});

test('a continuation broadcast is NOT a first sight', async () => {
  const S = await freshStore();
  const state = newGame('handoff-2');
  const first = S.applyState(broadcast(state, 'AAAA', 'p1'));
  playTurns(state, 2);
  const second = S.applyState(broadcast(state, 'AAAA', 'p1'));
  assert.equal(second.fresh, false, 'the felt is already showing this game');
  assert.ok(second.snapshot.eventSeq > first.snapshot.eventSeq, 'and the game moved');
});

test('the game AFTER a leave or a kick is a first sight — the felt must be emptied', async () => {
  const S = await freshStore();
  const first = newGame('handoff-3a');
  S.applyState(broadcast(first, 'AAAA', 'p1'));
  playTurns(first, 2);
  assert.equal(S.applyState(broadcast(first, 'AAAA', 'p1')).fresh, false);

  // ui/screens.js endSession() — the one teardown behind Leave room, the win
  // overlay's Leave room, a kick, and a dead resume token.
  S.reset();
  assert.equal(S.store.snapshot, null, 'reset() nulls the snapshot');
  assert.equal(S.store.self.id, null, 'and the seat, which belonged to that session');
  assert.equal(S.store.self.name, 'P1', 'the NAME is the player\'s, not the session\'s');

  const second = newGame('handoff-3b');
  const back = S.applyState(broadcast(second, 'BBBB', 'p1'));
  assert.equal(back.fresh, true, 'the second Quick Play of a tab is a game the felt has never shown');
});

test('a rematch restarts eventSeq inside the same room and is a first sight', async () => {
  const S = await freshStore();
  const first = newGame('handoff-4a');
  // Play it out a little, the way any game the host would rematch out of has
  // been: the signal a rematch is recognised by is the sequence going
  // BACKWARDS, and a finished game's seq is hundreds ahead of a fresh deal's.
  playTurns(first, 6);
  S.applyState(broadcast(first, 'AAAA', 'p1'));
  assert.ok(S.store.lastSeq > 10, `the first game got somewhere (seq ${S.store.lastSeq})`);

  // server/handlers.js `rematch` keeps the room and builds a new game, so the
  // sequence goes backwards — the one signal that says "different game, same
  // code". Its cards share no identity with the game that just ended.
  const again = newGame('handoff-4b');
  const result = S.applyState(broadcast(again, 'AAAA', 'p1'));
  assert.equal(result.fresh, true, 'a rematch is a new game on the same felt');
  assert.equal(result.snap, true, 'and it snaps: the event tail before it is meaningless');
});

test('a different room is a first sight', async () => {
  const S = await freshStore();
  const first = newGame('handoff-5a');
  S.applyState(broadcast(first, 'AAAA', 'p1'));
  const other = newGame('handoff-5b');
  assert.equal(S.applyState(broadcast(other, 'CCCC', 'p1')).fresh, true);
});

test('a RECONNECT into the same game is not a first sight — its felt is still true', async () => {
  const S = await freshStore();
  const state = newGame('handoff-6');
  S.applyState(broadcast(state, 'AAAA', 'p1'));
  playTurns(state, 4);
  S.applyState(broadcast(state, 'AAAA', 'p1'));

  // The socket dropped and came back. net/socket.js resumes the seat and the
  // server re-broadcasts the SAME game, further along. Nothing was reset, so
  // every card node on the felt is still the card it says it is: clearing here
  // would throw away the identities the resume exists to preserve.
  playTurns(state, 4);
  const resumed = S.applyState(broadcast(state, 'AAAA', 'p1'), { snap: true });
  assert.equal(resumed.fresh, false, 'a resume is a continuation, not a new game');
  assert.equal(resumed.snap, true);
});

test('a lobby broadcast is never a first sight of a game — there is no game in it', async () => {
  const S = await freshStore();
  const lobby = { type: 'state', code: 'AAAA', phase: 'lobby', players: [], hostId: 'p1', game: null };
  const result = S.applyState(lobby);
  assert.equal(result.fresh, false);
  assert.equal(result.snapshot, null);
});

/* ── the wiring, in the two files that consume the flag ────────────────────
 *
 * The rule above is worth nothing if nobody acts on it, and the acting happens
 * in the DOM, which this suite has no browser for. tools/handoff.mjs measures
 * the consequence; these two assertions only stop the wire being cut silently —
 * a `fresh` nobody reads, or a session teardown that forgets the table again.
 */
test('main.js empties the felt on a first sight, before the job that deals onto it', () => {
  const main = readFileSync(join(__dirname, '..', 'public/src/main.js'), 'utf8');
  assert.match(main, /result\.fresh/, 'main.js must consume store.applyState().fresh');
  const clearAt = main.search(/table\.clear\(\)/);
  const enqueueAt = main.search(/choreographer\.enqueue\(/);
  assert.ok(clearAt > 0, 'the felt has to actually be cleared');
  assert.ok(clearAt < enqueueAt, 'and cleared BEFORE the new game\'s first job is queued');
});

test('ending a session ends the felt with it', () => {
  const screens = readFileSync(join(__dirname, '..', 'public/src/ui/screens.js'), 'utf8');
  const body = screens.slice(screens.indexOf('export function endSession'));
  assert.match(body, /store\.reset\(\)/);
  assert.match(body, /table\.clear\(\)/, 'endSession must empty the table it is leaving');
  assert.match(body, /choreographer\.clear\(\)/, 'and drop the jobs the dead session queued');
});

test('a deliberate new session does not announce itself as an outage', () => {
  const socket = readFileSync(join(__dirname, '..', 'public/src/net/socket.js'), 'utf8');
  const body = socket.slice(socket.indexOf('export function disconnect'), socket.indexOf('function scheduleRetry'));
  assert.match(body, /everOpened = false/,
    'disconnect() ends the connection era, so the next connect is a first open and '
    + 'announceQueue() stays quiet on the Quick Play the player just pressed');
});
