const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMessage } = require('../server/protocol');
const G = require('../game');
const Bot = require('../bot');

test('rejects non-object, unknown, and malformed commands', () => {
  assert.equal(validateMessage(null).ok, false);
  assert.equal(validateMessage([]).ok, false);
  assert.equal(validateMessage({ type:'nope' }).ok, false);
  assert.equal(validateMessage({ type:'chat', text:7, scope:'global' }).ok, false);
  assert.equal(validateMessage({ type:'join_room', code:{}, name:'Ace' }).ok, false);
  assert.equal(validateMessage({ type:'create_room', name:'<img>' }).ok, false);
});

test('requires private reconnect credentials', () => {
  const playerId = '902ac21e-0feb-4d88-877c-1f17ad62ef00';
  const resumeToken = 'a'.repeat(43);
  assert.equal(validateMessage({ type:'reconnect', code:'ABCD', playerId }).ok, false);
  assert.equal(validateMessage({ type:'reconnect', code:'ABCD', playerId, resumeToken }).ok, true);
});

test('rejects duplicate card selections at the protocol boundary', () => {
  assert.equal(validateMessage({ type:'respond', response:'accept', paymentCards:[1, 1] }).ok, false);
  assert.equal(validateMessage({ type:'end_turn', discardIds:[4, 4] }).ok, false);
  assert.equal(validateMessage({ type:'respond', response:'accept', paymentCards:[1, 2] }).ok, true);
});

test('accepts supported product commands', () => {
  assert.equal(validateMessage({ type:'quick_play', name:'Maverick' }).ok, true);
  assert.equal(validateMessage({ type:'start_game', turnTimeout:60, responseTimeout:30 }).ok, true);
  assert.equal(validateMessage({ type:'rematch' }).ok, true);
});

// Both clocks are optional: absent means "the host did not say" and the server supplies the
// default (60s turn, 45s answer). Only "absent" is forgiving — a malformed value is still a
// hard refusal, because silently clamping a typo leaves a table on a setting nobody chose.
test('start_game clocks are optional but never sloppy', () => {
  assert.equal(validateMessage({ type:'start_game' }).ok, true, 'both omitted');
  assert.equal(validateMessage({ type:'start_game', turnTimeout:60 }).ok, true, 'answer clock omitted');
  assert.equal(validateMessage({ type:'start_game', responseTimeout:45 }).ok, true, 'turn clock omitted');
  assert.equal(validateMessage({ type:'start_game', responseTimeout:0 }).ok, true, 'explicit OFF is legal');
  for (const bad of [{ responseTimeout:121 }, { responseTimeout:-1 }, { responseTimeout:45.5 },
    { responseTimeout:'45' }, { responseTimeout:null }, { turnTimeout:301 }, { turnTimeout:'x' }]) {
    assert.equal(validateMessage({ type:'start_game', ...bad }).ok, false, JSON.stringify(bad));
  }
});

// `set_rules` only announces the ruleset the lobby is about to launch, so it must accept
// EXACTLY what start_game accepts — anything narrower and the picker could show a ruleset
// start_game then refuses; anything wider and the picker could show one it cannot launch.
test('set_rules accepts exactly the rule fields start_game accepts', () => {
  assert.equal(validateMessage({ type:'set_rules' }).ok, true, 'all fields optional');
  for (const good of [{ preset:'blitz' }, { preset:'mdFaithful', setsToWin:5 },
    { winRule:'instant' }, { setsToWin:4 }, { pureSetRequired:true }, { passGoRestartsTurn:false }]) {
    assert.equal(validateMessage({ type:'set_rules', ...good }).ok, true, JSON.stringify(good));
    assert.equal(validateMessage({ type:'start_game', ...good }).ok, true, `start_game ${JSON.stringify(good)}`);
  }
  for (const bad of [{ preset:'cheat' }, { winRule:'sudden_death' }, { setsToWin:2 }, { setsToWin:'3' },
    { pureSetRequired:'yes' }, { passGoRestartsTurn:1 }]) {
    assert.equal(validateMessage({ type:'set_rules', ...bad }).ok, false, JSON.stringify(bad));
    assert.equal(validateMessage({ type:'start_game', ...bad }).ok, false, `start_game ${JSON.stringify(bad)}`);
  }
  // It carries no clocks, no ids and no state: extra keys are ignored, never acted on.
  assert.equal(validateMessage({ type:'set_rules', turnTimeout:'nonsense' }).ok, true);
});

test('a wild rent carrying a targetId passes validation', () => {
  const targetId = '902ac21e-0feb-4d88-877c-1f17ad62ef00';
  assert.equal(validateMessage({ type:'play_action', cardIndex:2, targetColor:'brown', targetId }).ok, true);
  assert.equal(validateMessage({ type:'play_action', cardIndex:2, targetColor:'brown', targetId:'nope!' }).ok, false);
  assert.equal(validateMessage({ type:'play_action', cardIndex:2, targetColor:'purple' }).ok, false);
});

/* ── §10 invariant: events leak nothing getPlayerView hides ──────────── */

function collectCardIds(node, out = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) collectCardIds(item, out);
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'number' && (key === 'id' || /CardId$/.test(key))) out.add(value);
      else collectCardIds(value, out);
    }
  }
  return out;
}

function hiddenHandIds(state, viewerId) {
  const ids = new Set();
  for (const player of state.players) {
    if (player.id === viewerId) continue;
    for (const card of player.hand) ids.add(card.id);
  }
  return ids;
}

function assertNoLeak(state) {
  for (const viewer of state.players) {
    const view = G.getPlayerView(state, viewer.id);
    const hidden = hiddenHandIds(state, viewer.id);

    // The SNAPSHOT must never place another player's hand card in a visible zone.
    // `events` is scanned separately below: it is a log of things that were public WHEN
    // THEY HAPPENED, and after a reshuffle a publicly-played card legitimately returns to
    // somebody's hand. "p1 played PCS Orders 40 turns ago" does not say where it is now.
    const exposed = collectCardIds({ ...view, events: [] });
    for (const id of hidden) {
      assert.equal(exposed.has(id), false,
        `card ${id} is in another player's hand but appears in ${viewer.id}'s view`);
    }

    // §4/§10 redaction rule: only the drawer's own draw/deal events may carry card ids.
    for (const event of view.events) {
      if ((event.t === 'draw' || event.t === 'deal') && event.to !== viewer.id) {
        assert.equal(event.cards, undefined,
          `${event.t} event for ${event.to} leaked card ids to ${viewer.id}`);
      }
    }
    // own hand is visible, other hands are counts only
    for (const p of view.players) {
      if (p.id === viewer.id) assert.ok(Array.isArray(p.hand));
      else assert.equal(p.hand, undefined);
    }
  }
}

// Drives a fully seeded bot game and audits every intermediate state.
function playSeededGame(seed, audit) {
  const modes = ['neutral', 'aggressive', 'conservative', 'chud'];
  const players = modes.map((m, i) => ({ id: 'p' + i, name: 'Bot' + i }));
  const state = G.createGame(players, { seed });
  Bot._internal.setRng(G.makeRng('bot:' + seed));
  const modeOf = id => modes[Number(id.slice(1))];

  for (let step = 0; step < 4000 && state.phase === 'playing'; step++) {
    audit(state);
    const responder = Bot._internal.findResponder(state);
    if (responder) { Bot._internal.botRespondSync(state, responder, modeOf(responder)); continue; }
    const cp = G.currentPlayer(state);
    if (state.turnPhase === 'draw') { G.drawCards(state); continue; }
    const action = Bot._internal.decideBotPlay(state, cp.id, modeOf(cp.id));
    if (action) {
      // Through the bot's own executor, not a private copy of its switch: §3.8's free
      // rearrange is a decision type this helper had no case for, so it fell through to
      // playAction(), was refused, and the game never reached an ending.
      Bot._internal.applyBotAction(state, cp.id, action);
      continue;
    }
    const discard = cp.hand.length > 7
      ? Bot._internal.chooseDiscards(cp, cp.hand.length - 7, modeOf(cp.id)) : undefined;
    const ended = G.endTurn(state, cp.id, discard);
    if (ended.error) break;
  }
  Bot._internal.setRng(null);
  return state;
}

test('no view ever exposes a card that is in another hand', () => {
  const state = playSeededGame('leak-audit', assertNoLeak);
  assert.equal(state.phase, 'finished');
  assert.deepEqual(G.validateState(state), { ok: true });
  assert.ok(state.eventSeq > 50, 'the audited game actually produced events');
});

test('draw and deal events carry card ids only for the drawer', () => {
  const players = [{ id:'p1', name:'One' }, { id:'p2', name:'Two' }];
  const state = G.createGame(players, { seed: 'redact' });
  G.drawCards(state);

  const mine = G.getPlayerView(state, 'p1').events;
  const theirs = G.getPlayerView(state, 'p2').events;
  const own = mine.filter(e => (e.t === 'deal' || e.t === 'draw') && e.to === 'p1');
  const foreign = theirs.filter(e => (e.t === 'deal' || e.t === 'draw') && e.to === 'p1');

  assert.ok(own.length >= 2);
  assert.equal(own.length, foreign.length);
  for (const ev of own) assert.equal(ev.cards.length, ev.count);
  for (const ev of foreign) {
    assert.equal(ev.cards, undefined);
    assert.ok(Number.isInteger(ev.count));
  }
  // Redaction must not mutate the stored event stream.
  assert.ok(state.events.filter(e => e.t === 'deal').every(e => Array.isArray(e.cards)));
});

test('the broadcast event tail is capped and sequence numbers are monotonic', () => {
  const state = playSeededGame('tail-cap', () => {});
  const view = G.getPlayerView(state, 'p0');
  assert.ok(view.events.length <= G.EVENT_TAIL);
  assert.equal(view.eventSeq, state.eventSeq);
  const seqs = view.events.map(e => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
  assert.equal(seqs[seqs.length - 1], state.eventSeq);
});
