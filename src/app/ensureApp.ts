import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { readAppState, STATE_FILE, type AppState } from './AppClient';
import { readSignedMarker } from './signApp';
import { brandApp, brandedExe, isBranded } from './brandApp';

type Log = (message: string) => void;

/** Pinned: the app's Chromium is whatever this Electron ships, so this IS the browser version. */
export const ELECTRON_VERSION = '44.4.5';

export interface EnsureAppOptions {
  /** Internal: one replacement of an older instance has already been attempted. */
  retried?: boolean;
  /** The app's bundled entry (dist/app/main.js inside the extension). */
  appMain: string;
  /** Where to keep the downloaded Electron (globalStorage/electron). */
  cacheDir: string;
  /** A developer's checkout: prefer its own node_modules Electron, skip the download. */
  devElectron?: string;
  version: string;
  /** The menu-bar (tray) template image. */
  iconPath?: string;
  /** The app icon (.icns) the downloaded browser is branded with. */
  appIcon?: string;
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
  const dir = cachedVersionDir(opts.cacheDir);
  const branded = brandedExe(dir);
  if (fs.existsSync(branded)) return branded;
  const stock = path.join(dir, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return fs.existsSync(stock) ? stock : undefined;
}

function cachedVersionDir(cacheDir: string): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return path.join(cacheDir, `electron-v${ELECTRON_VERSION}-darwin-${arch}`);
}

/** The downloaded browser still lacks the cobrowser name and icon (a developer's own Electron
 *  is never branded). */
function needsBrand(opts: EnsureAppOptions): boolean {
  if (opts.devElectron && fs.existsSync(opts.devElectron)) return false;
  const dir = cachedVersionDir(opts.cacheDir);
  return fs.existsSync(dir) && !isBranded(dir);
}

/** A short hash of the app bundle on disk — what the running process reports back. */
export function buildIdOf(appMain: string): string {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(appMain)).digest('hex').slice(0, 12);
  } catch {
    return '';
  }
}

export async function ensureApp(opts: EnsureAppOptions): Promise<AppState> {
  const running = readAppState();
  if (running) {
    const stale = isOlder(running.version, opts.version);
    // Same version, different app code (a reinstall while iterating): the process must be
    // the code that shipped, or a fix in the app is invisible until someone restarts it.
    const rebuilt = !stale && running.build !== buildIdOf(opts.appMain);
    // Signed for passkeys since it started (Enable Passkeys ran): the unsigned process can't
    // reach the authenticator, so it restarts as the signed one.
    const unsignedButSigned = !running.webauthn && !!readSignedMarker(electronExecutable(opts) ?? '');
    // Branding renames the bundle the running process was launched from; it has to stop first.
    const unbranded = needsBrand(opts);
    if (!stale && !rebuilt && !unsignedButSigned && !unbranded) return running;
    opts.log(stale
      ? `cobrowser app ${running.version} is older than this extension (${opts.version}) — restarting it.`
      : rebuilt
        ? 'cobrowser app is running an older build of this version — restarting it.'
        : unbranded
          ? 'cobrowser app is being renamed and given its icon — restarting it.'
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
      COBROWSER_BUILD: buildIdOf(opts.appMain),
      COBROWSER_ICON: opts.iconPath ?? '',
      COBROWSER_WEBAUTHN_GROUP: signed?.webauthnGroup ?? '',
    },
  });
  child.unref();
  // Whichever instance won the app's single-instance lock is the app now — ours or one another
  // window spawned in the same moment. Either is fine when it is this version; an older
  // winner (another window still on an old extension) is told to go, once.
  const state = await waitFor(() => readAppState(), 20000);
  if (!state) throw new Error(`cobrowser app did not start (no ${STATE_FILE} within 20s)`);
  if (state.version !== opts.version && !opts.retried) {
    opts.log(`another window started cobrowser app ${state.version}; replacing it with ${opts.version}.`);
    try { process.kill(state.pid, 'SIGTERM'); } catch { /* gone */ }
    await waitFor(() => (readAppState() ? undefined : true), 8000);
    return ensureApp({ ...opts, retried: true });
  }
  return state;
}

/** Download the pinned Electron once into the cache and return its executable path. */
async function ensureElectron(opts: EnsureAppOptions): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('cobrowser app: only macOS is supported in this release');
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const dir = cachedVersionDir(opts.cacheDir);
  const exe = path.join(dir, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  const brand = (): string => (isBranded(dir) ? brandedExe(dir) : brandApp(dir, opts.appIcon ?? '', opts.log));
  if (fs.existsSync(brandedExe(dir)) || fs.existsSync(exe)) return brand();

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
  return brand();
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
