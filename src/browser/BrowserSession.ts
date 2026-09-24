import type { AppConnection, AppTabInfo, ConsoleEntry, RequestEntry, ScreenInfo } from '../app/AppClient';
import { AppPage } from './AppPage';
import { snapshotScript } from './snapshot';

export interface PageInfo {
  index: number;
  pageId: string;
  url: string;
  title: string;
  selected: boolean;
  /** Who opened the tab: the agent (new_page) or the human / a site popup. */
  openedBy: 'agent' | 'human';
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
type PageOpenedListener = (page: AppPage, id: string, reveal: boolean) => void;
type PageClosedListener = (id: string) => void;

/** A click/fill target: a uid from take_snapshot, or a CSS selector. */
interface Target {
  uid?: string;
  selector?: string;
}

/**
 * The editor's view of this workspace's tabs in the app. BOTH drivers — the MCP tool
 * handlers (agent) and the webview panel (human) — funnel every action through `run()`, a
 * FIFO queue that serializes access so their inputs never interleave mid-action.
 *
 * Every page operation is a DevTools-protocol command relayed to the app, which runs it on
 * the tab's own in-process debugger: input events are real trusted input, scripts run in
 * the page, screenshots come from the compositor. No debugging port, no puppeteer.
 */
export class BrowserSession {
  private active: AppPage | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  /** Pages in creation order, by the session's stable id. */
  private pages = new Map<string, AppPage>();
  private byTab = new Map<string, AppPage>();
  private idSeq = 0;

  /** Soft advisory flag; the FIFO queue is the real serialization mechanism. */
  inputOwner: InputOwner = null;

  /** Ring buffer of recent activity so the agent can re-sync after manual actions, and a
   *  timestamp of the last agent tool call to attribute navigations to agent vs human. */
  private events: ActivityEvent[] = [];
  private eventSeq = 0;
  private agentActivityAt = 0;

  private disposing = false;
  private onDisconnectedCb?: () => void;
  private allClosedCb?: () => void;
  private pageOpenedCb?: PageOpenedListener;
  private pageClosedCb?: PageClosedListener;
  private pageRevealCb?: (id: string) => void;
  private pagesChangedCb?: () => void;
  private highlightCb?: (id: string, box: ElementBox) => void;

  /** Pages the agent opened with new_page — the ones it is expected to tidy up. */
  private agentPages = new WeakSet<AppPage>();
  /** Pages that already got their passkey setup (idempotent per page). */
  private prepped = new WeakSet<AppPage>();

  private constructor(
    /** The cobrowser app that owns these tabs. */
    private readonly app: AppConnection,
    /** Install a virtual WebAuthn authenticator so passkey prompts fail fast to
     *  a password fallback (an offscreen page can't show the OS fingerprint prompt). */
    private readonly autoFallbackPasskeys: boolean,
  ) {}

  /** Offscreen tabs behave as headless did: no OS window can host a prompt. */
  readonly headless = true;

  /** Attach to the app: adopt the workspace's existing tabs and follow its tab events. */
  static async connectApp(app: AppConnection, autoFallbackPasskeys = true): Promise<BrowserSession> {
    const session = new BrowserSession(app, autoFallbackPasskeys);

    // A reload finds the tabs right where it left them.
    const existing = await app.listTabs().catch(() => [] as AppTabInfo[]);
    for (const t of existing) session.adopt(t);
    // Fire-and-forget: never block startup on passkey setup across restored tabs —
    // a single hung tab must not delay (or wedge) the whole session coming up.
    for (const p of session.pages.values()) void session.prepPage(p);
    const first = [...session.pages.values()].find((p) => !p.url().startsWith('about:')) ?? [...session.pages.values()][0];
    if (first) session.setActive(first);

    // A site-opened popup / target=_blank tab becomes active and gets its own revealed
    // panel, so the human and agent move to it together — never a split view. Our own
    // newPage() gets its tab as a request reply, not through this event.
    app.onTabOpened = (t) => {
      void (async () => {
        const page = session.adopt(t);
        session.pushEvent('tab-opened', page.id, page.url());
        await session.prepPage(page); // fail-fast passkeys before any site script runs
        await session.run(async () => session.setActive(page));
        session.pageOpenedCb?.(page, page.id, true);
        session.pagesChangedCb?.();
      })();
    };

    app.onTabUpdated = (t) => {
      const page = session.byTab.get(t.tabId);
      if (!page) return;
      const navigated = page.url() !== t.url;
      page.update(t.url, t.title, navigated);
      if (navigated) session.pushEvent('navigated', page.id, t.url);
      session.pagesChangedCb?.();
    };

    // A closed tab disposes its panel; if it was the agent's active page, fall
    // back to another open page so tools keep a live target.
    app.onTabClosed = (tabId) => {
      const page = session.byTab.get(tabId);
      if (!page) return;
      page.markClosed();
      session.byTab.delete(tabId);
      session.pages.delete(page.id);
      if (session.disposing) return; // intentional teardown does its own cleanup
      session.pushEvent('tab-closed', page.id, page.url());
      session.pageClosedCb?.(page.id);
      session.pagesChangedCb?.();
      if (session.pages.size === 0) {
        // Last tab closed: the app stays up (other workspaces may be using it); this
        // workspace just has no browser until the next tab opens.
        session.active = undefined;
        session.allClosedCb?.(); // intentional empty → don't auto-reopen on reload
        return;
      }
      if (session.active === page) session.setActive([...session.pages.values()][0]);
    };

    // Surface out-of-band exit (human Cmd-Q / crash) so the extension drops the dead
    // session and relaunches on next use. Chain whatever the extension already hooked.
    const prevClose = app.onClose;
    app.onClose = () => {
      prevClose?.();
      session.onDisconnectedCb?.();
    };

    return session;
  }

  /** Register a tab the app reported. Idempotent per tab. */
  private adopt(t: AppTabInfo): AppPage {
    const known = this.byTab.get(t.tabId);
    if (known) return known;
    const page = new AppPage(String(++this.idSeq), t.tabId, this.app, t.url, t.title ?? '');
    this.pages.set(page.id, page);
    this.byTab.set(t.tabId, page);
    return page;
  }

  /** The app's id for a page, for the panel's frame subscription. */
  tabIdOf(page: AppPage): string | undefined {
    return page.tabId;
  }

  /** Set the agent's active page (the target for tools without an explicit page). */
  private setActive(page: AppPage): void {
    if (this.active === page) return;
    this.active = page;
    this.pushEvent('tab-activated', page.id, page.url());
    this.pagesChangedCb?.(); // selection moved — refresh the sidebar's active dot
  }

  private pageById(id: string): AppPage | undefined {
    const p = this.pages.get(id);
    return p && !p.isClosed() ? p : undefined;
  }

  /** The page tools act on. Throws a clear error when the workspace has no tab. */
  private current(): AppPage {
    if (!this.active || this.active.isClosed()) throw new Error('no open page — call new_page first');
    return this.active;
  }

  /**
   * Install a credential-less virtual WebAuthn authenticator on a page, so a
   * passkey ceremony resolves immediately (NotAllowedError → the site falls
   * back to password) instead of hanging on an OS prompt the offscreen page can't show.
   * Not needed once the app is signed for real passkeys (the extension passes false).
   */
  private async prepPage(page: AppPage): Promise<void> {
    if (this.prepped.has(page)) return;
    this.prepped.add(page);
    if (!this.autoFallbackPasskeys) return;
    try {
      await page.cdp('WebAuthn.enable', {}, 3000);
      await page.cdp(
        'WebAuthn.addVirtualAuthenticator',
        {
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
        },
        3000,
      );
    } catch {
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
   *  doesn't trip the "last tab closed" path (which would clear the relaunch flag). */
  beginDispose(): void {
    this.disposing = true;
  }

  /** True during teardown — panels check this so they DON'T close their pages on a
   *  reload (the app keeps them for the reconnect). */
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
    for (const page of this.pages.values()) {
      if (!page.isClosed()) this.pageOpenedCb?.(page, page.id, page === this.active);
    }
  }

  /** Fired with the id + box of an element the AGENT just acted on
   *  (click/fill/etc.), so the human can see where the agent is working. Human
   *  input never routes through the uid path, so this is agent-only. */
  onAgentHighlight(cb: (id: string, box: ElementBox) => void): void {
    this.highlightCb = cb;
  }

  /** Size a page to its panel. The app lays the tab out at cssW x cssH (over `zoom`) and
   *  rasterizes at `scale`; `screen` is the real display, reported to the page as its screen. */
  async setViewport(page: AppPage, cssW: number, cssH: number, scale = 1, zoom = 1, screen?: ScreenInfo): Promise<void> {
    if (cssW < 1 || cssH < 1) return;
    this.app.resize(page.tabId, cssW, cssH, scale, zoom, screen);
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
    return [...this.pages.values()]
      .filter((p) => !p.isClosed())
      .map((p, index) => ({
        index,
        pageId: p.id,
        url: p.url(),
        title: p.title(),
        selected: p === this.active,
        openedBy: this.agentPages.has(p) ? 'agent' : 'human',
      }));
  }

  async newPage(url?: string, opts?: { background?: boolean }): Promise<PageInfo> {
    this.markAgent();
    const [w, h] = this.defaultSize;
    const page = this.adopt(await this.app.openTab('about:blank', w, h));
    this.agentPages.add(page);
    await this.prepPage(page); // fail-fast passkeys before navigating anywhere
    if (url) await page.goto(url).catch(() => undefined);
    if (!opts?.background) this.setActive(page);
    this.pageOpenedCb?.(page, page.id, !opts?.background);
    this.pagesChangedCb?.();
    return {
      index: [...this.pages.values()].indexOf(page),
      pageId: page.id,
      url: page.url(),
      title: page.title(),
      selected: page === this.active,
      openedBy: 'agent',
    };
  }

  /** Size for tabs opened before any panel has measured itself. Panels correct it on attach. */
  defaultSize: [number, number] = [1280, 800];

  async selectPage(pageId: string, bringToFront = true): Promise<void> {
    this.markAgent();
    const page = this.pageById(pageId);
    if (!page) throw new Error(`No page with id ${pageId}`);
    this.setActive(page);
    if (bringToFront) this.pageRevealCb?.(pageId); // reveal its VS Code tab so the human follows
  }

  /** The human focused a page's panel: make it the agent's active page, WITHOUT
   *  re-revealing — the panel is already the active editor tab, so firing the reveal
   *  path would recurse. */
  async focusPage(pageId: string): Promise<void> {
    const page = this.pageById(pageId);
    if (page) this.setActive(page);
  }

  /** Close a tab. The app's tabClosed event disposes its panel and picks a fallback. */
  async closePage(pageId: string): Promise<void> {
    const page = this.pageById(pageId);
    if (page) this.app.closeTab(page.tabId);
  }

  async navigate(
    type: 'url' | 'back' | 'forward' | 'reload',
    url?: string,
    timeout = 30000,
  ): Promise<{ url: string; title: string }> {
    this.markAgent();
    const p = this.current();
    if (type === 'url') {
      if (!url) throw new Error('navigate: url is required for type "url"');
      await p.goto(url, timeout);
    } else if (type === 'back') {
      await p.goBack(timeout).catch(() => undefined);
    } else if (type === 'forward') {
      await p.goForward(timeout).catch(() => undefined);
    } else {
      await p.reload(timeout).catch(() => undefined);
    }
    // Return the SETTLED url/title (post-redirect), not what was requested.
    return { url: p.url(), title: p.title() };
  }

  async takeSnapshot(): Promise<string> {
    return this.current().evaluate<string>(snapshotScript);
  }

  private selectorFor(t: Target): string {
    if (t.uid) return `[data-cobrowser-uid="${cssEscape(t.uid)}"]`;
    if (t.selector) return t.selector;
    throw new Error('click/fill requires a uid or a selector');
  }

  /**
   * Scroll a target into view and return its viewport box in CSS px — the coordinate
   * space Input.* events use. Throws the same guidance puppeteer's handle lookup did.
   */
  private async locate(t: Target): Promise<ElementBox> {
    const selector = this.selectorFor(t);
    const box = await this.current().evaluate<ElementBox | null>(
      (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      },
      selector,
    );
    if (!box) {
      throw new Error(
        t.uid
          ? `uid ${t.uid} not found — uids expire on any DOM change; call take_snapshot again first.`
          : `No element matches selector: ${t.selector}`,
      );
    }
    return box;
  }

  /** Flash the element in the human's panel so they can see what the agent touched. */
  private emitHighlight(box: ElementBox): void {
    if (this.highlightCb && box.width > 0 && box.height > 0) this.highlightCb(this.current().id, box);
  }

  async click(opts: Target & { dblClick?: boolean }): Promise<void> {
    this.markAgent();
    const box = await this.locate(opts);
    this.emitHighlight(box);
    // Real input (Input.dispatchMouseEvent through the tab's own debugger) — frameworks like
    // React treat it as genuine, unlike element.click() from evaluate_script. Approach along
    // a path first: a teleport-and-press skips every hover/mouseover the page expects (menus
    // that open on hover, for one) and is a shape no hand produces.
    const at = await this.moveMouseTo(box);
    const p = this.current();
    const press = async (clickCount: number): Promise<void> => {
      await p.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount });
      await delay(40 + Math.random() * 70);
      await p.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount });
    };
    await press(1);
    if (opts.dblClick) await press(2);
  }

  /**
   * Walk the cursor to a box instead of teleporting onto it, so pages that reveal UI on
   * hover get the mousemove stream they wait for, and the motion has the shape of a hand.
   * Eased and slightly jittered: a straight constant-velocity line is its own tell.
   */
  private async moveMouseTo(box: ElementBox, steps = 14): Promise<{ x: number; y: number }> {
    // Aim off-centre: every click landing on the exact centroid is not human either.
    const target = {
      x: box.x + box.width * (0.35 + Math.random() * 0.3),
      y: box.y + box.height * (0.35 + Math.random() * 0.3),
    };
    const from = this.cursor ?? { x: target.x - 220, y: target.y - 160 };
    const p = this.current();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // ease-in-out: slow to start, quick through the middle, settling at the end.
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const drift = i === steps ? 0 : (Math.random() - 0.5) * 3; // never miss the target
      await p.cdp('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + (target.x - from.x) * e + drift,
        y: from.y + (target.y - from.y) * e + drift,
        button: 'none',
      });
    }
    this.cursor = target;
    return target;
  }

  /** Where the cursor was left, so the next move starts from there rather than nowhere. */
  private cursor: { x: number; y: number } | undefined;

  async fill(opts: Target & { value: string }): Promise<void> {
    this.markAgent();
    // A <select> has no keyboard path in an offscreen page (its popup cannot show): choose
    // the option by visible text or value and fire the events frameworks listen for.
    const selector = this.selectorFor(opts);
    const picked = await this.current().evaluate<string | null | false>(
      (sel: string, want: string) => {
        const s = document.querySelector(sel);
        if (!s || s.tagName !== 'SELECT') return false;
        const el = s as HTMLSelectElement;
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
        const opts = [...el.options];
        const norm = (t: string) => t.trim().toLowerCase();
        const o = opts.find((x) => x.text.trim() === want) ?? opts.find((x) => x.value === want) ?? opts.find((x) => norm(x.text) === norm(want)) ?? opts.find((x) => norm(x.text).includes(norm(want)));
        if (!o) return null;
        el.selectedIndex = o.index;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return o.text;
      },
      selector,
      opts.value,
    );
    if (picked === null) throw new Error(`no option matches "${opts.value}" in that <select> — take_snapshot lists its options`);
    if (typeof picked === 'string') {
      this.emitHighlight(await this.locate(opts));
      return;
    }
    // Focus with a real click, select whatever is there, then type over it: the page sees
    // exactly the events a person produces, so React-style controlled inputs update.
    await this.click(opts);
    await this.current().evaluate(
      (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return;
        el.focus();
        const input = el as HTMLInputElement;
        if (typeof input.select === 'function') input.select();
        else document.execCommand('selectAll');
      },
      this.selectorFor(opts),
    );
    if (opts.value) await this.typeText(opts.value);
    else await this.pressKey('Backspace', 'Backspace', 8);
  }

  async fillForm(elements: (Target & { value: string })[]): Promise<void> {
    for (const e of elements) await this.fill(e);
  }

  /** Type into the focused element with real key events, one character at a time. */
  async typeText(text: string, submitKey = false): Promise<void> {
    const p = this.current();
    for (const ch of text) {
      if (ch === '\n') {
        await this.pressKey('Enter', 'Enter', 13, '\r');
        continue;
      }
      const code = keyCodeFor(ch);
      await p.cdp('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      await p.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      await delay(15 + Math.random() * 45);
    }
    if (submitKey) await this.pressKey('Enter', 'Enter', 13, '\r');
  }

  /** `code` is the DOM code string ("Enter"); `vk` the Windows virtual key. Parameter TYPES
   *  matter: a number where the protocol wants a string aborts the whole app inside
   *  Electron's deserializer (the app guards the hot-path commands, but stay typed). */
  private async pressKey(key: string, code: string, vk: number, text?: string): Promise<void> {
    const p = this.current();
    await p.cdp('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) });
    await p.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
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
        this.current().evaluate<string>(() => document.body?.innerText ?? '').catch(() => ''),
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
    const format = opts?.format ?? 'png';
    const p = this.current();
    const params: Record<string, unknown> = { format, captureBeyondViewport: false };
    if (format === 'jpeg') params.quality = 85;
    if (opts?.uid) {
      const box = await this.locate({ uid: opts.uid });
      this.emitHighlight(box);
      // Clip in document coordinates: the box is viewport-relative, so add the scroll offset.
      const scroll = await p.evaluate<{ x: number; y: number }>(() => ({ x: window.scrollX, y: window.scrollY }));
      params.clip = { x: box.x + scroll.x, y: box.y + scroll.y, width: Math.max(1, box.width), height: Math.max(1, box.height), scale: 1 };
      params.captureBeyondViewport = true;
    } else if (opts?.fullPage) {
      const m = await p.cdp<{ cssContentSize: { width: number; height: number } }>('Page.getLayoutMetrics');
      params.clip = { x: 0, y: 0, width: Math.ceil(m.cssContentSize.width), height: Math.ceil(m.cssContentSize.height), scale: 1 };
      params.captureBeyondViewport = true;
    }
    const r = await p.cdp<{ data: string }>('Page.captureScreenshot', params, 60000);
    return r.data;
  }

  /** What the page's console said: log lines, warnings, uncaught exceptions, and the
   *  browser's own resource-load errors. `pageId` defaults to the active page. */
  async consoleMessages(opts: { pageId?: string; since?: number; limit?: number; level?: string } = {}): Promise<{ pageId: string; entries: ConsoleEntry[]; latest: number }> {
    const page = opts.pageId ? this.pageById(opts.pageId) : this.current();
    if (!page) throw new Error(`No page with id ${opts.pageId}`);
    const r = await this.app.consoleMessages(page.tabId, opts.since ?? 0, { limit: opts.limit, level: opts.level });
    return { pageId: page.id, ...r };
  }

  /** The tab's request log: method, URL, status or error, timing. No bodies, no headers. */
  async networkRequests(opts: { pageId?: string; since?: number; limit?: number; failedOnly?: boolean; urlContains?: string; minStatus?: number } = {}): Promise<{ pageId: string; entries: RequestEntry[]; latest: number; pending: number }> {
    const page = opts.pageId ? this.pageById(opts.pageId) : this.current();
    if (!page) throw new Error(`No page with id ${opts.pageId}`);
    const { pageId: _p, since, ...rest } = opts;
    const r = await this.app.networkRequests(page.tabId, since ?? 0, rest);
    return { pageId: page.id, ...r };
  }

  /** Logins the vault holds for the agent to use: hosts and usernames only. */
  listCredentials(): Promise<{ host: string; username: string }[]> {
    return this.app.vaultList();
  }

  /** Fill a saved login into fields the agent chose; the app supplies the secret and checks
   *  the page is on that login's site. The agent only learns what got filled. */
  fillCredentials(opts: { usernameUid?: string; passwordUid?: string; username?: string }) {
    this.markAgent();
    return this.app.vaultFill(this.current().tabId, opts);
  }

  /** Ask the human to grant this workspace a login for a site. Answered in the app. */
  requestCredential(opts: { site: string; username?: string; reason?: string }) {
    this.markAgent();
    return this.app.vaultRequest(opts.site, opts.username, opts.reason);
  }

  /** Text bound for the agent, with any unlocked vault password removed. */
  scrub(text: string): Promise<string> {
    return this.app.scrub(text);
  }

  async evaluateScript(fn: string, args: unknown[] = []): Promise<unknown> {
    // The function expression is evaluated in the page's global scope with the JSON args.
    return this.current().evaluate(fn, ...args);
  }

  /** Current pages (stable id + URL) in creation order, synchronously — for persisting the
   *  open-tab list + panel layout so a reload can restore both. */
  pageEntries(): { id: string; url: string }[] {
    return [...this.pages.values()].filter((p) => !p.isClosed()).map((p) => ({ id: p.id, url: p.url() }));
  }

  /** Detach, leaving the tabs alive in the app for the next connection (a reload). */
  async disconnect(): Promise<void> {
    this.disposing = true;
    try {
      this.app.close();
    } catch {
      /* already gone */
    }
  }

  /** Close this workspace's tabs in the app, then detach. */
  async dispose(): Promise<void> {
    this.disposing = true;
    this.app.closeAll();
    await this.disconnect();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** The Windows virtual key code sites read as event.keyCode, for the characters that have
 *  an obvious one. Others get 0, which is what an IME commit reports too. */
function keyCodeFor(ch: string): number {
  if (/^[a-z]$/i.test(ch)) return ch.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(ch)) return ch.charCodeAt(0);
  if (ch === ' ') return 32;
  if (ch === '\t') return 9;
  return 0;
}
