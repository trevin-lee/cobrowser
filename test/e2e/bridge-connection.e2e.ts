/* The whole bridge path, as an agent uses it: an MCP call to a real daemon, over the add-on's
 * own WebSocket, into the Chrome add-on in Chrome for Testing, and back. Binding, a fill and a
 * click on a page, the add-on told when the workspace's window closes, and the add-on finding
 * the daemon again after it restarts. Everything runs in scratch dirs and a scratch Chrome
 * profile, on a port of its own, with a token of its own: never the human's daemon or browser. */
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { suite, serve, html, sleep, ROOT, SCRATCH, chromeForTesting, chromeWithBridge } from './harness';
import { bridgeEndpointUrl } from '../../src/daemon/protocol';

const FORM = `<!doctype html><title>bridge form</title>
<input id=name> <button id=go onclick="document.getElementById('out').textContent = 'Hello ' + document.getElementById('name').value">Go</button>
<p id=out></p>`;

suite('bridge-connection', async (r) => {
  const exe = chromeForTesting();
  if (!exe) {
    r.note('skipped', 'no Chrome for Testing: set COBROWSER_E2E_CHROME, or run `npx playwright install chromium`');
    return;
  }
  const srv = await serve((_q, res) => { const [st, h, b] = html(FORM); res.writeHead(st, h); res.end(b); });
  const dir = path.join(SCRATCH, 'daemon');
  fs.mkdirSync(dir, { recursive: true });
  const tokenFile = path.join(dir, 'daemon-token');
  const token = crypto.randomUUID();
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const port = 41000 + Math.floor(Math.random() * 2000);
  const workspace = path.join(SCRATCH, 'ws-bridge');
  fs.mkdirSync(workspace, { recursive: true });
  const version = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  let daemon: ChildProcess | undefined;
  const startDaemon = async (): Promise<boolean> => {
    daemon = spawn(process.execPath, [path.join(ROOT, 'dist', 'daemon.js'), '--port', String(port), '--token-file', tokenFile, '--version', version], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      if (await fetch(`http://127.0.0.1:${port}/health`, { headers: auth }).then((x) => x.ok, () => false)) return true;
    }
    return false;
  };
  const stopDaemon = async (): Promise<void> => {
    const d = daemon;
    if (!d || d.exitCode !== null) return;
    d.kill('SIGTERM');
    await new Promise<void>((ok) => { d.once('exit', () => ok()); setTimeout(ok, 3000); });
  };
  // What an editor window does when it opens the folder: register, bound to Chrome's whole profile.
  const register = () => fetch(`http://127.0.0.1:${port}/register`, { method: 'POST', headers: auth, body: JSON.stringify({ id: workspace, name: 'ws-bridge', url: 'http://127.0.0.1:9/mcp', token: 'window-token', pid: process.pid, container: 'profile', browser: 'chrome' }) }).then((x) => x.ok);
  const deregister = () => fetch(`http://127.0.0.1:${port}/deregister`, { method: 'POST', headers: auth, body: JSON.stringify({ id: workspace }) }).then((x) => x.ok);

  // An agent connected with the daemon-wide token (unscoped): it names the workspace per call.
  const agent = async () => {
    const c = new Client({ name: 'bridge-connection-e2e', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; text: string }> => {
    const res = (await c.callTool({ name, arguments: { workspace: 'ws-bridge', ...args } })) as { isError?: boolean; content: { text?: string }[] };
    return { ok: !res.isError, text: res.content.map((x) => x.text ?? '').join('\n') };
  };
  const until = async (c: Client, ms: number) => {
    let last = { ok: false, text: '' };
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(500)) {
      last = await call(c, 'bridge_list_tabs').catch((e: Error) => ({ ok: false, text: e.message }));
      if (last.ok) break;
    }
    return last;
  };

  let bc: Awaited<ReturnType<typeof chromeWithBridge>>;
  try {
    r.check('setup: a scratch daemon starts on its own port', await startDaemon());
    r.check('setup: a workspace registers with it, bound to Chrome', await register());
    bc = await chromeWithBridge(exe, srv.base + '/', 'bridge-connection-profile');
    r.check('setup: the add-on runs in Chrome for Testing', !!bc);
    if (!bc) return;
    // What pasting the URL from Copy Bridge URL into the popup does.
    await bc.run(`chrome.storage.local.set({ endpoints: [${JSON.stringify(bridgeEndpointUrl(port, token, workspace))}] }).then(() => 1)`);

    const a = await agent();
    const listed = await until(a, 15000);
    r.check('an agent\'s bridge_list_tabs reaches the add-on through the daemon, bound to the profile', listed.ok && listed.text.includes(srv.base), listed);

    const opened = await call(a, 'bridge_new_tab', { url: srv.base + '/form', active: false });
    const tabId = (JSON.parse(opened.text || '{}') as { tabId?: number }).tabId;
    r.check('bridge_new_tab opens a tab and returns its id', opened.ok && typeof tabId === 'number', opened);
    await sleep(800);
    const filled = await call(a, 'bridge_fill', { tabId, elements: [{ selector: '#name', value: 'Ada' }] });
    const clicked = await call(a, 'bridge_click', { tabId, selector: '#go' });
    const read = await call(a, 'bridge_read_page', { tabId });
    r.check('a fill and a click on the page go through, and reading it shows their effect', filled.ok && clicked.ok && read.text.includes('Hello Ada'), { filled, clicked, read: read.text.slice(0, 300) });

    // The window closes: the add-on is told so, and the agent is told how to bind.
    await deregister();
    await sleep(800);
    const status = (await bc.run<{ error?: string; connected: boolean }[]>('statusList()')).value ?? [];
    const unbound = await call(a, 'bridge_list_tabs');
    // With no window open at all, the daemon answers before the bridge does: no workspaces open.
    r.check('when the workspace\'s window closes, the add-on is told so, and an agent\'s call is refused with why', status.some((s) => s.connected && /window is closed/.test(s.error ?? '')) && !unbound.ok && /not bound|No cobrowser workspaces are open/.test(unbound.text), { status, unbound });
    await a.close().catch(() => undefined);

    // The daemon restarts (an update, a crash): the add-on finds it again on its own.
    await stopDaemon();
    r.check('setup: the daemon starts again on the same port', await startDaemon());
    await register();
    const b = await agent();
    const back = await until(b, 30000);
    r.check('after the daemon restarts, the add-on reconnects by itself and calls work again', back.ok && back.text.includes(srv.base), back);
    await b.close().catch(() => undefined);
  } finally {
    bc?.stop();
    await stopDaemon();
    srv.close();
  }
});
