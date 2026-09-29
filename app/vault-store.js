'use strict';
/**
 * The vault's logins, as data: adding, editing, scoping, removing, importing and exporting.
 * Pure functions over the decrypted vault object ({ entries: [...] }); the app does the
 * unlocking, the asking and the saving around them.
 *
 * A login: { id, host, port, username, password, scope, updatedAt }, where scope is 'all' or
 * a list of workspace paths. A workspace can only list and fill logins in its scope.
 */
const crypto = require('node:crypto');
const { parseSite, siteLabel, isIp } = require('./site.js');

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
  return { host: siteLabel(e), username: e.username, scope: e.scope };
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
function upsertLogin(vault, site, username, password, scope, { mergeScope: merge = true } = {}) {
  const { host, port } = parseSite(site);
  if (!host) throw new Error('site is required');
  const existing = vault.entries.find((e) => e.host === host && (e.port || '') === port && e.username === username);
  if (existing) {
    existing.password = password;
    existing.updatedAt = Date.now();
    if (scope !== undefined) existing.scope = merge ? mergeScope(existing.scope, normalizeScope(scope)) : normalizeScope(scope);
    return { entry: existing, replaced: true };
  }
  const entry = { id: crypto.randomBytes(6).toString('hex'), host, port, username, password, scope: normalizeScope(scope), updatedAt: Date.now() };
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

/** Import a CSV export. New logins get `scope`, plus the workspaces a cobrowser export noted
 *  for them; existing ones get their password replaced and their workspaces widened to include
 *  those, never narrowed. */
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
    const { replaced } = upsertLogin(vault, url, user || '', pass, noted === undefined ? scope : mergeScope(noted, normalizeScope(scope)), { mergeScope: true });
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
    rows.push([label, url, e.username || '', e.password || '', workspacesNote(e.scope)]);
  }
  return rows.map((r) => r.map((c) => q(String(c))).join(',')).join('\n') + '\n';
}

module.exports = {
  normalizeScope, allowed, mergeScope, publicEntry, findEntry, upsertLogin, updateLogin, setScope, removeLogin,
  parseCsv, importCsv, exportCsv,
};
