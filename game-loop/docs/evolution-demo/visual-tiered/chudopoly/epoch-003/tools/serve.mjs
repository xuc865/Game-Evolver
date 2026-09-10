#!/usr/bin/env node
/**
 * tools/serve.mjs — shared server lifecycle for every harness tool.
 *
 * Starts `node server.js` on an EPHEMERAL port (PORT=0 is not supported by the
 * server's listen call, so we pick a free port ourselves and hand it over in
 * env) and waits for /health. Ephemeral because P2/P3/P4 agents run tools
 * concurrently; a fixed 3000 means two tools kill each other's server halfway
 * through a recording.
 *
 * Usable as a library:
 *     import { startServer } from './serve.mjs';
 *     const s = await startServer({ seed: 7 });   // { port, url, wsUrl, stop() }
 *
 * Or standalone, to poke at a harness server by hand:
 *     node tools/serve.mjs [--port N] [--seed N]
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { ROOT, SEED, green, red, dim, bold, parseArgs } from './lib/harness.mjs';

/** Ask the OS for a free port, then release it. Small TOCTOU window, no better option. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body && body.ok === true;
  } catch {
    return false;
  }
}

async function waitForHealth(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await health(port)) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

/**
 * @param {{port?:number, seed?:number|string, env?:object, quiet?:boolean}} opts
 * @returns {Promise<{port:number,url:string,wsUrl:string,proc:any,logs:()=>string,stop:()=>Promise<void>}>}
 */
export async function startServer(opts = {}) {
  const port = opts.port || (await freePort());
  const quiet = opts.quiet !== false;
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      // NODE_ENV is deliberately NOT 'production': server.js's verifyClient
      // rejects origin-less WebSocket handshakes in production, and a raw `ws`
      // client from Node sends no Origin header. record.mjs would get an
      // instant 401 and no error message. (server.js:28)
      NODE_ENV: opts.env?.NODE_ENV || 'test',
      // Consumed by the seeded engine (§0.7). Harmless on the pre-P1 engine.
      CHUD_SEED: String(opts.seed ?? SEED),
      ...opts.env,
    },
  });

  let out = '';
  proc.stdout.on('data', (d) => { out += d; if (!quiet) process.stdout.write(d); });
  proc.stderr.on('data', (d) => { out += d; if (!quiet) process.stderr.write(d); });

  let exited = null;
  proc.on('exit', (code, sig) => { exited = code ?? sig; });

  const ok = await waitForHealth(port);
  if (!ok) {
    try { proc.kill('SIGKILL'); } catch {}
    throw new Error(
      `server.js never became healthy on :${port}` +
      (exited !== null ? ` (exited ${exited})` : '') + `\n${out}`
    );
  }

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    proc,
    logs: () => out,
    /**
     * Null while the server is alive, otherwise its exit code/signal.
     *
     * P8 round 2: touchtest lost the server mid-run on roughly one run in four
     * (every staged surface died on ERR_CONNECTION_REFUSED) and the tool had no
     * way to say so — it reported the browser's error and then printed green
     * summaries over the surfaces that had run before the death. A tool cannot
     * distinguish "the client is broken" from "the thing under test exited"
     * without asking, so every tool can now ask.
     */
    get died() { return exited !== null ? exited : proc.exitCode; },
    stop: async () => {
      if (proc.exitCode !== null) return;
      proc.kill('SIGTERM');
      for (let i = 0; i < 30 && proc.exitCode === null; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (proc.exitCode === null) proc.kill('SIGKILL');
    },
  };
}

// --------------------------------------------------------------- standalone
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  const server = await startServer({
    port: args.port ? Number(args.port) : undefined,
    seed: args.seed,
    quiet: false,
  });
  console.log(bold('serve') + ` ${green(server.url)} ${dim(`(seed ${args.seed ?? SEED})`)}`);
  console.log(dim('  ctrl-c to stop'));
  const bye = async () => { await server.stop(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  server.proc.on('exit', (c) => {
    console.log(red(`server exited ${c}`));
    process.exit(c ?? 1);
  });
}
