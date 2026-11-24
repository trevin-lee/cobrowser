// cobrowser's Bitwarden client against a real Vaultwarden (CI's vaultwarden job runs one): two
// made-up accounts are registered with Node's own crypto, the first makes an organization with a
// collection and lets the second in (its key sent to the second's RSA key, as a seat in someone
// else's organization gets it), and cobrowser's client (app/bitwarden-source.js and its
// WebAssembly) signs in as the second, reads the shared login, and saves a new one into the
// collection, which the first then reads with its own key.
//
//   VAULTWARDEN=http://localhost:8080 node test/vaultwarden/real-server.mjs
import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const wasm = require('../../app/bitwarden/bitwarden.js');
const { BitwardenSource } = require('../../app/bitwarden-source.js');
const BASE = (process.env.VAULTWARDEN || 'http://localhost:8080').replace(/\/$/, '');
const ITER = 600000;
const b64 = (b) => Buffer.from(b).toString('base64');
const expand = (prk, info) => crypto.createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest();
const seal = (key, plain) => {
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', key.subarray(0, 32), iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return `2.${b64(iv)}|${b64(ct)}|${b64(crypto.createHmac('sha256', key.subarray(32)).update(Buffer.concat([iv, ct])).digest())}`;
};
const unseal = (key, s) => {
  const [iv, ct] = s.slice(2).split('|').map((p) => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-cbc', key.subarray(0, 32), iv);
  return Buffer.concat([d.update(ct), d.final()]).toString();
};
const headers = { 'Bitwarden-Client-Name': 'desktop', 'Bitwarden-Client-Version': '2025.10.0', 'Device-Type': '7' };

async function call(method, path, { body, form, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...headers, Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : body ? { 'Content-Type': 'application/json' } : {}) },
    body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

/** A made-up account: its keys made here, registered as a Bitwarden client registers one. */
async function register(email, password) {
  const master = crypto.pbkdf2Sync(password, email, ITER, 32, 'sha256');
  const hash = b64(crypto.pbkdf2Sync(master, password, 1, 32, 'sha256'));
  const userKey = crypto.randomBytes(64);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const body = {
    email, name: email.split('@')[0], masterPasswordHash: hash, masterPasswordHint: null,
    key: seal(Buffer.concat([expand(master, 'enc'), expand(master, 'mac')]), userKey),
    kdf: 0, kdfIterations: ITER,
    keys: { publicKey: b64(publicKey.export({ type: 'spki', format: 'der' })), encryptedPrivateKey: seal(userKey, privateKey.export({ type: 'pkcs8', format: 'der' })) },
  };
  let r = await call('POST', '/api/accounts/register', { body });
  if (r.status === 404 || r.status === 405) {
    // Newer servers: ask for a sign-up token first (without mail, it comes back in the answer).
    const t = await call('POST', '/identity/accounts/register/send-verification-email', { body: { email, name: body.name, receiveMarketingEmails: false } });
    r = await call('POST', '/identity/accounts/register/finish', { body: { ...body, emailVerificationToken: t.json, userSymmetricKey: body.key, userAsymmetricKeys: body.keys } });
  }
  assert.ok(r.status < 300, `registering ${email}: ${r.status} ${JSON.stringify(r.json)}`);
  const tok = await call('POST', '/identity/connect/token', { form: { grant_type: 'password', username: email, password: hash, scope: 'api offline_access', client_id: 'desktop', deviceType: '7', deviceIdentifier: crypto.randomUUID(), deviceName: 'test' } });
  assert.equal(tok.status, 200, JSON.stringify(tok.json));
  return { email, password, userKey, publicKey, token: tok.json.access_token };
}

const run = Date.now().toString(36);
const PASSWORD = ['made', 'up', 'master', 'one'].join('-');
const owner = await register(`owner-${run}@example.com`, PASSWORD);
const seat = await register(`seat-${run}@example.com`, PASSWORD);

// The owner's organization, with one collection, and a login in it.
const orgKey = crypto.randomBytes(64);
const orgPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const org = await call('POST', '/api/organizations', { token: owner.token, body: {
  name: 'Family', billingEmail: owner.email, planType: 0, key: seal(owner.userKey, orgKey), collectionName: seal(orgKey, 'Shared'),
  keys: { publicKey: b64(orgPair.publicKey.export({ type: 'spki', format: 'der' })), encryptedPrivateKey: seal(orgKey, orgPair.privateKey.export({ type: 'pkcs8', format: 'der' })) },
} });
assert.ok(org.status < 300, `organization: ${org.status} ${JSON.stringify(org.json)}`);
const orgId = org.json.id || org.json.Id;
const cols = await call('GET', `/api/organizations/${orgId}/collections`, { token: owner.token });
const collectionId = (cols.json.data || cols.json.Data)[0].id;
const shared = await call('POST', '/api/ciphers/create', { token: owner.token, body: { cipher: { type: 1, organizationId: orgId, name: seal(orgKey, 'Shop'), notes: null, favorite: false, login: { username: seal(orgKey, 'sam'), password: seal(orgKey, 'shared-pw-1'), uris: [{ uri: seal(orgKey, 'https://shop.example/login'), match: null }] } }, collectionIds: [collectionId] } });
assert.ok(shared.status < 300, `shared login: ${shared.status} ${JSON.stringify(shared.json)}`);

// The seat: invited, accepted (without mail, the server accepts for it), and confirmed with the
// organization's key sent to its RSA key.
const inv = await call('POST', `/api/organizations/${orgId}/users/invite`, { token: owner.token, body: { emails: [seat.email], type: 2, collections: [{ id: collectionId, readOnly: false, hidePasswords: false, manage: false }], accessAll: false, groups: [], permissions: {} } });
assert.ok(inv.status < 300, `invite: ${inv.status} ${JSON.stringify(inv.json)}`);
const members = await call('GET', `/api/organizations/${orgId}/users`, { token: owner.token });
const member = (members.json.data || members.json.Data).find((u) => (u.email || u.Email) === seat.email);
if ((member.status ?? member.Status) === 0) {
  const accept = await call('POST', `/api/organizations/${orgId}/users/${member.id}/accept`, { token: seat.token, body: { token: '' } });
  assert.ok(accept.status < 300, `accept: ${accept.status} ${JSON.stringify(accept.json)}`);
}
const sealedOrg = `4.${b64(crypto.publicEncrypt({ key: seat.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, orgKey))}`;
const confirm = await call('POST', `/api/organizations/${orgId}/users/${member.id}/confirm`, { token: owner.token, body: { key: sealedOrg } });
assert.ok(confirm.status < 300, `confirm: ${confirm.status} ${JSON.stringify(confirm.json)}`);

// cobrowser signs in as the seat.
const bw = new BitwardenSource({ wasm, fetch, random: (n) => crypto.randomBytes(n), deviceId: crypto.randomUUID(), log: (m) => console.log(m) });
assert.deepEqual(await bw.signIn({ server: BASE, email: seat.email, password: PASSWORD }), { ok: true });
const summary = await bw.sync();
assert.equal(summary.organizations.length, 1, 'the organization, its key opened with the seat\'s RSA key');
let v = bw.vault({ scopes: {} });
const shop = v.entries.find((e) => e.username === 'sam');
assert.ok(shop, 'the shared login opens');
assert.equal(shop.password, 'shared-pw-1');
assert.ok(shop.fillsOn('https://shop.example/signin') && !shop.fillsOn('https://evil.example/'));
const places = bw.places();
assert.ok(places.some((p) => p.id === collectionId && p.writable), JSON.stringify(places));

// A new login into the collection, and one of the seat's own.
const madeId = await bw.createLogin({ name: 'news.example', username: 'reader', password: 'new-pw-2', uris: ['https://news.example'], notes: '', organizationId: orgId, collectionId });
const ownId = await bw.createLogin({ name: 'mine.example', username: 'me', password: 'own-pw-3', uris: ['https://mine.example'], notes: 'for agents', fields: [{ name: 'Share notes with agents', value: 'true', type: 2 }] });
v = bw.vault({ scopes: {} });
assert.ok(v.entries.some((e) => e.id === madeId && e.password === 'new-pw-2'));
const own = v.entries.find((e) => e.id === ownId);
assert.equal(own.password, 'own-pw-3');
assert.equal(own.notes, 'for agents', 'notes marked to share reach agents');

// The owner reads the seat's new login with the organization's own key: it was sealed right.
const ownerSync = await call('GET', '/api/sync', { token: owner.token });
const madeThere = (ownerSync.json.ciphers || ownerSync.json.Ciphers).find((c) => (c.id || c.Id) === madeId);
assert.equal(unseal(orgKey, madeThere.login.password), 'new-pw-2');

// The kept sign-in opens the account again, and a refresh token keeps it syncing.
const kept = bw.keep();
bw.lock();
const again = new BitwardenSource({ wasm, fetch, random: (n) => crypto.randomBytes(n), deviceId: crypto.randomUUID() });
again.restore(kept);
again.access = null;
await again.sync();
assert.equal(again.vault().entries.length, 3);
console.log(`Vaultwarden: signed in as a seat, ${summary.logins} shared login read, 2 made and read back, synced again from the kept sign-in`);
