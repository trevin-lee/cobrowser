/* Everything a page would show in a window of its own: popups, dialogs, uploads, downloads, leave
 * prompts, fullscreen, certificate warnings, login boxes — plus crash recovery and hidden-tab cost.
 * Nothing may appear on the desktop except the one real popup window. */
import { suite, launch, serve, html, sleep, humanClick, humanKey, onScreenWindows, averageCpu, scratchDir, selfSignedCert, withTimeout } from './harness';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';

suite('dialogs', async (r) => {
  const DL = scratchDir('downloads');
  const UP = path.join(scratchDir('upload'), 'e2e-upload.txt');
  fs.writeFileSync(UP, 'upload me');
  let port = 0;
  const srv = await serve((q, res) => {
    let p: [number, Record<string, string>, string];
    if (q.url === '/popup') p = html(`<title>popup</title><script>document.title='opener:'+!!window.opener+' cookie:'+document.cookie; if (window.opener) window.opener.postMessage('signed-in','*'); setTimeout(()=>window.close(), 1500)</script>`);
    else if (q.url === '/report.txt') p = [200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="report.txt"' }, 'report'];
    else if (q.url === '/frame') p = html(`<body style="margin:0;background:#eef"><input id=ff type=file style="position:absolute;left:10px;top:10px;width:200px;height:30px"><script>document.getElementById('ff').addEventListener('change',(e)=>parent.postMessage({frameFiles:[...e.target.files].map(f=>f.name)},'*'));</script></body>`);
    else if (q.url === '/upload') p = html(`<title>upload</title><body>
<button id=styled style="position:absolute;left:20px;top:20px;width:140px;height:30px" onclick="document.getElementById('hidden').click()">Upload new</button>
<input id=hidden type=file multiple style="display:none">
<input id=single type=file style="position:absolute;left:20px;top:70px;width:220px;height:30px">
<button id=nothing style="position:absolute;left:20px;top:120px;width:140px;height:30px">Does nothing</button>
<button id=pay style="position:absolute;left:20px;top:170px;width:140px;height:30px" onclick="window.__paid=true">Pay now</button>
<script>window.__up={};for(const id of ['hidden','single'])document.getElementById(id).addEventListener('change',(e)=>window.__up[id]=[...e.target.files].map(f=>f.name+':'+f.size));</script></body>`);
    else if (q.url === '/leave') p = html(`<title>leave</title><button id=b style="position:absolute;left:10px;top:10px;width:100px;height:30px">b</button><script>addEventListener('beforeunload',(e)=>{e.preventDefault();e.returnValue='x';})</script>`);
    else if (q.url === '/spin') p = html('<style>div{width:300px;height:300px;background:linear-gradient(red,blue);animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style><div></div>');
    else if (q.url === '/fs') p = html(`<title>fs</title><body style="margin:0"><button id=b style="position:absolute;left:10px;top:10px;width:120px;height:40px">fullscreen</button><div id=v style="position:absolute;left:0;top:60px;width:200px;height:100px;background:#36c"></div><script>window.__ev=[];document.getElementById('b').onclick=()=>{document.getElementById('v').requestFullscreen().then(()=>window.__ev.push('resolved'),(e)=>window.__ev.push('rejected:'+e.name))};document.addEventListener('fullscreenchange',()=>window.__ev.push('change:'+!!document.fullscreenElement));</script></body>`);
    else if (q.url === '/auth') {
      if (q.headers.authorization === 'Basic ' + Buffer.from('alice:secret').toString('base64')) p = html('<title>authed</title>ok');
      else p = [401, { 'WWW-Authenticate': 'Basic realm="Router"', 'content-type': 'text/html' }, '<title>401</title>'];
    } else p = html(`<!doctype html><title>fixes</title><body>
<button id=pop style="position:absolute;left:20px;top:20px;width:140px;height:30px" onclick="window.open('http://127.0.0.1:${port}/popup','_blank','width=400,height=300')">sign in</button>
<button id=dlg style="position:absolute;left:20px;top:70px;width:140px;height:30px" onclick="window.__dlg=[confirm('Delete?'), prompt('Name?','Ada'), String(alert('done'))]">dialogs</button>
<input id=file type=file style="position:absolute;left:20px;top:120px;width:220px;height:30px">
<a id=dl href="/report.txt" style="position:absolute;left:20px;top:170px;width:140px;height:30px;display:block">download</a>
<a id=tab target=_blank href="/spin" style="position:absolute;left:20px;top:220px;width:140px;height:30px;display:block">tab</a>
<iframe id=xf src="http://localhost:${port}/frame" style="position:absolute;left:300px;top:20px;width:260px;height:120px;border:0"></iframe>
<script>document.cookie='session=abc123;path=/';window.__msgs=[];addEventListener('message',(e)=>window.__msgs.push(e.data));
document.getElementById('file').addEventListener('change',(e)=>window.__files=[...e.target.files].map(f=>f.name));</script></body>`);
    res.writeHead(p[0], p[1]); res.end(p[2]);
  });
  port = srv.port;
  const cert = selfSignedCert();
  const tls = https.createServer({ key: fs.readFileSync(cert.key), cert: fs.readFileSync(cert.cert) }, (_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>secure</title>ok'); });
  await new Promise<void>((res) => tls.listen(0, '127.0.0.1', res));
  const tlsBase = `https://localhost:${(tls.address() as { port: number }).port}`;

  const L = await launch({ env: { COBROWSER_TEST_DIALOG: 'accept', COBROWSER_TEST_UPLOAD: UP, COBROWSER_TEST_UPLOAD_CONFIRM: 'deny', COBROWSER_DOWNLOADS_DIR: DL, COBROWSER_TEST_CERT: 'accept', COBROWSER_TEST_LOGIN: 'alice:secret' } });
  const { conn, session: s, app } = L;
  const pid = app.pid!;
  try {
    const main = await s.run(() => s.newPage(`${srv.base}/`));
    await sleep(800);
    const tabId = (await conn.listTabs()).find((t) => t.url.endsWith(`:${port}/`))!.tabId;
    const opened: string[] = []; s.onPageOpened((_p, id) => opened.push(id));

    // sign-in popup: a real window that keeps its opener and cookies, and closes itself
    await humanClick(conn, tabId, 90, 35); await sleep(1100);
    r.check('a sign-in popup opens as a real window on screen', onScreenWindows(pid).length === 1, onScreenWindows(pid));
    r.check('the opener receives the popup\'s message (it kept window.opener)', JSON.stringify(await s.evaluateScript('() => window.__msgs', [], main.pageId)) === '["signed-in"]');
    r.check('the popup is not also an empty editor tab', opened.length === 0 && !(await s.listPages()).some((p) => p.url.endsWith('/popup')), opened);
    await sleep(1600);
    r.check('a popup that closes itself is gone', onScreenWindows(pid).length === 0, onScreenWindows(pid));
    await humanClick(conn, tabId, 80, 235); await sleep(900);
    const linkTab = (await conn.listTabs()).find((t) => t.url.endsWith('/spin'));
    let frames = 0; if (linkTab) conn.subscribe(linkTab.tabId, () => frames++);
    await sleep(800);
    r.check('a target=_blank link opens an editor tab that renders', !!linkTab && frames > 0, { linkTab, frames });
    if (linkTab) { conn.unsubscribe(linkTab.tabId); conn.closeTab(linkTab.tabId); await sleep(300); }

    // page dialogs answered by the app; the page carries on
    await humanClick(conn, tabId, 90, 85); await sleep(500);
    r.check('confirm, prompt and alert return and the page continues', JSON.stringify(await s.evaluateScript('() => window.__dlg', [], main.pageId)) === '[true,"Ada","undefined"]');
    r.check('dialog functions still read as native', /\[native code\]/.test(String(await s.evaluateScript('() => Function.prototype.toString.call(window.confirm)', [], main.pageId))));
    await s.run(() => s.click({ selector: '#dlg', pageId: main.pageId }), main.pageId);
    r.check('an agent click that opens a dialog completes', Array.isArray(await s.evaluateScript('() => window.__dlg', [], main.pageId)));

    // file upload through the app's picker, on the page and inside a cross-site iframe
    await humanClick(conn, tabId, 80, 135); await sleep(600);
    r.check('a file input gets the chosen file', JSON.stringify(await s.evaluateScript('() => window.__files', [], main.pageId)) === '["e2e-upload.txt"]');
    await humanClick(conn, tabId, 360, 45); await sleep(800);
    const fm = (await s.evaluateScript('() => window.__msgs', [], main.pageId)) as unknown[];
    r.check('a file input inside a cross-site iframe gets the file too', fm.some((m) => JSON.stringify(m) === '{"frameFiles":["e2e-upload.txt"]}'), fm);

    // upload_file: the agent names the files, the human confirms (here: declines every time),
    // or the workspace lets it upload without asking; the picker the target opens takes them
    const UP2 = path.join(path.dirname(UP), 'e2e-cover.txt');
    fs.writeFileSync(UP2, 'cover letter');
    const upPage = await s.run(() => s.newPage(`${srv.base}/upload`));
    const up = (o: { uid?: string; selector?: string; filePaths: string[] }, ask = false) => s.run(() => s.uploadFile({ ...o, pageId: upPage.pageId, ask }), upPage.pageId);
    const got = async () => JSON.stringify(await s.evaluateScript('() => window.__up', [], upPage.pageId));
    const declined = await up({ selector: '#single', filePaths: [UP] }, true);
    r.check('an upload the human declines attaches nothing', declined.declined === true && (await got()) === '{}', { declined, page: await got() });
    const styled = await up({ selector: '#styled', filePaths: [UP, UP2] });
    r.check('upload_file through a styled button that opens a hidden multi-file input', JSON.stringify(styled.uploaded) === '["e2e-upload.txt","e2e-cover.txt"]' && (await got()).includes('"hidden":["e2e-upload.txt:9","e2e-cover.txt:12"]'), { styled, page: await got() });
    const single = await up({ selector: '#single', filePaths: [UP2] });
    r.check('upload_file straight into a file input', !!single.uploaded && (await got()).includes('"single":["e2e-cover.txt:12"]'), { single, page: await got() });
    const two = await up({ selector: '#single', filePaths: [UP, UP2] });
    r.check('a single-file input refuses two files before the human is asked', /takes one file/.test(two.error ?? ''), two);
    const nothing = await up({ selector: '#nothing', filePaths: [UP] });
    r.check('a click that opens no picker says so and points at the file inputs', /did not open a file picker.*2 file inputs/.test(nothing.error ?? ''), nothing);
    const pay = await up({ selector: '#pay', filePaths: [UP] });
    r.check('upload_file will not click a button that pays', /pays or places an order/.test(pay.error ?? '') && (await s.evaluateScript('() => window.__paid', [], upPage.pageId)) !== true, pay);
    const hidden = await up({ selector: '#single', filePaths: [path.join(os.homedir(), '.ssh', 'known_hosts')] });
    r.check('a hidden file is refused whatever the human would say', /refused|no such file/.test(hidden.error ?? '') && !(await got()).includes('known_hosts'), hidden);
    const raw = await conn.cdp((await conn.listTabs()).find((t) => t.url.endsWith('/upload'))!.tabId, 'DOM.setFileInputFiles', { files: [UP], backendNodeId: 1 }).then(() => 'sent', (e: Error) => e.message);
    r.check('the editor cannot set files on an input directly', /refused/.test(raw), raw);
    r.check('a picker the human opens later still asks them (nothing stays armed)', await (async () => {
      await s.evaluateScript('() => { window.__up = {}; }', [], upPage.pageId);
      await humanClick(conn, (await conn.listTabs()).find((t) => t.url.endsWith('/upload'))!.tabId, 120, 85); await sleep(600);
      return (await got()) === '{"single":["e2e-upload.txt:9"]}'; // COBROWSER_TEST_UPLOAD, the human's picker
    })(), await got());
    await s.run(() => s.closePage(upPage.pageId));

    // downloads land in the folder without a dialog, never overwriting
    await s.run(() => s.click({ selector: '#dl', pageId: main.pageId }), main.pageId); await sleep(800);
    await s.run(() => s.click({ selector: '#dl', pageId: main.pageId }), main.pageId); await sleep(800);
    r.check('downloads save to the folder, the second as "report (1).txt"', JSON.stringify(fs.readdirSync(DL).sort()) === '["report (1).txt","report.txt"]', fs.readdirSync(DL));

    // leaving a page with a beforeunload handler asks, and proceeds on "Leave"
    const leave = await s.run(() => s.newPage(`${srv.base}/leave`));
    const leaveTab = (await conn.listTabs()).find((t) => t.url.endsWith('/leave'))!.tabId;
    await humanClick(conn, leaveTab, 50, 25);
    const nav = await s.run(() => s.navigate('url', `${srv.base}/`, 8000, leave.pageId), leave.pageId).catch((e) => ({ url: 'error ' + e.message, title: '' }));
    r.check('navigating away from a page that asks goes ahead after "Leave"', nav.url === `${srv.base}/`, nav);

    // fullscreen stays inside the tab; Escape leaves it; the panel is told
    const fsPage = await s.run(() => s.newPage(`${srv.base}/fs`));
    const fsTab = (await conn.listTabs()).find((t) => t.url.endsWith('/fs'))!.tabId;
    const fsEvents: boolean[] = []; conn.onFullscreen = (_t, on) => fsEvents.push(on);
    await humanClick(conn, fsTab, 60, 30); await sleep(1200);
    const fsState = await s.evaluateScript('() => [window.__ev, document.fullscreenElement && document.fullscreenElement.id, JSON.stringify(document.getElementById("v").getBoundingClientRect())]', [], fsPage.pageId) as [string[], string | null, string];
    r.check('a page can enter fullscreen and it fills the tab, with nothing on the desktop', fsState[1] === 'v' && fsState[0].includes('change:true') && JSON.parse(fsState[2]).x === 0 && onScreenWindows(pid).length === 0, { fsState, windows: onScreenWindows(pid) });
    r.check('the panel is told about fullscreen', fsEvents[0] === true, fsEvents);
    await humanKey(conn, fsTab, 'Escape', 'Escape', 27); await sleep(600);
    r.check('Escape leaves fullscreen and the panel is told', (await s.evaluateScript('() => document.fullscreenElement', [], fsPage.pageId)) === null && fsEvents[fsEvents.length - 1] === false, fsEvents);

    // a self-signed certificate: asked once (accepted here), then remembered
    const sec = await s.run(() => s.newPage(tlsBase + '/'));
    r.check('a self-signed HTTPS page loads after the warning is accepted', sec.title === 'secure', sec);
    const sec2 = await s.run(() => s.navigate('url', tlsBase + '/again', 8000, sec.pageId), sec.pageId);
    r.check('the decision is remembered for the host', sec2.url === tlsBase + '/again', sec2);

    // a page asking for a password with the browser's own login box
    const auth = await s.run(() => s.newPage(`${srv.base}/auth`));
    r.check('a basic-auth page loads with the credentials from the login box', auth.title === 'authed', auth);

    // a crashed page reloads by itself
    await withTimeout(conn.cdp(tabId, 'Page.crash', {}).catch(() => 0), 1000);
    await sleep(2500);
    const alive = await withTimeout(s.evaluateScript('() => document.title', [], main.pageId).catch((e) => 'error ' + e.message), 4000);
    r.check('a crashed page comes back without a manual reload', alive === 'fixes', alive);

    // hidden tabs paint slowly; a screenshot of one is still quick
    for (let i = 0; i < 3; i++) await s.run(() => s.newPage(`${srv.base}/spin`, { background: true }));
    await sleep(3500); // past the activity boost
    const cpu = await averageCpu(pid);
    r.check('three hidden animated tabs cost little CPU', cpu < 12, { cpuPercentOfOneCore: cpu });
    const spin = (await s.listPages()).find((p) => p.url.endsWith('/spin'))!;
    const t0 = Date.now(); const shot = await s.run(() => s.screenshot({ format: 'png', pageId: spin.pageId }), spin.pageId); const shotMs = Date.now() - t0;
    // The first command to an idle hidden tab waits for its next frame (at most 250 ms at 4 fps).
    r.check('a screenshot of a hidden tab is quick', shot.length > 1000 && shotMs < 600, { shotMs });
    r.note('hidden tabs CPU', `${cpu}% of one core`); r.note('hidden screenshot', `${shotMs} ms`);
    r.check('no window is on screen at the end', onScreenWindows(pid).length === 0, onScreenWindows(pid));
  } finally {
    srv.close(); tls.close(); await L.stop();
  }
});
