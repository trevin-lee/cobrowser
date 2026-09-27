/* Scroll input latency and backlog on the human path, across the configurations that route input. */
import { launch, serve, html, sleep } from '../harness';

(async () => {
  let port = 0;
  const srv = await serve((q, res) => {
    const iframe = q.url!.includes('iframe') ? `<iframe src="http://localhost:${port}/child" style="position:fixed;right:10px;top:10px;width:300px;height:200px;border:0"></iframe>` : '';
    const churn = q.url!.includes('churn') ? `<script>let n=0;setInterval(()=>{const d=document.getElementById('ticker');d.textContent='tick '+(n++);const s=document.createElement('span');s.textContent='.';d.appendChild(s);},16)</script>` : '';
    const paras = Array.from({ length: 400 }, (_, i) => `<p style="margin:0;padding:12px;border-bottom:1px solid #ddd">Paragraph ${i} — the quick brown fox jumps over the lazy dog.</p>`).join('');
    const [st, h, b] = html(q.url === '/child' ? '<body style="background:#eef">ad</body>' : `<!doctype html><body style="margin:0;font:16px system-ui"><div id=ticker></div>${iframe}${paras}${churn}</body>`);
    res.writeHead(st, h); res.end(b);
  });
  port = srv.port;
  const { conn, stop } = await launch();
  const bench = async (label: string, query: string, human: boolean, screen?: { width: number; height: number; x: number; y: number }) => {
    const t = await conn.openTab(`${srv.base}/?${query}`, 1000, 700);
    let frames = 0; conn.subscribe(t.tabId, () => frames++);
    conn.resize(t.tabId, 1000, 700, 2, 1, screen);
    await sleep(1500);
    const N = 150, lat: number[] = [], pend: Promise<void>[] = [];
    const f0 = frames, t0 = Date.now();
    for (let i = 0; i < N; i++) {
      const s0 = Date.now();
      pend.push(conn.cdp(t.tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 400, deltaX: 0, deltaY: 20, modifiers: 0 }, 30000, human ? { human: true } : {}).then(() => { lat.push(Date.now() - s0); }, () => { lat.push(-1); }));
      await sleep(8);
    }
    const sentMs = Date.now() - t0; await Promise.all(pend); const doneMs = Date.now() - t0; await sleep(400);
    const fps = Math.round((frames - f0) / ((Date.now() - t0) / 1000));
    const y = (await conn.cdp<{ result: { value: number } }>(t.tabId, 'Runtime.evaluate', { expression: 'scrollY', returnByValue: true })).result.value;
    lat.sort((a, b) => a - b); const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
    console.log(`${label.padEnd(44)} p50 ${String(q(0.5)).padStart(4)}ms  p95 ${String(q(0.95)).padStart(4)}ms  max ${String(lat[lat.length - 1]).padStart(5)}ms  backlog ${String(doneMs - sentMs).padStart(5)}ms  ~${fps}fps  scrollY ${y}`);
    conn.unsubscribe(t.tabId); conn.closeTab(t.tabId); await sleep(300);
  };
  const SCREEN = { width: 1512, height: 982, x: 40, y: 60 };
  await bench('agent path (no routing, reference)', 'plain', false);
  await bench('human, plain page', 'plain', true);
  await bench('human, plain page + screen override', 'plain', true, SCREEN);
  await bench('human, cross-site iframe', 'iframe', true);
  await bench('human, iframe + busy DOM', 'iframe-churn', true);
  await bench('human, iframe + busy DOM + screen override', 'iframe-churn', true, SCREEN);
  srv.close(); await stop(); process.exit(0);
})();
