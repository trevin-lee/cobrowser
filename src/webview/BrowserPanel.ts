import * as vscode from 'vscode';
import * as fs from 'node:fs';
import type { CDPSession, Page } from 'puppeteer-core';
import type { BrowserSession, ElementBox } from '../browser/BrowserSession';

interface FrameEvent {
  data: string;
  sessionId: number;
  metadata: unknown;
}

// Adaptive frame intervals for background-but-visible panels (captureScreenshot poll).
// Paced at 60Hz while the page is changing; the capture itself is the real throttle
// (measured ~36fps at full-retina 2400x1500, faster at smaller panels — the JPEG
// encode pipe, not this timer, is the ceiling). Backs off to ~4fps once frames repeat
// so a static page costs almost nothing; identical frames are never posted. Only
// VISIBLE non-foreground panels poll, so cost scales with on-screen tabs, not total.
const POLL_FAST_MS = 16;
const POLL_SLOW_MS = 250;
const POLL_IDLE_AFTER = 5; // consecutive identical frames before backing off

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

  /** Headless Chrome composites only ONE page at a time, so exactly one panel may
   *  stream. This is that panel's id — set to whichever the user last focused. It
   *  survives focusing a non-webview editor, so a lone visible panel keeps streaming
   *  while you work elsewhere, yet two visible panels can never both bringToFront. */
  private static foregroundId: string | undefined;

  /** Re-evaluate every panel's render mode after the foreground changes. */
  private static syncAll(): void {
    for (const p of BrowserPanel.panels.values()) void p.syncRender();
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
    // Stack new tabs in the column an existing cobrowser panel already occupies, so they group
    // like browser tabs (one visible at a time) instead of spreading across splits — two
    // simultaneously-visible panels would fight over Chrome's single foreground page.
    const groupColumn = [...BrowserPanel.panels.values()]
      .map((p) => p.panel.viewColumn)
      .find((c) => c != null);
    const panel = vscode.window.createWebviewPanel(
      'cobrowser',
      'Cobrowser',
      { viewColumn: groupColumn ?? vscode.ViewColumn.Beside, preserveFocus: !reveal },
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
  /** 'screencast' = foreground push stream; 'poll' = background captureScreenshot loop
   *  (renders without being Chrome's foreground, so split tabs stay live); 'off' = hidden. */
  private renderMode: 'off' | 'screencast' | 'poll' = 'off';
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private vpW = 0;
  private vpH = 0;

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

    // Screencast whenever this panel is on screen — including when focus moves
    // to another editor group (a split), so it keeps updating while you work
    // elsewhere. It only stops when actually hidden (another tab selected in its
    // own group), where there would be nothing to show anyway.
    this.panel.onDidChangeViewState(
      () => {
        // Focusing a panel makes it the sole foreground streamer; re-sync all so the
        // previously-streaming one stops (only one page can composite at a time).
        if (this.panel.active) BrowserPanel.foregroundId = this.id;
        BrowserPanel.syncAll();
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

  /** Start/stop the screencast to match whether this tab is on screen.
   *  Gated on `visible` (shown anywhere), not `active` (focused), so switching
   *  to another editor tab in a split doesn't freeze it. `streaming` is set
   *  up-front so a re-entrant view-state change (e.g. from bringing the page to
   *  the front) no-ops instead of looping. */
  /** Match this panel's render mode to its state: the single foreground panel gets the
   *  efficient push screencast; any OTHER visible panel gets a captureScreenshot poll (pull
   *  rendering ignores foreground, so split tabs all stay live); hidden panels render nothing. */
  private async syncRender(): Promise<void> {
    const desired: 'off' | 'screencast' | 'poll' =
      !this.panel.visible || !this.ready
        ? 'off'
        : BrowserPanel.foregroundId === this.id
          ? 'screencast'
          : 'poll';
    if (desired === this.renderMode) return;
    // Tear down the previous mode before starting the next.
    if (this.renderMode === 'screencast') await this.stopScreencast();
    else if (this.renderMode === 'poll') this.stopPoll();
    this.renderMode = desired;
    if (desired === 'screencast') {
      // Bring this page to the front so its compositor pushes frames (screencast is
      // foreground-only); no other panel is foreground, so nothing fights it back.
      await this.session.run(() => this.session.focusPage(this.id)).catch(() => undefined);
      // The page viewport may be stale from a failed apply or a relaunch while this tab
      // was hidden — ask the webview to re-push its size (drops both dedupe keys so the
      // re-apply actually runs). Fixes the "stretched until you resize" tab switch.
      this.appliedKey = '';
      void this.panel.webview.postMessage({ type: 'extension.remeasure' });
      await this.startScreencast();
    } else if (desired === 'poll') {
      this.startPoll();
    }
  }

  /** Background-but-visible view: pull a fresh frame with captureScreenshot on a timer.
   *  Unlike the screencast, this renders a page that isn't Chrome's foreground, so split
   *  tabs stay live. Reuses the screencastFrame message path so the webview draws it the
   *  same way. */
  private lastPollFrame = '';
  private pollIdleCount = 0;

  private startPoll(): void {
    if (this.pollTimer) return;
    this.lastPollFrame = ''; // always paint the first frame on (re)entry
    this.pollIdleCount = 0;
    const loop = async (): Promise<void> => {
      if (this.renderMode !== 'poll') return;
      let delay = POLL_FAST_MS;
      try {
        const cdp = await this.ensureCdp();
        const { data } = (await cdp.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 60, // secondary view — a touch lower than the foreground stream
        })) as { data: string };
        if (this.renderMode !== 'poll') return; // mode changed mid-capture
        if (data === this.lastPollFrame) {
          // Page is static — don't re-send identical pixels, and back off the rate.
          this.pollIdleCount++;
          if (this.pollIdleCount >= POLL_IDLE_AFTER) delay = POLL_SLOW_MS;
        } else {
          this.pollIdleCount = 0;
          this.lastPollFrame = data;
          void this.panel.webview.postMessage({
            method: 'Page.screencastFrame',
            result: { data, metadata: { deviceWidth: this.vpW, deviceHeight: this.vpH } },
          });
        }
      } catch {
        delay = POLL_SLOW_MS; // page navigating/closed — retry gently
      }
      this.pollTimer = setTimeout(() => void loop(), delay);
    };
    this.pollTimer = setTimeout(() => void loop(), 0);
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
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
        // q70 keeps text crisp but cuts ~35% off every frame vs q90 (457KB -> 295KB at a
        // retina panel) — a big saving over the postMessage bridge at 30-60fps.
        quality: 70,
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
    try {
      await this.session.run(() => this.session.setViewport(this.page, width, height, 1));
      // Mark applied only AFTER success. Setting it up-front meant a transient failure
      // (page mid-navigation, session churn) left the page stuck on the 1280x800 launch
      // default — stretched to the panel — until a manual resize changed the key.
      this.appliedKey = key;
      this.vpW = width;
      this.vpH = height;
    } catch {
      this.appliedKey = ''; // retry on the next viewport push / remeasure
      return;
    }
    if (this.renderMode === 'screencast') await this.startScreencast();
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
            // Claim foreground if this panel is focused, or if nothing else holds it yet
            // (e.g. the first tab, so something streams immediately).
            if (this.panel.active || BrowserPanel.foregroundId === undefined) {
              BrowserPanel.foregroundId = this.id;
            }
            BrowserPanel.syncAll();
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

    // CDP passthrough (Input.*). Sent DIRECTLY, not through session.run(): human input must
    // never queue behind a slow agent action (navigate / waitFor) — that head-of-line blocking
    // was the main "laggy" feel. Input events are independent CDP calls, safe to interleave.
    const cdp = this.cdp;
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

  private html(): string {
    const nonce = getNonce();
    // Inline CSS + JS instead of <link>/<script src>: an external asWebviewUri fetch can race
    // or 404 (e.g. a retained webview still pointing at a pruned old build after an update),
    // which showed up as the occasional fully-unstyled toolbar. Inlining makes each panel
    // self-contained, so it can't render half-loaded. Assets come from the activation-time
    // cache (falls back to a live read if activation didn't prime it).
    if (!BrowserPanel.assetCache) BrowserPanel.primeAssets(this.context);
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
  <script nonce="${nonce}">${js}</script>
</body>
</html>`;
  }

  dispose(): void {
    BrowserPanel.panels.delete(this.id);
    this.stopPoll();
    // If the foreground tab is closing, release the slot so the next-focused panel can claim
    // it (VS Code focuses an adjacent tab on close, which re-syncs via onDidChangeViewState).
    if (BrowserPanel.foregroundId === this.id) {
      BrowserPanel.foregroundId = undefined;
      BrowserPanel.syncAll();
    }
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
