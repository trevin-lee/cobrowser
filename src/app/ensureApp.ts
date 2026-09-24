import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { readAppState, STATE_FILE, type AppState } from './AppClient';
import { readSignedMarker } from './signApp';

type Log = (message: string) => void;

/** Pinned: the app's Chromium is whatever this Electron ships, so this IS the browser version. */
export const ELECTRON_VERSION = '44.4.5';

export interface EnsureAppOptions {
  /** The app's bundled entry (dist/app/main.js inside the extension). */
  appMain: string;
  /** Where to keep the downloaded Electron (globalStorage/electron). */
  cacheDir: string;
  /** A developer's checkout: prefer its own node_modules Electron, skip the download. */
  devElectron?: string;
  version: string;
  iconPath?: string;
  onProgress?: (downloaded: number, total: number) => void;
  log: Log;
}

/**
 * Make sure the cobrowser app is running and is THIS extension's version. A stale app is
 * asked to quit and replaced: two versions taking turns would knock every window's agent
 * offline on each swap, so the newer build always wins and an older one never downgrades.
 */
/** The Electron executable ensureApp would use, without starting anything. */
export function electronExecutable(opts: Pick<EnsureAppOptions, 'cacheDir' | 'devElectron'>): string | undefined {
  if (opts.devElectron && fs.existsSync(opts.devElectron)) return opts.devElectron;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const exe = path.join(opts.cacheDir, `electron-v${ELECTRON_VERSION}-darwin-${arch}`, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return fs.existsSync(exe) ? exe : undefined;
}

export async function ensureApp(opts: EnsureAppOptions): Promise<AppState> {
  const running = readAppState();
  if (running) {
    const stale = isOlder(running.version, opts.version);
    // Signed for passkeys since it started (Enable Passkeys ran): the unsigned process can't
    // reach the authenticator, so it restarts as the signed one.
    const unsignedButSigned = !running.webauthn && !!readSignedMarker(electronExecutable(opts) ?? '');
    if (!stale && !unsignedButSigned) return running;
    opts.log(stale
      ? `cobrowser app ${running.version} is older than this extension (${opts.version}) — restarting it.`
      : 'cobrowser app is running unsigned but the browser is now signed for passkeys — restarting it.');
    try {
      process.kill(running.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    await waitFor(() => readAppState() === undefined, 8000);
  }
  const electron = opts.devElectron && fs.existsSync(opts.devElectron)
    ? opts.devElectron
    : await ensureElectron(opts);
  if (!fs.existsSync(opts.appMain)) throw new Error(`cobrowser app bundle missing: ${opts.appMain}`);
  const signed = readSignedMarker(electron);
  opts.log(`Starting cobrowser app ${opts.version} (${electron})${signed ? ' — signed, passkeys on' : ''}.`);
  const child = spawn(electron, [opts.appMain], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined, // the extension host sets this; the app must be Electron
      COBROWSER_VERSION: opts.version,
      COBROWSER_ICON: opts.iconPath ?? '',
      COBROWSER_WEBAUTHN_GROUP: signed?.webauthnGroup ?? '',
    },
  });
  child.unref();
  const state = await waitFor(() => {
    const s = readAppState();
    return s && s.version === opts.version ? s : undefined;
  }, 20000);
  if (!state) throw new Error(`cobrowser app did not start (no ${STATE_FILE} within 20s)`);
  return state;
}

/** Download the pinned Electron once into the cache and return its executable path. */
async function ensureElectron(opts: EnsureAppOptions): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('cobrowser app: only macOS is supported in this release');
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const dir = path.join(opts.cacheDir, `electron-v${ELECTRON_VERSION}-darwin-${arch}`);
  const exe = path.join(dir, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  if (fs.existsSync(exe)) return exe;

  const asset = `electron-v${ELECTRON_VERSION}-darwin-${arch}.zip`;
  const base = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}`;
  opts.log(`Downloading ${asset}…`);
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, asset);
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const want = sums.split('\n').find((l) => l.trim().endsWith(`*${asset}`) || l.trim().endsWith(` ${asset}`))?.split(/\s+/)[0];
  if (!want) throw new Error(`no checksum published for ${asset}`);
  await download(`${base}/${asset}`, zip, opts.onProgress);
  const got = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  if (got !== want) {
    fs.rmSync(zip, { force: true });
    throw new Error(`${asset} failed its checksum (got ${got.slice(0, 12)}…, want ${want.slice(0, 12)}…)`);
  }
  // ditto keeps the .app bundle's signature and attributes intact, where a generic unzip does not.
  execFileSync('ditto', ['-x', '-k', zip, dir]);
  fs.rmSync(zip, { force: true });
  if (!fs.existsSync(exe)) throw new Error(`Electron.app not found after extracting ${asset}`);
  opts.log(`Electron ${ELECTRON_VERSION} ready.`);
  return exe;
}

async function download(url: string, dest: string, onProgress?: (d: number, t: number) => void): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const out = fs.createWriteStream(dest);
  let done = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    out.write(value);
    done += value.length;
    onProgress?.(done, total);
  }
  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve());
    out.on('error', reject);
  });
}

function waitFor<T>(probe: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const v = probe();
      if (v !== undefined) return resolve(v);
      if (Date.now() > deadline) return resolve(undefined);
      setTimeout(tick, 150);
    };
    tick();
  });
}

/** True when `a` is a strictly older semver than `b`. Unparseable never counts as older. */
export function isOlder(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false;
  }
  return false;
}
