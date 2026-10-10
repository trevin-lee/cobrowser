'use strict';
/**
 * The vault's logins, as data: adding, editing, scoping, removing, importing and exporting.
 * Pure functions over the decrypted vault object ({ entries: [...] }); the app does the
 * unlocking, the asking and the saving around them.
 *
 * A login: { id, host, port, username, password, scope, also, notes, updatedAt }, where password
 * is '' for an account that signs in with an emailed link or a one-time code, and scope is 'all'
 * or a list of workspace paths (a workspace can only list and fill logins in its scope), and
 * `also` lists other websites the same account signs in on ({ host, port }), such as a
 * Microsoft account's password page on live.com for a login saved from microsoftonline.com.
 * `notes` is the person's Markdown about the login, for them and for agents ("sign in with the
 * work account; 2FA goes to the human's phone"). Cards carry notes the same way.
 */

/** Notes as stored: text, trimmed, bounded (they are read on every list). */
function normalizeNotes(notes) {
  return String(notes ?? '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
}
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

/** How closely a login fits a page, by its closest site: 3 the page's own host, 2 a domain the
 *  page is under (facebook.com on www.facebook.com), 1 only the same site (a sibling, such as
 *  accountscenter.facebook.com on www.facebook.com), 0 none. */
function matchRank(e, page) {
  let best = 0;
  for (const s of sitesOf(e)) {
    if (!siteMatches(s, page)) continue;
    best = Math.max(best, s.host === page.host ? 3 : page.host.endsWith('.' + s.host) ? 2 : 1);
  }
  return best;
}

/**
 * The logins that fit a page, one per username. One account saved for several of a site's
 * hosts (facebook.com and accountscenter.facebook.com, the same username) is one choice, not
 * two: the login whose site fits the page closest, then the most recently saved. Only
 * different usernames are left for someone to choose between.
 */
function closestPerUsername(matches, page) {
  const best = new Map();
  for (const e of matches) {
    const cur = best.get(e.username);
    if (!cur || matchRank(e, page) > matchRank(cur, page) || (matchRank(e, page) === matchRank(cur, page) && (e.updatedAt || 0) > (cur.updatedAt || 0))) best.set(e.username, e);
  }
  return [...best.values()];
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
  return { host: siteLabel(e), also: (e.also || []).map(siteLabel), username: e.username, scope: e.scope, notes: e.notes || '', hasPassword: !!e.password };
}

function findEntry(vault, label, username) {
  const { host, port } = parseSite(label);
  return vault.entries.find((x) => x.host === host && (x.port || '') === port && x.username === username);
}

/**
 * Add a login, or replace the password of the one with the same site and username. What
 * happened is reported (replaced), never silent. The scope of an existing login is replaced
 * only when the caller chose it for this login (the vault window's form); otherwise
 * (a command, an import) it is widened to include the new scope, never narrowed.
 */
function upsertLogin(vault, site, username, password, scope, { mergeScope: merge = true, also, notes } = {}) {
  const { host, port } = parseSite(site);
  if (!host) throw new Error('site is required');
  const existing = vault.entries.find((e) => e.host === host && (e.port || '') === port && e.username === username);
  if (existing) {
    // An empty password is "none given", never "erase it": only an edit removes a saved one.
    if (password) existing.password = password;
    existing.updatedAt = Date.now();
    if (scope !== undefined) existing.scope = merge ? mergeScope(existing.scope, normalizeScope(scope)) : normalizeScope(scope);
    // Other websites are only ever added here, like workspaces from a command or an import.
    if (also !== undefined) existing.also = normalizeSites([...(existing.also || []), ...normalizeSites(also)], existing);
    // Notes are replaced only by new notes; adding again without any keeps the old ones.
    if (notes !== undefined && normalizeNotes(notes)) existing.notes = normalizeNotes(notes);
    return { entry: existing, replaced: true };
  }
  const entry = { id: crypto.randomBytes(6).toString('hex'), host, port, username, password: password || '', scope: normalizeScope(scope), updatedAt: Date.now() };
  if (normalizeNotes(notes)) entry.notes = normalizeNotes(notes);
  const others = normalizeSites(also, entry);
  if (others.length) entry.also = others;
  vault.entries.push(entry);
  return { entry, replaced: false };
}

/**
 * Edit a login in place: its site, username, password (kept when not given, removed when null)
 * and scope (kept when not given). Refuses to become a duplicate of another login.
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
  if (fields.password === null) entry.password = ''; // now signs in with a link or a code
  else if (fields.password) entry.password = fields.password;
  if (fields.scope !== undefined) entry.scope = normalizeScope(fields.scope);
  if (fields.also !== undefined) entry.also = normalizeSites(fields.also, entry);
  if (fields.notes !== undefined) { const n = normalizeNotes(fields.notes); if (n) entry.notes = n; else delete entry.notes; }
  if (entry.also && !entry.also.length) delete entry.also;
  entry.updatedAt = Date.now();
  return entry;
}

function setScope(vault, host, username, scope) {
  const e = findEntry(vault, host, username);
  if (e) e.scope = normalizeScope(scope);
  return !!e;
}

/**
 * A change someone made to a scope they were looking at (`before` → `after`), applied to the
 * scope as it is now. Another grant may have landed since they looked (an agent's request was
 * allowed, another window saved): a change to the workspaces they touched never undoes one they
 * did not. Turning Everywhere on or off is a choice of the whole scope, and wins as made.
 */
function applyScopeChange(current, before, after) {
  before = normalizeScope(before); after = normalizeScope(after); current = normalizeScope(current);
  if (after === 'all' || before === 'all' || current === 'all') return after;
  const added = after.filter((w) => !before.includes(w));
  const removed = new Set(before.filter((w) => !after.includes(w)));
  return normalizeScope([...current, ...added].filter((w) => !removed.has(w)));
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

/** Which workspaces a login may be used in, and its other websites, carried in the CSV's note
 *  column as cobrowser's own lines at its end, so an export imported back into cobrowser
 *  restores them. Other managers keep them as part of the login's note. */
const WORKSPACES_NOTE = 'cobrowser-workspaces:';
const SITES_NOTE = 'cobrowser-sites:';
function workspacesNote(scope) {
  return `${WORKSPACES_NOTE} ${JSON.stringify(scope === 'all' ? 'all' : normalizeScope(scope))}`;
}

/**
 * A CSV note split into what the person wrote and cobrowser's lines. Only the note's last lines
 * count as cobrowser's, each starting with its marker and holding JSON, which is where an export
 * puts them: the same words anywhere else in a note are the person's text and stay theirs.
 */
function splitNote(note) {
  const lines = String(note || '').replace(/\r\n/g, '\n').split('\n');
  let workspaces, sites;
  while (lines.length) {
    const line = lines[lines.length - 1].trim();
    const marker = [WORKSPACES_NOTE, SITES_NOTE].find((m) => line.startsWith(m));
    if (!marker) break;
    let v;
    try { v = JSON.parse(line.slice(marker.length).trim()); } catch { break; }
    if (marker === WORKSPACES_NOTE) {
      if (workspaces !== undefined || !(v === 'all' || Array.isArray(v))) break;
      workspaces = v === 'all' ? 'all' : normalizeScope(v);
    } else {
      if (sites !== undefined || !Array.isArray(v)) break;
      sites = v.map(String);
    }
    lines.pop();
  }
  return { notes: normalizeNotes(lines.join('\n')), workspaces, sites };
}

/** Import a CSV export. A row from a cobrowser export carries its workspaces (the note), and a
 *  new login gets exactly those, so exporting and importing back restores the vault; a row
 *  without one gets `scope`. A login already in the vault gets the password (and the notes, when
 *  the row has some) from the file and keeps its workspaces, widened by the row's, never narrowed. */
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
    // A row without a password is an account that signs in with a link or a code; a row with
    // neither a username nor a password says nothing to keep.
    if (!url || (!pass && !user)) continue;
    const { workspaces, sites, notes } = inote >= 0 ? splitNote(r[inote]) : {};
    const { replaced } = upsertLogin(vault, url, user || '', pass, workspaces === undefined ? scope : workspaces, { mergeScope: true, also: sites, notes });
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
    // The person's notes first (other managers show the note as is), then cobrowser's lines.
    const note = (e.notes ? e.notes + '\n\n' : '') + workspacesNote(e.scope) + (e.also && e.also.length ? `\n${SITES_NOTE} ${JSON.stringify(e.also.map(siteLabel))}` : '');
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
  // A blank code keeps the saved one; null removes it (typed at checkout from then on).
  const cvc = fields.cvc === null ? '' : fields.cvc !== undefined && fields.cvc !== '' ? String(fields.cvc).trim() : existing?.cvc || '';
  if (cvc && !/^\d{3,4}$/.test(cvc)) throw new Error('the security code should be 3 or 4 digits');
  const name = fields.name !== undefined ? String(fields.name).trim() : existing?.name || '';
  const label = (fields.label !== undefined ? String(fields.label).trim() : existing?.label) || `${cardBrand(number)} ${number.slice(-4)}`;
  const notes = fields.notes !== undefined ? normalizeNotes(fields.notes) : existing?.notes || '';
  return { label, name, number, expMonth, expYear, cvc, notes };
}

function publicCard(c) {
  return { id: c.id, label: c.label, brand: cardBrand(c.number), last4: c.number.slice(-4), exp: `${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}`, name: c.name, hasCode: !!c.cvc, notes: c.notes || '' };
}

/** Refuses a second copy of a card already saved: the vault holds each number once. */
function addCard(vault, fields) {
  const card = { id: crypto.randomBytes(6).toString('hex'), ...cardFields(fields), updatedAt: Date.now() };
  const same = (vault.cards || []).find((c) => c.number === card.number);
  if (same) throw new Error(`that card is already saved, as ${same.label}: edit it there`);
  (vault.cards ||= []).push(card);
  return card;
}

/** A card by id, label, or its last four digits (all four, and only when one card ends so). */
function findCard(vault, which) {
  const cards = vault.cards || [];
  if (!which) return cards.length === 1 ? cards[0] : undefined;
  const w = String(which).trim().toLowerCase();
  const byId = cards.find((c) => c.id === which) || cards.find((c) => c.label.toLowerCase() === w);
  if (byId) return byId;
  const digits = w.replace(/\D/g, '');
  if (digits.length !== 4) return undefined;
  const ending = cards.filter((c) => c.number.endsWith(digits));
  return ending.length === 1 ? ending[0] : undefined;
}

function updateCard(vault, id, fields) {
  const card = (vault.cards || []).find((c) => c.id === id);
  if (!card) throw new Error('that card is no longer in the vault');
  const next = cardFields(fields, card);
  const same = vault.cards.find((c) => c !== card && c.number === next.number);
  if (same) throw new Error(`that card is already saved, as ${same.label}`);
  Object.assign(card, next, { updatedAt: Date.now() });
  return card;
}

function removeCard(vault, id) {
  const before = (vault.cards || []).length;
  vault.cards = (vault.cards || []).filter((c) => c.id !== id);
  return before - vault.cards.length;
}

const CARD_COLUMNS = ['label', 'name', 'number', 'expiry', 'code', 'notes'];
const csvLine = (r) => r.map((c) => { const v = String(c ?? ''); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(',');

/** Every card as a CSV (label,name,number,expiry,code,notes): the vault's own backup of its
 *  cards, which no password manager's login format has room for. */
function exportCards(vault) {
  const rows = [CARD_COLUMNS];
  for (const c of vault.cards || []) rows.push([c.label, c.name, c.number, `${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}`, c.cvc || '', c.notes || '']);
  return rows.map(csvLine).join('\n') + '\n';
}

/** Import cards from a CSV: cobrowser's own export, or any with a card number and an expiry
 *  column under a common name. A card already saved (the same number) takes the file's details,
 *  keeping its code and notes when the file has none. Rows that are not valid cards are skipped
 *  and counted. */
function importCards(vault, text) {
  const rows = parseCsv(text);
  const result = { count: 0, added: 0, replaced: 0, skipped: 0 };
  if (rows.length < 2) return result;
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s_-]+/g, ' '));
  const col = (...names) => header.findIndex((h) => names.includes(h));
  const inum = col('number', 'card number', 'cardnumber'), iexp = col('expiry', 'exp', 'expiration', 'expiration date', 'expires');
  const imon = col('exp month', 'expiry month', 'expiration month'), iyear = col('exp year', 'expiry year', 'expiration year');
  const ilabel = col('label', 'title'), iname = col('name', 'name on card', 'cardholder', 'cardholder name', 'card holder');
  const icode = col('code', 'cvc', 'cvv', 'security code'), inotes = col('notes', 'note');
  if (inum < 0 || (iexp < 0 && (imon < 0 || iyear < 0))) throw new Error(`CSV needs card number and expiry columns; found: ${rows[0].join(', ')}`);
  const at = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : undefined);
  for (const r of rows.slice(1)) {
    const fields = { number: at(r, inum), name: at(r, iname), label: at(r, ilabel) || undefined };
    if (iexp >= 0) fields.exp = at(r, iexp); else { fields.expMonth = at(r, imon); fields.expYear = at(r, iyear); }
    const code = at(r, icode), notes = at(r, inotes);
    if (code) fields.cvc = code;
    if (notes) fields.notes = notes;
    try {
      const number = String(fields.number || '').replace(/[\s-]/g, '');
      const existing = (vault.cards || []).find((c) => c.number === number);
      if (existing) { updateCard(vault, existing.id, fields); result.replaced++; } else { addCard(vault, fields); result.added++; }
      result.count++;
    } catch {
      result.skipped++;
    }
  }
  return result;
}

module.exports = {
  cardBrand, publicCard, addCard, findCard, updateCard, removeCard, exportCards, importCards,
  normalizeScope, allowed, mergeScope, applyScopeChange, publicEntry, findEntry, upsertLogin, updateLogin, setScope, removeLogin,
  normalizeSites, sitesOf, loginMatches, matchRank, closestPerUsername,
  parseCsv, importCsv, exportCsv, splitNote,
};
