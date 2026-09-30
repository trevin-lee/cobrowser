/* The browser extensions' own page code (the bridge into the human's Chrome and Firefox), run
 * in an isolated tab with the browser APIs stubbed: its snapshot, click-effect and settle
 * scripts are the ones that ship, tested without touching the human's browser. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { suite, launch, serve, html, sleep, ROOT } from './harness';
import { CONTROLS_PAGE } from './fixtures-controls';

const STUB = `(() => { const p = new Proxy(function () {}, { get: () => p, apply: () => p, construct: () => p }); globalThis.chrome = p; globalThis.browser = p; })();`;

type Item = { ref: string; tag: string; label: string; control?: string; checked?: boolean; value?: string; type?: string };

suite('bridge-scripts', async (r) => {
  const srv = await serve((_q, res) => { const [st, h, b] = html(CONTROLS_PAGE); res.writeHead(st, h); res.end(b); });
  const { conn, session: s, stop } = await launch();
  try {
    for (const ext of ['chrome-extension', 'firefox-extension']) {
      const page = await s.run(() => s.newPage(srv.base + '/'));
      const tabId = (await conn.listTabs()).find((t) => t.url === srv.base + '/' && !(t as { used?: boolean }).used)!.tabId;
      const src = fs.readFileSync(path.join(ROOT, ext, 'background.js'), 'utf8');
      const loaded = await conn.cdp<{ exceptionDetails?: { exception?: { description?: string } } }>(tabId, 'Runtime.evaluate', { expression: STUB + '\n' + src });
      r.check(`[${ext}] its background script loads in a page with the browser APIs stubbed`, !loaded.exceptionDetails, loaded.exceptionDetails?.exception?.description);
      const run = async <T,>(expr: string): Promise<T> => {
        const res = await conn.cdp<{ result: { value?: T }; exceptionDetails?: { exception?: { description?: string } } }>(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? 'evaluate failed');
        return res.result.value as T;
      };
      await run('document.getElementById("pw").value = "hunter2"; true');
      const snap = await run<{ elements: Item[] }>('PAGE_SCRIPTS.snapshot({})');
      const byLabel = (t: string) => snap.elements.find((e) => e.label.includes(t));
      const user = byLabel('User alias domain');
      r.check(`[${ext}] a radio drawn over a hidden input is listed once, as its label, with its state`, !!user && user.tag === 'label' && user.control === 'radio' && user.checked === false && byLabel('Secondary domain')?.checked === true && snap.elements.filter((e) => e.label.includes('User alias domain')).length === 1, snap.elements.map((e) => [e.tag, e.label, e.control, e.checked]));
      r.check(`[${ext}] an ARIA radio is listed with its state`, byLabel('Workers')?.control === 'radio' && byLabel('Workers')?.checked === false);
      const pw = snap.elements.find((e) => e.type === 'password');
      r.check(`[${ext}] a password field's value is never returned`, !!pw && pw.value === '(filled)' && !JSON.stringify(snap).includes('hunter2'), pw);
      await run('PAGE_SCRIPTS.effectStart()');
      await run(`PAGE_SCRIPTS.click(${JSON.stringify(user!.ref)}, null)`);
      await sleep(300);
      const picked = await run<{ changed: boolean }>('PAGE_SCRIPTS.effectRead()');
      r.check(`[${ext}] clicking the listed label selects the radio, and counts as an effect`, (await run<boolean>('document.getElementById("r1").checked')) === true && picked.changed === true, picked);

      await run('PAGE_SCRIPTS.effectStart()');
      await run('PAGE_SCRIPTS.click(null, "#inert")');
      await sleep(300);
      const none = await run<{ changed: boolean }>('PAGE_SCRIPTS.effectRead()');
      await run('PAGE_SCRIPTS.effectStart()');
      await run('PAGE_SCRIPTS.click(null, "#change")');
      await sleep(300);
      const some = await run<{ changed: boolean }>('PAGE_SCRIPTS.effectRead()');
      r.check(`[${ext}] a click that changed nothing is told apart from one that did`, none.changed === false && some.changed === true, { none, some });

      await run('PAGE_SCRIPTS.watch()');
      await run('PAGE_SCRIPTS.click(null, "#load")');
      await sleep(300);
      const busy = await run<{ quietFor: number }>('PAGE_SCRIPTS.quiet()');
      await sleep(1600);
      const still = await run<{ quietFor: number }>('PAGE_SCRIPTS.quiet()');
      r.check(`[${ext}] settle sees a page that is still changing, then one that has stopped`, busy.quietFor < 200 && still.quietFor >= 400, { busy, still });
      if (ext === 'firefox-extension') {
        const awaited = await run<unknown>('PAGE_SCRIPTS.evaluate("(async (n) => { await new Promise((r) => setTimeout(r, 50)); return n * 2; })(...[21])", "isolated")');
        r.check(`[${ext}] an async function's result is awaited, not dropped`, awaited === 42, awaited);
      } else {
        r.check(`[${ext}] carries no code evaluation at all (Chrome runs none, and the store forbids it)`, (await run<string>('typeof PAGE_SCRIPTS.evaluate')) === 'undefined' && !/\beval\(|new Function/.test(src));
      }
      const q = await run<{ count: number; items: Record<string, unknown>[] }>('PAGE_SCRIPTS.query("input", ["type", "value", "attr:id"], 50)');
      const pwItem = q.items.find((i) => i.type === 'password');
      r.check(`[${ext}] query reads every match with the fields asked, and never a password`, q.count === q.items.length && q.count >= 3 && pwItem?.value === '(filled)' && pwItem['attr:id'] === 'pw' && !JSON.stringify(q).includes('hunter2'), q);
      const bad = await run<{ __cobrowserError?: string }>('PAGE_SCRIPTS.query("a[", ["text"], 5)');
      r.check(`[${ext}] a bad selector is a clear error`, /not a valid CSS selector/.test(bad.__cobrowserError ?? ''), bad);
      const any = await run<{ found: boolean; text?: string }>('PAGE_SCRIPTS.probe(["no such text", "Workers"], null)');
      const none2 = await run<{ found: boolean }>('PAGE_SCRIPTS.probe(["no such text"], null)');
      r.check(`[${ext}] waiting for any of several texts finds the one that is there`, any.found && any.text === 'Workers' && !none2.found, { any, none2 });
      await s.run(() => s.closePage(page.pageId), page.pageId).catch(() => undefined);
      await sleep(300);
    }
  } finally {
    srv.close(); await stop();
  }
});
