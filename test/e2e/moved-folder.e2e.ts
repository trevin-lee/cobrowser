/* A renamed or moved folder takes over the browser of the path it had: sign-ins, site
 * permissions and the logins allowed there, while a folder made at the old path starts fresh. */
import { suite, launch, serve, html, sleep, AppConnection, readAppState, SCRATCH } from './harness';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

suite('moved-folder', async (r) => {
  const srv = await serve((_q, res) => { const [st, h, b] = html('<title>m</title>page'); res.writeHead(st, h); res.end(b); });
  const OLD = path.join(SCRATCH, 'app'), NEW = path.join(SCRATCH, 'app-renamed');
  fs.mkdirSync(OLD, { recursive: true });
  fs.writeFileSync(path.join(SCRATCH, 'data', 'permissions.json'), JSON.stringify({ version: 2, workspaces: { [OLD]: { [`${srv.base}|notifications`]: true } } }));
  let L = await launch({ workspace: NEW });
  try {
    const evaluate = async (conn: AppConnection, tabId: string, expression: string) => (await conn.cdp<{ result: { value: string } }>(tabId, 'Runtime.evaluate', { expression, returnByValue: true })).result.value;
    const cookie = (conn: AppConnection, tabId: string) => evaluate(conn, tabId, 'document.cookie');
    const notif = (conn: AppConnection, tabId: string) => evaluate(conn, tabId, 'Notification.permission');

    // The folder as it was: signed in to a site, a permission given, a login allowed there.
    const { conn: old } = await AppConnection.connect(readAppState()!, OLD);
    const tOld = await old.openTab(srv.base + '/', 800, 600); await sleep(600);
    await old.cdp(tOld.tabId, 'Runtime.evaluate', { expression: 'document.cookie = "signedin=1; max-age=3600"' });
    await old.vaultAdd('moved.example', 'ada', 'pw', [OLD]);
    await old.vaultLock(); // the logins move when the vault is next unlocked
    // The renamed folder, opened before taking over: what it does now is given up.
    const tNew = await L.conn.openTab(srv.base + '/', 800, 600); await sleep(600);
    await L.conn.cdp(tNew.tabId, 'Runtime.evaluate', { expression: 'document.cookie = "since=1; max-age=3600"' });

    const refusal = () => L.conn.takeOverWorkspace(OLD).then(() => '', (e: Error) => e.message);
    const exists = await refusal();
    fs.rmSync(OLD, { recursive: true });
    const open = await refusal();
    r.check('a folder that still exists, or is open in a window, is not taken over', /still exists/.test(exists) && /open in an editor window/.test(open), { exists, open });
    old.close(); await sleep(300);

    await L.conn.takeOverWorkspace(OLD);
    await sleep(300);
    r.check("the renamed folder's tabs are closed, for its editor to reopen", !(await L.conn.listTabs()).some((t) => t.tabId === tNew.tabId));
    const t = await L.conn.openTab(srv.base + '/', 800, 600); await sleep(600);
    r.check('it is signed in where the old folder was, and nothing from since the rename', (await cookie(L.conn, t.tabId)) === 'signedin=1', await cookie(L.conn, t.tabId));
    r.check("it has the old folder's site permissions", (await notif(L.conn, t.tabId)) === 'granted' && (await L.conn.sitePermissions()).length === 1);
    const logins = await L.conn.vaultList();
    r.check('logins allowed in the old folder are allowed in it (renamed at the unlock)', logins.some((l) => l.host === 'moved.example' && l.username === 'ada'), logins);
    const known = (await L.conn.knownWorkspaces()).map((w) => w.id);
    r.check('the old path leaves the workspace list', !known.includes(OLD) && known.includes(NEW), known);

    const { conn: again, tabs } = await AppConnection.connect(readAppState()!, OLD);
    const tAgain = await again.openTab(srv.base + '/', 800, 600); await sleep(600);
    r.check('a folder made at the old path later starts fresh', tabs.length === 0 && (await cookie(again, tAgain.tabId)) === '' && (await again.vaultList()).length === 0, { tabs: tabs.length });
    again.close();

    // What the renamed folder had since the move is deleted at the next start, before a session holds it.
    const given = path.join(SCRATCH, 'data', 'Partitions', `ws-${crypto.createHash('sha1').update(NEW).digest('hex').slice(0, 16)}`);
    const before = fs.existsSync(given);
    await L.stop(); await sleep(500);
    L = await launch({ workspace: NEW });
    const t2 = await L.conn.openTab(srv.base + '/', 800, 600); await sleep(600);
    r.check('after a restart the given-up browser is gone and the taken-over one kept', before && !fs.existsSync(given) && (await notif(L.conn, t2.tabId)) === 'granted', { before, after: fs.existsSync(given) });
  } finally {
    srv.close(); await L.stop();
  }
});
