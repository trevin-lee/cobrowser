import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import WebSocket from 'ws';
import { ZenHub } from '../src/daemon/zenHub';

/** A daemon-shaped server with a hub on it, plus a fake add-on that dials in. */
type Binding = { browser: 'firefox' | 'chrome'; container: string } | undefined;
const fx = (container: string): Binding => ({ browser: 'firefox', container });
async function setup(bindings: Record<string, Binding>, open?: Set<string>) {
  const server = http.createServer((_q, r) => r.writeHead(404).end());
  const hub = new ZenHub(() => 'admin-token', (ws) => bindings[ws], () => undefined, undefined, open ? (ws) => open.has(ws) : undefined);
  hub.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const dial = (workspace: string, token = 'admin-token', browser?: 'chrome') =>
    new Promise<{ ws: WebSocket; hellos: unknown[]; reqs: unknown[] }>((resolve, reject) => {
      const ws = new WebSocket(ZenHub.url(port, token, workspace) + (browser ? '&browser=' + browser : ''));
      const hellos: unknown[] = [];
      const reqs: unknown[] = [];
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'hello') { hellos.push(m); ws.send(JSON.stringify({ type: 'ready', container: { name: m.container, cookieStoreId: 'fx-' + m.container, color: null } })); }
        if (m.type === 'req') { reqs.push(m); ws.send(JSON.stringify({ type: 'res', id: m.id, ok: true, result: { echo: m.method, params: m.params } })); }
      });
      ws.on('open', () => setTimeout(() => resolve({ ws, hellos, reqs }), 80));
      ws.on('error', reject);
    });
  return { hub, port, dial, stop: () => new Promise<void>((r) => { hub.close(); server.close(() => r()); }) };
}

test('the URL for a workspace is stable: fixed port, admin token, workspace path — nothing per window', () => {
  const a = ZenHub.url(39273, 't', '/Users/me/Git/app');
  assert.equal(a, ZenHub.url(39273, 't', '/Users/me/Git/app'));
  assert.ok(a.includes('workspace=%2FUsers%2Fme%2FGit%2Fapp'));
});

test('a connecting add-on is told its workspace container and calls route to it', async () => {
  const s = await setup({ '/w/a': fx('personal') });
  const a = await s.dial('/w/a');
  assert.deepEqual((a.hellos[0] as { container: string }).container, 'personal');
  assert.equal(s.hub.status('/w/a').container?.name, 'personal');
  const r = (await s.hub.call('/w/a', 'listTabs', {})) as { echo: string };
  assert.equal(r.echo, 'listTabs');
  a.ws.close();
  await s.stop();
});

test('two workspaces are two sockets — one cannot receive the other\'s calls', async () => {
  const s = await setup({ '/w/a': fx('personal'), '/w/b': fx('work') });
  const a = await s.dial('/w/a');
  const b = await s.dial('/w/b');
  await s.hub.call('/w/b', 'readPage', { tabId: 7 });
  assert.equal(a.reqs.length, 0, 'workspace a saw nothing');
  assert.equal((b.reqs[0] as { params: { tabId: number } }).params.tabId, 7);
  a.ws.close(); b.ws.close();
  await s.stop();
});

test('a rebind re-hellos the existing socket instead of needing a reconnect', async () => {
  const bindings: Record<string, Binding> = { '/w/a': fx('personal') };
  const s = await setup(bindings);
  const a = await s.dial('/w/a');
  bindings['/w/a'] = fx('school');
  s.hub.rebind('/w/a');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(a.hellos.length, 2);
  assert.equal(s.hub.status('/w/a').container?.name, 'school');
  a.ws.close();
  await s.stop();
});

/** Dial with a token that is not the current one: what the socket receives, and how it ends. */
const dialWrong = (port: number, token: string) =>
  new Promise<{ code: number; messages: number }>((resolve) => {
    const ws = new WebSocket(ZenHub.url(port, token, '/w/a'));
    let messages = 0;
    ws.on('message', () => messages++);
    ws.on('close', (code) => resolve({ code, messages }));
    ws.on('error', () => resolve({ code: -1, messages }));
  });

test('a wrong token gets no hello and is closed as replaced; a missing workspace is refused', async () => {
  const s = await setup({ '/w/a': fx('personal') });
  // Told why (4003), so the add-on can say its URL is out of date, and nothing else.
  assert.deepEqual(await dialWrong(s.port, 'not-the-token'), { code: 4003, messages: 0 });
  await assert.rejects(new Promise((_r, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${s.port}/zen?token=admin-token`); ws.on('error', rej); ws.on('open', () => rej(new Error('should not open'))); }).catch(() => { throw new Error('refused'); }));
  await s.stop();
});

test('calls fail fast when no browser is connected, with instructions', async () => {
  const s = await setup({ '/w/a': fx('personal') });
  await assert.rejects(() => s.hub.call('/w/a', 'listTabs'), /No Firefox browser is connected/);
  await s.stop();
});

test('Firefox and Chrome can both be connected for one workspace; calls go to the bound one', async () => {
  const bindings: Record<string, Binding> = { '/w/a': { browser: 'chrome', container: 'profile' } };
  const s = await setup(bindings);
  const ff = await s.dial('/w/a');
  const ch = await s.dial('/w/a', 'admin-token', 'chrome');
  assert.equal((ff.hellos[0] as { container: string }).container, '', 'the unbound browser is told it has no scope');
  assert.equal((ch.hellos[0] as { container: string }).container, 'profile');
  assert.equal(s.hub.status('/w/a').browser, 'chrome');
  await s.hub.call('/w/a', 'listTabs');
  assert.equal(ff.reqs.length, 0); assert.equal(ch.reqs.length, 1);
  // rebinding to Firefox flips both hellos and the routing, on the same sockets
  bindings['/w/a'] = fx('personal'); s.hub.rebind('/w/a');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((ff.hellos[1] as { container: string }).container, 'personal');
  assert.equal((ch.hellos[1] as { container: string }).container, '');
  await s.hub.call('/w/a', 'listTabs');
  assert.equal(ff.reqs.length, 1);
  ff.ws.close(); ch.ws.close();
  await s.stop();
});

test('an unbound workspace whose editor window is closed is told so; one whose window is open is just unbound', async () => {
  const open = new Set<string>(['/w/open']);
  const s = await setup({}, open);
  const closed = await s.dial('/w/closed');
  const opened = await s.dial('/w/open');
  assert.equal((closed.hellos[0] as { windowClosed?: boolean }).windowClosed, true);
  assert.equal((opened.hellos[0] as { windowClosed?: boolean }).windowClosed, undefined);
  open.add('/w/closed');
  s.hub.rebindAll();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal((closed.hellos.at(-1) as { windowClosed?: boolean }).windowClosed, undefined, 'its window opened: told again, no longer closed');
  closed.ws.close(); opened.ws.close();
  await s.stop();
});

test('after the token is replaced, sockets opened with the old one are dropped and the old token opens nothing', async () => {
  let current = 'old-token';
  const server = http.createServer((_q, r) => r.writeHead(404).end());
  const hub = new ZenHub(() => current, () => fx('personal'), () => undefined);
  hub.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const ws = new WebSocket(ZenHub.url(port, 'old-token', '/w/a'));
  await new Promise((r) => ws.on('open', r));
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  current = 'new-token';
  assert.equal(hub.dropStale(), 1);
  assert.equal(await closed, 4001);
  assert.deepEqual(await dialWrong(port, 'old-token'), { code: 4003, messages: 0 }, 'the old token gets nothing, and is told it was replaced');
  hub.close(); await new Promise<void>((r) => server.close(() => r()));
});
