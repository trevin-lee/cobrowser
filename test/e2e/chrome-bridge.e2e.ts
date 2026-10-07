/* The Chrome add-on inside a real Chrome for Testing, in a scratch profile (never the human's
 * Chrome). The page-script suite runs the add-on's code in an ordinary page, which cannot show
 * what Chrome itself enforces: it refuses to evaluate strings in an extension, which is how
 * bridge_evaluate_script came to be broken in Chrome without a test noticing. */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { suite, serve, html, sleep, scratchDir, ROOT } from './harness';

/** Chrome for Testing: COBROWSER_E2E_CHROME, or the newest one Playwright downloaded. */
function chromeForTesting(): string | undefined {
  if (process.env.COBROWSER_E2E_CHROME) return process.env.COBROWSER_E2E_CHROME;
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  const builds = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))) : [];
  for (const b of builds) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
      const exe = path.join(cache, b, arch, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}

const PAGE = `<!doctype html><title>orders</title>
<a class=order href="/orders/1">Order one</a> <a class=order href="/orders/2">Order two</a> <a class=order href="/orders/3">Order three</a>
<input id=pw type=password value=hunter2>`;

suite('chrome-bridge', async (r) => {
  const exe = chromeForTesting();
  if (!exe) {
    r.note('skipped', 'no Chrome for Testing: set COBROWSER_E2E_CHROME, or run `npx playwright install chromium`');
    return;
  }
  const srv = await serve((_q, res) => { const [st, h, b] = html(PAGE); res.writeHead(st, h); res.end(b); });
  const port = 9400 + Math.floor(Math.random() * 400);
  const ext = path.join(ROOT, 'chrome-extension');
  const chrome = spawn(exe, ['--headless=new', `--user-data-dir=${scratchDir('chrome-profile')}`, '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`, `--load-extension=${ext}`, `--disable-extensions-except=${ext}`, srv.base + '/'], { stdio: 'ignore' });
  try {
    // The bridge's service worker, found by the add-on's name (Chrome runs its own too).
    let ws: WebSocket | undefined;
    for (let i = 0; i < 40 && !ws; i++) {
      await sleep(250);
      const list = (await fetch(`http://127.0.0.1:${port}/json/list`).then((x) => x.json()).catch(() => [])) as { type: string; webSocketDebuggerUrl: string }[];
      for (const t of list.filter((x) => x.type === 'service_worker')) {
        const c = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((ok) => c.once('open', ok));
        const name = await new Promise<string>((ok) => {
          const on = (d: WebSocket.RawData) => { const m = JSON.parse(String(d)); if (m.id === 0) { c.off('message', on); ok(m.result?.result?.value); } };
          c.on('message', on);
          c.send(JSON.stringify({ id: 0, method: 'Runtime.evaluate', params: { expression: 'chrome.runtime.getManifest().name', returnByValue: true } }));
          setTimeout(() => ok(''), 3000);
        });
        if (name === 'Cobrowser Bridge') { ws = c; break; }
        c.close();
      }
    }
    r.check('the add-on loads in Chrome and its service worker runs', !!ws);
    if (!ws) return;
    let id = 1;
    const run = <T,>(expression: string): Promise<{ value?: T; error?: string }> =>
      new Promise((ok) => {
        const mine = ++id;
        const on = (d: WebSocket.RawData) => {
          const m = JSON.parse(String(d));
          if (m.id !== mine) return;
          ws!.off('message', on);
          ok(m.result?.exceptionDetails ? { error: m.result.exceptionDetails.exception?.description ?? 'failed' } : { value: m.result?.result?.value });
        };
        ws!.on('message', on);
        ws!.send(JSON.stringify({ id: mine, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
    // A bound connection, as the daemon's hello leaves one: scoped to the whole profile.
    const call = (method: string, params: Record<string, unknown>) =>
      run<unknown>(`(async () => { const tabId = (await chrome.tabs.query({ url: ${JSON.stringify(srv.base + '/*')} }))[0].id; return dispatch({ scope: PROFILE }, ${JSON.stringify(method)}, { tabId, ...${JSON.stringify(params)} }); })()`);

    const version = await run<string>('chrome.runtime.getManifest().version');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
    r.check("the add-on reports cobrowser's version", version.value === pkg.version, version);

    const q = await call('query', { selector: 'a.order', fields: ['text', 'href'] });
    const items = (q.value as { count: number; items: { text: string; href: string }[] } | undefined);
    r.check('query reads every match in real Chrome, with absolute links', items?.count === 3 && items.items[1].text === 'Order two' && items.items[1].href === srv.base + '/orders/2', q);
    const pw = await call('query', { selector: '#pw', fields: ['value'] });
    r.check("query never returns a password's value", (pw.value as { items: { value: string }[] }).items[0].value === '(filled)' && !JSON.stringify(pw).includes('hunter2'), pw);

    const ev = await call('evaluate', { expression: 'document.title' });
    r.check('evaluate is refused plainly, pointing to bridge_query', /not available in Chrome: use bridge_query/.test(ev.error ?? ''), ev);

    const read = await call('readPage', {});
    const page = read.value as { title: string; text: string };
    r.check("reading the page returns the page, not the add-on's own activity marker", page.title === 'orders' && page.text.includes('Order two') && !page.text.includes('cobrowser:'), read);

    const close = await call('closeTab', {});
    r.check("a tab the human opened is not the agent's to close", (close.value as { refused?: string }).refused === 'human-tab', close);

    // A tab group, listed by the name the bind command takes. Chrome removes a group with its last
    // tab; the agent's next new tab starts it again under that name, rather than failing.
    const grouped = await run<Record<string, unknown>>(`(async () => {
      const t = await chrome.tabs.create({ url: ${JSON.stringify(srv.base + '/g')}, active: false });
      const g = await chrome.tabs.group({ tabIds: [t.id] });
      await chrome.tabGroups.update(g, { title: 'Work' });
      const loose = await chrome.tabs.create({ url: ${JSON.stringify(srv.base + '/u')}, active: false });
      await chrome.tabs.group({ tabIds: [loose.id] });
      const conn = { scope: await resolveScope('Work') };
      const names = (await dispatch(conn, 'listContainers', {})).map((x) => x.name);
      const before = (await dispatch(conn, 'listTabs', {})).tabs.length;
      await chrome.tabs.remove(t.id);
      await new Promise((ok) => setTimeout(ok, 300));
      const gone = await dispatch(conn, 'listTabs', {});
      const fresh = await dispatch(conn, 'newTab', { url: ${JSON.stringify(srv.base + '/n')}, active: false });
      const after = await dispatch(conn, 'listTabs', {});
      const group = await chrome.tabGroups.get(conn.scope.groupId);
      // A reconnect while the group is closed (a window reload, a daemon restart): bound, as closed.
      await chrome.tabs.remove(fresh.tabId);
      await new Promise((ok) => setTimeout(ok, 300));
      const re = { scope: await resolveScope('Work') };
      const reGone = await dispatch(re, 'listTabs', {});
      const reFresh = await dispatch(re, 'newTab', { url: ${JSON.stringify(srv.base + '/r')}, active: false });
      const reGroup = await chrome.tabGroups.get(re.scope.groupId);
      return { names, before, goneTabs: gone.tabs.length, note: gone.note, after: after.tabs.length, title: group.title, inGroup: after.tabs.some((x) => x.tabId === fresh.tabId),
        reTabs: reGone.tabs.length, reNote: reGone.note, reTitle: reGroup.title, reIn: (await dispatch(re, 'listTabs', {})).tabs.some((x) => x.tabId === reFresh.tabId) };
    })()`);
    const gv = grouped.value ?? {};
    r.check('the scopes are listed by the names the bind command takes: profile, a group\'s title, and an untitled group as none', JSON.stringify(gv.names) === JSON.stringify(['profile', 'Work', null]), grouped);
    r.check('a closed tab group lists no tabs and says why, and the next new tab starts it again under its name', gv.before === 1 && gv.goneTabs === 0 && /not open in Chrome/.test(String(gv.note)) && gv.after === 1 && gv.title === 'Work' && gv.inGroup === true, grouped);
    r.check('binding to a tab group that is closed when the bridge connects works too: the next new tab starts it', gv.reTabs === 0 && /not open in Chrome/.test(String(gv.reNote)) && gv.reTitle === 'Work' && gv.reIn === true, grouped);
    // The toolbar popup's page, in Chrome itself: it loads and shows the bridge's own state.
    await run(`chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }).then(() => 1)`);
    let popup: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 20 && !popup; i++) {
      await sleep(250);
      const list = (await fetch(`http://127.0.0.1:${port}/json/list`).then((x) => x.json()).catch(() => [])) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      popup = list.find((t) => t.type === 'page' && t.url.endsWith('/options.html'));
    }
    let shown: Record<string, unknown> | undefined;
    if (popup) {
      const pw = new WebSocket(popup.webSocketDebuggerUrl);
      await new Promise((ok) => pw.once('open', ok));
      await sleep(800);
      shown = await new Promise((ok) => {
        pw.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id === 1) ok(m.result?.result?.value); });
        pw.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `({ title: document.querySelector('h1').textContent, summary: document.getElementById('summary').textContent, groups: [...document.querySelectorAll('#containers .chip')].map((c) => c.firstChild.nextSibling.textContent), count: document.getElementById('count').textContent, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() })`, returnByValue: true } }));
      });
      pw.close();
    }
    r.check("the toolbar popup loads in Chrome and shows the bridge's state", shown?.title === 'Cobrowser Bridge' && shown?.summary === 'Not connected' && (shown?.groups as string[] | undefined)?.[0] === 'profile' && /^\d+$/.test(String(shown?.count)) && shown?.accent === '#2b5bff', shown);
    ws.close();
  } finally {
    chrome.kill('SIGKILL');
    srv.close();
  }
});
