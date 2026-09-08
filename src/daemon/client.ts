import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DEFAULT_DAEMON_PORT, type HealthResponse, type Registration } from './protocol';

type Log = (message: string) => void;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One shared secret for the daemon endpoint, created by whichever window gets there first.
 *  A file (mode 0600) rather than argv, so the token never shows up in `ps`. */
export function daemonToken(globalStorage: string): string {
  const file = path.join(globalStorage, 'daemon-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }
  const token = crypto.randomUUID();
  fs.mkdirSync(globalStorage, { recursive: true });
  fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
  return token;
}

const tokenFile = (globalStorage: string): string => path.join(globalStorage, 'daemon-token');

async function health(port: number, token: string): Promise<HealthResponse | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    return res.ok ? ((await res.json()) as HealthResponse) : undefined;
  } catch {
    return undefined; // not running
  }
}

async function post(port: number, token: string, route: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Make sure a daemon of THIS build is listening, then hand back its port.
 *
 * The version handshake is the load-bearing part: without it, a daemon spawned by an older
 * install keeps serving its old code after every upgrade, and the extension would look
 * broken in ways no amount of reloading fixes.
 */
export async function ensureDaemon(opts: {
  port: number;
  version: string;
  globalStorage: string;
  daemonScript: string;
  log: Log;
}): Promise<boolean> {
  const { port, version, globalStorage, daemonScript, log } = opts;
  const token = daemonToken(globalStorage);

  const running = await health(port, token);
  if (running?.version === version) return true;

  if (running) {
    log(`Daemon is v${running.version}, this build is v${version} — restarting it.`);
    await post(port, token, '/shutdown', {});
    for (let i = 0; i < 20 && (await health(port, token)); i++) await delay(100);
  }

  // Detached + unref'd so the daemon outlives the window that happened to start it — that
  // longevity is the whole reason the endpoint URL can stay fixed.
  const child = spawn(process.execPath, [daemonScript, '--port', String(port), '--token-file', tokenFile(globalStorage), '--version', version], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();

  for (let i = 0; i < 30; i++) {
    await delay(100);
    const up = await health(port, token);
    if (up) {
      log(`Daemon v${up.version} listening on http://127.0.0.1:${port}/mcp (pid ${up.pid}).`);
      return true;
    }
  }
  // Losing a spawn race is fine and expected: the winner's daemon is already serving.
  const other = await health(port, token);
  if (other) return true;
  log(`Daemon did not come up on port ${port}. Is something else bound to it?`);
  return false;
}

export async function register(
  port: number,
  globalStorage: string,
  reg: Registration,
  log: Log,
): Promise<void> {
  const ok = await post(port, daemonToken(globalStorage), '/register', reg);
  log(ok ? `Registered "${reg.name}" with the cobrowser daemon.` : 'Could not register with the cobrowser daemon.');
}

export async function deregister(port: number, globalStorage: string, id: string): Promise<void> {
  await post(port, daemonToken(globalStorage), '/deregister', { id });
}

export { DEFAULT_DAEMON_PORT };
