#!/usr/bin/env node
/**
 * tools/record.mjs — record REAL games and cut fixtures from them (§9).
 *
 * §9: "Fixtures live in tools/fixtures/*.json and are recorded from real seeded
 * games … states the game cannot reach must not be screenshot." So this tool
 * plays actual games against the real server with the real bots and keeps every
 * `state` broadcast the seat receives, then selects named moments by predicate.
 *
 * It drives the seat over a raw `ws` socket (tools/lib/wsclient.mjs) rather than
 * through the browser, because the P3 client does not exist yet. The fixture
 * format is the server's own `state` message, so switching to browser capture
 * later changes nothing downstream.
 *
 * Output:
 *   tools/fixtures/session-*.json   full transcript — every state, in order
 *   tools/fixtures/<moment>.json    one selected state + why it was selected
 *
 * Usage: node tools/record.mjs [--seed N] [--maxMs 300000] [--bots chud,chud]
 *                              [--verbose] [--only 3p|5p|passive|guest|cut]
 *   --only cut  re-cuts moments that have NO fixture file yet from the
 *               committed session-3p.json transcript, without replaying (see
 *               the pass's own comment).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  FIXTURE_DIR, SEED, ensureDir, parseArgs, readJSON, green, red, yellow, dim, bold,
  EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';
import { startServer } from './serve.mjs';
import { ChudClient, driveGame } from './lib/wsclient.mjs';

const args = parseArgs();
const seed = args.seed ? Number(args.seed) : SEED;
const maxMs = args.maxMs ? Number(args.maxMs) : 300000;
const verbose = !!args.verbose;
const only = args.only || null;
/** `--only X` runs pass X and nothing else; no flag runs every pass. */
const runs = (tag) => !only || only === tag;

ensureDir(FIXTURE_DIR);
console.log(bold('record') + dim(`  seed=${seed} → ${path.relative(process.cwd(), FIXTURE_DIR)}/`));

const written = [];
function write(name, payload) {
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  // Transcripts are compact: a pretty-printed 144-state transcript is 4.9MB
  // (each state carries the 120-event tail and the whole discard pile).
  // Curated single-state fixtures stay readable — a human reviews those.
  const pretty = payload.states.length <= 3;
  fs.writeFileSync(file, JSON.stringify(payload, null, pretty ? 1 : 0) + '\n');
  written.push({ name, states: payload.states.length, bytes: fs.statSync(file).size, note: payload.description });
  return file;
}

/* ─────────────────────────────── session ─────────────────────────────── */

/**
 * Play one game and return every state broadcast this seat saw.
 * @param {{label:string, bots:string[], seed:number, turnTimeout:number, responseTimeout:number, maxMs:number}} cfg
 */
async function session(server, cfg) {
  const client = new ChudClient(server.wsUrl, { name: 'HARNESS', verbose });
  await client.connect();

  await client.send({ type: 'create_room', name: 'HARNESS' });
  await client.waitFor((m) => m.type === 'joined', 10000, 'joined');
  const lobby = [];
  const states = [];

  // Lobby fill. add_bot is host-only and lobby-only (server/handlers.js).
  for (const mode of cfg.bots) {
    await client.send({ type: 'add_bot', mode });
    const s = await client.waitFor((m) => m.type === 'state', 10000, 'lobby state');
    lobby.push(s);
  }

  const collected = [];
  const res = await driveGame(client, {
    maxMs: cfg.maxMs,
    initialState: lobby[lobby.length - 1],
    planOpts: {
      turnTimeout: cfg.turnTimeout,
      responseTimeout: cfg.responseTimeout,
      // See wsclient.planMoves: a seat that folds is the only camera angle from
      // which the OPPONENTS get far enough to be worth photographing.
      passive: !!cfg.passive,
      opsec: cfg.passive ? false : undefined,
    },
    onState: (msg) => {
      collected.push(msg);
      if (collected.length % 25 === 0) process.stdout.write(dim('.'));
    },
  });
  states.push(...collected);
  client.close();

  return { ...res, lobby, states, selfId: client.playerId, code: client.roomCode, errors: client.errors };
}

/* ────────────────────────────── selectors ────────────────────────────── */

const boardCount = (g) =>
  g.players.reduce((n, p) => n + Object.values(p.properties || {}).flat().length, 0);
const bankCount = (p) => (p.bank || []).length;
const propCount = (p) => Object.values(p.properties || {}).flat().length;

/** @type {Array<{name:string, description:string, pick:(states:object[], selfId:string)=>object|null}>} */
const MOMENTS = [
  {
    name: 'early-game',
    description: 'First play phase of the opening turn — small hands, empty boards, full deck.',
    pick: (states) => states.find((s) => s.game?.turnPhase === 'play' && boardCount(s.game) <= 2)
      || states.find((s) => s.game?.turnPhase === 'play') || null,
  },
  {
    name: 'mid-game',
    description: 'Every seat holds properties and banked money — the dense table the layout must survive.',
    pick: (states, selfId) => {
      /* Must be OUR play phase with plays left — touchtest drag-plays a card
       * from this state — AND the hand must hold a wild_property: touchtest
       * also stages this fixture for the 'wild-place' driver, whose whole
       * subject is the myColor step that only playing a wild (two-colour or
       * rainbow) reaches. Seat shuffle (964d382) deals the recording seat a
       * wild-free hand often enough that a re-record certified exactly that
       * (triage 2026-08-08: re-recorded mid-game, 9 cards, no wild) and the
       * driver then died 'nowild:… mode idle' on a fixture THIS tool had
       * written. Requiring the content the consumer needs turns that silent
       * break into a loud "not reached in this game". */
      const hasWild = (g) => (g.players.find((p) => p.id === selfId)?.hand || [])
        .some((c) => c.type === 'wild_property');
      const ok = states.filter((s) => s.game
        && s.game.players.every((p) => propCount(p) >= 1 && bankCount(p) >= 1)
        && s.game.currentPlayerId === selfId
        && s.game.turnPhase === 'play'
        && s.game.playsRemaining > 0
        && !s.game.pendingAction
        && hasWild(s.game));
      if (!ok.length) return null;
      // Prefer the busiest board rather than the first qualifying one.
      return ok.reduce((best, s) => (boardCount(s.game) > boardCount(best.game) ? s : best));
    },
  },
  {
    name: 'payment-pending',
    description: 'A pending charge this seat owes — stages payment selection and the response timer.',
    pick: (states, selfId) => {
      const owes = (s) => {
        const pa = s.game?.pendingAction;
        if (!pa || !(pa.amount > 0)) return false;
        return Array.isArray(s.game.responders) && s.game.responders.includes(selfId);
      };
      const hits = states.filter(owes);
      if (!hits.length) return states.find((s) => s.game?.pendingAction?.amount > 0) || null;
      return hits.reduce((best, s) => (boardCount(s.game) > boardCount(best.game) ? s : best));
    },
  },
  {
    name: 'targeting',
    driven: true,   // screenshot/touchtest DRIVE this into a client-side mode before capture
    description: 'This seat is on turn holding a TARGETED card (rent/steal/swap) with legal victims on the '
      + 'table — the state tools/screenshot.mjs then DRIVES into target mode before capturing.',
    /**
     * P7 round-1 defect this selector fixes: the old predicate was satisfied by
     * almost any play-phase state, so it selected the SAME state as `big-hand`
     * and `targeting@*.png` came out byte-identical to `big-hand@*.png` (md5
     * verified). The targeting/selection foil moment therefore had zero visual
     * evidence in the entire review set while the gate reported PASS.
     *
     * Targeting is a CLIENT-SIDE mode — no server state can encode it — so the
     * honest fixture is "a state from which target mode is one tap away, and
     * which is not the state any other fixture already uses". Ranking by number
     * of targeted cards × number of victims makes that a different state than
     * "biggest hand" in practice, and `avoid` makes it one by construction.
     */
    pick: (states, selfId, picked) => {
      const TARGETED = ['midnight_requisition', 'chud', 'finance_office', 'inspector_general', 'tdy_orders'];
      const score = (s) => {
        const g = s.game;
        if (!g || g.pendingAction || g.currentPlayerId !== selfId || g.turnPhase !== 'play') return 0;
        if (!(g.playsRemaining > 0)) return 0;
        const me = g.players.find((p) => p.id === selfId);
        const targeted = (me?.hand || []).filter(
          (c) => c.type === 'rent' || TARGETED.includes(c.action)
        ).length;
        const victims = g.players.filter((p) => p.id !== selfId && propCount(p) > 0).length;
        if (!targeted || !victims) return 0;
        return targeted * 10 + victims;
      };
      const used = new Set(Object.values(picked || {}));
      const pool = states.filter((s) => score(s) > 0 && !used.has(s));
      if (!pool.length) return states.find((s) => score(s) > 0) || null;
      return pool.reduce((best, s) => (score(s) > score(best) ? s : best));
    },
  },
  {
    name: 'steal-set',
    driven: true,   // screenshot.mjs drives the theirSet targeting step before capture
    description: 'This seat is on turn holding Inspector General while an OPPONENT owns a complete '
      + 'set — the state screenshot.mjs drives into the `theirSet` targeting step. The `targeting` '
      + 'fixture cannot: its foes hold zero complete sets, so IG there is the REFUSAL, and the set '
      + 'steal — the interaction machine\'s only theirSet consumer — had never been entered by any gate.',
    pick: (states, selfId, picked) => {
      const ok = (s) => {
        const g = s.game;
        if (!g || g.pendingAction || g.currentPlayerId !== selfId) return false;
        if (g.turnPhase !== 'play' || !(g.playsRemaining > 0)) return false;
        const me = g.players.find((p) => p.id === selfId);
        if (!(me?.hand || []).some((c) => c.action === 'inspector_general')) return false;
        return g.players.some((p) => p.id !== selfId && (p.completedSets || 0) > 0);
      };
      const used = new Set(Object.values(picked || {}));
      const pool = states.filter((s) => ok(s) && !used.has(s));
      const hits = pool.length ? pool : states.filter(ok);
      if (!hits.length) return null;
      return hits.reduce((best, s) => (boardCount(s.game) > boardCount(best.game) ? s : best));
    },
  },
  {
    name: 'upgrade-set',
    driven: true,   // screenshot.mjs drives the mySet targeting step before capture
    description: 'This seat is on turn holding an Upgrade over a complete, un-upgraded set of its '
      + 'own — the state screenshot.mjs drives into the `mySet` targeting step (Upgrade/FOC '
      + 'placement, the other targeting step no gate had ever entered).',
    pick: (states, selfId, picked) => {
      const ok = (s) => {
        const g = s.game;
        if (!g || g.pendingAction || g.currentPlayerId !== selfId) return false;
        if (g.turnPhase !== 'play' || !(g.playsRemaining > 0)) return false;
        const me = g.players.find((p) => p.id === selfId);
        if (!(me?.hand || []).some((c) => c.action === 'upgrade')) return false;
        if (!((me?.completedSets || 0) > 0)) return false;
        // The Upgrade needs a complete set WITHOUT a house on it; a seat with a
        // complete set and no upgrades anywhere satisfies that by construction.
        return Object.values(me.upgrades || {}).every((v) => !(v || []).length);
      };
      const used = new Set(Object.values(picked || {}));
      const pool = states.filter((s) => ok(s) && !used.has(s));
      const hits = pool.length ? pool : states.filter(ok);
      if (!hits.length) return null;
      return hits.reduce((best, s) => (boardCount(s.game) > boardCount(best.game) ? s : best));
    },
  },
  {
    name: 'opsec-chain',
    driven: true,   // screenshot/touchtest DRIVE this into a client-side mode before capture
    description: 'A pending action the LOCAL seat must answer, at the deepest OPSEC chain recorded — '
      + 'the state where OPSEC / counter-OPSEC is actually the local player\'s decision.',
    /**
     * P7 round-1 defect this selector fixes: the old predicate ranked on chain
     * depth alone and selected a state whose `responders` was `[Blaze]` — a BOT.
     * The local seat had nothing to answer, so no tool and no screenshot ever
     * drove an OPSEC chain from the player's side; the deepest, most dramatic
     * rules moment in the game had no coverage while the gate said PASS.
     */
    pick: (states, selfId) => {
      const depth = (s) => {
        const pa = s.game?.pendingAction;
        if (!pa) return 0;
        const fromTargets = (pa.targets || []).map((t) => t.depth || 0);
        const fromChains = Object.values(pa.opsecChains || {}).map((c) => c.chain || 1);
        return Math.max(pa._opsecChain || 0, 0, ...fromTargets, ...fromChains);
      };
      const mine = (s) => Array.isArray(s.game?.responders) && s.game.responders.includes(selfId);
      const holdsOpsec = (s) => (s.game?.players.find((p) => p.id === selfId)?.hand || [])
        .some((c) => c.action === 'opsec' || c.action === 'just_say_no');
      // Strictly ordered preference — never silently fall back to a bot-only
      // chain, because that is the exact lie this fixture used to tell.
      const tiers = [
        (s) => mine(s) && depth(s) > 0 && holdsOpsec(s),
        (s) => mine(s) && depth(s) > 0,
        (s) => mine(s) && s.game?.pendingAction && holdsOpsec(s),
      ];
      for (const ok of tiers) {
        const hits = states.filter(ok);
        if (hits.length) return hits.reduce((best, s) => (depth(s) > depth(best) ? s : best));
      }
      return null;
    },
  },
  {
    name: 'opsec-decision',
    driven: true,   // captured with the prompt bar live; the choice is the picture
    description: 'The LOCAL seat is under attack AND holds an OPSEC card — the state where '
      + '"Accept / OPSEC" is a real decision rather than a formality.',
    // Split out from opsec-chain in P7 round 1. `opsec-chain` guarantees chain
    // DEPTH; this guarantees the local player has both buttons. Neither alone
    // proves the OPSEC UI works from the player's side, which is why the round-1
    // review set — one bot-only chain — showed nothing.
    pick: (states, selfId, picked) => {
      const used = new Set(Object.values(picked || {}));
      const ok = (s) => {
        const g = s.game;
        if (!g?.pendingAction) return false;
        if (!Array.isArray(g.responders) || !g.responders.includes(selfId)) return false;
        return (g.players.find((p) => p.id === selfId)?.hand || []).some((c) => c.action === 'opsec');
      };
      const pool = states.filter((s) => ok(s) && !used.has(s));
      const hits = pool.length ? pool : states.filter(ok);
      if (!hits.length) return null;
      // A theft hurts more than a bill: prefer the non-payment attacks.
      const steal = hits.filter((s) => s.game.pendingAction.type !== 'payment');
      return (steal.length ? steal : hits)[0];
    },
  },
  {
    name: 'discard-limit',
    driven: true,   // screenshot/touchtest DRIVE this into a client-side mode before capture
    description: 'This seat is over the hand limit on its own turn — tapping END TURN here opens the '
      + 'discard-to-limit selection, the one flow no fixture used to stage.',
    pick: (states, selfId) => {
      const excess = (s) => {
        const g = s.game;
        if (!g || g.pendingAction || g.currentPlayerId !== selfId) return 0;
        if (g.turnPhase !== 'play') return 0;
        const me = g.players.find((p) => p.id === selfId);
        return (me?.hand || []).length - (g.handLimit || 7);
      };
      const hits = states.filter((s) => excess(s) > 0);
      if (!hits.length) return null;
      return hits.reduce((best, s) => (excess(s) > excess(best) ? s : best));
    },
  },
  {
    name: 'big-hand',
    description: 'Largest hand this seat ever held — the fan-layout worst case (hand limit is 7 plus draws).',
    pick: (states, selfId, picked) => {
      const size = (s) => (s.game?.players.find((p) => p.id === selfId)?.hand || []).length;
      // Must not be a state another fixture already owns: `discard-limit` wants
      // the same "hand over the limit" shape, and when both landed on the same
      // state the review set carried two names for one picture.
      const used = new Set(Object.values(picked || {}));
      const pool = states.filter((s) => !used.has(s));
      for (const floor of [8, 7]) {
        const hits = pool.filter((s) => size(s) >= floor);
        if (hits.length) return hits.reduce((best, s) => (size(s) > size(best) ? s : best));
      }
      return null;
    },
  },
  {
    name: 'final-approach',
    description: 'A player is armed (3 complete sets, win pending) — the dramatic-peak state the alarm treatment stages.',
    pick: (states) => {
      const hits = states.filter((s) => (s.game?.armedIds || []).length > 0 && s.game.phase === 'playing');
      if (!hits.length) return null;
      // Busiest armed board; prefer states where the viewer is NOT the armed one (threat view).
      const threat = hits.filter((s) => s.game.armedIds[0] !== s.game.currentPlayerId);
      const pool = threat.length ? threat : hits;
      return pool.reduce((best, s) => (boardCount(s.game) > boardCount(best.game) ? s : best));
    },
  },
  {
    name: 'finished',
    description: 'Win screen state — winner set, phase finished, final boards intact.',
    pick: (states) => [...states].reverse().find((s) => s.game?.phase === 'finished') || null,
  },
];

/* ─────────────────── the OPPONENT half of the table ───────────────────
 *
 * Three renderings that only exist on a seat that is NOT yours — an upgrade
 * lane, a second mat row, the ARMED treatment on a collapsed seat — and which
 * no fixture in this directory had ever contained. Not because they are rare:
 * because every transcript was recorded from a seat that plays as hard as it
 * can, and that seat wins the race to all three. Across the committed 3-player
 * game (137 broadcasts) the count of opponents who ever held an upgrade, ever
 * reached six colours, or ever armed is zero, zero and zero.
 *
 * They come off a PASSIVE seat instead (wsclient.planMoves `passive`): still a
 * real game, still every state server-validated, but with the camera holding
 * still long enough for the bots to finish something.
 */
const nonEmptyColors = (p) => Object.values(p.properties || {}).filter((v) => (v || []).length).length;
const upgradeCount = (p) => Object.values(p.upgrades || {}).flat().length;

const OPPONENT_MOMENTS = [
  {
    name: 'opponent-upgrade',
    description: 'An OPPONENT holds an Upgrade/FOC on a complete set — the seat\'s upgrade lane and its '
      + 'corner geometry, which no recorded fixture had ever put on a seat that is not yours.',
    pick: (states, selfId) => {
      const score = (s) => {
        if (s.game?.phase !== 'playing') return 0;
        const foes = s.game.players.filter((p) => p.id !== selfId);
        const ups = foes.reduce((n, p) => n + upgradeCount(p), 0);
        if (!ups) return 0;
        return ups * 1000 + boardCount(s.game);
      };
      const hits = states.filter((s) => score(s) > 0);
      if (!hits.length) return null;
      return hits.reduce((best, s) => (score(s) > score(best) ? s : best));
    },
  },
  {
    name: 'opponent-wide',
    description: 'An OPPONENT holding six or more colours at once — the first state that pushes another '
      + 'seat\'s mat onto a second row.',
    pick: (states, selfId, picked) => {
      const used = new Set(Object.values(picked || {}));
      const width = (s) => (s.game?.phase !== 'playing' ? 0
        : Math.max(0, ...s.game.players.filter((p) => p.id !== selfId).map(nonEmptyColors)));
      // Prefer a state where NOBODY is armed: `opponent-armed` wants the
      // busiest board too, and on the recorded transcript both landed on the
      // same broadcast — two fixture names for one picture, which record.mjs
      // has refused since P7 round 1. Separating them by subject also makes
      // each shot about one thing.
      const pool = states.filter((s) => width(s) >= 6 && !used.has(s));
      const calm = pool.filter((s) => !(s.game.armedIds || []).length);
      const hits = calm.length ? calm : pool;
      if (!hits.length) return null;
      // Widest, then busiest — the row break is the subject, so more of it is better.
      return hits.reduce((best, s) => {
        const d = width(s) - width(best);
        return d > 0 || (d === 0 && boardCount(s.game) > boardCount(best.game)) ? s : best;
      });
    },
  },
  {
    name: 'approach-called',
    pair: true,
    description: 'TWO consecutive broadcasts: the one before an opponent arms, and the one whose event '
      + 'tail carries `final_approach`. Applied in order, the client raises ui/journal.js\'s full-width '
      + '`.announce` banner — a surface that exists in no snapshot and that nothing had ever photographed.',
    /**
     * The banner is not state, it is a REACTION. journal.js announces off
     * CHOREO_EVENT, so the only honest way to reach it is to make the event
     * arrive — which means a fixture has to carry the broadcast BEFORE it too,
     * or `lastSeq` swallows the difference. Every other fixture in this
     * directory is one state, and that is exactly why this surface had no shot.
     */
    pick: (states, selfId) => {
      const seqs = (s) => new Set((s.game?.events || []).map((e) => e.seq));
      for (let i = 1; i < states.length; i++) {
        const before = states[i - 1];
        const after = states[i];
        if (!after.game || !before.game) continue;
        const known = seqs(before);
        const fresh = (after.game.events || []).filter((e) => !known.has(e.seq));
        if (!fresh.some((e) => e.t === 'final_approach' && e.actor !== selfId)) continue;
        return [before, after];
      }
      return null;
    },
  },
  {
    name: 'opponent-armed',
    description: 'An OPPONENT is on Final Approach and this seat is not — the ARMED treatment as a THREAT, '
      + 'on somebody else\'s (collapsible) seat rather than on your own board.',
    /**
     * The `final-approach` selector in MOMENTS above claims to prefer "the
     * threat view" and tests `armedIds[0] !== currentPlayerId`, which is a
     * different question: the armed player is simply not the one on turn. It
     * has always selected a state where the ARMED player IS the local seat, so
     * the threat rendering — the only one that appears on a collapsed opponent
     * seat — was never in the review set. This one tests against selfId.
     */
    pick: (states, selfId, picked) => {
      const used = new Set(Object.values(picked || {}));
      const hits = states.filter((s) => s.game?.phase === 'playing'
        && (s.game.armedIds || []).some((id) => id !== selfId)
        && !(s.game.armedIds || []).includes(selfId)
        && !used.has(s));
      if (!hits.length) return null;
      return hits.reduce((best, s) => (boardCount(s.game) > boardCount(best.game) ? s : best));
    },
  },
];

/* ──────────────────────────────── run ────────────────────────────────── */

let code = EXIT_PASS;
/**
 * Moments the review set and the gates are BUILT on. A missing one is not a
 * "this game didn't happen to reach it" — it is a hole in the evidence, and the
 * P7 round-1 critics found every hole. Re-run with another --seed until the
 * game reaches them, or fix the selector.
 */
const REQUIRED = ['early-game', 'mid-game', 'payment-pending', 'targeting', 'opsec-chain', 'opsec-decision', 'big-hand', 'discard-limit', 'finished'];
const missing = [];
const server = await startServer({ seed });
console.log(dim(`  server on ${server.url}`));

try {
  /* ---- 3-player game, played to the end ---------------------------------- */
  let main = null;
  if (runs('3p')) {
    const bots = (args.bots ? String(args.bots).split(',') : ['chud', 'aggressive']).map((s) => s.trim());
    process.stdout.write(`  3p vs [${bots.join(', ')}] `);
    main = await session(server, {
      label: '3p', bots, seed,
      turnTimeout: 60, responseTimeout: 30, maxMs,
    });
    console.log(
      ` ${main.finished ? green('finished') : yellow('timed out')} ` +
      dim(`${main.states.length} states, room ${main.code}`)
    );
    if (main.errors.length) {
      console.log(dim(`    ${main.errors.length} server rejections (expected: the policy probes moves)`));
    }
    if (!main.states.length) {
      console.log(red('  ✗ no state broadcasts received'));
      code = EXIT_FAIL;
    }

    // Six evenly spaced states from the same real game. The full transcript is
    // 2.5MB and gitignored; this is the committed slice the shot list uses, so
    // a fresh clone can regenerate the review set without recording first.
    if (main.states.length >= 8) {
      // Sample the INTERIOR of the game, not the endpoints. Sampling from 0
      // made `arc-1-opening` byte-identical to the `early-game` shot (caught by
      // screenshot.mjs's hash detector), and sampling to the last state would
      // do the same to `arc-6` and `win`. The arc's job is the middle.
      const FRACTIONS = [0.08, 0.24, 0.40, 0.56, 0.72, 0.88];
      const last = main.states.length - 1;
      const arc = FRACTIONS.map((f) => main.states[Math.round(f * last)]);
      write('arc', {
        $schema: 'chud-fixture/1',
        name: 'arc',
        description: 'Six evenly spaced moments from one real 3-player game, opening to win screen.',
        seed, selfId: main.selfId, room: main.code,
        recordedAt: new Date().toISOString(),
        states: arc,
      });
      console.log(`  ${green('✓')} ${'arc'.padEnd(16)} ${dim(`6 moments across ${main.states.length} broadcasts`)}`);
    }

    write('session-3p', {
      $schema: 'chud-fixture/1',
      name: 'session-3p',
      description: 'Full transcript: every state broadcast one seat received across a real 3-player game.',
      seed, selfId: main.selfId, room: main.code, recordedAt: new Date().toISOString(),
      states: main.states,
    });

    /**
     * Two named fixtures resolving to the SAME state is not a curiosity, it is
     * the failure that made `targeting@*.png` byte-identical to
     * `big-hand@*.png` for an entire review round. Recording is the only place
     * that can see it before it becomes a screenshot, so it fails here too.
     */
    const picked = {};
    for (const m of MOMENTS) {
      const hit = m.pick(main.states, main.selfId, picked);
      if (!hit) {
        console.log(`  ${yellow('!')} ${m.name.padEnd(16)} ${dim('not reached in this game')}`);
        missing.push(m.name);
        continue;
      }
      const clash = Object.entries(picked).find(([, s]) => s === hit);
      // Two `driven` moments may share a state: each is captured after being
      // driven into a DIFFERENT client-side mode, so the pictures differ even
      // though the snapshot does not. screenshot.mjs's hash detector is what
      // proves that claim; here we only refuse the un-driven collisions.
      const bothDriven = clash && m.driven && MOMENTS.find((x) => x.name === clash[0])?.driven;
      if (clash && !bothDriven) {
        console.log(`  ${red('✗')} ${m.name.padEnd(16)} ${red(`selects the SAME state as '${clash[0]}' — the two fixtures would render identical shots`)}`);
        code = EXIT_FAIL;
      }
      picked[m.name] = hit;
      write(m.name, {
        $schema: 'chud-fixture/1',
        name: m.name,
        description: m.description,
        seed, selfId: main.selfId, room: main.code,
        recordedAt: new Date().toISOString(),
        stateIndex: main.states.indexOf(hit),
        states: [hit],
      });
      console.log(`  ${green('✓')} ${m.name.padEnd(16)} ${dim(`turn ${hit.game?.stats?.turns ?? '?'}, ${boardCount(hit.game)} cards on boards`)}`);
    }
  }

  /* ---- cut: NEW moments from the COMMITTED transcript --------------------
   * `--only cut` re-runs the selectors over tools/fixtures/session-3p.json —
   * the same recorder output the committed fixtures were cut from — without
   * replaying the game. It exists because re-recording rewrites EVERY fixture
   * (bots act on a wall clock a seed cannot fully fix), and "add one moment"
   * must not move the states forty existing shots are calibrated against.
   * Only moments with no committed fixture file are cut; the transcript IS
   * recorder output, so §9's "recorded from real seeded games" holds bit for
   * bit. Explicit-only: a plain `node tools/record.mjs` records fresh and cuts
   * everything in MOMENTS the normal way. */
  if (only === 'cut') {
    const file = path.join(FIXTURE_DIR, 'session-3p.json');
    if (!fs.existsSync(file)) {
      console.log(red('  ✗ --only cut: no tools/fixtures/session-3p.json — record first'));
      code = EXIT_FAIL;
    } else {
      const t = readJSON(file);
      // States a committed fixture from this same recording already owns: a
      // new name resolving to one of them is the two-names-one-picture failure
      // record.mjs has refused since P7 round 1.
      const owned = new Map();
      for (const f of fs.readdirSync(FIXTURE_DIR)) {
        if (!f.endsWith('.json') || f === 'session-3p.json') continue;
        let j;
        try { j = readJSON(path.join(FIXTURE_DIR, f)); } catch { continue; }
        if (j.room === t.room && Number.isInteger(j.stateIndex)) owned.set(j.stateIndex, j.name || f);
      }
      const fresh = MOMENTS.filter((m) => !fs.existsSync(path.join(FIXTURE_DIR, `${m.name}.json`)));
      if (!fresh.length) console.log(dim('  cut: every moment already has a fixture — nothing to do'));
      const picked = {};
      for (const m of fresh) {
        const hit = m.pick(t.states, t.selfId, picked);
        if (!hit) {
          console.log(`  ${red('✗')} ${m.name.padEnd(16)} ${red('not reachable in the committed transcript — record a new game for it')}`);
          code = EXIT_FAIL;
          continue;
        }
        const idx = t.states.indexOf(hit);
        const clash = owned.get(idx);
        // Two DRIVEN moments may share a snapshot (each is photographed in a
        // different client-side mode); an un-driven collision is refused.
        if (clash && !m.driven) {
          console.log(`  ${red('✗')} ${m.name.padEnd(16)} ${red(`selects state ${idx}, already owned by '${clash}'`)}`);
          code = EXIT_FAIL;
          continue;
        }
        picked[m.name] = hit;
        write(m.name, {
          $schema: 'chud-fixture/1',
          name: m.name,
          description: m.description,
          seed: t.seed, selfId: t.selfId, room: t.room,
          recordedAt: t.recordedAt,
          cutAt: new Date().toISOString(),
          stateIndex: idx,
          states: [hit],
        });
        console.log(`  ${green('✓')} ${m.name.padEnd(16)} ${dim(`state ${idx} of ${t.states.length}, `
          + `${boardCount(hit.game)} cards on boards${clash ? ` (shares ${clash}'s snapshot; both driven)` : ''}`)}`);
      }
    }
  }

  /* ---- 5-player table + a real lobby ------------------------------------- */
  if (runs('5p')) {
    process.stdout.write('  5p table ');
    const five = await session(server, {
      label: '5p', bots: ['conservative', 'neutral', 'aggressive', 'chud'], seed: seed + 1,
      turnTimeout: 60, responseTimeout: 30,
      maxMs: Math.min(maxMs, Number(args.fiveMs || 90000)),
    });
    console.log(` ${dim(`${five.states.length} states, room ${five.code}`)}`);

    if (five.lobby.length) {
      const full = five.lobby[five.lobby.length - 1];
      write('lobby', {
        $schema: 'chud-fixture/1',
        name: 'lobby',
        description: 'Real 5-seat lobby broadcast: host, four bots with modes, no game yet.',
        seed: seed + 1, selfId: five.selfId, room: five.code,
        recordedAt: new Date().toISOString(),
        states: [full],
      });
      console.log(`  ${green('✓')} ${'lobby'.padEnd(16)} ${dim(`${full.players.length} seats`)}`);
    }

    const busiest = five.states.length
      ? five.states.reduce((best, s) => (s.game && boardCount(s.game) > boardCount(best.game || { players: [] }) ? s : best), five.states[0])
      : null;
    if (busiest?.game) {
      write('five-player', {
        $schema: 'chud-fixture/1',
        name: 'five-player',
        description: 'Busiest 5-player board reached — the maximum-density table (§8 shot list).',
        seed: seed + 1, selfId: five.selfId, room: five.code,
        recordedAt: new Date().toISOString(),
        stateIndex: five.states.indexOf(busiest),
        states: [busiest],
      });
      console.log(`  ${green('✓')} ${'five-player'.padEnd(16)} ${dim(`${boardCount(busiest.game)} cards on boards`)}`);
    } else if (!main) {
      code = EXIT_FAIL;
    }
  }

  /* ---- passive seat: the OPPONENT half of the table ----------------------- */
  if (runs('passive')) {
    process.stdout.write('  passive seat (4p) ');
    const quiet = await session(server, {
      label: 'passive', bots: ['aggressive', 'chud', 'neutral'], seed: seed + 2,
      turnTimeout: 60, responseTimeout: 30, passive: true,
      maxMs: Math.min(maxMs, Number(args.passiveMs || 180000)),
    });
    console.log(` ${dim(`${quiet.states.length} states, room ${quiet.code}`)}`);
    const pickedOpp = {};
    for (const m of OPPONENT_MOMENTS) {
      const hit = m.pick(quiet.states, quiet.selfId, pickedOpp);
      if (!hit) {
        console.log(`  ${yellow('!')} ${m.name.padEnd(16)} ${dim('not reached in this game')}`);
        missing.push(m.name);
        continue;
      }
      const picked = Array.isArray(hit) ? hit : [hit];
      const last = picked[picked.length - 1];
      const clash = Object.entries(pickedOpp).find(([, s]) => s === last);
      if (clash) {
        console.log(`  ${red('✗')} ${m.name.padEnd(16)} ${red(`selects the SAME state as '${clash[0]}'`)}`);
        code = EXIT_FAIL;
      }
      pickedOpp[m.name] = last;
      const foe = last.game.players.filter((p) => p.id !== quiet.selfId);
      write(m.name, {
        $schema: 'chud-fixture/1',
        name: m.name,
        description: m.description,
        seed: seed + 2, selfId: quiet.selfId, room: quiet.code,
        recordedAt: new Date().toISOString(),
        stateIndex: quiet.states.indexOf(last),
        states: picked,
      });
      console.log(`  ${green('✓')} ${m.name.padEnd(16)} `
        + dim(`${picked.length} state(s), ${boardCount(last.game)} cards on boards, widest foe `
          + `${Math.max(0, ...foe.map(nonEmptyColors))} colours, `
          + `foe upgrades ${foe.reduce((n, p) => n + upgradeCount(p), 0)}, armed ${(last.game.armedIds || []).length}`));
    }
  }

  /* ---- a lobby seen from a GUEST -----------------------------------------
   * `lobby.json` is recorded from the seat that CREATED the room, so with the
   * §9 bridge finally handing the client its seat (`__CHUD.joinAs`) it renders
   * the host's lobby — the room code, the bot picker, the ruleset toggles and
   * Launch Mission. That is the right picture for that transcript, and it is
   * also not the picture most players see. A guest's lobby is a different
   * screen (`#lobby-host` hidden, `#ruleset-guest` shown, no per-seat Kick),
   * and until now the harness had it only by accident — by failing to set the
   * seat at all. An accident is not coverage, so it is recorded properly.     */
  if (runs('guest')) {
    process.stdout.write('  guest lobby ');
    const host = new ChudClient(server.wsUrl, { name: 'HOST', verbose });
    await host.connect();
    await host.send({ type: 'create_room', name: 'HOST' });
    const joined = await host.waitFor((m) => m.type === 'joined', 10000, 'joined');
    for (const mode of ['neutral', 'aggressive']) {
      await host.send({ type: 'add_bot', mode });
      await host.waitFor((m) => m.type === 'state', 10000, 'lobby state');
    }
    const guest = new ChudClient(server.wsUrl, { name: 'SQUADMATE', verbose });
    await guest.connect();
    await guest.send({ type: 'join_room', code: joined.code, name: 'SQUADMATE' });
    await guest.waitFor((m) => m.type === 'joined', 10000, 'guest joined');
    const seen = await guest.waitFor((m) => m.type === 'state' && !m.game, 10000, 'guest lobby state');
    guest.close();
    host.close();
    if (seen.hostId === guest.playerId) {
      console.log(red('  ✗ the guest recorded itself as host — the fixture would be a second host lobby'));
      code = EXIT_FAIL;
    } else {
      write('lobby-guest', {
        $schema: 'chud-fixture/1',
        name: 'lobby-guest',
        description: 'The same room from a SECOND HUMAN seat: host block hidden, ruleset read-only, '
          + 'no per-seat controls — the lobby most players actually see.',
        seed, selfId: guest.playerId, room: joined.code,
        recordedAt: new Date().toISOString(),
        states: [seen],
      });
      console.log(`  ${green('✓')} ${'lobby-guest'.padEnd(16)} ${dim(`${seen.players.length} seats, host ${seen.hostId === joined.playerId ? 'is the creator' : '???'}`)}`);
    }
  }
} catch (e) {
  console.log(red(`  ✗ ${e.stack || e.message}`));
  code = EXIT_FAIL;
} finally {
  await server.stop();
}

/** The opponent-side renderings, required of the passive pass for the same
 *  reason: a fixture that is "not reached" is a gate that measures nothing. */
const REQUIRED_PASSIVE = OPPONENT_MOMENTS.map((m) => m.name);
const missedPassive = missing.filter((m) => REQUIRED_PASSIVE.includes(m));
if (missedPassive.length && runs('passive')) {
  console.log(red(bold(`  ✗ opponent moment(s) never reached: ${missedPassive.join(', ')}`)));
  console.log(dim('    the opponent half of the table is ungated here — re-run with another --seed'));
  code = EXIT_FAIL;
}

const missedRequired = missing.filter((m) => REQUIRED.includes(m));
if (missedRequired.length && runs('3p')) {
  console.log(red(bold(`  ✗ required moment(s) never reached: ${missedRequired.join(', ')}`)));
  console.log(dim('    the review set and the gates that stage them are blind here — re-run with another --seed'));
  code = EXIT_FAIL;
}

console.log(dim(`  ${written.length} fixture file(s):`));
for (const w of written) {
  console.log(dim(`    ${w.name.padEnd(18)} ${String(w.states).padStart(4)} state(s)  ${String(Math.round(w.bytes / 1024)).padStart(4)}KB`));
}
console.log(code === EXIT_PASS ? green(bold('record: PASS')) : red(bold('record: FAIL')));
process.exit(code);
