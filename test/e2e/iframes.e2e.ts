/* Cross-origin (out-of-process) iframes get the human's clicks, typing and focus; native video works. */
import { suite, launch, serve, html, sleep, humanClick, humanKey, ROOT } from './harness';
import * as fs from 'node:fs';
import * as path from 'node:path';

suite('iframes', async (r) => {
  let port = 0;
  const srv = await serve((q, res) => {
    let page: [number, Record<string, string>, string];
    // A real clip, checked in: recording one in the page needs it to paint frames, which a
    // hidden tab on a machine without a GPU (a CI runner) did too slowly.
    if (q.url === '/clip.webm') { res.writeHead(200, { 'content-type': 'video/webm' }); res.end(fs.readFileSync(path.join(ROOT, 'test', 'e2e', 'clip.webm'))); return; }
    if (q.url === '/child') page = html(`<!doctype html><body style="margin:0;background:#dfd"><button id=b style="position:absolute;left:10px;top:10px;width:120px;height:40px">child btn</button><input id=i style="position:absolute;left:10px;top:55px;width:120px;height:20px"><script>document.getElementById('i').addEventListener('input',(e)=>parent.postMessage({typed:e.target.value},'*'));document.getElementById('b').addEventListener('click',(e)=>{parent.postMessage({childClick:true,trusted:e.isTrusted},'*')});document.addEventListener('mousedown',()=>parent.postMessage({childDown:true},'*'));</script></body>`);
    else page = html(`<!doctype html><title>iframe host</title><body style="margin:0">
<iframe id=same src="http://127.0.0.1:${port}/child" style="position:absolute;left:0;top:0;width:200px;height:80px;border:0"></iframe>
<iframe id=cross src="http://localhost:${port}/child" style="position:absolute;left:0;top:120px;width:200px;height:80px;border:0"></iframe>
<video id=v src="/clip.webm" controls muted playsinline loop style="position:absolute;left:0;top:240px;width:320px;height:180px;background:#000"></video>
<script>
window.__msgs=[]; addEventListener('message',(e)=>window.__msgs.push([e.origin,e.data]));
const v=document.getElementById('v'); if (v.readyState >= 1) window.__videoReady=true; else v.onloadedmetadata=()=>{window.__videoReady=true;};
</script></body>`);
    res.writeHead(page[0], page[1]); res.end(page[2]);
  });
  port = srv.port;
  const { conn, session: s, stop } = await launch();
  try {
    await s.run(() => s.newPage(`${srv.base}/`));
    await sleep(1500);
    const tabId = (await conn.listTabs())[0].tabId;
    conn.resize(tabId, 1000, 700, 2, 1.25, { width: 1512, height: 982, x: 40, y: 60 }); // retina, 125% zoom, a real screen
    await sleep(800);
    const info = await s.evaluateScript('() => ({ same: !!document.getElementById("same").contentDocument, cross: !!document.getElementById("cross").contentDocument })') as { same: boolean; cross: boolean };
    r.check('setup: the second iframe is cross-origin (no contentDocument access)', info.same && !info.cross, info);
    await humanClick(conn, tabId, 60, 30); await sleep(300);
    await humanClick(conn, tabId, 60, 150); await sleep(600);
    const msgs = await s.evaluateScript('() => window.__msgs') as [string, { childClick?: boolean; trusted?: boolean; typed?: string }][];
    const fromSame = msgs.filter((m) => m[0].includes('127.0.0.1')), fromCross = msgs.filter((m) => m[0].includes('localhost'));
    r.check('human click reaches a button in a same-origin iframe', fromSame.some((m) => m[1].childClick && m[1].trusted), msgs);
    r.check('human click reaches a button in a CROSS-origin iframe', fromCross.some((m) => m[1].childClick && m[1].trusted), msgs);

    await humanClick(conn, tabId, 60, 185);
    for (const ch of 'hi') await humanKey(conn, tabId, ch, 'Key' + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0), ch);
    await sleep(400);
    const typed = (await s.evaluateScript('() => window.__msgs') as [string, { typed?: string }][]).filter((m) => m[0].includes('localhost') && m[1].typed !== undefined);
    r.check('typing after clicking into the cross-origin frame lands there', typed.length > 0 && typed[typed.length - 1][1].typed === 'hi', typed);
    await s.evaluateScript('() => { const i = document.createElement("input"); i.id = "top"; i.style.cssText = "position:absolute;left:400px;top:20px;width:120px;height:24px"; document.body.appendChild(i); }');
    await humanClick(conn, tabId, 450, 30);
    await humanKey(conn, tabId, 'z', 'KeyZ', 90, 'z');
    await sleep(200);
    r.check('clicking back on the page returns keyboard focus to it', (await s.evaluateScript('() => document.getElementById("top").value')) === 'z');

    for (let i = 0; i < 40 && !(await s.evaluateScript('() => window.__videoReady')); i++) await sleep(250);
    r.check('setup: a real video loaded', (await s.evaluateScript('() => !!window.__videoReady')) === true);
    await humanClick(conn, tabId, 160, 320); await sleep(500);
    r.check('clicking the video body starts playback (native control behaviour)', (await s.evaluateScript('() => document.getElementById("v").paused')) === false);
    await humanClick(conn, tabId, 25, 240 + 132); await sleep(500);
    r.check('clicking the native play/pause button toggles it', (await s.evaluateScript('() => document.getElementById("v").paused')) === true);
  } finally {
    srv.close(); await stop();
  }
});
