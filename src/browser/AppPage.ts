import type { AppConnection, NavigateKind, NavigateResult } from '../app/AppClient';

/**
 * One tab of the app, as the editor sees it: a stable id, the URL and title the app last
 * reported, and a line to the tab's DevTools-protocol session. Replaces what puppeteer's
 * Page used to be — without a browser-level connection, and without anything the page's
 * own scripts can see.
 */
export class AppPage {
  private navListeners = new Set<() => void>();
  private _closed = false;

  constructor(
    /** The session's stable id, minted per page ("1", "2", …). Panels and tools use this. */
    readonly id: string,
    /** The app's id for the tab — what frames, resizes, closes and commands are addressed by. */
    readonly tabId: string,
    private readonly app: AppConnection,
    private _url: string,
    private _title: string,
  ) {}

  url(): string {
    return this._url;
  }

  /** The title the app last reported. Pages that have not set one yield ''. */
  title(): string {
    return this._title;
  }

  isClosed(): boolean {
    return this._closed;
  }

  /** The app reported a navigation or a title change. */
  update(url: string, title: string, navigated: boolean): void {
    this._url = url;
    this._title = title;
    if (navigated) for (const cb of this.navListeners) cb();
  }

  markClosed(): void {
    this._closed = true;
  }

  onNavigated(cb: () => void): void {
    this.navListeners.add(cb);
  }

  offNavigated(cb: () => void): void {
    this.navListeners.delete(cb);
  }

  /** A DevTools-protocol command on this tab. */
  cdp<T = Record<string, unknown>>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    return this.app.cdp<T>(this.tabId, method, params, timeoutMs);
  }

  /**
   * Run a function in the page and return its JSON result. `fn` is a function (its source
   * is shipped) or a function expression as text; `args` must be JSON-serialisable. Runs in
   * the page's main world, so the page's own globals are visible.
   */
  async evaluate<T = unknown>(fn: string | ((...a: never[]) => unknown), ...args: unknown[]): Promise<T> {
    const src = typeof fn === 'string' ? fn : fn.toString();
    const expression = `(${src})(...${JSON.stringify(args)})`;
    const r = await this.cdp<{ result: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluate failed');
    }
    return r.result.value as T;
  }

  /** Navigate and wait for the new document's DOM. Throws on a load error or timeout. */
  async goto(url: string, timeout = 30000): Promise<NavigateResult> {
    const r = await this.navigate('url', url, timeout);
    if (r.error) throw new Error(`navigation to ${url} failed: ${r.error}`);
    if (r.timedOut) throw new Error(`navigation to ${url} did not finish loading within ${timeout}ms (now at ${r.url})`);
    return r;
  }

  goBack(timeout?: number): Promise<NavigateResult> {
    return this.navigate('back', undefined, timeout);
  }

  goForward(timeout?: number): Promise<NavigateResult> {
    return this.navigate('forward', undefined, timeout);
  }

  reload(timeout?: number): Promise<NavigateResult> {
    return this.navigate('reload', undefined, timeout);
  }

  private async navigate(kind: NavigateKind, url?: string, timeout = 30000): Promise<NavigateResult> {
    const r = await this.app.navigate(this.tabId, kind, url, timeout);
    this._url = r.url;
    this._title = r.title;
    return r;
  }
}
