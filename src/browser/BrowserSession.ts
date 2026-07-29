import * as puppeteer from 'puppeteer-core';
import type { Browser, Page, ElementHandle, CDPSession } from 'puppeteer-core';
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

export type ActivityType = 'navigated' | 'tab-opened' | 'tab-closed' | 'tab-activated';

/** A browser activity event, so the agent can catch up on what happened between its own
 *  tool calls — especially manual human navigation — instead of acting on a stale view. */
export interface ActivityEvent {
  seq: number;
  time: string;
  type: ActivityType;
  pageId: string;
  url: string;
  source: 'agent' | 'human';
}

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
  /** Infrastructure pages (e.g. the video-capture controller) — excluded from the
   *  agent's tab list, panels, persistence, and the last-tab-quit heuristic. */
  private internalPages = new Set<Page>();
  private idSeq = 0;

  /** Per-page CDP session holding a virtual WebAuthn authenticator, so passkey
   *  prompts fail fast to a password fallback instead of hanging on an OS
   *  prompt that headless Chromium can never show. Kept alive for the page's
   *  lifetime (detaching would drop the authenticator). */
  private authSessions = new Map<Page, CDPSession>();

  /** Soft advisory flag; the FIFO queue is the real serialization mechanism. */
  inputOwner: InputOwner = null;

  /** Ring buffer of recent activity so the agent can re-sync after manual actions, and a
   *  timestamp of the last agent tool call to attribute navigations to agent vs human. */
  private events: ActivityEvent[] = [];
  private eventSeq = 0;
  private agentActivityAt = 0;

  /** >0 while newPage() is opening a target, so targetcreated doesn't also
   *  emit/adopt it — newPage handles its own open with the right reveal flag. */
  private suppressOpen = 0;
  private disposing = false;
  private onDisconnectedCb?: () => void;
  private allClosedCb?: () => void;
  private pageOpenedCb?: PageOpenedListener;
  private pageClosedCb?: PageClosedListener;
  private pageRevealCb?: (id: string) => void;
  private pagesChangedCb?: () => void;
  private highlightCb?: (id: string, box: ElementBox) => void;

  private constructor(
    private browser: Browser,
    readonly headless: boolean,
    /** Install a virtual WebAuthn authenticator so passkey prompts fail fast to
     *  a password fallback (headless can't show the OS fingerprint prompt). */
    private readonly autoFallbackPasskeys: boolean,
  ) {}

  static async launch(
    profileDir: string,
    chromePath: string,
    headless = true,
    autoFallbackPasskeys = true,
    uncapFrameRate = false,
  ): Promise<BrowserSession> {
    const browser = await puppeteer.launch({
      ...resolveLaunchOptions(profileDir, chromePath, headless, uncapFrameRate),
      // Don't let puppeteer kill Chrome when the extension host dies/reloads — we detach
      // (disconnect) on reload and reconnect to the same browser, so tabs are never lost.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    return BrowserSession.wrap(browser, headless, autoFallbackPasskeys);
  }

  /** Reconnect to a Chrome kept alive across a reload — its tabs are intact, no gap. */
  static async connect(
    wsEndpoint: string,
    headless: boolean,
    autoFallbackPasskeys = true,
  ): Promise<BrowserSession> {
    const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    return BrowserSession.wrap(browser, headless, autoFallbackPasskeys);
  }

  private static async wrap(
    browser: Browser,
    headless: boolean,
    autoFallbackPasskeys: boolean,
  ): Promise<BrowserSession> {
    const session = new BrowserSession(browser, headless, autoFallbackPasskeys);

    const pages = await browser.pages();
    // Prefer a real restored tab over puppeteer's stray about:blank.
    const first = pages.find((p) => !p.url().startsWith('about:')) ?? pages[0] ?? (await browser.newPage());
    // Fire-and-forget: never block startup on passkey setup across restored tabs —
    // a single hung tab must not delay (or wedge) the whole session coming up.
    for (const p of pages) void session.prepPage(p);
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
          if (session.internalPages.has(page)) return; // infrastructure, not a user tab
          const id = session.idFor(page);
          session.pushEvent('tab-opened', id, page.url());
          await session.prepPage(page); // fail-fast passkeys before any site script runs
          // A site-opened popup/tab becomes the shared active page and gets a revealed
          // panel, so the human and agent move to it together — never a split view.
          await session.run(() => session.setActive(page));
          session.pageOpenedCb?.(page, id, true);
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
              session.pushEvent('tab-closed', id, page.url());
              session.ids.delete(page);
              session.authSessions.delete(page); // CDP session dies with the page
              session.pageClosedCb?.(id);
            }
          }
          session.pagesChangedCb?.();
          const open = (await browser.pages()).filter(
            (p) => !p.isClosed() && !session.internalPages.has(p),
          );
          if (open.length === 0) {
            // Last tab closed → quit the whole Chrome instance (onDisconnected then
            // clears the session, so the next new tab relaunches a fresh browser).
            session.allClosedCb?.(); // intentional empty → don't auto-relaunch on reload
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
    this.pushEvent('tab-activated', this.idFor(page), page.url());
    // Timeout-guard: a hung bringToFront (e.g. on a half-loaded popup) must not freeze the
    // shared run() queue and lock up every other tab's input/rendering.
    await withTimeout(page.bringToFront(), 3000).catch(() => undefined);
    this.pagesChangedCb?.(); // selection moved — refresh the sidebar's active dot
  }

  /** Stable id for a page, minted on first sight. Also wires the one-time
   *  per-page navigation listener that keeps the sidebar's titles/urls fresh. */
  private idFor(page: Page): string {
    let id = this.ids.get(page);
    if (!id) {
      id = String(++this.idSeq);
      this.ids.set(page, id);
      const pid = id;
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
          this.pushEvent('navigated', pid, page.url());
          this.pagesChangedCb?.();
        }
      });
    }
    return id;
  }

  private pageById(id: string): Page | undefined {
    for (const [page, pid] of this.ids) if (pid === id && !page.isClosed()) return page;
    return undefined;
  }

  /**
   * Install a credential-less virtual WebAuthn authenticator on a page, so a
   * passkey ceremony resolves immediately (NotAllowedError → the site falls
   * back to password) instead of hanging on an OS prompt headless can't show.
   *
   * Idempotent per page; best-effort (a page that closed mid-setup just skips).
   * The CDP session is kept in `authSessions` for the page's lifetime — the
   * virtual authenticator is bound to it and would vanish if it detached.
   */
  /**
   * Describe ourselves accurately: this IS an ordinary Chrome rendering real pages for
   * a human, but headless defaults advertise otherwise — the UA literally contains
   * "HeadlessChrome" and the client-hint brands say unbranded "Chromium". Sites match
   * those strings and serve CAPTCHA walls instead of content. Rewrite both to the plain
   * Chrome equivalent of the SAME build (version taken from the real UA, never invented),
   * so the only thing that changes is the false "I am headless" claim.
   */
  private async fixUserAgent(page: Page): Promise<void> {
    try {
      const real = await withTimeout(this.browser.version(), 2000); // "HeadlessChrome/151.0.7922.47"
      const full = /[\d.]+/.exec(real ?? '')?.[0] ?? '';
      const major = full.split('.')[0] || '151';
      const ua =
        `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
        `(KHTML, like Gecko) Chrome/${full || major + '.0.0.0'} Safari/537.36`;
      await withTimeout(
        page.setUserAgent(ua, {
          // Client hints must agree with the UA string; a mismatch is itself a signal.
          brands: [
            { brand: 'Chromium', version: major },
            { brand: 'Google Chrome', version: major },
            { brand: 'Not=A?Brand', version: '99' },
          ],
          fullVersion: full,
          platform: 'macOS',
          platformVersion: '15.0.0',
          architecture: 'arm',
          model: '',
          mobile: false,
        }),
        3000,
      );
    } catch {
      /* UA override unsupported — cosmetic only, keep going */
    }
  }

  private async prepPage(page: Page): Promise<void> {
    void this.fixUserAgent(page); // independent of the passkey work below
    if (!this.autoFallbackPasskeys || this.authSessions.has(page)) return;
    try {
      // Every await is timeout-bounded: a hung/unresponsive page must never
      // block session startup or tab adoption on best-effort passkey setup.
      const cdp = await withTimeout(page.createCDPSession(), 3000);
      if (!cdp) return;
      this.authSessions.set(page, cdp);
      await withTimeout(cdp.send('WebAuthn.enable'), 3000);
      await withTimeout(
        cdp.send('WebAuthn.addVirtualAuthenticator', {
          options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            // Auto-resolve the presence/verification check (no OS prompt), so with
            // no stored credential the get() rejects fast instead of hanging.
            automaticPresenceSimulation: true,
            isUserVerified: true,
          },
        }),
        3000,
      );
    } catch {
      this.authSessions.delete(page);
      /* WebAuthn domain unsupported or page already gone — leave passkeys as-is */
    }
  }

  /** Fired when the underlying browser exits out-of-band (Cmd-Q / crash). */
  onDisconnected(cb: () => void): void {
    this.onDisconnectedCb = cb;
  }

  /** Fired when the human closes the LAST tab (an intentional "I'm done" signal,
   *  distinct from a reload/crash) so the extension won't auto-relaunch on reload. */
  onAllClosed(cb: () => void): void {
    this.allClosedCb = cb;
  }

  /** Mark teardown BEFORE panels are disposed, so closing their pages during a reload
   *  doesn't trip the "last tab closed" quit path (which would clear the relaunch flag). */
  beginDispose(): void {
    this.disposing = true;
  }

  /** True during teardown — panels check this so they DON'T close their pages on a
   *  reload (leaving them open lets browser.close() save them for --restore-last-session). */
  get isDisposing(): boolean {
    return this.disposing;
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
    await withTimeout(
      page.setViewport({ width, height, deviceScaleFactor: deviceScaleFactor || 1 }),
      3000,
    ).catch(() => undefined);
    // Headless keeps a stock 800x600 phantom screen, so sizing the viewport to the panel
    // (device pixels, for crisp text) leaves window.innerWidth LARGER than screen.width —
    // physically impossible on real hardware, and a giveaway that reads as "scripted".
    // Report a screen that plausibly contains the viewport instead.
    try {
      const cdp = this.authSessions.get(page) ?? (await withTimeout(page.createCDPSession(), 2000));
      if (!cdp) return;
      const screenWidth = Math.max(width, 1512);
      const screenHeight = Math.max(height, 982);
      await withTimeout(
        cdp.send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: deviceScaleFactor || 1,
          mobile: false,
          screenWidth,
          screenHeight,
          // Sit the window at a natural offset below the menu bar rather than 0,0.
          positionX: 0,
          positionY: 25,
        }),
        2000,
      );
    } catch {
      /* emulation unsupported — the viewport itself is already applied */
    }
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

  /** Mark that the agent is acting now, so the resulting navigation is attributed to it
   *  (human navigation happens while the agent is idle, so it's attributed to the human). */
  markAgent(): void {
    this.agentActivityAt = Date.now();
  }

  private pushEvent(type: ActivityType, pageId: string, url: string): void {
    const source: ActivityEvent['source'] = Date.now() - this.agentActivityAt < 3000 ? 'agent' : 'human';
    this.events.push({ seq: ++this.eventSeq, time: new Date().toISOString(), type, pageId, url, source });
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
  }

  /** Recent activity after `since` (a seq cursor), plus the latest seq to poll from next. */
  getActivity(since = 0): { events: ActivityEvent[]; latest: number } {
    return { events: this.events.filter((e) => e.seq > since), latest: this.eventSeq };
  }

  // ----- tool-facing operations (uid model mirrors chrome-devtools-mcp naming) -----

  async listPages(): Promise<PageInfo[]> {
    const pages = (await this.browser.pages()).filter((p) => !this.internalPages.has(p));
    const infos: PageInfo[] = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      infos.push({
        index: i,
        pageId: this.idFor(p),
        url: p.url(),
        // Timeout-guarded: an unresponsive tab's title() would otherwise hang
        // forever and wedge the whole run() queue (every later tool call blocks).
        title: (await withTimeout(p.title().catch(() => ''), 2000)) ?? '',
        selected: p === this.active,
      });
    }
    return infos;
  }

  async newPage(url?: string, opts?: { background?: boolean }): Promise<PageInfo> {
    this.markAgent();
    // We open this page ourselves, so suppress the generic targetcreated handler
    // and emit the open here with the right reveal flag (background = no reveal).
    const page = await (async (): Promise<Page> => {
      this.suppressOpen++;
      try {
        const p = await this.createPageInNewWindow();
        await this.prepPage(p); // fail-fast passkeys before navigating anywhere
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

  /**
   * Resize the OS-level window that owns `page` to a CSS size. Tab capture (the WebRTC
   * path) renders the WINDOW surface — not the emulated viewport — and delivers it at 2x,
   * so matching the window to the panel is what makes the video the right shape and
   * natively crisp. Each page has its own window (createPageInNewWindow), so this only
   * affects that tab. No-op'd errors: sizing is an optimization, never load-bearing.
   */
  async setWindowSize(page: Page, cssWidth: number, cssHeight: number): Promise<void> {
    if (cssWidth < 50 || cssHeight < 50) return;
    try {
      const cdp = await withTimeout(this.browser.target().createCDPSession(), 2000);
      if (!cdp) return;
      try {
        const targetId = (page.target() as unknown as { _targetId?: string })._targetId;
        if (!targetId) return;
        const { windowId } = (await withTimeout(
          cdp.send('Browser.getWindowForTarget', { targetId }),
          2000,
        )) as { windowId: number };
        // The window includes chrome above the content area, so the content comes out
        // shorter than the bounds we ask for. Measure the delta once and compensate.
        const before = await page.evaluate(() => window.innerHeight).catch(() => 0);
        await withTimeout(
          cdp.send('Browser.setWindowBounds', {
            windowId,
            bounds: { width: cssWidth, height: cssHeight + this.windowChromeH },
          }),
          2000,
        );
        if (!this.windowChromeMeasured && before > 0) {
          const after = await page.evaluate(() => window.innerHeight).catch(() => 0);
          if (after > 0 && after < cssHeight) {
            this.windowChromeH = cssHeight - after;
            this.windowChromeMeasured = true;
            await withTimeout(
              cdp.send('Browser.setWindowBounds', {
                windowId,
                bounds: { width: cssWidth, height: cssHeight + this.windowChromeH },
              }),
              2000,
            );
          }
        }
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    } catch {
      /* window sizing unsupported — capture just keeps its previous shape */
    }
  }

  private windowChromeH = 0;
  private windowChromeMeasured = false;

  /** Open an infrastructure page (own window) that is invisible to the agent's tab
   *  list, panels, persistence, and last-tab-quit — used by the video-capture hub. */
  async createInternalPage(url: string): Promise<Page> {
    this.suppressOpen++;
    try {
      const page = await this.createPageInNewWindow();
      this.internalPages.add(page);
      await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      return page;
    } finally {
      this.suppressOpen--;
    }
  }

  /** Open each page in its OWN headless window (Target.createTarget newWindow), not as
   *  a tab of one shared window. Every window's sole tab is independently "visible", so
   *  every panel's screencast pushes frames at full rate SIMULTANEOUSLY — verified 60fps
   *  on two windows at once, unaffected by bringToFront. Tabs sharing one window share
   *  one compositor, and all but the foreground tab freeze (the old poll workaround). */
  private async createPageInNewWindow(): Promise<Page> {
    const cdp = await this.browser.target().createCDPSession();
    try {
      const { targetId } = (await cdp.send('Target.createTarget', {
        url: 'about:blank',
        newWindow: true,
      })) as { targetId: string };
      const target = await this.browser.waitForTarget(
        (t) => (t as unknown as { _targetId?: string })._targetId === targetId,
        { timeout: 5000 },
      );
      const page = await target.page();
      if (!page) throw new Error('newly created window has no page');
      return page;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }

  async selectPage(pageId: string, bringToFront = true): Promise<void> {
    this.markAgent();
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
    // The human focused a panel → make it the shared active page AND force it to the
    // foreground. Critical: a backgrounded headless page emits ZERO screencast frames
    // (it only repaints on input, which reads as "updates only when my cursor moves"),
    // so the viewed/streaming page must always be front. bringToFront directly rather
    // than setActive, which no-ops when the page is already active even if something
    // (a popup, an agent tab switch) backgrounded it underneath.
    const page = this.pageById(pageId);
    if (!page) return;
    this.active = page;
    await withTimeout(page.bringToFront(), 3000).catch(() => undefined);
    this.pagesChangedCb?.();
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
  ): Promise<{ url: string; title: string }> {
    this.markAgent();
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
    // Return the SETTLED url/title (post-redirect), not what was requested.
    return { url: p.url(), title: await p.title().catch(() => '') };
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

  /** Resolve a click/fill target by uid (from take_snapshot) or a CSS selector. */
  private async resolveTarget(uid?: string, selector?: string): Promise<ElementHandle<Element>> {
    if (uid) return this.resolveUid(uid);
    if (selector) {
      const el = await this.active.$(selector);
      if (!el) throw new Error(`No element matches selector: ${selector}`);
      return el;
    }
    throw new Error('click/fill requires a uid or a selector');
  }

  async click(opts: { uid?: string; selector?: string; dblClick?: boolean }): Promise<void> {
    this.markAgent();
    const el = await this.resolveTarget(opts.uid, opts.selector);
    try {
      await el.scrollIntoView().catch(() => undefined);
      await this.emitHighlight(el); // measure after scroll, so the box is on-screen
      // Trusted CDP input click (Input.dispatchMouseEvent) — frameworks like React treat
      // it as real input, unlike element.click() called from evaluate_script.
      await el.click(opts.dblClick ? { clickCount: 2 } : {});
    } finally {
      await el.dispose();
    }
  }

  async fill(opts: { uid?: string; selector?: string; value: string }): Promise<void> {
    const el = await this.resolveTarget(opts.uid, opts.selector);
    try {
      await el.scrollIntoView().catch(() => undefined);
      await this.emitHighlight(el);
      await el.click({ clickCount: 3 }).catch(() => undefined); // select existing content
      await el.evaluate((node) => {
        const input = node as HTMLInputElement;
        if ('value' in input) input.value = '';
      });
      await el.type(opts.value); // trusted keystrokes
    } finally {
      await el.dispose();
    }
  }

  async fillForm(elements: { uid?: string; selector?: string; value: string }[]): Promise<void> {
    for (const e of elements) await this.fill(e);
  }

  async typeText(text: string, submitKey = false): Promise<void> {
    await this.active.keyboard.type(text);
    if (submitKey) await this.active.keyboard.press('Enter');
  }

  /**
   * Poll for text, but do NOT hold the run() queue for the whole wait. Each
   * body-text read is its own short queued op; the delay between polls runs
   * OUTSIDE the queue, so human panel input and other agent actions stay
   * responsive during a long wait instead of freezing for up to `timeout` ms.
   *
   * Call this WITHOUT wrapping it in run() (it queues its own reads).
   */
  async waitFor(texts: string[], timeout = 15000): Promise<void> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const body = await this.run(() =>
        this.active.evaluate(() => document.body?.innerText ?? '').catch(() => ''),
      );
      if (texts.every((t) => body.includes(t))) return;
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${timeout}ms waiting for: ${texts.join(', ')}`);
      }
      await delay(300); // queue is free here — input/other actions can interleave
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

  wsEndpoint(): string {
    return this.browser.wsEndpoint();
  }

  /** Current pages (stable id + URL) in creation order, synchronously (no queue, no CDP
   *  round-trip) — for persisting the open-tab list + panel layout so a reload can restore
   *  both even when Chrome dies with the extension host and --restore-last-session doesn't
   *  kick in. */
  pageEntries(): { id: string; url: string }[] {
    return [...this.ids.entries()]
      .filter(([p]) => !p.isClosed())
      .map(([p, id]) => ({ id, url: p.url() }));
  }

  /** Detach WITHOUT closing Chrome — keeps its tabs alive for a reconnect after a reload. */
  async disconnect(): Promise<void> {
    this.disposing = true;
    try {
      this.browser.disconnect();
    } catch {
      /* already gone */
    }
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

/** Resolve with the promise's value, or undefined if it doesn't settle within `ms` —
 *  so a hung page op can't wedge the serialized run() queue. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, delay(ms).then(() => undefined)]);
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
