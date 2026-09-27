import './isolate';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppConnection, readAppState, type NavigateKind } from '../../src/app/AppClient';
import { BrowserSession } from '../../src/browser/BrowserSession';
import { ELECTRON_VERSION } from '../../src/app/ensureApp';

export { AppConnection, BrowserSession, readAppState };
export type { NavigateKind };

/** The repo root: the runner starts every suite from it. */
export const ROOT = process.cwd();
export const SCRATCH = process.env.COBROWSER_E2E_SCRATCH!;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> {
  return Promise.race([p, sleep(ms).then(() => 'TIMEOUT' as const)]);
}

/** A fresh directory under this suite's scratch tree. */
export function scratchDir(name: string): string {
  const dir = path.join(SCRATCH, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The pinned Electron: the checkout's own when installed, else the one the extension cached. */
export function electronExe(): string {
  const dev = path.join(ROOT, 'app', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  if (fs.existsSync(dev)) return dev;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const dir = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'trevin-lee.cobrowser', 'electron', `electron-v${ELECTRON_VERSION}-darwin-${arch}`);
  for (const bundle of ['cobrowser.app', 'Electron.app']) {
    const exe = path.join(dir, bundle, 'Contents', 'MacOS', 'Electron');
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error(`no Electron ${ELECTRON_VERSION}: run \`npm --prefix app install\` or open a cobrowser panel once`);
}

export const APP_MAIN = path.join(ROOT, 'dist', 'app', 'main.js');

/** Environment for an isolated app: scratch state + data dirs, no biometrics, no real user.
 *  The data dir is shared by every app a suite spawns (they race for one lock, as editor
 *  windows do), so it is created once and never wiped mid-suite. */
const DATA_DIR = path.join(SCRATCH, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
export function appEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    COBROWSER_STATE_DIR: process.env.COBROWSER_STATE_DIR!,
    COBROWSER_DATA_DIR: DATA_DIR,
    COBROWSER_TEST_NO_BIOMETRICS: '1',
    COBROWSER_VERSION: 'e2e',
    ...extra,
  };
  delete env.ELECTRON_RUN_AS_NODE; // the extension host sets it; the app must be Electron
  return env;
}

export function spawnApp(extra: Record<string, string> = {}, args: string[] = []): ChildProcess {
  if (!fs.existsSync(APP_MAIN)) throw new Error(`${APP_MAIN} missing: run \`npm run build\` first`);
  return spawn(electronExe(), [APP_MAIN, ...args], { env: appEnv(extra), stdio: 'ignore' });
}

export async function waitForApp(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = readAppState();
    if (st) return st;
    if (Date.now() > deadline) throw new Error('the isolated app never wrote its state file');
    await sleep(200);
  }
}

export interface Launched {
  app: ChildProcess;
  conn: AppConnection;
  session: BrowserSession;
  workspace: string;
  /** A second connection for the same workspace (what an editor reload does). */
  reconnect(): Promise<{ conn: AppConnection; session: BrowserSession }>;
  stop(): Promise<void>;
}

/** Start an isolated app, connect to it as one workspace, and wrap it in a session. */
export async function launch(opts: { env?: Record<string, string>; passkeyFallback?: boolean; workspace?: string } = {}): Promise<Launched> {
  const app = spawnApp(opts.env);
  const workspace = opts.workspace ?? path.join(SCRATCH, 'workspace');
  const stop = async (): Promise<void> => {
    app.kill('SIGTERM');
    await withTimeout(new Promise<void>((r) => app.once('exit', () => r())), 3000);
    if (app.exitCode === null) app.kill('SIGKILL');
  };
  const killer = setTimeout(() => { void stop(); }, 240000); // no suite may outlive this
  killer.unref();
  try {
    const st = await waitForApp();
    const { conn } = await AppConnection.connect(st, workspace);
    const session = await BrowserSession.connectApp(conn, opts.passkeyFallback ?? false);
    const reconnect = async () => {
      const { conn: c } = await AppConnection.connect(readAppState()!, workspace);
      return { conn: c, session: await BrowserSession.connectApp(c, opts.passkeyFallback ?? false) };
    };
    return { app, conn, session, workspace, reconnect, stop: async () => { clearTimeout(killer); await stop(); } };
  } catch (e) {
    await stop();
    throw e;
  }
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export interface Served {
  /** http://127.0.0.1:<port> */
  base: string;
  /** http://localhost:<port> — a different SITE to Chromium, so an iframe from it is cross-origin
   *  and out-of-process. Same handler. */
  cross: string;
  port: number;
  close(): void;
}

/** A local page server on 127.0.0.1 and localhost (two sites, one handler). */
export async function serve(handler: Handler): Promise<Served> {
  const a = http.createServer(handler);
  await new Promise<void>((r) => a.listen(0, '127.0.0.1', r));
  const port = (a.address() as { port: number }).port;
  const b = http.createServer(handler);
  await new Promise<void>((r, rej) => { b.once('error', rej); b.listen(port, 'localhost', r); }).catch(() => undefined);
  return { base: `http://127.0.0.1:${port}`, cross: `http://localhost:${port}`, port, close: () => { a.close(); b.close(); } };
}

export const html = (body: string, status = 200): [number, Record<string, string>, string] => [status, { 'content-type': 'text/html; charset=utf-8' }, body];

/** Send one of the panel's own input events: the human path (frame routing, select menus). */
export async function humanClick(conn: AppConnection, tabId: string, x: number, y: number): Promise<void> {
  await conn.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, 30000, { human: true });
  await conn.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, 30000, { human: true });
  await sleep(60);
  await conn.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, 30000, { human: true });
}

export async function humanKey(conn: AppConnection, tabId: string, key: string, code: string, vk: number, text?: string): Promise<void> {
  await conn.cdp(tabId, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) }, 30000, { human: true });
  await conn.cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }, 30000, { human: true });
}

/** Windows a process has ON SCREEN (a hidden offscreen tab has none). Empty for a clean run. */
export function onScreenWindows(pid: number): { layer: number; w: number; h: number }[] {
  const script = path.join(SCRATCH, 'winlist.js');
  if (!fs.existsSync(script)) {
    fs.writeFileSync(script, `ObjC.import('CoreGraphics');
function run(argv) {
  const pid = Number(argv[0]);
  const arr = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0))) || [];
  return JSON.stringify(arr.filter((w) => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer !== 25).map((w) => ({ layer: w.kCGWindowLayer, w: w.kCGWindowBounds.Width, h: w.kCGWindowBounds.Height })));
}`);
  }
  return JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', script, String(pid)], { encoding: 'utf8' }).trim() || '[]');
}

/** %CPU of a process and everything under it (the app, its renderers, the GPU process). */
export function cpuOfTree(pid: number): number {
  const rows = execFileSync('ps', ['-axo', 'ppid,pid,%cpu'], { encoding: 'utf8' }).split('\n').slice(1).map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Set([pid]);
  let grew = true;
  while (grew) { grew = false; for (const [pp, p] of rows) if (kids.has(pp) && !kids.has(p)) { kids.add(p); grew = true; } }
  return rows.filter(([, p]) => kids.has(p)).reduce((a, [, , c]) => a + (c || 0), 0);
}

export async function averageCpu(pid: number, samples = 4): Promise<number> {
  let sum = 0;
  for (let i = 0; i < samples; i++) { await sleep(1000); sum += cpuOfTree(pid); }
  return Math.round(sum / samples);
}

/** A self-signed certificate for localhost, for the HTTPS checks. */
export function selfSignedCert(): { key: string; cert: string } {
  const dir = scratchDir('cert');
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  return { key, cert };
}

/** Pass/fail bookkeeping with the one-line-per-check output the runner reads. */
export class Report {
  private results = new Map<string, { ok: boolean; detail?: unknown }>();
  constructor(readonly suite: string) {}
  check(name: string, ok: boolean, detail?: unknown): void {
    this.results.set(name, { ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ' → ' + safe(detail)}`);
  }
  note(name: string, value: unknown): void {
    console.log(`note ${name}: ${safe(value)}`);
  }
  get failed(): number {
    return [...this.results.values()].filter((r) => !r.ok).length;
  }
  finish(): never {
    const total = this.results.size;
    console.log(`${this.suite}: ${total - this.failed}/${total} passed`);
    process.exit(this.failed ? 1 : 0);
  }
}

function safe(v: unknown): string {
  try { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 600 ? s.slice(0, 600) + '…' : s; } catch { return String(v); }
}

/** Run a suite: report, guaranteed teardown, non-zero exit on any failure or throw. */
export function suite(name: string, body: (r: Report) => Promise<void>): void {
  const r = new Report(name);
  body(r).then(() => r.finish(), (e) => {
    console.log(`FAIL ${name} threw: ${(e as Error).stack || e}`);
    process.exit(1);
  });
}
