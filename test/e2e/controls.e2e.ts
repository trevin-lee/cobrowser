/* What the agent needs from the panel on real sites: controls drawn over hidden inputs are
 * listed as the thing to click, a click that did nothing says so, and it can wait until a page
 * has finished updating. */
import { suite, launch, serve, html, sleep } from './harness';
import { CONTROLS_PAGE } from './fixtures-controls';

suite('controls', async (r) => {
  const srv = await serve((_q, res) => { const [st, h, b] = html(CONTROLS_PAGE); res.writeHead(st, h); res.end(b); });
  const { session: s, stop } = await launch();
  try {
    await s.run(() => s.newPage(srv.base + '/'));
    const snap = await s.run(() => s.takeSnapshot());
    const uid = (re: RegExp) => new RegExp('\\[(\\d+)\\] ' + re.source).exec(snap)?.[1];
    r.check('a radio drawn over a hidden input is listed once, as its label, with its state', /input:radio "User alias domain" \[unchecked\]/.test(snap) && /input:radio "Secondary domain" \[checked\]/.test(snap) && (snap.match(/User alias domain/g) || []).length === 1, snap);
    r.check('an ARIA radio is listed with its state', /radio "Workers" \[unchecked\]/.test(snap), snap);
    const pick = await s.run(() => s.click({ uid: uid(/input:radio "User alias domain"/) }));
    r.check('clicking it selects the radio', (await s.evaluateScript('() => document.getElementById("r1").checked')) === true && 'clicked' in pick && !pick.noVisibleEffect, pick);

    const changed = await s.run(() => s.click({ selector: '#change' }));
    r.check('a click that changed the page is not flagged', 'clicked' in changed && !changed.noVisibleEffect, changed);
    const inert = await s.run(() => s.click({ selector: '#inert' }));
    r.check('a click that changed nothing says so', 'clicked' in inert && inert.noVisibleEffect === true, inert);

    await s.run(() => s.click({ selector: '#load' }));
    const t0 = Date.now();
    const settled = await s.waitFor([], 10000, undefined, { settle: true });
    const waited = Date.now() - t0;
    const done = (await s.evaluateScript('() => document.getElementById("feed").textContent')) as string;
    r.check('settle waits until the page stops changing, not just for a moment', settled.settled === true && done.endsWith('Done') && waited >= 900, { waited, done });
    const quick = Date.now();
    const any = await s.waitFor(['no such text', 'Done'], 5000);
    r.check('wait_for waits for any of its texts and says which appeared', any.found === 'Done', any);
    const both = await s.waitFor(['Done'], 5000, undefined, { settle: true });
    r.check('text and settle together return promptly on a page already still', both.settled === true && Date.now() - quick < 1500, { ms: Date.now() - quick });
    await sleep(50);
  } finally {
    srv.close(); await stop();
  }
});
