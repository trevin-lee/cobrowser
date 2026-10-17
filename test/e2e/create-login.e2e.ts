/* The agent signs up for an account without seeing its password: the app makes one up, saves it
 * in the vault for this site and workspace once the person confirms, and types it into the form. */
import { suite, launch, serve, html, SCRATCH } from './harness';
import * as fs from 'node:fs';
import * as path from 'node:path';

const FORM = (max = '') => `<title>sign up</title><form>
<input id=u name=email placeholder="Email"><input id=t name=nickname placeholder="Nickname">
<input id=p type=password name=password ${max}><input id=c type=password name=confirm ${max}></form>`;

suite('create-login', async (r) => {
  const srv = await serve((q, res) => { const [st, h, b] = html(q.url === '/short' ? FORM('maxlength=12') : FORM()); res.writeHead(st, h); res.end(b); });
  const L = await launch();
  const s = L.session;
  try {
    const asks = () => fs.readFileSync(path.join(SCRATCH, 'data', 'app.log'), 'utf8').split('confirmation skipped for: save a new password').length - 1;
    const open = async (route: string) => {
      const page = await s.run(() => s.newPage(srv.base + route));
      await s.evaluateScript('() => { ["u","t","p","c"].forEach((id, i) => document.getElementById(id).setAttribute("data-cobrowser-uid", String(i + 1))); }', [], page.pageId);
      return page.pageId;
    };
    // What the page holds, read straight from it (the agent's own reads are scrubbed).
    const raw = async (route: string, id: string) => {
      const tabId = (await L.conn.listTabs()).find((t) => t.url === srv.base + route)!.tabId;
      return (await L.conn.cdp<{ result: { value: string } }>(tabId, 'Runtime.evaluate', { expression: `document.getElementById(${JSON.stringify(id)}).value`, returnByValue: true })).result.value;
    };

    const A = await open('/signup');
    const before = asks();
    const made = await s.run(() => s.createLogin({ username: 'ada@example.com', usernameUid: '1', passwordUid: '3', confirmUid: '4', pageId: A }), A);
    const pw = await raw('/signup', 'p');
    r.check('a new account gets a strong password, typed into both fields, confirmed once', made.created === true && made.filled?.join() === 'username,password,confirmation' && pw.length === 20 && (await raw('/signup', 'c')) === pw && (await raw('/signup', 'u')) === 'ada@example.com' && asks() - before === 1, { made, asks: asks() - before });
    r.check('the agent is never handed it: not in the result, scrubbed from what it reads', !JSON.stringify(made).includes(pw) && !(await s.scrub(`value: ${pw}`)).includes(pw), made);
    const listed = await L.conn.vaultList();
    r.check('it is saved for this site and this workspace', listed.some((l) => l.username === 'ada@example.com' && !l.noPassword), listed);

    const again = await s.run(() => s.createLogin({ username: 'ada@example.com', passwordUid: '3', confirmUid: '4', symbols: false, pageId: A }), A);
    const pw2 = await raw('/signup', 'p');
    r.check('the site refused it: within half an hour the agent may make up another for the same account', again.created === true && !!again.replaced && pw2 !== pw && /^[A-Za-z0-9]{20}$/.test(pw2), again);

    await L.conn.vaultAdd(new URL(srv.base).host, 'carol', 'her-own-password', 'all');
    const askedBefore = asks();
    const theirs = await s.run(() => s.createLogin({ username: 'carol', passwordUid: '3', pageId: A }), A);
    const text = await s.run(() => s.createLogin({ username: 'bob', passwordUid: '2', pageId: A }), A);
    r.check("a saved account is never given a new password, and a text field never gets one, before anything is asked", theirs.created === false && /changing a saved password/.test(theirs.error ?? '') && text.created === false && /not a password field/.test(text.error ?? '') && asks() === askedBefore && !(await L.conn.vaultList()).some((l) => l.username === 'bob'), { theirs, text });

    const B = await open('/short');
    await s.run(() => s.createLogin({ username: 'dee', passwordUid: '3', pageId: B }), B);
    r.check('a field that takes fewer characters gets a password it will not cut', (await raw('/short', 'p')).length === 12);

    await s.evaluateScript('() => { document.getElementById("u").value = ""; document.getElementById("p").value = ""; }', [], A);
    await s.run(() => s.fillCredentials({ usernameUid: '1', passwordUid: '3', username: 'ada@example.com', pageId: A }), A);
    r.check('signing in later fills the same password', (await raw('/signup', 'p')) === pw2);
  } finally {
    srv.close(); await L.stop();
  }
});
