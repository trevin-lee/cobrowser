import type * as http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { claimUpgradePath } from '../util/upgradeRouter';

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

const CALL_TIMEOUT_MS = 35000;

/**
 * Editor half of the Zen bridge.
 *
 * The WebExtension dials IN here (an extension can't listen on a port), on the same
 * localhost port and Bearer token as the MCP server — one endpoint per workspace. On
 * connect we tell it which container this workspace is bound to; it resolves that name to
 * a cookieStoreId and refuses every later call that touches a tab outside it.
 *
 * Only one browser connection is held at a time: a second one replaces the first, which is
 * what you want when Zen restarts and the old socket hasn't timed out yet.
 */
export class FirefoxBridge {
  private wss: WebSocketServer | undefined;
  private ws: WebSocket | undefined;
  private container: FirefoxContainer | undefined;
  private lastError: string | undefined;
  private port = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly watchers = new Set<() => void>();

  constructor(
    private readonly token: string,
    private containerName: string,
    private readonly workspace: string,
    private readonly log: (message: string) => void,
  ) {}

  attach(httpServer: http.Server, port: number): void {
    this.port = port;
    this.wss = new WebSocketServer({ noServer: true });
    claimUpgradePath(httpServer, '/zen', (req, socket, head, url) => {
      if (url.searchParams.get('token') !== this.token) {
        socket.destroy();
        return;
      }
      this.wss?.handleUpgrade(req, socket, head, (ws) => this.adopt(ws));
    });
  }

  /** The URL to paste into the Zen extension's options page. Carries the live token. */
  url(): string {
    return `ws://127.0.0.1:${this.port}/zen?token=${encodeURIComponent(this.token)}`;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.container !== undefined;
  }

  get boundContainer(): FirefoxContainer | undefined {
    return this.container;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  /** Re-bind to a different container without dropping the socket. */
  setContainer(name: string): void {
    if (name === this.containerName) return;
    this.containerName = name;
    this.container = undefined;
    this.sendHello();
    this.notify();
  }

  onStateChange(fn: () => void): void {
    this.watchers.add(fn);
  }

  /** Call a method in the browser extension. Rejects if no browser is connected. */
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error(
        'No Firefox browser connected. Install the Cobrowser Bridge extension and add this ' +
          "workspace's endpoint (command: Cobrowser: Copy Firefox Bridge URL).",
      );
    }
    if (!this.container && method !== 'listContainers') {
      throw new Error(
        this.lastError ??
          `Zen is connected but not bound to a container. Set "cobrowser.zenContainer" for this workspace.`,
      );
    }

    const id = this.nextId++;
    const ws = this.ws;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Zen bridge call "${method}" timed out after ${CALL_TIMEOUT_MS}ms`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  dispose(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Zen bridge closed'));
    }
    this.pending.clear();
    this.ws?.close();
    this.ws = undefined;
    this.wss?.close();
  }

  // ------------------------------------------------------------------ internals

  private adopt(ws: WebSocket): void {
    if (this.ws && this.ws !== ws) {
      this.log('Zen bridge: a new browser connection replaced the previous one.');
      this.ws.close();
    }
    this.ws = ws;
    this.container = undefined;
    this.lastError = undefined;

    ws.on('message', (data: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      } catch {
        return;
      }
      this.handle(msg);
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.container = undefined;
      // Fail in-flight calls now rather than letting each one sit out its timeout.
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('Zen browser disconnected'));
        this.pending.delete(id);
      }
      this.log('Zen bridge: browser disconnected.');
      this.notify();
    });

    this.sendHello();
  }

  private sendHello(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: 'hello',
        container: this.containerName,
        workspace: this.workspace,
      }),
    );
  }

  private handle(msg: Record<string, unknown>): void {
    if (msg.type === 'ready') {
      this.container = msg.container as FirefoxContainer;
      this.lastError = undefined;
      this.log(`Zen bridge: bound to container "${this.container.name}" (${this.container.cookieStoreId}).`);
      this.notify();
      return;
    }

    if (msg.type === 'error') {
      this.container = undefined;
      this.lastError = String(msg.message ?? 'unknown error');
      this.log(`Zen bridge: ${this.lastError}`);
      this.notify();
      return;
    }

    if (msg.type === 'res') {
      const id = msg.id as number;
      const p = this.pending.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(String(msg.error ?? 'unknown error')));
    }
  }

  private notify(): void {
    for (const fn of this.watchers) fn();
  }
}
