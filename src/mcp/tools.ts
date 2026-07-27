import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserSession } from '../browser/BrowserSession';

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
    { description: 'List open browser pages/tabs.', inputSchema: {} },
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
      description: 'Open a new tab, optionally navigating to a URL. Becomes active unless background.',
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
      description: 'Close a browser tab by pageId. Refuses to close the last remaining tab.',
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
        'Click an element by uid (from take_snapshot) OR a CSS selector. Uses a TRUSTED CDP input click that frameworks (React etc.) accept as real input — unlike element.click() from evaluate_script, which fires untrusted events sites may ignore.',
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
        'Set the value of an input/textarea by uid (from take_snapshot) OR a CSS selector, using trusted keystrokes.',
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
      return asText(typeof result === 'string' ? result : JSON.stringify(result));
    },
  );
}
