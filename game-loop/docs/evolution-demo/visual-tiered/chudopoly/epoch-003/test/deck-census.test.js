// The discard view's "what's left" panel is only worth having if its arithmetic
// is exact, and it is exact only because the deck's composition is a constant.
// ui/deckcensus.js therefore MIRRORS part of game.js buildDeck(). A mirror
// nobody checks is a lie with a timer on it, so this file checks every number
// in it against the real deck — and checks the derived totals too, which is the
// whole reason most of the census needs no mirror at all.
//
// public/src/ is native ESM (§0.2 — no build step) and this suite is CommonJS,
// so the module is loaded with a dynamic import().

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

const G = require('../game.js');

const load = () => import(pathToFileURL(join(__dirname, '..', 'public/src/ui/deckcensus.js')).href);

/** The real deck, grouped by the census's own kind key. */
async function realCounts() {
  const { kindKey } = await load();
  const out = new Map();
  for (const card of G.buildDeck()) {
    const key = kindKey(card);
    assert.ok(key, `every card must have a census kind: ${JSON.stringify(card)}`);
    out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
}

test('DECK_TOTALS matches game.js buildDeck() exactly, kind for kind', async () => {
  const { DECK_TOTALS } = await load();
  const real = await realCounts();
  const claimed = new Map(DECK_TOTALS);

  for (const [key, n] of real) {
    assert.equal(claimed.get(key), n, `${key}: census says ${claimed.get(key)}, deck has ${n}`);
  }
  for (const [key, n] of claimed) {
    assert.equal(real.get(key), n, `${key}: census invents ${n} cards the deck does not have`);
  }
});

test('DECK_SIZE is the authoritative 106 (§10 card conservation)', async () => {
  const { DECK_SIZE } = await load();
  assert.equal(DECK_SIZE, G.buildDeck().length);
  assert.equal(DECK_SIZE, 106);
});

test('every mirrored constant is the deck\'s own number', async () => {
  const { MONEY_COUNTS, WILD_COUNTS, RENT_PAIRS } = await load();
  const deck = G.buildDeck();

  const money = {};
  for (const c of deck) if (c.type === 'money') money[c.value] = (money[c.value] || 0) + 1;
  assert.deepEqual({ ...MONEY_COUNTS }, money);

  const wild = {};
  for (const c of deck) {
    if (c.type !== 'wild_property') continue;
    const k = c.colors[0] === 'any' ? 'any' : c.colors.slice().sort().join('|');
    wild[k] = (wild[k] || 0) + 1;
  }
  assert.deepEqual({ ...WILD_COUNTS }, wild);

  // The five colour-pair rents, as pairs (order-insensitive).
  const pairs = new Set();
  for (const c of deck) {
    if (c.type === 'rent' && c.colors[0] !== 'any') pairs.add(c.colors.slice().sort().join('|'));
  }
  assert.deepEqual(
    RENT_PAIRS.map(p => p.slice().sort().join('|')).sort(),
    [...pairs].sort());
});

test('census() conserves cards over a real seeded game', async () => {
  const { census, DECK_SIZE } = await load();
  const { runGame } = require('../simulate.js');
  const cfg = [{ mode: 'balanced', name: 'A' }, { mode: 'aggressive', name: 'B' },
    { mode: 'conservative', name: 'C' }];

  // Sample the view at every turn end of a few real games: the census must
  // account for all 106 cards from every seat's point of view, always.
  const origEnd = G.endTurn;
  let checked = 0;
  G.endTurn = function patched(state, ...rest) {
    const r = origEnd.call(this, state, ...rest);
    if (state && state.phase === 'playing') {
      for (const p of state.players) {
        const view = G.getPlayerView(state, p.id);
        const c = census(view, p.id);
        assert.equal(c.gone + c.visible + c.unseen, DECK_SIZE,
          `card conservation broke in the census: ${c.gone}+${c.visible}+${c.unseen}`);
        assert.equal(c.unseen, c.deckCount + c.hiddenHands,
          'unseen must be exactly deck + hidden hands');
        for (const g of c.groups) {
          for (const row of g.rows) {
            assert.ok(row.live >= 0 && row.gone >= 0 && row.live + row.gone <= row.total,
              `${row.key}: gone ${row.gone} + live ${row.live} > total ${row.total}`);
          }
        }
        checked++;
      }
    }
    return r;
  };
  try {
    for (let seed = 1; seed <= 3; seed++) runGame(cfg, 300, seed);
  } finally {
    G.endTurn = origEnd;
  }
  assert.ok(checked > 50, `expected many samples, got ${checked}`);
});
