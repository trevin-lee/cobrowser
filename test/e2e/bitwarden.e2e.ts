/* The vault on a Bitwarden server: signed in to from the vault window's Source view, its logins
 * granted to a workspace, filled by Bitwarden's matching (a one-time code too), a new login an
 * agent signs up with saved to the server sealed, and the vault opening from its kept copy when
 * the server is down. The server is test/e2e/fakeBitwarden.ts, whose crypto is Node's own. */
import { suite, launch, serve, html, SCRATCH } from './harness';
import { fakeBitwarden, totp } from './fakeBitwarden';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PAGE = `<title>shop</title><form><input id=u name=email><input id=p type=password name=password><input id=c name=otp inputmode=numeric></form>`;
const MASTER = ['correct', 'horse', 'battery'].join(' ');
const SEED = ['JBSWY3DP', 'EHPK3PXP'].join('');

suite('bitwarden', async (r) => {
  const srv = await serve((_q, res) => { const [st, h, b] = html(PAGE); res.writeHead(st, h); res.end(b); });
  const bw = await fakeBitwarden({
    email: 'sam@example.com', password: MASTER,
    logins: [
      { id: 'login-1', name: 'Test shop', uri: `${srv.base}/`, username: 'sam', password: 'Pw-from-server-1', totp: SEED, notes: 'Use the shop account.', shareNotes: true },
      { id: 'login-2', name: 'Kept', uri: `${srv.base}/`, username: 'kept', password: 'Pw-from-server-2', notes: 'recovery codes: 1111 2222' },
    ],
  });
  const L = await launch({ env: { COBROWSER_TEST_GRANT: 'workspace' } });
  const s = L.session;
  const data = path.join(SCRATCH, 'data');
  try {
    // ---- signing in, in the window ----
    await L.conn.vaultWindow(`document.getElementById('k-source').click(); 1`, { wait: 300 });
    await L.conn.vaultWindow(`document.querySelectorAll('#list .item')[1].click(); 1`, { wait: 300 });
    const form = await L.conn.vaultWindow(`(() => { const ins = [...document.querySelectorAll('#detail .field input')]; const set = (i, v) => { ins[i].value = v; ins[i].dispatchEvent(new Event('input')); }; set(0, ${JSON.stringify(bw.url)}); set(1, 'sam@example.com'); set(2, ${JSON.stringify(MASTER)}); [...document.querySelectorAll('#detail .actions button')].find((b) => b.textContent === 'Sign in').click(); return ins.length; })()`, { wait: 2500 });
    const shown = (await L.conn.vaultWindow(`({ items: [...document.querySelectorAll('#list .item b')].map((b) => b.textContent), notice: (document.getElementById('status')?.textContent || '') + document.getElementById('notice').textContent, user: document.querySelector('#detail .user')?.textContent, io: !document.getElementById('import').hidden || !document.getElementById('export').hidden })`)).value as { items: string[]; notice: string; user: string; io: boolean };
    r.check('the Source view signs in to the server, and says what the vault holds', form.value === 3 && shown.items.some((t) => /Bitwarden server.*in use/.test(t)) && /2 logins/.test(shown.notice) && /sam@example\.com/.test(shown.user ?? '') && !shown.io, { form, shown });
    const sent = JSON.stringify(bw.requests);
    r.check('the master password never left the app', !sent.includes(MASTER) && bw.requests.some((q) => q.path === '/identity/connect/token'), bw.requests.map((q) => q.path));
    const kept = ['vault-source.json', 'bitwarden-scopes.json', 'bitwarden.bin'].filter((f) => fs.existsSync(path.join(data, f)));
    r.check('the sign-in is kept encrypted, the settings hold no secret', kept.includes('vault-source.json') && kept.includes('bitwarden.bin') && !fs.readFileSync(path.join(data, 'bitwarden.bin')).includes(Buffer.from('sam@example.com')) && !fs.readFileSync(path.join(data, 'vault-source.json'), 'utf8').includes(MASTER), kept);

    // ---- workspaces ----
    r.check('a server login is no workspace\'s until the human says so', (await L.conn.vaultList()).length === 0);
    const granted = await s.requestCredential({ site: new URL(srv.base).host, username: 'sam' });
    const listed = await L.conn.vaultList();
    r.check('a grant gives it to this workspace, with its shared notes and its code; an unmarked item\'s notes stay the human\'s', granted.granted === 'workspace' && listed.length === 1 && listed[0].username === 'sam' && listed[0].hasCode === true && listed[0].notes === 'Use the shop account.', { granted, listed });

    // ---- filling ----
    const page = await s.run(() => s.newPage(`${srv.base}/login`));
    await s.evaluateScript('() => { ["u","p","c"].forEach((id, i) => document.getElementById(id).setAttribute("data-cobrowser-uid", String(i + 1))); }', [], page.pageId);
    const raw = async (id: string) => {
      const tabId = (await L.conn.listTabs()).find((t) => t.url === `${srv.base}/login`)!.tabId;
      return (await L.conn.cdp<{ result: { value: string } }>(tabId, 'Runtime.evaluate', { expression: `document.getElementById(${JSON.stringify(id)}).value`, returnByValue: true })).result.value;
    };
    const fill = await s.run(() => s.fillCredentials({ usernameUid: '1', passwordUid: '2', pageId: page.pageId }), page.pageId);
    r.check('the server\'s login fills its site, and the agent is not handed the password', fill.filled.join() === 'username,password' && (await raw('u')) === 'sam' && (await raw('p')) === 'Pw-from-server-1' && !JSON.stringify(fill).includes('Pw-from-server'), fill);
    const code = await s.run(() => s.fillCredentials({ codeUid: '3', pageId: page.pageId }), page.pageId);
    const typed = await raw('c');
    r.check('its one-time code is made from the authenticator key and typed in, and scrubbed from what the agent reads', code.filled.join() === 'code' && totp(SEED).includes(typed) && !(await s.scrub(`the code is ${typed}`)).includes(typed) && !JSON.stringify(code).includes(typed), { code, typed });
    const other = await s.run(() => s.newPage(`${srv.base.replace('127.0.0.1', 'localhost')}/login`));
    const elsewhere = await s.run(() => s.fillCredentials({ usernameUid: '1', pageId: other.pageId }), other.pageId);
    r.check('Bitwarden\'s matching holds: the same port on another host is not its site', elsewhere.filled.length === 0 && /no saved login/.test(elsewhere.error ?? ''), elsewhere);

    // ---- an agent signs up: the made-up password goes to the server first, sealed ----
    const before = bw.ciphers.length;
    const made = await s.run(() => s.createLogin({ username: 'new@example.com', usernameUid: '1', passwordUid: '2', pageId: page.pageId }), page.pageId);
    const pw = await raw('p');
    const saved = bw.ciphers.length === before + 1 ? bw.open(bw.ciphers[before]) : undefined;
    const posted = bw.requests.filter((q) => q.method === 'POST' && q.path === '/api/ciphers');
    r.check('create_login saves the new password on the server before typing it, sealed with the account\'s key', made.created === true && pw.length === 20 && saved?.password === pw && saved?.username === 'new@example.com' && saved?.uris[0] === srv.base && posted.length === 1 && !posted[0].body.includes(pw), { made, saved, posts: posted.length });
    r.check('and this workspace may use it at once', (await L.conn.vaultList()).some((l) => l.username === 'new@example.com'));
    const again = await s.run(() => s.createLogin({ username: 'new@example.com', passwordUid: '2', symbols: false, pageId: page.pageId }), page.pageId);
    const pw2 = await raw('p');
    r.check('the site refused it: the one just made is written over on the server', again.created === true && !!again.replaced && bw.requests.some((q) => q.method === 'PUT') && bw.open(bw.ciphers[before]).password === pw2 && pw2 !== pw, again);

    // ---- the server goes away ----
    bw.setUp(false);
    await L.conn.vaultLock();
    const offline = await L.conn.vaultList();
    await s.evaluateScript('() => { document.getElementById("p").value = ""; }', [], page.pageId);
    const offFill = await s.run(() => s.fillCredentials({ passwordUid: '2', username: 'sam', pageId: page.pageId }), page.pageId);
    r.check('with the server down, the vault opens from its kept copy, and fills', offline.length === 2 && offFill.filled.join() === 'password' && (await raw('p')) === 'Pw-from-server-1', { offline, offFill });
    bw.setUp(true);

    // ---- the window: server items are changed in Bitwarden ----
    await L.conn.vaultWindow(`document.getElementById('k-logins').click(); [...document.querySelectorAll('#list .item')].find((i) => i.textContent.includes('sam')).click(); 1`, { wait: 400 });
    const detail = (await L.conn.vaultWindow(`({ buttons: [...document.querySelectorAll('#detail .acts button')].map((b) => b.textContent), hint: document.querySelector('#detail p.hint')?.textContent, scope: !!document.querySelector('#detail .scope') })`)).value as { buttons: string[]; hint: string; scope: boolean };
    r.check('a server login shows no Edit or Remove: it is changed in Bitwarden, its workspaces here', detail.buttons.length === 0 && /Bitwarden/.test(detail.hint ?? '') && detail.scope, detail);
  } finally {
    srv.close(); await bw.close(); await L.stop();
  }
});
