// The wild-placement decision support (state/selectors.js placementAdvice).
//
// The whole feature is a claim about arithmetic: each mat, during a `myColor`
// step, prints the rent row you would land on. A readout that is right most of
// the time is worse than no readout, because a player stops checking. So this
// file pins the two things that can quietly rot:
//
//   1. the client's rentFor() IS game.js calcRent(), for every colour, every
//      count and every upgrade combination. `rentFor` is a hand-written mirror
//      (core/cards.js says so at the top) and the engine is mid-gauntlet.
//   2. placementAdvice() reads its ladder THROUGH that function rather than off
//      `COLORS[color].rent`. That is the exact bug the feature was specified
//      against — a naive implementation ignores the +3/+4 an Upgrade and an FOC
//      add and prints a rent the engine will not charge.
//
// public/src/ is native ESM (§0.2 — no build step) and this suite is CommonJS,
// so the modules are loaded with a dynamic import().

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

const G = require('../game.js');

const url = (p) => pathToFileURL(join(__dirname, '..', p)).href;
const loadCards = () => import(url('public/src/core/cards.js'));
const loadStore = () => import(url('public/src/state/store.js'));
const loadSel = () => import(url('public/src/state/selectors.js'));

/** A bare player the engine and the client will both accept. */
function player(props = {}, upgrades = {}) {
  return { id: 'me', properties: { ...props }, upgrades: { ...upgrades }, bank: [], hand: [] };
}

const prop = (color) => ({ id: 0, type: 'property', color, value: 1, name: color });
const wild = (colors) => ({ id: 0, type: 'wild_property', colors, value: 0, name: 'wild' });
const many = (color, n, make = prop) => Array.from({ length: n }, (_, i) => ({ ...make(color), id: i + 1 }));

/** Put a snapshot with one seat (me) in front of the selectors. */
async function stage(me, rules = {}, extra = {}) {
  const { store } = await loadStore();
  store.self = { id: 'me', name: 'me' };
  store.snapshot = {
    phase: 'playing', turnPhase: 'play', currentPlayerId: 'me', playsRemaining: 3,
    players: [me], rules, ...extra,
  };
  return store;
}

test('rentFor() is calcRent(), colour by colour, count by count, upgrade by upgrade', async () => {
  const { COLORS, COLOR_KEYS, rentFor } = await loadCards();
  let checked = 0;
  for (const color of COLOR_KEYS) {
    const size = COLORS[color].size;
    for (let n = 0; n <= size; n++) {
      for (const ups of [[], ['house'], ['house', 'hotel']]) {
        const p = player({ [color]: many(color, n) }, { [color]: ups });
        assert.equal(
          rentFor(p, color), G.calcRent(p, color),
          `${color} ${n}/${size} with [${ups}]: client says ${rentFor(p, color)}, engine says ${G.calcRent(p, color)}`,
        );
        checked++;
      }
    }
  }
  // A gate that measured nothing must not pass (§8).
  assert.ok(checked >= 90, `only ${checked} combinations compared`);
});

test('the ladder carries the Upgrade and the FOC, not the printed rent table', async () => {
  const { COLORS } = await loadCards();
  const { placementAdvice } = await loadSel();
  // 1 Command property + Upgrade + FOC. The printed ladder is [3, 8]; the
  // engine charges +3 +4 on top of it. A `COLORS[color].rent` read would print
  // 3 and 8 and be wrong by 7M on both rungs.
  const me = player({ darkblue: many('darkblue', 1) }, { darkblue: ['house', 'hotel'] });
  await stage(me);
  const [row] = placementAdvice(prop('darkblue'), ['darkblue']);
  assert.deepEqual(COLORS.darkblue.rent, [3, 8], 'fixture assumption: the printed ladder');
  assert.deepEqual(row.ladder, [10, 15]);
  assert.equal(row.rentNow, G.calcRent(me, 'darkblue'));
  assert.equal(row.landing, 2, 'placing the second card lands on the second rung');
  assert.equal(row.rentNext, 15);
  assert.equal(row.gain, 5);
  assert.equal(row.completes, true);
});

test('the landing rung is the zone length, not the first ladder entry that matches', async () => {
  const { placementAdvice } = await loadSel();
  // Overseas Bases is [1,2,3,4]; with an Upgrade every rung shifts +3 to
  // [4,5,6,7] — still distinct. The point of the assertion is the RULE: the
  // rung is chosen by position. Drone Ops with a House is [4,5]; searching a
  // ladder for the value 4 would land on rung 1 when the answer is rung 2.
  const me = player({ brown: many('brown', 1) }, { brown: ['house'] });
  await stage(me);
  const [row] = placementAdvice(prop('brown'), ['brown']);
  assert.deepEqual(row.ladder, [4, 5]);
  assert.equal(row.landing, 2);
  assert.equal(row.rentNext, 5);
});

test('exactly one BEST, on the highest rent gain', async () => {
  const { placementAdvice } = await loadSel();
  const me = player({
    lightblue: many('lightblue', 1),   // [1,2,3] → 1M, +1
    yellow: many('yellow', 1),         // [2,4,6] → 2M, +2
    base: many('base', 1),             // [1,2,3,4] → 1M, +1
  });
  await stage(me);
  const rows = placementAdvice(wild(['any']), ['lightblue', 'yellow', 'base']);
  assert.equal(rows.filter((r) => r.best).length, 1);
  assert.equal(rows.find((r) => r.best).color, 'yellow');
});

test('a tie on gain breaks toward the placement that completes a set', async () => {
  const { placementAdvice } = await loadSel();
  // Drone Ops 1/2 → +1 and COMPLETES. Overseas Bases 1/4 → +1 and does not.
  const me = player({ brown: many('brown', 1), base: many('base', 1) });
  await stage(me);
  const rows = placementAdvice(wild(['any']), ['base', 'brown']);
  assert.deepEqual(rows.map((r) => r.gain), [1, 1], 'fixture assumption: the gains tie');
  assert.equal(rows.find((r) => r.best).color, 'brown');
  assert.equal(rows.find((r) => r.color === 'brown').completes, true);
  assert.equal(rows.find((r) => r.color === 'base').completes, false);
});

test('one option is never marked BEST — there is nothing to recommend against', async () => {
  const { placementAdvice } = await loadSel();
  await stage(player({ yellow: many('yellow', 1) }));
  const rows = placementAdvice(prop('yellow'), ['yellow']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].best, false);
});

test('COMPLETES obeys pureSetRequired — a full zone of wilds is not a set', async () => {
  const { placementAdvice } = await loadSel();
  const { isSetComplete } = G;
  // Drone Ops holds one "any" wild; placing a second wild fills the zone.
  const me = player({ brown: [{ ...wild(['any']), id: 7 }] });
  const filled = { ...me, properties: { brown: [{ ...wild(['any']), id: 7 }, { ...wild(['any']), id: 8 }] } };

  await stage(me, { pureSetRequired: false });
  assert.equal(placementAdvice(wild(['any']), ['brown'])[0].completes, true);

  await stage(me, { pureSetRequired: true });
  assert.equal(placementAdvice(wild(['any']), ['brown'])[0].completes, false);
  // …and the engine agrees, which is the only reason the claim is worth making.
  // game.js rulesOf() reads the ruleset off the PLAYER (`_rules`), where the
  // client reads it off the snapshot — same flag, two carriers.
  assert.equal(isSetComplete({ ...filled, _rules: { pureSetRequired: true } }, 'brown'), false);
  assert.equal(isSetComplete({ ...filled, _rules: { pureSetRequired: false } }, 'brown'), true);
});

test('a rent step reads the column as it stands, multiplied by the armed surge', async () => {
  const { placementAdvice } = await loadSel();
  const me = player({ yellow: many('yellow', 2) });      // [2,4,6] → 4M
  await stage(me, {}, { surgeOps: 2 });                  // §3.1c: 2**2
  const [row] = placementAdvice({ type: 'rent', colors: ['yellow'] }, ['yellow'], 'rent');
  assert.equal(row.next, 2, 'a rent charge moves no card');
  assert.equal(row.landing, 2);
  assert.equal(row.rentNext, 16);
  assert.deepEqual(row.ladder, [8, 16, 24]);
  assert.equal(row.completes, false, 'charging rent never completes anything');
});

test('an Upgrade moving between complete sets is priced as the rider it is', async () => {
  const { placementAdvice, adviceSentence } = await loadSel();
  // Two complete sets; the FOC-less one is where a House could go.
  const me = player(
    { brown: many('brown', 2), intel: many('intel', 2) },
    { brown: ['house'] },
  );
  await stage(me);
  const card = { id: 5, type: 'action', action: 'upgrade', upgradeType: 'house', value: 3 };
  const [row] = placementAdvice(card, ['intel'], 'upgrade');
  assert.equal(row.rentNow, G.calcRent(me, 'intel'));
  assert.equal(row.gain, 3, 'a House is +3M (game.js calcRent)');
  assert.equal(row.next, row.count, 'no card moves');
  assert.match(adviceSentence(row), /Intelligence/);
});

test('every advice row can be spoken (§0.9 — the mat\'s accessible name)', async () => {
  const { placementAdvice, adviceSentence } = await loadSel();
  const me = player({ yellow: many('yellow', 2), intel: many('intel', 1) });
  await stage(me);
  const rows = placementAdvice(wild(['any']), ['yellow', 'intel']);
  for (const row of rows) {
    const said = adviceSentence(row);
    assert.ok(said.length > 10, `empty sentence for ${row.color}`);
    assert.ok(said.includes(`${row.rentNext}M`), `${said} does not say the rent it lands on`);
  }
  const intel = rows.find((r) => r.color === 'intel');
  assert.match(adviceSentence(intel), /Completes the set/);
  assert.match(adviceSentence(rows.find((r) => r.best)), /Best rent gain/);
});
