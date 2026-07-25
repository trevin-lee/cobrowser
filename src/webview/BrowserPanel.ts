import * as vscode from 'vscode';
import type { CDPSession, Page } from 'puppeteer-core';
import type { BrowserSession, ElementBox } from '../browser/BrowserSession';

interface FrameEvent {
  data: string;
  sessionId: number;
  metadata: unknown;
}

/**
 * One webview panel per browser page — so each browser tab is a native VS Code
 * editor tab, and VS Code's own tab bar is the tab bar (no custom strip, no
 * double row). The extension opens one of these per page via the session's
 * page-lifecycle events.
 *
 * Each panel owns its own CDP session to its page: it screencasts that page to
 * a <canvas> and forwards the human's input back, serialized through
 * `session.run()`. Only the foreground page composites (headless), so a panel
 * screencasts only while it is the active editor tab and brings its page to the
 * front when revealed; hidden panels stop streaming and freeze on their last
 * frame.
 */
export class BrowserPanel {
  /** id (stable page id) -> panel, so lifecycle events can find their panel. */
  private static panels = new Map<string, BrowserPanel>();

  static get(id: string): BrowserPanel | undefined {
    return BrowserPanel.panels.get(id);
  }

  /** Open (or reveal) the panel for a page. Reveal=false opens it as a tab
   *  without stealing focus (agent background tabs). */
  static openForPage(
    context: vscode.ExtensionContext,
    session: BrowserSession,
    page: Page,
    id: string,
    reveal: boolean,
  ): BrowserPanel {
    const existing = BrowserPanel.panels.get(id);
    if (existing) {
      if (reveal) existing.panel.reveal(vscode.ViewColumn.Beside);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      'cobrowser',
      'Cobrowser',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !reveal },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist'),
          vscode.Uri.joinPath(context.extensionUri, 'media'),
        ],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    const bp = new BrowserPanel(context, session, panel, page, id);
    BrowserPanel.panels.set(id, bp);
    return bp;
  }

  static reveal(id: string): void {
    BrowserPanel.panels.get(id)?.panel.reveal(vscode.ViewColumn.Beside);
  }

  static closeForId(id: string): void {
    BrowserPanel.panels.get(id)?.panel.dispose();
  }

  static disposeAll(): void {
    for (const p of [...BrowserPanel.panels.values()]) p.panel.dispose();
  }

  private disposables: vscode.Disposable[] = [];
  private cdp: CDPSession | undefined;
  private frameHandler: ((e: FrameEvent) => void) | undefined;
  private ready = false;
  private metrics = { cssW: 0, cssH: 0, dpr: 1 };
  private origin = '';
  private appliedKey = '';
  private streaming = false;

  private constructor(
    private context: vscode.ExtensionContext,
    private session: BrowserSession,
    private panel: vscode.WebviewPanel,
    private page: Page,
    private id: string,
  ) {
    this.origin = hostOf(page.url());
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);

    // Screencast only while this is the active editor tab: only one page
    // composites at a time, so a hidden tab would get no frames anyway.
    this.panel.onDidChangeViewState(
      () => void this.syncStreaming(),
      null,
      this.disposables,
    );

    // Keep the omnibox + tab title in sync with this page's real URL/title.
    this.page.on('framenavigated', this.onNav);

    void this.updateTitle();
  }

  private onNav = (frame: unknown): void => {
    if (frame === this.page.mainFrame()) {
      this.origin = hostOf(this.page.url());
      void this.panel.webview.postMessage({ type: 'extension.url', url: this.page.url() });
      void this.updateTitle();
      void this.applyViewport(); // apply this origin's remembered zoom
    }
  };

  private async updateTitle(): Promise<void> {
    const title = (await this.page.title().catch(() => '')) || hostOf(this.page.url()) || 'Browser';
    this.panel.title = title;
  }

  /** Post an agent-action highlight box down to this panel's webview. */
  postHighlight(box: ElementBox): void {
    void this.panel.webview.postMessage({ type: 'extension.highlight', box });
  }

  /** Start/stop the screencast to match whether this tab is the active one.
   *  `streaming` is set up-front so a re-entrant view-state change (e.g. from
   *  bringing the page to the front) no-ops instead of looping. */
  private async syncStreaming(): Promise<void> {
    const shouldStream = this.panel.active && this.ready;
    if (shouldStream === this.streaming) return;
    this.streaming = shouldStream;
    if (shouldStream) {
      // Make this the agent's active page and bring it to the front so it
      // composites (focusPage, not selectPage — no reveal recursion), then stream.
      await this.session.run(() => this.session.focusPage(this.id)).catch(() => undefined);
      await this.startScreencast();
    } else {
      await this.stopScreencast();
    }
  }

  private async ensureCdp(): Promise<CDPSession> {
    if (this.cdp) return this.cdp;
    this.cdp = await this.page.createCDPSession();
    this.frameHandler = (e: FrameEvent) => {
      this.panel.webview.postMessage({
        method: 'Page.screencastFrame',
        result: { data: e.data, metadata: e.metadata },
      });
      this.cdp?.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => undefined);
    };
    this.cdp.on('Page.screencastFrame', this.frameHandler as never);
    return this.cdp;
  }

  private async startScreencast(): Promise<void> {
    try {
      const cdp = await this.ensureCdp();
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 90,
        // High caps so a device-pixel-sized viewport isn't downscaled back to blurry.
        maxWidth: 4096,
        maxHeight: 4096,
        everyNthFrame: 1,
      });
    } catch {
      /* page may be navigating/closed; a later view-state change retries */
    }
  }

  private async stopScreencast(): Promise<void> {
    try {
      await this.cdp?.send('Page.stopScreencast');
    } catch {
      /* page already gone */
    }
  }

  /** Size the page viewport to the panel in device pixels (screencast ignores
   *  deviceScaleFactor), divided by the per-site zoom (persisted per origin). */
  private async applyViewport(): Promise<void> {
    const { cssW, cssH, dpr } = this.metrics;
    if (cssW < 50 || cssH < 50) return;
    const zoom = this.getZoom();
    const width = Math.max(1, Math.round((cssW * dpr) / zoom));
    const height = Math.max(1, Math.round((cssH * dpr) / zoom));
    void this.panel.webview.postMessage({ type: 'extension.zoomlabel', zoom });
    const key = `${width}x${height}`;
    if (key === this.appliedKey) return;
    this.appliedKey = key;
    await this.session.run(() => this.session.setViewport(this.page, width, height, 1));
    if (this.streaming) await this.startScreencast();
  }

  private zoomMap(): Record<string, number> {
    return this.context.globalState.get<Record<string, number>>('cobrowser.zoom') ?? {};
  }
  private getZoom(): number {
    return this.zoomMap()[this.origin] ?? 1;
  }
  private async setZoom(z: number): Promise<void> {
    const map = this.zoomMap();
    map[this.origin] = z;
    await this.context.globalState.update('cobrowser.zoom', map);
  }

  private async onMessage(m: {
    type: string;
    params?: Record<string, unknown>;
    callbackId?: number;
  }): Promise<void> {
    if (typeof m?.type !== 'string') return;

    if (m.type.startsWith('extension.')) {
      try {
        switch (m.type) {
          case 'extension.ready':
            this.ready = true;
            await this.syncStreaming();
            void this.panel.webview.postMessage({ type: 'extension.url', url: this.page.url() });
            break;
          case 'extension.viewport': {
            const p = (m.params ?? {}) as { cssW?: number; cssH?: number; dpr?: number };
            if (p.cssW && p.cssH) {
              this.metrics = { cssW: p.cssW, cssH: p.cssH, dpr: p.dpr ?? 1 };
              await this.applyViewport();
            }
            break;
          }
          case 'extension.zoom': {
            const dir = (m.params as { dir?: string } | undefined)?.dir;
            let z = dir === 'reset' ? 1 : this.getZoom() * (dir === 'in' ? 1.2 : 1 / 1.2);
            z = Math.min(5, Math.max(0.25, Math.round(z * 100) / 100));
            await this.setZoom(z);
            this.appliedKey = ''; // force a re-apply at the new zoom
            await this.applyViewport();
            break;
          }
          case 'extension.back':
            await this.session.run(() => this.page.goBack().then(() => undefined).catch(() => undefined));
            break;
          case 'extension.forward':
            await this.session.run(() =>
              this.page.goForward().then(() => undefined).catch(() => undefined),
            );
            break;
          case 'extension.reload':
            await this.session.run(() => this.page.reload().then(() => undefined));
            break;
          case 'extension.navigate': {
            const p = (m.params ?? {}) as { url?: string };
            if (p.url) {
              await this.session.run(() =>
                this.page.goto(p.url!, { waitUntil: 'domcontentloaded' }).then(() => undefined),
              );
            }
            break;
          }
        }
      } catch {
        /* transient (page navigating/closed) — recovers on the next event */
      }
      return;
    }

    // CDP passthrough (Input.*), serialized via the session queue against the agent.
    const cdp = this.cdp;
    if (!cdp) return;
    try {
      const result = await this.session.run(() =>
        (cdp.send as (method: string, params?: unknown) => Promise<unknown>)(m.type, m.params),
      );
      if (m.callbackId != null) {
        this.panel.webview.postMessage({ callbackId: m.callbackId, result });
      }
    } catch (err) {
      if (m.callbackId != null) {
        this.panel.webview.postMessage({ callbackId: m.callbackId, error: String(err) });
      }
    }
  }

  private html(): string {
    const w = this.panel.webview;
    const scriptUri = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const cssUri = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.css'));
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource}; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>Cobrowser</title>
</head>
<body>
  <div id="toolbar">
    <button id="back" class="icon" title="Back" aria-label="Back">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3.5 5.5 8 10 12.5"/></svg>
    </button>
    <button id="forward" class="icon" title="Forward" aria-label="Forward">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>
    </button>
    <button id="reload" class="icon" title="Reload" aria-label="Reload">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M12.5 8a4.5 4.5 0 1 1-1.32-3.18M12.5 2.5V5H10"/></svg>
    </button>
    <div id="omnibox">
      <svg id="omnibox-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M7 2.5a4.5 4.5 0 1 0 2.85 8L13 13.6M10.5 7A3.5 3.5 0 1 1 3.5 7a3.5 3.5 0 0 1 7 0Z"/></svg>
      <input id="url" placeholder="Search or enter address" spellcheck="false" autocomplete="off" />
    </div>
    <button id="zoomout" class="icon" title="Zoom out (⌘−)" aria-label="Zoom out">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 8h8"/></svg>
    </button>
    <span id="zoomlabel" title="Zoom">100%</span>
    <button id="zoomin" class="icon" title="Zoom in (⌘+)" aria-label="Zoom in">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 4v8M4 8h8"/></svg>
    </button>
  </div>
  <div id="stage">
    <canvas id="screen" tabindex="0"></canvas>
    <div id="highlight" hidden></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    BrowserPanel.panels.delete(this.id);
    this.page.off('framenavigated', this.onNav);
    if (this.cdp && this.frameHandler) {
      try {
        this.cdp.off('Page.screencastFrame', this.frameHandler as never);
        this.cdp.send('Page.stopScreencast').catch(() => undefined);
        this.cdp.detach().catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
    // The human closed this editor tab → close the underlying browser page.
    void this.session.run(() => this.session.closePage(this.id)).catch(() => undefined);
    for (const d of this.disposables) d.dispose();
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
