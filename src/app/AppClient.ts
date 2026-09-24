import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

export interface AppState {
  wsPort: number;
  token: string;
  debugWs: string;
  pid: number;
  version: string;
  /** The binary is signed for passkeys and the Touch ID authenticator is configured. */
  webauthn?: boolean;
}

export interface AppTabInfo {
  tabId: string;
  targetId: string;
  url: string;
  opener?: string;
}

export interface AppFrame {
  bytes: Uint8Array;
  /** deviceWidth/Height: the page's CSS coordinate space; frameWidth/Height: the bitmap. */
  metadata: { tabId: string; deviceWidth: number; deviceHeight: number; frameWidth?: number; frameHeight?: number };
}

/** Overridable with COBROWSER_STATE_DIR — the app honours the same variable — so a test can
 *  run a second instance and never reach the user's real app. */
export const STATE_FILE = path.join(process.env.COBROWSER_STATE_DIR || path.join(os.homedir(), '.cobrowser'), 'app.json');

/** The running app's connection details, or undefined if it isn't running. */
export function readAppState(): AppState | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as AppState;
    process.kill(s.pid, 0); // throws when the pid is gone → the file is stale
    return s;
  } catch {
    return undefined;
  }
}

type FrameListener = (f: AppFrame) => void;

/**
 * This editor window's connection to the app, scoped to one workspace. Tabs belong to the
 * workspace inside the app, not to this socket: a reload reconnects and finds them again.
 */
export class AppConnection {
  private ws: WebSocket;
  private nextRequest = 1;
  private pending = new Map<number, (m: Record<string, unknown>) => void>();
  private frameListeners = new Map<string, FrameListener>();
  /** targetId → tabId for every tab the app has told us about. */
  private byTarget = new Map<string, string>();
  readonly debugWs: string;
  readonly version: string;
  onTabOpened?: (t: AppTabInfo) => void;
  onTabClosed?: (tabId: string) => void;
  onClose?: () => void;

  private constructor(ws: WebSocket, hello: { debugWs: string; version: string; tabs: AppTabInfo[] }) {
    this.ws = ws;
    this.debugWs = hello.debugWs;
    this.version = hello.version;
    for (const t of hello.tabs) this.byTarget.set(t.targetId, t.tabId);
    ws.on('message', (data, isBinary) => this.receive(data as Buffer, isBinary));
    ws.on('close', () => this.onClose?.());
    ws.on('error', () => undefined); // surfaced through 'close'
  }

  static async connect(state: AppState, workspace: string): Promise<{ conn: AppConnection; tabs: AppTabInfo[] }> {
    const ws = new WebSocket(`ws://127.0.0.1:${state.wsPort}/?token=${state.token}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const hello = await new Promise<{ debugWs: string; version: string; tabs: AppTabInfo[] }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('app did not answer hello')), 10000);
      ws.once('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse((data as Buffer).toString()));
      });
      ws.send(JSON.stringify({ type: 'hello', workspace }));
    });
    return { conn: new AppConnection(ws, hello), tabs: hello.tabs };
  }

  private send(m: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private request(m: Record<string, unknown>, timeoutMs = 15000): Promise<Record<string, unknown>> {
    const requestId = this.nextRequest++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`app did not answer ${String(m.type)}`));
      }, timeoutMs);
      this.pending.set(requestId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.send({ ...m, requestId });
    });
  }

  async openTab(url: string, width: number, height: number): Promise<AppTabInfo> {
    const r = (await this.request({ type: 'openTab', url, width, height })) as unknown as AppTabInfo;
    this.byTarget.set(r.targetId, r.tabId);
    return r;
  }

  async listTabs(): Promise<AppTabInfo[]> {
    const r = await this.request({ type: 'listTabs' });
    const tabs = r.tabs as AppTabInfo[];
    for (const t of tabs) this.byTarget.set(t.targetId, t.tabId);
    return tabs;
  }

  tabIdFor(targetId: string): string | undefined {
    return this.byTarget.get(targetId);
  }

  closeTab(tabId: string): void {
    this.send({ type: 'closeTab', tabId });
  }

  /** Write cookies into a workspace's partition (any workspace — used by the migration). */
  async importCookies(workspace: string, cookies: Record<string, unknown>[]): Promise<{ imported: number; failed: number }> {
    const r = await this.request({ type: 'importCookies', workspace, cookies });
    return { imported: Number(r.imported) || 0, failed: Number(r.failed) || 0 };
  }

  // --- vault: the agent can use logins without seeing them; passwords never cross this socket
  //     outbound except INTO the app (add/import), and never come back.
  /** `scope` defaults to this connection's workspace inside the app. */
  async vaultAdd(host: string, username: string, password: string, scope?: 'all' | string[]): Promise<void> {
    const r = await this.request({ type: 'vault.add', host, username, password, ...(scope ? { scope } : {}) }, 120000);
    if (r.error) throw new Error(String(r.error));
  }
  async vaultImport(csv: string, scope?: 'all' | string[]): Promise<number> {
    const r = await this.request({ type: 'vault.import', csv, ...(scope ? { scope } : {}) }, 120000);
    if (r.error) throw new Error(String(r.error));
    return Number(r.count) || 0;
  }
  async vaultList(): Promise<{ host: string; username: string }[]> {
    const r = await this.request({ type: 'vault.list' }, 120000);
    if (r.error) throw new Error(String(r.error));
    return r.logins as { host: string; username: string }[];
  }
  async vaultLock(): Promise<void> {
    await this.request({ type: 'vault.lock' });
  }
  async vaultFill(tabId: string, opts: { usernameUid?: string; passwordUid?: string; username?: string }): Promise<{ filled: string[]; username?: string; error?: string; candidates?: string[] }> {
    return (await this.request({ type: 'vault.fill', tabId, ...opts }, 120000)) as unknown as { filled: string[]; username?: string; error?: string; candidates?: string[] };
  }
  /** Strip any unlocked password out of text bound for the agent. */
  async scrub(text: string): Promise<string> {
    const r = await this.request({ type: 'vault.scrub', text });
    return typeof r.text === 'string' ? r.text : text;
  }

  closeAll(): void {
    this.send({ type: 'closeAll' });
  }

  /** Lay the page out at cssW x cssH CSS px (divided by `zoom`), rasterized at `scale` device
   *  pixels per CSS px — the frame comes back css*scale pixels wide. */
  resize(tabId: string, width: number, height: number, scale = 1, zoom = 1): void {
    this.send({ type: 'resize', tabId, width, height, scale, zoom });
  }

  subscribe(tabId: string, listener: FrameListener): void {
    this.frameListeners.set(tabId, listener);
    this.send({ type: 'subscribe', tabId });
  }

  unsubscribe(tabId: string): void {
    this.frameListeners.delete(tabId);
    this.send({ type: 'unsubscribe', tabId });
  }

  private receive(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      const metaLen = data.readUInt32LE(0);
      const metadata = JSON.parse(data.subarray(4, 4 + metaLen).toString()) as AppFrame['metadata'];
      const listener = this.frameListeners.get(metadata.tabId);
      if (!listener) return;
      const bytes = new Uint8Array(data.buffer, data.byteOffset + 4 + metaLen, data.length - 4 - metaLen);
      listener({ bytes, metadata });
      return;
    }
    const m = JSON.parse(data.toString()) as Record<string, unknown>;
    if (typeof m.requestId === 'number') {
      const cb = this.pending.get(m.requestId);
      this.pending.delete(m.requestId);
      cb?.(m);
      return;
    }
    if (m.type === 'tab') {
      const t = m as unknown as AppTabInfo;
      this.byTarget.set(t.targetId, t.tabId);
      this.onTabOpened?.(t);
    } else if (m.type === 'tabClosed') {
      const id = String(m.tabId);
      for (const [target, tab] of this.byTarget) if (tab === id) this.byTarget.delete(target);
      this.frameListeners.delete(id);
      this.onTabClosed?.(id);
    }
  }

  close(): void {
    this.ws.close();
  }
}
