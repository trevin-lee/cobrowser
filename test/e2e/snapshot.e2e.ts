/* take_snapshot filters, stable uids, shadow DOM, password hiding, and read_page. */
import { suite, launch, serve, html } from './harness';

const uidOf = (snap: string, re: RegExp): string | undefined => { const m = new RegExp('\\[(\\d+)\\] ' + re.source).exec(snap); return m ? m[1] : undefined; };
const PAGE = `<!doctype html><title>snap</title><body>
<p id=para>Order 1234 shipped on Tuesday. Total $42.00.</p>
<div id=box><button id=go>Go</button><a href="/dest">Order details</a><button aria-label=""><svg width=10 height=10></svg></button></div>
<form id=f><input id=user placeholder="Email"><input id=pw type=password><select id=size><option>Small</option><option selected>Medium</option></select></form>
<x-card id=card></x-card>
<iframe id=player title="Lecture player" src="http://localhost:1/embed/video" style="width:200px;height:100px"></iframe>
<script>
  window.__go = 0; window.__shadow = 0;
  document.getElementById('go').addEventListener('click', () => window.__go++);
  customElements.define('x-card', class extends HTMLElement { constructor() { super(); const r = this.attachShadow({ mode: 'open' }); r.innerHTML = '<button id=sb>Shadow action</button>'; r.getElementById('sb').addEventListener('click', () => window.__shadow++); } });
</script></body>`;

suite('snapshot', async (r) => {
  const srv = await serve((q, res) => { const [st, h, b] = html(q.url === '/dest' ? '<title>dest</title><button>Other</button><button>Another</button>' : PAGE); res.writeHead(st, h); res.end(b); });
  const { session: s, stop } = await launch();
  try {
    await s.run(() => s.newPage(srv.base + '/'));
    const snap1 = await s.run(() => s.takeSnapshot());
    const goUid = uidOf(snap1, /button "Go"/);
    r.check('full snapshot lists controls, link destination and select options', !!goUid && /link "Order details" → \/dest/.test(snap1) && /options: Small \| \*Medium/.test(snap1) && /button "Shadow action"/.test(snap1), snap1);

    await s.evaluateScript('() => { const b = document.createElement("button"); b.textContent = "New"; document.getElementById("box").prepend(b); }');
    await s.run(() => s.click({ uid: goUid }));
    r.check('an old uid still clicks after the DOM changed, no re-snapshot', (await s.evaluateScript('() => window.__go')) === 1);
    const snap2 = await s.run(() => s.takeSnapshot());
    r.check('the same element keeps its uid in the next snapshot', uidOf(snap2, /button "Go"/) === goUid && !!uidOf(snap2, /button "New"/) && uidOf(snap2, /button "New"/) !== goUid, snap2);

    const onlyGo = await s.run(() => s.takeSnapshot({ textContains: 'go' }));
    r.check('textContains keeps only matching elements', /button "Go"/.test(onlyGo) && !/Order details/.test(onlyGo) && !/Email/.test(onlyGo), onlyGo);
    const byHref = await s.run(() => s.takeSnapshot({ textContains: '/dest' }));
    r.check('textContains with a slash matches link destinations', /link "Order details"/.test(byHref) && !/button/.test(byHref), byHref);
    const links = await s.run(() => s.takeSnapshot({ role: 'link' }));
    r.check('role filters by role', /link "Order details"/.test(links) && !/button/.test(links), links);
    const inForm = await s.run(() => s.takeSnapshot({ withinSelector: '#f' }));
    r.check('withinSelector scopes to a region', /Email/.test(inForm) && !/Go/.test(inForm), inForm);
    const labeled = await s.run(() => s.takeSnapshot({ labeledOnly: true, withinSelector: '#box' }));
    r.check('labeledOnly drops icon-only buttons and says how many', /1 unlabeled element/.test(labeled), labeled);
    const limited = await s.run(() => s.takeSnapshot({ limit: 2 }));
    r.check('limit caps the list and says what was left out', (limited.match(/^\s*\[\d+\]/gm) || []).length === 2 && /more elements not shown/.test(limited), limited);

    await s.run(() => s.fill({ selector: '#pw', value: 'hunter2secret', allowCredentials: true }));
    await s.run(() => s.fill({ selector: '#user', value: 'me@example.com' }));
    const snap3 = await s.run(() => s.takeSnapshot({ withinSelector: '#f' }));
    r.check('a filled password shows as (filled), never its value; other inputs show theirs', !snap3.includes('hunter2secret') && /input:password \(filled\)/.test(snap3) && /value="me@example.com"/.test(snap3), snap3);

    await s.run(() => s.click({ uid: uidOf(snap2, /button "Shadow action"/) }));
    r.check('a button inside a shadow root is clickable by uid', (await s.evaluateScript('() => window.__shadow')) === 1);

    await s.evaluateScript('() => document.getElementById("go").remove()');
    let err = ''; try { await s.run(() => s.click({ uid: goUid })); } catch (e) { err = String((e as Error).message); }
    r.check('a removed element says the uid is gone and to take_snapshot', /is gone/.test(err) && /take_snapshot/.test(err), err);

    const withFrame = await s.run(() => s.takeSnapshot());
    r.check('an embedded frame is listed as out of reach, with a note', /\[frame\] "Lecture player" localhost:1\/embed\/video — contents not reachable/.test(withFrame) && /1 embedded frame\(s\) listed/.test(withFrame), withFrame);
    const rp = await s.run(() => s.readPage());
    r.check('read_page returns the visible text', rp.text.includes('Order 1234 shipped on Tuesday') && rp.title === 'snap' && !rp.truncated, rp);
    const rp2 = await s.run(() => s.readPage({ maxChars: 20, links: true }));
    r.check('read_page truncates on request and lists links', rp2.text.length === 20 && (rp2.truncated?.total ?? 0) > 20 && !!rp2.links?.some((l) => l.href.endsWith('/dest') && l.text === 'Order details'), rp2);
    const rp3 = await s.run(() => s.readPage({ withinSelector: '#para' }));
    r.check('read_page withinSelector reads one region', rp3.text === 'Order 1234 shipped on Tuesday. Total $42.00.', rp3);

    const maxBefore = Math.max(...(snap3 + snap2).match(/\[(\d+)\]/g)!.map((x) => Number(x.slice(1, -1))));
    await s.run(() => s.navigate('url', srv.base + '/dest'));
    const snap4 = await s.run(() => s.takeSnapshot());
    const minAfter = Math.min(...snap4.match(/\[(\d+)\]/g)!.map((x) => Number(x.slice(1, -1))));
    r.check('after navigation new uids continue past the old ones', minAfter > maxBefore, { maxBefore, snap4 });
  } finally {
    srv.close(); await stop();
  }
});
