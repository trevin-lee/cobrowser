/* The basics through the real session: pages, input, snapshots, screenshots, logs, navigation. */
import { suite, launch, serve, html, sleep } from './harness';

const PAGE = `<!doctype html><title>e2e home</title>
<input id="name" placeholder="name"><button id="go">Go</button><span id="out"></span>
<a id="pop" target="_blank" href="/dest">open</a>
<script>
  document.getElementById('go').addEventListener('click', (e) => { document.getElementById('out').textContent = 'clicked:' + e.isTrusted + ':' + document.getElementById('name').value; });
  document.getElementById('name').addEventListener('input', () => { window.__inputEvents = (window.__inputEvents || 0) + 1; });
  console.error('boom', { a: 1 });
  fetch('/missing').catch(() => {});
  setTimeout(() => { throw new Error('late failure'); }, 50);
</script>`;

suite('core', async (r) => {
  const srv = await serve((q, res) => {
    const [status, headers, body] =
      q.url === '/missing' ? [404, { 'content-type': 'text/plain' }, 'nope'] as const
      : q.url === '/dest' ? html('<title>DEST</title>arrived')
      : q.url === '/second' ? html('<title>second</title>two')
      : html(PAGE);
    res.writeHead(status, headers); res.end(body);
  });
  const { conn, session: s, stop } = await launch({ passkeyFallback: true });
  try {
    const opened: string[] = []; s.onPageOpened((_p, id, reveal) => opened.push(`${id}:${reveal}`));
    const closed: string[] = []; s.onPageClosed((id) => closed.push(id));

    const p1 = await s.run(() => s.newPage(srv.base + '/'));
    r.check('newPage lands on the url with title', p1.url === srv.base + '/' && p1.title === 'e2e home', p1);
    r.check('webdriver is false', (await s.evaluateScript('() => navigator.webdriver')) === false);

    const snap = await s.run(() => s.takeSnapshot());
    r.check('snapshot lists the controls with uids', /\[\d+\] button "Go"/.test(snap), snap.slice(0, 200));
    const goUid = /\[(\d+)\] button "Go"/.exec(snap)![1];

    await s.run(() => s.fill({ selector: '#name', value: 'Trevin' }));
    const typed = await s.evaluateScript('() => [document.getElementById("name").value, window.__inputEvents]') as [string, number];
    r.check('fill types with real input events', typed[0] === 'Trevin' && typed[1] >= 6, typed);
    await s.run(() => s.click({ uid: goUid }));
    const out = await s.evaluateScript('() => document.getElementById("out").textContent');
    r.check('click is trusted and sees the typed value', out === 'clicked:true:Trevin', out);
    await s.run(() => s.fill({ selector: '#name', value: '' }));
    r.check('fill with empty clears', (await s.evaluateScript('() => document.getElementById("name").value')) === '');

    const shot = await s.run(() => s.screenshot({ format: 'png' }));
    r.check('screenshot returns png', Buffer.from(shot, 'base64').subarray(1, 4).toString() === 'PNG');
    const snap2 = await s.run(() => s.takeSnapshot());
    const eshot = await s.run(() => s.screenshot({ format: 'jpeg', uid: /\[(\d+)\] button "Go"/.exec(snap2)![1] }));
    r.check('element screenshot by uid is a jpeg', Buffer.from(eshot, 'base64')[0] === 0xff);

    await sleep(400);
    const con = await s.consoleMessages({});
    r.check('console captured error + exception + 404 log', con.entries.some((e) => e.text.startsWith('boom')) && con.entries.some((e) => e.source === 'exception' && e.text.includes('late failure')) && con.entries.some((e) => e.source === 'network' && /404/.test(e.text)), con.entries.map((e) => [e.level, e.source, e.text.slice(0, 60)]));
    const net = await s.networkRequests({ failedOnly: true });
    r.check('network log has the 404', net.entries.some((e) => e.url.endsWith('/missing') && e.status === 404), net.entries);

    await s.run(() => s.click({ selector: '#pop' }));
    await sleep(1200);
    const pages = await s.run(() => s.listPages());
    r.check('target=_blank link opened a second page that is active and the agent\'s', pages.length === 2 && pages[1].selected && pages[1].url.endsWith('/dest') && pages[1].openedBy === 'agent', pages);
    r.check('popup fired onPageOpened', opened.some((o) => o.startsWith('2:')), opened);

    await s.run(() => s.selectPage('1'));
    const nav = await s.run(() => s.navigate('url', srv.base + '/second'));
    r.check('navigate settles with the new title', nav.title === 'second', nav);
    const back = await s.run(() => s.navigate('back'));
    r.check('back returns to home', back.url === srv.base + '/', back);
    const fwd = await s.run(() => s.navigate('forward'));
    r.check('forward returns to second', fwd.url.endsWith('/second'), fwd);
    await s.run(() => s.typeText('hello\n'));
    const act = s.getActivity();
    r.check('activity has navigations and tab events', act.events.some((e) => e.type === 'navigated') && act.events.some((e) => e.type === 'tab-opened'), act.events.map((e) => e.type));
    let threw = '';
    try { await s.run(() => s.navigate('url', 'http://127.0.0.1:1/')); } catch (e) { threw = String((e as Error).message); }
    r.check('navigation to a dead host throws with the error', /ERR_CONNECTION_REFUSED|failed/.test(threw), threw);
    await sleep(300);
    const shown = await s.run(() => s.readPage({}));
    const tabUrl = (await s.listPages()).find((p) => p.selected)?.url;
    r.check('a page that could not load shows an error page, and the tab keeps the address that failed', /This site can't be reached/.test(shown.text) && tabUrl === 'http://127.0.0.1:1/', { text: shown.text.slice(0, 120), tabUrl });
    try { await s.run(() => s.click({ uid: 'nope' })); } catch (e) { threw = String((e as Error).message); }
    r.check('a stale uid gives the re-snapshot guidance', /take_snapshot/.test(threw), threw);

    // Passkeys, unsigned: a site's create() and get() must both fail at once (to its password
    // form), never hang on a prompt nobody can see, and never record a passkey nobody holds.
    // WebAuthn needs a domain, so this runs on localhost rather than 127.0.0.1.
    await s.run(() => s.navigate('url', srv.cross + '/second'));
    const ceremony = await s.evaluateScript(`async () => {
      const race = (p) => Promise.race([p.then(() => 'CREATED-OR-GOT', (e) => e.name), new Promise((r) => setTimeout(() => r('HUNG'), 5000))]);
      const t0 = performance.now();
      const made = await race(navigator.credentials.create({ publicKey: { challenge: new Uint8Array(32), rp: { name: 'e2e', id: 'localhost' }, user: { id: new Uint8Array(8), name: 'u', displayName: 'u' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'discouraged' } } }));
      const got = await race(navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: 'localhost', userVerification: 'preferred' } }));
      return { made, got, ms: Math.round(performance.now() - t0) };
    }`) as { made: string; got: string; ms: number };
    r.check('passkey create() and get() fail fast to the password form, recording nothing', ceremony.made === 'NotAllowedError' && ceremony.got === 'NotAllowedError' && ceremony.ms < 4000, ceremony);
    await s.run(() => s.navigate('back'));

    await s.run(() => s.closePage('2'));
    await sleep(500);
    r.check('close removes the page and reports it', (await s.listPages()).length === 1 && closed.includes('2'), closed);
  } finally {
    srv.close(); await stop();
  }
});
