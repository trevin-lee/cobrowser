import type * as http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Page } from 'puppeteer-core';
import type { BrowserSession } from '../browser/BrowserSession';

type Log = (m: string) => void;

export interface VideoHeader {
  pageId: string;
  kind: 'chunk' | 'config' | 'started' | 'error';
  type?: 'key' | 'delta';
  ts?: number;
  codec?: string;
  width?: number;
  height?: number;
  description?: string | null;
  message?: string;
}

/** WebRTC signaling relayed between the in-browser capture controller and a panel's
 *  webview. Only setup traffic crosses the extension host — the media itself flows
 *  peer-to-peer over loopback, straight from Chrome into the webview's <video>. */
interface SignalMessage {
  pageId: string;
  kind: 'offer' | 'answer' | 'ice' | 'stop';
  payload?: unknown;
}

/** The tab title the --auto-select-tab-capture-source-by-title flag auto-approves.
 *  A page carries it only for the ~100ms it takes getDisplayMedia to bind. */
const MAGIC_TITLE = '__cobrowser_capture__';

/**
 * Hardware-video pipeline coordinator. A hidden controller page inside the headless
 * browser captures tabs (getDisplayMedia) and streams WebCodecs H.264 chunks back
 * over a WebSocket on the MCP server's port; this hub routes them to the right
 * panel. Capture start is a small dance: retitle the target tab to the magic
 * string, give the controller a trusted click (user activation), ask it to
 * getDisplayMedia (auto-selected by title), then restore the title.
 */
export class CaptureHub {
  private wss: WebSocketServer | undefined;
  private controllerWs: WebSocket | undefined;
  private controllerPage: Page | undefined;
  private session: BrowserSession | undefined;
  private port = 0;
  private startQueue: Promise<unknown> = Promise.resolve();
  private pendingStarts = new Map<string, (ok: boolean) => void>();
  private frameCb: ((h: VideoHeader, payload: Buffer | undefined) => void) | undefined;

  constructor(
    private readonly token: string,
    private readonly capturePagePath: string,
    private readonly log: Log,
  ) {}

  onFrame(cb: (h: VideoHeader, payload: Buffer | undefined) => void): void {
    this.frameCb = cb;
  }

  /** Panel webviews connected as WebRTC receivers, keyed by pageId. */
  private viewers = new Map<string, WebSocket>();

  /** ws:// URL a webview uses to join as the viewer for a page. */
  viewerUrl(pageId: string): string {
    return `ws://127.0.0.1:${this.port}/capture?token=${encodeURIComponent(this.token)}&role=viewer&pageId=${encodeURIComponent(pageId)}`;
  }

  /** Accept the controller's WebSocket on the existing MCP HTTP server. */
  attach(httpServer: http.Server, port: number): void {
    this.port = port;
    this.wss = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/capture' || url.searchParams.get('token') !== this.token) {
        socket.destroy();
        return;
      }
      // A panel webview joining as the WebRTC receiver for one page. Signaling only —
      // once the peer connection is up, media bypasses this process entirely.
      if (url.searchParams.get('role') === 'viewer') {
        const pageId = url.searchParams.get('pageId') ?? '';
        this.wss?.handleUpgrade(req, socket, head, (ws) => {
          this.viewers.get(pageId)?.close(); // replace any stale viewer for this page
          this.viewers.set(pageId, ws);
          ws.on('message', (data: Buffer) => {
            // answer / ice from the webview → forward to the controller
            try {
              const msg = JSON.parse(data.toString('utf8')) as SignalMessage;
              this.controllerWs?.send(JSON.stringify({ cmd: 'signal', ...msg, pageId }));
            } catch {
              /* malformed */
            }
          });
          ws.on('close', () => {
            if (this.viewers.get(pageId) === ws) this.viewers.delete(pageId);
          });
        });
        return;
      }
      this.wss?.handleUpgrade(req, socket, head, (ws) => {
        this.controllerWs = ws;
        ws.on('message', (data: Buffer, isBinary: boolean) => {
          if (!isBinary) {
            // Text = WebRTC signaling from the controller (offer / ice) → its viewer.
            try {
              const msg = JSON.parse(data.toString('utf8')) as SignalMessage;
              if (msg.kind === 'offer' || msg.kind === 'ice') {
                this.viewers.get(msg.pageId)?.send(JSON.stringify(msg));
              } else if (msg.kind === 'stop') {
                this.pendingStarts.get(msg.pageId)?.(false);
              }
            } catch {
              /* malformed */
            }
            return;
          }
          try {
            const headerLen = data.readUInt32LE(0);
            const header = JSON.parse(data.subarray(4, 4 + headerLen).toString('utf8')) as VideoHeader;
            const payload = data.length > 4 + headerLen ? data.subarray(4 + headerLen) : undefined;
            if (header.kind === 'started' || header.kind === 'error') {
              if (header.kind === 'error') this.log(`Capture[${header.pageId}]: ${header.message}`);
              this.pendingStarts.get(header.pageId)?.(header.kind === 'started');
              if (header.kind === 'started') return; // ack consumed; nothing to route
            }
            this.frameCb?.(header, payload);
          } catch {
            /* malformed frame — skip */
          }
        });
        ws.on('close', () => {
          if (this.controllerWs === ws) this.controllerWs = undefined;
        });
      });
    });
  }

  /** New browser session: the old controller page died with the old Chrome. */
  setSession(session: BrowserSession): void {
    this.session = session;
    this.controllerPage = undefined;
  }

  private send(cmd: string, pageId: string): void {
    this.controllerWs?.send(JSON.stringify({ cmd, pageId }));
  }

  /** Begin H.264 capture of `page`. Resolves false on any failure (caller falls
   *  back to the JPEG screencast). Starts are serialized because the magic-title
   *  auto-selection can only unambiguously match one tab at a time. */
  start(pageId: string, page: Page): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const session = this.session;
      if (!session) return false;
      try {
        if (!this.controllerPage || this.controllerPage.isClosed()) {
          const url = `file://${this.capturePagePath}?port=${this.port}&token=${encodeURIComponent(this.token)}`;
          this.controllerPage = await session.createInternalPage(url);
        }
        // Wait for the controller's socket (it connects right after load).
        for (let i = 0; i < 40 && !this.controllerWs; i++) await delay(100);
        if (!this.controllerWs) throw new Error('capture controller never connected');

        const originalTitle = await page.evaluate((t) => {
          const old = document.title;
          document.title = t;
          return old;
        }, MAGIC_TITLE);
        try {
          // Trusted input = user activation, which getDisplayMedia requires.
          await this.controllerPage.mouse.click(4, 4);
          const ok = await new Promise<boolean>((resolve) => {
            this.pendingStarts.set(pageId, resolve);
            this.send('start', pageId);
            setTimeout(() => resolve(false), 8000);
          });
          this.pendingStarts.delete(pageId);
          return ok;
        } finally {
          await page
            .evaluate((t) => {
              document.title = t;
            }, originalTitle)
            .catch(() => undefined);
        }
      } catch (err) {
        this.log(`Capture start failed for page ${pageId}: ${String(err)}`);
        return false;
      }
    };
    const result = this.startQueue.then(run, run);
    this.startQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  stop(pageId: string): void {
    this.send('stop', pageId);
  }

  requestKeyframe(pageId: string): void {
    this.send('keyframe', pageId);
  }

  dispose(): void {
    this.wss?.close();
    this.controllerWs?.close();
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
