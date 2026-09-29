import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import WebSocket from 'ws';
import { callZenTool, ZEN_TOOLS } from '../src/daemon/zenTools';
import { ZenHub } from '../src/daemon/zenHub';

type Addon = { browser: 'firefox' | 'chrome'; version: string | undefined; expected: string; stale: boolean } | undefined;
/** A hub that answers like an installed add-on would, recording what it was asked. */
function fakeHub(answer: (method: string, params: Record<string, unknown>) => unknown, addon: Addon = undefined) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const hub = {
    call: async (_ws: string, method: string, params: Record<string, unknown> = {}) => { calls.push({ method, params }); return answer(method, params); },
    addon: () => addon,
  } as unknown as ZenHub;
  return { hub, calls };
}
const json = (r: { content: { type: string; text?: string }[] }) => JSON.parse(r.content[0].text!);
const OLD: Addon = { browser: 'chrome', version: undefined, expected: '9.9.9', stale: true };

test('the bridge tools take the panel tools\' words: uid, function/args, timeout, elements, navigate type', () => {
  const props = (name: string) => Object.keys((ZEN_TOOLS.find((t) => t.name === name)!.inputSchema as { properties: object }).properties);
  assert.ok(props('bridge_click').includes('uid'));
  assert.deepEqual(['function', 'args'].filter((p) => props('bridge_evaluate_script').includes(p)), ['function', 'args']);
  assert.ok(props('bridge_wait_for').includes('timeout'));
  assert.ok(props('bridge_fill').includes('elements'));
  assert.ok(props('bridge_navigate').includes('type'));
  assert.ok(ZEN_TOOLS.some((t) => t.name === 'bridge_close_tab'));
});

test('a uid reaches the add-on as its ref, and the add-on\'s refs come back as uids', async () => {
  const { hub, calls } = fakeHub((m) => (m === 'snapshot' ? { url: 'x', elements: [{ ref: 'cb1', tag: 'button', label: 'Go' }] } : { ok: true }));
  const snap = json(await callZenTool(hub, '/ws', 'bridge_snapshot', { tabId: 1 }));
  assert.deepEqual(snap.elements, [{ uid: 'cb1', tag: 'button', label: 'Go' }]);
  await callZenTool(hub, '/ws', 'bridge_click', { tabId: 1, uid: 'cb1' });
  assert.equal(calls[1].params.ref, 'cb1');
  await callZenTool(hub, '/ws', 'bridge_fill', { tabId: 1, elements: [{ uid: 'cb2', value: 'a' }] });
  assert.deepEqual(calls[2].params.fields, [{ ref: 'cb2', selector: undefined, value: 'a' }]);
  await callZenTool(hub, '/ws', 'bridge_fill', { tabId: 1, fields: [{ ref: 'cb3', value: 'b' }] });
  assert.deepEqual(calls[3].params.fields, [{ ref: 'cb3', selector: undefined, value: 'b' }], 'the old names still work');
});

test('a function with args is run as a call; an expression still works; neither is an error', async () => {
  const { hub, calls } = fakeHub(() => 1);
  await callZenTool(hub, '/ws', 'bridge_evaluate_script', { tabId: 1, function: '(sel, n) => document.querySelectorAll(sel).length > n', args: ['a', 2] });
  assert.equal(calls[0].params.expression, '((sel, n) => document.querySelectorAll(sel).length > n)(...["a",2])');
  await callZenTool(hub, '/ws', 'bridge_evaluate_script', { tabId: 1, expression: 'document.title' });
  assert.equal(calls[1].params.expression, 'document.title');
  await assert.rejects(callZenTool(hub, '/ws', 'bridge_evaluate_script', { tabId: 1 }), /needs a function/);
});

test('wait_for takes several texts and timeout; an old add-on gets the first text it can read', async () => {
  const { hub, calls } = fakeHub(() => ({ found: true }));
  await callZenTool(hub, '/ws', 'bridge_wait_for', { tabId: 1, text: ['Done', 'Failed'], timeout: 5000 });
  assert.deepEqual([calls[0].params.text, calls[0].params.timeoutMs], [['Done', 'Failed'], 5000]);
  const old = fakeHub(() => ({ found: true }), OLD);
  await callZenTool(old.hub, '/ws', 'bridge_wait_for', { tabId: 1, text: ['Done', 'Failed'] });
  assert.equal(old.calls[0].params.text, 'Done');
});

test('navigate goes back, forward and reloads; an old add-on is told why it cannot', async () => {
  const { hub, calls } = fakeHub(() => ({ url: 'u' }));
  await callZenTool(hub, '/ws', 'bridge_navigate', { tabId: 1, type: 'back' });
  assert.equal(calls[0].params.type, 'back');
  await assert.rejects(callZenTool(hub, '/ws', 'bridge_navigate', { tabId: 1 }), /url is required/);
  const old = fakeHub(() => ({ url: 'u' }), OLD);
  await assert.rejects(callZenTool(old.hub, '/ws', 'bridge_navigate', { tabId: 1, type: 'reload' }), /needs the current Cobrowser Bridge add-on.*reload Cobrowser Bridge in chrome:\/\/extensions/);
  assert.equal(old.calls.length, 0);
});

test('an out-of-date add-on is named in list_tabs and in errors, with how to update it', async () => {
  const old = fakeHub(() => ({ container: 'profile', tabs: [] }), OLD);
  const listed = json(await callZenTool(old.hub, '/ws', 'bridge_list_tabs', {}));
  assert.match(listed.addonUpdate, /an older version; this editor expects 9\.9\.9/);
  const current = fakeHub(() => ({ container: 'profile', tabs: [] }), { ...OLD!, version: '9.9.9', stale: false });
  assert.equal(json(await callZenTool(current.hub, '/ws', 'bridge_list_tabs', {})).addonUpdate, undefined);
  const failing = { call: async () => { throw new Error('unknown method: closeTab'); }, addon: () => OLD } as unknown as ZenHub;
  await assert.rejects(callZenTool(failing, '/ws', 'bridge_close_tab', { tabId: 3 }), /unknown method: closeTab \(The Cobrowser Bridge add-on in Chrome/);
});

test('the hub records the add-on\'s version from its ready message and compares it with its own', async () => {
  const server = http.createServer((_q, r) => r.writeHead(404).end());
  const hub = new ZenHub(() => 't', () => ({ browser: 'chrome', container: 'profile' }), () => undefined, '1.2.3');
  hub.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const dial = (version?: string) => new Promise<WebSocket>((resolve) => {
    const ws = new WebSocket(ZenHub.url(port, 't', '/w') + '&browser=chrome');
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'hello') ws.send(JSON.stringify({ type: 'ready', container: { name: 'profile' }, version })); });
    ws.on('open', () => setTimeout(() => resolve(ws), 80));
  });
  const old = await dial(undefined);
  assert.deepEqual(hub.addon('/w'), { browser: 'chrome', version: undefined, expected: '1.2.3', stale: true });
  old.close(); await new Promise((r) => setTimeout(r, 50));
  const cur = await dial('1.2.3');
  assert.equal(hub.addon('/w')?.stale, false);
  assert.equal(hub.status('/w').version, '1.2.3');
  cur.close(); hub.close(); await new Promise<void>((r) => server.close(() => r()));
});

test('closing one of the human\'s tabs needs the override, passed through only when given', async () => {
  const { hub, calls } = fakeHub(() => ({ closed: 3 }));
  await callZenTool(hub, '/ws', 'bridge_close_tab', { tabId: 3 });
  await callZenTool(hub, '/ws', 'bridge_close_tab', { tabId: 3, allowHumanTab: true });
  assert.deepEqual(calls.map((c) => c.params.allowHumanTab), [false, true]);
});

test('in a workspace that is not bound, a bridge call says how the human binds one', async () => {
  const server = http.createServer((_q, r) => r.writeHead(404).end());
  const hub = new ZenHub(() => 't', () => undefined, () => undefined, '1.2.3');
  hub.attach(server);
  await assert.rejects(hub.call('/w', 'listTabs'), /not bound.*Bind Chrome Tab Group.*Bind Firefox Container/s);
  hub.close();
});
