import * as vscode from 'vscode';
import { pickColumn } from './columns';
import * as fs from 'node:fs';
import type { CDPSession, Page } from 'puppeteer-core';
import type { BrowserSession, ElementBox } from '../browser/BrowserSession';
import type { AppConnection } from '../app/AppClient';

/** Ceiling on rendered pixels per frame (device px). 5Mpx sits above a full-screen
 *  retina laptop panel (~3.6Mpx, measured 60fps) and below the point where JPEG
 *  encode falls apart (~10.7Mpx → 46fps, 1.26MB frames) and H.264 levels run out. */
const MAX_RENDER_PX = 5_000_000;

// Every page lives in its own headless window (see BrowserSession.createPageInNewWindow),
// so every visible panel screencasts at full compositor rate simultaneously — no
// foreground coordination, no screenshot polling for background panels.

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

  /** Editor columns for the next panels to open, in order — set before a tab restore so
   *  each recreated panel lands in the editor group it occupied before the reload
   *  (otherwise the stacking logic below collapses a split into one group). */
  private static plannedColumns: (number | undefined)[] = [];

  /**
   * The editor group cobrowser has claimed — its dedicated pane.
   *
   * VS Code reports `panel.viewColumn` as undefined whenever a panel is not the visible tab
   * in its group, so deriving the target column from live panels returned nothing the moment
   * you switched to a code file, and every new browser tab opened a FRESH SPLIT. Remembering
   * the column keeps all browser tabs stacked in one pane, the way browser tabs should be.
   */
  private static dedicatedColumn: vscode.ViewColumn | undefined;

  /** Remember wherever a panel actually lives, so later tabs join it. */
  private static claimColumn(col: vscode.ViewColumn | undefined): void {
    if (col != null) BrowserPanel.dedicatedColumn = col;
  }

  /** The pane new browser tabs should open in. */
  static targetColumn(): vscode.ViewColumn | undefined {
    return pickColumn({
      dedicated: BrowserPanel.dedicatedColumn,
      liveColumns: [...BrowserPanel.panels.values()].map((p) => p.panel.viewColumn),
    });
  }

  static planColumns(cols: (number | undefined)[]): void {
    BrowserPanel.plannedColumns = [...cols];
  }

  static clearColumnPlan(): void {
    BrowserPanel.plannedColumns = [];
  }

  /** The editor column a page's panel currently occupies (for layout persistence). */
  static columnOf(id: string): number | undefined {
    return BrowserPanel.panels.get(id)?.panel.viewColumn;
  }

  /** Notified on any panel view-state change, so the host can persist the layout
   *  (a panel dragged to another editor group doesn't fire any session event). */
  static onLayoutChanged: (() => void) | undefined;

  /** The app streaming this workspace's tabs. Set by the extension once connected. */
  static app: AppConnection | undefined;

  /** Inlined webview assets (CSS/JS), read ONCE and cached in memory. */
  private static assetCache: { css: string; js: string } | undefined;

  /** Read the webview CSS/JS at activation, when this version's install dir is guaranteed
   *  to exist, and cache them. A later `npm run release` prunes older install dirs — if the
   *  running host's dir gets pruned, reading assets at panel-creation time would return
   *  empty (the "unstyled toolbar"). Caching at startup makes open windows immune. */
  static primeAssets(context: vscode.ExtensionContext): void {
    const css = readAsset(context, 'media', 'panel.css');
    const js = readAsset(context, 'dist', 'webview.js');
    if (css && js) BrowserPanel.assetCache = { css, js };
  }

  static get(id: string): BrowserPanel | undefined {
    return BrowserPanel.panels.get(id);
  }

  /** Panels restored by VS Code's serializer at startup — the tab shell exists
   *  instantly (like editor tabs); each waits here to be adopted by its page once
   *  the session is up. Keyed by the page URL the webview saved as state. */
  private static restoredPool: Array<{
    panel: vscode.WebviewPanel;
    url?: string;
    timer?: ReturnType<typeof setTimeout>;
  }> = [];

  /** Park a deserialized panel until its page exists. Paints the toolbar shell
   *  immediately so the restored tab isn't a blank void while Chrome launches. */
  static addRestored(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    url: string | undefined,
  ): void {
    panel.webview.options = { enableScripts: true };
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    panel.webview.html = BrowserPanel.renderHtml(context);
    const entry: { panel: vscode.WebviewPanel; url?: string; timer?: ReturnType<typeof setTimeout> } =
      { panel, url };
    // Self-destruct if no page claims this shell. VS Code can deserialize panels at any
    // point — including AFTER the restore sweep has already run — and such a late shell
    // would otherwise linger forever as a blank tab with an empty URL bar.
    entry.timer = setTimeout(() => {
      if (BrowserPanel.restoredPool.includes(entry)) {
        BrowserPanel.restoredPool = BrowserPanel.restoredPool.filter((e) => e !== entry);
        panel.dispose();
      }
    }, 10_000);
    BrowserPanel.restoredPool.push(entry);
    // If the user closes the placeholder before adoption, forget it.
    panel.onDidDispose(() => {
      if (entry.timer) clearTimeout(entry.timer);
      BrowserPanel.restoredPool = BrowserPanel.restoredPool.filter((e) => e !== entry);
    });
  }

  /** Claim a restored panel for a page: exact URL match first; a page still on
   *  about:blank (the initial page, adopted before its restore-navigation runs)
   *  takes the oldest one — restore order equals creation order. */
  private static takeRestored(url: string): vscode.WebviewPanel | undefined {
    let idx = BrowserPanel.restoredPool.findIndex((e) => e.url === url);
    if (idx < 0 && url === 'about:blank' && BrowserPanel.restoredPool.length > 0) idx = 0;
    if (idx < 0) return undefined;
    const [entry] = BrowserPanel.restoredPool.splice(idx, 1);
    if (entry.timer) clearTimeout(entry.timer); // adopted — cancel self-destruct
    return entry.panel;
  }

  /** Dispose restored panels no page claimed (their tabs were closed pre-reload,
   *  or the session came back with a different set). */
  static disposeUnclaimedRestored(): void {
    for (const e of [...BrowserPanel.restoredPool]) {
      if (e.timer) clearTimeout(e.timer);
      e.panel.dispose();
    }
    BrowserPanel.restoredPool = [];
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
      if (reveal) existing.panel.reveal(undefined, false); // focus it in its own group, don't move it
      return existing;
    }
    // Adopt a serializer-restored shell if one matches: it's already sitting in its
    // pre-reload editor group, so this also restores the split layout exactly.
    const adopted = BrowserPanel.takeRestored(page.url());
    if (adopted) {
      const bp = new BrowserPanel(context, session, adopted, page, id);
      BrowserPanel.panels.set(id, bp);
      BrowserPanel.claimColumn(adopted.viewColumn);
      return bp;
    }
    // A planned column (tab restore) wins — it recreates the pre-reload split. Otherwise
    // stack new tabs in the column an existing cobrowser panel already occupies, so they
    // group like browser tabs instead of spreading across splits.
    const groupColumn = pickColumn({
      planned: BrowserPanel.plannedColumns.shift(),
      dedicated: BrowserPanel.dedicatedColumn,
      liveColumns: [...BrowserPanel.panels.values()].map((p) => p.panel.viewColumn),
    });
    const panel = vscode.window.createWebviewPanel(
      'cobrowser',
      'Cobrowser',
      { viewColumn: groupColumn ?? vscode.ViewColumn.Beside, preserveFocus: !reveal },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    const bp = new BrowserPanel(context, session, panel, page, id);
    BrowserPanel.panels.set(id, bp);
    BrowserPanel.claimColumn(panel.viewColumn);
    return bp;
  }

  /** Focus a page's panel IN PLACE. Revealing it "Beside" used to relocate the panel into a
   *  new split every time the agent switched tabs — a steady supply of new panes. */
  static reveal(id: string): void {
    BrowserPanel.panels.get(id)?.panel.reveal(undefined, false);
  }

  static closeForId(id: string): void {
    BrowserPanel.panels.get(id)?.panel.dispose();
  }

  static disposeAll(): void {
    for (const p of [...BrowserPanel.panels.values()]) p.panel.dispose();
  }

  private disposables: vscode.Disposable[] = [];
  private cdp: CDPSession | undefined;
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
    this.panel.webview.html = BrowserPanel.renderHtml(this.context);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);

    // Screencast whenever this panel is on screen — including when focus moves
    // to another editor group (a split), so it keeps updating while you work
    // elsewhere. It only stops when actually hidden (another tab selected in its
    // own group), where there would be nothing to show anyway.
    this.panel.onDidChangeViewState(
      () => {
        void this.syncRender();
        // Follow the user: if they move a browser tab to another group, that group becomes
        // the dedicated pane and later tabs open there too.
        BrowserPanel.claimColumn(this.panel.viewColumn);
        BrowserPanel.onLayoutChanged?.(); // panel may have moved groups — persist layout
      },
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

  /** Stream whenever this panel is on screen. Every tab is its own offscreen window in the
   *  app, so every visible panel gets frames at full rate at once; hidden panels get none. */
  private async syncRender(): Promise<void> {
    const shouldStream = this.panel.visible && this.ready;
    if (shouldStream === this.streaming) return;
    this.streaming = shouldStream;
    if (shouldStream) {
      // Becoming visible: make this the agent's current page too, and re-verify the
      // viewport — it may be stale from a failed apply while hidden.
      await this.session.run(() => this.session.focusPage(this.id)).catch(() => undefined);
      this.appliedKey = '';
      void this.panel.webview.postMessage({ type: 'extension.remeasure' });
      this.startStream();
    } else {
      this.stopStream();
    }
  }

  /** A CDP session on the page for trusted input (Input.*) and small page queries. */
  private async ensureCdp(): Promise<CDPSession> {
    if (this.cdp) return this.cdp;
    this.cdp = await this.page.createCDPSession();
    return this.cdp;
  }

  /** Frames come from the app: each paint of the offscreen tab arrives as a JPEG with the
   *  frame's device size, which the webview maps input against. */
  private startStream(): void {
    const tabId = this.session.tabIdOf(this.page);
    if (!tabId || !BrowserPanel.app) return;
    BrowserPanel.app.subscribe(tabId, (f) => {
      void this.panel.webview.postMessage({
        method: 'cobrowser.frame',
        bytes: f.bytes,
        metadata: { deviceWidth: f.metadata.deviceWidth, deviceHeight: f.metadata.deviceHeight },
      });
    });
  }

  private stopStream(): void {
    const tabId = this.session.tabIdOf(this.page);
    if (tabId) BrowserPanel.app?.unsubscribe(tabId);
  }

  /** Size the page to the panel in DEVICE pixels (crisp text on retina), divided by the
   *  per-site zoom (persisted per origin). The app renders exactly that size at scale 1. */
  private async applyViewport(): Promise<void> {
    const { cssW, cssH, dpr } = this.metrics;
    if (cssW < 50 || cssH < 50) return;
    const zoom = this.getZoom();
    let width = Math.max(1, Math.round((cssW * dpr) / zoom));
    let height = Math.max(1, Math.round((cssH * dpr) / zoom));
    // Cap the rendered area: full device pixels keep text crisp, but the cost is quadratic
    // and unbounded. Past the budget, back the effective scale off toward 1x.
    const area = width * height;
    if (area > MAX_RENDER_PX) {
      const s = Math.sqrt(MAX_RENDER_PX / area);
      width = Math.max(1, Math.round(width * s));
      height = Math.max(1, Math.round(height * s));
    }
    void this.panel.webview.postMessage({ type: 'extension.zoomlabel', zoom });
    const key = `${width}x${height}`;
    if (key === this.appliedKey) return;
    try {
      await this.session.run(() => this.session.setViewport(this.page, width, height));
      this.appliedKey = key; // only after success, so a transient failure retries
    } catch {
      this.appliedKey = '';
    }
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
            await this.syncRender();
            void this.panel.webview.postMessage({ type: 'extension.url', url: this.page.url() });
            break;
          case 'extension.contextinfo': {
            // Right-click: report what's under the cursor (selection / link) so the
            // webview can render a context menu — headless Chrome's native menu is
            // browser chrome and doesn't exist in the screencast.
            const p = (m.params ?? {}) as { x?: number; y?: number; clientX?: number; clientY?: number };
            const cdp = await this.ensureCdp();
            const { result } = (await cdp.send('Runtime.evaluate', {
              expression: `(() => {
                const el = document.elementFromPoint(${Number(p.x) || 0}, ${Number(p.y) || 0});
                const a = el && el.closest ? el.closest('a[href]') : null;
                return JSON.stringify({ sel: String(window.getSelection() || ''), link: a ? a.href : null });
              })()`,
              returnByValue: true,
            })) as { result: { value?: string } };
            const info = JSON.parse(result?.value ?? '{}') as { sel?: string; link?: string | null };
            void this.panel.webview.postMessage({
              type: 'extension.contextmenu',
              at: { clientX: p.clientX ?? 0, clientY: p.clientY ?? 0 },
              hasSelection: !!info.sel,
              link: info.link ?? null,
            });
            break;
          }
          case 'extension.copy': {
            // Copy the page's selection to the OS clipboard. The headless browser's own
            // clipboard is sandboxed away from the OS — route through vscode.env.
            const cdp = await this.ensureCdp();
            const { result } = (await cdp.send('Runtime.evaluate', {
              expression: 'String(window.getSelection() || "")',
              returnByValue: true,
            })) as { result: { value?: string } };
            if (result?.value) await vscode.env.clipboard.writeText(result.value);
            break;
          }
          case 'extension.paste': {
            const text = await vscode.env.clipboard.readText();
            if (text) await (await this.ensureCdp()).send('Input.insertText', { text });
            break;
          }
          case 'extension.selectall':
            await (await this.ensureCdp()).send('Runtime.evaluate', {
              expression: 'document.execCommand("selectAll")',
            });
            break;
          case 'extension.openlink': {
            const url = (m.params as { url?: string } | undefined)?.url;
            if (url) {
              await this.session.run(() => this.session.newPage(url).then(() => undefined));
            }
            break;
          }
          case 'extension.copylink': {
            const url = (m.params as { url?: string } | undefined)?.url;
            if (url) await vscode.env.clipboard.writeText(url);
            break;
          }
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

    // CDP passthrough (Input.*). Sent DIRECTLY, not through session.run(): human input must
    // never queue behind a slow agent action (navigate / waitFor) — that head-of-line blocking
    // was the main "laggy" feel. Input events are independent CDP calls, safe to interleave.
    // The session is created on first use: the screencast used to create it as a side
    // effect, and without that every click was silently dropped.
    const cdp = await this.ensureCdp().catch(() => undefined);
    if (!cdp) return;
    try {
      const result = await (cdp.send as (method: string, params?: unknown) => Promise<unknown>)(
        m.type,
        m.params,
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

  /** Full panel HTML. Static so serializer-restored shells can paint before any
   *  BrowserPanel instance exists (instant tabs on reload). */
  static renderHtml(context: vscode.ExtensionContext): string {
    const nonce = getNonce();
    // Inline CSS + JS instead of <link>/<script src>: an external asWebviewUri fetch can race
    // or 404 (e.g. a retained webview still pointing at a pruned old build after an update),
    // which showed up as the occasional fully-unstyled toolbar. Inlining makes each panel
    // self-contained, so it can't render half-loaded. Assets come from the activation-time
    // cache (falls back to a live read if activation didn't prime it).
    if (!BrowserPanel.assetCache) BrowserPanel.primeAssets(context);
    const { css, js: rawJs } = BrowserPanel.assetCache ?? { css: '', js: '' };
    const js = rawJs.replace(/<\/script/gi, '<\\/script');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src ws://127.0.0.1:*; media-src blob: mediastream:;" />
  <style nonce="${nonce}">${css}</style>
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
  <!-- Input binds to the STAGE, not to a render surface: the canvas is display:none in
       WebRTC mode, and listeners on a hidden element receive nothing (that is why input
       died when video engaged). The stage is present in both modes. -->
  <div id="stage" tabindex="0">
    <canvas id="screen"></canvas>
    <video id="video" autoplay muted playsinline hidden></video>
    <div id="highlight" hidden></div>
  </div>
  <script nonce="${nonce}">${js}</script>
</body>
</html>`;
  }

  dispose(): void {
    BrowserPanel.panels.delete(this.id);
    this.stopStream();
    this.page.off('framenavigated', this.onNav);
    this.cdp?.detach().catch(() => undefined);
    // The human closed this editor tab → close the underlying browser page. But during a
    // session teardown (window reload), leave the pages open so browser.close() saves them
    // and --restore-last-session brings them back.
    if (!this.session.isDisposing) {
      void this.session.run(() => this.session.closePage(this.id)).catch(() => undefined);
    }
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

/** Read a bundled asset (CSS/JS) off disk to inline into the webview HTML. */
function readAsset(context: vscode.ExtensionContext, ...segments: string[]): string {
  try {
    return fs.readFileSync(vscode.Uri.joinPath(context.extensionUri, ...segments).fsPath, 'utf8');
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
