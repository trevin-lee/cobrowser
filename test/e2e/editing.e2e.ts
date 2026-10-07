/* The human's edit keys in the panel: the selection is read from a field as well as the page,
 * never from a password field, and cut, undo and redo reach the page as editing commands. */
import { suite, launch, serve, html, sleep } from './harness';
import { SELECTION_JS, pressEditKey, type Selection } from '../../src/browser/editing';

suite('editing', async (r) => {
  const srv = await serve((_q, res) => {
    const [st, h, b] = html('<input id=f value="hello world" style="width:300px"><input id=pw type=password value="secret"><p id=para>plain page text</p>');
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
  } finally {
    srv.close(); await stop();
  }
});
