/* request_credential: a login scoped to one workspace, asked for by another; grant, once, deny. */
import { suite, launch, serve, html, sleep, AppConnection, readAppState, SCRATCH } from './harness';
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
        if (mode === 'workspace') {
          const before2 = (await b.cdp<{ result: { value: string } }>(t.tabId, 'Runtime.evaluate', { expression: 'document.getElementById("u").value' })).result.value;
          const wrong = await b.vaultFill(t.tabId, { passwordUid: '1' });
          const after2 = (await b.cdp<{ result: { value: string } }>(t.tabId, 'Runtime.evaluate', { expression: 'document.getElementById("u").value' })).result.value;
          r.check('[workspace] a password is never typed into a field that is not a password field', wrong.filled.length === 0 && /not a password field/.test(wrong.error ?? '') && after2 === before2, { wrong, before2, after2 });
        }
        if (mode === 'once') {
          // A two-step sign-in: the email on one page, the password on the next. The grant
          // outlives the username and is spent by the password.
          await b.vaultRequest(srv.base, undefined, 'two-step sign-in');
          const user = await b.vaultFill(t.tabId, { usernameUid: '1' });
          const pass = await b.vaultFill(t.tabId, { passwordUid: '2' });
          const after = await b.vaultFill(t.tabId, { passwordUid: '2' });
          r.check('[once] one sign-in: the username alone keeps the grant for the password page, which spends it', user.filled.join() === 'username' && pass.filled.join() === 'password' && after.filled.length === 0, { user, pass, after });
          // Locking ends a grant nobody used.
          await b.vaultRequest(srv.base, undefined, 'then locked');
          await b.vaultLock();
          const locked = await b.vaultFill(t.tabId, { usernameUid: '1', passwordUid: '2' });
          r.check('[once] locking the vault ends an unused grant', locked.filled.length === 0 && /no saved login/.test(locked.error ?? ''), locked);
        }
        if (mode === 'deny') r.check('[deny] a denial fills nothing and reads like no such login', req.granted === 'denied' && /was granted/.test(req.error ?? '') && first.filled.length === 0 && typed === '/0', { req, first, typed });
        const unknown = await b.vaultRequest('nowhere.example', undefined, 'x');
        r.check(`[${mode}] a request for a site with no login is denied the same way`, unknown.granted === 'denied', unknown);
        b.close();
      } finally {
        await L.stop();
        srv.close();
      }
    }
    // One account, several sign-in sites: a login saved for 127.0.0.1:port that also fills on
    // localhost:port (a different site to the vault), and nowhere else.
    {
      const two = await form();
      const L2 = await launch({ workspace: path.join(process.env.COBROWSER_E2E_SCRATCH!, 'ws-S') });
      try {
        await L2.conn.vaultAdd(two.base, 'sam', 'two-sites-pw', 'all', [new URL(two.cross).host]);
        const listed = (await L2.conn.vaultList()).find((e) => e.username === 'sam');
        const fillOn = async (url: string) => {
          const t = await L2.conn.openTab(url, 800, 600); await sleep(600);
          await L2.conn.cdp(t.tabId, 'Runtime.evaluate', { expression: 'document.getElementById("u").setAttribute("data-cobrowser-uid","1"); document.getElementById("p").setAttribute("data-cobrowser-uid","2"); 1' });
          return L2.conn.vaultFill(t.tabId, { usernameUid: '1', passwordUid: '2', username: 'sam' });
        };
        const onOther = await fillOn(two.cross + '/');
        r.check('[sites] a login fills on the other website it was given, and the agent is told about it', onOther.filled.length === 2 && listed?.alsoOn?.[0] === new URL(two.cross).host, { onOther, listed });
        const other = await form(); // localhost on another port: a site it was not given
        const elsewhere = await fillOn(other.cross + '/');
        other.close();
        r.check('[sites] and on no site it was not given', elsewhere.filled.length === 0, elsewhere);
      } finally {
        await L2.stop();
        two.close();
      }
    }
    // Cards: a checkout page with its own fields, month/year selects, a hidden card-number field
    // (autofill theft: must stay empty), and card fields in another site's frame (as Stripe does).
    {
      const shop = await serve((q, res) => {
        const frame = `<input id=fnum autocomplete=cc-number><input id=fexp autocomplete=cc-exp placeholder="MM / YY"><input id=fcvc autocomplete=cc-csc>
          <script>for (const id of ['fnum','fexp','fcvc']) document.getElementById(id).addEventListener('input', () => parent.postMessage({ [id]: document.getElementById(id).value }, '*'));</script>`;
        const page = `<title>checkout</title><input id=num name=cardnumber autocomplete=cc-number><input id=name autocomplete=cc-name>
          <select id=mm autocomplete=cc-exp-month><option value="">Month</option>${Array.from({ length: 12 }, (_, i) => `<option value="${String(i + 1).padStart(2, '0')}">${String(i + 1).padStart(2, '0')}</option>`).join('')}</select>
          <select id=yy autocomplete=cc-exp-year><option value="">Year</option><option>2028</option><option>2029</option><option>2030</option></select>
          <input id=cvc autocomplete=cc-csc><input id=trap autocomplete=cc-number style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">
          <iframe id=f src="${shop.cross}/frame" style="width:400px;height:80px"></iframe>
          <script>window.__frame = {}; addEventListener('message', (e) => Object.assign(window.__frame, e.data));</script>`;
        const [st, h, b] = html(q.url === '/frame' ? frame : page); res.writeHead(st, h); res.end(b);
      });
      const L3 = await launch({ workspace: path.join(process.env.COBROWSER_E2E_SCRATCH!, 'ws-C') });
      try {
        await L3.conn.vaultAddCard({ number: '4242 4242 4242 4242', exp: '03/29', cvc: '123', name: 'Ada Lovelace', label: 'Personal' });
        const cards = await L3.conn.vaultCards();
        r.check('[cards] a saved card is listed without its number or code', cards.length === 1 && cards[0].last4 === '4242' && !JSON.stringify(cards).includes('4242424242424242') && !JSON.stringify(cards).includes('123'), cards);
        const t = await L3.conn.openTab(shop.base + '/', 900, 600); await sleep(1500);
        const res = await L3.conn.vaultFillCard(t.tabId, undefined, 'agent');
        await sleep(500);
        const got = (await L3.conn.cdp<{ result: { value: Record<string, unknown> } }>(t.tabId, 'Runtime.evaluate', { expression: '({ num: num.value, name: document.getElementById("name").value, mm: mm.value, yy: yy.value, cvc: cvc.value, trap: trap.value, frame: window.__frame })', returnByValue: true })).result.value;
        r.check('[cards] the card fills the page: number, name, month and year menus, code', got.num === '4242424242424242' && got.name === 'Ada Lovelace' && got.mm === '03' && got.yy === '2029' && got.cvc === '123', { res, got });
        r.check('[cards] a hidden card field is left empty', got.trap === '', got);
        // What the agent reads back after a fill, as the tools hand it over (scrubbed by the app).
        const mine = await L3.session.run(() => L3.session.newPage(shop.base + '/'));
        await sleep(1200);
        const mineTab = (await L3.conn.listTabs()).filter((x) => x.url === shop.base + '/' && x.tabId !== t.tabId)[0].tabId;
        await L3.conn.vaultFillCard(mineTab, undefined, 'agent');
        await sleep(500);
        const snap = await L3.session.scrub(await L3.session.run(() => L3.session.takeSnapshot({ pageId: mine.pageId }), mine.pageId));
        const read = await L3.session.scrub(JSON.stringify(await L3.session.evaluateScript('() => [document.getElementById("num").value, document.getElementById("cvc").value]', [], mine.pageId)));
        r.check('[cards] the agent never reads the number or the code back: snapshots show (filled), script results are masked', !snap.includes('4242424242424242') && !/value="123"/.test(snap) && /\(filled\)/.test(snap) && !read.includes('4242424242424242') && read.includes('•••• •••• •••• 4242'), { snap: snap.split('\n').filter((l) => /input/.test(l)), read });
        const fr = got.frame as Record<string, string>;
        r.check("[cards] and the fields in another site's frame are filled too", fr.fnum === '4242424242424242' && /^03 ?\/ ?29$/.test(fr.fexp ?? '') && fr.fcvc === '123', { res, frame: fr });
        const none = await L3.conn.vaultFillCard((await L3.conn.openTab(shop.base + '/frame', 400, 300)).tabId, 'no such card', 'agent');
        r.check('[cards] an unknown card is a clear error, with the cards there are', /no saved card/.test(none.error ?? '') && none.cards?.[0] === 'Personal', none);
      } finally {
        await L3.stop();
        shop.close();
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
      r.check('[export] every login in the vault is written as name,url,username,password, readable only by you', ex.ok === true && ex.count === rows(csv).length && ex.count >= 2 && csv.startsWith('name,url,username,password,note\n') && csv.includes('"p,a""ss\nword"') && mode === '600', { ex, csv, mode });
      r.check('[export] a device on the network exports as http, a domain as https', csv.includes(',http://192.168.1.1:8080,admin,') && csv.includes(',https://bank.test,ada,'), csv);
      // Back in the way the editor's Import command does it (its own workspace chosen): each
      // login keeps exactly the workspaces its note recorded.
      const imp = await L.conn.vaultImportDetailed(csv);
      r.check('[import] importing logins already in the vault reports them as replaced, not added', imp.count === ex.count && imp.added === 0 && imp.replaced === ex.count, imp);
      const again = await L.conn.vaultExport();
      const csv2 = fsm.readFileSync(exportPath, 'utf8');
      r.check('[export] importing the file back changes nothing: same logins, same workspaces, no duplicates', again.count === ex.count && JSON.stringify(rows(csv2)) === JSON.stringify(rows(csv)), { first: rows(csv), second: rows(csv2) });
      const dataFiles = fsm.readdirSync(path.join(SCRATCH, 'data'));
      r.check('[save] the vault is saved whole, with no temporary file left beside it', dataFiles.includes('vault.bin') && !dataFiles.some((f) => f.startsWith('vault.bin.')), dataFiles);
    } finally {
      await L.stop();
    }
  } finally {
    /* each run closes its own server */
  }
});
