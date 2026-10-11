/* The human's edit keys in the panel: the selection is read from a field as well as the page,
 * never from a password field, and cut, undo and redo reach the page as editing commands. */
import { suite, launch, serve, html, sleep } from './harness';
import { SELECTION_JS, pressEditKey, type Selection } from '../../src/browser/editing';

suite('editing', async (r) => {
  const srv = await serve((_q, res) => {
    const [st, h, b] = html(`<input id=f value="hello world" style="width:300px"><input id=pw type=password value="secret"><p id=para>plain page text</p>
<input id=a><input id=b><ul id=list tabindex=0><li>one</li><li>two</li><li>three</li></ul><div id=modal>open</div>
<script>window.__sel = 0; document.getElementById('list').addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') window.__sel++; });
addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('modal').textContent = 'closed'; });</script>`);
    res.writeHead(st, h); res.end(b);
  });
  const { conn, session: s, stop } = await launch();
  try {
    const page = await s.run(() => s.newPage(srv.base + '/'));
    await sleep(500);
    const tabId = (await conn.listTabs()).find((t) => t.url.startsWith(srv.base))!.tabId;
    const send = (method: string, params?: unknown) => conn.cdp(tabId, method, params, 30000, { human: true });
    const selection = async () => (await conn.cdp<{ result: { value: Selection } }>(tabId, 'Runtime.evaluate', { expression: SELECTION_JS, returnByValue: true })).result.value;
    const value = async () => (await s.evaluateScript('() => document.getElementById("f").value', [], page.pageId)) as string;

    await s.evaluateScript('() => { const f = document.getElementById("f"); f.focus(); f.setSelectionRange(0, 5); }', [], page.pageId);
    const inField = await selection();
    r.check('a selection inside a field is read, and can be cut', inField.text === 'hello' && inField.editable === true, inField);

    await pressEditKey(send, 'cut');
    await sleep(200);
    r.check('cut removes the selection from the field', (await value()) === ' world', await value());
    await pressEditKey(send, 'undo');
    await sleep(200);
    r.check('undo puts it back', (await value()) === 'hello world', await value());
    await pressEditKey(send, 'redo');
    await sleep(200);
    r.check('redo removes it again', (await value()) === ' world', await value());

    await s.evaluateScript('() => { const p = document.getElementById("pw"); p.focus(); p.select(); }', [], page.pageId);
    const inPassword = await selection();
    r.check('nothing is read from a password field', inPassword.text === '' && inPassword.editable === false, inPassword);

    await s.evaluateScript('() => { document.activeElement.blur(); const range = document.createRange(); range.selectNodeContents(document.getElementById("para")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }', [], page.pageId);
    const inPage = await selection();
    r.check('page text is read and cannot be cut', inPage.text === 'plain page text' && inPage.editable === false, inPage);

    // press_key: the keys a person reaches for, as real key events.
    const press = (key: string, extra: Record<string, unknown> = {}) => s.run(() => s.pressKeys({ key, pageId: page.pageId, ...extra }), page.pageId);
    await press('Escape');
    const modal = await s.evaluateScript('() => document.getElementById("modal").textContent', [], page.pageId);
    await s.evaluateScript('() => document.getElementById("a").focus()', [], page.pageId);
    await press('Tab');
    const focused = await s.evaluateScript('() => document.activeElement.id', [], page.pageId);
    await s.evaluateScript('() => document.getElementById("list").focus()', [], page.pageId);
    await press('ArrowDown', { times: 2 });
    const moved = await s.evaluateScript('() => window.__sel', [], page.pageId);
    r.check('press_key: Escape reaches the page, Tab moves focus, an arrow repeats', modal === 'closed' && focused === 'b' && moved === 2, { modal, focused, moved });
    await s.evaluateScript('() => { const f = document.getElementById("f"); f.value = "select me"; f.focus(); f.setSelectionRange(0, 0); }', [], page.pageId);
    await press('a', { modifiers: ['Meta'] });
    const all = await s.evaluateScript('() => { const f = document.getElementById("f"); return [f.selectionStart, f.selectionEnd]; }', [], page.pageId);
    r.check('press_key: ⌘A selects all in a field', JSON.stringify(all) === '[0,9]', all);
    await s.evaluateScript('() => document.getElementById("pw").focus()', [], page.pageId);
    const refused = await press('x') as { refused?: string[] };
    const pw = await s.evaluateScript('() => document.getElementById("pw").value', [], page.pageId);
    r.check('press_key: a printable key into a password field is refused', Array.isArray(refused.refused) && pw === 'secret', { refused, pw });
  } finally {
    srv.close(); await stop();
  }
});
