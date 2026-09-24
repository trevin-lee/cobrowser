import * as vscode from 'vscode';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserSession } from '../browser/BrowserSession';
import { BrowserPanel } from '../webview/BrowserPanel';

type GetSession = () => Promise<BrowserSession>;

const asText = (text: string) => ({ content: [{ type: 'text' as const, text }] });

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
        "List open browser tabs. Each has openedBy: 'agent' (you or an earlier agent turn opened it) or 'human'. The human sees every tab as an editor tab, so keep the set small and tidy: before opening anything, reuse an 'agent' tab you are no longer using (navigate_page), and close_page any 'agent' tabs left over from finished work. Never close 'human' tabs unless asked.",
      inputSchema: {},
    },
    async () => {
      const s = await getSession();
      const pages = await s.run(() => s.listPages());
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
        "Open a new tab, optionally navigating to a URL. Becomes active unless background. Every tab you open is a tab in the human's editor, and leaving them behind is the top complaint — so: prefer navigate_page on the current tab when you are simply following a link; reuse a tab you opened earlier instead of opening another (list_pages shows which are yours via openedBy); keep at most one tab per task; and close_page your tabs the moment their work is done. Call get_editor_layout if you are unsure how crowded their editor already is.",
      inputSchema: { url: z.string().optional(), background: z.boolean().optional() },
    },
    async ({ url, background }) => {
      const s = await getSession();
      const info = await s.run(() => s.newPage(url, { background }));
      return asText(JSON.stringify(info));
    },
  );

  server.registerTool(
    'select_page',
    {
      description: 'Make a page active (also becomes the screencast target).',
      inputSchema: { pageId: z.string(), bringToFront: z.boolean().optional() },
    },
    async ({ pageId, bringToFront }) => {
      const s = await getSession();
      await s.run(() => s.selectPage(pageId, bringToFront ?? true));
      return asText(`selected page ${pageId}`);
    },
  );
  server.registerTool(
    'close_page',
    {
      description:
        "Close a tab by pageId. Use it routinely: when a task ends, close every tab you opened for it (list_pages marks yours with openedBy: 'agent') so the human's editor is left as you found it. Do not close 'human' tabs unless asked. Refuses to close the last remaining tab.",
      inputSchema: { pageId: z.string() },
    },
    async ({ pageId }) => {
      const s = await getSession();
      // Refuse to close the last tab: for a human, closing the final editor tab
      // intentionally quits the browser, but an agent doing so mid-task would
      // yank the browser out from under itself. Keep at least one tab alive.
      const pages = await s.run(() => s.listPages());
      if (pages.length <= 1) {
        return asText('refused: cannot close the last remaining tab (open another first)');
      }
      await s.run(() => s.closePage(pageId));
      return asText(`closed page ${pageId}`);
    },
  );

  server.registerTool(
    'navigate_page',
    {
      description:
        'Navigate the active page. Returns the SETTLED {url,title} after load (not the requested url), so redirects/failures are detectable.',
      inputSchema: {
        type: z.enum(['url', 'back', 'forward', 'reload']),
        url: z.string().optional(),
        timeout: z.number().optional(),
      },
    },
    async ({ type, url, timeout }) => {
      const s = await getSession();
      const landed = await s.run(() => s.navigate(type, url, timeout));
      return asText(JSON.stringify({ requested: url ?? null, url: landed.url, title: landed.title }));
    },
  );

  server.registerTool(
    'take_snapshot',
    {
      description:
        'Return an interactive-element text tree of the active page. Each node has a [uid] used by click/fill. uids expire on any DOM change — re-snapshot before reusing them.',
      inputSchema: {},
    },
    async () => {
      const s = await getSession();
      return asText(await s.run(() => s.takeSnapshot()));
    },
  );

  server.registerTool(
    'take_screenshot',
    {
      description: 'Screenshot the active page (or a single element by uid). Returns an image.',
      inputSchema: {
        format: z.enum(['png', 'jpeg', 'webp']).optional(),
        fullPage: z.boolean().optional(),
        uid: z.string().optional(),
      },
    },
    async ({ format, fullPage, uid }) => {
      const s = await getSession();
      const data = await s.run(() => s.screenshot({ format, fullPage, uid }));
      return { content: [{ type: 'image' as const, data, mimeType: `image/${format ?? 'png'}` }] };
    },
  );

  server.registerTool(
    'click',
    {
      description:
        'Click an element by uid (from take_snapshot) OR a CSS selector. A real input click (the cursor moves there, presses, releases) that frameworks (React etc.) accept as genuine — unlike element.click() from evaluate_script, which fires untrusted events sites may ignore.',
      inputSchema: { uid: z.string().optional(), selector: z.string().optional(), dblClick: z.boolean().optional() },
    },
    async ({ uid, selector, dblClick }) => {
      const s = await getSession();
      await s.run(() => s.click({ uid, selector, dblClick }));
      return asText(`clicked ${uid ?? selector}`);
    },
  );

  server.registerTool(
    'fill',
    {
      description:
        "Set the value of an input/textarea by uid (from take_snapshot) OR a CSS selector, using real keystrokes. For a <select>, pass the OPTION'S VISIBLE TEXT (or its value): it is chosen and the input/change events fired, since a dropdown cannot open in an offscreen page.",
      inputSchema: { uid: z.string().optional(), selector: z.string().optional(), value: z.string() },
    },
    async ({ uid, selector, value }) => {
      const s = await getSession();
      await s.run(() => s.fill({ uid, selector, value }));
      return asText(`filled ${uid ?? selector}`);
    },
  );

  server.registerTool(
    'fill_form',
    {
      description: 'Fill multiple fields (by uid or selector) in one call (preferred over repeated fill).',
      inputSchema: {
        elements: z.array(
          z.object({ uid: z.string().optional(), selector: z.string().optional(), value: z.string() }),
        ),
      },
    },
    async ({ elements }) => {
      const s = await getSession();
      await s.run(() => s.fillForm(elements));
      return asText(`filled ${elements.length} field(s)`);
    },
  );

  server.registerTool(
    'type_text',
    {
      description: 'Type text into the currently-focused element; optionally press Enter.',
      inputSchema: { text: z.string(), submitKey: z.boolean().optional() },
    },
    async ({ text, submitKey }) => {
      const s = await getSession();
      await s.run(() => s.typeText(text, submitKey));
      return asText(`typed ${text.length} char(s)`);
    },
  );

  server.registerTool(
    'wait_for',
    {
      description: 'Block until all given strings appear in the page text.',
      inputSchema: { text: z.array(z.string()), timeout: z.number().optional() },
    },
    async ({ text, timeout }) => {
      const s = await getSession();
      // No outer run(): waitFor queues each poll itself and frees the queue
      // between polls, so a long wait doesn't freeze human input / other actions.
      await s.waitFor(text, timeout);
      return asText(`found: ${text.join(', ')}`);
    },
  );

  server.registerTool(
    'evaluate_script',
    {
      description:
        'Escape hatch: evaluate a JS function expression in the active page, e.g. "() => document.title". `args` are plain JSON passed to the function. NOTE: synthetic .click()/dispatchEvent from here is NOT trusted input (React etc. may ignore it) — use click/fill by uid (from take_snapshot) for real interactions.',
      inputSchema: { function: z.string(), args: z.array(z.any()).optional() },
    },
    async ({ function: fn, args }) => {
      const s = await getSession();
      const result = await s.run(() => s.evaluateScript(fn, args ?? []));
      // Never hand a filled password back: the vault scrubs its own values out of the text.
      return asText(await s.scrub(typeof result === 'string' ? result : JSON.stringify(result)));
    },
  );

  server.registerTool(
    'list_console_messages',
    {
      description:
        "What the page's console said: console.log/warn/error output, uncaught exceptions, and the browser's own resource-load errors (\"Failed to load resource: … 404\"). THE tool for \"why isn't this site working\": check it after a click or submit that did nothing. Defaults to the active page; pass `level: \"error\"` for errors only, `since` (the `latest` from a prior call) for only newer lines. Each entry carries the pageUrl it was logged on.",
      inputSchema: {
        pageId: z.string().optional(),
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
        "The page's request log: method, URL, HTTP status (or the network error), content type and timing, for documents, XHR/fetch, scripts, images — no bodies or headers. Use it to see what a form submit or API call actually returned (a 401, a 500, a CORS block, a request that never completed — `pending` counts those). Defaults to the active page; `failedOnly` keeps errors and 4xx/5xx; `urlContains` filters by URL; `since` (the `latest` from a prior call) returns only newer requests.",
      inputSchema: {
        pageId: z.string().optional(),
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
        "Logins THIS workspace may use, from the human's cobrowser vault — sites and usernames only, never passwords. Logins scoped to other workspaces are not listed and cannot be filled from here; if the site you need is missing, request_credential asks the human to grant one.",
      inputSchema: {},
    },
    async () => {
      const s = await getSession();
      return asText(JSON.stringify(await s.listCredentials(), null, 2));
    },
  );

  server.registerTool(
    'fill_credentials',
    {
      description:
        'Fill the saved login for the CURRENT site into fields you choose: pass the username and/or password field uids from take_snapshot. The password never enters your context — the app types it in directly and reports what it filled. Refused unless the page is on the login\'s site. Pass `username` when the site has more than one saved login. If it answers "no saved login", call request_credential — the human may hold one scoped to another workspace. Do NOT submit payment or MFA steps for the human.',
      inputSchema: {
        usernameUid: z.string().optional(),
        passwordUid: z.string().optional(),
        username: z.string().optional(),
      },
    },
    async (opts) => {
      const s = await getSession();
      return asText(JSON.stringify(await s.run(() => s.fillCredentials(opts))));
    },
  );

  server.registerTool(
    'request_credential',
    {
      description:
        'Ask the human to let THIS workspace use a saved login for a site (one that list_credentials does not show). They answer in the cobrowser app: allow it here from now on, allow it once, or deny — you learn only the outcome, never the password, and a denial looks the same as no such login. Give a one-line `reason` the human will read (what you are doing that needs it). After a grant, use fill_credentials. Blocks until they answer, up to a few minutes.',
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
