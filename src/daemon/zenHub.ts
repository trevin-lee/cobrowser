import type * as http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { claimUpgradePath } from '../util/upgradeRouter';
import { bridgeEndpointUrl, type BridgeBrowser } from './protocol';

export interface FirefoxContainer {
  name: string;
  cookieStoreId: string;
  color: string | null;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface Conn {
  ws: WebSocket;
  browser: BridgeBrowser;
  container: FirefoxContainer | undefined;
  lastError: string | undefined;
  pending: Map<number, Pending>;
}

const CALL_TIMEOUT_MS = 35000;

/**
 * The daemon's half of the browser bridge: one WebSocket per (workspace, browser), all
 * dialled in by the Firefox or Chrome add-on to this process's FIXED port with the
 * machine-wide token. Calls for a workspace go to whichever browser it is bound to.
 *
 * This is what makes the bridge stop dropping. Before, each editor window served its own
 * endpoint on an ephemeral port, so every reload moved the URL the add-on had; Firefox only
 * reads the managed manifest at startup, so the add-on was forever chasing dead ports. Now
 * the URL for a workspace never changes, and the daemon — which outlives every window —
 * holds the socket. A window coming or going only changes which container the daemon tells
 * the add-on to scope that socket to.
 *
 * The add-on's security model is unchanged: scope is per connection, set by our `hello` and
 * enforced by the add-on on every call, so one workspace's socket can never touch another
 * workspace's container.
 */
export class ZenHub {
  private wss: WebSocketServer | undefined;
  private readonly conns = new Map<string, Conn>();
  private nextId = 1;

  constructor(
    /** The current admin token; read per request so a rotated token file takes effect. */
    private readonly token: () => string | undefined,
    /** A workspace's current binding (undefined: not bound / no window). */
    private readonly bindingFor: (workspace: string) => { browser: BridgeBrowser; container: string } | undefined,
    private readonly log: (message: string) => void,
  ) {}

  attach(httpServer: http.Server): void {
    this.wss = new WebSocketServer({ noServer: true });
    claimUpgradePath(httpServer, '/zen', (req, socket, head, url) => {
      const admin = this.token();
      const workspace = url.searchParams.get('workspace') ?? '';
      const browser: BridgeBrowser = url.searchParams.get('browser') === 'chrome' ? 'chrome' : 'firefox';
      if (!admin || url.searchParams.get('token') !== admin || !workspace) {
        socket.destroy();
        return;
      }
      this.wss?.handleUpgrade(req, socket, head, (ws) => this.adopt(workspace, browser, ws));
    });
  }

  /** The URL the add-on should dial for a workspace. Stable: fixed port, admin token, path. */
  static url(port: number, token: string, workspace: string): string {
    return bridgeEndpointUrl(port, token, workspace);
  }

  /** A workspace's binding changed (window registered, re-bound, or went away): tell the
   *  add-on, if it is connected for that workspace. */
  private key(workspace: string, browser: BridgeBrowser): string {
    return `${browser}\u0000${workspace}`;
  }

  /** The socket calls for a workspace go to: the one from the browser it is bound to. */
  private bound(workspace: string): Conn | undefined {
    const b = this.bindingFor(workspace);
    return this.conns.get(this.key(workspace, b?.browser ?? 'firefox'));
  }

  rebind(workspace: string): void {
    // Every browser connected for this workspace is told again: the one now bound gets its
    // scope, any other gets an empty hello and reports itself unbound.
    for (const [k, c] of this.conns) {
      if (!k.endsWith(`\u0000${workspace}`)) continue;
      c.container = undefined;
      this.sendHello(workspace, c);
    }
  }

  status(workspace: string): { connected: boolean; browser?: BridgeBrowser; container?: FirefoxContainer; error?: string } {
    const c = this.bound(workspace);
    if (!c || c.ws.readyState !== WebSocket.OPEN) return { connected: false };
    return { connected: true, browser: c.browser, container: c.container, error: c.lastError };
  }

  /** Call a method in the add-on on behalf of a workspace. */
  call<T>(workspace: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
    const b = this.bindingFor(workspace);
    const c = this.bound(workspace);
    if (!c || c.ws.readyState !== WebSocket.OPEN) {
      const which = b?.browser === 'chrome' ? 'Chrome' : 'Firefox';
      return Promise.reject(
        new Error(
          `No ${which} browser is connected for this workspace. Install the Cobrowser Bridge extension in ${which}` +
            (b?.browser === 'chrome'
              ? ' and paste this workspace\'s bridge URL into it (Cobrowser: Copy Bridge URL).'
              : '; it configures itself from the managed manifest the editor writes.'),
        ),
      );
    }
    if (!c.container && method !== 'listContainers') {
      return Promise.reject(
        new Error(c.lastError ?? `${c.browser} is connected but this workspace is not bound to a scope yet.`),
      );
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        c.pending.delete(id);
        reject(new Error(`bridge call "${method}" timed out after ${CALL_TIMEOUT_MS}ms`));
      }, CALL_TIMEOUT_MS);
      c.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      c.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  close(): void {
    for (const [ws, c] of this.conns) {
      for (const p of c.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('bridge closed'));
      }
      c.ws.close();
      this.conns.delete(ws);
    }
    this.wss?.close();
  }

  // ------------------------------------------------------------------ internals

  private adopt(workspace: string, browser: BridgeBrowser, ws: WebSocket): void {
    const key = this.key(workspace, browser);
    const prev = this.conns.get(key);
    if (prev && prev.ws !== ws) {
      // The browser restarted before the old socket timed out: the new one wins.
      this.log(`zen: ${workspace} [${browser}] — a new connection replaced the previous one`);
      prev.ws.close();
    }
    const c: Conn = { ws, browser, container: undefined, lastError: undefined, pending: new Map() };
    this.conns.set(key, c);

    ws.on('message', (data: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      } catch {
        return;
      }
      this.handle(workspace, c, msg);
    });
    ws.on('close', () => {
      if (this.conns.get(key) !== c) return;
      this.conns.delete(key);
      for (const [id, p] of c.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`${c.browser} disconnected`));
        c.pending.delete(id);
      }
      this.log(`zen: ${workspace} [${browser}] — disconnected`);
    });

    this.log(`zen: ${workspace} [${browser}] — connected`);
    this.sendHello(workspace, c);
  }

  private sendHello(workspace: string, c: Conn): void {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    const b = this.bindingFor(workspace);
    // A browser the workspace is not bound to gets an empty scope and reports itself unbound.
    const container = b && (b.browser ?? 'firefox') === c.browser ? b.container : '';
    c.ws.send(JSON.stringify({ type: 'hello', container, workspace }));
  }

  private handle(workspace: string, c: Conn, msg: Record<string, unknown>): void {
    if (msg.type === 'ready') {
      c.container = msg.container as FirefoxContainer;
      c.lastError = undefined;
      this.log(`zen: ${workspace} [${c.browser}] — bound to "${c.container.name}"`);
      return;
    }
    if (msg.type === 'error') {
      c.container = undefined;
      c.lastError = String(msg.message ?? 'unknown error');
      this.log(`zen: ${workspace} [${c.browser}] — ${c.lastError}`);
      return;
    }
    if (msg.type === 'res') {
      const p = c.pending.get(msg.id as number);
      if (!p) return;
      clearTimeout(p.timer);
      c.pending.delete(msg.id as number);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(String(msg.error ?? 'unknown error')));
    }
  }
}
