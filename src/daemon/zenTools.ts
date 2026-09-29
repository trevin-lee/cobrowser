import type { Tool } from './toolSchema';
import { COMMITTING, paymentRefusal } from '../browser/guards';
import type { ZenHub } from './zenHub';

/**
 * The bridge_* tools: drive the human's OWN browser — Firefox (scoped to one container) or
 * Chrome (scoped to one tab group, or the profile) — through the Cobrowser Bridge extension.
 * Served by the daemon so the add-on's endpoint never moves with an editor window. Schemas are
 * plain JSON because the daemon speaks the low-level MCP server, not the zod-based one.
 *
 * The parameters use the panel tools' words (uid, function/args, timeout, elements, navigate
 * type), so an agent that learned one family knows the other. The add-on's older names (ref,
 * expression, timeoutMs, fields) are still accepted.
 */

const num = { type: 'number' } as const;
const str = { type: 'string' } as const;
const bool = { type: 'boolean' } as const;
const tabId = { ...num, description: 'From bridge_list_tabs.' };

export const ZEN_TOOLS: Tool[] = [
  {
    name: 'bridge_evaluate_script',
    description:
      "Run a JS function in a tab and get its JSON-serializable result back (an async function is awaited), like the panel's evaluate_script. THIS IS THE TOOL FOR BULK READS: to collect 50 order links, run `() => [...document.querySelectorAll('a[href*=\"/orders/\"]')].map(a => a.href)` in ONE call rather than snapshotting and clicking 50 times. Runs in the ISOLATED world by default (shares the DOM, not the page's JavaScript). Pass world:\"page\" only when you need the site's own globals or framework internals — that is logged. Treat it as READ-ONLY: it can technically touch the DOM, but use click/fill for changes so the human's guards apply. Every call is throttled.",
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        function: { ...str, description: 'A function, e.g. "() => document.title" or "(sel) => document.querySelectorAll(sel).length".' },
        args: { type: 'array', description: 'Arguments passed to the function (JSON values).' },
        world: { type: 'string', enum: ['isolated', 'page'] },
      },
      required: ['tabId', 'function'],
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
      'Wait until any of the given texts (or a selector) appears in a tab, and/or (settle: true) until the page stops changing — no DOM change for quietMs, default 500 — instead of guessing when a single-page app has finished rendering. Use settle after a click or navigation so you read the page once it is done updating. timeout is in ms (default 15000, at most 60000); errors at the timeout.',
    inputSchema: { type: 'object', properties: { tabId, text: { type: 'array', items: str }, selector: str, settle: bool, quietMs: num, timeout: num }, required: ['tabId'] },
  },
  {
    name: 'bridge_list_tabs',
    description:
      "List the tabs open in the human's OWN browser (Firefox or Chrome), limited to the container / tab group this workspace is bound to. Start here: these are real tabs with real sessions, so you can take over work already in progress instead of navigating from scratch. Returns a tabId for each, used by every other bridge_ tool, and openedBy: 'agent' for the tabs you opened — close those with bridge_close_tab when you are done with them; the rest are the human's.",
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
    description: "Open a new tab inside the bound container / tab group, optionally at a URL. It is yours: close it with bridge_close_tab when you no longer need it, so the human's browser is not left full of your tabs.",
    inputSchema: { type: 'object', properties: { url: str, active: bool } },
  },
  {
    name: 'bridge_close_tab',
    description: "Close a tab you opened with bridge_new_tab (openedBy: 'agent' in bridge_list_tabs). Tabs the human opened are refused: leave those, or ask the human.",
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
  },
  {
    name: 'bridge_activate_tab',
    description: 'Bring a tab to the front and focus its window — use it to show the human what you are working on.',
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
  },
  {
    name: 'bridge_navigate',
    description: 'Navigate a tab to a url, or back, forward or reload it, and wait for it to finish loading. Returns the SETTLED url/title, so redirects and failures are detectable.',
    inputSchema: { type: 'object', properties: { tabId, type: { type: 'string', enum: ['url', 'back', 'forward', 'reload'] }, url: str }, required: ['tabId'] },
  },
  {
    name: 'bridge_read_page',
    description: 'Read a tab as plain text (truncated). Cheaper than a screenshot when you only need the content.',
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
  },
  {
    name: 'bridge_snapshot',
    description:
      "Interactive elements in a tab, each with a `uid` for click/fill. Includes `href` for links — so twenty identical \"View order detail\" links can be navigated directly instead of clicked one at a time through pagination that resets. Sees into open shadow roots (sites built from web components). Lists <select> options so you can choose by visible text. Filter it: an unfiltered order-history page is 200+ mostly-unlabeled icon buttons — pass labeledOnly, textContains, role, withinSelector or limit. For bulk extraction prefer bridge_evaluate_script.",
    inputSchema: {
      type: 'object',
      properties: { tabId, labeledOnly: bool, textContains: str, role: str, withinSelector: str, limit: num },
      required: ['tabId'],
    },
  },
  {
    name: 'bridge_click',
    description:
      "Click an element by `uid` (from bridge_snapshot), CSS `selector`, or visible `text` — text is usually what you want, e.g. {text: 'Load more orders', exact: true}. Sees into open shadow roots. REFUSES buttons that pay or place an order, returning `needsUserAction` so you can hand that click to the human; pass allowPayment only if they asked you to complete the payment. Input here is synthetic (isTrusted: false) — no browser extension can send real clicks — and some sites ignore it: Google's and Cloudflare's consoles, among others. The result says noVisibleEffect when nothing on the page changed. When that happens, do the task in the cobrowser panel instead (new_page, then click/fill there), where input is real; the human signs in there once (fill_credentials for the password, the human for 2FA).",
    inputSchema: {
      type: 'object',
      properties: { tabId, uid: str, selector: str, text: str, exact: bool, allowPayment: bool },
      required: ['tabId'],
    },
  },
  {
    name: 'bridge_fill',
    description:
      "Set form values. For a <select>, pass the OPTION'S VISIBLE TEXT — it is chosen and driven with the focus/input/change/blur sequence frameworks listen for, because setting the value alone leaves React lists unrefreshed. REFUSES passwords, one-time codes, CVVs and card numbers, returning `needsUserAction`: the human types those. Never automate login or MFA. Values are set, not typed: a search-as-you-type field that waits for keystrokes (a picker whose results appear as you type) may not react — use the panel's fill or type_text for those, which type real keys.",
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        elements: {
          type: 'array',
          items: { type: 'object', properties: { uid: str, selector: str, value: str }, required: ['value'] },
        },
        allowCredentials: bool,
      },
      required: ['tabId', 'elements'],
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

/** The Firefox add-on already installed predates the rename of these tools and still names
 *  them firefox_* in its messages; re-signing it is a separate step, so the names are fixed
 *  on the way through. */
const currentNames = (text: string): string => text.replace(/\bfirefox_([a-z_]+)/g, 'bridge_$1');

const asJson = (v: unknown): { content: Content[] } => ({ content: [{ type: 'text', text: currentNames(JSON.stringify(v, null, 2)) }] });

/** When the add-on is older than this editor, what to tell the human. */
function staleNote(hub: ZenHub, workspace: string): string | undefined {
  const a = hub.addon?.(workspace);
  if (!a?.stale) return undefined;
  const how = a.browser === 'chrome'
    ? 'update cobrowser, then reload Cobrowser Bridge in chrome://extensions'
    : 'install the new signed Cobrowser Bridge .xpi in Firefox';
  return `The Cobrowser Bridge add-on in ${a.browser === 'chrome' ? 'Chrome' : 'Firefox'} is ${a.version ? `version ${a.version}` : 'an older version'}; this editor expects ${a.expected}. Some tools may not work until the human updates it (${how}).`;
}

/** Run one bridge_* tool for a workspace through its bridge connection. */
export async function callZenTool(
  hub: ZenHub,
  workspace: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Content[]; isError?: boolean }> {
  try {
    return await runZenTool(hub, workspace, name, args);
  } catch (e) {
    const note = staleNote(hub, workspace);
    throw new Error(currentNames((e as Error).message ?? String(e)) + (note ? ` (${note})` : ''));
  }
}

/** The add-on still says ref; the tools say uid, as the panel's do. */
const withUids = (snap: unknown): unknown => {
  const s = snap as { elements?: Record<string, unknown>[] } | null;
  if (!s || !Array.isArray(s.elements)) return snap;
  return { ...s, elements: s.elements.map(({ ref, ...rest }) => (ref === undefined ? rest : { uid: ref, ...rest })) };
};
const refOf = (o: Record<string, unknown>): unknown => o.uid ?? o.ref;

async function runZenTool(
  hub: ZenHub,
  workspace: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Content[]; isError?: boolean }> {
  const { tabId } = args as { tabId?: number };
  switch (name) {
    case 'bridge_evaluate_script': {
      let expression = args.expression;
      if (typeof args.function === 'string' && args.function.trim()) {
        const fnArgs = Array.isArray(args.args) ? args.args : [];
        expression = `(${args.function})(...${JSON.stringify(fnArgs)})`;
      }
      if (typeof expression !== 'string' || !expression.trim()) throw new Error('bridge_evaluate_script needs a function, e.g. "() => document.title"');
      return asJson(await hub.call(workspace, 'evaluate', { tabId, expression, world: args.world }));
    }
    case 'bridge_fetch':
      return asJson(await hub.call(workspace, 'fetchUrl', { tabId, url: args.url, method: args.method, headers: args.headers, body: args.body }));
    case 'bridge_wait_for': {
      const texts = Array.isArray(args.text) ? args.text.map(String) : typeof args.text === 'string' ? [args.text] : [];
      // An add-on older than several-texts support reads one string.
      const text = texts.length === 0 ? undefined : texts.length === 1 || hub.addon?.(workspace)?.stale ? texts[0] : texts;
      return asJson(await hub.call(workspace, 'waitFor', { tabId, text, selector: args.selector, settle: args.settle, quietMs: args.quietMs, timeoutMs: args.timeout ?? args.timeoutMs }));
    }
    case 'bridge_list_tabs': {
      const listed = await hub.call<Record<string, unknown>>(workspace, 'listTabs');
      const note = staleNote(hub, workspace);
      return asJson(note ? { ...listed, addonUpdate: note } : listed);
    }
    case 'bridge_close_tab':
      return asJson(await hub.call(workspace, 'closeTab', { tabId }));
    case 'bridge_list_containers':
      return asJson(await hub.call(workspace, 'listContainers'));
    case 'bridge_new_tab':
      return asJson(await hub.call(workspace, 'newTab', { url: args.url, active: args.active }));
    case 'bridge_activate_tab':
      await hub.call(workspace, 'activate', { tabId });
      return { content: [{ type: 'text', text: `activated tab ${tabId}` }] };
    case 'bridge_navigate': {
      const type = typeof args.type === 'string' ? args.type : 'url';
      if (type === 'url' && (typeof args.url !== 'string' || !args.url)) throw new Error('bridge_navigate: url is required for type "url"');
      // An older add-on ignores type and would treat back/forward/reload as a url-less load.
      if (type !== 'url' && hub.addon?.(workspace)?.stale) throw new Error(`bridge_navigate type "${type}" needs the current Cobrowser Bridge add-on`);
      return asJson(await hub.call(workspace, 'navigate', { tabId, type, url: args.url }));
    }
    case 'bridge_read_page':
      return asJson(await hub.call(workspace, 'readPage', { tabId }));
    case 'bridge_snapshot': {
      const { tabId: _t, ...options } = args;
      return asJson(withUids(await hub.call(workspace, 'snapshot', { tabId, options })));
    }
    case 'bridge_click': {
      const { tabId: _t, allowPayment, uid: _u, ...others } = args;
      const rest = { ...others, ref: refOf(args) };
      const pay = allowPayment === true;
      // allowDestructive is the add-on's old name for the same override.
      const click = (override: boolean) => hub.call<{ refused?: string; label?: string }>(workspace, 'click', { tabId, ...rest, allowPayment: override, allowDestructive: override });
      let result = await click(pay) as { refused?: string; label?: string; noVisibleEffect?: boolean; hint?: string };
      // An add-on from before the rule changed still refuses sign-out and delete-account
      // controls. That guard is gone, so go past it — but never past a payment button.
      if (result && result.refused === 'destructive') {
        result = COMMITTING.test(result.label ?? '') && !pay ? paymentRefusal(result.label ?? '') : await click(true);
      }
      if (result && result.noVisibleEffect) {
        result.hint = 'Nothing on the page changed after this click. The site may ignore synthetic input, which is all these tools can send. Do this step in the cobrowser panel (new_page, then click there), where input is real, or hand it to the human.';
      }
      return asJson(result);
    }
    case 'bridge_fill': {
      const list = (Array.isArray(args.elements) ? args.elements : Array.isArray(args.fields) ? args.fields : []) as Record<string, unknown>[];
      const fields = list.map((f) => ({ ref: refOf(f), selector: f.selector, value: f.value }));
      return asJson(await hub.call(workspace, 'fill', { tabId, fields, allowCredentials: args.allowCredentials }));
    }
    case 'bridge_screenshot': {
      const shot = await hub.call<{ data: string; mimeType: string }>(workspace, 'screenshot', { tabId, format: args.format });
      return { content: [{ type: 'image', data: shot.data, mimeType: shot.mimeType }] };
    }
    default:
      return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
  }
}
