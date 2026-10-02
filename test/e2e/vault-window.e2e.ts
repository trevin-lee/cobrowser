/* The vault window as a person sees it: its names, the Logins and Cards views, a login's websites
 * as a list, Markdown notes shown formatted, and room to see the workspaces. Screenshots of each
 * view are saved in the suite's scratch folder for a look. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { suite, launch, SCRATCH } from './harness';

suite('vault-window', async (r) => {
  const L = await launch({ workspace: path.join(SCRATCH, 'ws-V') });
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
    const cards = (await L.conn.vaultWindow(`({ state: document.getElementById('state').textContent, sub: document.getElementById('sub').textContent, foot: document.getElementById('new').textContent, importHidden: document.getElementById('import').hidden, notes: !!document.querySelector('#detail .md') })`)).value as Record<string, unknown>;
    r.check('Cards is a view of the same vault: its own add button, no import, a notes section', cards.foot === 'Add card' && cards.importHidden === true && cards.notes === true && cards.state === '1 card · unlocked', cards);
    r.note('screenshots', shots);
  } finally {
    await L.stop();
  }
});
