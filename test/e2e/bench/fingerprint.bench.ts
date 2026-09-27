/* What a site sees: UA, client hints, screen, permissions. Reads only; nothing is asserted. */
import { launch, serve, html, sleep } from '../harness';

(async () => {
  let headers: Record<string, unknown> = {};
  const srv = await serve((q, res) => { headers = q.headers; const [st, h, b] = html('<title>fp</title>ok'); res.writeHead(st, { ...h, 'accept-ch': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version' }); res.end(b); });
  const { conn, session: s, stop } = await launch();
  const p = await s.run(() => s.newPage(srv.base + '/'));
  const tab = (await conn.listTabs())[0].tabId;
  conn.resize(tab, 1280, 800, 1, 1, { width: 1512, height: 982, x: 40, y: 60 });
  await sleep(600);
  await s.run(() => s.navigate('reload', undefined, 8000, p.pageId), p.pageId);
  const js = await s.evaluateScript(`async () => {
    const gl = document.createElement('canvas').getContext('webgl'); const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const hi = await navigator.userAgentData?.getHighEntropyValues(['fullVersionList', 'platformVersion']).catch(() => null);
    return { userAgent: navigator.userAgent, webdriver: navigator.webdriver, brands: navigator.userAgentData?.brands, fullVersionList: hi?.fullVersionList, languages: navigator.languages,
      plugins: navigator.plugins.length, screen: [screen.width, screen.height, screenX, screenY], window: [innerWidth, innerHeight, outerWidth, outerHeight],
      webglRenderer: dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL), hasFocus: document.hasFocus(), notificationPermission: Notification.permission };
  }`, [], p.pageId);
  console.log(JSON.stringify({ headers: Object.fromEntries(Object.entries(headers).filter(([k]) => /user-agent|sec-ch|accept-language/.test(k))), page: js }, null, 2));
  srv.close(); await stop(); process.exit(0);
})();
