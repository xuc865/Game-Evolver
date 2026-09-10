// server/gamelog.js — durable per-game records so "how did I lose that?" is answerable.
//
// A finished game used to leave five console lines about room lifecycle and nothing about
// the game itself. This appends ONE JSONL line per finished game containing the seed, the
// resolved ruleset, the seat order and bot modes, the retained event stream and the final
// boards — enough to reconstruct the ending, and enough to replay it exactly when the game
// was seeded.
//
// Rules this module lives by:
//   * it can never throw into a room (every entry point is wrapped);
//   * it never blocks the event loop (async append, errors swallowed after one warning);
//   * it is bounded (byte cap; the closed file is GZIPPED into a bounded ring of archives,
//     so rotation is no longer data loss);
//   * it is opt-outable (CHUD_GAME_LOG=0/off/false);
//   * ONE BAD GAME NEVER SILENCES THE REST. A record that cannot be built or serialized
//     skips itself and logging continues — the games most worth recording are the weird
//     ones, so "malformed" is the last thing that should switch forensics off. Only a
//     filesystem error (the one thing retrying cannot fix) hard-disables the module.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');

// ── the directory, probed at boot ──────────────────────────────────────────
// Railway mounts volumes at RUNTIME only — never at build or pre-deploy — so
// module load (server start) is exactly the moment a configured dir is
// guaranteed mounted if it is ever going to be. Two failure shapes, both
// PROBED before this existed (2026-08-07, child node with the env set):
//   * the dir cannot be created (volume absent, no permission at /): the lazy
//     mkdirSync inside ensureReady() threw on first write, the module
//     HARD-DISABLED after one warning, and every game thereafter was silently
//     unrecorded. Total loss, not fallback.
//   * the dir is creatable but wrong: records flowed into ephemeral storage,
//     silently, indistinguishable from working.
// The first case is what this probe converts into the second — PLUS a banner,
// because "silently identical to working" is the actual defect in both. The
// probe is a real write, not an access() guess (a mounted-read-only volume
// passes mkdir and fails write). On failure the module falls back to the
// repo's ./logs so records keep flowing while the banner is acted on.
function resolveDir() {
  const configured = process.env.CHUD_GAME_LOG_DIR;
  const fallback = path.join(__dirname, '..', 'logs');
  if (!configured) return fallback;
  try {
    fs.mkdirSync(configured, { recursive: true });
    const probe = path.join(configured, '.chud-write-probe');
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return configured;
  } catch (error) {
    console.warn(`[GAMELOG] CHUD_GAME_LOG_DIR=${configured} is not writable `
      + `(${error?.code || error?.message || error}) — falling back to ${fallback}`);
    console.warn('[GAMELOG] THAT DIRECTORY IS EPHEMERAL ON RAILWAY. '
      + 'Records will be lost on the next deploy. Check the volume mount.');
    return fallback;
  }
}
const DIR = resolveDir();
// The LIVE file is deliberately plain text. The whole point of JSONL is that a human can
// grep/jq it mid-investigation, so it is never compressed in place and never per-line.
const FILE = path.join(DIR, 'games.jsonl');
const ARCHIVE_RE = /^games-(.+?)\.jsonl(\.gz(\.part)?)?$/;
// 32MB of plain text per file. Measured on a real 3-seat/23-turn/200-event record:
// 49,160 B raw -> 5,813 B gzip (11.8%), so each archive costs ~3.8MB.
const MAX_BYTES = Math.max(0, Number(process.env.CHUD_GAME_LOG_MAX_BYTES) || 32 * 1024 * 1024);
// How many closed archives to keep. Default 5 => ~192MB of raw history for ~19MB on disk.
const ARCHIVES = Math.max(0, Number(process.env.CHUD_GAME_LOG_ARCHIVES ?? 5));

function enabled() {
  const raw = String(process.env.CHUD_GAME_LOG ?? '1').toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(raw);
}

let ready = false;
let bytes = 0;
let fsDisabled = false;      // set ONLY by filesystem failures
let warned = false;
let written = 0;
let skipped = 0;
// Serializes the rotate-and-append so a rename never runs mid-append (see the
// Phase 2 note in recordFinished). Every write chains behind the previous one.
let writeChain = Promise.resolve();

function warnOnce(error) {
  if (warned) return;
  warned = true;
  console.warn('[GAMELOG] disabled after filesystem failure:', error?.message || error);
}

function stats() { return { written, skipped, disabled: fsDisabled }; }

function ensureReady() {
  if (ready) return true;
  fs.mkdirSync(DIR, { recursive: true });
  try { bytes = fs.statSync(FILE).size; } catch { bytes = 0; }
  ready = true;
  return true;
}

// Rotation. The live file is CLOSED by an atomic rename and a fresh one is created by the
// next append; the closed file is then gzipped in the background.
//
// Why rename-then-compress rather than compress-then-replace: a synchronous gzip of a full
// 32MB file stalls the event loop for ~1s, freezing every room on the instance, and
// compressing a file that is still being appended to would race the writer. After the
// rename nothing writes to the closed file, so it can be streamed at leisure.
//
// Appends are asynchronous, so the live file may not exist on disk yet when the in-process
// byte counter says it is time to rotate; that is not an error.
// The stamp was millisecond-granular and renameSync clobbers silently, so two rotations
// inside one millisecond destroyed a whole generation and raced the `.part` -> `.gz` rename
// of the generation they had just overwritten (measured with ARCHIVES=999 and a 40KB cap:
// 300 records written, 139 recoverable on disk, 161 lost — 54%). A monotonic, zero-padded
// counter after the timestamp makes every generation distinct while keeping the lexical
// sort chronological, which pruneArchives depends on.
let rotateSeq = 0;
function nextArchivePath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let attempt = 0; attempt < 1000; attempt++) {
    const seq = String(++rotateSeq).padStart(6, '0');
    const candidate = path.join(DIR, `games-${stamp}-${seq}.jsonl`);
    // Belt and braces: never rename onto a path that already exists, whatever produced it
    // (a restarted process resets rotateSeq, and its ring is still on disk).
    if (!fs.existsSync(candidate) && !fs.existsSync(candidate + '.gz')
      && !fs.existsSync(candidate + '.gz.part')) return candidate;
  }
  return null;
}

function rotate() {
  bytes = 0;
  try {
    if (!fs.existsSync(FILE)) return;
    if (ARCHIVES === 0) { fs.rmSync(FILE, { force: true }); return; }
    const closed = nextArchivePath();
    if (!closed) throw new Error('no free archive path');
    fs.renameSync(FILE, closed);   // atomic: the live path is safe from here on
    compressArchive(closed);
  } catch (error) {
    // The rename is the only part that can affect the live write path.
    fsDisabled = true;
    warnOnce(error);
  }
}

// Background, streamed, and written to a `.part` name first so a half-written archive is
// never mistaken for a complete one. A failure here cannot corrupt the live file and does
// NOT disable logging: the plain closed file is left in place, so no data is lost — only
// the space saving is.
function compressArchive(closed) {
  const finalPath = closed + '.gz';
  const partPath = finalPath + '.part';
  const finish = (error) => {
    try {
      if (error) {
        fs.rmSync(partPath, { force: true });
        console.warn('[GAMELOG] archive compression failed, keeping the plain file:',
          error?.message || error);
      } else if (fs.existsSync(finalPath)) {
        // Never clobber a complete archive with a different generation's bytes.
        console.warn('[GAMELOG] archive target already exists, keeping the plain file:', finalPath);
        fs.rmSync(partPath, { force: true });
      } else {
        fs.renameSync(partPath, finalPath);      // becomes visible only when complete
        fs.rmSync(closed, { force: true });
      }
    } catch (cleanupError) {
      console.warn('[GAMELOG] archive cleanup failed:', cleanupError?.message || cleanupError);
    }
    pruneArchives();
  };
  try {
    pipeline(fs.createReadStream(closed), zlib.createGzip(), fs.createWriteStream(partPath), finish);
  } catch (error) {
    finish(error);
  }
}

// Keeps the newest ARCHIVES closed generations. ISO timestamps sort lexicographically, so
// a plain sort is chronological. All files belonging to a doomed generation go together,
// including any orphaned `.part` from an interrupted compression.
function pruneArchives() {
  try {
    const byStamp = new Map();
    for (const name of fs.readdirSync(DIR)) {
      const match = ARCHIVE_RE.exec(name);
      if (!match) continue;
      if (!byStamp.has(match[1])) byStamp.set(match[1], []);
      byStamp.get(match[1]).push(name);
    }
    const stamps = [...byStamp.keys()].sort();
    for (const stamp of stamps.slice(0, Math.max(0, stamps.length - ARCHIVES))) {
      for (const name of byStamp.get(stamp)) fs.rmSync(path.join(DIR, name), { force: true });
    }
  } catch (error) {
    console.warn('[GAMELOG] archive pruning failed:', error?.message || error);
  }
}

// SCHEMA — still 1, and the §3.2 card-id encoding is DEFERRED, on purpose (2026-08-08).
// The measured case for it is real: 47% of event bytes are repeated full card objects on
// deal/draw, and bare ids would take a real record from ~61.5KB to ~33KB (DESIGN.md §3.2).
// It is not taken now for three reasons, in order:
//   1. The retention problem it halves was just solved 40× over by CHUD_GAME_LOG_ARCHIVES
//      (documented in .env.example: 200 archives ≈ 100k games vs the default's ~3.2k) —
//      a 1.9× encoding win on top is not worth touching the forensic path for today.
//   2. DESIGN.md's own implementation order says to land `schema: 2` "when there is
//      nothing else in flight", and the rank ladder is in flight in this very change.
//   3. An event-shape transform inside buildRecord is the one edit here that could
//      corrupt records silently; every existing analysis script and the §2.11 "recompute
//      SP from the log" story parse schema-1 lines. When it lands it must come with a
//      `schema: 2` field and a replay test, together.
//
// buildRecord must be TOTAL: a game whose state is structurally odd is exactly the game
// worth recording, so every collection is coerced rather than trusted. (Audited 2026-08-06:
// no engine or server path assigns null to any of these — every assignment is {} or a
// filtered array — so these coercions only ever fire for genuinely corrupt states.)
const asArray = v => (Array.isArray(v) ? v : []);
const asEntries = v => (v && typeof v === 'object' ? Object.entries(v) : []);
const cardId = c => (c && c.id !== undefined ? c.id : null);

function board(player) {
  const p = player && typeof player === 'object' ? player : {};
  return {
    id: p.id ?? null,
    name: p.name ?? null,
    eliminated: !!p.eliminated,
    finalApproach: !!p.finalApproach,
    handCount: asArray(p.hand).length,
    bank: asArray(p.bank).map(cardId),
    properties: Object.fromEntries(asEntries(p.properties)
      .map(([color, cards]) => [color, asArray(cards).map(cardId)])
      .filter(([, ids]) => ids.length)),
    upgrades: Object.fromEntries(asEntries(p.upgrades)
      .map(([color, ups]) => [color, asArray(ups).map(u => (u && u.upgradeType) || 'upgrade')])),
  };
}

// A seat counts as HUMAN if a human EVER occupied it — not merely if one is sitting there
// at the final broadcast. Verified against every transition in server/handlers.js:
//   * leave_room mid-game (:241) and handleClose (:467) set isBot=true AND _wasHuman=true
//   * reclaiming the seat on rejoin (:131-133) or reconnect (:173-175) clears both
// so `!isBot || _wasHuman` is true for exactly the seats a human ever held. Deciding from
// `isBot` alone would have thrown away the events of any game somebody disconnected from —
// the single most likely game to be asked about.
function everHuman(seat) {
  return !seat?.isBot || !!seat?._wasHuman;
}

function safeValidate(state, G) {
  try { return G ? G.validateState(state) : null; }
  catch (error) { return { error: 'validateState threw: ' + (error?.message || error) }; }
}

function buildRecord(room, G) {
  const state = room.state;
  const seats = asArray(room.players);
  const humanSeats = seats.filter(everHuman).length;
  const replayable = state.seed != null;
  const omitEvents = seats.length > 0 && humanSeats === 0 && replayable;
  return {
    ts: new Date().toISOString(),
    code: room.code,
    seed: state.seed ?? null,
    // Unseeded production games cannot be replayed from the seed; the event stream below
    // is the reconstruction. `eventsTotal` vs `events.length` shows whether it was capped.
    replayable,
    rules: state.rules,
    turnTimeout: room.turnTimeout ?? null,
    responseTimeout: room.responseTimeout ?? null,
    winner: state.winner,
    endReason: state.endReason,
    stalemateBasis: state._stalemateBasis || null,
    turns: state.turnCounter,
    deckCycles: state.shuffleCount || 0,
    seats: asArray(room.players).map((p, i) => ({
      seat: i, id: p?.id ?? null, name: p?.name ?? null,
      isBot: !!p?.isBot, botMode: p?.botMode || null, everHuman: everHuman(p),
    })),
    humanSeats,
    stats: state.stats ?? null,
    // The event stream is 85% of a record (41,738 B of a measured 49,160 B). A game with
    // no human seat at all is only ever produced by the harness, and a SEEDED one replays
    // exactly from seed + ruleset + seat order, so its events are pure duplication.
    // `eventsTotal` always survives so the omission is visible and countable, and an
    // unseeded bot game KEEPS its events — nothing else could reconstruct it.
    eventsTotal: state.eventSeq || 0,
    events: omitEvents ? undefined : asArray(state.events),
    eventsOmitted: omitEvents ? 'bot_only' : undefined,
    boards: asArray(state.players).map(board),
    // A corrupt state is the most interesting kind to record, so say so in the record
    // rather than losing it: a null players array becomes an explicit marker.
    boardsMissing: Array.isArray(state.players) ? undefined : true,
    log: asArray(state.log),
    integrity: safeValidate(state, G),
  };
}

// Records a finished game exactly once. Safe to call on every broadcast.
function recordFinished(room, G) {
  if (!enabled() || fsDisabled) return false;
  if (!room || !room.state || room.state.phase !== 'finished') return false;
  if (room.state._logged) return false;
  room.state._logged = true;

  // Phase 1 — build and serialize. A failure here is about THIS game only, so it skips
  // itself and logging stays on for every other room on the instance.
  let line;
  try {
    line = JSON.stringify(buildRecord(room, G)) + '\n';
  } catch (error) {
    skipped++;
    console.warn(`[GAMELOG] skipped ${room?.code ?? '?'}: ${error?.message || error}`
      + ' (logging continues)');
    return false;
  }

  // Phase 2 — write. A failure here is the filesystem, which retrying cannot fix.
  try {
    ensureReady();
  } catch (error) {
    fsDisabled = true;
    warnOnce(error);
    return false;
  }
  // Appends stay async (the event loop is never blocked), but the rotate() inside
  // must never renameSync the live file while an append to it is still in flight.
  // fs.appendFile is fire-and-forget and renameSync runs on the main thread, so
  // under fast rotation (a tiny byte cap, or a 32MB flood) the two raced: Node's
  // threadpool lost the records whose write handle the rename moved out from under
  // (measured Node 20: 1–3 of 60 lost with no pacing — test/engine-hardening.js
  // 'back-to-back rotations'; Node 24's threadpool timing hid it). Chaining each
  // write behind the previous one means rotate() only runs BETWEEN two settled
  // appends — nothing is ever in flight across a rename, and the byte counter is
  // read and advanced only inside the chain, so it can't drift either.
  const bump = Buffer.byteLength(line);
  writeChain = writeChain.then(async () => {
    if (MAX_BYTES > 0 && bytes >= MAX_BYTES) rotate();
    bytes += bump;
    await fs.promises.appendFile(FILE, line);
  }).catch((err) => { fsDisabled = true; warnOnce(err); });

  written++;
  console.log(`[GAME] ${room.code} recorded (${room.state.endReason}, ${room.state.turnCounter} turns)`);
  return true;
}

module.exports = { recordFinished, enabled, stats, FILE, DIR, buildRecord };
