'use strict';
/**
 * The vault on a Bitwarden-compatible server (Bitwarden, or a self-hosted Vaultwarden): signing
 * in, syncing, and saving new logins, over the server's own API. Everything that touches a key
 * is in the WebAssembly core (app/bitwarden/, built from bitwarden/); this is the network and
 * the shape the app's vault takes.
 *
 * Signing in takes the master password once, or a personal API key (client id and secret) and
 * the master password, plus a two-step code when the account asks for one. After that the app
 * keeps the user key and the refresh token in the keychain (Electron's safeStorage, saved by
 * main.js), and unlocking is Touch ID, as for the built-in vault. A copy of the last sync is kept
 * with them, so the vault opens, and fills, without the server: its values stay encrypted with
 * the account's keys until it is unlocked.
 *
 * No network or Electron here: main.js passes fetch and randomness in, so the tests run it
 * against a fake server.
 */
const { parseSite } = require('./site.js');

/** The two halves of a server, from the address a person types: Bitwarden's own cloud (US or
 *  EU) has them on separate hosts; a self-hosted server has them under its address. */
function endpoints(server) {
  let raw = String(server || '').trim();
  if (!raw) throw new Error('give the server\'s address, such as https://vault.example.com');
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let u;
  try { u = new URL(raw); } catch { throw new Error(`"${server}" is not an address`); }
  const host = u.hostname.toLowerCase();
  const cloud = /(^|\.)bitwarden\.(com|eu)$/.exec(host);
  if (cloud) {
    const tld = cloud[2];
    return { server: `https://vault.bitwarden.${tld}`, api: `https://api.bitwarden.${tld}`, identity: `https://identity.bitwarden.${tld}` };
  }
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(host)) throw new Error('the server must be reached over https (http only on this Mac itself)');
  const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  return { server: base, api: `${base}/api`, identity: `${base}/identity` };
}

/** How cobrowser introduces itself to the server: as Bitwarden's desktop app on macOS, the
 *  client the server knows; the device is this Mac's cobrowser, named so the person
 *  recognizes it in their account's list of devices. */
const CLIENT = { id: 'desktop', name: 'cobrowser', type: '7', version: '2025.10.0' };

/** An error from the server, as a sentence: Bitwarden puts it in a few places. */
function serverMessage(body, status) {
  if (body && typeof body === 'object') {
    const m = body.ErrorModel?.Message || body.errorModel?.message || body.error_description || body.message || body.Message;
    if (m) return String(m);
  }
  return `the server answered ${status}`;
}

class BitwardenSource {
  /**
   * @param {object} o
   * @param {object} o.wasm      the WebAssembly core (require('./bitwarden/bitwarden.js'))
   * @param {Function} o.fetch   fetch(url, init) → Response
   * @param {Function} o.random  random(n) → Uint8Array of n random bytes
   * @param {string} o.deviceId  this Mac's device identifier for the server, kept between runs
   * @param {Function} [o.log]
   */
  constructor({ wasm, fetch, random, deviceId, log }) {
    this.wasm = wasm;
    this.fetch = fetch;
    this.random = random;
    this.deviceId = deviceId;
    this.log = log || (() => {});
    this.account = null; // the open account (WebAssembly), or null while locked
    this.state = null; // { server, email, userKey, refreshToken, sync, syncedAt }
    this.access = null; // { token, until }
  }

  get open() { return !!this.account; }

  async request(url, init = {}) {
    let res;
    try {
      res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      const err = new Error(`the server could not be reached (${e.cause?.code || e.name || e.message})`);
      err.offline = true;
      throw err;
    }
    const text = await res.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, body };
  }

  headers(extra = {}) {
    return { Accept: 'application/json', 'Bitwarden-Client-Name': CLIENT.id, 'Bitwarden-Client-Version': CLIENT.version, 'Device-Type': CLIENT.type, ...extra };
  }

  /** How the account makes its key (PBKDF2 or Argon2id, and its settings). */
  async prelogin(ends, email) {
    for (const url of [`${ends.identity}/accounts/prelogin`, `${ends.api}/accounts/prelogin`]) {
      const r = await this.request(url, { method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ email }) });
      if (r.ok && r.body && typeof r.body === 'object') return r.body;
      if (r.status !== 404) throw new Error(serverMessage(r.body, r.status));
    }
    throw new Error('this server does not answer as a Bitwarden server does: check its address');
  }

  /**
   * Sign in, and open the account. Answers { ok: true } when open, or what the server still
   * needs: { needs: 'twoFactor', providers: [{ id, name }] } (call again with twoFactor:
   * { provider, code }), or { needs: 'newDevice' } (Bitwarden emailed a code for this new
   * device: call again with newDeviceOtp). The master password is used here and forgotten.
   */
  async signIn({ server, email, password, apiKey, twoFactor, newDeviceOtp }) {
    const ends = endpoints(server);
    email = String(email || '').trim().toLowerCase();
    if (!email) throw new Error('give the account\'s email');
    if (!password) throw new Error('give the master password');
    const pre = await this.prelogin(ends, email);
    const sign = new this.wasm.SignIn(email, password, pre);
    try {
      const form = {
        scope: 'api offline_access',
        client_id: CLIENT.id,
        deviceType: CLIENT.type,
        deviceIdentifier: this.deviceId,
        deviceName: CLIENT.name,
      };
      if (apiKey?.clientId) Object.assign(form, { grant_type: 'client_credentials', scope: 'api', client_id: apiKey.clientId, client_secret: apiKey.clientSecret });
      else Object.assign(form, { grant_type: 'password', username: email, password: sign.hash });
      if (twoFactor?.code) Object.assign(form, { twoFactorProvider: String(twoFactor.provider), twoFactorToken: String(twoFactor.code).replace(/\s/g, ''), twoFactorRemember: '0' });
      if (newDeviceOtp) form.newDeviceOtp = String(newDeviceOtp).replace(/\s/g, '');
      const r = await this.request(`${ends.identity}/connect/token`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/x-www-form-urlencoded', 'Auth-Email': Buffer.from(email).toString('base64url') }),
        body: new URLSearchParams(form).toString(),
      });
      if (!r.ok) {
        const providers = r.body?.TwoFactorProviders2 || r.body?.twoFactorProviders2;
        if (providers && typeof providers === 'object') {
          const names = { 0: 'authenticator app', 1: 'email', 2: 'Duo', 3: 'YubiKey', 6: 'organization Duo', 7: 'security key' };
          return { needs: 'twoFactor', providers: Object.keys(providers).map((id) => ({ id: Number(id), name: names[id] || `method ${id}`, usable: id === '0' || id === '1' })) };
        }
        const msg = serverMessage(r.body, r.status);
        if (/new device/i.test(msg) || r.body?.error === 'device_error') return { needs: 'newDevice', message: msg };
        throw new Error(/invalid_grant|username or password/i.test(msg) || r.body?.error === 'invalid_grant' ? 'the email or master password is not right' : msg);
      }
      const account = sign.open(r.body); // the master password wasn't the account's: throws
      this.account?.free();
      this.account = account;
      this.access = { token: r.body.access_token, until: Date.now() + (Number(r.body.expires_in) || 3600) * 1000 - 60000 };
      this.state = { server: ends.server, email, userKey: Buffer.from(account.exportKey()).toString('base64'), refreshToken: r.body.refresh_token || '', apiKey: apiKey?.clientId ? { clientId: apiKey.clientId, clientSecret: apiKey.clientSecret } : undefined, sync: null, syncedAt: 0 };
      this.log(`bitwarden: signed in as ${email} on ${ends.server}`);
      return { ok: true };
    } finally {
      try { sign.free(); } catch { /* used up by open */ }
    }
  }

  /** Ask the server to email a two-step code (the email method). */
  async sendEmailCode({ server, email, password }) {
    const ends = endpoints(server);
    email = String(email || '').trim().toLowerCase();
    const pre = await this.prelogin(ends, email);
    const sign = new this.wasm.SignIn(email, password, pre);
    try {
      const r = await this.request(`${ends.api}/two-factor/send-email-login`, { method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ email, masterPasswordHash: sign.hash, deviceIdentifier: this.deviceId }) });
      if (!r.ok) throw new Error(serverMessage(r.body, r.status));
    } finally {
      sign.free();
    }
  }

  /** Open the account from what the keychain kept, without the server: its last sync. */
  restore(state) {
    if (!state?.userKey || !state?.server) throw new Error('nothing kept to open the Bitwarden vault with: sign in again');
    this.account?.free();
    this.account = this.wasm.Account.fromKey(Buffer.from(state.userKey, 'base64'));
    this.state = { ...state };
    this.access = null;
    if (state.sync) this.account.load(state.sync);
  }

  /** A token for the API, refreshed when it has lapsed. */
  async token() {
    if (this.access && this.access.until > Date.now()) return this.access.token;
    const ends = endpoints(this.state.server);
    const form = this.state.apiKey && !this.state.refreshToken
      ? { grant_type: 'client_credentials', scope: 'api', client_id: this.state.apiKey.clientId, client_secret: this.state.apiKey.clientSecret, deviceType: CLIENT.type, deviceIdentifier: this.deviceId, deviceName: CLIENT.name }
      : { grant_type: 'refresh_token', client_id: CLIENT.id, refresh_token: this.state.refreshToken };
    const r = await this.request(`${ends.identity}/connect/token`, { method: 'POST', headers: this.headers({ 'Content-Type': 'application/x-www-form-urlencoded' }), body: new URLSearchParams(form).toString() });
    if (!r.ok) {
      const err = new Error(r.status === 400 || r.status === 401 ? 'the server no longer accepts this Mac\'s sign-in: sign in to Bitwarden again in the vault window' : serverMessage(r.body, r.status));
      err.signedOut = r.status === 400 || r.status === 401;
      throw err;
    }
    if (r.body.refresh_token) this.state.refreshToken = r.body.refresh_token;
    this.access = { token: r.body.access_token, until: Date.now() + (Number(r.body.expires_in) || 3600) * 1000 - 60000 };
    return this.access.token;
  }

  async api(method, path, body) {
    const ends = endpoints(this.state.server);
    const go = async () => this.request(`${ends.api}${path}`, { method, headers: this.headers({ Authorization: `Bearer ${await this.token()}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }), body: body !== undefined ? JSON.stringify(body) : undefined });
    let r = await go();
    if (r.status === 401) { this.access = null; r = await go(); }
    if (!r.ok) throw new Error(serverMessage(r.body, r.status));
    return r.body;
  }

  /** Fetch the vault from the server and open it in place of the last sync. */
  async sync() {
    if (!this.account) throw new Error('the Bitwarden vault is locked');
    const sync = await this.api('GET', '/sync?excludeDomains=true');
    const summary = this.account.load(sync);
    this.state.sync = sync;
    this.state.syncedAt = Date.now();
    return summary;
  }

  /** Save a new login on the server ({ name, username, password, uris, notes } and where:
   *  { folderId } or { organizationId, collectionId }), then sync so it is in the vault. Returns
   *  its id. */
  async createLogin(login) {
    const body = this.sealLogin(login);
    const made = login.organizationId ? await this.api('POST', '/ciphers/create', body) : await this.api('POST', '/ciphers', body);
    await this.sync();
    return made?.id || made?.Id;
  }

  /** Write a login over one already on the server (its id), all of it: only for one cobrowser
   *  made moments ago, which holds nothing but what it was made with (createLogin's password
   *  made up again, when the site refused the first). */
  async replaceLogin(id, login) {
    const body = this.sealLogin(login);
    await this.api('PUT', `/ciphers/${encodeURIComponent(id)}`, body.cipher || body);
    await this.sync();
  }

  sealLogin(login) {
    if (!this.account) throw new Error('the Bitwarden vault is locked');
    const uris = (login.uris || []).filter((u) => String(u || '').trim());
    const fields = login.fields || [];
    return this.account.newLogin({ ...login, uris, fields }, this.random(this.wasm.ivsNeeded(uris.length, fields.length)));
  }

  /** What to keep in the keychain: enough to unlock without the master password, and to fill
   *  without the server. */
  keep() { return this.state ? { ...this.state } : null; }

  lock() {
    try { this.account?.free(); } catch { /* already freed */ }
    this.account = null;
    this.access = null;
  }

  /** The vault as the app holds it, built from the open account: logins and cards in the
   *  built-in vault's shape, so every tool works on them as on its own. Each login keeps its
   *  Bitwarden addresses and fills by Bitwarden's matching (fillsOn). Which workspaces may use
   *  each item is cobrowser's own (scopes, by item id); notes reach agents only on items marked
   *  with the notes field (rules.notesField, a checkbox field). */
  vault({ scopes = {}, rules = {} } = {}) {
    if (!this.account) throw new Error('the Bitwarden vault is locked');
    const { logins, cards } = this.account.items();
    const notesField = String(rules.notesField || NOTES_FIELD).trim().toLowerCase();
    const marked = (item) => (item.fields || []).some((f) => f.boolean && f.name.trim().toLowerCase() === notesField && f.value === 'true');
    const account = this.account;
    const entries = [];
    let noSite = 0;
    for (const l of logins) {
      const sites = l.uris.map((u) => parseSite(u)).filter((s) => s.host);
      if (!sites.length) { noSite++; continue; }
      const [own, ...also] = sites;
      const e = {
        id: l.id,
        name: l.name,
        host: own.host,
        port: own.port || '',
        also: also.filter((s, i) => also.findIndex((x) => x.host === s.host && x.port === s.port) === i && !(s.host === own.host && s.port === own.port)),
        username: l.username,
        password: l.password,
        scope: scopes[l.id] ?? [],
        notes: marked(l) ? l.notes : '',
        hasTotp: l.hasTotp,
        updatedAt: Date.parse(l.revisionDate) || 0,
        source: 'bitwarden',
        place: l.organizationId ? { organizationId: l.organizationId, collectionIds: l.collectionIds } : { folderId: l.folderId },
      };
      // Bitwarden's matching, not the built-in vault's: the account's match settings hold.
      // Not enumerable, so it never travels with the entry.
      Object.defineProperty(e, 'fillsOn', { value: (url) => { try { return account.fillsOn(l.id, url); } catch { return false; } }, enumerable: false });
      Object.defineProperty(e, 'code', { value: () => account.code(l.id, Date.now()), enumerable: false });
      entries.push(e);
    }
    const out = { entries, noSite, source: 'bitwarden' };
    out.cards = cards.filter((c) => /^\d{12,19}$/.test(String(c.number).replace(/[\s-]/g, ''))).map((c) => {
      let expYear = Number(c.expYear) || 0;
      if (expYear && expYear < 100) expYear += 2000;
      return {
        id: c.id,
        label: c.name || `Card ${String(c.number).slice(-4)}`,
        name: c.cardholderName,
        number: String(c.number).replace(/[\s-]/g, ''),
        expMonth: Number(c.expMonth) || 0,
        expYear,
        cvc: c.code,
        notes: marked(c) ? c.notes : '',
        updatedAt: Date.parse(c.revisionDate) || 0,
        source: 'bitwarden',
      };
    });
    return out;
  }

  /** Folders and collections a new login can go to, and the account's organizations. */
  places() {
    if (!this.account) return [];
    return this.account.places();
  }
}

/** The checkbox field that lets agents read an item's notes, by default. A vault shared with
 *  other tools can use their name for it (the setting in the vault window). */
const NOTES_FIELD = 'Share notes with agents';

module.exports = { BitwardenSource, endpoints, NOTES_FIELD, CLIENT };
