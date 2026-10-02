'use strict';
/**
 * The vault's logins, as data: adding, editing, scoping, removing, importing and exporting.
 * Pure functions over the decrypted vault object ({ entries: [...] }); the app does the
 * unlocking, the asking and the saving around them.
 *
 * A login: { id, host, port, username, password, scope, also, updatedAt }, where scope is 'all'
 * or a list of workspace paths (a workspace can only list and fill logins in its scope), and
 * `also` lists other websites the same account signs in on ({ host, port }), such as a
 * Microsoft account's password page on live.com for a login saved from microsoftonline.com.
 */
const crypto = require('node:crypto');
const { parseSite, siteLabel, siteMatches, isIp } = require('./site.js');

/** Typed websites ("live.com, login.live.com") as { host, port }, deduplicated, without the
 *  login's own site. Each is matched by the same rule as the login's own site. */
function normalizeSites(list, own) {
  const items = (Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)).map((s) => (typeof s === 'string' ? parseSite(s) : { host: String(s?.host || '').toLowerCase(), port: String(s?.port || '') }));
  const seen = new Set(own ? [siteLabel(own)] : []);
  const out = [];
  for (const s of items) {
    if (!s.host) continue;
    const label = siteLabel(s);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ host: s.host, port: s.port || '' });
  }
  return out;
}

/** Every website a login fills on: its own, then the others it was given. */
function sitesOf(e) {
  return [{ host: e.host, port: e.port || '' }, ...(Array.isArray(e.also) ? e.also : [])];
}

/** Does a login belong on this page? On any of its websites, each matched the usual way. */
function loginMatches(e, page) {
  return sitesOf(e).some((s) => siteMatches(s, page));
}

function normalizeScope(scope) {
  if (scope === 'all') return 'all';
  if (Array.isArray(scope)) return [...new Set(scope.filter((w) => typeof w === 'string' && w))];
  return [];
}

function allowed(entry, workspaceId) {
  return entry.scope === 'all' || (Array.isArray(entry.scope) && entry.scope.includes(workspaceId));
}

/** The union of two scopes: adding a login again never takes it away from anyone. */
function mergeScope(a, b) {
  if (a === 'all' || b === 'all') return 'all';
  return normalizeScope([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]);
}

function publicEntry(e) {
  return { host: siteLabel(e), also: (e.also || []).map(siteLabel), username: e.username, scope: e.scope };
}

function findEntry(vault, label, username) {
  const { host, port } = parseSite(label);
  return vault.entries.find((x) => x.host === host && (x.port || '') === port && x.username === username);
}

/**
 * Add a login, or replace the password of the one with the same site and username. What
 * happened is reported (replaced), never silent. The scope of an existing login is replaced
 * only when the caller chose it for this login (the Logins window's form); otherwise
 * (a command, an import) it is widened to include the new scope, never narrowed.
 */
function upsertLogin(vault, site, username, password, scope, { mergeScope: merge = true, also } = {}) {
  const { host, port } = parseSite(site);
  if (!host) throw new Error('site is required');
  const existing = vault.entries.find((e) => e.host === host && (e.port || '') === port && e.username === username);
  if (existing) {
    existing.password = password;
    existing.updatedAt = Date.now();
    if (scope !== undefined) existing.scope = merge ? mergeScope(existing.scope, normalizeScope(scope)) : normalizeScope(scope);
    // Other websites are only ever added here, like workspaces from a command or an import.
    if (also !== undefined) existing.also = normalizeSites([...(existing.also || []), ...normalizeSites(also)], existing);
    return { entry: existing, replaced: true };
  }
  const entry = { id: crypto.randomBytes(6).toString('hex'), host, port, username, password, scope: normalizeScope(scope), updatedAt: Date.now() };
  const others = normalizeSites(also, entry);
  if (others.length) entry.also = others;
  vault.entries.push(entry);
  return { entry, replaced: false };
}

/**
 * Edit a login in place: its site, username, password (kept when not given) and scope (kept
 * when not given). Refuses to become a duplicate of another login.
 */
function updateLogin(vault, from, fields) {
  const entry = findEntry(vault, from.host, from.username);
  if (!entry) throw new Error('that login is no longer in the vault');
  const site = fields.site !== undefined ? parseSite(fields.site) : { host: entry.host, port: entry.port || '' };
  if (!site.host) throw new Error('site is required');
  const username = fields.username !== undefined ? String(fields.username) : entry.username;
  const clash = vault.entries.find((e) => e !== entry && e.host === site.host && (e.port || '') === site.port && e.username === username);
  if (clash) throw new Error(`there is already a login for ${username || '(no username)'} on ${siteLabel(clash)}`);
  entry.host = site.host;
  entry.port = site.port;
  entry.username = username;
  if (fields.password) entry.password = fields.password;
  if (fields.scope !== undefined) entry.scope = normalizeScope(fields.scope);
  if (fields.also !== undefined) entry.also = normalizeSites(fields.also, entry);
  if (entry.also && !entry.also.length) delete entry.also;
  entry.updatedAt = Date.now();
  return entry;
}

function setScope(vault, host, username, scope) {
  const e = findEntry(vault, host, username);
  if (e) e.scope = normalizeScope(scope);
  return !!e;
}

function removeLogin(vault, host, username) {
  const before = vault.entries.length;
  const target = findEntry(vault, host, username);
  vault.entries = vault.entries.filter((e) => e !== target);
  return before - vault.entries.length;
}

/** Minimal RFC 4180 CSV → rows of strings. Apple Passwords, Bitwarden and Chrome exports
 *  all carry url/username/password columns under slightly different headers. */
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Which workspaces a login may be used in, carried in the CSV's note column so an export
 *  imported back into cobrowser restores them. Other managers keep it as the login's note. */
const WORKSPACES_NOTE = 'cobrowser-workspaces:';
function workspacesNote(scope) {
  return `${WORKSPACES_NOTE} ${JSON.stringify(scope === 'all' ? 'all' : normalizeScope(scope))}`;
}
const SITES_NOTE = 'cobrowser-sites:';
function sitesFromNote(note) {
  const text = String(note || '');
  const at = text.indexOf(SITES_NOTE);
  if (at < 0) return undefined;
  try {
    const v = JSON.parse(text.slice(at + SITES_NOTE.length).trim().split('\n')[0]);
    return Array.isArray(v) ? v.map(String) : undefined;
  } catch {
    return undefined;
  }
}
function workspacesFromNote(note) {
  const at = String(note || '').indexOf(WORKSPACES_NOTE);
  if (at < 0) return undefined;
  try {
    const v = JSON.parse(String(note).slice(at + WORKSPACES_NOTE.length).trim().split('\n')[0]);
    return v === 'all' ? 'all' : Array.isArray(v) ? normalizeScope(v) : undefined;
  } catch {
    return undefined;
  }
}

/** Import a CSV export. A row from a cobrowser export carries its workspaces (the note), and a
 *  new login gets exactly those, so exporting and importing back restores the vault; a row
 *  without one gets `scope`. A login already in the vault gets the password from the file and
 *  keeps its workspaces, widened by the row's, never narrowed. */
function importCsv(vault, text, scope) {
  const rows = parseCsv(text);
  const result = { count: 0, added: 0, replaced: 0 };
  if (rows.length < 2) return result;
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => header.findIndex((h) => names.includes(h));
  const iu = col('url', 'login_uri', 'website'), in_ = col('username', 'login_username', 'user'), ip = col('password', 'login_password'), inote = col('note', 'notes');
  if (iu < 0 || in_ < 0 || ip < 0) throw new Error(`CSV needs url/username/password columns; found: ${header.join(', ')}`);
  for (const r of rows.slice(1)) {
    const url = r[iu], user = r[in_], pass = r[ip];
    if (!url || !pass) continue;
    const noted = inote >= 0 ? workspacesFromNote(r[inote]) : undefined;
    const also = inote >= 0 ? sitesFromNote(r[inote]) : undefined;
    const { replaced } = upsertLogin(vault, url, user || '', pass, noted === undefined ? scope : noted, { mergeScope: true, also });
    result.count++;
    if (replaced) result.replaced++; else result.added++;
  }
  return result;
}

/** Every login as a CSV in Chrome's export format (name,url,username,password,note), which
 *  Apple Passwords, Bitwarden, 1Password, Chrome and this vault's own import all read. The
 *  note says which workspaces may use the login (see workspacesNote). */
function exportCsv(vault) {
  const q = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = [['name', 'url', 'username', 'password', 'note']];
  for (const e of vault.entries) {
    const label = siteLabel(e);
    // The vault keeps host and port, not the scheme, and other managers match on it: a device
    // on the network (an IP address, or a one-word host like a router's) is usually plain
    // http, anything with a domain https.
    const local = isIp(e.host) || !String(e.host).includes('.');
    const url = /^https?:\/\//.test(label) ? label : `${local ? 'http' : 'https'}://${label}`;
    const note = workspacesNote(e.scope) + (e.also && e.also.length ? `\n${SITES_NOTE} ${JSON.stringify(e.also.map(siteLabel))}` : '');
    rows.push([label, url, e.username || '', e.password || '', note]);
  }
  return rows.map((r) => r.map((c) => q(String(c))).join(',')).join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------
// Payment cards: { id, label, name, number, expMonth, expYear, cvc, updatedAt }. The number
// and the code never leave the app: lists see publicCard, and filling types them into the
// page directly. Every fill asks the person first (main.js), so cards have no workspace scope.

function cardBrand(number) {
  const n = String(number);
  if (/^4/.test(n)) return 'Visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(n)) return 'Mastercard';
  if (/^3[47]/.test(n)) return 'American Express';
  if (/^(6011|65|64[4-9])/.test(n)) return 'Discover';
  if (/^35(2[89]|[3-8])/.test(n)) return 'JCB';
  if (/^3(0[0-5]|[68])/.test(n)) return 'Diners Club';
  return 'Card';
}

/** The checksum every card number carries (Luhn), so a mistyped number is caught on save. */
function luhnOk(n) {
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Checked and tidied card fields. `existing` keeps the number and code when not given again. */
function cardFields(fields, existing) {
  const number = fields.number ? String(fields.number).replace(/[\s-]/g, '') : existing?.number;
  if (!number || !/^\d{12,19}$/.test(number) || !luhnOk(number)) throw new Error('that is not a valid card number');
  let expMonth = fields.expMonth ?? existing?.expMonth, expYear = fields.expYear ?? existing?.expYear;
  if (fields.exp) {
    const m = /^\s*(\d{1,2})\s*\/\s*(\d{2}|\d{4})\s*$/.exec(String(fields.exp));
    if (!m) throw new Error('expiry should look like MM/YY');
    expMonth = m[1]; expYear = m[2];
  }
  expMonth = Number(expMonth); expYear = Number(expYear);
  if (!(expMonth >= 1 && expMonth <= 12)) throw new Error('the expiry month should be 1 to 12');
  if (expYear < 100) expYear += 2000;
  if (!(expYear >= 2000 && expYear <= 2100)) throw new Error('the expiry year is not valid');
  const cvc = fields.cvc !== undefined && fields.cvc !== '' ? String(fields.cvc).trim() : existing?.cvc || '';
  if (cvc && !/^\d{3,4}$/.test(cvc)) throw new Error('the security code should be 3 or 4 digits');
  const name = fields.name !== undefined ? String(fields.name).trim() : existing?.name || '';
  const label = (fields.label !== undefined ? String(fields.label).trim() : existing?.label) || `${cardBrand(number)} ${number.slice(-4)}`;
  return { label, name, number, expMonth, expYear, cvc };
}

function publicCard(c) {
  return { id: c.id, label: c.label, brand: cardBrand(c.number), last4: c.number.slice(-4), exp: `${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}`, name: c.name, hasCode: !!c.cvc };
}

function addCard(vault, fields) {
  const card = { id: crypto.randomBytes(6).toString('hex'), ...cardFields(fields), updatedAt: Date.now() };
  (vault.cards ||= []).push(card);
  return card;
}

function findCard(vault, which) {
  const cards = vault.cards || [];
  if (!which) return cards.length === 1 ? cards[0] : undefined;
  const w = String(which).toLowerCase();
  return cards.find((c) => c.id === which) || cards.find((c) => c.label.toLowerCase() === w) || cards.find((c) => c.number.endsWith(String(which)));
}

function updateCard(vault, id, fields) {
  const card = (vault.cards || []).find((c) => c.id === id);
  if (!card) throw new Error('that card is no longer in the vault');
  Object.assign(card, cardFields(fields, card), { updatedAt: Date.now() });
  return card;
}

function removeCard(vault, id) {
  const before = (vault.cards || []).length;
  vault.cards = (vault.cards || []).filter((c) => c.id !== id);
  return before - vault.cards.length;
}

module.exports = {
  cardBrand, publicCard, addCard, findCard, updateCard, removeCard,
  normalizeScope, allowed, mergeScope, publicEntry, findEntry, upsertLogin, updateLogin, setScope, removeLogin,
  normalizeSites, sitesOf, loginMatches,
  parseCsv, importCsv, exportCsv,
};
