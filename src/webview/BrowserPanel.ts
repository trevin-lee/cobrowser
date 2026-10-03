import * as vscode from 'vscode';
import { pickColumn } from './columns';
import * as fs from 'node:fs';
import type { AppPage } from '../browser/AppPage';
import type { BrowserSession, ElementBox } from '../browser/BrowserSession';
import type { AppConnection, ScreenInfo } from '../app/AppClient';
import { DEFAULT_TAB_TITLE_MAX, fullTabTitle, tabLabel } from './tabTitle';
import { resolveAddress } from '../browser/address';

/** Default ceiling on rendered pixels per frame (cobrowser.renderBudgetMegapixels). Measured
 *  on an M4 Pro: the app's JPEG encode holds 24fps at 8.2Mpx (a full-height retina laptop
 *  panel at 2x) and ~30fps at 6.5Mpx, so 6.5 keeps scrolling smooth at ~1.8x there and gives
 *  true 2x on anything smaller. The old 5Mpx cap rendered that panel at 0.78x and stretched
 *  it back up, which is what "not perfectly crisp" was. Raise it for crisp over smooth. */
const DEFAULT_RENDER_BUDGET_PX = 6_500_000;

// Every page is its own offscreen window in the app, so every visible panel gets frames
// at full rate simultaneously — no foreground coordination, no polling for hidden panels.

/**
 * One webview panel per browser page — so each browser tab is a native VS Code
 * editor tab, and VS Code's own tab bar is the tab bar (no custom strip, no
 * double row). The extension opens one of these per page via the session's
 * page-lifecycle events.
 *
 * Each panel paints its page's frames onto a <canvas> and forwards the human's input
 * to the page as DevTools-protocol Input events, relayed through the app to the tab's own
 * debugger. A panel streams only while it is on screen; hidden panels stop and freeze on
 * their last frame.
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
  /** Device pixels per CSS px to render at (cobrowser.renderScale). 2 is native on a retina
   *  display and a 2x supersample on a 1x one; the area cap above may pull it down. */
  static renderScale = 2;
  /** Pixel budget per frame; see DEFAULT_RENDER_BUDGET_PX. */
  static renderBudgetPx = DEFAULT_RENDER_BUDGET_PX;
  /** Longest tab title, in characters (cobrowser.tabTitleMaxLength); 0 = no limit. */
  static tabTitleMax = DEFAULT_TAB_TITLE_MAX;
  /** The panel that is the active editor, for the keyboard-shortcut commands. */
  static active: BrowserPanel | undefined;

  /** The app's id for this panel's tab. */
  get tabId(): string {
    return this.page.tabId;
  }

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
    page: AppPage,
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

  /** Re-apply every panel's viewport (a render setting changed). */
  static remeasureAll(): void {
    for (const p of BrowserPanel.panels.values()) {
      p.appliedKey = '';
      void p.applyViewport();
    }
  }

  /** Re-read every panel's title from its page (titles change without a navigation). */
  /** The cobrowser.accentColor setting: the agent's highlight in every panel. */
  static accent = '#2b5bff';
  static setAccent(color: string): void {
    BrowserPanel.accent = color;
    for (const p of BrowserPanel.panels.values()) void p.panel.webview.postMessage({ type: 'extension.accent', color });
  }

  static refreshTitles(): void {
    for (const p of BrowserPanel.panels.values()) p.updateTitle();
  }

  static closeForId(id: string): void {
    BrowserPanel.panels.get(id)?.panel.dispose();
  }

  static disposeAll(): void {
    for (const p of [...BrowserPanel.panels.values()]) p.panel.dispose();
  }

  private disposables: vscode.Disposable[] = [];
  private ready = false;
  private metrics: { cssW: number; cssH: number; dpr: number; screen?: ScreenInfo } = { cssW: 0, cssH: 0, dpr: 1 };
  private origin = '';
  private appliedKey = '';
  private streaming = false;

  private constructor(
    private context: vscode.ExtensionContext,
    private session: BrowserSession,
    private panel: vscode.WebviewPanel,
    private page: AppPage,
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
    if (panel.active) BrowserPanel.active = this;
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.active) BrowserPanel.active = this;
        else if (BrowserPanel.active === this) BrowserPanel.active = undefined;
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
    this.page.onNavigated(this.onNav);
    this.page.onFullscreen(this.onFullscreen);

    this.updateTitle();
  }

  private onFullscreen = (on: boolean): void => {
    void this.panel.webview.postMessage({ type: 'extension.fullscreen', on });
  };

  private onNav = (): void => {
    this.origin = hostOf(this.page.url());
    void this.panel.webview.postMessage({ type: 'extension.url', url: this.page.url() });
    this.updateTitle();
    void this.applyViewport(); // apply this origin's remembered zoom
  };

  /** The page's whole title, last sent to the webview (its address bar shows it on hover). */
  private fullTitle = '';

  /** Called on navigation and by the extension whenever the tab set changes (titles). The
   *  tab shows the title cut like a browser tab's; the address bar's tooltip has all of it. */
  updateTitle(): void {
    const label = tabLabel(this.page.title(), this.page.url(), BrowserPanel.tabTitleMax);
    if (this.panel.title !== label) this.panel.title = label;
    const full = fullTabTitle(this.page.title(), this.page.url());
    if (full !== this.fullTitle) {
      this.fullTitle = full;
      void this.panel.webview.postMessage({ type: 'extension.title', title: full });
    }
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
      await this.session.run(() => this.session.focusPage(this.id), this.id).catch(() => undefined);
      this.appliedKey = '';
      void this.panel.webview.postMessage({ type: 'extension.remeasure' });
      this.startStream();
    } else {
      this.stopStream();
    }
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
        metadata: f.metadata,
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
    const { cssW, cssH, screen } = this.metrics;
    if (cssW < 50 || cssH < 50) return;
    const zoom = this.getZoom();
    // Render at renderScale device pixels per CSS px — native crispness on retina, a
    // supersample on a 1x display — backed off only if the frame would exceed the budget.
    let scale = Math.max(1, BrowserPanel.renderScale);
    const area = cssW * cssH * scale * scale;
    if (area > BrowserPanel.renderBudgetPx) scale = Math.max(1, Math.sqrt(BrowserPanel.renderBudgetPx / (cssW * cssH)));
    scale = Math.round(scale * 100) / 100;
    void this.panel.webview.postMessage({ type: 'extension.zoomlabel', zoom });
    const key = `${cssW}x${cssH}@${scale}z${zoom}#${screen?.width ?? 0}x${screen?.height ?? 0}`;
    if (key === this.appliedKey) return;
    try {
      await this.session.run(() => this.session.setViewport(this.page, cssW, cssH, scale, zoom, screen), this.id);
      this.appliedKey = key; // only after success, so a transient failure retries
    } catch {
      this.appliedKey = '';
    }
  }

  /** Keyboard-shortcut commands act on the active panel. */
  async navigate(kind: 'back' | 'forward' | 'reload'): Promise<void> {
    const go = kind === 'back' ? () => this.page.goBack() : kind === 'forward' ? () => this.page.goForward() : () => this.page.reload();
    await this.session.run(() => go().then(() => undefined).catch(() => undefined), this.id).catch(() => undefined);
  }

  close(): void {
    this.panel.dispose();
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
            void this.panel.webview.postMessage({ type: 'extension.title', title: this.fullTitle });
            break;
          case 'extension.contextinfo': {
            // Right-click: report what's under the cursor (selection / link) so the
            // webview can render a context menu — headless Chrome's native menu is
            // browser chrome and doesn't exist in the screencast.
            const p = (m.params ?? {}) as { x?: number; y?: number; clientX?: number; clientY?: number };
            const { result } = await this.page.cdp<{ result: { value?: string } }>('Runtime.evaluate', {
              expression: `(() => {
                const el = document.elementFromPoint(${Number(p.x) || 0}, ${Number(p.y) || 0});
                const a = el && el.closest ? el.closest('a[href]') : null;
                return JSON.stringify({ sel: String(window.getSelection() || ''), link: a ? a.href : null });
              })()`,
              returnByValue: true,
            });
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
            const { result } = await this.page.cdp<{ result: { value?: string } }>('Runtime.evaluate', {
              expression: 'String(window.getSelection() || "")',
              returnByValue: true,
            });
            if (result?.value) await vscode.env.clipboard.writeText(result.value);
            break;
          }
          case 'extension.paste': {
            const text = await vscode.env.clipboard.readText();
            if (text) await this.page.cdp('Input.insertText', { text });
            break;
          }
          case 'extension.selectall':
            await this.page.cdp('Runtime.evaluate', { expression: 'document.execCommand("selectAll")' });
            break;
          case 'extension.openlink': {
            const url = (m.params as { url?: string } | undefined)?.url;
            if (url) {
              // The human's own "open link in new tab": theirs, and the agent stays put.
              await this.session.run(() => this.session.newPage(url, { byAgent: false }).then(() => undefined), this.id);
            }
            break;
          }
          case 'extension.copylink': {
            const url = (m.params as { url?: string } | undefined)?.url;
            if (url) await vscode.env.clipboard.writeText(url);
            break;
          }
          case 'extension.viewport': {
            const p = (m.params ?? {}) as { cssW?: number; cssH?: number; dpr?: number; screen?: ScreenInfo };
            if (p.cssW && p.cssH) {
              this.metrics = { cssW: p.cssW, cssH: p.cssH, dpr: p.dpr ?? 1, screen: p.screen };
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
            await this.navigate('back');
            break;
          case 'extension.forward':
            await this.navigate('forward');
            break;
          case 'extension.reload':
            await this.navigate('reload');
            break;
          case 'extension.navigate': {
            const p = (m.params ?? {}) as { url?: string };
            // What was typed: an address, or a search. A failure shows the app's error page.
            const url = p.url ? resolveAddress(p.url) : '';
            if (url) await this.session.run(() => this.page.goto(url).then(() => undefined), this.id);
            break;
          }
        }
      } catch {
        /* transient (page navigating/closed) — recovers on the next event */
      }
      return;
    }

    // Protocol passthrough (Input.*). Sent DIRECTLY, not through session.run(): human input
    // must never queue behind a slow agent action (navigate / waitFor) — that head-of-line
    // blocking was the main "laggy" feel. Input events are independent calls, safe to interleave.
    if (!/^Input\./.test(m.type)) return; // the webview drives input only
    try {
      const result = await this.page.humanInput(m.type, m.params);
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <style nonce="${nonce}">${css}</style>
  <title>Cobrowser</title>
</head>
<body style="--cobrowser-agent: ${BrowserPanel.accent}">
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
  <!-- Input binds to the STAGE, which holds the canvas and the highlight. -->
  <div id="stage" tabindex="0">
    <canvas id="screen"></canvas>
    <div id="highlight" hidden></div>
  </div>
  <script nonce="${nonce}">${js}</script>
</body>
</html>`;
  }

  dispose(): void {
    BrowserPanel.panels.delete(this.id);
    this.stopStream();
    this.page.offNavigated(this.onNav);
    this.page.offFullscreen(this.onFullscreen);
    // The human closed this editor tab → close the underlying browser page. But during a
    // session teardown (window reload), leave the pages open in the app so the reconnect
    // finds them again.
    if (!this.session.isDisposing) {
      void this.session.run(() => this.session.closePage(this.id), this.id).catch(() => undefined);
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
