import { test } from 'node:test';
import assert from 'node:assert/strict';

type Scope = 'all' | string[];
type Entry = { id: string; host: string; port: string; username: string; password: string; scope: Scope; also?: { host: string; port: string }[]; updatedAt: number };
type Page = { host: string; port: string };
const page = (url: string): Page => { const u = new URL(url); return { host: u.hostname, port: u.port }; };
type Vault = { entries: Entry[] };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require('../app/vault-store.js') as {
  mergeScope: (a: Scope, b: Scope) => Scope;
  allowed: (e: Entry, workspaceId: string) => boolean;
  findEntry: (v: Vault, label: string, username: string) => Entry | undefined;
  upsertLogin: (v: Vault, site: string, username: string, password: string, scope?: Scope, opts?: { mergeScope?: boolean; also?: string | string[] }) => { entry: Entry; replaced: boolean };
  loginMatches: (e: Entry, page: Page) => boolean;
  publicEntry: (e: Entry) => { host: string; also: string[]; username: string; scope: Scope };
  updateLogin: (v: Vault, from: { host: string; username: string }, fields: { site?: string; username?: string; password?: string; scope?: Scope; also?: string | string[] }) => Entry;
  removeLogin: (v: Vault, host: string, username: string) => number;
  importCsv: (v: Vault, text: string, scope: Scope) => { count: number; added: number; replaced: number };
  exportCsv: (v: Vault) => string;
  applyScopeChange: (current: Scope, before: Scope, after: Scope) => Scope;
  splitNote: (note: string) => { notes: string; workspaces?: Scope; sites?: string[] };
};

const empty = (): Vault => ({ entries: [] });

test('adding a login that exists replaces its password and says so, instead of making a second copy', () => {
  const v = empty();
  assert.equal(store.upsertLogin(v, 'https://costco.com/login', 'me', 'one', ['/a']).replaced, false);
  const again = store.upsertLogin(v, 'costco.com', 'me', 'two', ['/b']);
  assert.equal(again.replaced, true);
  assert.equal(v.entries.length, 1);
  assert.equal(v.entries[0].password, 'two');
});

test('adding again widens who may use a login (never narrows it); the form, which chose the scope, replaces it', () => {
  const v = empty();
  store.upsertLogin(v, 'costco.com', 'me', 'pw', ['/a']);
  store.upsertLogin(v, 'costco.com', 'me', 'pw', ['/b']);
  assert.deepEqual(v.entries[0].scope, ['/a', '/b'], 'a command or an import adds its workspace');
  store.upsertLogin(v, 'costco.com', 'me', 'pw', ['/c'], { mergeScope: false });
  assert.deepEqual(v.entries[0].scope, ['/c'], 'the Logins window form sets exactly what was ticked');
  assert.equal(store.mergeScope(['/a'], 'all'), 'all');
  assert.equal(store.allowed(v.entries[0], '/c'), true);
  assert.equal(store.allowed(v.entries[0], '/a'), false);
});

test('a login on another port, or with another username, is a different login', () => {
  const v = empty();
  store.upsertLogin(v, '192.168.1.50:8080', 'admin', 'x', 'all');
  store.upsertLogin(v, '192.168.1.50:9090', 'admin', 'y', 'all');
  store.upsertLogin(v, '192.168.1.50:8080', 'guest', 'z', 'all');
  assert.equal(v.entries.length, 3);
  assert.equal(store.findEntry(v, '192.168.1.50:9090', 'admin')?.password, 'y');
});

test('editing changes site, username and scope in place, and keeps the password when none is given', () => {
  const v = empty();
  store.upsertLogin(v, 'costco.com', 'old@x.com', 'secret', ['/a']);
  const id = v.entries[0].id;
  store.updateLogin(v, { host: 'costco.com', username: 'old@x.com' }, { site: 'www.costco.com', username: 'new@x.com', scope: 'all' });
  assert.equal(v.entries.length, 1);
  assert.deepEqual({ ...v.entries[0], updatedAt: 0 }, { id, host: 'www.costco.com', port: '', username: 'new@x.com', password: 'secret', scope: 'all', updatedAt: 0 });
  store.updateLogin(v, { host: 'www.costco.com', username: 'new@x.com' }, { password: 'fresh' });
  assert.equal(v.entries[0].password, 'fresh');
});

test('editing refuses to turn one login into a duplicate of another, and to edit one that is gone', () => {
  const v = empty();
  store.upsertLogin(v, 'costco.com', 'a', '1', 'all');
  store.upsertLogin(v, 'costco.com', 'b', '2', 'all');
  assert.throws(() => store.updateLogin(v, { host: 'costco.com', username: 'b' }, { username: 'a' }), /already a login for a on costco\.com/);
  assert.equal(store.findEntry(v, 'costco.com', 'b')?.password, '2', 'the refused edit changed nothing');
  assert.throws(() => store.updateLogin(v, { host: 'nowhere.com', username: 'a' }, { password: 'x' }), /no longer in the vault/);
});

test('a login fills on each of its websites, each matched as strictly as its own site', () => {
  const v = empty();
  store.upsertLogin(v, 'login.microsoftonline.com', 'me@x.com', 'pw', 'all', { also: 'live.com, login.live.com' });
  const e = v.entries[0];
  assert.deepEqual(e.also, [{ host: 'live.com', port: '' }, { host: 'login.live.com', port: '' }]);
  const on = (url: string) => store.loginMatches(e, page(url));
  assert.equal(on('https://login.microsoftonline.com/common'), true);
  assert.equal(on('https://login.live.com/oauth20'), true);
  assert.equal(on('https://evil-live.com/'), false);
  assert.equal(on('https://example.com/'), false);
  store.upsertLogin(v, '192.168.1.1', 'admin', 'pw', 'all', { also: ['192.168.1.2'] });
  assert.equal(store.loginMatches(v.entries[1], page('http://192.168.1.2/')), true);
  assert.equal(store.loginMatches(v.entries[1], page('http://192.168.1.3/')), false);
});

test("editing sets a login's other websites; adding again only adds to them; the login's own site is never listed twice", () => {
  const v = empty();
  store.upsertLogin(v, 'microsoftonline.com', 'me', 'pw', 'all', { also: ['live.com'] });
  store.upsertLogin(v, 'microsoftonline.com', 'me', 'pw2', 'all', { also: ['office.com', 'microsoftonline.com'] });
  assert.deepEqual(store.publicEntry(v.entries[0]).also, ['live.com', 'office.com']);
  store.updateLogin(v, { host: 'microsoftonline.com', username: 'me' }, { also: '' });
  assert.equal(v.entries[0].also, undefined);
});

test('removing takes exactly the one login', () => {
  const v = empty();
  store.upsertLogin(v, 'costco.com', 'a', '1', 'all');
  store.upsertLogin(v, 'costco.com', 'b', '2', 'all');
  assert.equal(store.removeLogin(v, 'costco.com', 'a'), 1);
  assert.equal(store.removeLogin(v, 'costco.com', 'a'), 0);
  assert.deepEqual(v.entries.map((e) => e.username), ['b']);
});

test('import reports what it added and what it replaced; replaced logins keep their workspaces and gain the new ones', () => {
  const v = empty();
  store.upsertLogin(v, 'costco.com', 'me', 'old', ['/a']);
  const csv = 'Title,URL,Username,Password\nCostco,https://costco.com/,me,new\nBank,"https://bank.co.uk/login",you,"p,w""q"\nNo password,https://x.com,z,\n';
  assert.deepEqual(store.importCsv(v, csv, ['/b']), { count: 2, added: 1, replaced: 1 });
  const costco = store.findEntry(v, 'costco.com', 'me')!;
  assert.equal(costco.password, 'new');
  assert.deepEqual(costco.scope, ['/a', '/b']);
  assert.equal(store.findEntry(v, 'bank.co.uk', 'you')?.password, 'p,w"q');
  assert.deepEqual(store.findEntry(v, 'bank.co.uk', 'you')?.scope, ['/b']);
  assert.throws(() => store.importCsv(v, 'a,b\n1,2\n', 'all'), /url\/username\/password/);
});

test('export writes every login in a form other managers and this vault read back identically', () => {
  const v = empty();
  store.upsertLogin(v, 'costco.com', 'me', 'p,w"q', ['/a']);
  store.upsertLogin(v, '192.168.1.1', 'admin', 'r', 'all');
  store.upsertLogin(v, 'nas:5000', 'admin', 's', 'all', { also: ['nas.local:5000'] });
  const csv = store.exportCsv(v);
  assert.match(csv, /^name,url,username,password,note\n/);
  assert.match(csv, /,https:\/\/costco\.com,/);
  assert.match(csv, /,http:\/\/192\.168\.1\.1,/, 'a device on the network is plain http');
  assert.match(csv, /,http:\/\/nas:5000,/);
  const back = empty();
  assert.deepEqual(store.importCsv(back, csv, []), { count: 3, added: 3, replaced: 0 });
  const pairs = (x: Vault) => x.entries.map((e) => [e.host, e.port, e.username, e.password, JSON.stringify(e.scope), JSON.stringify((e as { also?: unknown }).also ?? null)]).sort();
  assert.deepEqual(pairs(back), pairs(v), 'the same logins, each with the workspaces it had');
});

test('a row from a cobrowser export keeps exactly its workspaces; the chosen ones go to rows without a note', () => {
  const v = empty();
  const csv = 'name,url,username,password,note\na,https://a.com,me,1,"cobrowser-workspaces: [""/x""]"\nb,https://b.com,me,2,remember the dog\n';
  store.importCsv(v, csv, ['/y']);
  assert.deepEqual(store.findEntry(v, 'a.com', 'me')?.scope, ['/x']);
  assert.deepEqual(store.findEntry(v, 'b.com', 'me')?.scope, ['/y']);
});

test("notes travel with a login: set, kept when adding again without notes, cleared by editing them away", () => {
  const v = empty();
  store.upsertLogin(v, 'costco.com', 'me', 'pw', 'all', { notes: '  Use the **business** account.\r\n2FA: ask Trevin.  ' } as never);
  const e = v.entries[0] as Entry & { notes?: string };
  assert.equal(e.notes, 'Use the **business** account.\n2FA: ask Trevin.');
  store.upsertLogin(v, 'costco.com', 'me', 'pw2', 'all');
  assert.equal(e.notes, 'Use the **business** account.\n2FA: ask Trevin.', 'adding again without notes keeps them');
  store.updateLogin(v, { host: 'costco.com', username: 'me' }, { notes: '' } as never);
  assert.equal(e.notes, undefined);
});

test("export puts the person's notes first in the note column, and import takes them back without cobrowser's own lines", () => {
  const v = empty();
  store.upsertLogin(v, 'a.com', 'me', 'pw', ['/w'], { notes: 'Line one\n- a list', also: ['b.com'] } as never);
  const csv = store.exportCsv(v);
  assert.match(csv, /"Line one\n- a list\n\ncobrowser-workspaces: \[""\/w""\]\ncobrowser-sites: \[""b.com""\]"/);
  const back = empty();
  store.importCsv(back, csv, []);
  const e = back.entries[0] as Entry & { notes?: string };
  assert.deepEqual([e.notes, e.scope, e.also?.map((s) => s.host)], ['Line one\n- a list', ['/w'], ['b.com']]);
});

test("only a note's last lines are cobrowser's own: the same words in the person's text stay theirs", () => {
  const note = 'Uses the cobrowser-workspaces: "all" trick\ncobrowser-sites: written by hand\n\ncobrowser-workspaces: ["/ws/a"]\ncobrowser-sites: ["c.com"]';
  assert.deepEqual(store.splitNote(note), { notes: 'Uses the cobrowser-workspaces: "all" trick\ncobrowser-sites: written by hand', workspaces: ['/ws/a'], sites: ['c.com'] });
  assert.deepEqual(store.splitNote('cobrowser-workspaces: not json'), { notes: 'cobrowser-workspaces: not json', workspaces: undefined, sites: undefined });
  const v = empty();
  store.upsertLogin(v, 'a.com', 'me', 'pw', ['/ws/a'], { notes: 'cobrowser-sites: is how I label things', also: ['c.com'] } as never);
  const back = empty();
  store.importCsv(back, store.exportCsv(v), ['/default']);
  const e = back.entries[0] as Entry & { notes?: string };
  assert.deepEqual([e.notes, e.scope, e.also?.map((s) => s.host)], ['cobrowser-sites: is how I label things', ['/ws/a'], ['c.com']]);
});

test('a change to the workspaces someone was looking at never undoes a grant made since', () => {
  // The window showed [/a]; an agent in /b was allowed meanwhile; the person ticks /c.
  assert.deepEqual(store.applyScopeChange(['/a', '/b'], ['/a'], ['/a', '/c']), ['/a', '/b', '/c']);
  // Unticking /a takes off /a only.
  assert.deepEqual(store.applyScopeChange(['/a', '/b'], ['/a'], []), ['/b']);
  // Everywhere, on or off, is a choice of the whole scope.
  assert.equal(store.applyScopeChange(['/a', '/b'], ['/a'], 'all'), 'all');
  assert.deepEqual(store.applyScopeChange('all', 'all', ['/a']), ['/a']);
});
