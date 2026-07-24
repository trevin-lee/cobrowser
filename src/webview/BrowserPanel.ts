import * as vscode from 'vscode';
import type { CDPSession } from 'puppeteer-core';
import type { BrowserSession } from '../browser/BrowserSession';

interface FrameEvent {
  data: string;
  sessionId: number;
  metadata: unknown;
}

/**
 * Host side of the co-drive webview. Streams CDP screencast frames down to a <canvas>
 * and forwards the user's input (mouse/keyboard/wheel) + CDP passthrough commands back
 * up — all serialized through `session.run()`. Re-attaches the screencast whenever the
 * active page changes (H6), so switching tabs / popups doesn't freeze the canvas.
 */
export class BrowserPanel {
  private static current: BrowserPanel | undefined;

  static show(context: vscode.ExtensionContext, session: BrowserSession): BrowserPanel {
    if (BrowserPanel.current) {
      BrowserPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return BrowserPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('cobrowser', 'Cobrowser', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'dist'),
        vscode.Uri.joinPath(context.extensionUri, 'media'),
      ],
    });
    BrowserPanel.current = new BrowserPanel(context, session, panel);
    return BrowserPanel.current;
  }

  private disposables: vscode.Disposable[] = [];
  private cdp: CDPSession | undefined;
  private frameHandler: ((e: FrameEvent) => void) | undefined;

  private constructor(
    private context: vscode.ExtensionContext,
    private session: BrowserSession,
    private panel: vscode.WebviewPanel,
  ) {
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);
    // Fires immediately with the current CDP session, then on every active-page change.
    this.session.onActivePageChanged((cdp) => void this.attach(cdp));
  }

  private async attach(cdp: CDPSession): Promise<void> {
    // Detach from the previous page's session.
    if (this.cdp && this.frameHandler) {
      try {
        this.cdp.off('Page.screencastFrame', this.frameHandler as never);
        await this.cdp.send('Page.stopScreencast');
      } catch {
        /* previous session already gone */
      }
    }
    this.cdp = cdp;
    this.frameHandler = (e: FrameEvent) => {
      this.panel.webview.postMessage({
        method: 'Page.screencastFrame',
        result: { data: e.data, metadata: e.metadata },
      });
      cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => undefined);
    };
    cdp.on('Page.screencastFrame', this.frameHandler as never);
    try {
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        maxWidth: 2048,
        maxHeight: 2048,
        everyNthFrame: 1,
      });
    } catch {
      /* page may be navigating; next active-page change re-attaches */
    }
  }

  private async onMessage(m: {
    type: string;
    params?: Record<string, unknown>;
    callbackId?: number;
  }): Promise<void> {
    if (typeof m?.type !== 'string') return;

    if (m.type.startsWith('extension.')) {
      if (m.type === 'extension.openNativeWindow') {
        if (this.session.headless) {
          void vscode.window.showInformationMessage(
            'Cobrowser is running headless (embedded only). Set "cobrowser.headless" to false and reload to use a separate OS window.',
          );
        } else {
          await this.session.run(() => this.session.bringActiveToFront());
        }
      }
      return;
    }

    // CDP passthrough (Input.*, Page.navigate, …), serialized via the session queue.
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
    <input id="url" placeholder="Enter a URL and press Enter…" />
    <button id="go">Go</button>
    <button id="native" class="secondary" title="Interact with the real OS window (native dropdowns, file pickers, 2FA)">Open native window</button>
  </div>
  <div id="stage"><canvas id="screen" tabindex="0"></canvas></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    BrowserPanel.current = undefined;
    if (this.cdp && this.frameHandler) {
      try {
        this.cdp.off('Page.screencastFrame', this.frameHandler as never);
        this.cdp.send('Page.stopScreencast').catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
