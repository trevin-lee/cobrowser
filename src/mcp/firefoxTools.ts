import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { FirefoxBridge } from '../firefox/FirefoxBridge';

const asText = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const asJson = (value: unknown) => asText(JSON.stringify(value, null, 2));

/**
 * Tools that drive the human's OWN Zen browser through the Cobrowser Bridge extension,
 * scoped to the one container this workspace is bound to. Separate from the CDP-backed
 * tools (which drive the editor's embedded Chrome) because the tradeoffs differ: these see
 * the tabs and logins you already have open, but input is synthetic — see `firefox_click`.
 */
export function registerFirefoxTools(server: McpServer, zen: FirefoxBridge): void {
  server.registerTool(
    'firefox_evaluate_script',
    {
      description:
        "Evaluate a JS expression in a tab and get JSON back. THIS IS THE TOOL FOR BULK READS: to collect 50 order links, evaluate `[...document.querySelectorAll('a[href*=\"/orders/\"]')].map(a => a.href)` in ONE call rather than snapshotting and clicking 50 times. Runs in the ISOLATED world by default (shares the DOM, not the page's JavaScript). Pass world:\"page\" only when you need the site's own globals or framework internals — that is logged. Treat it as READ-ONLY: it can technically touch the DOM, but use click/fill for changes so the human's guards apply. Every call is throttled.",
      inputSchema: {
        tabId: z.number(),
        expression: z
          .string()
          .describe('A JS expression, e.g. "document.title" or "[...document.links].map(a=>a.href)". Not a statement block.'),
        world: z.enum(['isolated', 'page']).optional(),
      },
    },
    async ({ tabId, expression, world }) =>
      asJson(await zen.call('evaluate', { tabId, expression, world })),
  );

  server.registerTool(
    'firefox_fetch',
    {
      description:
        "Fetch a SAME-ORIGIN URL from a tab, carrying that tab's cookies — for JSON APIs and file downloads the page itself would load. Use it when a site has an export or an API behind the login (statements, order JSON) instead of scraping rendered HTML, and when a response is not scriptable (Firefox's JSON viewer). Cross-origin is refused: navigate a tab to that origin first. Throttled, and a 429/403/CAPTCHA triggers a one-minute backoff rather than a retry loop.",
      inputSchema: {
        tabId: z.number(),
        url: z.string(),
        method: z.string().optional(),
        headers: z.record(z.string()).optional(),
        body: z.string().optional(),
      },
    },
    async ({ tabId, url, method, headers, body }) =>
      asJson(await zen.call('fetchUrl', { tabId, url, method, headers, body })),
  );

  server.registerTool(
    'firefox_wait_for',
    {
      description:
        'Wait until text or a selector appears in a tab, instead of guessing when a single-page app has finished rendering. Returns as soon as it matches, or errors at the timeout.',
      inputSchema: {
        tabId: z.number(),
        text: z.string().optional(),
        selector: z.string().optional(),
        timeoutMs: z.number().optional(),
      },
    },
    async ({ tabId, text, selector, timeoutMs }) =>
      asJson(await zen.call('waitFor', { tabId, text, selector, timeoutMs })),
  );

  server.registerTool(
    'firefox_list_tabs',
    {
      description:
        "List the tabs open in the human's Zen browser, limited to the container this workspace is bound to. Start here: these are real tabs with real sessions, so you can take over work already in progress instead of navigating from scratch. Returns a tabId for each, used by every other firefox_ tool.",
      inputSchema: {},
    },
    async () => asJson(await zen.call('listTabs')),
  );

  server.registerTool(
    'firefox_list_containers',
    {
      description:
        'List every container in the Zen profile (names only — this does NOT grant access to their tabs). Use it to tell the human what they could bind this workspace to via the "cobrowser.zenContainer" setting.',
      inputSchema: {},
    },
    async () => asJson(await zen.call('listContainers')),
  );

  server.registerTool(
    'firefox_new_tab',
    {
      description: 'Open a new tab inside the bound container, optionally at a URL.',
      inputSchema: { url: z.string().optional(), active: z.boolean().optional() },
    },
    async ({ url, active }) => asJson(await zen.call('newTab', { url, active })),
  );

  server.registerTool(
    'firefox_activate_tab',
    {
      description: 'Bring a tab to the front and focus its window — use it to show the human what you are working on.',
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => {
      await zen.call('activate', { tabId });
      return asText(`activated tab ${tabId}`);
    },
  );

  server.registerTool(
    'firefox_navigate',
    {
      description:
        'Navigate a tab and wait for it to finish loading. Returns the SETTLED url/title, so redirects and failures are detectable.',
      inputSchema: { tabId: z.number(), url: z.string() },
    },
    async ({ tabId, url }) => asJson(await zen.call('navigate', { tabId, url })),
  );

  server.registerTool(
    'firefox_read_page',
    {
      description: 'Read a tab as plain text (truncated). Cheaper than a screenshot when you only need the content.',
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => asJson(await zen.call('readPage', { tabId })),
  );

  server.registerTool(
    'firefox_snapshot',
    {
      description:
        "Interactive elements in a tab, each with a `ref` for click/fill. Includes `href` for links — so twenty identical \"View order detail\" links can be navigated directly instead of clicked one at a time through pagination that resets. Sees into open shadow roots (sites built from web components). Lists <select> options so you can choose by visible text. Filter it: an unfiltered order-history page is 200+ mostly-unlabeled icon buttons — pass labeledOnly, textContains, role, withinSelector or limit. For bulk extraction prefer firefox_evaluate_script.",
      inputSchema: {
        tabId: z.number(),
        labeledOnly: z.boolean().optional(),
        textContains: z.string().optional(),
        role: z.string().optional(),
        withinSelector: z.string().optional(),
        limit: z.number().optional(),
      },
    },
    async ({ tabId, ...options }) => asJson(await zen.call('snapshot', { tabId, options })),
  );

  server.registerTool(
    'firefox_click',
    {
      description:
        "Click an element by `ref` (from firefox_snapshot), CSS `selector`, or visible `text` — text is usually what you want, e.g. {text: 'Load more orders', exact: true}. Sees into open shadow roots. REFUSES sign-out / delete-account / cancel-subscription controls, and payment or place-order buttons, returning `needsUserAction` so you can hand that step to the human; pass allowDestructive only if they explicitly asked. Input is synthetic (isTrusted: false), so a site that checks event trust may ignore it — report that to the human rather than working around it.",
      inputSchema: {
        tabId: z.number(),
        ref: z.string().optional(),
        selector: z.string().optional(),
        text: z.string().optional(),
        exact: z.boolean().optional(),
        allowDestructive: z.boolean().optional(),
      },
    },
    async ({ tabId, ...rest }) => asJson(await zen.call('click', { tabId, ...rest })),
  );

  server.registerTool(
    'firefox_fill',
    {
      description:
        "Set form values. For a <select>, pass the OPTION'S VISIBLE TEXT — it is chosen and driven with the focus/input/change/blur sequence frameworks listen for, because setting the value alone leaves React lists unrefreshed. REFUSES passwords, one-time codes, CVVs and card numbers, returning `needsUserAction`: the human types those. Never automate login or MFA.",
      inputSchema: {
        tabId: z.number(),
        fields: z.array(
          z.object({
            ref: z.string().optional(),
            selector: z.string().optional(),
            value: z.string(),
          }),
        ),
        allowCredentials: z.boolean().optional(),
      },
    },
    async ({ tabId, fields, allowCredentials }) =>
      asJson(await zen.call('fill', { tabId, fields, allowCredentials })),
  );

  server.registerTool(
    'firefox_screenshot',
    {
      description:
        'Screenshot a tab in the bound container. Captures the viewport only (no full-page capture is available through the extension APIs).',
      inputSchema: { tabId: z.number(), format: z.enum(['png', 'jpeg']).optional() },
    },
    async ({ tabId, format }) => {
      const shot = await zen.call<{ data: string; mimeType: string }>('screenshot', { tabId, format });
      return { content: [{ type: 'image' as const, data: shot.data, mimeType: shot.mimeType }] };
    },
  );
}
