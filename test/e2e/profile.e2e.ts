/* Each workspace is its own browser: site permissions, browsing data, and forgetting one. */
import { suite, launch, serve, html, sleep, AppConnection, readAppState, SCRATCH } from './harness';
import * as fs from 'node:fs';
import * as path from 'node:path';

suite('profile', async (r) => {
  const srv = await serve((_q, res) => { const [st, h, b] = html('<title>p</title>page'); res.writeHead(st, h); res.end(b); });
  const A = path.join(SCRATCH, 'ws-A'), B = path.join(SCRATCH, 'ws-B');
  // A decision from before permissions were per workspace: one flat file shared by all.
  fs.mkdirSync(path.join(SCRATCH, 'data'), { recursive: true });
  fs.writeFileSync(path.join(SCRATCH, 'data', 'workspaces.json'), JSON.stringify([A, B]));
  fs.writeFileSync(path.join(SCRATCH, 'data', 'permissions.json'), JSON.stringify({ [`${srv.base}|notifications`]: true }));
  const L = await launch({ workspace: A });
  try {
    const notif = async (conn: AppConnection, tabId: string) => (await conn.cdp<{ result: { value: string } }>(tabId, 'Runtime.evaluate', { expression: 'Notification.permission', returnByValue: true })).result.value;
    const tA = await L.conn.openTab(srv.base + '/', 800, 600); await sleep(600);
    const { conn: b } = await AppConnection.connect(readAppState()!, B);
    const tB = await b.openTab(srv.base + '/', 800, 600); await sleep(600);
    r.check('a decision from the old shared file still holds in each workspace', (await notif(L.conn, tA.tabId)) === 'granted' && (await notif(b, tB.tabId)) === 'granted', [await notif(L.conn, tA.tabId), await notif(b, tB.tabId), fs.readFileSync(path.join(SCRATCH, 'data', 'permissions.json'), 'utf8')]);

    const listed = await L.conn.sitePermissions();
    r.check('the workspace lists its decisions, saying what each allows', listed.length === 1 && listed[0].origin === srv.base && listed[0].allowed && listed[0].label === 'show notifications', listed);
    await L.conn.forgetSitePermissions(listed.map((p) => p.key));
    await L.conn.cdp(tA.tabId, 'Page.reload', {}); await b.cdp(tB.tabId, 'Page.reload', {}); await sleep(800);
    r.check('forgetting it in one workspace leaves the other as it was', (await notif(L.conn, tA.tabId)) === 'denied' && (await notif(b, tB.tabId)) === 'granted' && (await L.conn.sitePermissions()).length === 0 && (await b.sitePermissions()).length === 1, [await notif(L.conn, tA.tabId), await notif(b, tB.tabId)]);

    const cookie = async (conn: AppConnection, tabId: string) => (await conn.cdp<{ result: { value: string } }>(tabId, 'Runtime.evaluate', { expression: 'document.cookie', returnByValue: true })).result.value;
    for (const [c, t] of [[L.conn, tA.tabId], [b, tB.tabId]] as const) await c.cdp(t, 'Runtime.evaluate', { expression: 'document.cookie = "signedin=1; max-age=3600"' });
    await L.conn.clearBrowsingData();
    await L.conn.cdp(tA.tabId, 'Page.reload', {}); await sleep(800);
    r.check('clearing browsing data signs this workspace out and no other', (await cookie(L.conn, tA.tabId)) === '' && (await cookie(b, tB.tabId)) === 'signedin=1', { a: await cookie(L.conn, tA.tabId), b: await cookie(b, tB.tabId) });

    let refused = '';
    try { await L.conn.forgetWorkspace(B); } catch (e) { refused = (e as Error).message; }
    r.check('a workspace open in an editor window cannot be forgotten from another', /open in an editor window/.test(refused), refused);
    try { await L.conn.forgetWorkspace(A); refused = ''; } catch (e) { refused = (e as Error).message; }
    r.check('nor can the one asking', /open in an editor window/.test(refused), refused);

    b.close(); await sleep(300);
    await L.conn.forgetWorkspace(B);
    const known = (await L.conn.knownWorkspaces()).map((w) => w.id);
    r.check('a forgotten workspace leaves the list', !known.includes(B) && known.includes(A), known);
    const { conn: b2, tabs, forgotten } = await AppConnection.connect(readAppState()!, B);
    const tB2 = await b2.openTab(srv.base + '/', 800, 600); await sleep(600);
    r.check('opening it again starts a fresh browser: no tabs, signed out, no permissions', tabs.length === 0 && (await cookie(b2, tB2.tabId)) === '' && (await notif(b2, tB2.tabId)) === 'denied' && (await b2.sitePermissions()).length === 0, { tabs: tabs.length });
    b2.close(); await sleep(200);
    const { conn: b3, forgotten: again } = await AppConnection.connect(readAppState()!, B);
    const { conn: a2, forgotten: other } = await AppConnection.connect(readAppState()!, A);
    r.check('its editor is told once that it was forgotten, so it drops the tabs it saved', forgotten === true && again === false && other === false, { forgotten, again, other });
    b3.close(); a2.close();
  } finally {
    srv.close(); await L.stop();
  }
});
