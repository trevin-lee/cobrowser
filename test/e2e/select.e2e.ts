/* Native <select>: a human click opens the app's menu; the agent's fill picks by text. */
import { suite, launch, serve, html, sleep, humanClick } from './harness';

const PAGE = `<!doctype html><title>select</title><body style="margin:0">
<select id="exp" style="position:absolute;left:20px;top:20px;width:220px;height:32px;font-size:16px">
  <option value="">Select an expiration date…</option><option value="7d">7 days</option><option value="30d">30 days</option>
  <optgroup label="Longer"><option value="90d">90 days</option></optgroup>
</select>
<button id="b" style="position:absolute;left:20px;top:100px;width:100px;height:32px">Btn</button>
<script>
  window.__changes = []; window.__clicks = 0;
  document.getElementById('exp').addEventListener('change', (e) => window.__changes.push([e.target.value, e.isTrusted]));
  document.getElementById('b').addEventListener('click', (e) => { window.__clicks += e.isTrusted ? 1 : 100; });
</script></body>`;

suite('select', async (r) => {
  const srv = await serve((_q, res) => { const [st, h, b] = html(PAGE); res.writeHead(st, h); res.end(b); });
  const { conn, session: s, stop } = await launch({ env: { COBROWSER_TEST_SELECT_PICK: '2' } });
  try {
    await s.run(() => s.newPage(srv.base + '/'));
    const tabId = (await conn.listTabs())[0].tabId;

    const press = await conn.cdp<{ selectMenu?: boolean }>(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 36, button: 'left', clickCount: 1 }, 30000, { human: true });
    const release = await conn.cdp<{ selectMenu?: boolean }>(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: 36, button: 'left', clickCount: 1 }, 30000, { human: true });
    await sleep(300);
    const after = await s.evaluateScript('() => [document.getElementById("exp").value, window.__changes]') as [string, unknown[]];
    r.check('human click on select was intercepted (press and release)', press.selectMenu === true && release.selectMenu === true, { press, release });
    r.check('the menu choice landed in the page with a change event', after[0] === '30d' && after[1].length === 1, after);

    await humanClick(conn, tabId, 60, 116);
    await sleep(200);
    r.check('human click on a button still reaches the page as trusted input', (await s.evaluateScript('() => window.__clicks')) === 1);

    await s.run(() => s.fill({ selector: '#exp', value: '7 days' }));
    await s.run(() => s.fill({ selector: '#exp', value: '90d' }));
    await s.run(() => s.fill({ selector: '#exp', value: '30 DAYS' }));
    const vals = await s.evaluateScript('() => window.__changes.map((c) => c[0])') as string[];
    r.check('agent fill picks by text, by value, and case-insensitively, firing change each time', JSON.stringify(vals) === JSON.stringify(['30d', '7d', '90d', '30d']), vals);
    let err = '';
    try { await s.run(() => s.fill({ selector: '#exp', value: 'never' })); } catch (e) { err = String((e as Error).message); }
    r.check('a missing option is a clear error', /no option matches/.test(err), err);
    await s.run(() => s.click({ selector: '#exp' }));
    r.check('agent click on the select just focuses it', (await s.evaluateScript('() => document.activeElement.id')) === 'exp');
  } finally {
    srv.close(); await stop();
  }
});
