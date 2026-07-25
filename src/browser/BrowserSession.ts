import * as puppeteer from 'puppeteer-core';
import type { Browser, Page, ElementHandle } from 'puppeteer-core';
import { resolveLaunchOptions } from './launchFlags';
import { snapshotScript } from './snapshot';

export interface PageInfo {
  index: number;
  pageId: string;
  url: string;
  title: string;
  selected: boolean;
}

/** Viewport-relative box of an element the agent just acted on, in CSS px. */
export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type InputOwner = 'human' | 'agent' | null;

/** Fired when a page appears (launch/agent/site popup). `reveal` is false for
 *  agent background tabs, which should open a panel without stealing focus. */
type PageOpenedListener = (page: Page, id: string, reveal: boolean) => void;
type PageClosedListener = (id: string) => void;

/**
 * The single owner of the Chromium instance. BOTH drivers — the MCP tool handlers
 * (agent) and the webview panel (human) — funnel every action through `run()`, a FIFO
 * queue that serializes access to the one browser so their inputs never interleave
 * mid-action.
 */
export class BrowserSession {
  private active!: Page;
  private queue: Promise<unknown> = Promise.resolve();

  /** Stable per-page id, so panels and the agent can refer to a tab across
   *  opens/closes (indices shift; these don't). */
  private ids = new Map<Page, string>();
  private idSeq = 0;

  /** Soft advisory flag; the FIFO queue is the real serialization mechanism. */
  inputOwner: InputOwner = null;

  /** >0 while newPage() is opening a target, so targetcreated doesn't also
   *  emit/adopt it — newPage handles its own open with the right reveal flag. */
  private suppressOpen = 0;
  private disposing = false;
  private onDisconnectedCb?: () => void;
  private pageOpenedCb?: PageOpenedListener;
  private pageClosedCb?: PageClosedListener;
  private pageRevealCb?: (id: string) => void;
  private pagesChangedCb?: () => void;
  private highlightCb?: (id: string, box: ElementBox) => void;

  private constructor(
    private browser: Browser,
    readonly headless: boolean,
  ) {}

  static async launch(
    profileDir: string,
    chromePath: string,
    headless = true,
  ): Promise<BrowserSession> {
    const browser = await puppeteer.launch(resolveLaunchOptions(profileDir, chromePath, headless));
    const session = new BrowserSession(browser, headless);

    const pages = await browser.pages();
    // Prefer a real restored tab over puppeteer's stray about:blank.
    const first = pages.find((p) => !p.url().startsWith('about:')) ?? pages[0] ?? (await browser.newPage());
    await session.setActive(first);

    // A genuinely site-opened popup/new tab becomes active and gets its own
    // revealed panel. Our own newPage() sets suppressOpen so it isn't
    // double-handled — it emits its open with the correct reveal flag itself.
    // Serialized through run() so it can't race the agent's snapshot→act sequence.
    browser.on('targetcreated', (target) => {
      if (session.suppressOpen > 0) return;
      void (async () => {
        try {
          const page = await target.page();
          if (!page) return; // not a page target
          const id = session.idFor(page);
          // Open a panel for the human, but do NOT steal the agent's active page — a
          // site popup/new tab must never silently change which page tools act on.
          session.pageOpenedCb?.(page, id, false);
          session.pagesChangedCb?.();
        } catch {
          /* not a page target */
        }
      })();
    });

    // A closed tab disposes its panel; if it was the agent's active page, fall
    // back to another open page so tools keep a live target.
    browser.on('targetdestroyed', () => {
      if (session.disposing) return; // intentional teardown does its own cleanup
      void (async () => {
        try {
          for (const [page, id] of session.ids) {
            if (page.isClosed()) {
              session.ids.delete(page);
              session.pageClosedCb?.(id);
            }
          }
          session.pagesChangedCb?.();
          const open = (await browser.pages()).filter((p) => !p.isClosed());
          if (open.length === 0) {
            // Last tab closed → quit the whole Chrome instance (onDisconnected then
            // clears the session, so the next new tab relaunches a fresh browser).
            session.disposing = true;
            await browser.close().catch(() => undefined);
            return;
          }
          if (!session.active || session.active.isClosed()) {
            await session.run(() => session.setActive(open[0]));
          }
        } catch {
          /* ignore */
        }
      })();
    });

    // Surface out-of-band exit (human Cmd-Q / crash) so the extension drops the dead
    // session and relaunches on next use.
    browser.on('disconnected', () => session.onDisconnectedCb?.());

    return session;
  }

  pid(): number | undefined {
    return this.browser.process()?.pid ?? undefined;
  }

  /** Set the agent's active page (the target for tools without an explicit
   *  page). Brings it to the front: only one page composites at a time, so this
   *  is what lets that page's panel screencast live frames. */
  private async setActive(page: Page): Promise<void> {
    if (this.active === page) return;
    this.active = page;
    await page.bringToFront().catch(() => undefined);
    this.pagesChangedCb?.(); // selection moved — refresh the sidebar's active dot
  }

  /** Stable id for a page, minted on first sight. Also wires the one-time
   *  per-page navigation listener that keeps the sidebar's titles/urls fresh. */
  private idFor(page: Page): string {
    let id = this.ids.get(page);
    if (!id) {
      id = String(++this.idSeq);
      this.ids.set(page, id);
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) this.pagesChangedCb?.();
      });
    }
    return id;
  }

  private pageById(id: string): Page | undefined {
    for (const [page, pid] of this.ids) if (pid === id && !page.isClosed()) return page;
    return undefined;
  }

  /** Fired when the underlying browser exits out-of-band (Cmd-Q / crash). */
  onDisconnected(cb: () => void): void {
    this.onDisconnectedCb = cb;
  }

  /** Fired for every page that appears — the extension opens one panel per page. */
  onPageOpened(cb: PageOpenedListener): void {
    this.pageOpenedCb = cb;
  }

  /** Fired when a page closes — the extension disposes its panel. */
  onPageClosed(cb: PageClosedListener): void {
    this.pageClosedCb = cb;
  }

  /** Fired when the agent focuses an existing page (selectPage), so the
   *  extension can reveal that page's panel and the human follows along. */
  onPageReveal(cb: (id: string) => void): void {
    this.pageRevealCb = cb;
  }

  /** Fired when the tab set changes (open/close/navigate/activate) — the sidebar
   *  re-reads listPages() itself, so this carries no payload. */
  onPagesChanged(cb: () => void): void {
    this.pagesChangedCb = cb;
  }

  /** Emit onPageOpened for every page that already exists (the initial tab, or a
   *  restored session), so the extension builds their panels on activation. */
  emitExisting(): void {
    void (async () => {
      for (const page of await this.browser.pages()) {
        if (!page.isClosed()) this.pageOpenedCb?.(page, this.idFor(page), page === this.active);
      }
    })();
  }

  /** Fired with the id + box of an element the AGENT just acted on
   *  (click/fill/etc.), so the human can see where the agent is working. Human
   *  input never routes through the uid path, so this is agent-only. */
  onAgentHighlight(cb: (id: string, box: ElementBox) => void): void {
    this.highlightCb = cb;
  }

  /** Match a page's viewport to its panel (size + display DPR) so the screencast
   *  isn't stretched to the wrong aspect ratio or rendered below the display's
   *  resolution. Per-page now: each panel sizes its own page. */
  async setViewport(
    page: Page,
    width: number,
    height: number,
    deviceScaleFactor: number,
  ): Promise<void> {
    if (width < 1 || height < 1) return;
    await page.setViewport({ width, height, deviceScaleFactor: deviceScaleFactor || 1 });
  }

  get activePage(): Page {
    return this.active;
  }

  /** Serialize every browser action (agent + human) through one FIFO queue. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    // Keep the chain alive but swallow settled state so one failure can't poison the queue.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ----- tool-facing operations (uid model mirrors chrome-devtools-mcp naming) -----

  async listPages(): Promise<PageInfo[]> {
    const pages = await this.browser.pages();
    const infos: PageInfo[] = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      infos.push({
        index: i,
        pageId: this.idFor(p),
        url: p.url(),
        title: await p.title().catch(() => ''),
        selected: p === this.active,
      });
    }
    return infos;
  }

  async newPage(url?: string, opts?: { background?: boolean }): Promise<PageInfo> {
    // We open this page ourselves, so suppress the generic targetcreated handler
    // and emit the open here with the right reveal flag (background = no reveal).
    const page = await (async (): Promise<Page> => {
      this.suppressOpen++;
      try {
        const p = await this.browser.newPage();
        if (url) await p.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
        return p;
      } finally {
        this.suppressOpen--;
      }
    })();
    if (!opts?.background) await this.setActive(page);
    const id = this.idFor(page);
    this.pageOpenedCb?.(page, id, !opts?.background);
    this.pagesChangedCb?.();
    const pages = await this.browser.pages();
    return {
      index: pages.indexOf(page),
      pageId: id,
      url: page.url(),
      title: await page.title().catch(() => ''),
      selected: page === this.active,
    };
  }

  async selectPage(pageId: string, bringToFront = true): Promise<void> {
    const page = this.pageById(pageId);
    if (!page) throw new Error(`No page with id ${pageId}`);
    await this.setActive(page);
    if (bringToFront) await page.bringToFront();
    this.pageRevealCb?.(pageId); // reveal its VS Code tab so the human follows
  }

  /** The human focused a page's panel: make it the agent's active page (and
   *  bring it to the front to composite), WITHOUT re-revealing — the panel is
   *  already the active editor tab, so firing the reveal path would recurse. */
  async focusPage(pageId: string): Promise<void> {
    // The human focused a panel — bring that page to the front so its screencast
    // composites, but DON'T change the agent's active target (that only moves via
    // new_page/select_page), so human viewing can't drift agent tool calls.
    const page = this.pageById(pageId);
    if (page) await page.bringToFront().catch(() => undefined);
  }

  /** Close a tab. Refuses to close the last one (would leave no active page);
   *  the targetdestroyed handler disposes its panel + picks a fallback. */
  async closePage(pageId: string): Promise<void> {
    // Close the underlying Chrome page. If it was the last one, the targetdestroyed
    // handler quits the whole Chrome instance so nothing is orphaned.
    const page = this.pageById(pageId);
    if (page) await page.close().catch(() => undefined);
  }

  async navigate(
    type: 'url' | 'back' | 'forward' | 'reload',
    url?: string,
    timeout = 30000,
  ): Promise<void> {
    const p = this.active;
    if (type === 'url') {
      if (!url) throw new Error('navigate: url is required for type "url"');
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout });
    } else if (type === 'back') {
      await p.goBack({ timeout }).catch(() => undefined);
    } else if (type === 'forward') {
      await p.goForward({ timeout }).catch(() => undefined);
    } else {
      await p.reload({ waitUntil: 'domcontentloaded', timeout });
    }
  }

  async takeSnapshot(): Promise<string> {
    return (await this.active.evaluate(snapshotScript)) as string;
  }

  private async resolveUid(uid: string): Promise<ElementHandle<Element>> {
    const handle = await this.active.$(`[data-cobrowser-uid="${cssEscape(uid)}"]`);
    if (!handle) {
      throw new Error(
        `uid ${uid} not found — uids expire on any DOM change; call take_snapshot again first.`,
      );
    }
    return handle;
  }

  /** Flash the element in the human's panel so they can see what the agent
   *  touched. Best-effort — a vanished element just skips the highlight. */
  private async emitHighlight(el: ElementHandle<Element>): Promise<void> {
    if (!this.highlightCb) return;
    try {
      const box = await el.evaluate((node) => {
        const r = (node as Element).getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      // Route to the panel for the page the agent acted on (its active page).
      if (box && box.width > 0 && box.height > 0) {
        this.highlightCb(this.idFor(this.active), box);
      }
    } catch {
      /* element detached between action and measure */
    }
  }

  async click(uid: string, dblClick = false): Promise<void> {
    const el = await this.resolveUid(uid);
    try {
      await el.scrollIntoView().catch(() => undefined);
      await this.emitHighlight(el); // measure after scroll, so the box is on-screen
      await el.click(dblClick ? { clickCount: 2 } : {});
    } finally {
      await el.dispose();
    }
  }

  async fill(uid: string, value: string): Promise<void> {
    const el = await this.resolveUid(uid);
    try {
      await el.scrollIntoView().catch(() => undefined);
      await this.emitHighlight(el);
      await el.click({ clickCount: 3 }).catch(() => undefined); // select existing content
      await el.evaluate((node) => {
        const input = node as HTMLInputElement;
        if ('value' in input) input.value = '';
      });
      await el.type(value);
    } finally {
      await el.dispose();
    }
  }

  async fillForm(elements: { uid: string; value: string }[]): Promise<void> {
    for (const e of elements) await this.fill(e.uid, e.value);
  }

  async typeText(text: string, submitKey = false): Promise<void> {
    await this.active.keyboard.type(text);
    if (submitKey) await this.active.keyboard.press('Enter');
  }

  async waitFor(texts: string[], timeout = 15000): Promise<void> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const body = await this.active
        .evaluate(() => document.body?.innerText ?? '')
        .catch(() => '');
      if (texts.every((t) => body.includes(t))) return;
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${timeout}ms waiting for: ${texts.join(', ')}`);
      }
      await delay(300);
    }
  }

  async screenshot(opts?: {
    format?: 'png' | 'jpeg' | 'webp';
    fullPage?: boolean;
    uid?: string;
  }): Promise<string> {
    const type = opts?.format ?? 'png';
    if (opts?.uid) {
      const el = await this.resolveUid(opts.uid);
      try {
        await this.emitHighlight(el);
        const buf = await el.screenshot({ type });
        return Buffer.from(buf).toString('base64');
      } finally {
        await el.dispose();
      }
    }
    const buf = await this.active.screenshot({ type, fullPage: opts?.fullPage });
    return Buffer.from(buf).toString('base64');
  }

  async evaluateScript(fn: string, args: unknown[] = []): Promise<unknown> {
    return this.active.evaluate(
      (body: string, a: unknown[]) => {
        // Indirect eval → evaluates the function expression in the page's global scope.
        const f = (0, eval)('(' + body + ')');
        return f(...a);
      },
      fn,
      args,
    );
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    try {
      await this.browser.close();
    } catch {
      /* ignore */
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
