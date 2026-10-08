/* The vault window as a person sees it: its names, the Logins and Cards views, a login's websites
 * as a list, Markdown notes shown formatted, and room to see the workspaces. Screenshots of each
 * view are saved in the suite's scratch folder for a look. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { suite, launch, SCRATCH } from './harness';

suite('vault-window', async (r) => {
  // Cards go out to and come in from files of the test's own (no save or open dialog).
  const cardsOut = path.join(SCRATCH, 'cards-out.csv'), cardsIn = path.join(SCRATCH, 'cards-in.csv');
  fs.writeFileSync(cardsIn, 'Card Number,Expiration Month,Expiration Year,CVV,Cardholder Name\n5555555555554444,12,2031,999,Bo\n');
  fs.rmSync(cardsOut, { force: true });
  const L = await launch({ workspace: path.join(SCRATCH, 'ws-V'), env: { COBROWSER_TEST_EXPORT_PATH: cardsOut, COBROWSER_TEST_IMPORT_PATH: cardsIn } });
  const shots = path.join(SCRATCH, 'vault-shots'); fs.mkdirSync(shots, { recursive: true });
  const snap = async (name: string, script?: string, wait?: number) => {
    const res = await L.conn.vaultWindow(script, { capture: true, wait });
    if (res.png) fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(res.png, 'base64'));
    return res;
  };
  try {
    await L.conn.vaultAdd('https://login.microsoftonline.com', 'ada@example.com', 'pw-1', 'all', ['live.com'], '# Work account\nUse **this** one, not the personal.\n- 2FA: `ask Trevin`\n- help: https://example.com/help');
    await L.conn.vaultAdd('costco.com', 'ada', 'pw-2');
    await L.conn.vaultAddCard({ number: '4242424242424242', exp: '03/29', cvc: '123', name: 'Ada Lovelace', label: 'Personal' });
    // A mistake is said before the person is asked to confirm: no confirmation is reached.
    const asked = () => fs.readFileSync(path.join(SCRATCH, 'data', 'app.log'), 'utf8').split('confirmation skipped for: add a card').length - 1;
    const askedBefore = asked();
    const bad = await L.conn.vaultAddCard({ number: '1234', exp: '03/29' }).then(() => 'saved', (e: Error) => e.message);
    const dup = await L.conn.vaultAddCard({ number: '4242424242424242', exp: '03/29' }).then(() => 'saved', (e: Error) => e.message);
    r.check('a card mistake (a bad number, a card already saved) is refused before any confirmation is asked', /not a valid card number/.test(bad) && /already saved/.test(dup) && asked() === askedBefore, { bad, dup, askedBefore, after: asked() });

    const opened = await snap('1-list', `document.querySelector('.item') ? 1 : 0`, 800);
    r.check('the window opens large enough to see a login and its workspaces', opened.width >= 860 && opened.height >= 560, { width: opened.width, height: opened.height });
    const header = await L.conn.vaultWindow(`({ title: document.title, h1: document.querySelector('header h1').textContent, kinds: [...document.querySelectorAll('.kinds button')].map((b) => b.textContent), foot: [...document.querySelectorAll('.foot button')].map((b) => b.textContent), wrapped: [...document.querySelectorAll('.foot button, header button')].some((b) => b.offsetHeight > 34) })`);
    const h = header.value as { title: string; h1: string; kinds: string[]; foot: string[]; wrapped: boolean };
    r.check('it is the Vault, with Logins and Cards as its views', h.title === 'cobrowser vault' && h.h1 === 'Vault' && h.kinds.join() === 'Logins,Cards', h);
    r.check('the add button stands alone and no button wraps', h.foot.join() === 'Add login' && !h.wrapped, h);

    const detail = await snap('2-login', `[...document.querySelectorAll('.item')].find((i) => i.textContent.includes('microsoftonline')).click(); 1`);
    void detail;
    const shown = (await L.conn.vaultWindow(`({ sites: [...document.querySelectorAll('#detail .sites .site')].map((s) => s.textContent), strong: document.querySelector('#detail .md strong')?.textContent, code: document.querySelector('#detail .md code')?.textContent, link: document.querySelector('#detail .md a')?.getAttribute('href'), heading: document.querySelector('#detail .md h4')?.textContent, scope: !!document.querySelector('#detail .scope') })`)).value as Record<string, unknown>;
    r.check("a login's websites are a list, one row each", JSON.stringify(shown.sites) === JSON.stringify(['login.microsoftonline.com', 'live.com']), shown);
    r.check('its notes are shown formatted', shown.strong === 'this' && shown.code === 'ask Trevin' && shown.link === 'https://example.com/help' && shown.heading === 'Work account' && shown.scope === true, shown);

    await snap('3-edit', `[...document.querySelectorAll('#detail button')].find((b) => b.textContent === 'Edit').click(); 1`);
    const form = (await L.conn.vaultWindow(`({ rows: [...document.querySelectorAll('#detail .sites .site input')].map((i) => i.value), add: !!document.querySelector('#detail .site.add button'), removes: document.querySelectorAll('#detail .site .x').length, notes: document.querySelector('#detail textarea.notes')?.value })`)).value as Record<string, unknown>;
    r.check('editing shows the websites as rows to remove, plus Add website, and the notes as Markdown text', JSON.stringify(form.rows) === JSON.stringify(['login.microsoftonline.com', 'live.com']) && form.add === true && form.removes === 2 && String(form.notes).startsWith('# Work account'), form);
    const overlap = (await L.conn.vaultWindow(`(() => { const a = document.querySelector('#detail .actions').getBoundingClientRect(); const sc = document.querySelector('#detail .scope').getBoundingClientRect(); return a.top >= sc.bottom - 1; })()`)).value;
    r.check("the form's buttons sit below the workspaces, not over them", overlap === true, overlap);
    await snap('4-add-website', `document.querySelector('#detail .site.add button').click(); document.querySelectorAll('#detail .sites .site input').length`);

    await snap('5-cards', `document.getElementById('k-cards').click(); document.querySelector('.item').click(); 1`);
    const cards = (await L.conn.vaultWindow(`({ state: document.getElementById('state').textContent, sub: document.getElementById('sub').textContent, foot: document.getElementById('new').textContent, io: !document.getElementById('import').hidden && !document.getElementById('export').hidden, notes: !!document.querySelector('#detail .md') })`)).value as Record<string, unknown>;
    r.check('Cards is a view of the same vault: its own add button, its own export and import, a notes section', cards.foot === 'Add card' && cards.io === true && cards.notes === true && cards.state === '1 card · unlocked', cards);

    // Cards have a backup: Export writes them to a file of their own, Import reads one back.
    await L.conn.vaultWindow(`document.getElementById('export').click(); 1`, { wait: 800 });
    const out = fs.existsSync(cardsOut) ? fs.readFileSync(cardsOut, 'utf8') : '';
    r.check("Export in the Cards view writes every card, number and code included, to its own CSV", /^label,name,number,expiry,code,notes\n/.test(out) && out.includes('4242424242424242,03/29,123'), out);
    const imported = await L.conn.vaultWindow(`document.getElementById('import').click(); 1`, { wait: 800 });
    void imported;
    const after = (await L.conn.vaultWindow(`({ state: document.getElementById('state').textContent, status: document.getElementById('status')?.textContent, items: document.querySelectorAll('#list .item').length })`)).value as Record<string, unknown>;
    r.check('Import in the Cards view adds the cards a file holds and says what it did', after.state === '2 cards · unlocked' && after.items === 2 && /Imported 1 card: 1 new/.test(String(after.status)), after);
    // With nothing selected there is no line beside an item: the message goes under the header.
    await L.conn.vaultWindow(`document.getElementById('k-logins').click(); sel = null; mode = 'view'; render(); document.getElementById('export').click(); 1`, { wait: 800 });
    const notice = (await L.conn.vaultWindow(`({ status: !!document.getElementById('status'), notice: document.getElementById('notice').hidden ? '' : document.getElementById('notice').textContent })`)).value as { status: boolean; notice: string };
    r.check('with nothing selected, what Export did is still said, under the header', notice.status === false && /^Exported \d+ logins? to /.test(notice.notice), notice);

    // The window shows the vault as it is: a grant made elsewhere appears at once, and unticking
    // a workspace here takes off only that one.
    await L.conn.vaultWindow(`document.getElementById('k-logins').click(); [...document.querySelectorAll('.item')].find((i) => i.textContent.includes('costco')).click(); 1`);
    await L.conn.vaultAdd('costco.com', 'ada', 'pw-2', ['/elsewhere/ws-X']);
    const scopeNow = async () => (await L.conn.vaultWindow(`JSON.stringify(rows.find((x) => x.host === 'costco.com').scope)`)).value as string;
    const live = JSON.parse(await scopeNow()) as string[];
    r.check('a grant made elsewhere shows in the open window at once', live.includes('/elsewhere/ws-X') && live.some((w) => w.endsWith('/ws-V')), live);
    await L.conn.vaultWindow(`[...document.querySelectorAll('#detail .ws .name')].find((n) => n.title.endsWith('/ws-V')).parentElement.click(); 1`, { wait: 600 });
    const unticked = JSON.parse(await scopeNow()) as string[];
    r.check('unticking a workspace takes off that one and keeps the grant made elsewhere', JSON.stringify(unticked) === JSON.stringify(['/elsewhere/ws-X']), unticked);

    // The accent setting recolours the open window at once, shades included.
    L.conn.setAccent('#ff5c1a');
    const painted = (await L.conn.vaultWindow(`({ accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), selected: getComputedStyle(document.querySelector('.item.sel')).boxShadow })`, { wait: 500 })).value as Record<string, string>;
    r.check('the accent setting recolours the open vault window, selection included', painted.accent === '#ff5c1a' && painted.selected.includes('rgb(255, 92, 26)'), painted);
    L.conn.setAccent('#2b5bff');

    // A Lock from elsewhere (the menu bar, the editor) shows in the window at once.
    await L.conn.vaultLock();
    const locked = (await L.conn.vaultWindow(`({ state: document.getElementById('state').textContent, lockShown: !document.getElementById('lock').hidden, items: document.querySelectorAll('#list .item').length })`)).value as Record<string, unknown>;
    r.check('a Lock from elsewhere shows at once: nothing listed, no Lock button', locked.state === 'Locked' && locked.lockShown === false && locked.items === 0, locked);
    r.note('screenshots', shots);
  } finally {
    await L.stop();
  }
});
