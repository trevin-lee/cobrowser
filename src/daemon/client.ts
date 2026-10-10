import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { DEFAULT_DAEMON_PORT, type HealthResponse, type Registration } from './protocol';

type Log = (message: string) => void;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The daemon's shared secret, stored MACHINE-WIDE rather than in an editor's globalStorage.
 *
 * One daemon serves every editor, so its credential cannot live per-editor: VS Code and
 * Cursor generated different tokens, the daemon only ever read the file of whichever editor
 * spawned it, and the other editor got 401 on /health, concluded no daemon was running,
 * tried to spawn one, lost to EADDRINUSE and never registered at all.
 *
 * Mode 0600, and a file rather than argv so the token never shows up in `ps`.
 */
export function daemonTokenPath(dev = false): string {
  return path.join(os.homedir(), '.cobrowser', dev ? 'dev-daemon-token' : 'daemon-token');
}


function readIfPresent(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function writeToken(token: string, dev = false): string {
  const file = daemonTokenPath(dev);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
  return token;
}

/** The machine-wide token (created on first use). A dev daemon has a secret of its own. */
export function daemonToken(dev = false): string {
  return readIfPresent(daemonTokenPath(dev)) ?? writeToken(crypto.randomUUID(), dev);
}


/**
 * Replace the machine-wide token with a new one (Cobrowser: Replace Agent Token). The daemon
 * reads the file per request, so the old token stops opening it at once.
 */
export function replaceDaemonToken(dev = false): string {
  return writeToken(crypto.randomUUID(), dev);
}

/** Tell the daemon the token was replaced, so it closes bridge sockets opened with the old one. */
export function tokenReplaced(port: number, dev = false): Promise<boolean> {
  return post(port, daemonToken(dev), '/token-replaced', {});
}

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
  daemonScript: string;
  log: Log;
  /** Running from an Extension Development Host: isolate completely. */
  dev?: boolean;
}): Promise<boolean> {
  const { port, version, daemonScript, log, dev = false } = opts;

  const token = daemonToken(dev);

  const running = await health(port, token);
  if (running?.version === version) return true;

  // Never drag a shared daemon BACKWARDS. A window still running an older build would
  // otherwise restart everyone's daemon into that older version on activation, and the two
  // builds would take turns restarting it.
  if (running && isOlder(version, running.version)) {
    log(`Daemon is v${running.version}, newer than this build (v${version}) — leaving it alone.`);
    return true;
  }

  if (running) {
    log(`Daemon is v${running.version}, this build is v${version} — restarting it.`);
    await post(port, token, '/shutdown', {});
    for (let i = 0; i < 20 && (await health(port, token)); i++) await delay(100);
  } else if (await portBusy(port)) {
    // Something holds the port but authenticates with none of our secrets — an older daemon
    // whose token file we can no longer read. Without this it is a deadlock: /health 401s,
    // so we think nothing is running, and every spawn dies on EADDRINUSE.
    const pid = daemonPidOnPort(port);
    if (pid) {
      log(`A cobrowser daemon (pid ${pid}) holds port ${port} with an unknown token — replacing it.`);
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      for (let i = 0; i < 20 && (await portBusy(port)); i++) await delay(100);
    } else {
      log(`Port ${port} is held by something that is not a cobrowser daemon.`);
      return false;
    }
  }

  // Detached + unref'd so the daemon outlives the window that happened to start it — that
  // longevity is the whole reason the endpoint URL can stay fixed.
  const child = spawn(
    process.execPath,
    [daemonScript, '--port', String(port), '--token-file', daemonTokenPath(dev), '--version', version],
    { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  );
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
  if (await health(port, token)) return true;
  log(`Daemon did not come up on port ${port}. Is something else bound to it?`);
  return false;
}

/** Is `a` an older release than `b`? Numeric, component-wise; unparseable means "not older". */
export function isOlder(a: string, b: string): boolean {
  const parse = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10));
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const l = x[i] ?? 0;
    const r = y[i] ?? 0;
    if (!Number.isInteger(l) || !Number.isInteger(r)) return false;
    if (l !== r) return l < r;
  }
  return false;
}

async function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.setTimeout(700);
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
  });
}

/** The pid listening on `port`, but only if it is one of OUR daemons — never kill a
 *  stranger's process just because it took the port. */
function daemonPidOnPort(port: number): number | undefined {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = Number.parseInt(out.split('\n')[0]?.trim() ?? '', 10);
    if (!Number.isInteger(pid)) return undefined;
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return /dist\/daemon\.js/.test(cmd) ? pid : undefined;
  } catch {
    return undefined;
  }
}

export async function register(port: number, reg: Registration, log: Log, dev = false): Promise<void> {
  const ok = await post(port, daemonToken(dev), '/register', reg);
  log(ok ? `Registered "${reg.name}" with the cobrowser daemon.` : 'Could not register with the cobrowser daemon.');
}

/** Whether the daemon still has this window's workspace: it forgets every window when it
 *  restarts (an update, a crash), and a window must then register again. */
export async function registrationState(port: number, id: string, dev = false): Promise<'ok' | 'missing' | 'down'> {
  const h = await health(port, daemonToken(dev));
  if (!h) return 'down';
  return h.workspaces.some((w) => w.id === id) ? 'ok' : 'missing';
}

export async function deregister(port: number, id: string, dev = false): Promise<void> {
  await post(port, daemonToken(dev), '/deregister', { id });
}

export { DEFAULT_DAEMON_PORT };
