#!/usr/bin/env node
/**
 * tools/dragtest.mjs — DIRECT MANIPULATION ON YOUR OWN BOARD (§3.5, §3.8, ART §5).
 * HARNESS-AGENT-OWNED (ARCHITECTURE.md §1, §8).
 *
 * ─── the two defects this gate exists for, both reported in live play ─────
 *
 * §A CONSENT. "im trying to add a wild to one that has a dual color one and they
 *    are just getting swapped over and over." A `myColor` answer on a FULL mat
 *    dispatched `swap_property` on the spot whenever the mat held exactly one
 *    legal partner — a different move, relocating two cards and drawing two
 *    rearranges instead of one, chosen by a tap that is byte-for-byte identical
 *    to the tap that means "put this here". MEASURED before the fix, on the
 *    board §3.5's ruling is written against: one mouse-up on the mat produced
 *      [{"type":"swap_property","cardId":28,"withCardId":33}]
 *    with `mode.kind` back at 'idle' — no step, no confirmation, no way to tell
 *    it from the move that was meant.
 *
 * §B PAINT ORDER. "when dragging cards between base sets it doesnt overlap over
 *    them so it goes underneath and looks jarring/offputting." ART §5 rides the
 *    held card above the table. MEASURED before the fix, `elementFromPoint` at
 *    the held card's own centre returned a card in the mat it was crossing.
 *
 * ─── why a new gate and not a new case in an old one ─────────────────────
 * def3dd9's standing rule: a gate that cannot reach a state cannot defend it.
 * NEITHER defect was reachable by anything in tools/. `touchtest` drags a HAND
 * card (measured clean — a hand card has no stacking-context ancestor, so the
 * bug is specific to a card dragged OUT OF A MAT), `screenshot`'s `drag-mid`
 * drives the same hand-card path, and `playtest` never touches the pointer. The
 * swap needs a DEADLOCKED board — two full zones each holding a wild legal in
 * the other's colour — which no recorded fixture contains, because it takes a
 * deliberate sequence of plays to build one.
 *
 * So the boards here are BUILT THROUGH ENGINE CALLS (§0.7: "fixtures are
 * recorded from real games or built through engine calls"), pushed in through
 * `__CHUD.applyState` exactly as a broadcast arrives, and every gesture is real
 * CDP mouse input. Nothing is asserted from page script that the player could
 * not have caused with a finger.
 *
 * Every run leaves `tools/shots/dragtest-held.png` — the mid-drag frame §B is
 * about — and `tools/shots/coverage-dragtest.json` for the surface census.
 *
 * Exits 2 (PENDING CLIENT) until window.__CHUD exists.
 * Flags: --prove (demonstrate the assertions going red — see the bottom)
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, SHOT_DIR, DESKTOP, parseArgs, reporter, ensureDir, launchBrowser, openPage,
  requireBridge, pending, dim, EXIT_PASS,
} from './lib/harness.mjs';
import { installPageHelpers } from './lib/audit.mjs';
import { census, observeMarkers } from './lib/census.mjs';
import { openTouchPage, settleLayout } from './lib/touch.mjs';
import { startServer } from './serve.mjs';

const require = createRequire(path.join(ROOT, 'package.json'));
const G = require(path.join(ROOT, 'game.js'));

const args = parseArgs();
const PROVE = !!args.prove;
const r = reporter('dragtest' + dim('  the swap asks first, and the held card rides on top'));

/* ── boards, built through engine calls ─────────────────────────────────── */

function fresh(seed = 'dragtest') {
  const state = G.createGame([{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }], { seed });
  state.deck = G.buildDeck();
  state.discardPile = [];
  state.pendingAction = null;
  state.players.forEach((p) => { p.hand = []; p.bank = []; p.properties = {}; p.upgrades = {}; });
  state.turnPhase = 'play';
  state.currentPlayerIndex = 0;
  state.playsRemaining = 3;
  state.cardTotal = null;
  state._handSnapshot = 0;
  return state;
}

const take = (state, pick) => {
  const i = state.deck.findIndex(pick);
  if (i < 0) throw new Error('dragtest: the deck does not contain the card this board needs');
  return state.deck.splice(i, 1)[0];
};
const putProperty = (state, p, color) => {
  const c = take(state, (x) => x.type === 'property' && x.color === color);
  (p.properties[color] ||= []).push({ ...c, placedColor: color });
  return c;
};
const putWild = (state, p, color, pick) => {
  const c = take(state, (x) => x.type === 'wild_property' && pick(x));
  (p.properties[color] ||= []).push({ ...c, placedColor: color });
  return c;
};
const anyWild = (c) => c.colors[0] === 'any';
const pairWild = (a, b) => (c) => c.colors[0] !== 'any' && c.colors.includes(a) && c.colors.includes(b);

/**
 * §3.5's own board, plus enough furniture that a drag really crosses OCCUPIED
 * mats rather than empty ones (the paint-order defect is invisible over an empty
 * column — there is nothing there to be drawn over by).
 *
 * darkblue is size 2 and green is size 3, so both zones are exactly full and
 * each holds one wild that is legal in the other's colour: moveProperty refuses
 * BOTH directions and swapProperties is the only move that exists.
 * `room` is a colour with space left, so the plain move stays measurable on the
 * same board — a gate that only ever proves the refusal cannot see the day a fix
 * refuses everything.
 */
function deadlockBoard() {
  const state = fresh();
  const [me] = state.players;
  putProperty(state, me, 'darkblue');
  const partner = putWild(state, me, 'darkblue', pairWild('green', 'darkblue'));
  putProperty(state, me, 'green');
  putProperty(state, me, 'green');
  const wild = putWild(state, me, 'green', anyWild);
  for (const color of ['brown', 'lightblue', 'pink', 'orange', 'red', 'yellow']) {
    putProperty(state, me, color);
  }
  // A HAND card, for §E: the spring-home teleport was specific to cards that
  // rest in the fan (hand.reset → layout → setRest → writeRest overwrites the
  // drag offsets before the spring reads them; a board card's rest is never
  // rewritten on release). orange has room, so the card is legal SOMEWHERE and
  // draggable, and green refuses it — a full mat of the wrong colour.
  const handCard = take(state, (x) => x.type === 'property' && x.color === 'orange');
  me.hand.push(handCard);
  return { state, wild, partner, full: 'darkblue', room: 'orange', handCard };
}

/**
 * §F's table: five seats, because the strip only becomes a scroller when it
 * holds more seat than viewport — measured on five-player@phone, the strip is
 * sh 195 = ch 195 with every seat collapsed and only overflows once one is
 * EXPANDED. Opponent p2 holds five colours down and the sixth in hand, with p2
 * to act: at 390px a seat wraps its mat row at six columns (measured: five
 * cols propsH 70 / one row, six cols 144 / two, strip sh 323 -> 397), so one
 * engine play crosses the wrap the owner reported.
 */
function stripBoard() {
  const state = G.createGame([
    { id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }, { id: 'p3', name: 'P3' },
    { id: 'p4', name: 'P4' }, { id: 'p5', name: 'P5' },
  ], { seed: 'dragtest-strip' });
  state.deck = G.buildDeck();
  state.discardPile = [];
  state.pendingAction = null;
  state.players.forEach((p) => { p.hand = []; p.bank = []; p.properties = {}; p.upgrades = {}; });
  state.turnPhase = 'play';
  state.currentPlayerIndex = 1;
  state.playsRemaining = 3;
  state.cardTotal = null;
  state._handSnapshot = 0;
  const p2 = state.players[1];
  for (const color of ['brown', 'lightblue', 'pink', 'orange', 'green']) putProperty(state, p2, color);
  const sixth = take(state, (x) => x.type === 'property' && x.color === 'yellow');
  p2.hand.push(sixth);
  return { state, sixth };
}

/**
 * §G's table: a steal victim whose columns are STACKED. Bases 3/4 holds a wild
 * BURIED under two properties — the exact board the owner reported ("hard to
 * select exactly what you want if there is a property overlayed on top") —
 * plus a two-deep Elite and a single Space card, so the gate sees a buried
 * card, a half-covered card and a whole one in a single step. Midnight
 * Requisition in my hand arms `player` → `theirCard` over all three mats
 * (every colour is incomplete, so every card is stealable).
 */
function stealBoard() {
  const state = fresh('dragtest-steal');
  const [me, p2] = state.players;
  const buried = putWild(state, p2, 'base', (x) => x.colors.includes('base'));
  const mid = putProperty(state, p2, 'base');
  const top = putProperty(state, p2, 'base');
  putProperty(state, p2, 'green');
  putProperty(state, p2, 'green');
  putProperty(state, p2, 'pink');
  const mr = take(state, (x) => x.type === 'action' && x.action === 'midnight_requisition');
  me.hand.push(mr);
  return { state, buried, mid, top, mr };
}

const stateMessage = (state) => ({
  type: 'state',
  code: 'DRAG',
  phase: 'playing',
  players: state.players.map((p) => ({ id: p.id, name: p.name, connected: true, isBot: false })),
  hostId: 'p1',
  game: G.getPlayerView(state, 'p1'),
  turnTimer: null,
  responseTimer: null,
});

/* ── page helpers ───────────────────────────────────────────────────────── */

const CARD = (id) => `.card[data-card-id="${id}"]`;
const MAT = (color) => `#self-board .propcol[data-color="${color}"]`;

async function stage(page, state) {
  // A COMMITTED drop keeps its offset for interact/drag.js COMMIT_HOLD_MS (900)
  // and is `pointer-events: none` while it does, by design — the FLIP is meant
  // to continue from the drop point. A stage that does not wait it out starts
  // the next gesture on a card the pointer cannot reach and blames the drag
  // engine; measured, that is exactly how this file's §B first went red.
  await page.waitForFunction(() => !document.querySelector('.card.is-dropping'),
    null, { timeout: 4000 }).catch(() => {});
  await page.evaluate(() => window.__CHUD.joinAs('p1', 'P1'));
  await page.evaluate((m) => { window.__CHUD.applyState(m); window.__CHUD.drainEvents(); },
    stateMessage(state));
  await page.waitForTimeout(320);
}

const centre = (page, sel) => page.evaluate((q) => {
  const el = document.querySelector(q);
  if (!el) return null;
  const b = el.getBoundingClientRect();
  if (!b.width || !b.height) return null;
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}, sel);

/* ── the surface census (§8, tools/coverage.mjs) ──────────────────────────
 *
 * This gate is the ONLY thing in tools/ that can hold a mid-drag frame over a
 * player's own mats, so it is the only thing that can report on the markers that
 * exist solely during one: `step:swapCard`, `.propcol[data-drop-source]`, the
 * mat advice printed under a held card. coverage.mjs listed `step:swapCard` as
 * never visited by any gate before this file existed, which is precisely the
 * shape of failure def3dd9 wrote the census for. Observed at the exact moments
 * the assertions are made, not at a settled end state — half of these markers
 * are gone by then. */
const CENSUS = census().markers;
const markerSeen = new Map();
let captures = 0;

async function observe(page, label) {
  captures++;
  for (const key of await page.evaluate(observeMarkers, CENSUS)) {
    if (!markerSeen.has(key)) markerSeen.set(key, []);
    if (markerSeen.get(key).length < 4) markerSeen.get(key).push(label);
  }
}

const mode = (page) => page.evaluate(() => window.__CHUD.mode);
const sentFrom = (page, n) => page.evaluate((i) => window.__CHUD.sentLog.slice(i), n);
const sentCount = (page) => page.evaluate(() => window.__CHUD.sentLog.length);

async function tap(page, sel) {
  const at = await centre(page, sel);
  if (!at) throw new Error(`dragtest: nothing to tap at ${sel}`);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(140);
}

/**
 * A real drag, held open at the destination so the caller can measure the
 * moment. `hold` runs with the pointer still down; the caller decides whether to
 * release on the target (`drop`) or walk home first, which resolve() step 0
 * treats as a change of mind.
 */
async function drag(page, fromSel, toSel, { hold = null, drop = true } = {}) {
  const from = await centre(page, fromSel);
  const to = await centre(page, toSel);
  if (!from || !to) throw new Error(`dragtest: no drag path ${fromSel} → ${toSel}`);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
    await page.waitForTimeout(16);
  }
  await page.mouse.move(to.x, to.y);
  await page.waitForTimeout(90);
  if (hold) await hold();
  if (!drop) {
    await page.mouse.move(from.x, from.y);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await page.waitForTimeout(260);
}

/**
 * §B's measurement, and the ONE place it is made.
 *
 * `elementFromPoint` at the held card's own centre is the direct test, with two
 * traps that make a naive version report a clean board:
 *   • `.card.is-dragging` is `pointer-events: none` BY DESIGN (drag.js resolves a
 *     drop against the zone under the finger, which means the held card must be
 *     transparent to hit testing). audit.openHitTesting() neutralises exactly
 *     that, for the duration of the measurement, and it is the shared
 *     implementation every occlusion gate in tools/ already uses.
 *   • one point is not a measurement: the held card is rotated and scaled by the
 *     drag pose, so a single sample can land on a corner that overlaps nothing.
 *     Nine points on a 3×3 inset grid, and the verdict names the first occluder.
 *
 * Also returns the stacking-context ancestors, because "which element wins the
 * paint" and "which element establishes the context" are different questions and
 * the second one is the one a fix has to be written against.
 */
function measureHeld() {
  const held = document.querySelector('.card.is-dragging');
  if (!held) return { error: 'no .card.is-dragging — the drag never started' };
  const b = held.getBoundingClientRect();

  const contexts = [];
  // The dimming the same ancestors apply. `getComputedStyle(held).opacity` is
  // NOT this measurement and reports 1.00 through a mat at `opacity: .55` — the
  // ancestor composites the whole subtree, it does not change the child's
  // computed value. So the chain is multiplied out by hand, and any filter on an
  // ancestor is recorded, because a held card must not wear a mat's treatment.
  let dimmed = 1;
  const filtered = [];
  for (let n = held.parentElement; n && n.id !== 'app'; n = n.parentElement) {
    const s = getComputedStyle(n);
    dimmed *= Number(s.opacity) || 1;
    if (s.filter !== 'none') filtered.push(`${n.id ? `#${n.id}` : `.${String(n.className || '').split(' ')[0]}`}: ${s.filter}`);
    const why = [];
    if (s.position !== 'static' && s.zIndex !== 'auto') why.push(`z-index:${s.zIndex}`);
    if (s.transform !== 'none') why.push('transform');
    if (s.filter !== 'none') why.push(`filter:${s.filter}`);
    if (s.opacity !== '1') why.push(`opacity:${s.opacity}`);
    if (s.isolation === 'isolate') why.push('isolation');
    if (s.mixBlendMode !== 'normal') why.push('mix-blend-mode');
    if (s.willChange !== 'auto' && /transform|opacity|filter/.test(s.willChange)) why.push('will-change');
    if (s.contain && /paint|layout|strict|content/.test(s.contain)) why.push(`contain:${s.contain}`);
    if (s.backdropFilter && s.backdropFilter !== 'none') why.push('backdrop-filter');
    if (!why.length) continue;
    const name = n.id ? `#${n.id}` : `.${String(n.className || '').split(' ')[0]}`
      + (n.dataset && n.dataset.color ? `[${n.dataset.color}]` : '');
    contexts.push(`${name} → ${why.join(' + ')}`);
  }

  const hit = window.__chudHitTesting();
  let occluded = 0;
  let tested = 0;
  let by = null;
  try {
    for (let iy = 0; iy < 3; iy++) {
      for (let ix = 0; ix < 3; ix++) {
        const x = b.left + (b.width * (ix + 0.5)) / 3;
        const y = b.top + (b.height * (iy + 0.5)) / 3;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const el = document.elementFromPoint(x, y);
        tested++;
        if (el === held || held.contains(el) || (el && el.contains(held))) continue;
        occluded++;
        // A CARD occluder outranks any other in the report: §B is about the
        // cards the held card crosses, and a chrome layer winning one sample is
        // a weaker way to say the same thing.
        const card = el && el.closest ? el.closest('.card') : null;
        const named = card
          ? `card#${card.dataset.cardId} in ${card.closest('.propcol')?.dataset.color || '?'}`
          : `${el ? el.tagName.toLowerCase() : 'nothing'}.${el ? String(el.className || '') : ''}`;
        if (!by || (card && !/^card#/.test(by))) by = named;
      }
    }
  } finally { hit.close(); }

  // What the card is FLYING OVER, so "nothing occluded it" cannot be a pass
  // earned by dragging over bare felt.
  const crossed = [...document.querySelectorAll('#self-board .propcol .card')]
    .filter((c) => c !== held)
    .filter((c) => {
      const o = c.getBoundingClientRect();
      return o.left < b.right && o.right > b.left && o.top < b.bottom && o.bottom > b.top;
    }).length;

  return { contexts, occluded, tested, by, crossed, dimmed: Math.round(dimmed * 100) / 100, filtered };
}

/* ── run ─────────────────────────────────────────────────────────────────── */

let server = null;
let browser = null;
let handle = null;

try {
  server = await startServer({ quiet: true });
  browser = await launchBrowser();
  handle = await openPage(browser, `${server.url}/?harness=1`, { viewport: DESKTOP });
  // addInitScript, so it has to be installed before the document that uses it.
  await installPageHelpers(handle.context);
  await handle.page.goto(`${server.url}/?harness=1`, { waitUntil: 'load' });
  const { page } = handle;

  const bridged = await page.waitForFunction(() => !!window.__CHUD, null, { timeout: 30000 })
    .then(() => true).catch(() => false);
  if (!bridged) pending('CLIENT', 'window.__CHUD is absent with ?harness=1');
  await requireBridge(page, 30000);

  const board = deadlockBoard();
  await stage(page, board.state);

  const mats = await page.evaluate(() => [...document.querySelectorAll('#self-board .propcol')]
    .map((c) => `${c.dataset.color}:${c.querySelectorAll('.card').length}`).join(' '));
  r.info(`board (built through engine calls): ${mats}`);

  /* ── §A the tap route asks before it swaps ────────────────────────────── */
  {
    const before = await sentCount(page);
    await tap(page, CARD(board.wild.id));                     // beginMove
    const armed = await mode(page);
    if (armed.kind !== 'target' || armed.needs[0] !== 'myColor') {
      r.fail(`tapping the wild did not arm a myColor step (mode ${JSON.stringify(armed)})`);
    }
    await tap(page, MAT(board.full));                         // the FULL mat
    const after = await mode(page);
    const frames = await sentFrom(page, before);

    const swaps = frames.filter((f) => f.type === 'swap_property');
    if (swaps.length) {
      r.fail('§A a tap on a full mat sent swap_property with NO distinguishing step — '
        + `${JSON.stringify(swaps[0])}`);
    } else if (after.needs[0] !== 'swapCard') {
      r.fail(`§A a tap on a full mat neither swapped nor asked — needs ${JSON.stringify(after.needs)}`);
    } else {
      r.pass('§A tap: a full mat asks WHICH CARD before any swap frame leaves the client');
      r.info(`mode after the mat tap: needs ${JSON.stringify(after.needs)} · "${after.hint}"`);
    }
    await observe(page, 'swapCard step (tap)');

    // …and the step really is the door, not a dead end.
    await tap(page, CARD(board.partner.id));
    const done = await sentFrom(page, before);
    const sent = done.filter((f) => f.type === 'swap_property');
    if (sent.length === 1 && sent[0].cardId === board.wild.id
        && sent[0].withCardId === board.partner.id) {
      r.pass('§A answering the step sends exactly one swap_property, with the answered pair');
    } else {
      r.fail(`§A the swapCard step did not produce the swap — ${JSON.stringify(done)}`);
    }
  }

  /* ── §A′ the drag route forks in the same place ───────────────────────── */
  await stage(page, board.state);
  {
    const before = await sentCount(page);
    let chit = '(never read)';
    await drag(page, CARD(board.wild.id), MAT(board.full), {
      hold: async () => {
        chit = await page.evaluate((q) => document.querySelector(`${q} .mat-advice`)?.textContent || '(none)',
          MAT(board.full));
        await observe(page, 'board drag over a full mat');
      },
    });
    const frames = await sentFrom(page, before);
    const after = await mode(page);

    if (frames.some((f) => f.type === 'swap_property')) {
      r.fail(`§A′ a DROP on a full mat sent swap_property with no step — ${JSON.stringify(frames)}`);
    } else if (after.needs[0] !== 'swapCard') {
      r.fail(`§A′ a drop on a full mat neither swapped nor asked — ${JSON.stringify(after)}`);
    } else {
      r.pass('§A′ drag: the same fork, the same question — no frame until the partner is named');
    }

    if (/TRADE/.test(chit)) {
      r.pass(`§A′ the mat says what it would do BEFORE the drop ${dim(`(chit "${chit}")`)}`);
    } else {
      r.fail(`§A′ mid-drag the full mat is indistinguishable from a move mat — chit ${chit}`);
    }
  }

  /* ── §A″ a mat with ROOM is still a plain move ────────────────────────── */
  await stage(page, board.state);
  {
    const before = await sentCount(page);
    await drag(page, CARD(board.wild.id), MAT(board.room));
    const frames = await sentFrom(page, before);
    const moves = frames.filter((f) => f.type === 'move_property');
    if (moves.length === 1 && moves[0].toColor === board.room && frames.length === 1) {
      r.pass('§A″ a mat with room still takes one tap and one move_property (offer ⊆ accept, §0.1)');
    } else {
      r.fail(`§A″ the plain move regressed — ${JSON.stringify(frames)}`);
    }
  }

  /* ── §B the held card rides above the table ───────────────────────────── */
  await stage(page, board.state);
  {
    let held = null;
    ensureDir(SHOT_DIR);
    await drag(page, CARD(board.wild.id), MAT(board.full), {
      drop: false,
      hold: async () => {
        held = await page.evaluate(measureHeld);
        await observe(page, 'held card mid-flight over the mats');
        await page.screenshot({ path: path.join(SHOT_DIR, 'dragtest-held.png') });
      },
    });

    if (!held || held.error) {
      r.fail(`§B ${held ? held.error : 'the held card was never measured'}`);
    } else if (!held.crossed) {
      // §8: a gate that measured nothing must not pass.
      r.fail('§B the held card overlapped NO other card — this run measured nothing');
    } else if (held.occluded) {
      r.fail(`§B the held card is painted UNDER ${held.occluded}/${held.tested} of its own area — `
        + `first occluder ${held.by}. Stacking contexts above it: ${held.contexts.join(' | ') || '(none)'}`);
    } else {
      r.pass(`§B the held card paints above all ${held.crossed} card(s) it crosses `
        + dim(`(${held.tested}/${held.tested} points, contexts above it: ${held.contexts.join(' | ')})`));
    }

    // The same ancestor that stole the paint order also composited the card
    // through the mat's own treatment — a 55%-opaque, desaturated card in the
    // player's hand is the half of the bug you can see without a hit test.
    if (held && !held.error && (held.dimmed < 1 || held.filtered.length)) {
      r.fail(`§B the held card is composited through its mat — effective opacity ${held.dimmed}`
        + `${held.filtered.length ? `, filters ${held.filtered.join(' · ')}` : ''}`);
    } else if (held && !held.error) {
      r.pass('§B no ancestor dims or filters the held card '
        + dim(`(effective opacity ${held.dimmed}, 0 ancestor filters)`));
    }
  }

  /* ── §C an accepted drop with no frame behind it leaves the board alone ── */
  await stage(page, board.state);
  {
    await drag(page, CARD(board.wild.id), MAT(board.full));    // parks on the swapCard step
    // COMMIT_HOLD_MS is 900 in interact/drag.js; past it, holdRelease decides
    // where an unanswered drop goes home to.
    await page.waitForTimeout(1400);
    const where = await page.evaluate((id) => {
      const n = document.querySelector(`.card[data-card-id="${id}"]`);
      if (!n) return 'gone';
      const zone = n.closest('[data-zone]');
      return zone ? zone.getAttribute('data-zone') : (n.parentElement?.className || '?');
    }, board.wild.id);
    if (/hand/.test(where)) {
      r.fail(`§C an unanswered drop put a BOARD card in the ${where} zone — `
        + 'holdRelease springs it to the hand');
    } else {
      r.pass(`§C an unanswered drop leaves the card on the board ${dim(`(zone ${where})`)}`);
    }
  }

  /* ── §E a card let go travels HOME, it does not teleport there ──────────
   *
   * ART §4: "invalid drops lerp home over 260ms, never teleport." MEASURED
   * before the fix, frame-by-frame with a real mouse drag: at t=818ms the held
   * card was at the finger (--fx −67px, --fy −609px); at t=831ms — the NEXT
   * FRAME — it was at its fan rest (0px, −26.1px), ~620px in 13ms, then sat
   * motionless ~240ms with `is-flying` set while card_slide + card_snap played
   * over a stationary card. Cause: dragEnd ran table.releaseCard BEFORE
   * springBack, and releaseCard's hand relayout (hand.reset → layout → setRest
   * → retarget → writeRest) rewrote the drag offsets to the rest pose, so
   * flight.springHome launched a zero-length flight.
   *
   * The measurement is a rAF sampler on the released card's own rect: the
   * teleport is exactly {1 moving frame, 0ms spread, max step == total}, so a
   * genuine lerp must show many moving frames, spread over real time, with no
   * single frame carrying most of the distance. All three return paths are
   * sampled: the refused drop, the Escape cancel, and the targeting-return
   * (§A′'s swapCard drop, which goes home to wait for its answer).
   *
   * PROVEN TO FAIL (§8): make flight.springHome ignore its fromX/fromY (the
   * pre-fix read of vars releaseCard already rewrote) and all three go red —
   * "1 moving frame over 0ms, jump 383px of 383px". Red run recorded in this
   * round's report; the injection is two characters in anim/flight.js. */
  function springShape(frames) {
    let firstMove = -1, lastMove = -1, moving = 0, movingFlying = 0, maxStep = 0;
    for (let i = 1; i < frames.length; i++) {
      const d = Math.hypot(frames[i][1] - frames[i - 1][1], frames[i][2] - frames[i - 1][2]);
      if (d <= 1) continue;
      moving++;
      if (frames[i][3]) movingFlying++;
      if (firstMove < 0) firstMove = frames[i][0];
      lastMove = frames[i][0];
      if (d > maxStep) maxStep = d;
    }
    const a = frames[0], z = frames[frames.length - 1];
    return {
      total: Math.round(Math.hypot(z[1] - a[1], z[2] - a[2])),
      moving,
      movingFlying,
      spreadMs: firstMove < 0 ? 0 : lastMove - firstMove,
      maxStep: Math.round(maxStep * 10) / 10,
      frames: frames.length,
    };
  }

  /** A real drag whose RELEASE is frame-sampled: the sampler is installed with
   *  the pointer still down, so frame 0 is the drop point, not a guess. */
  async function dragSampled(page, fromSel, toSel, { escape = false } = {}) {
    const from = await centre(page, fromSel);
    const to = await centre(page, toSel);
    if (!from || !to) throw new Error(`dragtest: no drag path ${fromSel} → ${toSel}`);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
      await page.waitForTimeout(16);
    }
    await page.mouse.move(to.x, to.y);
    await page.waitForTimeout(120);
    await page.evaluate((sel) => {
      const node = document.querySelector(sel);
      const t0 = performance.now();
      const trace = { frames: [], done: false };
      window.__SPRING_TRACE = trace;
      const tick = () => {
        const r = node.getBoundingClientRect();
        trace.frames.push([
          Math.round(performance.now() - t0),
          Math.round((r.left + r.width / 2) * 10) / 10,
          Math.round((r.top + r.height / 2) * 10) / 10,
          node.classList.contains('is-flying') ? 1 : 0,
        ]);
        if (performance.now() - t0 < 900) requestAnimationFrame(tick);
        else trace.done = true;
      };
      // Frame 0 is taken NOW, synchronously, with the pointer still down: the
      // CDP mouse-up can land before the first rAF fires, and a teleport that
      // completed before frame 0 measured "0px of travel" instead of naming
      // itself (seen on the first proof-of-failure run).
      tick();
    }, fromSel);
    if (escape) await page.keyboard.press('Escape');
    else await page.mouse.up();
    await page.waitForFunction(() => window.__SPRING_TRACE && window.__SPRING_TRACE.done,
      null, { timeout: 4000 });
    if (escape) await page.mouse.up().catch(() => {});
    await page.waitForTimeout(80);
    return page.evaluate(() => window.__SPRING_TRACE.frames);
  }

  const springTraces = {};

  function assertSpring(label, s, { minTravel = 100, minMoving = 6, minSpread = 150, needFlying = false } = {}) {
    const teleport = s.maxStep > s.total * 0.6;
    if (s.total < minTravel) {
      // §8: a gate that measured nothing must not pass — a release next to its
      // rest pose proves nothing about how the card got home.
      r.fail(`§E ${label}: only ${s.total}px between release and rest (< ${minTravel}) — this run measured nothing`);
    } else if (s.moving < minMoving || s.spreadMs < minSpread || teleport) {
      r.fail(`§E ${label}: the return home is not a ~260ms lerp — ${s.moving} moving frame(s) `
        + `over ${s.spreadMs}ms, biggest single-frame jump ${s.maxStep}px of ${s.total}px total `
        + '(ART §4: refused drops lerp home over 260ms, never teleport)');
    } else if (needFlying && s.movingFlying < minMoving) {
      r.fail(`§E ${label}: the card moved but only ${s.movingFlying} moving frame(s) carried .is-flying — `
        + 'the slide/snap cues are anchored on a flight that is not the motion');
    } else {
      r.pass(`§E ${label}: home over ${s.spreadMs}ms in ${s.moving} frames `
        + dim(`(${s.total}px, max step ${s.maxStep}px${needFlying ? `, ${s.movingFlying} flying` : ''})`));
    }
  }

  /* §E.1 — the refused drop: an orange property released dead centre on the
   * full green mat (wrong colour, full zone) is refused by resolve() step 1a
   * and must LERP home to the fan. */
  await stage(page, board.state);
  {
    const frames = await dragSampled(page, CARD(board.handCard.id), MAT('green'));
    springTraces.refused = frames;
    assertSpring('refused drop (hand → illegal mat)', springShape(frames), { needFlying: true });
  }

  /* §E.2 — Escape mid-drag: dragCancel takes the same ordering path as the
   * refusal (teardown → releaseCard → springBack), so it teleported the same
   * way. */
  await stage(page, board.state);
  {
    const frames = await dragSampled(page, CARD(board.handCard.id), MAT('green'), { escape: true });
    springTraces.escape = frames;
    assertSpring('Escape cancel (hand)', springShape(frames), { needFlying: true });
  }

  /* §E.3 — the targeting-return: §A′'s drop on the full mat is ACCEPTED by the
   * machine (it arms the swapCard step) and the card goes home to wait for its
   * answer — springBack again, this time from a board source (the CSS-spring
   * branch, which transitions FROM the painted pose and so must also be handed
   * the true drop point). Thresholds are lower only because two mats on one
   * board are nearer each other than the fan is to the felt — the teleport
   * signature (1 frame, 0ms) is still unambiguously red. */
  await stage(page, board.state);
  {
    const frames = await dragSampled(page, CARD(board.wild.id), MAT(board.full));
    springTraces.targeting = frames;
    assertSpring('targeting-return (board, swapCard step)', springShape(frames),
      { minTravel: 40, minMoving: 5, minSpread: 100 });
  }

  ensureDir(SHOT_DIR);
  fs.writeFileSync(path.join(SHOT_DIR, 'springtrace-dragtest.json'), JSON.stringify({
    tool: 'dragtest',
    generatedAt: new Date().toISOString(),
    format: '[tMs, cx, cy, isFlying] per rAF frame, t0 = sampler start (pointer still down)',
    traces: springTraces,
  }, null, 1) + '\n');
  r.info('release trajectories → springtrace-dragtest.json');

  /* ── §D the new step, on the phone the bar was measured against ─────────
   *
   * The swapCard step ships a new sentence into ui/prompt.js, and that file
   * carries a measurement this round must not break: a two-clause hint on a
   * 390×844 phone wraps to three lines and makes the bar 109px tall (d05d523,
   * which spent a whole paragraph choosing an eleven-word clause over a
   * sentence for exactly this reason). 64px is the figure that commit ratified
   * as the worst case, and the bar is measured with the step ARMED — the state
   * the string only exists in — rather than at rest, where it costs nothing. */
  {
    const ph = await openPage(browser, `${server.url}/?harness=1`, {
      viewport: { width: 390, height: 844 }, dpr: 3, isMobile: true, hasTouch: true,
    });
    try {
      await requireBridge(ph.page, 30000);
      await stage(ph.page, board.state);
      await tap(ph.page, CARD(board.wild.id));
      await tap(ph.page, MAT(board.full));
      const bar = await ph.page.evaluate(() => {
        const el = document.getElementById('prompt');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { h: Math.round(b.height), text: (el.textContent || '').trim().slice(0, 90) };
      });
      const step = (await ph.page.evaluate(() => window.__CHUD.mode)).needs[0];
      if (step !== 'swapCard') {
        r.fail(`§D the phone never reached the swapCard step (needs[0] ${step})`);
      } else if (!bar) {
        r.fail('§D no #prompt on the phone');
      } else if (bar.h > 64) {
        r.fail(`§D the prompt bar is ${bar.h}px with the swapCard step armed — d05d523 ratified 64 `
          + `as the worst case. Text: "${bar.text}"`);
      } else {
        r.pass(`§D the swapCard prompt fits the ratified bar on a phone ${dim(`(${bar.h}px ≤ 64)`)}`);
        r.info(`bar: "${bar.text}"`);
      }
    } finally { await ph.close().catch(() => {}); }
  }

  /* ── §F the strip never scrolls itself ──────────────────────────────────
   *
   * OWNER, 2026-08-07, verbatim: "when another player gets to their 5th set of
   * properties (not complete just goes to the next row) it auto scrolls and
   * you have to scroll back up just to see their hand … it should never auto
   * scroll like this just let players scroll if they want to."
   *
   * The obvious suspect was WRONG, and it is worth recording which one: the
   * strip's `scroll-snap-type` has a documented history of re-snapping on
   * overflow lies (table.css, the .is-flying guard), and a synthetic
   * class-toggle probe even moved 13 → 0. But the REAL flight path survives —
   * the unclip registry saves and restores scrollTop around every landing.
   * What reproduces the owner's report is SCROLL ANCHORING: with
   * `overflow-anchor: auto` the browser picks an anchor node, and when the
   * wrap grows a seat ABOVE that anchor, it moves scrollTop to hold the
   * anchor still. MEASURED (scratchpad anchorprobe, phone 390×844, seat
   * expanded, strip at its 18px bottom): the sixth colour lands, the mat row
   * wraps (strip sh 323 → 397), and scrollTop is written 18 → 92 — the
   * nameplate and fan of the seat the player was reading leave the port.
   * At scrollTop 0 nothing moves, which is why no gate had ever seen it.
   *
   * The gesture and the growth are both real: a CDP-touch expand and swipe,
   * then the sixth colour played through G.playProperty and animated by the
   * choreographer. Preconditions are asserted (the strip really overflows,
   * the user position is really nonzero, the wrap really happened) so a
   * layout change cannot quietly turn this into a gate that measures nothing.
   */
  async function stripGrowth(injectAnchor) {
    const sb = stripBoard();
    const ph = await openTouchPage(browser, `${server.url}/?harness=1`);
    try {
      await requireBridge(ph.page, 30000);
      if (injectAnchor) {
        // The exact rule the fix deleted, put back — §8's "reproduction, not
        // imitation". With it, the remembered snap target re-aligns across
        // the wrap and drags scrollTop, anchoring off or not.
        await ph.page.addStyleTag({ content: '#opponents{scroll-snap-type:y proximity}' });
      }
      await stage(ph.page, sb.state);
      await settleLayout(ph.page);
      // Expand p2's seat with a real thumb.
      const tog = await ph.page.evaluate(() => {
        const b = document.querySelector('.board[data-player="p2"] [data-seat-toggle]');
        if (!b) return null;
        const r2 = b.getBoundingClientRect();
        return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 };
      });
      if (!tog) return { err: 'no seat toggle for p2' };
      await ph.tap(tog.x, tog.y);
      await settleLayout(ph.page);
      const strip = () => ph.page.evaluate(() => {
        const e = document.getElementById('opponents');
        const rr = e.getBoundingClientRect();
        return { st: e.scrollTop, sh: e.scrollHeight, ch: e.clientHeight,
          x: rr.left + rr.width / 2, top: rr.top, bottom: rr.bottom };
      });
      let s = await strip();
      if (s.sh <= s.ch + 8) return { err: `strip does not overflow after expand (sh ${s.sh}, ch ${s.ch}) — measured nothing` };
      // A real swipe up inside the strip scrolls it down a few px.
      const midX = s.x, y0 = s.bottom - 12, y1 = s.top + 12;
      await ph.swipe(midX, y0, midX, y1, 14);
      await settleLayout(ph.page);
      s = await strip();
      if (s.st <= 0) return { err: 'the swipe left scrollTop at 0 — measured nothing' };
      const st0 = s.st;
      const sh0 = s.sh;
      // The sixth colour, played by the engine and animated by the choreographer.
      const res = G.playProperty(sb.state, 'p2', 0, sb.sixth.color);
      if (res && res.error) return { err: `engine refused the sixth colour: ${res.error}` };
      await ph.page.evaluate((m) => window.__CHUD.applyState(m), stateMessage(sb.state));
      await ph.page.waitForFunction(() => !document.querySelector('.card.is-flying'),
        null, { timeout: 6000 }).catch(() => {});
      // Outlast the reclip sweep and any late re-snap before measuring.
      await ph.page.waitForTimeout(500);
      s = await strip();
      const cols = await ph.page.evaluate(() =>
        document.querySelectorAll('.board[data-player="p2"] .propcol:not([data-empty="1"])').length);
      return { st0, st1: s.st, sh0, sh1: s.sh, cols, errors: ph.errors };
    } finally { await ph.close().catch(() => {}); }
  }
  {
    const g = await stripGrowth(false);
    if (g.err) {
      r.fail(`§F ${g.err}`);
    } else if (g.cols !== 6) {
      r.fail(`§F p2 shows ${g.cols} columns after the play — the sixth colour never landed`);
    } else if (g.sh1 <= g.sh0) {
      r.fail(`§F the strip never grew (sh ${g.sh0} → ${g.sh1}) — the wrap this section exists for `
        + 'did not happen, so this run measured nothing');
    } else if (Math.abs(g.st1 - g.st0) > 1) {
      r.fail(`§F the strip scrolled itself: ${g.st0}px → ${g.st1}px across an opponent's row-wrapping `
        + 'landing, with no input — the owner\'s "auto scroll" reproduced');
    } else {
      r.pass(`§F an opponent's row-wrapping colour lands and the strip holds the player's scroll `
        + dim(`(${g.st0}px → ${g.st1}px while sh ${g.sh0} → ${g.sh1})`));
    }
  }

  /* ── §G a buried steal target is a real target (§0.9, owner report) ──────
   *
   * OWNER, verbatim: "when trying to steal someone's card it can be hard to
   * select exactly what you want if there is a property overlayed on top. PC
   * may have a similar issue though."
   *
   * MEASURED before the fix (recorded red, 2026-08-07), 390×844 real CDP
   * touch, Midnight Requisition's theirCard step over stealBoard(): every seat
   * card was 30×42 — below §0.9's 44 floor even UNCOVERED — and the resting
   * stack's mini-step left each buried card an 8px sliver (27% of its own
   * face; the two-deep Elite exposed 18px). A tap at the buried wild's visual
   * centre dispatched play_action with the targetCardId of the card ON TOP of
   * the one aimed at, and the steal left the client with no confirming step.
   * The mouse leg at 1280×720 mis-picked identically — the owner's "PC may
   * have a similar issue" was right.
   *
   * The fix is table.css's pick-open fan — the same mark-keyed un-stack the
   * bank already performs for a payment ([data-payable]) applied to a mat
   * whose CARDS are the live pick targets: the mat takes the seat row it
   * needs, the mini card is floored at --tap, and the derived overlap
   * guarantees every card an exposed strip ≥ --tap wide by construction.
   * This section asserts the OUTCOME, on both input worlds:
   *   touch — every marked card's unoccluded area is ≥44px on both axes, and
   *           a thumb tap at the buried card's OWN CENTRE picks THAT card;
   *   mouse — the same walk and the same two assertions at 1280×720.
   * PROVEN TO FAIL: the recorded pre-fix red, and --prove re-injects the
   * resting stack's geometry over the fan (26px card, nowrap, mini-step
   * margins, !important) and the touch leg goes red again.
   */
  function measurePickTargets() {
    const out = [];
    for (const node of document.querySelectorAll('.card[data-targetable="1"]')) {
      const r = node.getBoundingClientRect();
      let vis = 0;
      let total = 0;
      let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
      // 1px grid: the exposed-box quantisation error is <1px, so a 44px strip
      // reads 44, not 42 — the floor being asserted is the floor measured.
      for (let y = r.top + 0.5; y < r.bottom; y += 1) {
        for (let x = r.left + 0.5; x < r.right; x += 1) {
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
          total++;
          const el = document.elementFromPoint(x, y);
          if (el && (el === node || node.contains(el))) {
            vis++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const col = node.closest('.propcol');
      out.push({
        id: Number(node.dataset.cardId),
        color: col ? col.dataset.color : '?',
        w: Math.round(r.width),
        h: Math.round(r.height),
        visPct: total ? Math.round((vis / total) * 100) : 0,
        effW: maxX === -Infinity ? 0 : Math.round(maxX - minX + 1),
        effH: maxY === -Infinity ? 0 : Math.round(maxY - minY + 1),
      });
    }
    return out;
  }

  /** The walk both input worlds share: MR → Play → victim seat → theirCard. */
  async function stealWalk(pg, tapAt, sb) {
    await pg.evaluate(() => window.__CHUD.joinAs('p1', 'P1'));
    await pg.evaluate((m) => { window.__CHUD.applyState(m); window.__CHUD.drainEvents(); },
      stateMessage(sb.state));
    await pg.waitForTimeout(360);
    const at = async (sel) => {
      const c = await centre(pg, sel);
      if (!c) throw new Error(`dragtest §G: nothing to tap at ${sel}`);
      await tapAt(c.x, c.y);
    };
    await at(CARD(sb.mr.id));
    await pg.waitForTimeout(220);
    await at('[data-action="play-card"]');
    await pg.waitForTimeout(300);
    let m = await pg.evaluate(() => window.__CHUD.mode);
    if (m.needs && m.needs[0] === 'player') {
      await at('.board[data-player="p2"]');
      await pg.waitForTimeout(340);
      m = await pg.evaluate(() => window.__CHUD.mode);
    }
    return { mode: m, at };
  }

  function assertPickTargets(leg, picks, floor = 44) {
    if (picks.length !== 6) {
      r.fail(`§G ${leg}: expected 6 marked steal targets, found ${picks.length}`);
      return;
    }
    const short = picks.filter((p) => Math.min(p.effW, p.effH) < floor);
    if (short.length) {
      const worst = short.reduce((a, b) => (Math.min(a.effW, a.effH) < Math.min(b.effW, b.effH) ? a : b));
      r.fail(`§G ${leg}: ${short.length}/6 pick targets under the ${floor}px floor — worst `
        + `card#${worst.id} in ${worst.color}: ${worst.effW}×${worst.effH} exposed of a `
        + `${worst.w}×${worst.h} card (${worst.visPct}% visible). `
        + `All: ${picks.map((p) => `${p.color}#${p.id}:${p.effW}×${p.effH}`).join(' ')}`);
    } else {
      const min = picks.reduce((a, b) => Math.min(a, b.effW, b.effH), Infinity);
      r.pass(`§G ${leg}: all 6 pick targets ≥${floor}px effective `
        + dim(`(smallest exposed axis ${min}px; ${picks.map((p) => `${p.color}#${p.id}:${p.effW}×${p.effH}`).join(' ')})`));
    }
  }

  async function assertBuriedPick(leg, pg, at, sb) {
    const before = await sentCount(pg);
    await at(CARD(sb.buried.id));                 // the card's own centre — where a thumb aims
    await pg.waitForTimeout(300);
    const frames = await sentFrom(pg, before);
    const steal = frames.find((f) => f.type === 'play_action');
    if (!steal) {
      r.fail(`§G ${leg}: tapping the buried card's centre sent nothing — ${JSON.stringify(frames)}`);
    } else if (steal.targetCardId !== sb.buried.id) {
      r.fail(`§G ${leg}: aimed at buried card#${sb.buried.id}, the client sent targetCardId `
        + `${steal.targetCardId} — the WRONG property is stolen with no confirming step`);
    } else {
      r.pass(`§G ${leg}: a tap at the buried card's own centre picks that card `
        + dim(`(targetCardId ${steal.targetCardId})`));
    }
  }

  const sbTouch = stealBoard();
  {
    const ph = await openTouchPage(browser, `${server.url}/?harness=1`);
    try {
      await requireBridge(ph.page, 30000);
      const { mode: m, at } = await stealWalk(ph.page, (x, y) => ph.tap(x, y), sbTouch);
      if (m.kind !== 'target' || !m.needs || m.needs[0] !== 'theirCard') {
        r.fail(`§G touch: never reached the theirCard step (mode ${m.kind}, needs ${JSON.stringify(m.needs)})`);
      } else {
        await settleLayout(ph.page);
        await observe(ph.page, 'theirCard pick, fanned column (touch)');
        const picks = await ph.page.evaluate(measurePickTargets);
        ensureDir(SHOT_DIR);
        await ph.page.screenshot({ path: path.join(SHOT_DIR, 'dragtest-pickfan.png') });
        assertPickTargets('touch@390×844', picks);
        await assertBuriedPick('touch@390×844', ph.page, at, sbTouch);
      }
    } finally { await ph.close().catch(() => {}); }
  }

  {
    const sb = stealBoard();
    await stage(page, sb.state);
    const { mode: m, at } = await stealWalk(page,
      async (x, y) => { await page.mouse.click(x, y); }, sb);
    if (m.kind !== 'target' || !m.needs || m.needs[0] !== 'theirCard') {
      r.fail(`§G mouse: never reached the theirCard step (mode ${m.kind}, needs ${JSON.stringify(m.needs)})`);
    } else {
      const picks = await page.evaluate(measurePickTargets);
      assertPickTargets('mouse@1280×720', picks);
      await assertBuriedPick('mouse@1280×720', page, at, sb);
    }
  }

  /* ── §H1 the pick-open fan OPENS — motion, not teleportation ─────────────
   *
   * §P10 FEEL: entering the theirCard step is pure CSS :has() layout
   * (table.css ~1346-1385 — grid spans, --card-w, negative margins, the seats
   * track), and before table.flipStrip existed the whole fan arrived in ONE
   * frame: the victim seat grew ~140→~250px with no motion anywhere, because
   * no FLIP runs on a mark — nothing reparents. The fix measures the strip's
   * cards around interact/'s mark pass and flies the inverted deltas on the
   * one clock.
   *
   * The measurement is §E's own rAF sampler pointed at a card the fan moves:
   * installed BEFORE the arming tap, so frame 0 is the resting stack. A
   * teleport is exactly {≤1 moving frame, ~0ms spread, max step == total};
   * motion is many frames spread over real time. PROVEN TO FAIL: with
   * interact/applyMarks routed straight to applyMarksNow (the flipStrip call
   * disabled) this reads "1 moving frame over 0ms" — red run recorded in this
   * round's report. Reduced motion is not sampled here: the collapse to the
   * instant change is the specified §0.9 behaviour, not a regression.
   */
  {
    const sb = stealBoard();
    await stage(page, sb.state);
    await tap(page, CARD(sb.mr.id));
    await tap(page, '[data-action="play-card"]');
    await page.waitForTimeout(240);
    const m = await mode(page);
    if (m.kind !== 'target' || m.needs[0] !== 'player') {
      r.fail(`§H1 never reached the player step (mode ${m.kind}, needs ${JSON.stringify(m.needs)})`);
    } else {
      // Sampler first, THEN the tap that arms the fan — centroid + width per rAF.
      await page.evaluate((sel) => {
        const node = document.querySelector(sel);
        const t0 = performance.now();
        const trace = { frames: [], done: false };
        window.__FAN_TRACE = trace;
        const tick = () => {
          const b = node.getBoundingClientRect();
          trace.frames.push([
            Math.round(performance.now() - t0),
            Math.round((b.left + b.width / 2) * 10) / 10,
            Math.round((b.top + b.height / 2) * 10) / 10,
            Math.round(b.width * 10) / 10,
          ]);
          if (performance.now() - t0 < 900) requestAnimationFrame(tick);
          else trace.done = true;
        };
        tick();
      }, CARD(sb.top.id));
      await tap(page, '.board[data-player="p2"]');           // arms theirCard → the fan
      await page.waitForFunction(() => window.__FAN_TRACE && window.__FAN_TRACE.done,
        null, { timeout: 4000 });
      const armed = await mode(page);
      const frames = await page.evaluate(() => window.__FAN_TRACE.frames);
      const s = springShape(frames);
      if (armed.needs?.[0] !== 'theirCard') {
        r.fail(`§H1 the victim tap never armed theirCard (needs ${JSON.stringify(armed.needs)})`);
      } else if (s.total < 8) {
        // §8: a gate that measured nothing must not pass — if the fan stops
        // moving this card, sample a card it does move.
        r.fail(`§H1 the sampled card moved only ${s.total}px opening the fan — this run measured nothing`);
      } else if (s.moving < 3 || s.spreadMs < 60 || s.maxStep > s.total * 0.8) {
        r.fail(`§H1 the pick-open fan SNAPS open — ${s.moving} moving frame(s) over ${s.spreadMs}ms, `
          + `biggest single-frame jump ${s.maxStep}px of ${s.total}px total (§P10: the fan's `
          + 'opening must be >1 frame of motion on the one clock)');
      } else {
        r.pass(`§H1 the fan opens as motion: ${s.moving} frames over ${s.spreadMs}ms `
          + dim(`(${s.total}px, max step ${s.maxStep}px)`));
      }
      // …and it still settles into §G's guarantees, which ran above.
    }
  }

  /* ── §H2 the drag lean relaxes when the pointer parks ────────────────────
   *
   * §P10 FEEL, measured on the pre-fix build: table.dragCard() computes the
   * velocity pose only on pointermove, so a fast sweep followed by a 260ms
   * hold left the card at −4.2° / scaleX 1.055 for the whole hold. The fix
   * decays rec.vx toward 0 from drag.js's follow() subscriber (τ ≈ 120ms,
   * table.dragSettle). Asserted with a real CDP sweep: the lean must EXIST at
   * the end of the sweep (or this run measured nothing) and be under 1° after
   * a 450ms park — exp(−450/120) leaves ~2% of a saturated 6°. PROVEN TO
   * FAIL: with the dragSettle call removed from follow(), the parked reading
   * equals the hot one (red run recorded in this round's report).
   */
  {
    await stage(page, board.state);
    const from = await centre(page, CARD(board.handCard.id));
    if (!from) {
      r.fail('§H2 no hand card to sweep');
    } else {
      const tiltOf = () => page.evaluate(
        (sel) => parseFloat(document.querySelector(sel)?.style.getPropertyValue('--tilt')) || 0,
        CARD(board.handCard.id));
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) {
        await page.mouse.move(from.x + i * 28, from.y - i * 6);
        await page.waitForTimeout(5);
      }
      const hot = await tiltOf();
      await page.waitForTimeout(450);                        // the park, pointer still down
      const parked = await tiltOf();
      await page.keyboard.press('Escape');
      await page.mouse.up().catch(() => {});
      await page.waitForTimeout(300);
      if (Math.abs(hot) < 1.5) {
        r.fail(`§H2 the sweep built only ${hot}° of lean — this run measured nothing `
          + '(V_REF or the sweep speed moved; make the gesture faster)');
      } else if (Math.abs(parked) > 1) {
        r.fail(`§H2 the lean FROZE at a parked pointer: ${hot}° at sweep end, still `
          + `${parked}° after a 450ms hold (τ=120ms decay predicts <0.2°)`);
      } else {
        r.pass(`§H2 the lean relaxes while parked ${dim(`(${hot}° hot → ${parked}° after 450ms)`)}`);
      }
    }
  }

  ensureDir(SHOT_DIR);
  fs.writeFileSync(path.join(SHOT_DIR, 'coverage-dragtest.json'), JSON.stringify({
    tool: 'dragtest',
    generatedAt: new Date().toISOString(),
    captures,
    seen: Object.fromEntries(markerSeen),
  }, null, 1) + '\n');
  r.info(`${markerSeen.size}/${CENSUS.length} surface marker(s) seen → coverage-dragtest.json`);

  if (handle.errors.length) {
    r.fail(`${handle.errors.length} console/page error(s): ${handle.errors.slice(0, 3).join(' · ')}`);
  } else {
    r.pass('no console or page errors across every gesture');
  }

  /* ── --prove ──────────────────────────────────────────────────────────────
   * §8's rule that a gate must be shown to be capable of failing. §B is the one
   * that can be reverted from outside the client: the defect was a `filter` /
   * `opacity` on the mat the held card is still inside, so putting one back is
   * an exact reproduction of the shipped bug rather than an imitation of it.
   * §A/§A′/§C live in JS and are proved by reverting the source — the figures
   * are in this round's commit message. */
  if (PROVE) {
    await stage(page, board.state);
    await page.addStyleTag({
      content: '.propcol[data-drop-source="1"]{filter:saturate(.5);opacity:.55}',
    });
    let held = null;
    await drag(page, CARD(board.wild.id), MAT(board.full), {
      drop: false,
      hold: async () => { held = await page.evaluate(measureHeld); },
    });
    if (held && !held.error && held.occluded > 0) {
      r.pass(`--prove: with the mat's filter/opacity restored, §B goes red — `
        + `${held.occluded}/${held.tested} points occluded by ${held.by}`);
      r.info(`context that did it: ${held.contexts.join(' | ')}`);
    } else {
      r.fail(`--prove: §B did NOT go red with the defect restored (${JSON.stringify(held)}) — `
        + 'the assertion is not measuring what it claims');
    }
    const g = await stripGrowth(true);
    if (g.err) {
      r.fail(`--prove §F: ${g.err}`);
    } else if (Math.abs(g.st1 - g.st0) > 1) {
      r.pass(`--prove: with the strip's snap-type restored, §F goes red — `
        + `${g.st0}px → ${g.st1}px across the wrap`);
    } else {
      r.fail(`--prove: §F did NOT move with the deleted snap restored (${g.st0} → ${g.st1}) — `
        + 'the assertion is not measuring what it claims');
    }

    /* §G: the resting stack's exact geometry (26px card, nowrap, mini-step
     * margins — the shipped defect, not an imitation) is forced back over the
     * pick-open fan, and the effective-target measurement must find the sliver
     * again. */
    {
      const ph = await openTouchPage(browser, `${server.url}/?harness=1`);
      try {
        await requireBridge(ph.page, 30000);
        await ph.page.addStyleTag({
          content: `
            .opponents .zone-props:has(> .card[data-targetable="1"]) {
              --card-w: max(26px, calc(var(--s) * 2.1)) !important;
              flex-wrap: nowrap !important; gap: 0 !important;
            }
            .opponents .zone-props:has(> .card[data-targetable="1"]) > .card:not(:first-child) {
              margin-left: calc(var(--mini-step) - var(--card-w)) !important;
            }
            .opponents .propcol:has(> .zone-props > .card[data-targetable="1"]) {
              grid-column: auto !important;
            }`,
        });
        const sb = stealBoard();
        const { mode: m } = await stealWalk(ph.page, (x, y) => ph.tap(x, y), sb);
        if (m.kind !== 'target' || !m.needs || m.needs[0] !== 'theirCard') {
          r.fail(`--prove §G: never reached the theirCard step (${m.kind}/${JSON.stringify(m.needs)})`);
        } else {
          const picks = await ph.page.evaluate(measurePickTargets);
          const short = picks.filter((p) => Math.min(p.effW, p.effH) < 44);
          if (short.length) {
            const worst = short.reduce((a, b) => (Math.min(a.effW, a.effH) < Math.min(b.effW, b.effH) ? a : b));
            r.pass(`--prove: with the resting stack restored over the fan, §G goes red — `
              + `${short.length}/${picks.length} targets under 44px, worst ${worst.effW}×${worst.effH} `
              + `(card#${worst.id} in ${worst.color})`);
          } else {
            r.fail('--prove: §G did NOT go red with the stack restored — '
              + 'the assertion is not measuring what it claims');
          }
        }
      } finally { await ph.close().catch(() => {}); }
    }
  }
} finally {
  if (handle) await handle.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server) await server.stop().catch(() => {});
}

process.exit(r.finish('dragtest') === EXIT_PASS ? EXIT_PASS : r.code);
