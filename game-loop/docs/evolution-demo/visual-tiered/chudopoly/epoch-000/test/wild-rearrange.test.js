// test/wild-rearrange.test.js — §3.8, the free wild rearrange, engine vs client.
//
// Owner report, live play: "wild cards sometimes it doesnt let me swap them
// properly when it should". Reproduced, and the "sometimes" had a name.
//
// game.js moveProperty() (1971-1984) tests FOUR things before it moves a wild:
// the game is playing, it is your turn, `turnPhase === 'play'`, and the per-turn
// rearrange budget. `playsRemaining` is deliberately NOT one of them — a
// rearrange costs no play, which is the whole of §3.8.
//
// The client gated both routes to that move on `canPlay()`, which DOES carry
// `playsRemaining > 0`. So on every turn whose three plays were spent — the
// common case, and a state the engine sits in until End Turn — a wild on your
// own board would not drag (dragCandidate returned null) and a tap fell through
// to the rules sheet with no refusal at all, while the server would have
// accepted the identical move. MEASURED with playwright on tools/fixtures/
// mid-game.json with `playsRemaining: 0`: all three board wilds dead on the tap
// route AND the drag route, zero `move_property` frames sent.
//
// public/src/ is native ESM (§0.2 — no build step) and this suite is CommonJS,
// so the client modules load through a dynamic import(), the same way
// test/placement-advice.test.js does.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

const G = require('../game.js');

const url = (p) => pathToFileURL(join(__dirname, '..', p)).href;
const loadStore = () => import(url('public/src/state/store.js'));
const loadSel = () => import(url('public/src/state/selectors.js'));

const COLOR_KEYS = Object.keys(G.COLORS);

/* ── engine fixtures ───────────────────────────────────────────────────── */

function fresh(seed = 'rearrange') {
  const state = G.createGame(
    [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }],
    { seed },
  );
  state.deck = G.buildDeck();
  state.discardPile = [];
  state.pendingAction = null;
  state.players.forEach(p => { p.hand = []; p.bank = []; p.properties = {}; p.upgrades = {}; });
  state.turnPhase = 'play';
  state.currentPlayerIndex = 0;
  state.playsRemaining = 3;
  state.cardTotal = null;
  state._handSnapshot = 0;
  return state;
}

function take(state, predicate) {
  const i = state.deck.findIndex(predicate);
  assert.notEqual(i, -1, 'expected card in deck');
  return state.deck.splice(i, 1)[0];
}

function putProperty(state, player, color) {
  const card = take(state, c => c.type === 'property' && c.color === color);
  (player.properties[color] ||= []).push({ ...card, placedColor: color });
  return card;
}

function putWild(state, player, color, pick) {
  const card = take(state, c => c.type === 'wild_property' && pick(c));
  (player.properties[color] ||= []).push({ ...card, placedColor: color });
  return card;
}

const anyWild = (c) => c.colors[0] === 'any';
const pairWild = (a, b) => (c) => c.colors[0] !== 'any'
  && c.colors.includes(a) && c.colors.includes(b);

/* ── 1. the engine's own contract ──────────────────────────────────────── */

test('§3.8 — a rearrange costs no play, so playsRemaining 0 does not block it', () => {
  const state = fresh();
  const [a] = state.players;
  const wild = putWild(state, a, 'green', pairWild('green', 'darkblue'));
  state.playsRemaining = 0;

  assert.deepEqual(G.moveProperty(state, 'p1', wild.id, 'darkblue'), { ok: true },
    'the engine moves a wild with every play spent — the client must not disagree');
  assert.equal(state.playsRemaining, 0, 'and it still costs no play');
  assert.equal(G.getPlayerView(state, 'p1').playsRemaining, 0,
    'the state the client sees is exactly the one it refused to act on');
});

test('the rearrange window is the four things moveProperty() actually tests', () => {
  const probe = (mutate) => {
    const state = fresh();
    const [a] = state.players;
    const wild = putWild(state, a, 'green', pairWild('green', 'darkblue'));
    mutate(state);
    return G.moveProperty(state, 'p1', wild.id, 'darkblue');
  };
  assert.deepEqual(probe(() => {}), { ok: true });
  assert.deepEqual(probe(s => { s.playsRemaining = 0; }), { ok: true }, 'plays are not the gate');
  assert.match(probe(s => { s.phase = 'finished'; }).error, /finished/);
  assert.match(probe(s => { s.currentPlayerIndex = 1; }).error, /Not your turn/);
  assert.match(probe(s => { s.turnPhase = 'action_response'; }).error, /Cannot rearrange now/);
  assert.match(probe(s => { s.rearrangesRemaining = 0; }).error, /No free rearranges left/);
});

/* ── 2. the client's window is the same window ─────────────────────────── */

/** Put one snapshot in front of the selectors, shaped like getPlayerView(). */
async function stage(state, selfId = 'p1') {
  const { store } = await loadStore();
  const view = G.getPlayerView(state, selfId);
  store.self = { id: selfId, name: 'P1' };
  store.snapshot = view;
  return view;
}

test('canRearrange() mirrors moveProperty(), including at playsRemaining 0', async () => {
  const sel = await loadSel();
  const build = () => {
    const state = fresh();
    const [a] = state.players;
    const wild = putWild(state, a, 'green', pairWild('green', 'darkblue'));
    return { state, wild };
  };

  // The regression itself.
  {
    const { state } = build();
    state.playsRemaining = 0;
    await stage(state);
    assert.equal(sel.canPlay(), false, 'fixture assumption: canPlay() is false here');
    assert.equal(sel.canRearrange(), true,
      'a spent play must not weld a wild to its mat — this is the reported bug');
    assert.equal(sel.rearrangeWindowOpen(), true);
  }

  // Every case the engine refuses, the client refuses too, in the same words.
  const cases = [
    [s => { s.currentPlayerIndex = 1; }, /turn/],
    [s => { s.turnPhase = 'action_response'; }, /cannot rearrange right now/i],
    [s => { s.rearrangesRemaining = 0; }, /No free rearranges left/],
  ];
  for (const [mutate, re] of cases) {
    const { state, wild } = build();
    mutate(state);
    await stage(state);
    assert.equal(sel.canRearrange(), false, `client should refuse: ${re}`);
    assert.match(sel.cannotRearrangeReason(), re);
    assert.ok(G.moveProperty(state, 'p1', wild.id, 'darkblue').error,
      'and the engine refuses the same state');
  }
});

test('a snapshot with no rearrange budget field reads as a FULL allowance', async () => {
  const sel = await loadSel();
  const { store } = await loadStore();
  const state = fresh();
  putWild(state, state.players[0], 'green', pairWild('green', 'darkblue'));
  const view = G.getPlayerView(state, 'p1');
  delete view.rearrangesRemaining;              // an older recorded fixture / server
  store.self = { id: 'p1', name: 'P1' };
  store.snapshot = view;
  assert.equal(sel.canRearrange(), true,
    'game.js rearrangesLeft() defaults to the full budget; the client must not invent a refusal');
});

/* ── 3. what the mats offer IS what the engine accepts ─────────────────── */

/** Every colour game.js will actually take this card to, probed one at a time
 *  on a clone so no probe can leave the board changed for the next one. */
function engineAccepts(state, cardId) {
  const out = [];
  for (const color of COLOR_KEYS) {
    const clone = JSON.parse(JSON.stringify(state));
    if (G.moveProperty(clone, 'p1', cardId, color).ok) out.push(color);
  }
  return out;
}

test('boardMoveTarget() offers exactly the colours moveProperty() accepts', async () => {
  const sel = await loadSel();

  /* Each board below is one hypothesis about the reported bug, and every one of
   * them is reachable in a real game (§0.7):
   *   full-zone     §3.5's cap — a wild may not move into a zone already at size
   *   complete-set  a wild LEAVING a complete set (§3.8 says it may; it is your
   *                 own property, and the client must not quietly protect it)
   *   rainbow       the 'any' wild, whose legal set is every colour
   *   pair          a two-colour wild, whose legal set is two
   *   upgrade       an Upgrade/FOC, which is NOT a property and moves under
   *                 §3.1b's completely different rule through the same command
   */
  const boards = {
    'pair wild, both zones open': (s, a) => {
      const w = putWild(s, a, 'green', pairWild('green', 'darkblue'));
      return w.id;
    },
    'pair wild, the other zone FULL (§3.5)': (s, a) => {
      const w = putWild(s, a, 'green', pairWild('green', 'darkblue'));
      putProperty(s, a, 'darkblue');
      putProperty(s, a, 'darkblue');                    // darkblue is size 2 → full
      return w.id;
    },
    'pair wild inside a COMPLETE set (§3.8 — it may still leave)': (s, a) => {
      const w = putWild(s, a, 'darkblue', pairWild('green', 'darkblue'));
      putProperty(s, a, 'darkblue');                    // darkblue complete, 2/2
      return w.id;
    },
    'rainbow wild on a board with two full zones': (s, a) => {
      const w = putWild(s, a, 'red', anyWild);
      putProperty(s, a, 'darkblue');
      putProperty(s, a, 'darkblue');                    // full
      putProperty(s, a, 'intel');
      putProperty(s, a, 'intel');                       // full
      putProperty(s, a, 'brown');                       // 1/2, room
      return w.id;
    },
    'rainbow wild alone in its own zone': (s, a) => {
      const w = putWild(s, a, 'base', anyWild);
      return w.id;
    },
    'an Upgrade between complete sets (§3.1b, NOT a property)': (s, a) => {
      putProperty(s, a, 'darkblue');
      putProperty(s, a, 'darkblue');
      putProperty(s, a, 'intel');
      putProperty(s, a, 'intel');
      const up = take(s, c => c.type === 'action' && c.action === 'upgrade');
      (a.upgrades.darkblue ||= []).push({ ...up, upgradeType: 'house', placedColor: 'darkblue' });
      return up.id;
    },
  };

  let compared = 0;
  for (const [name, build] of Object.entries(boards)) {
    for (const plays of [3, 0]) {
      const state = fresh();
      const cardId = build(state, state.players[0]);
      state.playsRemaining = plays;
      await stage(state);

      const client = (sel.boardMoveTarget(cardId)?.colors || []).slice().sort();
      const engine = engineAccepts(state, cardId).sort();
      assert.deepEqual(client, engine,
        `${name} @ ${plays} plays — client offers [${client}], engine accepts [${engine}]`);
      compared++;
    }
  }
  // A gate that measured nothing must not pass (§8).
  assert.equal(compared, Object.keys(boards).length * 2);
  assert.ok(compared >= 12, `only ${compared} boards compared`);
});

test('the offer is non-trivial: these boards really do refuse some colours', async () => {
  const sel = await loadSel();
  const state = fresh();
  const [a] = state.players;
  const wild = putWild(state, a, 'green', pairWild('green', 'darkblue'));
  putProperty(state, a, 'darkblue');
  putProperty(state, a, 'darkblue');
  await stage(state);
  // Nowhere to go: green is the source, darkblue is full. If this ever comes
  // back non-empty the comparison above is comparing two empty lists.
  assert.deepEqual(sel.boardMoveTarget(wild.id).colors, []);
  assert.ok(G.moveProperty(state, 'p1', wild.id, 'darkblue').error);
});

/* ── 4. neither route may re-grow a playsRemaining gate ────────────────── */

test('the board-card entry points are gated on the rearrange window, not on plays', () => {
  const src = readFileSync(join(__dirname, '..', 'public/src/interact/index.js'), 'utf8');

  // beginMove() — the tap route's entry, and dropCommit()'s 'move' branch.
  const beginMove = src.slice(src.indexOf('export function beginMove'));
  const beginBody = beginMove.slice(0, beginMove.indexOf('\n}\n'));
  assert.match(beginBody, /sel\.canRearrange\(\)/);
  assert.doesNotMatch(beginBody, /sel\.canPlay\(\)/,
    'beginMove() must not ask canPlay() — §3.8 costs no play');

  // dragCandidate() — the drag route's entry. Its HAND branch keeps canPlay();
  // only the board branch is a rearrange.
  const dragCand = src.slice(src.indexOf('export function dragCandidate'));
  const dragBody = dragCand.slice(0, dragCand.indexOf('\n}\n'));
  const boardBranch = dragBody.slice(dragBody.indexOf('boardMoveTarget'));
  assert.match(boardBranch, /sel\.canRearrange\(\)/);
  assert.doesNotMatch(boardBranch, /sel\.canPlay\(\)/,
    'a board card is picked up under the rearrange window, not the play window');
});

/* ── 5. a mat drawn as refused must not resolve to a different mat ──────────
 *
 * The second defect this round found, and the worse of the two: aiming a wild
 * at a FULL zone did not refuse, it moved the card somewhere else. drag.js
 * resolve() falls through to a 120px snap radius, the mats are a ten-cell grid,
 * and markIllegal() had already painted the aimed-at mat as illegal.
 * MEASURED on the mid-game fixture, rainbow wild #28 released dead centre on a
 * complete 2/2 Command set: `{"type":"move_property","cardId":28,
 * "toColor":"lightblue"}` — a real move to a colour the player never chose.
 *
 * Neither half of the fix can run under node:test (drag.js needs a live pointer,
 * dropRefusal() reaches through table/ into the DOM), so what is pinned here is
 * the ORDERING that makes it work; the behaviour is measured with playwright.
 */
test('drop resolution refuses an illegal mat BEFORE hysteresis or the snap radius', () => {
  const src = readFileSync(join(__dirname, '..', 'public/src/interact/drag.js'), 'utf8');
  const resolveFn = src.slice(src.indexOf('function resolve(x, y)'));
  const body = resolveFn.slice(0, resolveFn.indexOf('\nfunction hover('));

  const guard = body.indexOf("data-drop-illegal");
  const hysteresis = body.indexOf('live.snap + HOLD_SLACK');
  const snap = body.indexOf('dist <= live.snap');
  assert.ok(guard > 0, 'resolve() must consult the mats it drew as illegal');
  assert.ok(hysteresis > 0 && snap > 0, 'fixture assumption: both forgiving steps still exist');
  assert.ok(guard < hysteresis, 'the illegal-mat guard must precede the hysteresis hold');
  assert.ok(guard < snap, 'the illegal-mat guard must precede the snap radius');

  // Scoped: a card whose meaning over my board is "bank it" still routes there.
  assert.match(body, /rank === 0 && t\.el\.classList\?\.contains\('propcol'\)/,
    'the guard only applies to a plan that is choosing a colour');

  // And the refusal is spoken, not swallowed (§P7.3).
  assert.match(src, /api\?\.dropRefusal\?\./, 'a refused mat asks the machine for its sentence');
});

/* ── 5b. the held card rides ABOVE the table, and one mat was stopping it ───
 *
 * Owner, live: "when dragging cards between base sets it doesnt overlap over
 * them so it goes underneath and looks jarring/offputting." ART §5 puts the held
 * card above the table; `interact.css .card.is-dragging { z-index: 60 }` says so.
 *
 * MEASURED at 1280×720 under real CDP, a rainbow wild dragged out of a full
 * Elite Programs mat across a full Command mat. Ancestors of the held card that
 * establish a stacking context:
 *
 *   ["div.propcol[green] → filter: saturate(0.5) + opacity: 0.55",
 *    "div#self-board → z-index: 1"]
 *
 * and `document.elementFromPoint` at the held card's own centre returned
 * `card#20` — a card in the mat it was crossing — at 9 of 9 sample points.
 *
 * The card NEVER LEAVES THE MAT IT WAS PICKED UP FROM: table.liftCard() opens
 * the clipping ancestor chain and deliberately does not reparent. So any
 * treatment on that mat that makes it a stacking context resolves `z-index: 60`
 * against the mat's own children instead of against the table, and the mat
 * itself — `position: relative; z-index: auto` — paints at the z-index-0 step of
 * #self-board in TREE ORDER. Every mat later in document order drew over it.
 *
 * TWO declarations were doing it, both on the source column and neither about
 * it: `[data-drop-illegal]`'s opacity+filter (markIllegal() marked the column
 * the card came FROM, which is not an illegal target — it is home, and
 * resolve() step 0 already treats a release there as a change of mind), and
 * `[data-drop-source]`'s own `filter: saturate(.5)`.
 *
 * The behaviour is measured under real input by tools/dragtest.mjs §B, which
 * also fails when the held card overlaps no other card — a paint-order gate that
 * flies over bare felt has measured nothing. What is pinned here is the pair of
 * facts that make it hold, because both are one careless edit away from coming
 * back.
 */
test('the column a card was picked up from is not marked illegal', () => {
  const src = readFileSync(join(__dirname, '..', 'public/src/interact/drag.js'), 'utf8');
  const fn = src.slice(src.indexOf('function markIllegal(plan)'));
  const body = fn.slice(0, fn.indexOf('\n/**', 1));
  assert.match(body, /const source = live\?\.node\?\.closest\?\.\('\.propcol'\)/,
    'markIllegal must know which column the held card is still sitting in');
  assert.match(body, /col !== source && !legal\.has\(col\)/,
    'home is not a refusal — and the illegal treatment is a stacking context');
});

test('no treatment on a .propcol may trap the held card inside it', () => {
  const css = readFileSync(join(__dirname, '..', 'public/style/interact.css'), 'utf8');

  // The rule for the column a wild is LEAVING is the one the held card is
  // inside. It may not carry any property that creates a stacking context.
  const start = css.indexOf('.propcol[data-drop-source="1"] {');
  assert.ok(start > 0, 'fixture assumption: the drop-source rule still exists');
  const block = css.slice(start, css.indexOf('}', start));
  for (const prop of ['filter', 'opacity', 'transform', 'isolation', 'mix-blend-mode',
    'backdrop-filter', 'will-change', 'contain', 'perspective']) {
    assert.doesNotMatch(block, new RegExp(`(^|[;{\\s])${prop}\\s*:`),
      `.propcol[data-drop-source] must not set ${prop} — it makes the mat a stacking `
      + 'context and z-index 60 on the held card stops meaning anything');
  }
  // The desaturation is not deleted, it is moved onto what is left behind.
  assert.match(css, /\.propcol\[data-drop-source="1"\] \.card:not\(\.is-dragging\)\s*\{[^}]*filter/,
    'the departure still reads: the mat\'s RESTING cards desaturate');

  // And `.card.is-dragging` is still the thing that claims the top of the table.
  assert.match(css, /\.card\.is-dragging \{[\s\S]*?z-index: 60/);
});

test('the machine answers "why that mat" for both routes', () => {
  const src = readFileSync(join(__dirname, '..', 'public/src/interact/index.js'), 'utf8');
  assert.match(src, /export function dropRefusal\(cardId, color\)/);
  assert.match(src, /drag\.mount\(\{[^}]*dropRefusal[^}]*\}\)/,
    'drag.js must be handed the same answer the tap route uses');
  // The tap route: pointer.js sends a tap on a non-targetable mat to the CARD
  // inside it, so the machine has to notice the colour step and answer there.
  const tapBlock = src.slice(src.indexOf('pointer.onCardTap'));
  assert.match(tapBlock.slice(0, tapBlock.indexOf('pointer.registerActions')),
    /mode\.needs\[0\] === 'myColor'[\s\S]*dropRefusal/,
    'a tap on a refused column of my own must say why, not open the rules sheet');
});

test('every sentence dropRefusal can print is one the engine would have sent', () => {
  // The strings are hand-mirrored, so they are pinned against game.js here the
  // same way core/cards.js is pinned against the COLORS table.
  const client = readFileSync(join(__dirname, '..', 'public/src/interact/index.js'), 'utf8');
  const engine = readFileSync(join(__dirname, '..', 'game.js'), 'utf8');
  assert.match(client, /already holds a full set \(\$\{size\}\)/);
  assert.match(engine, /already holds a full set \('/,
    'game.js moveProperty() is still the source of that sentence');

  // And it is really the sentence the engine produces, word for word.
  const state = fresh();
  const [a] = state.players;
  const wild = putWild(state, a, 'green', pairWild('green', 'darkblue'));
  putProperty(state, a, 'darkblue');
  putProperty(state, a, 'darkblue');
  assert.equal(G.moveProperty(state, 'p1', wild.id, 'darkblue').error,
    'Command already holds a full set (2)');
});

/* ── 4. a swap is only ever offered where a MOVE cannot go ─────────────────
 *
 * Owner, live play, on the round that shipped the atomic swap: "its literally
 * forcing a swap ... when they were literally on the board".
 *
 * swapColors() — which decides what to MARK — always required `zoneFull`.
 * interact/index.js's pick() calls swapPartners() to decide WHICH COMMAND to
 * send, and swapPartners() did not. So a wild dropped into a zone with room
 * that happened to hold a compatible wild was dispatched as a swap: two cards
 * moved and two rearranges spent for a gesture that meant "put this here". The
 * mats looked like an ordinary move right up until it was not one.
 *
 * The invariant is the one selectors.js already states for swapColors: the
 * client OFFERS a swap only where a plain move cannot get there, so
 * offer ⊆ accept in the direction §0.1 requires. */

test('a zone with room offers NO swap partners — the move is the right command', async () => {
  const state = fresh();
  const [a] = state.players;
  // darkblue holds 2 of 3 — room to spare — and one of them is a wild that
  // could legally travel back to green. Before the fix this returned a partner.
  const mover = putWild(state, a, 'green', pairWild('green', 'darkblue'));
  putWild(state, a, 'darkblue', anyWild);   // a rainbow is legal in green, so it IS a partner
  assert.ok(!G.zoneFull(a, 'darkblue'), 'the fixture must leave the zone with room');

  const sel = await loadSel();
  await stage(state);

  assert.deepEqual(sel.swapPartners(mover.id, 'darkblue'), [],
    'a zone with room must offer no swap — pick() reads this to choose the command');
  assert.ok(sel.moveColors(mover).includes('darkblue'),
    'and the plain move is still offered, which is what the player meant');
  assert.deepEqual(G.moveProperty(state, 'p1', mover.id, 'darkblue'), { ok: true },
    'the engine agrees the move is legal, so the client must not send a swap');
});

test('a FULL zone still offers the swap that §3.5 makes otherwise impossible', async () => {
  const state = fresh();
  const [a] = state.players;
  const mover = putWild(state, a, 'green', pairWild('green', 'darkblue'));
  putProperty(state, a, 'darkblue');
  const partner = putWild(state, a, 'darkblue', anyWild);
  assert.ok(G.zoneFull(a, 'darkblue'), 'darkblue must be full for this to be the swap case');

  const sel = await loadSel();
  await stage(state);

  assert.deepEqual(sel.swapPartners(mover.id, 'darkblue').map(c => c.id), [partner.id],
    'the deadlock case still offers its one partner');
  assert.ok(!sel.moveColors(mover).includes('darkblue'),
    'and the plain move is refused there, which is why the swap exists at all');
});
