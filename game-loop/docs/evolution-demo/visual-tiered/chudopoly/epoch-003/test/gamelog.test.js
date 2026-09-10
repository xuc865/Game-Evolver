// test/gamelog.test.js — the game log's directory contract (DESIGN.md §3.1/§3.4).
//
// Railway mounts volumes at RUNTIME only (verified: docs.railway.com/volumes —
// never at build or pre-deploy), so `CHUD_GAME_LOG_DIR` is the entire "records
// survive a redeploy" story. Two failure shapes were PROBED, not assumed,
// before this file existed (2026-08-07, node child with the env set):
//
//   * dir cannot be created (volume not mounted, no permission at /):
//     `ensureReady()` threw inside recordFinished, the module HARD-DISABLED
//     after one warning, and every subsequent game was silently unrecorded.
//     Not the §3.4 "silently ephemeral" — total loss, quieter.
//   * dir creatable but wrong (typo, unmounted path that happens to be
//     writable): records flow into ephemeral storage, silently, looking
//     exactly like working. The §3.4 case as written.
//
// The contract pinned here: a configured dir that fails a boot write-probe
// falls back to the repo's ./logs with a LOUD warning, and logging continues.
// Each test runs gamelog in a child process because DIR is resolved from the
// environment at module load — which is the correct time, since server start
// is the only moment a Railway volume is guaranteed mounted.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REPO_LOGS = path.join(ROOT, 'logs');

/** Run a snippet in a child node with CHUD_GAME_LOG_DIR set. */
function inChild(dir, script) {
  const res = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    env: { ...process.env, CHUD_GAME_LOG_DIR: dir, CHUD_GAME_LOG: '1' },
    encoding: 'utf8',
    timeout: 15000,
  });
  return { out: res.stdout || '', err: res.stderr || '', status: res.status };
}

const fakeRoom = `
  const room = {
    code: 'TSTG',
    players: [
      { id: 'a', name: 'A', isBot: false },
      { id: 'b', name: 'B', isBot: true, botMode: 'random' },
    ],
    state: { phase: 'finished', winner: 'a', endReason: 'sets', turnCounter: 9,
      seed: 'x', rules: {}, events: [{ seq: 1, t: 'win', actor: 'a' }], eventSeq: 1,
      log: [], players: [], stats: null },
  };
`;

test('an unwritable CHUD_GAME_LOG_DIR falls back to ./logs, loudly, with logging still on', () => {
  // A path that cannot be created: nested under a FILE, so mkdirSync -p fails
  // on every platform without needing root.
  const block = path.join(os.tmpdir(), `chud-gamelog-block-${process.pid}`);
  fs.writeFileSync(block, 'not a directory');
  try {
    const { out, err } = inChild(path.join(block, 'vol'), `
      const gl = require('./server/gamelog.js');
      console.log(JSON.stringify({ dir: gl.DIR, disabled: gl.stats().disabled }));
    `);
    const line = out.trim().split('\n').pop();
    const got = JSON.parse(line);
    assert.equal(path.resolve(got.dir), path.resolve(REPO_LOGS),
      `gamelog did not fall back to the repo logs dir (got ${got.dir})`);
    assert.equal(got.disabled, false,
      'a bad env var must not hard-disable logging — that is the probed pre-fix behaviour');
    assert.match(err + out, /not writable/i,
      'the fallback must announce itself at startup — silent is the failure mode');
    assert.match(err + out, /EPHEMERAL/,
      'the warning must say what the fallback costs on Railway');
  } finally {
    fs.rmSync(block, { force: true });
  }
});

test('a writable CHUD_GAME_LOG_DIR is honoured: the record lands in the volume', () => {
  const vol = fs.mkdtempSync(path.join(os.tmpdir(), 'chud-gamelog-vol-'));
  try {
    const { out, err } = inChild(vol, `
      ${fakeRoom}
      const gl = require('./server/gamelog.js');
      const ok = gl.recordFinished(room, null);
      setTimeout(() => {
        const fs = require('fs');
        console.log(JSON.stringify({ dir: gl.DIR, ok, exists: fs.existsSync(gl.FILE) }));
      }, 250);
    `);
    const got = JSON.parse(out.trim().split('\n').pop());
    assert.equal(path.resolve(got.dir), path.resolve(vol));
    assert.equal(got.ok, true, `recordFinished failed: ${err}`);
    assert.equal(got.exists, true, 'no JSONL landed in the configured dir');
    assert.doesNotMatch(err + got.dir, /EPHEMERAL/, 'a working volume must not warn');
    const line = fs.readFileSync(path.join(vol, 'games.jsonl'), 'utf8').trim();
    const rec = JSON.parse(line);
    assert.equal(rec.code, 'TSTG');
    assert.equal(rec.seats.find((s) => s.isBot).botMode, 'random');
  } finally {
    fs.rmSync(vol, { recursive: true, force: true });
  }
});

test('.env.example documents the volume mount and the retention ring', () => {
  const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(env, /CHUD_GAME_LOG_DIR/,
    'the volume mount env var is undocumented — the next deploy loses records');
  assert.match(env, /CHUD_GAME_LOG_ARCHIVES/,
    'the retention ring env var is undocumented — the 5-archive default retains '
    + '~3,200 real games (192MB raw at the measured 61.5KB/record), weeks not history');
});
