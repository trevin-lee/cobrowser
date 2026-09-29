/* request_credential: a login scoped to one workspace, asked for by another; grant, once, deny. */
import { suite, launch, serve, html, sleep, AppConnection, readAppState } from './harness';
import * as path from 'node:path';

suite('credentials', async (r) => {
  const form = () => serve((_q, res) => { const [st, h, b] = html('<input id=u><input id=p type=password>'); res.writeHead(st, h); res.end(b); });
  try {
    for (const mode of ['workspace', 'once', 'deny'] as const) {
      // The suite's apps share one data dir, so one vault: each run gets its own site (a new
      // port), or the previous run's grant would still be there.
      const srv = await form();
      const L = await launch({ env: { COBROWSER_TEST_GRANT: mode }, workspace: path.join(process.env.COBROWSER_E2E_SCRATCH!, 'ws-A') });
      try {
        await L.conn.vaultAdd(srv.base, 'alice', 'secret-pw-123'); // scoped to ws-A by default
        const site = new URL(srv.base).host;
        const mine = async () => (await b.vaultList()).filter((e) => e.host === site).length;
        const { conn: b } = await AppConnection.connect(readAppState()!, path.join(process.env.COBROWSER_E2E_SCRATCH!, 'ws-B'));
        r.check(`[${mode}] B lists nothing it is not scoped for`, (await mine()) === 0);
        const t = await b.openTab(srv.base + '/', 800, 600); await sleep(800);
        await b.cdp(t.tabId, 'Runtime.evaluate', { expression: 'document.getElementById("u").setAttribute("data-cobrowser-uid","1"); document.getElementById("p").setAttribute("data-cobrowser-uid","2"); 1' });
        const before = await b.vaultFill(t.tabId, { usernameUid: '1', passwordUid: '2' });
        r.check(`[${mode}] B cannot fill before a grant`, before.filled.length === 0 && /no saved login/.test(before.error ?? ''), before);
        const req = await b.vaultRequest(srv.base, undefined, 'signing in for the e2e');
        const first = await b.vaultFill(t.tabId, { usernameUid: '1', passwordUid: '2' });
        const second = await b.vaultFill(t.tabId, { usernameUid: '1', passwordUid: '2' });
        const listed = await mine();
        const typed = (await b.cdp<{ result: { value: string } }>(t.tabId, 'Runtime.evaluate', { expression: 'document.getElementById("u").value + "/" + document.getElementById("p").value.length', returnByValue: true })).result.value;
        if (mode === 'workspace') r.check('[workspace] a grant for the workspace fills now and later, and the login is listed', req.granted === 'workspace' && first.filled.length === 2 && second.filled.length === 2 && listed === 1 && typed === 'alice/13', { req, first, second, listed, typed });
        if (mode === 'once') r.check('[once] a one-time grant fills exactly once and is never listed', req.granted === 'once' && first.filled.length === 2 && second.filled.length === 0 && listed === 0 && typed === 'alice/13', { req, first, second, listed, typed });
        if (mode === 'deny') r.check('[deny] a denial fills nothing and reads like no such login', req.granted === 'denied' && /was granted/.test(req.error ?? '') && first.filled.length === 0 && typed === '/0', { req, first, typed });
        const unknown = await b.vaultRequest('nowhere.example', undefined, 'x');
        r.check(`[${mode}] a request for a site with no login is denied the same way`, unknown.granted === 'denied', unknown);
        b.close();
      } finally {
        await L.stop();
        srv.close();
      }
    }
    // export: every login, as a CSV other managers (and this vault) read, round-tripping
    const exportPath = path.join(process.env.COBROWSER_E2E_SCRATCH!, 'export', 'logins.csv');
    require('node:fs').mkdirSync(path.dirname(exportPath), { recursive: true });
    const L = await launch({ env: { COBROWSER_TEST_EXPORT_PATH: exportPath }, workspace: path.join(process.env.COBROWSER_E2E_SCRATCH!, 'ws-X') });
    try {
      await L.conn.vaultAdd('https://bank.test', 'ada', 'p,a"ss\nword', 'all');
      const first = await L.conn.vaultAdd('http://192.168.1.1:8080', 'admin', 'router-pw-old', 'all');
      const second = await L.conn.vaultAdd('192.168.1.1:8080', 'admin', 'router-pw', 'all');
      r.check('[add] adding a login that exists says it replaced the password, and keeps one copy', first.replaced === false && second.replaced === true && (await L.conn.vaultList()).filter((e) => e.username === 'admin').length === 1, { first, second });
      const ex = await L.conn.vaultExport();
      const fsm = require('node:fs') as typeof import('node:fs');
      const csv = fsm.readFileSync(exportPath, 'utf8');
      const mode = (fsm.statSync(exportPath).mode & 0o777).toString(8);
      const rows = (t: string) => t.trim().split(/\n(?=[^\n]*,https?:\/\/)/).slice(1).sort();
      r.check('[export] every login in the vault is written as name,url,username,password, readable only by you', ex.ok === true && ex.count === rows(csv).length && ex.count >= 2 && csv.startsWith('name,url,username,password\n') && csv.includes('"p,a""ss\nword"') && mode === '600', { ex, csv, mode });
      r.check('[export] a device on the network exports as http, a domain as https', csv.includes(',http://192.168.1.1:8080,admin,') && csv.includes(',https://bank.test,ada,'), csv);
      const imp = await L.conn.vaultImportDetailed(csv, 'all');
      r.check('[import] importing logins already in the vault reports them as replaced, not added', imp.count === ex.count && imp.added === 0 && imp.replaced === ex.count, imp);
      const again = await L.conn.vaultExport();
      const csv2 = fsm.readFileSync(exportPath, 'utf8');
      r.check('[export] importing the file back changes nothing: same logins, no duplicates', again.count === ex.count && JSON.stringify(rows(csv2)) === JSON.stringify(rows(csv)), { first: rows(csv), second: rows(csv2) });
    } finally {
      await L.stop();
    }
  } finally {
    /* each run closes its own server */
  }
});
