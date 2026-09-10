// test/xff.test.js — X-Forwarded-For trust for the per-IP caps.
//
// Recorded defect: clientIp() keyed the per-IP socket cap and the
// /api/public-rooms rate limiter on the LEFTMOST XFF entry, which is
// client-controlled — Railway's edge APPENDS the real client IP to whatever
// XFF the client sent. Spoof proof from the audit: 8/8 sockets with distinct
// spoofed leftmost XFF from one IP admitted past a 4-socket cap.
//
// The fix: CHUD_TRUST_PROXY_HOPS (default 1, Railway single-hop) counts
// trusted hops from the RIGHT of the chain; a shorter chain falls back to the
// socket's remoteAddress; 0 ignores XFF entirely.
//
// Same harness shape as test/server-hardening.test.js: real spawned
// server.js processes (one per suite, each on its own free port — never a
// fixed port, never localhost:3000), real WebSocket clients, real HTTP GETs.
// Only processes this file spawns are ever signalled, by captured handle.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CAP = 4; // CHUD_MAX_SOCKETS_PER_IP for every suite: small enough to cross quickly

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      CHUD_PING_MS: '250',
      CHUD_MAX_SOCKETS_PER_IP: String(CAP),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', d => { output += String(d); });
  proc.stderr.on('data', d => { output += String(d); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server start timeout\n${output}`)), 8000);
    const onData = () => {
      if (output.includes('Server running')) { clearTimeout(timeout); resolve(); }
    };
    proc.stdout.on('data', onData);
    proc.once('exit', code => reject(new Error(`server exited early (${code})\n${output}`)));
  });
  return {
    proc,
    getOutput: () => output,
    wsUrl: `ws://127.0.0.1:${port}`,
    httpUrl: `http://127.0.0.1:${port}`,
  };
}

function stopServer(proc) {
  return new Promise(resolve => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 3000);
  });
}

// Resolves 'refused' when the server closes the socket (cap enforcement uses
// close code 1013), 'admitted' when it is still open after a grace window.
function openSocket(wsUrl, xff) {
  return new Promise((resolve, reject) => {
    const headers = xff ? { 'x-forwarded-for': xff } : {};
    const ws = new WebSocket(wsUrl, { headers });
    ws.on('error', () => {});
    ws.once('open', () => {
      let settled = false;
      ws.once('close', code => { if (!settled) { settled = true; resolve({ ws, status: code === 1013 ? 'refused' : `closed(${code})` }); } });
      setTimeout(() => { if (!settled) { settled = true; resolve({ ws, status: 'admitted' }); } }, 600);
    });
    ws.once('error', reject);
  });
}

// Opens count sockets and returns their {ws, status} results.
async function openSockets(wsUrl, count, xffFor) {
  const results = [];
  for (let i = 0; i < count; i++) {
    results.push(await openSocket(wsUrl, xffFor(i)));
  }
  return results;
}

function statuses(results) {
  return results.map(r => r.status);
}

async function publicRooms(httpUrl, xff) {
  const headers = xff ? { 'x-forwarded-for': xff } : {};
  const res = await fetch(`${httpUrl}/api/public-rooms`, { headers });
  return res.status;
}

/* ── hops=1 (the Railway default): the spoof is dead, the cap is alive ────── */

test('hops=1: spoofed leftmost XFF no longer bypasses the per-IP socket cap', async () => {
  const srv = await startServer({ CHUD_TRUST_PROXY_HOPS: '1' });
  const sockets = [];
  try {
    // Distinct attacker-controlled leftmost entries, ONE platform-appended
    // rightmost entry — exactly what Railway delivers for one real client.
    // Pre-fix this admitted 8/8 past the cap of 4.
    const results = await openSockets(srv.wsUrl, 8, i => `198.51.100.${i + 1}, 203.0.113.7`);
    sockets.push(...results.map(r => r.ws));
    assert.deepEqual(statuses(results), [
      'admitted', 'admitted', 'admitted', 'admitted',
      'refused', 'refused', 'refused', 'refused',
    ]);
  } finally {
    for (const ws of sockets) { try { ws.terminate(); } catch {} }
    await stopServer(srv.proc);
  }
});

test('hops=1: the /api/public-rooms limiter also keys on the rightmost hop', async () => {
  const srv = await startServer({ CHUD_TRUST_PROXY_HOPS: '1' });
  try {
    // LIST_MAX_PER_WINDOW is 20 per 5s. Every request spoofs a fresh leftmost
    // entry behind the same real client IP; pre-fix each landed in its own
    // bucket and none was ever limited.
    const codes = [];
    for (let i = 0; i < 21; i++) {
      codes.push(await publicRooms(srv.httpUrl, `198.51.100.${i + 1}, 203.0.113.9`));
    }
    assert.deepEqual(codes.slice(0, 20), Array(20).fill(200));
    assert.equal(codes[20], 429);
  } finally {
    await stopServer(srv.proc);
  }
});

test('hops=1: distinct real client IPs are NOT capped together (the cap is not a global one)', async () => {
  const srv = await startServer({ CHUD_TRUST_PROXY_HOPS: '1' });
  const sockets = [];
  try {
    // Each socket presents a distinct rightmost (edge-appended) IP: eight
    // different real clients behind the proxy. All must be admitted — fixing
    // the spoof by collapsing everyone into one bucket would fail here.
    const results = await openSockets(srv.wsUrl, 8, i => `198.51.100.9, 203.0.113.${i + 1}`);
    sockets.push(...results.map(r => r.ws));
    assert.deepEqual(statuses(results), Array(8).fill('admitted'));

    // Same for the HTTP limiter: 21 requests from 21 distinct real IPs.
    for (let i = 0; i < 21; i++) {
      assert.equal(await publicRooms(srv.httpUrl, `198.51.100.9, 203.0.113.${i + 1}`), 200);
    }
  } finally {
    for (const ws of sockets) { try { ws.terminate(); } catch {} }
    await stopServer(srv.proc);
  }
});

test('hops=1: same-IP cap still actually blocks (regression: the cap itself is intact)', async () => {
  const srv = await startServer({ CHUD_TRUST_PROXY_HOPS: '1' });
  const sockets = [];
  try {
    // No XFF at all: every socket keys on the shared 127.0.0.1 remoteAddress,
    // so the 5th must be refused. If the fix had neutered the cap instead of
    // re-keying it, this would admit all five.
    const results = await openSockets(srv.wsUrl, CAP + 1, () => null);
    sockets.push(...results.map(r => r.ws));
    assert.deepEqual(statuses(results), [...Array(CAP).fill('admitted'), 'refused']);
  } finally {
    for (const ws of sockets) { try { ws.terminate(); } catch {} }
    await stopServer(srv.proc);
  }
});

/* ── hops=0: XFF is ignored entirely ─────────────────────────────────────── */

test('hops=0: XFF is ignored and the cap keys on remoteAddress', async () => {
  const srv = await startServer({ CHUD_TRUST_PROXY_HOPS: '0' });
  const sockets = [];
  try {
    // Every chain entry is distinct; with XFF ignored they all share
    // 127.0.0.1 and the 5th socket must be refused.
    const results = await openSockets(srv.wsUrl, CAP + 1, i => `203.0.113.${i + 1}`);
    sockets.push(...results.map(r => r.ws));
    assert.deepEqual(statuses(results), [...Array(CAP).fill('admitted'), 'refused']);
  } finally {
    for (const ws of sockets) { try { ws.terminate(); } catch {} }
    await stopServer(srv.proc);
  }
});

/* ── chain shorter than the trust count: fall back to remoteAddress ──────── */

test('hops=3: a chain shorter than N falls back to remoteAddress', async () => {
  const srv = await startServer({ CHUD_TRUST_PROXY_HOPS: '3' });
  const sockets = [];
  try {
    // Two-entry chains under a 3-hop trust count: the server trusts more
    // proxies than touched this request, so it must not pick ANY chain entry
    // (all are client-writable here) — it falls back to 127.0.0.1 and the
    // 5th socket is refused. Pre-fix the distinct leftmost entries each got
    // their own bucket and all five were admitted.
    const results = await openSockets(srv.wsUrl, CAP + 1, i => `198.51.100.${i + 1}, 203.0.113.5`);
    sockets.push(...results.map(r => r.ws));
    assert.deepEqual(statuses(results), [...Array(CAP).fill('admitted'), 'refused']);
  } finally {
    for (const ws of sockets) { try { ws.terminate(); } catch {} }
    await stopServer(srv.proc);
  }
});

/* ── env validation: junk means the safe default, loudly ─────────────────── */

test('a non-integer CHUD_TRUST_PROXY_HOPS warns at boot and behaves as the default 1', async () => {
  const srv = await startServer({ CHUD_TRUST_PROXY_HOPS: 'bogus' });
  const sockets = [];
  try {
    assert.match(srv.getOutput(), /CHUD_TRUST_PROXY_HOPS=.*falling back to 1/);
    const results = await openSockets(srv.wsUrl, CAP + 1, i => `198.51.100.${i + 1}, 203.0.113.7`);
    sockets.push(...results.map(r => r.ws));
    assert.deepEqual(statuses(results), [...Array(CAP).fill('admitted'), 'refused']);
  } finally {
    for (const ws of sockets) { try { ws.terminate(); } catch {} }
    await stopServer(srv.proc);
  }
});
