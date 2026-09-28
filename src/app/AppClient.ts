import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

export interface AppState {
  wsPort: number;
  token: string;
  pid: number;
  version: string;
  /** Hash of the app bundle this process was started from, so a same-version reinstall
   *  (a dev iteration) still gets the new app code. */
  build?: string;
  /** The binary is signed for passkeys and the Touch ID authenticator is configured. */
  webauthn?: boolean;
}

/** The real display the panel is on, in CSS px, so the page can describe its screen truthfully. */
export interface ScreenInfo {
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface AppTabInfo {
  tabId: string;
  url: string;
  title: string;
  /** The tab that opened this one (a site popup / target=_blank), if any. */
  opener?: string;
  /** Who opened it, kept by the app so it survives an editor reload. */
  by?: 'agent' | 'human';
}

export interface AppFrame {
  bytes: Uint8Array;
  /** deviceWidth/Height: the page's CSS coordinate space; frameWidth/Height: the bitmap. */
  metadata: { tabId: string; deviceWidth: number; deviceHeight: number; frameWidth?: number; frameHeight?: number };
}

export type NavigateKind = 'url' | 'back' | 'forward' | 'reload';

export interface NavigateResult {
  url: string;
  title: string;
  error?: string;
  timedOut?: boolean;
  /** back/forward with no history in that direction. */
  noop?: boolean;
}

export interface ConsoleEntry {
  seq: number;
  time: string;
  level: string;
  text: string;
  url?: string;
  line?: number;
  source?: string;
  pageUrl: string;
}

export interface RequestEntry {
  seq: number;
  time: string;
  method: string;
  url: string;
  type?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  error?: string;
  fromCache?: boolean;
  durationMs?: number;
  pageUrl: string;
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
 *
 * Everything the editor does to a tab goes over this one socket — frames out, input and
 * DevTools-protocol commands in. The app speaks the protocol to its own tabs in-process, so
 * no debugging port is ever opened: nothing else on the machine can attach to the user's
 * sessions, and the pages are not launched under an automation switch.
 */
export class AppConnection {
  private ws: WebSocket;
  private nextRequest = 1;
  private pending = new Map<number, (m: Record<string, unknown>) => void>();
  private frameListeners = new Map<string, FrameListener>();
  readonly version: string;
  onTabOpened?: (t: AppTabInfo) => void;
  onTabClosed?: (tabId: string) => void;
  onTabUpdated?: (t: AppTabInfo) => void;
  /** The app is quitting: the tab closes that follow are the quit, not the human. */
  onQuitting?: () => void;
  /** The page went fullscreen inside its tab (or left it). */
  onFullscreen?: (tabId: string, on: boolean) => void;
  onClose?: () => void;

  private constructor(ws: WebSocket, hello: { version: string; tabs: AppTabInfo[] }) {
    this.ws = ws;
    this.version = hello.version;
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
    const hello = await new Promise<{ version: string; tabs: AppTabInfo[] }>((resolve, reject) => {
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

  async openTab(url: string, width: number, height: number, by: 'agent' | 'human' = 'human'): Promise<AppTabInfo> {
    return (await this.request({ type: 'openTab', url, width, height, by })) as unknown as AppTabInfo;
  }

  /** Record who a tab belongs to (a popup the agent's own click opened). */
  markTab(tabId: string, by: 'agent' | 'human'): void {
    this.send({ type: 'markTab', tabId, by });
  }

  async listTabs(): Promise<AppTabInfo[]> {
    const r = await this.request({ type: 'listTabs' });
    return r.tabs as AppTabInfo[];
  }

  closeTab(tabId: string): void {
    this.send({ type: 'closeTab', tabId });
  }

  /**
   * One DevTools-protocol command on a tab, executed by the app's in-process debugger.
   * Input.*, Runtime.evaluate, Page.captureScreenshot, WebAuthn.* — anything the page's
   * session supports. Throws with the protocol's error message.
   */
  async cdp<T = Record<string, unknown>>(tabId: string, method: string, params?: unknown, timeoutMs = 30000, opts: { human?: boolean } = {}): Promise<T> {
    const r = await this.request({ type: 'cdp', tabId, method, params: params ?? {}, ...(opts.human ? { human: true } : {}) }, timeoutMs);
    if (r.error) throw new Error(String(r.error));
    return (r.result ?? {}) as T;
  }

  /** Navigate a tab and wait for the new document's DOM (or an in-page navigation). */
  async navigate(tabId: string, kind: NavigateKind, url?: string, timeout = 30000): Promise<NavigateResult> {
    return (await this.request({ type: 'navigate', tabId, kind, url, timeout }, timeout + 5000)) as unknown as NavigateResult;
  }

  async consoleMessages(tabId: string, since = 0, opts: { limit?: number; level?: string } = {}): Promise<{ entries: ConsoleEntry[]; latest: number }> {
    return (await this.request({ type: 'console', tabId, since, ...opts })) as unknown as { entries: ConsoleEntry[]; latest: number };
  }

  async networkRequests(
    tabId: string,
    since = 0,
    opts: { limit?: number; failedOnly?: boolean; urlContains?: string; minStatus?: number } = {},
  ): Promise<{ entries: RequestEntry[]; latest: number; pending: number }> {
    return (await this.request({ type: 'network', tabId, since, ...opts })) as unknown as { entries: RequestEntry[]; latest: number; pending: number };
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
  /** Ask the app to export every login to a CSV the human picks (Touch ID each time). The
   *  passwords are written by the app; nothing but the count and the path comes back. */
  async vaultExport(): Promise<{ ok: boolean; count?: number; file?: string; canceled?: boolean; error?: string }> {
    return (await this.request({ type: 'vault.export' }, 300000)) as unknown as { ok: boolean; count?: number; file?: string; canceled?: boolean; error?: string };
  }
  async vaultLock(): Promise<void> {
    await this.request({ type: 'vault.lock' });
  }
  /** Ask the human (native dialog) to let this workspace use a login it is not scoped for. */
  async vaultRequest(site: string, username: string | undefined, reason: string | undefined): Promise<{ granted: 'workspace' | 'once' | 'already' | 'denied'; host?: string; username?: string; error?: string }> {
    // Long timeout: Touch ID plus a dialog the human may take a while to notice.
    return (await this.request({ type: 'vault.request', site, username, reason }, 300000)) as unknown as { granted: 'workspace' | 'once' | 'already' | 'denied'; host?: string; username?: string; error?: string };
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
  resize(tabId: string, width: number, height: number, scale = 1, zoom = 1, screen?: ScreenInfo): void {
    this.send({ type: 'resize', tabId, width, height, scale, zoom, screen });
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
      this.onTabOpened?.(m as unknown as AppTabInfo);
    } else if (m.type === 'tabUpdated') {
      this.onTabUpdated?.(m as unknown as AppTabInfo);
    } else if (m.type === 'fullscreen') {
      this.onFullscreen?.(String(m.tabId), !!m.on);
    } else if (m.type === 'quitting') {
      this.onQuitting?.();
    } else if (m.type === 'tabClosed') {
      const id = String(m.tabId);
      this.frameListeners.delete(id);
      this.onTabClosed?.(id);
    }
  }

  close(): void {
    this.ws.close();
  }
}
