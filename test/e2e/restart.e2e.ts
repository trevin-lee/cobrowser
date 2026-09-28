/* The app shutting down (menu-bar Quit, an update or renewal restarting it) must not read as
 * the human closing every tab: the editor would save an empty tab list and forget the tabs. */
import { suite, launch, serve, html, sleep, withTimeout } from './harness';

suite('restart', async (r) => {
  const srv = await serve((q, res) => { const [st, h, b] = html(`<title>${q.url!.slice(1) || 'home'}</title>page`); res.writeHead(st, h); res.end(b); });
  const L = await launch();
  const { session: s, app } = L;
  try {
    const closed: string[] = []; s.onPageClosed((id) => closed.push(id));
    let allClosed = 0; s.onAllClosed(() => { allClosed++; });
    let disconnected = 0; s.onDisconnected(() => { disconnected++; });
    let changedAfterQuit = 0;

    const a = await s.run(() => s.newPage(srv.base + '/a'));
    await s.run(() => s.newPage(srv.base + '/b', { byAgent: false }));
    const c = await s.run(() => s.newPage(srv.base + '/c'));
    await s.run(() => s.closePage(c.pageId), c.pageId);
    await sleep(500);
    r.check('closing a tab still reports the close (the fix must not hide real closes)', closed.join() === c.pageId && (await s.listPages()).length === 2, closed);

    s.onPagesChanged(() => { changedAfterQuit++; });
    const exited = new Promise<number>((res) => app.once('exit', () => res(Date.now())));
    const t0 = Date.now();
    app.kill('SIGTERM'); // what the extension does to replace the app; a menu-bar Quit takes the same path
    const at = await withTimeout(exited, 15000);
    for (let i = 0; i < 25 && !disconnected; i++) await sleep(200);
    const ms = at === 'TIMEOUT' ? -1 : at - t0;
    r.check('the app quits cleanly and promptly on the stop signal', ms >= 0 && ms < 10000 && app.exitCode === 0, { ms, code: app.exitCode, signal: app.signalCode });
    r.note('quit took', `${ms} ms`);
    r.check('setup: the session saw the app go', disconnected === 1, { disconnected });
    const entries = s.pageEntries().map((e) => e.url.split('/').pop()).sort();
    r.check('the shutdown did not close the tabs as far as the editor knows', closed.length === 1 && entries.join() === 'a,b', { closed, entries });
    r.check('the shutdown did not read as "the human closed everything"', allClosed === 0, { allClosed });
    r.check('no tab-list change was reported for the editor to save', changedAfterQuit === 0, { changedAfterQuit });
    void a;
  } finally {
    srv.close(); await L.stop();
  }
});
