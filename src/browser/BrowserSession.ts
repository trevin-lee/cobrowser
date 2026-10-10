import type { AppConnection, AppTabInfo, ConsoleEntry, RequestEntry, ScreenInfo } from '../app/AppClient';
import { AppPage } from './AppPage';
import { FIND_JS, readPageScript, snapshotScript } from './snapshot';
import { COMMITTING, CREDENTIAL, SECRET_AUTOCOMPLETE, credentialRefusal, paymentRefusal } from './guards';

/** What click reports: what it clicked (and whether the page visibly reacted), or why it did
 *  not (see guards.ts). */
export type ClickResult = { clicked: string; noVisibleEffect?: boolean } | ReturnType<typeof paymentRefusal>;
export type UploadResult = { uploaded?: string[]; host?: string; error?: string; declined?: boolean } | ReturnType<typeof paymentRefusal>;

/** In-page: watch for DOM changes around a click, so one the page ignored is reported rather
 *  than assumed to have worked. Kept under a Symbol.for key, off the page's own names. */
// Checking a box or picking a radio changes a property, not the DOM, so form state is compared
// too; otherwise a click that selected a radio read as one that did nothing.
const FORM_STATE = `const formState = () => Array.from(document.querySelectorAll('input, select, textarea'), (f) => (f.checked ? '1' : '0') + (f.type === 'password' ? f.value.length : f.value) + '/' + (f.selectedIndex ?? '')).join('|');`;
const EFFECT_START = `() => { ${FORM_STATE}
  const k = Symbol.for('cobrowser.effect');
  if (window[k]) window[k].obs.disconnect();
  const e = { n: 0, url: location.href, form: formState(), obs: null };
  e.obs = new MutationObserver((recs) => { e.n += recs.length; });
  e.obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  window[k] = e;
  return true;
}`;
const EFFECT_READ = `() => { ${FORM_STATE}
  const k = Symbol.for('cobrowser.effect');
  const e = window[k];
  if (!e) return { changed: true }; // a new document: the click navigated
  e.obs.disconnect();
  window[k] = null;
  const a = document.activeElement;
  const editing = !!a && (a.isContentEditable || a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['radio', 'checkbox', 'button', 'submit', 'reset'].includes(a.type)));
  return { changed: e.n > 0 || location.href !== e.url || editing || formState() !== e.form };
}`;
/** In-page: when the DOM last changed, for waiting until a page settles. */
const WATCH_START = `() => {
  const k = Symbol.for('cobrowser.watch');
  if (window[k]) window[k].obs.disconnect();
  const w = { last: Date.now(), obs: null };
  w.obs = new MutationObserver(() => { w.last = Date.now(); });
  w.obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  window[k] = w;
  return true;
}`;
const WATCH_READ = `() => { const w = window[Symbol.for('cobrowser.watch')]; return w ? Date.now() - w.last : -1; }`;
/** What fill / fill_form / type_text report: what went in, and any secret field left for the human. */
export type FillResult = { filled: number; refused?: string[]; needsUserAction?: string; why?: string };

/** In-page: whether an element is a secret field (see guards.ts), and a name for it. */
const SECRET_JS = `const secretInfo = (el, credSrc, auto) => {
  if (!el) return null;
  const describes = [el.getAttribute('aria-label'), el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('placeholder'), el.getAttribute('autocomplete'), el.labels && el.labels[0] ? el.labels[0].innerText : ''].join(' ');
  const secret = el.type === 'password' || auto.includes(String(el.autocomplete || '').toLowerCase()) || new RegExp(credSrc, 'i').test(describes);
  return { secret, name: String(el.getAttribute('name') || el.getAttribute('id') || el.getAttribute('aria-label') || el.type || 'field').slice(0, 40) };
};`;
import type { ReadPageOptions, ReadPageResult, SnapshotOptions, SnapshotResult } from './snapshot';

export interface PageInfo {
  index: number;
  pageId: string;
  url: string;
  title: string;
  /** The tab the agent's tools act on when they are not given a pageId. */
  selected: boolean;
  /** The tab the human is looking at in the editor. Independent of `selected`. */
  humanViewing: boolean;
  /** Who opened the tab: the agent (new_page, or a link it clicked) or the human. */
  openedBy: 'agent' | 'human';
  /** Which agent's task it is for, when an agent named one (new_page owner). */
  owner?: string;
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

/** Which tab a tool acts on: an explicit pageId, or the agent's current tab. */
interface OnPage {
  pageId?: string;
}

/**
 * The editor's view of this workspace's tabs in the app. BOTH drivers — the MCP tool
 * handlers (agent) and the webview panel (human) — funnel every action on a tab through
 * `run()`, a FIFO queue per tab, so their inputs never interleave mid-action on the same
 * tab while different tabs proceed independently.
 *
 * The agent and the human each have their own current tab. Every tab is its own offscreen
 * window that renders and takes input whether or not it is on screen, so nothing requires
 * them to be the same: the human switching editor tabs never retargets the agent, and the
 * agent switching tabs never moves the human's view unless it asks to.
 *
 * Every page operation is a DevTools-protocol command relayed to the app, which runs it on
 * the tab's own in-process debugger: input events are real trusted input, scripts run in
 * the page, screenshots come from the compositor. No debugging port, no puppeteer.
 */
export class BrowserSession {
  /** The tab the agent's tools act on by default. */
  private agentActive: AppPage | undefined;
  /** The tab the human is looking at (the focused cobrowser panel). */
  private humanActive: AppPage | undefined;
  /** One FIFO per tab (keyed by page id). */
  private queues = new Map<string, Promise<unknown>>();

  /** Pages in creation order, by the session's stable id. */
  private pages = new Map<string, AppPage>();
  private byTab = new Map<string, AppPage>();
  /**
   * Page ids are never reused, across this workspace's sessions too (Restart Browser, the app
   * quitting, a window reload): an agent still holding an old pageId must get "no such page",
   * never a different tab that happens to have the same number. The extension keeps the counter
   * in the workspace's state between reloads (lastPageId / onPageId).
   */
  static lastPageId = 0;
  static onPageId: ((id: number) => void) | undefined;

  /** Soft advisory flag; the FIFO queue is the real serialization mechanism. */
  inputOwner: InputOwner = null;

  /** Ring buffer of recent activity so the agent can re-sync after manual actions, and a
   *  timestamp of the last agent tool call to attribute navigations to agent vs human. */
  private events: ActivityEvent[] = [];
  private eventSeq = 0;
  private agentActivityAt = 0;

  private disposing = false;
  /** The app announced it is quitting: its tabs are not being closed by anyone. */
  private appQuitting = false;
  private onDisconnectedCb?: () => void;
  private allClosedCb?: () => void;
  private pageOpenedCb?: PageOpenedListener;
  private pageClosedCb?: PageClosedListener;
  private pageRevealCb?: (id: string) => void;
  private pagesChangedCb?: () => void;
  private highlightCb?: (id: string, box: ElementBox) => void;

  /** Pages the agent opened with new_page — the ones it is expected to tidy up. */
  private agentPages = new WeakSet<AppPage>();
  /** Which agent's task each tab is for, when agents work in parallel (new_page owner). */
  private owners = new WeakMap<AppPage, string>();
  /** Pages that already got their passkey setup (idempotent per page). */
  private prepped = new WeakSet<AppPage>();
  /** The highest uid minted per page, so uids never repeat within a tab across documents. */
  private uidSeq = new WeakMap<AppPage, number>();
  /** Where the agent's cursor was left in each tab, so the next move starts from there. */
  private cursors = new WeakMap<AppPage, { x: number; y: number }>();

  private constructor(
    /** The cobrowser app that owns these tabs. */
    private readonly app: AppConnection,
    /** Install a virtual WebAuthn authenticator so passkey prompts fail fast to
     *  a password fallback (an offscreen page can't show the OS fingerprint prompt). */
    /** Passkey prompts fail fast to a password: the browser is not signed for Touch ID. */
    private readonly passkeyFallback: boolean,
  ) {}

  /** Offscreen tabs behave as headless did: no OS window can host a prompt. */
  readonly headless = true;

  /** Attach to the app: adopt the workspace's existing tabs and follow its tab events. */
  static async connectApp(app: AppConnection, passkeyFallback = true): Promise<BrowserSession> {
    const session = new BrowserSession(app, passkeyFallback);

    // A reload finds the tabs right where it left them.
    const existing = await app.listTabs().catch(() => [] as AppTabInfo[]);
    for (const t of existing) session.adopt(t);
    // Fire-and-forget: never block startup on passkey setup across restored tabs —
    // a single hung tab must not delay (or wedge) the whole session coming up.
    for (const p of session.pages.values()) void session.prepPage(p);
    const first = [...session.pages.values()].find((p) => !p.url().startsWith('about:')) ?? [...session.pages.values()][0];
    if (first) session.agentActive = first;

    // A tab a page opened (target=_blank, window.open). Our own newPage() gets its tab as a
    // request reply, not through this event.
    //  - The agent follows it when the agent just clicked in the tab that opened it: that is
    //    the agent's own link, and the tab counts as the agent's to tidy up.
    //  - The human's editor reveals it when the human is looking at the tab that opened it;
    //    a popup from a tab the agent is working in behind the scenes opens quietly.
    app.onTabOpened = (t) => {
      void (async () => {
        const page = session.adopt(t);
        const opener = t.opener ? session.byTab.get(t.opener) : undefined;
        const agentFollows = !session.agentActive || (!!opener && opener === session.agentActive && Date.now() - session.agentActivityAt < 3000);
        // A popup from a named agent's tab is that agent's too, whichever tab is "current".
        const owner = opener ? session.owners.get(opener) : undefined;
        if (owner) session.owners.set(page, owner);
        if ((agentFollows && opener) || owner) {
          session.agentPages.add(page);
          session.app.markTab(page.tabId, 'agent', owner);
        }
        session.pushEvent('tab-opened', page.id, page.url(), agentFollows && opener ? 'agent' : 'human');
        await session.prepPage(page); // fail-fast passkeys before any site script runs
        if (agentFollows) session.setAgentTarget(page, 'agent');
        const reveal = !session.humanActive || !opener || opener === session.humanActive;
        session.pageOpenedCb?.(page, page.id, reveal);
        session.pagesChangedCb?.();
      })();
    };

    app.onFullscreen = (tabId, on) => session.byTab.get(tabId)?.setFullscreen(on);

    // From here the app closes every tab window on its way out. Those are not closes: the
    // editor keeps its tab list, and restores it when the app comes back.
    app.onQuitting = () => { session.appQuitting = true; };

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
      if (session.appQuitting) return;
      const page = session.byTab.get(tabId);
      if (!page) return;
      page.markClosed();
      session.byTab.delete(tabId);
      session.pages.delete(page.id);
      if (session.disposing) return; // intentional teardown does its own cleanup
      session.pushEvent('tab-closed', page.id, page.url());
      session.pageClosedCb?.(page.id);
      session.pagesChangedCb?.();
      if (session.humanActive === page) session.humanActive = undefined;
      if (session.pages.size === 0) {
        // Last tab closed: the app stays up (other workspaces may be using it); this
        // workspace just has no browser until the next tab opens.
        session.agentActive = undefined;
        session.allClosedCb?.(); // intentional empty → don't auto-reopen on reload
        return;
      }
      // The agent's tab went away: fall back to what the human is looking at, else the first.
      if (session.agentActive === page) session.setAgentTarget(session.humanActive ?? [...session.pages.values()][0], 'human');
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
    const n = ++BrowserSession.lastPageId;
    BrowserSession.onPageId?.(n);
    const page = new AppPage(String(n), t.tabId, this.app, t.url, t.title ?? '');
    this.pages.set(page.id, page);
    this.byTab.set(t.tabId, page);
    if (t.by === 'agent') this.agentPages.add(page); // remembered by the app across reloads
    if (t.owner) this.owners.set(page, t.owner);
    return page;
  }

  /** The app's id for a page, for the panel's frame subscription. */
  tabIdOf(page: AppPage): string | undefined {
    return page.tabId;
  }

  /** Set the tab the agent's tools act on by default. */
  private setAgentTarget(page: AppPage, source: ActivityEvent['source']): void {
    if (this.agentActive === page) return;
    this.agentActive = page;
    this.pushEvent('tab-activated', page.id, page.url(), source);
    this.pagesChangedCb?.(); // refresh the sidebar's marker
  }

  private pageById(id: string): AppPage | undefined {
    const p = this.pages.get(id);
    return p && !p.isClosed() ? p : undefined;
  }

  /** The agent's current tab. Throws a clear error when the workspace has none. */
  private current(): AppPage {
    // Agents working in parallel share one browser, and so one "current tab": a call that
    // relies on it could land in another agent's tab. A call does not say which agent sent
    // it, so a main agent without an owner and one named subagent look like a single owner,
    // and the subagent's new_page would move the main agent's current tab under it. So once
    // any tab has an owner, every call must say which tab.
    const owners = this.ownersInUse();
    if (owners.length > 0) {
      const tabs = [...this.pages.values()].filter((p) => !p.isClosed() && this.owners.has(p)).map((p) => `${p.id} (${this.owners.get(p)})`);
      throw new Error(`Agents are working in parallel in this browser (${owners.join(', ')}), so pass pageId: the tab you opened for your task, or the tab you are working in. Their tabs: ${tabs.join(', ')}. Close tabs whose task is done (close_page) to work without pageId again.`);
    }
    if (!this.agentActive || this.agentActive.isClosed()) throw new Error('no open page — call new_page first');
    return this.agentActive;
  }

  /** The owner names of open tabs (new_page owner), each once. */
  private ownersInUse(): string[] {
    return [...new Set([...this.pages.values()].filter((p) => !p.isClosed() && this.owners.has(p)).map((p) => this.owners.get(p)!))];
  }

  /** A tab's owner, if an agent named one. */
  ownerOf(pageId: string): string | undefined {
    const p = this.pageById(pageId);
    return p ? this.owners.get(p) : undefined;
  }

  /** The tab a tool acts on: the one named by pageId, or the agent's current tab. */
  private pageFor(pageId?: string): AppPage {
    if (pageId === undefined || pageId === '') return this.current();
    const p = this.pageById(pageId);
    if (!p) throw new Error(`No open page with id ${pageId} — list_pages shows the open tabs.`);
    return p;
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
    if (!this.passkeyFallback) return;
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
            // Auto-resolve the presence check (no OS prompt), and FAIL user verification:
            // then both create() and get() reject at once, whatever verification the site
            // asks for. With verification passing (as before), get() failed fast but
            // create() succeeded, so a site could record a passkey nobody holds (measured).
            automaticPresenceSimulation: true,
            isUserVerified: false,
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

  /** Fired when the agent asks for a tab to be shown to the human (select_page with
   *  bringToFront), so the extension can reveal that page's panel. */
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
      if (!page.isClosed()) this.pageOpenedCb?.(page, page.id, page === this.agentActive);
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

  /**
   * Serialize browser actions (agent + human) on a tab through that tab's FIFO. `pageId`
   * names the tab; without one it is the agent's current tab at the time of the call.
   * Different tabs never wait for each other.
   */
  run<T>(fn: () => Promise<T>, pageId?: string): Promise<T> {
    const key = pageId || this.agentActive?.id || '_';
    const prev = this.queues.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    // Keep the chain alive but swallow settled state so one failure can't poison the queue.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key); // idle: forget it
    });
    return result;
  }

  /** Mark that the agent is acting now, so the resulting navigation is attributed to it
   *  (human navigation happens while the agent is idle, so it's attributed to the human). */
  markAgent(): void {
    this.agentActivityAt = Date.now();
  }

  private pushEvent(type: ActivityType, pageId: string, url: string, known?: ActivityEvent['source']): void {
    const source: ActivityEvent['source'] = known ?? (Date.now() - this.agentActivityAt < 3000 ? 'agent' : 'human');
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
        selected: p === this.agentActive,
        humanViewing: p === this.humanActive,
        openedBy: this.agentPages.has(p) ? 'agent' : 'human',
        ...(this.owners.has(p) ? { owner: this.owners.get(p) } : {}),
      }));
  }

  /**
   * Open a tab. By the agent (the default): it becomes the agent's current tab and counts
   * as the agent's; `background` keeps it out of the human's view. By the human (the
   * new-tab command, "open link in new tab", restoring saved tabs): `byAgent: false`, so it
   * is theirs and the agent's target does not move.
   */
  async newPage(url?: string, opts?: { background?: boolean; byAgent?: boolean; openedBy?: 'agent' | 'human'; owner?: string }): Promise<PageInfo> {
    const byAgent = opts?.byAgent !== false;
    // Who opened it, which can differ from who is opening it now: restoring saved tabs is the
    // human's act, but a tab the agent had opened is still the agent's to tidy up.
    const openedBy = opts?.openedBy ?? (byAgent ? 'agent' : 'human');
    const owner = opts?.owner?.trim() || undefined;
    if (byAgent) this.markAgent();
    const [w, h] = this.defaultSize;
    const page = this.adopt(await this.app.openTab('about:blank', w, h, openedBy, owner));
    if (openedBy === 'agent') this.agentPages.add(page);
    await this.prepPage(page); // fail-fast passkeys before navigating anywhere
    if (url) await page.goto(url).catch(() => undefined);
    if (byAgent || !this.agentActive) this.setAgentTarget(page, byAgent ? 'agent' : 'human');
    this.pageOpenedCb?.(page, page.id, !opts?.background);
    this.pagesChangedCb?.();
    return {
      index: [...this.pages.values()].indexOf(page),
      pageId: page.id,
      url: page.url(),
      title: page.title(),
      selected: page === this.agentActive,
      humanViewing: page === this.humanActive,
      openedBy,
      ...(owner ? { owner } : {}),
    };
  }

  /** Size for tabs opened before any panel has measured itself. Panels correct it on attach. */
  defaultSize: [number, number] = [1280, 800];

  /** Set the agent's current tab. The human's view moves only with bringToFront. */
  async selectPage(pageId: string, bringToFront = false): Promise<void> {
    this.markAgent();
    const page = this.pageFor(pageId);
    this.setAgentTarget(page, 'agent');
    if (bringToFront) this.pageRevealCb?.(pageId);
  }

  /** The human is looking at a page's panel. Recorded for list_pages and get_activity; it
   *  does NOT retarget the agent, except when the agent has no tab at all. */
  async focusPage(pageId: string): Promise<void> {
    const page = this.pageById(pageId);
    if (!page || this.humanActive === page) return;
    this.humanActive = page;
    this.pushEvent('tab-activated', page.id, page.url(), 'human');
    if (!this.agentActive || this.agentActive.isClosed()) this.agentActive = page;
    this.pagesChangedCb?.();
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
    pageId?: string,
  ): Promise<{ url: string; title: string }> {
    this.markAgent();
    const p = this.pageFor(pageId);
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

  /** Interactive elements with stable uids, optionally filtered. See snapshotScript. */
  async takeSnapshot(opts: SnapshotOptions & OnPage = {}): Promise<string> {
    const { pageId, ...filters } = opts;
    const p = this.pageFor(pageId);
    const start = this.uidSeq.get(p) ?? 0;
    const r = await p.evaluate<SnapshotResult>(snapshotScript, { ...filters, seqStart: start, secretSrc: CREDENTIAL.source, secretAuto: SECRET_AUTOCOMPLETE });
    this.uidSeq.set(p, Math.max(start, r.seq));
    return r.text;
  }

  /** The page's visible text (and optionally its links). See readPageScript. */
  async readPage(opts: ReadPageOptions & OnPage = {}): Promise<ReadPageResult> {
    const { pageId, ...rest } = opts;
    return this.pageFor(pageId).evaluate<ReadPageResult>(readPageScript, rest);
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
  private async locate(p: AppPage, t: Target): Promise<ElementBox & { label: string }> {
    const selector = this.selectorFor(t);
    const r = await p.evaluate<{ count: number; box?: ElementBox & { label: string } }>(
      `(sel) => { ${FIND_JS}
        const hits = find(sel);
        if (!hits.length) return { count: 0 };
        const el = hits[0];
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        const label = String(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 100);
        return { count: hits.length, box: { x: r.x, y: r.y, width: r.width, height: r.height, label } };
      }`,
      selector,
    );
    if (!r.count) {
      throw new Error(
        t.uid
          ? `uid ${t.uid} is gone — that element was removed or the page navigated. Call take_snapshot again (narrow it with withinSelector or textContains).`
          : `No element matches selector: ${t.selector}`,
      );
    }
    if (t.uid && r.count > 1) throw new Error(`uid ${t.uid} is on ${r.count} elements (the page copied it) — call take_snapshot again.`);
    return r.box!;
  }

  /** Flash the element in the human's panel so they can see what the agent touched. */
  private emitHighlight(p: AppPage, box: ElementBox): void {
    if (this.highlightCb && box.width > 0 && box.height > 0) this.highlightCb(p.id, box);
  }

  async click(opts: Target & OnPage & { dblClick?: boolean; allowPayment?: boolean }): Promise<ClickResult> {
    this.markAgent();
    const p = this.pageFor(opts.pageId);
    const box = await this.locate(p, opts);
    if (COMMITTING.test(box.label) && opts.allowPayment !== true) return paymentRefusal(box.label);
    await p.evaluate(EFFECT_START).catch(() => undefined);
    await this.pressBox(p, box, opts.dblClick === true);
    await delay(400);
    const effect = await p.evaluate<{ changed: boolean }>(EFFECT_READ).catch(() => ({ changed: true }));
    return { clicked: box.label || opts.selector || `uid ${opts.uid}`, ...(effect.changed ? {} : { noVisibleEffect: true }) };
  }

  /**
   * Upload files from this Mac into a file input, or through the picker a button opens. The app
   * checks the paths and the human confirms them (unless `ask` is false: the workspace's
   * cobrowser.uploadsWithoutAsking, and the app then notifies them of each upload); then a file input is clicked from script (a
   * hidden one cannot take a real click) and anything else gets a real click, and the picker
   * that opens takes the files instead of showing.
   */
  async uploadFile(opts: Target & OnPage & { filePaths: string[]; ask?: boolean }): Promise<UploadResult> {
    this.markAgent();
    const p = this.pageFor(opts.pageId);
    const selector = this.selectorFor(opts);
    const el = await p.evaluate<{ count: number; fileInput: boolean; multiple: boolean; inputs: number }>(
      `(sel) => { ${FIND_JS}
        const hits = find(sel); const el = hits[0];
        const fileInput = el instanceof HTMLInputElement && el.type === 'file';
        return { count: hits.length, fileInput, multiple: fileInput && el.multiple, inputs: find('input[type=file]').length };
      }`,
      selector,
    );
    if (!el.count) await this.locate(p, opts); // throws the "uid is gone" / "no element" guidance
    // Known before the human is asked: a single-file input cannot take several.
    if (el.fileInput && !el.multiple && opts.filePaths.length > 1) {
      return { error: `that file input takes one file and ${opts.filePaths.length} were given: upload them one at a time, or find the input that takes several` };
    }
    // The click rule holds here too: a button that pays or places an order is the human's.
    if (!el.fileInput) {
      const { label } = await this.locate(p, opts);
      // The same refusal as click's, so an agent reads one shape whichever tool refused.
      if (COMMITTING.test(label)) return { ...paymentRefusal(label), needsUserAction: `target the file input or the upload button itself; "${label}" is the human's to click` };
    }
    const armed = await this.app.uploadArm(p.tabId, opts.filePaths, opts.ask !== false);
    if (!armed.armed) return { error: armed.error ?? 'the upload was not allowed', ...(armed.declined ? { declined: true } : {}) };
    try {
      if (el.fileInput) {
        await p.cdp('Runtime.evaluate', { expression: `(() => { ${FIND_JS} find(${JSON.stringify(selector)})[0].click(); })()`, userGesture: true });
      } else {
        await this.pressBox(p, await this.locate(p, opts), false);
      }
    } catch (e) {
      await this.app.uploadOutcome(p.tabId, 0).catch(() => undefined); // disarm: no later picker gets them
      throw e;
    }
    const r = await this.app.uploadOutcome(p.tabId);
    if (r.noPicker) {
      return {
        error: `clicking ${opts.uid ? `uid ${opts.uid}` : opts.selector} did not open a file picker.${el.inputs ? ` The page has ${el.inputs} file input${el.inputs === 1 ? '' : 's'}: pass one as selector "input[type=file]" (hidden ones work too).` : ''}`,
      };
    }
    return r;
  }

  /** Move to an element and click it (the input half of click, without its rule). */
  private async pressBox(p: AppPage, box: ElementBox, dblClick: boolean): Promise<void> {
    this.emitHighlight(p, box);
    // Real input (Input.dispatchMouseEvent through the tab's own debugger) — frameworks like
    // React treat it as genuine, unlike element.click() from evaluate_script. Approach along
    // a path first: a teleport-and-press skips every hover/mouseover the page expects (menus
    // that open on hover, for one) and is a shape no hand produces.
    const at = await this.moveMouseTo(p, box);
    const press = async (clickCount: number): Promise<void> => {
      await p.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount });
      await delay(40 + Math.random() * 70);
      await p.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount });
    };
    await press(1);
    if (dblClick) await press(2);
  }

  /**
   * Walk the cursor to a box instead of teleporting onto it, so pages that reveal UI on
   * hover get the mousemove stream they wait for, and the motion has the shape of a hand.
   * Eased and slightly jittered: a straight constant-velocity line is its own tell.
   */
  private async moveMouseTo(p: AppPage, box: ElementBox, steps = 14): Promise<{ x: number; y: number }> {
    // Aim off-centre: every click landing on the exact centroid is not human either.
    const target = {
      x: box.x + box.width * (0.35 + Math.random() * 0.3),
      y: box.y + box.height * (0.35 + Math.random() * 0.3),
    };
    const from = this.cursors.get(p) ?? { x: target.x - 220, y: target.y - 160 };
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
    this.cursors.set(p, target);
    return target;
  }

  async fill(opts: Target & OnPage & { value: string; allowCredentials?: boolean }): Promise<FillResult> {
    this.markAgent();
    const p = this.pageFor(opts.pageId);
    // The rule (guards.ts): a secret field is the human's to type, or the vault's to fill.
    const info = await p.evaluate<{ secret: boolean; name: string } | null>(
      `(sel, credSrc, auto) => { ${FIND_JS} ${SECRET_JS} return secretInfo(find(sel)[0], credSrc, auto); }`,
      this.selectorFor(opts),
      CREDENTIAL.source,
      SECRET_AUTOCOMPLETE,
    );
    if (!info) await this.locate(p, opts); // throws the "uid is gone" / "no element" guidance
    if (info?.secret && opts.allowCredentials !== true) return { filled: 0, ...credentialRefusal([info.name]) };
    // A <select> has no keyboard path in an offscreen page (its popup cannot show): choose
    // the option by visible text or value and fire the events frameworks listen for.
    const selector = this.selectorFor(opts);
    // Date, time and color fields likewise: their picker cannot show, and typed keys go into
    // locale-formatted segments, so the value (YYYY-MM-DD, HH:MM, #rrggbb…) is set directly.
    const pickerValue = await p.evaluate<{ ok: boolean; type: string } | false>(
      `(sel, want) => { ${FIND_JS}
        const el = find(sel)[0];
        const PICKERS = ['date', 'time', 'datetime-local', 'month', 'week', 'color'];
        if (!el || el.tagName !== 'INPUT' || !PICKERS.includes(el.type)) return false;
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(el, want);
        if (want !== '' && el.value === '') return { ok: false, type: el.type };
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, type: el.type };
      }`,
      this.selectorFor(opts),
      opts.value,
    );
    if (pickerValue) {
      if (!pickerValue.ok) {
        const formats: Record<string, string> = { date: 'YYYY-MM-DD', time: 'HH:MM', 'datetime-local': 'YYYY-MM-DDTHH:MM', month: 'YYYY-MM', week: 'YYYY-Www', color: '#rrggbb' };
        throw new Error(`"${opts.value}" is not a valid value for that ${pickerValue.type} field — use ${formats[pickerValue.type] ?? 'its standard format'}`);
      }
      this.emitHighlight(p, await this.locate(p, opts));
      return { filled: 1 };
    }
    const picked = await p.evaluate<string | null | false>(
      `(sel, want) => { ${FIND_JS}
        const el = find(sel)[0];
        if (!el || el.tagName !== 'SELECT') return false;
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const all = Array.from(el.options);
        const norm = (t) => t.trim().toLowerCase();
        const o = all.find((x) => x.text.trim() === want) ?? all.find((x) => x.value === want) ?? all.find((x) => norm(x.text) === norm(want)) ?? all.find((x) => norm(x.text).includes(norm(want)));
        if (!o) return null;
        el.selectedIndex = o.index;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return o.text;
      }`,
      selector,
      opts.value,
    );
    if (picked === null) throw new Error(`no option matches "${opts.value}" in that <select> — take_snapshot lists its options`);
    if (typeof picked === 'string') {
      this.emitHighlight(p, await this.locate(p, opts));
      return { filled: 1 };
    }
    // Focus with a real click, select whatever is there, then type over it: the page sees
    // exactly the events a person produces, so React-style controlled inputs update.
    await this.pressBox(p, await this.locate(p, opts), false);
    await p.evaluate(
      `(sel) => { ${FIND_JS}
        const el = find(sel)[0];
        if (!el) return;
        el.focus();
        if (typeof el.select === 'function') el.select();
        else document.execCommand('selectAll');
      }`,
      this.selectorFor(opts),
    );
    if (opts.value) await this.typeInto(p, opts.value, false);
    else await this.pressKey(p, 'Backspace', 'Backspace', 8);
    return { filled: 1 };
  }

  async fillForm(elements: (Target & { value: string })[], pageId?: string, allowCredentials = false): Promise<FillResult> {
    const p = this.pageFor(pageId);
    let filled = 0;
    const refused: string[] = [];
    for (const e of elements) {
      const r = await this.fill({ ...e, pageId: p.id, allowCredentials });
      filled += r.filled;
      if (r.refused) refused.push(...r.refused);
    }
    return refused.length ? { filled, ...credentialRefusal(refused) } : { filled };
  }

  /** Type into the focused element with real key events — unless it is a secret field. */
  async typeText(text: string, submitKey = false, pageId?: string, allowCredentials = false): Promise<FillResult> {
    this.markAgent();
    const p = this.pageFor(pageId);
    const info = await p.evaluate<{ secret: boolean; name: string } | null>(
      `(credSrc, auto) => { ${SECRET_JS} const el = document.activeElement; return el && el !== document.body ? secretInfo(el, credSrc, auto) : null; }`,
      CREDENTIAL.source,
      SECRET_AUTOCOMPLETE,
    );
    if (info?.secret && !allowCredentials) return { filled: 0, ...credentialRefusal([info.name]) };
    await this.typeInto(p, text, submitKey);
    return { filled: 1 };
  }

  /** Real key events, one character at a time, into whatever has focus. */
  private async typeInto(p: AppPage, text: string, submitKey: boolean): Promise<void> {
    for (const ch of text) {
      if (ch === '\n') {
        await this.pressKey(p, 'Enter', 'Enter', 13, '\r');
        continue;
      }
      const code = keyCodeFor(ch);
      await p.cdp('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      await p.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      await delay(15 + Math.random() * 45);
    }
    if (submitKey) await this.pressKey(p, 'Enter', 'Enter', 13, '\r');
  }

  /** `code` is the DOM code string ("Enter"); `vk` the Windows virtual key. Parameter TYPES
   *  matter: a number where the protocol wants a string aborts the whole app inside
   *  Electron's deserializer (the app guards the hot-path commands, but stay typed). */
  private async pressKey(p: AppPage, key: string, code: string, vk: number, text?: string): Promise<void> {
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
  async waitFor(texts: string[], timeout = 15000, pageId?: string, opts: { settle?: boolean; quietMs?: number } = {}): Promise<{ found?: string; settled?: boolean }> {
    const p = this.pageFor(pageId); // resolved once: the wait stays on this tab
    const deadline = Date.now() + timeout;
    // settle: also wait until the page has stopped changing (no DOM change for quietMs), so a
    // single-page app that swaps content after the URL changes is read when it is done.
    const quietMs = opts.settle ? Math.max(200, opts.quietMs ?? 500) : 0;
    if (quietMs) await this.run(() => p.evaluate(WATCH_START).catch(() => undefined), p.id);
    for (;;) {
      const body = texts.length ? await this.run(() => p.evaluate<string>(() => document.body?.innerText ?? '').catch(() => ''), p.id) : '';
      // Any of the texts, as in the own-browser bridge: wait for "Saved" or "Error" in one call.
      const found = texts.length ? texts.find((t) => body.includes(t)) : '';
      if (found !== undefined) {
        const hit = found ? { found } : {};
        if (!quietMs) return hit;
        const quiet = await this.run(() => p.evaluate<number>(WATCH_READ).catch(() => -1), p.id);
        if (quiet >= quietMs) return { ...hit, settled: true };
        if (quiet < 0) await this.run(() => p.evaluate(WATCH_START).catch(() => undefined), p.id); // it navigated
      }
      if (Date.now() > deadline) {
        throw new Error(found !== undefined && quietMs ? `Timed out after ${timeout}ms waiting for the page to stop changing` : `Timed out after ${timeout}ms waiting for any of: ${texts.join(', ')}`);
      }
      await delay(quietMs ? 150 : 300); // queue is free here — input/other actions can interleave
    }
  }

  async screenshot(opts?: OnPage & {
    format?: 'png' | 'jpeg' | 'webp';
    fullPage?: boolean;
    uid?: string;
  }): Promise<string> {
    const format = opts?.format ?? 'png';
    const p = this.pageFor(opts?.pageId);
    const params: Record<string, unknown> = { format, captureBeyondViewport: false };
    if (format === 'jpeg') params.quality = 85;
    if (opts?.uid) {
      const box = await this.locate(p, { uid: opts.uid });
      this.emitHighlight(p, box);
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
    const page = this.pageFor(opts.pageId);
    const r = await this.app.consoleMessages(page.tabId, opts.since ?? 0, { limit: opts.limit, level: opts.level });
    return { pageId: page.id, ...r };
  }

  /** The tab's request log: method, URL, status or error, timing. No bodies, no headers. */
  async networkRequests(opts: { pageId?: string; since?: number; limit?: number; failedOnly?: boolean; urlContains?: string; minStatus?: number } = {}): Promise<{ pageId: string; entries: RequestEntry[]; latest: number; pending: number }> {
    const page = this.pageFor(opts.pageId);
    const { pageId: _p, since, ...rest } = opts;
    const r = await this.app.networkRequests(page.tabId, since ?? 0, rest);
    return { pageId: page.id, ...r };
  }

  /** Logins the vault holds for the agent to use: hosts and usernames only. */
  listCredentials(): Promise<{ host: string; alsoOn?: string[]; username: string; noPassword?: boolean; notes?: string }[]> {
    return this.app.vaultList();
  }

  /** Fill a saved login into fields the agent chose; the app supplies the secret and checks
   *  the page is on that login's site. The agent only learns what got filled. */
  /** Fill a saved card into the page's card fields. The human confirms every fill in the app;
   *  the number and code are typed by the app and never come back. */
  fillCard(opts: OnPage & { card?: string }) {
    this.markAgent();
    return this.app.vaultFillCard(this.pageFor(opts.pageId).tabId, opts.card, 'agent');
  }

  listCards() {
    return this.app.vaultCards();
  }

  fillCredentials(opts: OnPage & { usernameUid?: string; passwordUid?: string; username?: string }) {
    this.markAgent();
    const { pageId, ...rest } = opts;
    return this.app.vaultFill(this.pageFor(pageId).tabId, rest);
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

  async evaluateScript(fn: string, args: unknown[] = [], pageId?: string): Promise<unknown> {
    this.markAgent(); // a navigation the script causes is the agent's
    // The function expression is evaluated in the page's global scope with the JSON args.
    return this.pageFor(pageId).evaluate(fn, ...args);
  }

  /** Current pages (stable id + URL) in creation order, synchronously — for persisting the
   *  open-tab list + panel layout so a reload can restore both. */
  pageEntries(): { id: string; url: string; by: 'agent' | 'human'; owner?: string }[] {
    return [...this.pages.values()].filter((p) => !p.isClosed()).map((p) => {
      const owner = this.owners.get(p);
      return { id: p.id, url: p.url(), by: this.agentPages.has(p) ? 'agent' : 'human', ...(owner ? { owner } : {}) };
    });
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
