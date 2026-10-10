import * as vscode from 'vscode';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserSession } from '../browser/BrowserSession';
import { BrowserPanel } from '../webview/BrowserPanel';
import { humanTabRefusal } from '../browser/guards';

type GetSession = () => Promise<BrowserSession>;

const asText = (text: string) => ({ content: [{ type: 'text' as const, text }] });

/** Every page tool can act on any open tab, not just the agent's current one. */
const pageId = z
  .string()
  .optional()
  .describe(
    "Act on this tab (a pageId from list_pages) instead of your current one. Does not change your current tab or the human's view. Always pass it when another agent may be using this browser.",
  );

/**
 * cobrowser.uploadsWithoutAsking, from Workspace settings only: a value in the human's user
 * settings would turn it on in every workspace at once. Restricted in package.json, so VS Code
 * also ignores it in a workspace the human has not trusted.
 */
function uploadsWithoutAsking(): boolean {
  if (!vscode.workspace.isTrusted) return false;
  // The first folder is the workspace cobrowser serves, so its own .vscode/settings.json counts
  // in a multi-root window too.
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const v = vscode.workspace.getConfiguration('cobrowser', folder).inspect<boolean>('uploadsWithoutAsking');
  return (v?.workspaceFolderValue ?? v?.workspaceValue) === true;
}

/**
 * Register the cobrowser tool surface onto a fresh McpServer. Tool names/params mirror
 * chrome-devtools-mcp so the agent experience is consistent. Every handler routes through
 * `session.run()` so agent actions serialize against human (webview) actions.
 */
export function registerTools(server: McpServer, getSession: GetSession): void {
  server.registerTool(
    'list_pages',
    {
      description:
        "List open browser tabs. `selected` is YOUR current tab (what tools act on without a pageId); `humanViewing` is the tab the human is looking at — they are independent, and the human switching tabs does not move you. openedBy is 'agent' (you, an earlier agent turn, or a link you clicked) or 'human'; owner names the agent task a tab is for, when agents work in parallel (new_page owner). The human sees every tab as an editor tab, so keep the set small and tidy: reuse an 'agent' tab you are done with (navigate_page) before opening another, and close_page 'agent' tabs left over from finished work. Never close 'human' tabs unless asked.",
      inputSchema: {},
    },
    async () => {
      const s = await getSession();
      const pages = await s.listPages(); // the session's own state: waits on no tab's queue
      return asText(JSON.stringify(pages, null, 2));
    },
  );

  server.registerTool(
    'get_activity',
    {
      description:
        'Recent browser activity — page navigations and tab open/close/activate — each tagged source "agent" or "human". Call it to catch up on anything the human did MANUALLY since your last action, so you act on the current state instead of a stale view. Pass `since` (a seq from a prior call) to get only newer events.',
      inputSchema: { since: z.number().optional() },
    },
    async ({ since }) => {
      const s = await getSession();
      return asText(JSON.stringify(s.getActivity(since), null, 2));
    },
  );

  server.registerTool(
    'new_page',
    {
      description:
        "Open a new tab, optionally at a URL. It becomes your current tab and returns its pageId. It is shown in the human's editor unless background: true — use background when you are working on your own so you do not pull their view away. Every tab you open is a tab in the human's editor, and leaving them behind is the top complaint — so: prefer navigate_page on your current tab when you are simply following a link; reuse a tab you opened earlier instead of opening another (list_pages shows which are yours via openedBy); keep at most one tab per task; and close_page your tabs the moment their work is done. Working alongside other agents (subagents, parallel tasks)? Pass owner, a short name for your task (\"research-2\"), and then pass this tab's pageId to every tool: once any tab has an owner, a call without pageId is refused rather than risk acting in another agent's tab, and close_page only closes your owner's tabs.",
      inputSchema: { url: z.string().optional(), background: z.boolean().optional(), owner: z.string().optional() },
    },
    async ({ url, background, owner }) => {
      const s = await getSession();
      const info = await s.run(() => s.newPage(url, { background, owner }));
      return asText(JSON.stringify(info));
    },
  );

  server.registerTool(
    'select_page',
    {
      description:
        "Make a tab your current tab: the one tools act on when not given a pageId. It does NOT move the human's view unless bringToFront: true (they may be reading another tab — only bring it to the front when you want them to look). For a single action in another tab, pass pageId to that tool instead. Once any tab here has an owner (agents working in parallel), tools refuse calls without pageId, so the current tab no longer matters: use it only to bring a tab to the human's attention.",
      inputSchema: { pageId: z.string(), bringToFront: z.boolean().optional() },
    },
    async ({ pageId: id, bringToFront }) => {
      const s = await getSession();
      await s.run(() => s.selectPage(id, bringToFront ?? false), id);
      return asText(`your current tab is now ${id}${bringToFront ? ' (shown to the human)' : ''}`);
    },
  );
  server.registerTool(
    'close_page',
    {
      description:
        "Close a tab by pageId. Use it routinely: when a task ends, close every tab you opened for it (list_pages marks yours with openedBy: 'agent') so the human's editor is left as you found it. Tabs the human opened are refused unless you pass allowHumanTab: true, which you do only when they asked you to close that tab. A tab opened for another agent's task (its owner) is refused unless you pass that same owner. Refuses to close the last remaining tab.",
      inputSchema: { pageId: z.string(), allowHumanTab: z.boolean().optional(), owner: z.string().optional() },
    },
    async ({ pageId: id, allowHumanTab, owner }) => {
      const s = await getSession();
      const pages = await s.listPages();
      const page = pages.find((p) => p.pageId === id);
      if (!page) throw new Error(`No open page with id ${id} — list_pages shows the open tabs.`);
      // Another agent's task tab is that agent's to close: pass the owner you opened it with.
      if (page.owner && page.owner !== owner) {
        return asText(JSON.stringify({ refused: 'other-agent-tab', owner: page.owner, why: `This tab belongs to "${page.owner}", another agent's task. Close only your own: pass the owner you gave new_page.` }, null, 2));
      }
      if (page.openedBy === 'human' && allowHumanTab !== true) return asText(JSON.stringify(humanTabRefusal(id), null, 2));
      // Refuse to close the last tab: for a human, closing the final editor tab
      // intentionally quits the browser, but an agent doing so mid-task would
      // yank the browser out from under itself. Keep at least one tab alive.
      if (pages.length <= 1) {
        return asText('refused: cannot close the last remaining tab (open another first)');
      }
      s.markAgent(); // closePage is the human's too (the panel's ×); this one is the agent's
      await s.run(() => s.closePage(id), id);
      return asText(`closed page ${id}`);
    },
  );

  server.registerTool(
    'navigate_page',
    {
      description:
        'Navigate your current tab (or pageId). Returns the SETTLED {url,title} after load (not the requested url), so redirects/failures are detectable.',
      inputSchema: {
        type: z.enum(['url', 'back', 'forward', 'reload']).optional().describe('Default "url", which needs url.'),
        url: z.string().optional(),
        timeout: z.number().optional().describe('Milliseconds to wait for the page to load (default 30000).'),
        pageId,
      },
    },
    async ({ type = 'url', url, timeout, pageId: id }) => {
      const s = await getSession();
      const landed = await s.run(() => s.navigate(type, url, timeout, id), id);
      return asText(JSON.stringify({ requested: url ?? null, url: landed.url, title: landed.title }));
    },
  );

  server.registerTool(
    'take_snapshot',
    {
      description:
        "The things you can ACT on in your current tab (or pageId): visible interactive elements (links with their destination, buttons, inputs with their current value, selects with their options, open shadow roots included), each with a [uid] for click/fill. uids are STABLE — an element keeps its uid as long as it exists — so do not re-snapshot after every action: snapshot again only after a navigation, when new UI appears that you need, or when a click reports a uid is gone. Keep it small: withinSelector (e.g. \"form\", \"[role=dialog]\", \"main\"), textContains (matches labels; with a \"/\" it matches link destinations, e.g. \"/orders/\"), role (\"button\", \"link\", \"input\"), labeledOnly. To READ the page use read_page instead; to pull many values at once use evaluate_script. Embedded frames (a video player or widget from another site) show as [frame]: their contents are out of these tools' reach, so hand that part to the human.",
      inputSchema: {
        withinSelector: z.string().optional(),
        textContains: z.string().optional(),
        role: z.string().optional(),
        labeledOnly: z.boolean().optional(),
        limit: z.number().optional(),
        pageId,
      },
    },
    async (opts) => {
      const s = await getSession();
      // Scrubbed like every page read: a field the vault filled must never come back as text.
      return asText(await s.scrub(await s.run(() => s.takeSnapshot(opts), opts.pageId)));
    },
  );

  server.registerTool(
    'read_page',
    {
      description:
        "What your current tab (or pageId) SAYS: its visible text, cheaply — the default way to read content, check a result, or find what to do next. Far smaller than take_snapshot and gives no uids; call take_snapshot (filtered) only when you need to click or type. withinSelector reads one region (\"main\", \"table\", \"[role=dialog]\"); links: true adds each link's text and destination; maxChars caps the text (default 12000, and says when it cut).",
      inputSchema: {
        withinSelector: z.string().optional(),
        maxChars: z.number().optional(),
        links: z.boolean().optional(),
        pageId,
      },
    },
    async (opts) => {
      const s = await getSession();
      return asText(await s.scrub(JSON.stringify(await s.run(() => s.readPage(opts), opts.pageId), null, 2)));
    },
  );

  server.registerTool(
    'take_screenshot',
    {
      description: 'Screenshot your current tab (or pageId), or a single element by uid. Returns an image. Works on tabs the human is not looking at.',
      inputSchema: {
        format: z.enum(['png', 'jpeg', 'webp']).optional(),
        fullPage: z.boolean().optional(),
        uid: z.string().optional(),
        pageId,
      },
    },
    async ({ format, fullPage, uid, pageId: id }) => {
      const s = await getSession();
      const data = await s.run(() => s.screenshot({ format, fullPage, uid, pageId: id }), id);
      return { content: [{ type: 'image' as const, data, mimeType: `image/${format ?? 'png'}` }] };
    },
  );

  server.registerTool(
    'click',
    {
      description:
        'Click an element by uid (from take_snapshot; valid while the element exists) OR a CSS selector. A real input click (the cursor moves there, presses, releases) that frameworks (React etc.) accept as genuine — unlike element.click() from evaluate_script, which fires untrusted events sites may ignore. Check the outcome with read_page, not a fresh full snapshot. If the click opens a page dialog (confirm, prompt) or a file picker, it is shown to the human and the click waits for their answer (to attach files yourself, use upload_file). REFUSES buttons that pay or place an order (it reports the button instead of clicking), since the human owns that click; pass allowPayment only if they asked you to complete that payment.',
      inputSchema: { uid: z.string().optional(), selector: z.string().optional(), dblClick: z.boolean().optional(), allowPayment: z.boolean().optional(), pageId },
    },
    async ({ uid, selector, dblClick, allowPayment, pageId: id }) => {
      const s = await getSession();
      const r = await s.run(() => s.click({ uid, selector, dblClick, allowPayment, pageId: id }), id);
      if (!('clicked' in r)) return asText(JSON.stringify(r, null, 2));
      return asText(
        r.noVisibleEffect
          ? `clicked ${JSON.stringify(r.clicked)}, but nothing on the page changed within half a second — it may have missed its target or the page may still be working. Check with read_page or take_snapshot before repeating it.`
          : `clicked ${JSON.stringify(r.clicked)}`,
      );
    },
  );

  server.registerTool(
    'upload_file',
    {
      description:
        "Attach files from this Mac to the page: a résumé to a job application, a document to a form. Target the file input itself (by uid, or selector \"input[type=file]\": hidden inputs work) OR the button that opens a file picker (\"Upload\", \"Attach\", \"Choose file\"), by uid or selector. The human confirms the files and the site in the cobrowser app first, so this waits for them (unless they turned confirmation off for this workspace). filePaths are absolute (or start with ~/) and literal: no wildcards, no folders. Several files go in one call when the picker takes several; otherwise upload them one at a time. Hidden files and folders, ~/Library (apart from iCloud Drive and cloud-storage folders) and cobrowser's own data are always refused. Check the page with read_page afterwards: many sites upload on change and show the file once it is in.",
      inputSchema: {
        uid: z.string().optional(),
        selector: z.string().optional(),
        filePaths: z.array(z.string()).min(1).describe('Absolute paths of the files to attach, e.g. ["~/Documents/resume.pdf"]'),
        pageId,
      },
    },
    async ({ uid, selector, filePaths, pageId: id }) => {
      const s = await getSession();
      const r = await s.run(() => s.uploadFile({ uid, selector, filePaths, pageId: id, ask: !uploadsWithoutAsking() }), id);
      return asText('uploaded' in r && r.uploaded ? `uploaded ${r.uploaded.join(', ')} to ${r.host}` : JSON.stringify(r, null, 2));
    },
  );

  server.registerTool(
    'fill',
    {
      description:
        "Set the value of an input/textarea by uid (from take_snapshot) OR a CSS selector, using real keystrokes. For a <select>, pass the OPTION'S VISIBLE TEXT (or its value): it is chosen and the input/change events fired, since a dropdown cannot open in an offscreen page. Date, time and color fields take their standard value (2026-10-05, 14:30, #336699) and are set the same way. REFUSES password, one-time-code, card and security-code fields and reports them instead: the human types those, and a saved login goes in with fill_credentials, which never shows you the secret. Pass allowCredentials only for a value the human gave you for that field.",
      inputSchema: { uid: z.string().optional(), selector: z.string().optional(), value: z.string(), allowCredentials: z.boolean().optional(), pageId },
    },
    async ({ uid, selector, value, allowCredentials, pageId: id }) => {
      const s = await getSession();
      const r = await s.run(() => s.fill({ uid, selector, value, allowCredentials, pageId: id }), id);
      return asText(r.refused ? JSON.stringify(r, null, 2) : `filled ${uid ?? selector}`);
    },
  );

  server.registerTool(
    'fill_form',
    {
      description: 'Fill multiple fields (by uid or selector) in one call (preferred over repeated fill). The same rule as fill: secret fields are left for the human (or fill_credentials) and reported, unless allowCredentials.',
      inputSchema: {
        elements: z.array(
          z.object({ uid: z.string().optional(), selector: z.string().optional(), value: z.string() }),
        ),
        allowCredentials: z.boolean().optional(),
        pageId,
      },
    },
    async ({ elements, allowCredentials, pageId: id }) => {
      const s = await getSession();
      const r = await s.run(() => s.fillForm(elements, id, allowCredentials === true), id);
      return asText(r.refused ? JSON.stringify(r, null, 2) : `filled ${r.filled} field(s)`);
    },
  );

  server.registerTool(
    'type_text',
    {
      description: 'Type text into the currently-focused element; optionally press Enter. Refuses when the focused field is a password, one-time-code or card field, as fill does, unless allowCredentials.',
      inputSchema: { text: z.string(), submitKey: z.boolean().optional(), allowCredentials: z.boolean().optional(), pageId },
    },
    async ({ text, submitKey, allowCredentials, pageId: id }) => {
      const s = await getSession();
      const r = await s.run(() => s.typeText(text, submitKey, id, allowCredentials === true), id);
      return asText(r.refused ? JSON.stringify(r, null, 2) : `typed ${text.length} char(s)`);
    },
  );

  server.registerTool(
    'wait_for',
    {
      description:
        'Wait until any of the given strings appears in the page text (the result says which), and/or (settle: true) until the page stops changing — no DOM change for quietMs, default 500. Use settle after a click or navigation in a single-page app, so you read the page once it has finished updating rather than a half-rendered one.',
      inputSchema: { text: z.array(z.string()).optional(), settle: z.boolean().optional(), quietMs: z.number().optional(), timeout: z.number().optional(), pageId },
    },
    async ({ text, settle, quietMs, timeout, pageId: id }) => {
      const s = await getSession();
      const want = text ?? [];
      if (!want.length && !settle) return asText('nothing to wait for: pass text, settle: true, or both');
      // No outer run(): waitFor queues each poll itself and frees the queue
      // between polls, so a long wait doesn't freeze human input / other actions.
      const r = await s.waitFor(want, timeout, id, { settle, quietMs });
      return asText([r.found ? `found: ${r.found}` : '', r.settled ? 'the page has stopped changing' : ''].filter(Boolean).join('; '));
    },
  );

  server.registerTool(
    'evaluate_script',
    {
      description:
        'Evaluate a JS function expression in your current tab (or pageId) and get JSON back, e.g. "() => document.title". THE tool for bulk reads: collecting 50 order rows or every link in a table is ONE call — `() => [...document.querySelectorAll(\'tr\')].map(r => r.innerText)` — not a snapshot and 50 clicks. `args` are plain JSON passed to the function. Synthetic .click()/dispatchEvent from here is NOT trusted input (React etc. may ignore it) — use click/fill by uid for real interactions.',
      inputSchema: { function: z.string(), args: z.array(z.any()).optional(), pageId },
    },
    async ({ function: fn, args, pageId: id }) => {
      const s = await getSession();
      const result = await s.run(() => s.evaluateScript(fn, args ?? [], id), id);
      // Never hand a filled password back: the vault scrubs its own values out of the text.
      return asText(await s.scrub(typeof result === 'string' ? result : JSON.stringify(result)));
    },
  );

  server.registerTool(
    'list_console_messages',
    {
      description:
        "What the page's console said: console.log/warn/error output, uncaught exceptions, and the browser's own resource-load errors (\"Failed to load resource: … 404\"). THE tool for \"why isn't this site working\": check it after a click or submit that did nothing. Defaults to your current tab; pass `level: \"error\"` for errors only, `since` (the `latest` from a prior call) for only newer lines. Each entry carries the pageUrl it was logged on.",
      inputSchema: {
        pageId,
        since: z.number().optional(),
        limit: z.number().optional(),
        level: z.enum(['error', 'warning', 'all']).optional(),
      },
    },
    async ({ pageId, since, limit, level }) => {
      const s = await getSession();
      const r = await s.consoleMessages({ pageId, since, limit, level: level === 'all' ? undefined : level });
      return asText(await s.scrub(JSON.stringify(r, null, 2)));
    },
  );

  server.registerTool(
    'list_network_requests',
    {
      description:
        "The page's request log: method, URL, HTTP status (or the network error), content type and timing, for documents, XHR/fetch, scripts, images — no bodies or headers. Use it to see what a form submit or API call actually returned (a 401, a 500, a CORS block, a request that never completed — `pending` counts those). Defaults to your current tab; `failedOnly` keeps errors and 4xx/5xx; `minStatus` keeps statuses at or above it (400 for client errors); `urlContains` filters by URL; `since` (the `latest` from a prior call) returns only newer requests.",
      inputSchema: {
        pageId,
        since: z.number().optional(),
        limit: z.number().optional(),
        failedOnly: z.boolean().optional(),
        urlContains: z.string().optional(),
        minStatus: z.number().optional(),
      },
    },
    async (opts) => {
      const s = await getSession();
      const r = await s.networkRequests(opts);
      return asText(await s.scrub(JSON.stringify(r, null, 2)));
    },
  );

  server.registerTool(
    'list_credentials',
    {
      description:
        "Logins THIS workspace may use, from the human's cobrowser vault — sites and usernames only, never passwords, plus the saved cards (label, brand, last four digits) that fill_card can fill. A login or card can carry notes: the human's Markdown for you (which account to use, how 2FA works, what a card is for). Read them before you sign in or pay. alsoOn lists other websites the same login fills on (one account, several sign-in sites). noPassword marks an account that signs in with an emailed link or a one-time code: fill_credentials fills its username, and the human finishes. Logins scoped to other workspaces are not listed and cannot be filled from here; if the site you need is missing, request_credential asks the human to grant one.",
      inputSchema: {},
    },
    async () => {
      const s = await getSession();
      const cards = await s.listCards().catch(() => []);
      return asText(JSON.stringify({ logins: await s.listCredentials(), cards: cards.map(({ label, brand, last4, exp, notes }) => ({ label, brand, last4, exp, ...(notes ? { notes } : {}) })) }, null, 2));
    },
  );

  server.registerTool(
    'fill_credentials',
    {
      description:
        'Fill the saved login for the CURRENT site into fields you choose: pass the username and/or password field uids from take_snapshot. The password never enters your context — the app types it in directly and reports what it filled. A login with no password (noPassword: it signs in with a link or a code) fills only the username; submit it, then leave the link or the code to the human. Refused unless the page is on the login\'s site. Pass `username` when the site has more than one saved login. If it answers "no saved login", call request_credential — the human may hold one scoped to another workspace. Do NOT submit payment or MFA steps for the human.',
      inputSchema: {
        usernameUid: z.string().optional(),
        passwordUid: z.string().optional(),
        username: z.string().optional(),
        pageId,
      },
    },
    async (opts) => {
      const s = await getSession();
      return asText(JSON.stringify(await s.run(() => s.fillCredentials(opts), opts.pageId)));
    },
  );

  server.registerTool(
    'fill_card',
    {
      description:
        "Fill one of the human's saved cards (list_credentials shows them: label, brand, last four digits) into the card fields of your current tab (or pageId), including fields inside a payment provider's frames. The human confirms every fill in the cobrowser app (Touch ID or their Mac password), so this waits for them. You never see the number: it is masked in everything returned to you, and card fields read as (filled) in snapshots. Pass `card` (its label or last four digits) when several are saved. Filling is not paying: do not click the pay or place-order button unless the human asked you to complete the purchase (click refuses it without allowPayment).",
      inputSchema: { card: z.string().optional(), pageId },
    },
    async (opts) => {
      const s = await getSession();
      return asText(JSON.stringify(await s.run(() => s.fillCard(opts), opts.pageId)));
    },
  );

  server.registerTool(
    'request_credential',
    {
      description:
        'Ask the human to let THIS workspace use a saved login for a site (one that list_credentials does not show). They answer in the cobrowser app: allow it here from now on, allow it once (one sign-in: it lasts until the password is filled, so a username page and then a password page both work, and lapses after ten minutes), or deny — you learn only the outcome, never the password, and a denial looks the same as no such login. Give a one-line `reason` the human will read (what you are doing that needs it). After a grant, use fill_credentials. Blocks until they answer, up to a few minutes.',
      inputSchema: {
        site: z.string().describe('The site, e.g. "github.com" or the page URL'),
        username: z.string().optional(),
        reason: z.string().optional(),
      },
    },
    async (opts) => {
      const s = await getSession();
      return asText(JSON.stringify(await s.requestCredential(opts)));
    },
  );

  server.registerTool(
    'get_editor_layout',
    {
      description:
        "The human's editor layout: every editor group (pane), the tabs in each, and which tabs are cobrowser browser tabs. Call this BEFORE opening tabs if you are about to open several, and whenever the human mentions their layout being crowded. Browser tabs all share ONE dedicated pane; keep it that way — prefer navigating the current page or reusing an existing browser tab over opening new ones, and close browser tabs you no longer need (close_page) rather than leaving them stacked up.",
      inputSchema: {},
    },
    async () => {
      const panes = vscode.window.tabGroups.all.map((g) => ({
        pane: g.viewColumn,
        active: g.isActive,
        tabs: g.tabs.map((t) => ({
          label: t.label,
          active: t.isActive,
          kind: t.input instanceof vscode.TabInputWebview ? 'webview' : 'editor',
        })),
      }));
      const s = await getSession();
      const browserTabs = s.pageEntries().map((e) => ({
        pageId: e.id,
        url: e.url,
        pane: BrowserPanel.columnOf(e.id) ?? null, // null = not the visible tab in its pane
      }));
      return asText(
        JSON.stringify(
          {
            panes,
            browserTabs,
            cobrowserPane: BrowserPanel.targetColumn() ?? null,
            note:
              'New browser tabs open in cobrowserPane. A `pane` of null means that tab exists but is not currently the visible tab in its group.',
          },
          null,
          2,
        ),
      );
    },
  );
}
