/* Agent and human focus are separate; pageId targets any tab; tabs run in parallel; ownership survives a reload. */
import { suite, launch, serve, html, sleep } from './harness';

const page = (name: string) => `<!doctype html><title>${name}</title><body><h1>page ${name}</h1>
<button id=b style="position:absolute;left:20px;top:80px;width:120px;height:30px">btn ${name}</button>
<a id=pop target=_blank href="/popup-${name}" style="position:absolute;left:20px;top:140px;width:120px;height:30px;display:block">popup ${name}</a>
<script>window.__clicks = 0; document.getElementById('b').addEventListener('click', () => window.__clicks++);</script></body>`;

suite('tabs', async (r) => {
  const srv = await serve((q, res) => { const [st, h, b] = html(q.url!.startsWith('/popup') ? `<title>${q.url!.slice(1)}</title>popup` : page(q.url!.slice(1))); res.writeHead(st, h); res.end(b); });
  const L = await launch();
  const { conn, session: s } = L;
  try {
    const opened: string[] = []; s.onPageOpened((_p, id, reveal) => opened.push(`${id}:${reveal}`));
    const revealed: string[] = []; s.onPageReveal((id) => revealed.push(id));

    const A = (await s.run(() => s.newPage(srv.base + '/A'))).pageId;
    const B = (await s.run(() => s.newPage(srv.base + '/B', { byAgent: false }))).pageId;
    let pages = await s.listPages();
    r.check('a human-opened tab does not move the agent and is the human\'s', pages.find((p) => p.pageId === A)!.selected && !pages.find((p) => p.pageId === B)!.selected && pages.find((p) => p.pageId === B)!.openedBy === 'human', pages);

    await s.run(() => s.focusPage(B), B);
    pages = await s.listPages();
    r.check('the human switching tabs does not retarget the agent', pages.find((p) => p.pageId === A)!.selected && pages.find((p) => p.pageId === B)!.humanViewing, pages);
    await s.run(() => s.click({ selector: '#b' }));
    const clicks = [await s.evaluateScript('() => window.__clicks', [], A), await s.evaluateScript('() => window.__clicks', [], B)];
    r.check('a click without pageId lands in the agent\'s tab, not the human\'s', clicks[0] === 1 && clicks[1] === 0, clicks);
    const act = s.getActivity().events.filter((e) => e.type === 'tab-activated' && e.pageId === B);
    r.check('the human\'s tab switch is logged as the human\'s', act.length === 1 && act[0].source === 'human', act);

    const rb = await s.run(() => s.readPage({ pageId: B }), B);
    await s.run(() => s.click({ selector: '#b', pageId: B }), B);
    pages = await s.listPages();
    r.check('pageId reads and clicks another tab and leaves the agent where it was', rb.text.includes('page B') && (await s.evaluateScript('() => window.__clicks', [], B)) === 1 && pages.find((p) => p.pageId === A)!.selected, { rb: rb.text });
    let err = ''; try { await s.run(() => s.readPage({ pageId: '999' })); } catch (e) { err = String((e as Error).message); }
    r.check('an unknown pageId is a clear error', /No open page with id 999/.test(err), err);

    const t0 = Date.now(); let slowDone = 0, fastDone = 0;
    // Blocking, not speed: the click (a pointer path and a short wait for the page's response)
    // takes 0.5 s on a Mac and about 1.6 s on a CI runner without a GPU, so it is measured against
    // the slow action, which it must finish well before, rather than against a fixed time.
    const slow = s.run(() => s.evaluateScript('() => new Promise((r) => setTimeout(() => r(1), 3000))', [], A), A).then(() => { slowDone = Date.now() - t0; });
    const fast = s.run(() => s.click({ selector: '#b', pageId: B }), B).then(() => { fastDone = Date.now() - t0; });
    await Promise.all([slow, fast]);
    r.check('a slow action in one tab does not block another tab', slowDone >= 2900 && fastDone < slowDone - 800, { fastDone, slowDone });
    const order: string[] = [];
    await Promise.all([s.run(async () => { await sleep(300); order.push('first'); }, A), s.run(async () => { order.push('second'); }, A)]);
    r.check('actions on the same tab still run in order', order.join() === 'first,second', order);

    await s.run(() => s.selectPage(B), B);
    r.check('select_page does not reveal by default', (await s.listPages()).find((p) => p.pageId === B)!.selected && revealed.length === 0, revealed);
    await s.run(() => s.selectPage(A, true), A);
    r.check('select_page with bringToFront reveals', revealed.join() === A, revealed);

    const C = (await s.run(() => s.newPage(srv.base + '/C', { background: true }))).pageId;
    r.check('new_page background becomes the agent\'s tab without revealing it', (await s.listPages()).find((p) => p.pageId === C)!.selected && opened.includes(`${C}:false`), opened);

    await s.run(() => s.click({ selector: '#pop', pageId: C }), C);
    await sleep(1200);
    pages = await s.listPages();
    const agentPopup = pages.find((p) => p.url.endsWith('/popup-C'));
    r.check('a tab opened by the agent\'s click becomes its tab and does not pull the human\'s view', !!agentPopup && agentPopup.selected && agentPopup.openedBy === 'agent' && opened.includes(`${agentPopup.pageId}:false`), { pages, opened });

    await sleep(3100); // past the agent-activity window, as when a human acts later
    const box = await s.evaluateScript('() => { const r = document.getElementById("pop").getBoundingClientRect(); return { x: r.x + 20, y: r.y + 10 }; }', [], B) as { x: number; y: number };
    const tabB = (await conn.listTabs()).find((t) => t.url.endsWith('/B'))!.tabId;
    for (const type of ['mousePressed', 'mouseReleased']) await conn.cdp(tabB, 'Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, 30000, { human: true });
    await sleep(1200);
    pages = await s.listPages();
    const humanPopup = pages.find((p) => p.url.endsWith('/popup-B'));
    r.check('a tab the human\'s click opened is revealed, is the human\'s, and leaves the agent put', !!humanPopup && !humanPopup.selected && humanPopup.openedBy === 'human' && opened.includes(`${humanPopup.pageId}:true`) && pages.find((p) => p.pageId === agentPopup?.pageId)?.selected === true, { pages, opened });

    await s.waitFor(['page B'], 3000, B);
    r.check('wait_for works on a tab by pageId', true);

    await s.disconnect();
    await sleep(300);
    const again = await L.reconnect();
    const own = (await again.session.listPages()).map((p) => `${p.url.split('/').pop()}:${p.openedBy}`).sort();
    r.check('who opened each tab survives a reconnect', JSON.stringify(own) === JSON.stringify(['A:agent', 'B:human', 'C:agent', 'popup-B:human', 'popup-C:agent']), own);
    // After an app restart the extension reopens the saved tabs itself (restoreTabs): the
    // human's act, so the agent stays put, but each tab keeps its saved owner.
    const target = (await again.session.listPages()).find((p) => p.selected)?.pageId;
    const restored = await again.session.run(() => again.session.newPage(srv.base + '/R', { background: true, byAgent: false, openedBy: 'agent' }));
    const after = await again.session.listPages();
    r.check('a restored tab keeps its owner without taking the agent\'s focus', restored.openedBy === 'agent' && after.find((p) => p.pageId === restored.pageId)?.openedBy === 'agent' && after.find((p) => p.selected)?.pageId === target, { restored, target, after });
    // Agents in parallel: each names its task's tab; then a call must say which tab.
    const g = again.session;
    const one = await g.run(() => g.newPage(srv.base + '/one', { background: true, owner: 'research-1' }));
    let solo = '';
    try { await g.run(() => g.readPage({})); } catch (e) { solo = (e as Error).message; }
    r.check('once one tab has an owner, a call without pageId is refused (another agent may have no owner)', /working in parallel.*research-1.*pass pageId/s.test(solo), solo);
    const two = await g.run(() => g.newPage(srv.base + '/two', { background: true, owner: 'research-2' }));
    let refused = '';
    try { await g.run(() => g.readPage({})); } catch (e) { refused = (e as Error).message; }
    r.check('with two owners, a call without pageId is refused, naming the tabs', /working in parallel.*research-1, research-2.*pass pageId/s.test(refused) && refused.includes(`${one.pageId} (research-1)`), refused);
    const read = await g.run(() => g.readPage({ pageId: two.pageId }), two.pageId);
    const owners = (await g.listPages()).filter((p) => p.owner).map((p) => `${p.pageId}:${p.owner}`);
    r.check('with pageId it works, and list_pages shows each tab\'s owner', read.text.includes('page two') && owners.join() === `${one.pageId}:research-1,${two.pageId}:research-2`, { owners, text: read.text.slice(0, 40) });
    await g.run(() => g.click({ selector: '#pop', pageId: one.pageId }), one.pageId);
    await sleep(1200);
    const popup = (await g.listPages()).find((p) => p.url.endsWith('/popup-one'));
    r.check("a popup from an agent's tab belongs to that agent", popup?.owner === 'research-1' && popup.openedBy === 'agent', popup);
    await again.session.dispose().catch(() => undefined);
  } finally {
    srv.close(); await L.stop();
  }
});
