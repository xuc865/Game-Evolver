// server.js — Chudopoly entry point

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');            // hardLog() + the __ORIGIN__ page substitution

const pkg = require('./package.json');
const G = require('./game');
const Bot = require('./bot');
const broadcast = require('./server/broadcast');
const timers = require('./server/timers');
const absent = require('./server/absent');
const handlers = require('./server/handlers');
const protocol = require('./server/protocol');
const icon = require('./server/icon');
const og = require('./server/og');
const pages = require('./server/pages');

/* ── App setup ─────────────────────────────────────────────────────── */

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const configuredOrigins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean));
const wss = new WebSocketServer({
  server,
  maxPayload: 16 * 1024,
  perMessageDeflate: false,
  verifyClient: ({ origin, req }) => {
    if (!origin) return process.env.NODE_ENV !== 'production';
    if (configuredOrigins.has(origin)) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  },
});

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self' ws: wss: https://api.giphy.com",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
/* ── App icon ──────────────────────────────────────────────────────────
   Served, not stored. §0.3 bans .svg and .png files in the repo, so the tab
   favicon and every install raster are generated from one shape list in
   server/icon.js — SVG as text, PNG through node:zlib. Registered ABOVE the
   static mount so these paths never touch the filesystem. Cache-Control
   matches the rest of the tree (revalidate; the ?v= in index.html is what
   actually busts), and express adds the ETag off the buffer. */
app.get('/icon.svg', (req, res) => {
  res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(icon.tabSVG());
});
app.get('/icon-:key.png', (req, res, next) => {
  const png = icon.pngFor(req.params.key);
  if (!png) return next();
  res.type('image/png').set('Cache-Control', 'no-cache').send(png);
});

/* ── Link preview ──────────────────────────────────────────────────────
   Same story as the icons: the og:image is generated from geometry the client
   already ships (server/og.js) and served from a route, so §0.3 stays intact.
   Crawlers cache an og:image for days, so this one may be cached too — the
   ?v= on the meta tag is what busts it when the drawing changes. */
app.get('/og.png', async (req, res, next) => {
  try {
    const png = await og.png('og');
    if (!png) return next();
    res.type('image/png').set('Cache-Control', 'public, max-age=86400').send(png);
  } catch (err) { next(err); }
});

/* ── The crawlable documents ───────────────────────────────────────────
   The app is one screen of JavaScript, and a crawler does not run it — so the
   rules live at real URLs, rendered server-side from the same engine the game
   runs on (server/pages.js). Registered ABOVE the static mount for the same
   reason the icons are: these paths must never fall through to a file.
   Cache-Control mirrors the shell — these are generated per request and the
   numbers in them change when the engine does. */
app.get('/rules', (req, res) => {
  res.type('html').set('Cache-Control', 'no-cache')
    .send(pages.rulesPage(og.originOf(req, `localhost:${PORT}`)));
});
app.get('/monopoly-deal-rules', (req, res) => {
  res.type('html').set('Cache-Control', 'no-cache')
    .send(pages.mdRulesPage(og.originOf(req, `localhost:${PORT}`)));
});
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600')
    .send(pages.sitemap(og.originOf(req, `localhost:${PORT}`)));
});
/* Served from the origin so the Sitemap: line carries an absolute URL that
   resolves to whatever host is answering. Cloudflare appends its own
   content-signal block to this rather than replacing it. */
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').set('Cache-Control', 'public, max-age=3600')
    .send(pages.robots(og.originOf(req, `localhost:${PORT}`)));
});

/* The page itself is served with __ORIGIN__ substituted, because og:image and
   og:url must be ABSOLUTE (a relative og:image does not unfurl) and the same
   static file ships to localhost, deal.8tp.dev and whatever domain comes next.
   Crawlers do not execute JS, so the substitution has to happen server-side.
   Registered above the static mount; read from disk per request (the file is
   no-store anyway, and this keeps live-editing the shell working in dev). */
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
app.get(['/', '/index.html'], (req, res, next) => {
  fs.readFile(INDEX_PATH, 'utf8', (err, html) => {
    if (err) return next(err);
    res.type('html').set('Cache-Control', 'no-store')
      .send(og.withOrigin(html, og.originOf(req, `localhost:${PORT}`)));
  });
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // HTML must always revalidate so its cache-busted asset URLs stay in sync.
    res.setHeader('Cache-Control', filePath.endsWith('index.html') ? 'no-store' : 'no-cache');
  },
}));

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const globalChat = [];
const CHAT_MAX = 50;
const chatIdRef = { value: 0 };

/* ── Utilities ─────────────────────────────────────────────────────── */

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function genId() { return crypto.randomUUID(); }
function genResumeToken() { return crypto.randomBytes(32).toString('base64url'); }

/* ── Initialize modules ────────────────────────────────────────────── */

broadcast.init({ G, Bot });
timers.init({ G, Bot, broadcast });
absent.init({ G, broadcast });
handlers.init({ G, Bot, broadcast, timers, absent, rooms, globalChat, CHAT_MAX, chatIdRef, genCode, genId, genResumeToken, wss });

/* ── API routes ────────────────────────────────────────────────────── */

app.get('/api/config', (req, res) => {
  res.json({ giphyKey: process.env.GIPHY_KEY || '' });
});

/* ── Public rooms (owner directive 2026-08-07) ─────────────────────────
   The home screen's browse list. Opt-in only: a room appears here iff its
   host created it with `public: true` (strictly validated in
   server/protocol.js), it is still in the lobby, and a seat is open. Five
   fields per room and NOTHING else — no player ids, no tokens, no chat —
   pinned by test/public-rooms.test.js, which also proves a private room's
   code is absent. Rate-limited per IP with the same window arithmetic the
   WS frame limit uses, so polling clients are fine and a scraper is not:
   the codes listed are public by the host's choice, but the endpoint must
   not become a cheap liveness oracle hammered per-millisecond. */
const LIST_WINDOW_MS = 5000;
const LIST_MAX_PER_WINDOW = 20;
const listHits = new Map();          // ip -> { at, n }
app.get('/api/public-rooms', (req, res) => {
  const ip = clientIp(req);
  const now = Date.now();
  let hit = listHits.get(ip);
  if (!hit || now - hit.at >= LIST_WINDOW_MS) { hit = { at: now, n: 0 }; listHits.set(ip, hit); }
  if (++hit.n > LIST_MAX_PER_WINDOW) { res.status(429).json({ error: 'Slow down' }); return; }
  if (listHits.size > 10000) listHits.clear();   // bounded, cheap amnesty
  const out = [];
  for (const room of rooms.values()) {
    if (room.public !== true || room.phase !== 'lobby') continue;   // lobby only, never a live game
    if (room.players.length >= 5) continue;                         // full is not joinable
    // A lobby whose humans have all dropped is a dead end for a joiner — the
    // reaper will collect it, but it must not be advertised in the meantime.
    if (!room.players.some(p => !p.isBot && p.ws?.readyState === 1)) continue;
    const host = room.players.find(p => p.id === room.hostId);
    out.push({
      code: room.code,
      host: host?.name || 'Host',
      seats: room.players.length,
      capacity: 5,                              // handlers.js's own cap, restated
      preset: (room.pendingRules && room.pendingRules.preset) || 'custom',
    });
    if (out.length >= 50) break;                // a page, not a firehose
  }
  res.set('Cache-Control', 'no-store').json({ rooms: out });
});
const STARTED_AT = Date.now();
app.get('/health', (req, res) => res.json({
  ok: true,
  rooms: rooms.size,
  version: pkg.version,
  // A deploy could not tell which build was live from {ok, rooms} alone.
  commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || null,
  node: process.version,
  uptime: Math.round(process.uptime()),
  startedAt: STARTED_AT,
  sockets: wss.clients.size,
}));

/* ── WebSocket ─────────────────────────────────────────────────────── */

/* Liveness. Without this a half-open socket (phone loses signal, no FIN) keeps
   readyState === 1 until the OS TCP keepalive gives up (~2h on Linux): no close event, so
   no bot takeover, absent.js never engages, and reconnect is refused forever with
   "That player is already connected". Measured: 3/3 reconnect attempts refused.
   PING_INTERVAL 15s → a dead socket is reaped within 30s. */
const PING_INTERVAL = Math.max(50, Number(process.env.CHUD_PING_MS) || 15000);
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { try { ws.terminate(); } catch {} }
  }
}, PING_INTERVAL);
heartbeat.unref?.();
wss.on('close', () => clearInterval(heartbeat));

// A WebSocket with no 'error' listener re-throws as an uncaught exception and takes the
// whole process down. Four unauthenticated single-frame vectors did exactly that
// (>16KB payload, invalid UTF-8, RSV1 set, opcode 0x3) — the Origin check is no
// mitigation because a non-browser client sets Origin freely.
wss.on('error', (err) => console.error('[WSS] server error:', err?.message || err));

/* Connection caps. There were none: 400 sockets from one client opened in 0.1s
   (sockets:401), and every one of them is an independent budget for the frame rate limit,
   an independent chat_history amplifier, and a fan-out target for global chat. The per-IP
   cap is the one that matters — the global cap is a backstop for a distributed flood so the
   process runs out of sockets on its own terms rather than the OS's. */
const MAX_SOCKETS_PER_IP = Math.max(1, Number(process.env.CHUD_MAX_SOCKETS_PER_IP) || 100);
const MAX_SOCKETS_TOTAL = Math.max(1, Number(process.env.CHUD_MAX_SOCKETS) || 2000);
const socketsByIp = new Map();

/* X-Forwarded-For trust. The old clientIp() took the LEFTMOST XFF entry — client-controlled,
   because Railway's edge APPENDS the real client IP to whatever XFF the client sent. Measured
   bypass: 8/8 sockets with distinct spoofed leftmost XFF from one IP admitted past a 4-socket
   cap. The fix counts trusted hops from the RIGHT of the chain. Default 1: the production
   deploy is Railway single-hop, so the rightmost entry is the edge-appended real client IP.
   0 ignores XFF entirely (direct exposure, no proxy). Invalid values warn and fall back to 1
   rather than killing boot — every other env knob here coerces to a safe default
   (CHUD_PING_MS, CHUD_MAX_SOCKETS_PER_IP), and 1 is the production value. */
function trustProxyHops() {
  const raw = process.env.CHUD_TRUST_PROXY_HOPS;
  if (raw === undefined || raw.trim() === '') return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.warn(`[CONFIG] CHUD_TRUST_PROXY_HOPS=${JSON.stringify(raw)} is not a non-negative integer — falling back to 1`);
    return 1;
  }
  return n;
}
const TRUST_PROXY_HOPS = trustProxyHops();

// Behind Railway/any reverse proxy every socket shares the proxy's remoteAddress, which
// would make a per-IP cap either useless or a global outage. The chain is read N trusted
// hops from the RIGHT: only the rightmost TRUST_PROXY_HOPS entries are infrastructure-
// written; everything left of them is attacker input. A chain shorter than the trust count
// means fewer proxies touched the request than we trust — fall back to the socket address.
// Both per-IP caps (the WS handshake below and /api/public-rooms above) key on this one
// helper, so the two paths cannot drift apart.
function clientIp(req) {
  const remote = req?.socket?.remoteAddress || 'unknown';
  if (TRUST_PROXY_HOPS === 0) return remote;
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    const chain = forwarded.split(',').map(x => x.trim()).filter(Boolean);
    if (chain.length >= TRUST_PROXY_HOPS) return chain[chain.length - TRUST_PROXY_HOPS];
  }
  return remote;
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const liveForIp = (socketsByIp.get(ip) || 0) + 1;
  socketsByIp.set(ip, liveForIp);
  // Registered BEFORE the cap check so a refused socket still gives its slot back.
  ws.on('close', () => {
    const remaining = (socketsByIp.get(ip) || 1) - 1;
    if (remaining > 0) socketsByIp.set(ip, remaining); else socketsByIp.delete(ip);
  });
  if (liveForIp > MAX_SOCKETS_PER_IP || wss.clients.size > MAX_SOCKETS_TOTAL) {
    console.warn(`[WS] connection refused (${ip}: ${liveForIp} sockets, ${wss.clients.size} total)`);
    ws.on('error', () => {});
    try { ws.close(1013, 'Too many connections'); } catch { try { ws.terminate(); } catch {} }
    return;
  }

  const state = { playerId: null, roomCode: null };
  let windowStartedAt = Date.now();
  let messageCount = 0;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', (err) => {
    console.warn('[WS] socket error:', err?.message || err);
    try { ws.terminate(); } catch {}
  });

  ws.on('message', (raw) => {
    const now = Date.now();
    if (now - windowStartedAt >= 5000) { windowStartedAt = now; messageCount = 0; }
    messageCount++;
    if (messageCount > 40) { ws.close(1008, 'Rate limit exceeded'); return; }
    let msg;
    try { msg = JSON.parse(raw); }
    catch { broadcast.send(ws, { type: 'error', message: 'Message must be valid JSON' }); return; }
    const validation = protocol.validateMessage(msg);
    if (!validation.ok) { broadcast.send(ws, { type: 'error', message: validation.error }); return; }
    try {
      handlers.handleMessage(ws, validation.value, state);
    } catch (error) {
      console.error('[WS] Message handling failed:', error);
      broadcast.send(ws, { type: 'error', message: 'Unable to process that request' });
    }
  });

  ws.on('close', () => {
    handlers.handleClose(state, ws);
  });
});

/* ── Death forensics ───────────────────────────────────────────────────
   The play server has been found dead with a log that simply STOPS: no stack, no last
   line, no explanation. Everything below exists so that never happens again.

   There are exactly two ways this process can end without a word, and both are covered.

   (1) The event loop DRAINS. No request path calls process.exit(), and every throw and
       rejection is trapped below and merely logged, so an exit means Node ran out of work.
       While the server is listening that cannot happen — the listening handle and the
       turn/bot timers hold the loop open (only the heartbeat and the room reaper are
       unref'd) — but the instant the listen handle goes away, nothing does. That is a real
       measured death, and it is handled at `server.on('error')` below.
   (2) A SIGNAL. A signal death runs no 'exit' handler at all, which is precisely why
       nothing was ever printed. Handled just below.

   Everything here writes with fs.writeSync rather than console.error. Node's stdio is
   synchronous for files, TTYs and (measured here, Node 24 on darwin: 20,001 lines survived
   an immediate SIGKILL) pipes — but that is a platform-and-version detail, not a promise,
   and the whole value of these lines is that they are the LAST thing the process ever
   says. A write that has to survive its own death should not depend on which of the three
   the operator happened to redirect to. */
function hardLog(line) {
  try { fs.writeSync(2, line.endsWith('\n') ? line : line + '\n'); }
  catch { try { console.error(line); } catch {} }
}
function vitals() {
  return `uptime ${Math.round(process.uptime())}s, ${rooms.size} rooms, ${wss.clients.size} sockets`;
}

/* Last-resort backstop: one bad frame, one bug in a timer callback, must never end the
   process for every other room on the instance. Anything that reaches here is a defect —
   it is logged loudly — but the server keeps serving. */
process.on('uncaughtException', (err, origin) => {
  hardLog(`[FATAL] uncaught exception (${origin}) — server continues (${vitals()}): ${err?.stack || err}`);
});
process.on('unhandledRejection', (reason) => {
  hardLog(`[FATAL] unhandled rejection — server continues (${vitals()}): ${reason?.stack || reason}`);
});

/* Signals that are NOT a shutdown request and must never end a game in progress.
   One observed death exited 144 — 128+16, which is SIGURG on macOS and SIGSTKFLT on
   Linux. Neither is something a supervisor sends to stop a server, and SIGURG in
   particular is spurious noise (out-of-band socket data, or a stray group signal from a
   Go-based parent process). Installing a listener is precisely what makes such a signal
   non-fatal: a signal with a JS handler no longer takes its default action, which on
   Linux for signal 16 is "terminate". Unknown names throw on registration and are
   skipped, so this list is portable. */
for (const name of ['SIGURG', 'SIGSTKFLT', 'SIGXCPU', 'SIGXFSZ', 'SIGPIPE']) {
  try {
    process.on(name, () => hardLog(`[SIGNAL] ${name} received and IGNORED — `
      + `not a shutdown request; the server keeps serving (${vitals()})`));
  } catch { /* not a signal this platform knows */ }
}

/* Signals that ARE a shutdown request are still obeyed — but they say so first, and they
   exit 128+n so a supervisor still reads the conventional code. */
for (const [name, number] of Object.entries({ SIGTERM: 15, SIGINT: 2, SIGHUP: 1 })) {
  process.on(name, () => {
    hardLog(`[SIGNAL] ${name} — shutting down (${vitals()})`);
    process.exit(128 + number);
  });
}

// Fires for every exit the process chooses. It cannot fire for a signal death, which is
// the whole point: an [EXIT] line means the process decided, its absence means something
// outside did.
process.on('exit', (code) => hardLog(`[EXIT] code=${code} (${vitals()})`));

/* ── Start ─────────────────────────────────────────────────────────── */

/* THE silent death. Measured, not theorised: start a second server.js on a port that is
   already taken and the pre-fix process printed one line — `[WSS] server error: listen
   EADDRINUSE` — and then EXITED 0. No [FATAL], no stack, no last line, and every client
   on ERR_CONNECTION_REFUSED. Exactly the signature that has been reported.

   Two things conspired. The `ws` server re-emits the HTTP server's error, so wss.on('error')
   above swallowed it and it never reached uncaughtException; and once the listen handle is
   gone nothing else holds the loop open — the heartbeat and the room reaper are both
   unref'd — so Node ran out of work and left quietly with a success code.

   A failed listen is named and fatal ON PURPOSE now, so a supervisor sees a real failure
   and a human sees the reason. An error on an ALREADY-LISTENING server is a different
   animal — one connection's problem, not the process's — so it is logged and survived. */
server.on('error', (err) => {
  if (server.listening) {
    hardLog(`[WS] http server error while listening — server continues: ${err?.stack || err}`);
    return;
  }
  hardLog(`[FATAL] cannot listen on :${PORT} — ${err?.code || ''} ${err?.message || err}`);
  process.exit(1);
});

server.listen(PORT, () => {
  // Build every icon raster before the first request rather than making the
  // first tab paint pay for it. Measured: 29ms for the SVG + all five PNGs.
  const iconMs = icon.warm();
  console.log(`\n  CHUDOPOLY — Air Force Card Game`);
  console.log(`  Server running on http://localhost:${PORT}`);
  console.log(`  icons generated in ${iconMs}ms (no binary in the tree — §0.3)\n`);
  // The link preview too — async because it imports the client's own cardart
  // module for the deck-mark geometry. Measured: ~140ms for both sizes, off
  // the listen path, so boot is not the one that pays.
  og.warm().then(
    (ms) => console.log(`  link preview generated in ${ms}ms (served at /og.png)`),
    (err) => console.error('[OG] preview generation failed:', err?.message || err));
});
