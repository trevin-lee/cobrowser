/* A page's alert, confirm and prompt, answered by the agent: an action that opens one is told
 * at once what it asks, and handle_dialog's answer reaches the page. (The dialogs here wait for
 * the agent: COBROWSER_TEST_DIALOG=agent.) */
import { suite, launch, serve, html, sleep } from './harness';

const PAGE = `<title>dialogs</title>
<button id=c style="position:absolute;left:10px;top:10px;width:120px;height:30px" onclick="window.__c = confirm('Delete the draft?')">confirm</button>
<button id=p style="position:absolute;left:10px;top:50px;width:120px;height:30px" onclick="window.__p = prompt('Your name?', 'Ada')">prompt</button>
<button id=a style="position:absolute;left:10px;top:90px;width:120px;height:30px" onclick="alert('Saved'); window.__a = 'after'">alert</button>`;

suite('page-dialogs', async (r) => {
  const srv = await serve((_q, res) => { const [st, h, b] = html(PAGE); res.writeHead(st, h); res.end(b); });
  const { session: s, stop } = await launch({ env: { COBROWSER_TEST_DIALOG: 'agent' } });
  try {
    const page = await s.run(() => s.newPage(srv.base + '/'));
    await sleep(600);
    const id = page.pageId;
    const clickFor = async (selector: string) => {
      const t0 = Date.now();
      const err = await s.run(() => s.click({ selector, pageId: id }), id).then(() => '', (e: Error) => e.message);
      return { err, ms: Date.now() - t0 };
    };
    const value = (expr: string) => s.evaluateScript(`() => ${expr}`, [], id);

    const none = await s.handleDialog({ accept: true, pageId: id });
    r.check('with no dialog open, handle_dialog says so', /no dialog is open/.test(none.error ?? ''), none);

    const c = await clickFor('#c');
    r.check('a click that opens a confirm is told at once what it asks', /showing a confirm: "Delete the draft\?"/.test(c.err) && c.ms < 5000, c);
    const busy = await s.run(() => s.readPage({ pageId: id }), id).then(() => '', (e: Error) => e.message);
    r.check('other tools on the tab say the dialog is open, instead of hanging', /showing a confirm/.test(busy), busy);
    const answered = await s.handleDialog({ accept: false, pageId: id });
    await sleep(300);
    r.check('handle_dialog answers the confirm, and the page gets the answer', answered.answered === 'confirm' && (await value('window.__c')) === false, answered);

    await clickFor('#p');
    await s.handleDialog({ accept: true, text: 'Grace', pageId: id });
    await sleep(300);
    r.check('a prompt is answered with the given text', (await value('window.__p')) === 'Grace');

    await clickFor('#a');
    await s.handleDialog({ accept: true, pageId: id });
    await sleep(300);
    r.check('an alert is dismissed and the page carries on', (await value('window.__a')) === 'after');
  } finally {
    srv.close(); await stop();
  }
});
