import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ZenBridge } from '../zen/ZenBridge';

const asText = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const asJson = (value: unknown) => asText(JSON.stringify(value, null, 2));

/**
 * Tools that drive the human's OWN Zen browser through the Cobrowser Bridge extension,
 * scoped to the one container this workspace is bound to. Separate from the CDP-backed
 * tools (which drive the editor's embedded Chrome) because the tradeoffs differ: these see
 * the tabs and logins you already have open, but input is synthetic — see `zen_click`.
 */
export function registerZenTools(server: McpServer, zen: ZenBridge): void {
  server.registerTool(
    'zen_list_tabs',
    {
      description:
        "List the tabs open in the human's Zen browser, limited to the container this workspace is bound to. Start here: these are real tabs with real sessions, so you can take over work already in progress instead of navigating from scratch. Returns a tabId for each, used by every other zen_ tool.",
      inputSchema: {},
    },
    async () => asJson(await zen.call('listTabs')),
  );

  server.registerTool(
    'zen_list_containers',
    {
      description:
        'List every container in the Zen profile (names only — this does NOT grant access to their tabs). Use it to tell the human what they could bind this workspace to via the "cobrowser.zenContainer" setting.',
      inputSchema: {},
    },
    async () => asJson(await zen.call('listContainers')),
  );

  server.registerTool(
    'zen_new_tab',
    {
      description: 'Open a new tab inside the bound container, optionally at a URL.',
      inputSchema: { url: z.string().optional(), active: z.boolean().optional() },
    },
    async ({ url, active }) => asJson(await zen.call('newTab', { url, active })),
  );

  server.registerTool(
    'zen_activate_tab',
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
    'zen_navigate',
    {
      description:
        'Navigate a tab and wait for it to finish loading. Returns the SETTLED url/title, so redirects and failures are detectable.',
      inputSchema: { tabId: z.number(), url: z.string() },
    },
    async ({ tabId, url }) => asJson(await zen.call('navigate', { tabId, url })),
  );

  server.registerTool(
    'zen_read_page',
    {
      description: 'Read a tab as plain text (truncated). Cheaper than a screenshot when you only need the content.',
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => asJson(await zen.call('readPage', { tabId })),
  );

  server.registerTool(
    'zen_snapshot',
    {
      description:
        'List the interactive elements of a tab (links, buttons, inputs, selects). Each gets a [ref] used by zen_click and zen_fill. refs are written into the live DOM, so they go stale on navigation or re-render — re-snapshot before reusing them.',
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => asJson(await zen.call('snapshot', { tabId })),
  );

  server.registerTool(
    'zen_click',
    {
      description:
        'Click an element by ref (from zen_snapshot) or CSS selector. IMPORTANT: this is an UNTRUSTED synthetic click (isTrusted:false) — a browser extension cannot generate real input. It works on ordinary links, buttons and form controls, but sites that check event trust, native file pickers, and OS-level dialogs will not respond. When you need real input, use the CDP-backed `click` against the embedded browser instead.',
      inputSchema: { tabId: z.number(), ref: z.string().optional(), selector: z.string().optional() },
    },
    async ({ tabId, ref, selector }) => asJson(await zen.call('click', { tabId, ref, selector })),
  );

  server.registerTool(
    'zen_fill',
    {
      description:
        'Fill one or more fields in a tab, by ref (from zen_snapshot) or CSS selector. Values are set through the native value setter and followed by input/change events, so React/Vue-style frameworks pick them up. File inputs cannot be set at all — no extension can. Prefer one call with several fields over repeated calls.',
      inputSchema: {
        tabId: z.number(),
        fields: z.array(
          z.object({ ref: z.string().optional(), selector: z.string().optional(), value: z.string() }),
        ),
      },
    },
    async ({ tabId, fields }) => asJson(await zen.call('fill', { tabId, fields })),
  );

  server.registerTool(
    'zen_screenshot',
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
