import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const wasm = require('../app/bitwarden/bitwarden.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BitwardenSource, endpoints } = require('../app/bitwarden-source.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require('../app/vault-store.js');

/** The web vault's own test account and sync (bitwarden/tests/data/vault.hex): made-up values,
 *  sealed by Bitwarden's web code. */
const V = JSON.parse(Buffer.from(fs.readFileSync('bitwarden/tests/data/vault.hex', 'utf8').replace(/\s/g, ''), 'hex').toString()).vault;

type Call = { method: string; url: string; headers: Record<string, string>; body: string };

/** A Bitwarden server in memory, answering as Vaultwarden does, for the test account. */
function fakeServer(opts: { twoFactor?: boolean; expire?: boolean } = {}) {
  const calls: Call[] = [];
  const created: unknown[] = [];
  let tokens = 0;
  const reply = (status: number, body: unknown) => ({ status, ok: status < 300, text: async () => JSON.stringify(body) });
  const fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const call = { method: init.method || 'GET', url, headers: init.headers || {}, body: init.body || '' };
    calls.push(call);
    const path = new URL(url).pathname.replace(/^\/vw/, '');
    if (path === '/identity/accounts/prelogin') return reply(200, { kdf: 0, kdfIterations: V.iterations });
    if (path === '/identity/connect/token') {
      const form = new URLSearchParams(call.body);
      if (form.get('grant_type') === 'refresh_token') return form.get('refresh_token') === 'r-1' ? reply(200, { access_token: `a-${++tokens}`, expires_in: 3600 }) : reply(400, { error: 'invalid_grant' });
      if (form.get('password') !== V.hash) return reply(400, { error: 'invalid_grant', error_description: 'invalid_username_or_password' });
      if (opts.twoFactor && form.get('twoFactorToken') !== '123456') return reply(400, { error: 'invalid_grant', TwoFactorProviders2: { 0: null, 1: { Email: 's***@example.com' } } });
      return reply(200, { access_token: `a-${++tokens}`, refresh_token: 'r-1', expires_in: opts.expire ? 0 : 3600, Key: V.sealedUser });
    }
    const auth = call.headers.Authorization;
    if (!auth || !auth.startsWith('Bearer a-')) return reply(401, {});
    if (path === '/api/sync') return reply(200, V.sync);
    if (path === '/api/ciphers' || path === '/api/ciphers/create') { const b = JSON.parse(call.body); created.push(b); return reply(200, { id: 'new-1', ...(b.cipher || b) }); }
    return reply(404, {});
  };
  return { calls, created, fetch };
}

function source(server: ReturnType<typeof fakeServer>) {
  return new BitwardenSource({ wasm, fetch: server.fetch, random: (n: number) => crypto.randomBytes(n), deviceId: 'dev-1' });
}

test('the server address: Bitwarden\'s own cloud, US and EU, or a self-hosted one under its path', () => {
  assert.deepEqual(endpoints('bitwarden.com'), { server: 'https://vault.bitwarden.com', api: 'https://api.bitwarden.com', identity: 'https://identity.bitwarden.com' });
  assert.equal(endpoints('https://vault.bitwarden.eu/#/login').identity, 'https://identity.bitwarden.eu');
  assert.deepEqual(endpoints('agents.example.ts.net/vaultwarden/'), { server: 'https://agents.example.ts.net/vaultwarden', api: 'https://agents.example.ts.net/vaultwarden/api', identity: 'https://agents.example.ts.net/vaultwarden/identity' });
  assert.equal(endpoints('http://localhost:8080').api, 'http://localhost:8080/api');
  assert.throws(() => endpoints('http://vault.example.com'), /https/);
  assert.throws(() => endpoints(''), /address/);
});

test('signs in with the master password, never sends it, and opens the vault in the built-in vault\'s shape', async () => {
  const server = fakeServer();
  const bw = source(server);
  assert.deepEqual(await bw.signIn({ server: 'https://vault.example.com/vw', email: V.user, password: V.typed }), { ok: true });
  assert.ok(server.calls.every((c) => !c.body.includes(V.typed) && !JSON.stringify(c.headers).includes(V.typed)), 'the master password never leaves');
  const token = new URLSearchParams(server.calls.find((c) => c.url.endsWith('/connect/token'))!.body);
  assert.equal(token.get('grant_type'), 'password');
  assert.equal(token.get('deviceIdentifier'), 'dev-1');
  const s = await bw.sync();
  assert.equal(s.logins, 2);
  const v = bw.vault({ scopes: {} });
  // A login with no website can't be filled anywhere: it isn't one the agent can use.
  assert.equal(v.entries.length, 1);
  assert.equal(v.noSite, 1);
  const bank = v.entries[0];
  assert.equal(bank.host, 'bank.example.com');
  assert.deepEqual(bank.scope, [], 'no workspace may use a server login until the person says so');
  assert.equal(bank.source, 'bitwarden');
  assert.ok(bank.hasTotp);
  assert.equal(bank.code().code.length, 6);
  assert.ok(!('fillsOn' in JSON.parse(JSON.stringify(bank))), 'the matcher never travels with the entry');
  // Bitwarden's matching, through the store's.
  assert.ok(store.loginMatches(bank, { host: 'bank.example.com', port: '', url: 'https://bank.example.com/login' }));
  assert.ok(!store.loginMatches(bank, { host: 'bank.example.com', port: '', url: 'http://bank.example.com/login' }), 'an https login never into an http page');
  assert.ok(!store.loginMatches(bank, { host: 'bank.example.com', port: '' }), 'no address, no match');
  assert.equal(v.cards.length, 1);
  assert.equal(v.cards[0].number.length >= 12, true);
  bw.lock();
  assert.throws(() => bw.vault(), /locked/);
});

test('a wrong master password is said as such', async () => {
  const bw = source(fakeServer());
  await assert.rejects(bw.signIn({ server: 'https://vault.example.com', email: V.user, password: 'not it' }), /email or master password/);
});

test('a two-step code is asked for, then sent', async () => {
  const server = fakeServer({ twoFactor: true });
  const bw = source(server);
  const first = await bw.signIn({ server: 'https://vault.example.com', email: V.user, password: V.typed });
  assert.equal(first.needs, 'twoFactor');
  assert.deepEqual(first.providers.map((p: { id: number; usable: boolean }) => [p.id, p.usable]), [[0, true], [1, true]]);
  assert.deepEqual(await bw.signIn({ server: 'https://vault.example.com', email: V.user, password: V.typed, twoFactor: { provider: 0, code: '123 456' } }), { ok: true });
  const last = new URLSearchParams(server.calls.filter((c) => c.url.endsWith('/connect/token')).pop()!.body);
  assert.equal(last.get('twoFactorProvider'), '0');
  assert.equal(last.get('twoFactorToken'), '123456');
});

test('workspaces and shared notes are cobrowser\'s own, by item id', async () => {
  const bw = source(fakeServer());
  await bw.signIn({ server: 'https://vault.example.com', email: V.user, password: V.typed });
  await bw.sync();
  const id = bw.vault().entries[0].id;
  const v = bw.vault({ scopes: { [id]: ['/Users/sam/shop'] } });
  assert.deepEqual(v.entries[0].scope, ['/Users/sam/shop']);
  assert.ok(store.allowed(v.entries[0], '/Users/sam/shop'));
  assert.ok(!store.allowed(v.entries[0], '/Users/sam/other'));
  // Notes reach agents only on an item marked with the notes field, a ticked checkbox.
  assert.equal(v.entries[0].notes, '');
  assert.deepEqual(Object.keys(store.publicEntry(v.entries[0])).sort(), ['also', 'hasPassword', 'hasTotp', 'host', 'name', 'notes', 'scope', 'scopeWas', 'source', 'username'].sort());
  assert.ok(!JSON.stringify(store.publicEntry(v.entries[0])).includes(v.entries[0].password));
});

test('a new login is sealed before it leaves, then synced', async () => {
  const server = fakeServer();
  const bw = source(server);
  await bw.signIn({ server: 'https://vault.example.com', email: V.user, password: V.typed });
  await bw.sync();
  const id = await bw.createLogin({ name: 'shop.example', username: 'sam', password: 'Made-up-9x', uris: ['https://shop.example'], notes: 'for agents', fields: [{ name: 'Share notes with agents', value: 'true', type: 2 }] });
  assert.equal(id, 'new-1');
  const sent = JSON.stringify(server.created[0]);
  for (const plain of ['Made-up-9x', 'shop.example', 'for agents', 'Share notes']) assert.ok(!sent.includes(plain), plain);
  assert.equal((server.created[0] as { type: number }).type, 1);
  const post = server.calls.find((c) => c.url.endsWith('/api/ciphers'))!;
  assert.equal(post.method, 'POST');
  assert.ok(server.calls.indexOf(post) < server.calls.map((c) => c.url).lastIndexOf('https://vault.example.com/api/sync?excludeDomains=true'), 'synced after');
  // An organization's login goes to /ciphers/create, with its collection.
  await assert.rejects(bw.createLogin({ name: 'x', username: 'y', password: 'z', uris: [], organizationId: V.orgId }), /collection/);
});

test('the kept sign-in opens the vault without the server, and a lapsed token is refreshed', async () => {
  const server = fakeServer({ expire: true });
  const bw = source(server);
  await bw.signIn({ server: 'https://vault.example.com', email: V.user, password: V.typed });
  await bw.sync();
  const kept = JSON.parse(JSON.stringify(bw.keep()));
  assert.ok(!JSON.stringify(kept).includes(V.typed));
  bw.lock();
  // Offline: nothing reaches the server, and the vault opens as the last sync had it.
  const offline = new BitwardenSource({ wasm, fetch: async () => { throw new TypeError('fetch failed'); }, random: (n: number) => crypto.randomBytes(n), deviceId: 'dev-1' });
  offline.restore(kept);
  assert.equal(offline.vault().entries.length, 1);
  await assert.rejects(offline.sync(), /could not be reached/);
  // Back online with a lapsed access token: the refresh token gets another.
  const again = source(server);
  again.restore(kept);
  const before = server.calls.length;
  await again.sync();
  const after = server.calls.slice(before).map((c) => new URL(c.url).pathname + (c.body.includes('refresh_token') ? ' refresh' : ''));
  assert.deepEqual(after, ['/identity/connect/token refresh', '/api/sync']);
});
