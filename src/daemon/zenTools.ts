import type { Tool } from './toolSchema';
import type { ZenHub } from './zenHub';

/**
 * The bridge_* tools: drive the human's OWN browser — Firefox (scoped to one container) or
 * Chrome (scoped to one tab group, or the profile) — through the Cobrowser Bridge extension.
 * Served by the daemon so the add-on's endpoint never moves with an editor window. Schemas are
 * plain JSON because the daemon speaks the low-level MCP server, not the zod-based one.
 */

const num = { type: 'number' } as const;
const str = { type: 'string' } as const;
const bool = { type: 'boolean' } as const;
const tabId = { ...num, description: 'From bridge_list_tabs.' };

export const ZEN_TOOLS: Tool[] = [
  {
    name: 'bridge_evaluate_script',
    description:
      "Evaluate a JS expression in a tab and get JSON back. THIS IS THE TOOL FOR BULK READS: to collect 50 order links, evaluate `[...document.querySelectorAll('a[href*=\"/orders/\"]')].map(a => a.href)` in ONE call rather than snapshotting and clicking 50 times. Runs in the ISOLATED world by default (shares the DOM, not the page's JavaScript). Pass world:\"page\" only when you need the site's own globals or framework internals — that is logged. Treat it as READ-ONLY: it can technically touch the DOM, but use click/fill for changes so the human's guards apply. Every call is throttled.",
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        expression: { ...str, description: 'A JS expression, e.g. "document.title" or "[...document.links].map(a=>a.href)". Not a statement block.' },
        world: { type: 'string', enum: ['isolated', 'page'] },
      },
      required: ['tabId', 'expression'],
    },
  },
  {
    name: 'bridge_fetch',
    description:
      "Fetch a SAME-ORIGIN URL from a tab, carrying that tab's cookies — for JSON APIs and file downloads the page itself would load. Use it when a site has an export or an API behind the login (statements, order JSON) instead of scraping rendered HTML, and when a response is not scriptable (Firefox's JSON viewer). Cross-origin is refused: navigate a tab to that origin first. Throttled, and a 429/403/CAPTCHA triggers a one-minute backoff rather than a retry loop.",
    inputSchema: {
      type: 'object',
      properties: { tabId, url: str, method: str, headers: { type: 'object', additionalProperties: str }, body: str },
      required: ['tabId', 'url'],
    },
  },
  {
    name: 'bridge_wait_for',
    description:
      'Wait until text or a selector appears in a tab, instead of guessing when a single-page app has finished rendering. Returns as soon as it matches, or errors at the timeout.',
    inputSchema: { type: 'object', properties: { tabId, text: str, selector: str, timeoutMs: num }, required: ['tabId'] },
  },
  {
    name: 'bridge_list_tabs',
    description:
      "List the tabs open in the human's OWN browser (Firefox or Chrome), limited to the container / tab group this workspace is bound to. Start here: these are real tabs with real sessions, so you can take over work already in progress instead of navigating from scratch. Returns a tabId for each, used by every other bridge_ tool.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bridge_list_containers',
    description:
      'List the scopes available in the connected browser — Firefox containers, or Chrome tab groups plus "profile" (names only; this does NOT grant access to their tabs). Use it to tell the human what they could bind this workspace to.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bridge_new_tab',
    description: 'Open a new tab inside the bound container / tab group, optionally at a URL.',
    inputSchema: { type: 'object', properties: { url: str, active: bool } },
  },
  {
    name: 'bridge_activate_tab',
    description: 'Bring a tab to the front and focus its window — use it to show the human what you are working on.',
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
  },
  {
    name: 'bridge_navigate',
    description: 'Navigate a tab and wait for it to finish loading. Returns the SETTLED url/title, so redirects and failures are detectable.',
    inputSchema: { type: 'object', properties: { tabId, url: str }, required: ['tabId', 'url'] },
  },
  {
    name: 'bridge_read_page',
    description: 'Read a tab as plain text (truncated). Cheaper than a screenshot when you only need the content.',
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
  },
  {
    name: 'bridge_snapshot',
    description:
      "Interactive elements in a tab, each with a `ref` for click/fill. Includes `href` for links — so twenty identical \"View order detail\" links can be navigated directly instead of clicked one at a time through pagination that resets. Sees into open shadow roots (sites built from web components). Lists <select> options so you can choose by visible text. Filter it: an unfiltered order-history page is 200+ mostly-unlabeled icon buttons — pass labeledOnly, textContains, role, withinSelector or limit. For bulk extraction prefer bridge_evaluate_script.",
    inputSchema: {
      type: 'object',
      properties: { tabId, labeledOnly: bool, textContains: str, role: str, withinSelector: str, limit: num },
      required: ['tabId'],
    },
  },
  {
    name: 'bridge_click',
    description:
      "Click an element by `ref` (from bridge_snapshot), CSS `selector`, or visible `text` — text is usually what you want, e.g. {text: 'Load more orders', exact: true}. Sees into open shadow roots. REFUSES sign-out / delete-account / cancel-subscription controls, and payment or place-order buttons, returning `needsUserAction` so you can hand that step to the human; pass allowDestructive only if they explicitly asked. Input is synthetic (isTrusted: false), so a site that checks event trust may ignore it — report that to the human rather than working around it.",
    inputSchema: {
      type: 'object',
      properties: { tabId, ref: str, selector: str, text: str, exact: bool, allowDestructive: bool },
      required: ['tabId'],
    },
  },
  {
    name: 'bridge_fill',
    description:
      "Set form values. For a <select>, pass the OPTION'S VISIBLE TEXT — it is chosen and driven with the focus/input/change/blur sequence frameworks listen for, because setting the value alone leaves React lists unrefreshed. REFUSES passwords, one-time codes, CVVs and card numbers, returning `needsUserAction`: the human types those. Never automate login or MFA.",
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        fields: {
          type: 'array',
          items: { type: 'object', properties: { ref: str, selector: str, value: str }, required: ['value'] },
        },
        allowCredentials: bool,
      },
      required: ['tabId', 'fields'],
    },
  },
  {
    name: 'bridge_screenshot',
    description:
      "Screenshot a tab in the bound scope. Viewport only. In Chrome the tab is brought to the front first (Chrome can only capture a window's visible tab).",
    inputSchema: { type: 'object', properties: { tabId, format: { type: 'string', enum: ['png', 'jpeg'] } }, required: ['tabId'] },
  },
];

const ZEN_TOOL_NAMES = new Set(ZEN_TOOLS.map((t) => t.name));

export function isZenTool(name: string): boolean {
  return ZEN_TOOL_NAMES.has(name);
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
const asJson = (v: unknown): { content: Content[] } => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });

/** Run one bridge_* tool for a workspace through its bridge connection. */
export async function callZenTool(
  hub: ZenHub,
  workspace: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Content[]; isError?: boolean }> {
  const { tabId } = args as { tabId?: number };
  switch (name) {
    case 'bridge_evaluate_script':
      return asJson(await hub.call(workspace, 'evaluate', { tabId, expression: args.expression, world: args.world }));
    case 'bridge_fetch':
      return asJson(await hub.call(workspace, 'fetchUrl', { tabId, url: args.url, method: args.method, headers: args.headers, body: args.body }));
    case 'bridge_wait_for':
      return asJson(await hub.call(workspace, 'waitFor', { tabId, text: args.text, selector: args.selector, timeoutMs: args.timeoutMs }));
    case 'bridge_list_tabs':
      return asJson(await hub.call(workspace, 'listTabs'));
    case 'bridge_list_containers':
      return asJson(await hub.call(workspace, 'listContainers'));
    case 'bridge_new_tab':
      return asJson(await hub.call(workspace, 'newTab', { url: args.url, active: args.active }));
    case 'bridge_activate_tab':
      await hub.call(workspace, 'activate', { tabId });
      return { content: [{ type: 'text', text: `activated tab ${tabId}` }] };
    case 'bridge_navigate':
      return asJson(await hub.call(workspace, 'navigate', { tabId, url: args.url }));
    case 'bridge_read_page':
      return asJson(await hub.call(workspace, 'readPage', { tabId }));
    case 'bridge_snapshot': {
      const { tabId: _t, ...options } = args;
      return asJson(await hub.call(workspace, 'snapshot', { tabId, options }));
    }
    case 'bridge_click': {
      const { tabId: _t, ...rest } = args;
      return asJson(await hub.call(workspace, 'click', { tabId, ...rest }));
    }
    case 'bridge_fill':
      return asJson(await hub.call(workspace, 'fill', { tabId, fields: args.fields, allowCredentials: args.allowCredentials }));
    case 'bridge_screenshot': {
      const shot = await hub.call<{ data: string; mimeType: string }>(workspace, 'screenshot', { tabId, format: args.format });
      return { content: [{ type: 'image', data: shot.data, mimeType: shot.mimeType }] };
    }
    default:
      return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
  }
}
