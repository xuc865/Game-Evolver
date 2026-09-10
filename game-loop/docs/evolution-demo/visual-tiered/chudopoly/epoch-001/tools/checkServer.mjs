#!/usr/bin/env node
/**
 * tools/checkServer.mjs — frame-level WebSocket abuse, and socket liveness.
 * NEW in P7 round 1 (§8 addition; harness-agent-owned per §1).
 *
 * WHY THIS EXISTS
 * The robustness critic took the whole server down from an UNAUTHENTICATED
 * socket with a single frame — four separate ways. None of them needs a valid
 * message, a room, or a name; the Origin check is no mitigation because a
 * non-browser client sets Origin freely. `ws` emits those failures as an
 * 'error' event on the socket, and a socket with no 'error' listener re-throws
 * as an uncaught exception, which ends the process and every game on it.
 *
 * Every other gate in tools/ speaks the protocol correctly and therefore could
 * not see any of this. This one speaks it INCORRECTLY, on purpose, over a raw
 * TCP socket — the `ws` client library refuses to send most of these.
 *
 * Asserted, per vector: the client socket is closed AND
 *   • /health still answers ok
 *   • a normal client can still connect, create a room and get a state
 * That second assertion is the real one: "the process survived" is cheap, "the
 * process survived and is still a working game server" is the invariant.
 *
 * Plus §P7.21 socket liveness: a client whose network dies without a FIN keeps
 * `readyState === 1` until TCP keepalive gives up (~2h), so the seat is never
 * released, bots never take over, and reconnect is refused forever. The server
 * answers that with a ping/pong heartbeat; this proves the heartbeat is still
 * wired, by handshaking a raw socket that can never pong and requiring the
 * server to reap it.
 *
 * Node-only — no browser, no bridge, so it never SKIPs.
 */
import net from 'node:net';
import crypto from 'node:crypto';
import {
  parseArgs, reporter, green, red, dim, bold, EXIT_PASS, EXIT_FAIL,
} from './lib/harness.mjs';
import { startServer } from './serve.mjs';
import { ChudClient } from './lib/wsclient.mjs';

const args = parseArgs();
/** The heartbeat interval the server under test runs at. Squeezed from 15s to
 *  250ms so a reap that really happens is observable inside a gate's budget;
 *  server.js reads CHUD_PING_MS and floors it at 50ms. */
const PING_MS = Number(args.pingMs || 250);

const r = reporter('checkServer' + dim('  frame-level abuse + socket liveness'));

/* ── raw framing (the `ws` client will not send most of these) ──────────── */

/**
 * @param {number} opcode
 * @param {Buffer} payload
 * @param {{rsv1?:boolean, mask?:boolean, fin?:boolean, lenOverride?:number}} o
 */
function frame(opcode, payload, o = {}) {
  const fin = o.fin === false ? 0 : 0x80;
  const rsv1 = o.rsv1 ? 0x40 : 0;
  const mask = o.mask === false ? 0 : 0x80;
  const len = o.lenOverride ?? payload.length;
  const head = [fin | rsv1 | opcode];
  if (len < 126) head.push(mask | len);
  else if (len < 65536) head.push(mask | 126, (len >> 8) & 0xff, len & 0xff);
  else {
    head.push(mask | 127, 0, 0, 0, 0, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  }
  const parts = [Buffer.from(head)];
  if (mask) {
    const key = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= key[i % 4];
    parts.push(key, masked);
  } else {
    parts.push(Buffer.from(payload));
  }
  return Buffer.concat(parts);
}

/** Handshake a raw TCP socket into a WebSocket. Resolves once 101 is seen. */
function rawSocket(port, { path = '/' } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const key = crypto.randomBytes(16).toString('base64');
    const events = { closed: false, closedAt: 0, bytes: [] };
    sock.on('error', () => { events.closed = true; events.closedAt = Date.now(); });
    sock.on('close', () => { if (!events.closed) { events.closed = true; events.closedAt = Date.now(); } });
    sock.on('data', (d) => {
      if (upgraded) { events.bytes.push(d); return; }
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const head = buf.slice(0, i).toString('latin1');
      upgraded = true;
      if (!/^HTTP\/1\.1 101/.test(head)) { reject(new Error(`handshake refused: ${head.split('\r\n')[0]}`)); sock.destroy(); return; }
      resolve({ sock, events });
    });
    sock.on('connect', () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${port}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${key}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n'
        + `Origin: http://127.0.0.1:${port}\r\n\r\n`
      );
    });
    setTimeout(() => reject(new Error('handshake timed out')), 8000).unref?.();
  });
}

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

const server = await startServer({ seed: 1, env: { CHUD_PING_MS: String(PING_MS) } });
let code = EXIT_PASS;

/**
 * The last line of defence, not the fix.
 *
 * MEASURED while writing this tool: with the per-socket `error` listener
 * removed (mutation test, see the report), all four original vectors still left
 * /health answering — because server.js also installs a process-level
 * `uncaughtException` handler that logs `[FATAL] … server continues`. So
 * "the process survived" is NOT sufficient evidence that the socket-level
 * handling is present: 4/4 vectors passed a liveness-only check while every
 * one of them escaped to the process handler.
 *
 * A frame from an anonymous socket must be handled where it happens. Any
 * `[FATAL] uncaught exception` in the log during a vector is therefore a
 * failure of this gate even though the server is still up.
 */
function fatalsInLog() {
  return (server.logs().match(/uncaught exception|unhandled rejection/gi) || []).length;
}
let fatalsSeen = 0;

/** The invariant, checked after every vector: still a working game server. */
async function stillServing(label) {
  let ok = false;
  try {
    const res = await fetch(`${server.url}/health`, { signal: AbortSignal.timeout(2500) });
    ok = res.ok && (await res.json())?.ok === true;
  } catch { ok = false; }
  if (!ok) {
    r.fail(`${label}: /health stopped answering — the process is down`);
    return false;
  }
  // Two attempts. One refused round trip is a race with our own previous
  // socket teardown; two in a row is the server. A gate that flakes gets
  // ignored, which is worse than a gate that does not exist.
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const client = new ChudClient(server.wsUrl, { name: 'SURVIVOR' });
    try {
      await client.connect();
      await client.send({ type: 'create_room', name: 'SURVIVOR' });
      await client.waitFor((m) => m.type === 'joined', 6000, 'joined');
      await client.waitFor((m) => m.type === 'state', 6000, 'state');
      r.pass(`${label}: server survived and still serves a new room`);
      return true;
    } catch (e) {
      last = e.message;
    } finally {
      try { client.close(); } catch { /* already gone */ }
    }
    await wait(300);
  }
  r.fail(`${label}: server is up but no longer usable — ${last}`);
  return false;
}

/**
 * Each vector is a single frame from an UNAUTHENTICATED socket. The expectation
 * is never "the server accepts it" — it is "the server refuses it without
 * dying". A protocol error SHOULD close the socket; only the process matters.
 */
const VECTORS = [
  {
    name: 'oversized frame (64KB against a 16KB maxPayload)',
    build: () => frame(0x1, Buffer.alloc(64 * 1024, 0x41)),
  },
  {
    name: 'invalid UTF-8 in a text frame',
    build: () => frame(0x1, Buffer.from([0xff, 0xfe, 0xfd, 0x80, 0x81])),
  },
  {
    name: 'RSV1 set with no extension negotiated',
    build: () => frame(0x1, Buffer.from('{"type":"ping"}'), { rsv1: true }),
  },
  {
    name: 'reserved opcode 0x3',
    build: () => frame(0x3, Buffer.from('x')),
  },
  {
    name: 'unmasked client frame (RFC 6455 §5.1 violation)',
    build: () => frame(0x1, Buffer.from('{"type":"ping"}'), { mask: false }),
  },
  {
    name: 'length header lies (declares 4KB, sends 8 bytes)',
    build: () => frame(0x1, Buffer.from('12345678'), { lenOverride: 4096 }),
  },
  {
    name: 'fragmented continuation with no start frame',
    build: () => frame(0x0, Buffer.from('orphan')),
  },
];

try {
  if (!(await stillServing('baseline'))) throw new Error('server was not healthy before the first vector');

  for (const v of VECTORS) {
    let handshook = false;
    try {
      const { sock } = await rawSocket(server.port);
      handshook = true;
      sock.write(v.build());
      await wait(400);
      sock.destroy();
    } catch (e) {
      // A refused handshake is not a pass for this vector — it means we never
      // got to send the frame, so the vector is UNTESTED and must say so.
      r.fail(`${v.name}: could not reach the frame layer (${e.message})`);
      continue;
    }
    if (!handshook) continue;
    const fatals = fatalsInLog();
    if (fatals > fatalsSeen) {
      r.fail(`${v.name}: escaped to the process-level uncaughtException handler `
        + '— the socket has no error listener, the process only survived by accident');
      fatalsSeen = fatals;
    }
    const ok = await stillServing(v.name);
    if (!ok) break;     // the process is gone; every later vector is noise
  }

  /* ── §P7.21 liveness: a socket that cannot pong must be reaped ────────── */
  const { sock, events } = await rawSocket(server.port);
  // A raw socket answers no ping — exactly a client whose network vanished
  // without a FIN. If the heartbeat is wired, the server terminates it in at
  // most two intervals.
  const budget = PING_MS * 4 + 1500;
  const t0 = Date.now();
  const reaped = await new Promise((resolve) => {
    const done = () => resolve(true);
    sock.once('close', done);
    sock.once('end', done);
    setTimeout(() => resolve(events.closed), budget).unref?.();
  });
  const took = Date.now() - t0;
  sock.destroy();
  if (reaped) r.pass(`a dead (never-ponging) socket was reaped in ${took}ms ${dim(`(ping ${PING_MS}ms)`)}`);
  else {
    r.fail(`a socket that never pongs was still open after ${budget}ms — no ping/pong heartbeat, `
      + 'so a player whose network dies holds their seat until TCP keepalive gives up (~2h) '
      + 'and reconnect is refused forever (§P7.21)');
  }

  await stillServing('after liveness reap');
  code = r.code;
} catch (e) {
  console.log(red(`  ✗ ${e.stack || e.message}`));
  console.log(dim(server.logs().split('\n').slice(-12).join('\n')));
  code = EXIT_FAIL;
} finally {
  await server.stop();
}

console.log(code === EXIT_PASS ? green(bold('checkServer: PASS')) : red(bold('checkServer: FAIL')));
process.exit(code);
