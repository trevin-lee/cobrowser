import * as puppeteer from 'puppeteer-core';
import type { Browser, Page, CDPSession, ElementHandle } from 'puppeteer-core';
import { resolveLaunchOptions } from './launchFlags';
import { snapshotScript } from './snapshot';

export interface PageInfo {
  index: number;
  pageId: string;
  url: string;
  title: string;
  selected: boolean;
}

export type InputOwner = 'human' | 'agent' | null;
type ActivePageListener = (cdp: CDPSession, page: Page) => void;

/**
 * The single owner of the Chromium instance. BOTH drivers — the MCP tool handlers
 * (agent) and the webview panel (human) — funnel every action through `run()`, a FIFO
 * queue that serializes access to the one browser so their inputs never interleave
 * mid-action.
 */
export class BrowserSession {
  private active!: Page;
  private cdp!: CDPSession;
  private queue: Promise<unknown> = Promise.resolve();
  private activePageListeners: ActivePageListener[] = [];

  /** Soft advisory flag; the FIFO queue is the real serialization mechanism. */
  inputOwner: InputOwner = null;

  /** >0 while newPage() is opening a target, so targetcreated doesn't adopt it. */
  private suppressAdopt = 0;
  private onDisconnectedCb?: () => void;

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
    const first = pages[0] ?? (await browser.newPage());
    await session.setActive(first);

    // Adopt genuinely site-opened popups/new tabs as active — but NOT the page that
    // newPage() is opening itself (suppressAdopt), and serialized through run() so it
    // can't race the agent's snapshot→act sequence.
    browser.on('targetcreated', (target) => {
      if (session.suppressAdopt > 0) return;
      void (async () => {
        try {
          const page = await target.page();
          if (page) await session.run(() => session.setActive(page));
        } catch {
          /* not a page target */
        }
      })();
    });

    // If the active tab closes, fall back to another open page so the screencast
    // re-attaches instead of freezing on a dead target.
    browser.on('targetdestroyed', () => {
      void (async () => {
        try {
          if (!session.active || !session.active.isClosed()) return;
          const pages = await browser.pages();
          const next = pages.find((p) => !p.isClosed());
          if (next) await session.run(() => session.setActive(next));
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

  private async setActive(page: Page): Promise<void> {
    if (this.active === page) return; // idempotent — avoids double createCDPSession leak
    if (this.cdp) {
      try {
        await this.cdp.detach();
      } catch {
        /* already detached */
      }
    }
    this.active = page;
    this.cdp = await page.createCDPSession();
    for (const listener of this.activePageListeners) listener(this.cdp, page);
  }

  /** Register a callback fired on every active-page change (and immediately with the current one). */
  onActivePageChanged(cb: ActivePageListener): void {
    this.activePageListeners.push(cb);
    if (this.cdp) cb(this.cdp, this.active);
  }

  /** Fired when the underlying browser exits out-of-band (Cmd-Q / crash). */
  onDisconnected(cb: () => void): void {
    this.onDisconnectedCb = cb;
  }

  get activeCdp(): CDPSession {
    return this.cdp;
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
        pageId: String(i),
        url: p.url(),
        title: await p.title().catch(() => ''),
        selected: p === this.active,
      });
    }
    return infos;
  }

  async newPage(url?: string, opts?: { background?: boolean }): Promise<PageInfo> {
    // Suppress targetcreated adoption for the page WE are opening, so background:true
    // is honored and the tab doesn't hijack the active page/screencast.
    const page = await (async (): Promise<Page> => {
      this.suppressAdopt++;
      try {
        const p = await this.browser.newPage();
        if (url) await p.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
        return p;
      } finally {
        this.suppressAdopt--;
      }
    })();
    if (!opts?.background) await this.setActive(page);
    const pages = await this.browser.pages();
    const index = pages.indexOf(page);
    return {
      index,
      pageId: String(index),
      url: page.url(),
      title: await page.title().catch(() => ''),
      selected: page === this.active,
    };
  }

  async selectPage(pageId: string, bringToFront = true): Promise<void> {
    const pages = await this.browser.pages();
    const page = pages[Number(pageId)];
    if (!page) throw new Error(`No page with id ${pageId}`);
    await this.setActive(page);
    if (bringToFront) await page.bringToFront();
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

  async click(uid: string, dblClick = false): Promise<void> {
    const el = await this.resolveUid(uid);
    try {
      await el.scrollIntoView().catch(() => undefined);
      await el.click(dblClick ? { clickCount: 2 } : {});
    } finally {
      await el.dispose();
    }
  }

  async fill(uid: string, value: string): Promise<void> {
    const el = await this.resolveUid(uid);
    try {
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

  /** Native-window fallback: focus the real headful Chromium window. */
  async bringActiveToFront(): Promise<void> {
    await this.active.bringToFront();
  }

  async dispose(): Promise<void> {
    try {
      await this.cdp?.detach();
    } catch {
      /* ignore */
    }
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
