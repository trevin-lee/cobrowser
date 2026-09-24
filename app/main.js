// cobrowser browser service. Owns every workspace's browser tabs as OFFSCREEN webContents and
// streams them to the editor; the editor's puppeteer connects to this process's debugging
// port and drives the same tabs, so the MCP tools are unchanged.
//
// Offscreen means rendered into GPU memory with no OS window: nothing for macOS to hide,
// minimize or clamp, which is what stalled every window-based design. The process outlives
// editor windows, so a reload no longer restarts the browser or drops session cookies.
//
// Wire protocol, one WebSocket per editor window (authenticated by the token in app.json):
//   -> {type:'hello', workspace}                       <- {type:'hello', debugWs, tabs:[...]}
//   -> {type:'openTab', url, width, height}            <- {type:'tab', tabId, targetId, url}
//   -> {type:'closeTab'|'resize'|'subscribe'|'unsubscribe', tabId, ...}
//   -> {type:'closeAll'}                               (this workspace's tabs)
//   <- binary frame  [u32 metaLen][meta JSON][jpeg]    meta.tabId says which tab
//   <- {type:'tab', ...} for tabs the page opened itself; {type:'tabClosed', tabId}
const { app, BrowserWindow, Tray, Menu, nativeImage, session, safeStorage, systemPreferences, ipcMain, dialog } = require('electron');
const { WebSocketServer } = require('ws');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseSite, siteMatches, siteLabel } = require('./site.js');

// Overridable so tests can run a second instance beside the real one without clobbering its state.
const STATE_DIR = process.env.COBROWSER_STATE_DIR || path.join(os.homedir(), '.cobrowser');
const STATE_FILE = path.join(STATE_DIR, 'app.json');
const JPEG_QUALITY = 90; // q80 rings around glyphs; the frame is the thing the human reads
const FRAME_RATE = 60;
const VERSION = process.env.COBROWSER_VERSION || app.getVersion();
const ICON = process.env.COBROWSER_ICON;

// Our own data directory: partitions, caches and the log live here, not in Electron's
// generic default that every unpackaged Electron app on the machine shares.
const DATA_DIR = process.env.COBROWSER_DATA_DIR
  || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'cobrowser')
    : path.join(STATE_DIR, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath('userData', DATA_DIR);
app.setName('cobrowser'); // names the Keychain item safeStorage uses ("cobrowser Safe Storage")

// stdio is discarded by the extension that spawns us, so anything worth knowing goes here.
const LOG_FILE = path.join(DATA_DIR, 'app.log');
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (p instanceof Error ? p.stack || p.message : String(p))).join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* nowhere to log */ }
  process.stdout.write(line);
}
process.on('uncaughtException', (e) => log('uncaughtException', e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e));

// Passkeys: only meaningful when the binary was signed with the matching keychain-access-
// groups entitlement (see the extension's signApp.ts); the group arrives from that step.
// Unsigned, the extension keeps its fail-fast virtual authenticator instead.
const WEBAUTHN_GROUP = process.env.COBROWSER_WEBAUTHN_GROUP || '';
if (WEBAUTHN_GROUP && typeof app.configureWebAuthn === 'function') {
  try {
    app.configureWebAuthn({ touchID: { keychainAccessGroup: WEBAUTHN_GROUP, promptReason: 'sign in with a passkey' } });
  } catch (e) { console.error('configureWebAuthn failed:', e.message); }
}

// Port 0: Chromium picks a free port and writes DevToolsActivePort into userData.
app.commandLine.appendSwitch('remote-debugging-port', '0');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.platform === 'darwin') app.dock?.hide(); // menu-bar app, not a Dock app

/** Chrome's UA for this build, without the Electron token that would otherwise be in it. */
const CHROME_UA = (() => {
  const chrome = process.versions.chrome.split('.')[0];
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`;
})();

// ---------------------------------------------------------------------------------------
// Vault: logins the agent can USE without ever SEEING. Encrypted at rest through the OS
// keychain (safeStorage), unlocked per app session behind Touch ID, filled straight into
// the page over this process's debugger. Nothing here ever returns a password to a client.
// ---------------------------------------------------------------------------------------
const VAULT_FILE = path.join(DATA_DIR, 'vault.bin');
let vault = null; // { entries: [{ id, host, username, password, updatedAt }] } while unlocked

// Test-only: the UI tests run an isolated instance nobody is sitting at, so they cannot
// answer a Touch ID prompt. Never set in normal use; every skip is logged.
const SKIP_BIOMETRICS = process.env.COBROWSER_TEST_NO_BIOMETRICS === '1';
async function promptBiometrics(reason) {
  if (SKIP_BIOMETRICS) { log('vault: TEST MODE — biometrics skipped for: ' + reason); return; }
  await Promise.race([
    systemPreferences.promptTouchID(reason),
    new Promise((_r, rej) => setTimeout(() => rej(new Error('Touch ID prompt timed out')), 45000)),
  ]);
}

async function unlockVault(reason) {
  if (vault) return vault;
  if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
    await promptBiometrics(reason || 'unlock the cobrowser vault'); // rejects on cancel/failure
  } else {
    log('vault: Touch ID unavailable (lid closed / no sensor) — unlocking without biometrics');
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS keychain encryption is unavailable');
  vault = fs.existsSync(VAULT_FILE)
    ? JSON.parse(safeStorage.decryptString(fs.readFileSync(VAULT_FILE)))
    : { entries: [] };
  log(`vault: unlocked (${vault.entries.length} logins)`);
  return vault;
}
function saveVault() {
  fs.writeFileSync(VAULT_FILE, safeStorage.encryptString(JSON.stringify(vault)), { mode: 0o600 });
}
function lockVault() { vault = null; log('vault: locked'); }

// Workspaces that have ever connected, so the vault window can offer them as scopes even
// when no editor window is open for them right now.
const WORKSPACES_FILE = path.join(DATA_DIR, 'workspaces.json');
function knownWorkspaces() {
  try { return JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8')); } catch { return []; }
}
function rememberWorkspace(id) {
  const list = knownWorkspaces();
  if (list.includes(id)) return;
  list.push(id); list.sort();
  fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(list, null, 2));
}

/** A login's scope is 'all' or a list of workspace paths. A workspace can only list and
 *  fill logins in its scope; it cannot learn that others exist. */
function normalizeScope(scope) {
  if (scope === 'all') return 'all';
  if (Array.isArray(scope)) return [...new Set(scope.filter((w) => typeof w === 'string' && w))];
  return [];
}
function allowed(entry, workspaceId) {
  return entry.scope === 'all' || (Array.isArray(entry.scope) && entry.scope.includes(workspaceId));
}
function publicEntry(e) { return { host: siteLabel(e), username: e.username, scope: e.scope }; }

function upsertLogin(site, username, password, scope) {
  const { host, port } = parseSite(site);
  if (!host) throw new Error('site is required');
  const existing = vault.entries.find((e) => e.host === host && (e.port || '') === port && e.username === username);
  if (existing) {
    existing.password = password; existing.updatedAt = Date.now();
    if (scope !== undefined) existing.scope = normalizeScope(scope);
    return existing;
  }
  const e = { id: crypto.randomBytes(6).toString('hex'), host, port, username, password, scope: normalizeScope(scope), updatedAt: Date.now() };
  vault.entries.push(e);
  return e;
}
function findEntry(label, username) {
  const { host, port } = parseSite(label);
  return vault.entries.find((x) => x.host === host && (x.port || '') === port && x.username === username);
}
function setScope(host, username, scope) {
  const e = findEntry(host, username);
  if (e) e.scope = normalizeScope(scope);
  return !!e;
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
function importCsv(text, scope) {
  const rows = parseCsv(text);
  if (rows.length < 2) return 0;
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => header.findIndex((h) => names.includes(h));
  const iu = col('url', 'login_uri', 'website'), in_ = col('username', 'login_username', 'user'), ip = col('password', 'login_password');
  if (iu < 0 || in_ < 0 || ip < 0) throw new Error(`CSV needs url/username/password columns; found: ${header.join(', ')}`);
  let n = 0;
  for (const r of rows.slice(1)) {
    const url = r[iu], user = r[in_], pass = r[ip];
    if (!url || !pass) continue;
    upsertLogin(url, user || '', pass, scope); n++;
  }
  return n;
}

/** Replace any unlocked password that appears in `text` — what keeps evaluate_script and
 *  snapshots from carrying a filled value back to the agent. */
function scrubSecrets(text) {
  if (!vault || typeof text !== 'string') return text;
  let out = text;
  for (const e of vault.entries) {
    if (e.password && e.password.length >= 4 && out.includes(e.password)) out = out.split(e.password).join('••••••••');
  }
  return out;
}

/** Fill username/password into elements the agent picked by uid. The page must be on the
 *  login's site — the app checks the tab's real URL, not anything the caller claims. */
async function fillCredentials(tab, { usernameUid, passwordUid, username }) {
  const v = await unlockVault('fill a login into the browser');
  const page = parseSite(tab.win.webContents.getURL());
  const host = siteLabel(page);
  // Scope first: a login outside this workspace's scope does not exist as far as it knows.
  let matches = v.entries.filter((e) => allowed(e, tab.workspace.id) && siteMatches(e, page));
  if (username) matches = matches.filter((e) => e.username === username);
  if (matches.length === 0) return { filled: [], error: `no saved login for ${host}` };
  if (matches.length > 1) return { filled: [], error: 'several logins match — pass username', candidates: matches.map((e) => e.username) };
  const entry = matches[0];
  const dbg = tab.win.webContents.debugger;
  const filled = [];
  for (const [uid, value, label] of [[usernameUid, entry.username, 'username'], [passwordUid, entry.password, 'password']]) {
    if (!uid || !value) continue;
    const { result } = await dbg.sendCommand('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector('[data-cobrowser-uid=${JSON.stringify(String(uid))}]'); if (!el) return false; el.focus(); if (el.select) el.select(); return true; })()`,
      returnByValue: true,
    });
    if (!result.value) return { filled, error: `uid ${uid} not found — take a fresh snapshot` };
    await dbg.sendCommand('Input.insertText', { text: value }); // trusted keystrokes, never page JS
    filled.push(label);
  }
  log(`vault: filled ${filled.join('+')} for ${entry.username} on ${host}`);
  return { filled, username: entry.username };
}

function removeLogin(host, username) {
  const before = vault.entries.length;
  const target = findEntry(host, username);
  vault.entries = vault.entries.filter((e) => e !== target);
  return before - vault.entries.length;
}

// ---------------------------------------------------------------------------------------
// Vault window: the menu-bar way to add, remove and import logins. A real (visible) window;
// the page talks to the app only through the preload's narrow bridge.
// ---------------------------------------------------------------------------------------
const VAULT_HTML = `<!doctype html><meta charset="utf-8"><title>cobrowser logins</title>
<style>
  :root {
    color-scheme: light dark;
    /* cobrowser's palette, from its mark: navy, blue, teal (the overlap), green. */
    --bg: #16181d; --panel: #1b1e24; --lift: #22262d; --line: rgba(255,255,255,.07); --line-2: rgba(255,255,255,.13);
    --fg: #e6e8ec; --muted: #8b919c; --dim: #4f5560;
    --blue: #388bfd; --teal: #2fbdb9; --green: #29a891; --danger: #e5534b;
    --blue-soft: rgba(56,139,253,.14); --green-soft: rgba(41,168,145,.16); --teal-glow: rgba(47,189,185,.35); --sel-ring: #1f2b3d;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #f2f3f5; --panel: #fff; --lift: #f7f8fa; --line: rgba(0,0,0,.07); --line-2: rgba(0,0,0,.14);
      --fg: #171a20; --muted: #656b77; --dim: #b3b8c2; --blue: #1f6fe0; --teal: #1a9c98; --green: #1f8f7b; --danger: #c93c31; --teal-glow: rgba(26,156,152,.3); --sel-ring: #e4ecfa; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { background: var(--bg); color: var(--fg); font: 13px/1.45 -apple-system, "SF Pro Text", system-ui, sans-serif; -webkit-user-select: none; display: grid; grid-template-rows: auto 1fr; -webkit-font-smoothing: antialiased; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: -.01em; }
  input { font: inherit; color: var(--fg); }
  button { font: inherit; color: var(--fg); background: var(--lift); border: 1px solid var(--line-2); border-radius: 7px; height: 28px; padding: 0 12px; cursor: default; }
  button:hover { border-color: var(--muted); }
  button.quiet { background: transparent; border-color: transparent; color: var(--muted); } button.quiet:hover { color: var(--fg); background: var(--lift); }
  button.primary { background: var(--blue); border-color: transparent; color: #fff; font-weight: 600; } button.primary:disabled { opacity: .4; }
  button.danger:hover { color: var(--danger); border-color: var(--danger); }
  :focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  ::-webkit-scrollbar { width: 8px; } ::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 4px; border: 2px solid transparent; background-clip: padding-box; }

  header { -webkit-app-region: drag; display: flex; align-items: center; gap: 10px; padding: 30px 22px 14px; }
  header svg { width: 20px; height: 20px; }
  header h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -.01em; }
  header .sub { color: var(--muted); margin-left: 2px; }
  header .spacer { flex: 1; } header button, header .state { -webkit-app-region: no-drag; }
  .state { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; padding: 0 4px; }
  .state i { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); } .state.on i { background: var(--green); box-shadow: 0 0 0 3px var(--green-soft); }

  .panes { display: grid; grid-template-columns: 320px 1fr; gap: 14px; padding: 0 22px 22px; min-height: 0; }
  .pane { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }

  /* roster */
  .search { padding: 10px 12px; border-bottom: 1px solid var(--line); }
  .search input { width: 100%; background: var(--lift); border: 1px solid var(--line); border-radius: 7px; height: 28px; padding: 0 10px 0 28px; outline: 0; -webkit-user-select: text;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%238b919c' stroke-width='2.2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='M20 20l-3.5-3.5'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: 9px center; }
  .search input::placeholder { color: var(--dim); }
  .list { overflow: auto; flex: 1; }
  .item { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
  .item:hover { background: var(--lift); } .item.sel { background: var(--blue-soft); box-shadow: inset 3px 0 0 var(--blue); }
  .item .id { min-width: 0; flex: 1; }
  .item b { display: block; font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } b em { font-style: normal; color: var(--muted); font-weight: 400; }
  .item .id span { display: block; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .foot { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); } .foot .primary { flex: 1; }
  .empty { margin: auto; padding: 24px; text-align: center; color: var(--muted); max-width: 300px; line-height: 1.5; }

  /* the signature: where a login meets a workspace. One disc per workspace, in its hue. */
  .discs { display: inline-flex; align-items: center; flex: none; }
  .disc { width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid var(--dim); background: transparent; flex: none; }
  .discs .disc { margin-left: -5px; box-shadow: 0 0 0 2px var(--panel); } .discs .disc:first-child { margin-left: 0; }
  .item.sel .discs .disc { box-shadow: 0 0 0 2px var(--sel-ring); }
  .disc.on { border-color: transparent; background: var(--c, var(--teal)); }
  .disc.all { border-color: var(--green); background: radial-gradient(circle, var(--green) 0 3px, transparent 3.5px); }
  .disc.none { border-style: dashed; }
  .discs small { color: var(--muted); font-size: 11px; margin-left: 5px; }

  /* card */
  .detail { padding: 20px 22px; display: flex; flex-direction: column; gap: 18px; min-height: 0; }
  .card-in { display: flex; flex-direction: column; gap: 18px; flex: 1; min-height: 0; }
  .sec.grow { flex: 1; min-height: 0; }
  .title { display: flex; align-items: flex-start; gap: 12px; }
  .title .id { flex: 1; min-width: 0; } .title h2 { margin: 0; font-size: 22px; font-weight: 600; line-height: 1.2; overflow-wrap: anywhere; } .title h2 em { font-style: normal; font-weight: 400; color: var(--muted); }
  .title .user { color: var(--muted); margin-top: 3px; font-size: 13px; }
  .title .acts { display: flex; gap: 4px; flex: none; }
  h3 { margin: 0; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
  .sec { display: flex; flex-direction: column; gap: 8px; }
  .fields { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .field { display: grid; grid-template-columns: 96px 1fr; align-items: center; min-height: 40px; padding: 0 14px; border-bottom: 1px solid var(--line); background: var(--lift); }
  .field:last-child { border-bottom: 0; } .field label { color: var(--muted); font-size: 12.5px; }
  .field input { background: none; border: 0; outline: 0; height: 40px; padding: 0; -webkit-user-select: text; } .field input::placeholder { color: var(--dim); }
  .pw { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .pw span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); letter-spacing: .12em; }
  .pw span.revealed { color: var(--fg); letter-spacing: 0; -webkit-user-select: text; }
  .scope { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; flex: 1; min-height: 160px; }
  .row { display: flex; align-items: center; gap: 12px; padding: 0 14px; height: 40px; border-bottom: 1px solid var(--line); }
  .row:last-child { border-bottom: 0; }
  .row.every { background: var(--lift); } .row.every b { flex: 1; font-weight: 600; } .row.every small { color: var(--muted); }
  .switch { width: 34px; height: 20px; border-radius: 999px; background: var(--dim); position: relative; border: 0; padding: 0; transition: background .15s; }
  .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; }
  .switch[aria-checked="true"] { background: var(--green); } .switch[aria-checked="true"]::after { transform: translateX(14px); }
  .wsfilter { padding: 8px 10px; border-bottom: 1px solid var(--line); } .wsfilter input { width: 100%; background: var(--panel); border: 1px solid var(--line); border-radius: 7px; height: 26px; padding: 0 9px; outline: 0; -webkit-user-select: text; font-size: 12.5px; }
  .wslist { overflow: auto; flex: 1; }
  .ws { height: 38px; } .ws:hover { background: var(--lift); }
  .ws .disc { transition: transform .12s ease, background-color .12s ease; } .ws:hover .disc { transform: scale(1.15); }
  .ws .disc.on { box-shadow: 0 0 0 3px var(--teal-glow); }
  .ws .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .ws .name small { color: var(--muted); margin-left: 8px; }
  .ws.inherit { opacity: .5; pointer-events: none; }
  .hint { color: var(--muted); font-size: 12px; margin: 0; line-height: 1.5; }
  .actions { display: flex; gap: 8px; padding-top: 2px; align-items: center; flex: none; } .actions .spacer { flex: 1; }
  #status { color: var(--muted); font-size: 12px; min-height: 17px; }
  .lockcard { margin: auto; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px; color: var(--muted); max-width: 320px; line-height: 1.5; }
  .lockcard svg { width: 28px; height: 28px; opacity: .6; }
  @media (prefers-reduced-motion: reduce) { .switch, .switch::after, .ws .disc { transition: none; } }
</style>
<header>
  <svg viewBox="0 0 128 128" aria-hidden="true"><circle cx="46" cy="64" r="40" fill="#388bfd"/><circle cx="82" cy="64" r="40" fill="#29a891"/><path d="M64 33.4a40 40 0 0 1 0 61.2 40 40 0 0 1 0-61.2z" fill="#2fbdb9"/></svg>
  <h1>Logins</h1><span class="sub">what the agent may sign in with, and where</span>
  <span class="spacer"></span>
  <span class="state" id="state"><i></i><span>Locked</span></span>
  <button class="quiet" id="lock">Lock</button>
</header>
<div class="panes">
  <section class="pane">
    <div class="search"><input id="q" placeholder="Filter" autocomplete="off" spellcheck="false"></div>
    <div class="list" id="list" tabindex="0"></div>
    <div class="foot"><button class="primary" id="new">Add login</button><button id="import">Import CSV…</button></div>
  </section>
  <section class="pane detail" id="detail"></section>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  let known = [], rows = [], unlocked = false, unlocking = false, lastError = '', sel = null, mode = 'view';
  const draft = { host: '', user: '', pass: '', scope: [] };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const base = (p) => p.split('/').filter(Boolean).slice(-1)[0] || p;
  const dir = (p) => ('/' + p.split('/').filter(Boolean).slice(0, -1).join('/')).replace(new RegExp('^/Users/[^/]+'), '~');
  const say = (t) => { const s = $('status'); if (s) s.textContent = t; };
  const hostParts = (h) => { const [hostOnly, port] = h.split(':'); const p = hostOnly.split('.'); const tail = port ? ':' + port : ''; return p.length > 2 && !/^\\d+$/.test(p[0]) ? [p.slice(0, -2).join('.') + '.', p.slice(-2).join('.') + tail] : ['', h]; };
  const scopeText = (sc) => sc === 'all' ? 'everywhere' : !sc || !sc.length ? 'nowhere' : sc.length === 1 ? base(sc[0]) : sc.length + ' workspaces';

  /** A stable hue per workspace on the brand arc (blue 212° → green 168°). */
  const hue = (w) => { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return 168 + (h % 45); };
  const color = (w) => 'hsl(' + hue(w) + ' 62% 56%)';
  function disc(cls, w) { const d = el('span', 'disc' + (cls ? ' ' + cls : '')); if (w) { d.style.setProperty('--c', color(w)); d.title = base(w); } return d; }
  function discStack(sc) {
    const box = el('span', 'discs');
    if (sc === 'all') { box.append(disc('all')); box.append(el('small', null, 'everywhere')); return box; }
    if (!sc || !sc.length) { box.append(disc('none')); box.append(el('small', null, 'nowhere')); return box; }
    for (const w of sc.slice(0, 4)) box.append(disc('on', w));
    box.append(el('small', null, sc.length > 4 ? '+' + (sc.length - 4) : sc.length === 1 ? base(sc[0]) : ''));
    return box;
  }

  function state() { $('state').className = 'state' + (unlocked ? ' on' : ''); $('state').lastElementChild.textContent = unlocked ? rows.length + ' login' + (rows.length === 1 ? '' : 's') + ' · unlocked' : 'Locked'; }

  function renderList() {
    const q = $('q').value.trim().toLowerCase();
    const list = $('list'); list.innerHTML = '';
    const shown = rows.filter((r) => !q || (r.host + ' ' + r.username + ' ' + scopeText(r.scope)).toLowerCase().includes(q));
    if (!unlocked) { list.append(el('div', 'empty', 'Locked.')); return; }
    if (!rows.length) { list.append(el('div', 'empty', 'No logins yet. Add one, or import a CSV export from Passwords, Bitwarden or Chrome.')); return; }
    if (!shown.length) { list.append(el('div', 'empty', 'Nothing matches “' + q + '”.')); return; }
    for (const r of shown) {
      const it = el('div', 'item' + (sel === r ? ' sel' : ''));
      const id = el('div', 'id'); const b = el('b', 'mono'); const [pre, dom] = hostParts(r.host); b.append(el('em', null, pre), dom);
      id.append(b, el('span', 'mono', r.username || '(no username)'));
      it.append(id, discStack(r.scope));
      it.onclick = () => { sel = r; mode = 'view'; render(); };
      list.append(it);
    }
  }

  function scopeEditor(getScope, setScope) {
    const box = el('div', 'scope');
    const every = el('div', 'row every'); every.append(disc('all'), el('b', null, 'Everywhere'), el('small', null, 'any workspace'));
    const sw = el('button', 'switch'); sw.setAttribute('role', 'switch'); every.append(sw);
    const filt = el('div', 'wsfilter'); const fi = el('input'); fi.placeholder = 'Filter workspaces'; fi.autocomplete = 'off'; fi.spellcheck = false; filt.append(fi);
    const wl = el('div', 'wslist'); box.append(every, filt, wl);
    const paint = () => {
      const sc = getScope(); const all = sc === 'all';
      sw.setAttribute('aria-checked', String(all));
      const q = fi.value.trim().toLowerCase();
      const items = known.filter((w) => !q || w.toLowerCase().includes(q)).sort((a, b) => { const A = !all && sc.includes(a), B = !all && sc.includes(b); return A === B ? base(a).localeCompare(base(b)) : A ? -1 : 1; });
      wl.innerHTML = '';
      if (!known.length) wl.append(el('div', 'empty', 'Workspaces appear here once they have opened cobrowser.'));
      for (const w of items) {
        const on = all || sc.includes(w);
        const r = el('div', 'row ws' + (all ? ' inherit' : ''));
        const name = el('div', 'name'); name.append(base(w), el('small', null, dir(w))); name.title = w;
        r.append(disc(on ? 'on' : '', w), name);
        r.onclick = () => { if (all) return; setScope(on ? sc.filter((x) => x !== w) : [...sc, w]); paint(); };
        wl.append(r);
      }
    };
    sw.onclick = () => { setScope(getScope() === 'all' ? [] : 'all'); paint(); };
    fi.oninput = paint; paint();
    return box;
  }

  function section(title, body, grow) { const s = el('div', 'sec' + (grow ? ' grow' : '')); s.append(el('h3', null, title), body); return s; }

  function renderDetail() {
    const d = $('detail'); d.innerHTML = '';
    const wrap = el('div', 'card-in'); d.append(wrap);
    if (!unlocked) {
      const lc = el('div', 'lockcard');
      lc.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
      const b = el('button', 'primary', unlocking ? 'Waiting for Touch ID…' : 'Unlock'); b.disabled = unlocking; b.onclick = refresh;
      lc.append(el('div', null, 'Locked. Unlock to see logins; changes always ask for Touch ID.'), b);
      if (lastError && !unlocking) lc.append(el('p', 'hint', lastError));
      wrap.append(lc); return;
    }
    if (mode === 'add' || mode === 'import') {
      const importing = mode === 'import';
      const t = el('div', 'title'); const id = el('div', 'id'); id.append(el('h2', null, importing ? 'Import logins' : 'New login')); t.append(id); wrap.append(t);
      if (importing) wrap.append(el('p', 'hint', 'Every imported login gets the workspaces you choose here. You can change each one afterwards.'));
      else {
        const f = el('div', 'fields');
        for (const [key, label, ph, type] of [['host', 'Site', 'costco.com, or 192.168.1.50:8080', 'text'], ['user', 'Username', 'you@example.com', 'text'], ['pass', 'Password', '', 'password']]) {
          const row = el('div', 'field'); const inp = el('input', key === 'pass' ? '' : 'mono'); inp.type = type; inp.placeholder = ph; inp.value = draft[key]; inp.autocomplete = 'off'; inp.spellcheck = false;
          inp.oninput = () => { draft[key] = inp.value; sync(); }; inp.onkeydown = (e) => { if (e.key === 'Enter' && canSave()) save(); };
          row.append(el('label', null, label), inp); f.append(row);
        }
        wrap.append(section('Login', f));
      }
      wrap.append(section('Where the agent may use it', scopeEditor(() => draft.scope, (v) => { draft.scope = v; sync(); }), true));
      const a = el('div', 'actions'); const st = el('div'); st.id = 'status'; a.append(st, el('span', 'spacer'));
      const cancel = el('button', 'quiet', 'Cancel'); cancel.onclick = () => { Object.assign(draft, { host: '', user: '', pass: '', scope: [] }); mode = 'view'; render(); };
      const ok = el('button', 'primary', importing ? 'Choose CSV…' : 'Save login'); ok.id = 'save'; ok.onclick = importing ? doImport : save;
      a.append(cancel, ok); wrap.append(a); sync();
      if (!importing) wrap.querySelector('input').focus();
      return;
    }
    if (!sel) { wrap.append(el('div', 'empty', rows.length ? 'Pick a login to see where the agent may use it.' : 'Add a login and choose which workspaces may use it. The agent can sign in with it, but never sees the password.')); return; }

    const t = el('div', 'title'); const id = el('div', 'id'); const h2 = el('h2', 'mono'); const [pre, dom] = hostParts(sel.host); h2.append(el('em', null, pre), dom);
    id.append(h2, el('div', 'user mono', sel.username || '(no username)')); t.append(id);
    const acts = el('div', 'acts'); const rm = el('button', 'quiet danger', 'Remove'); rm.onclick = async () => { await vault.remove(sel.host, sel.username); sel = null; await refresh(); }; acts.append(rm); t.append(acts); wrap.append(t);

    const pw = el('div', 'fields'); const prow = el('div', 'field'); prow.style.gridTemplateColumns = '1fr';
    const pval = el('div', 'pw'); const dots = el('span', 'mono', '••••••••••'); pval.append(dots);
    const copyBtn = el('button', 'quiet', 'Copy'); copyBtn.hidden = true; const show = el('button', 'quiet', 'Show'); let hideTimer;
    const hide = () => { clearTimeout(hideTimer); dots.textContent = '••••••••••'; dots.classList.remove('revealed'); show.textContent = 'Show'; copyBtn.hidden = true; };
    show.onclick = async () => {
      if (dots.classList.contains('revealed')) return hide();
      try { const secret = await vault.reveal(sel.host, sel.username); dots.textContent = secret; dots.classList.add('revealed'); show.textContent = 'Hide'; copyBtn.hidden = false;
        copyBtn.onclick = async () => { await navigator.clipboard.writeText(secret); copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500); };
        hideTimer = setTimeout(hide, 30000); } catch (e) { say(e.message); }
    };
    pval.append(copyBtn, show); prow.append(pval); pw.append(prow);
    wrap.append(section('Password', pw));
    wrap.append(section('Where the agent may use it', scopeEditor(() => sel.scope, async (v) => { sel.scope = v; renderList(); try { await vault.setScope(sel.host, sel.username, v); } catch (e) { say(e.message); } }), true));
    const a = el('div', 'actions'); const st = el('div'); st.id = 'status'; a.append(st); wrap.append(a);
  }
  const canSave = () => !!(draft.host.trim() && draft.pass && (draft.scope === 'all' || draft.scope.length));
  const sync = () => {
    const b = $('save'); if (!b) return;
    const scoped = draft.scope === 'all' || draft.scope.length > 0;
    b.disabled = mode === 'add' ? !canSave() : !scoped;
    // Say why Save is off, once the rest is filled in — the missing piece is otherwise invisible.
    const st = $('status'); if (st && (mode !== 'add' || (draft.host.trim() && draft.pass))) st.textContent = scoped ? '' : 'Choose a workspace, or Everywhere.';
  };
  async function save() {
    try { await vault.add(draft.host.trim(), draft.user.trim(), draft.pass, draft.scope); const h = draft.host.trim().toLowerCase(); Object.assign(draft, { host: '', user: '', pass: '', scope: [] }); mode = 'view'; await refresh(); sel = rows.find((r) => h.includes(r.host.split(':')[0])) || null; render(); }
    catch (e) { say(e.message); }
  }
  async function doImport() {
    try { const n = await vault.importCsv(draft.scope); if (n == null) return; mode = 'view'; draft.scope = []; await refresh(); say('Imported ' + n + ' login' + (n === 1 ? '' : 's') + '.'); }
    catch (e) { say(e.message); }
  }
  function render() { renderList(); renderDetail(); state(); }
  async function refresh() {
    if (unlocking) return; unlocking = true; render();
    try { rows = await vault.list(); unlocked = true; lastError = ''; } catch (e) { unlocked = false; rows = []; lastError = e.message; } finally { unlocking = false; }
    known = await vault.workspaces();
    if (sel) sel = rows.find((r) => r.host === sel.host && r.username === sel.username) || null;
    render();
  }
  const ensureUnlocked = async () => { if (!unlocked) await refresh(); return unlocked; };
  $('q').oninput = renderList;
  $('new').onclick = async () => { if (!(await ensureUnlocked())) return; mode = 'add'; sel = null; render(); };
  $('import').onclick = async () => { if (!(await ensureUnlocked())) return; mode = 'import'; sel = null; render(); };
  $('lock').onclick = async () => { await vault.lock(); unlocked = false; rows = []; sel = null; mode = 'view'; render(); };
  // ↑/↓ move the selection through the roster.
  $('list').addEventListener('keydown', (e) => { if (!rows.length || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return; e.preventDefault(); const i = rows.indexOf(sel); sel = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]; mode = 'view'; render(); });
  vault.workspaces().then((w) => { known = w; });
  render(); refresh();
</script>`;

let vaultWin;
function openVaultWindow() {
  if (vaultWin && !vaultWin.isDestroyed()) { vaultWin.show(); vaultWin.focus(); return; }
  const { nativeTheme } = require('electron');
  vaultWin = new BrowserWindow({
    width: 820, height: 560, minWidth: 660, minHeight: 440, title: 'cobrowser logins', show: false,
    titleBarStyle: 'hiddenInset', backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#f3f4f6',
    webPreferences: { preload: path.join(__dirname, 'vault-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  vaultWin.once('ready-to-show', () => { vaultWin.show(); vaultWin.focus(); });
  vaultWin.on('closed', () => { vaultWin = undefined; });
  void vaultWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(VAULT_HTML));
}

ipcMain.handle('vault:list', async () => (await unlockVault('show the logins in the cobrowser vault')).entries.map(publicEntry));
ipcMain.handle('vault:workspaces', () => knownWorkspaces());
ipcMain.handle('vault:add', async (_e, { host, username, password, scope }) => {
  if (!host || !password) throw new Error('site and password are required');
  await unlockVault('add a login to the cobrowser vault'); upsertLogin(host, username || '', password, scope); saveVault();
});
ipcMain.handle('vault:setScope', async (_e, { host, username, scope }) => { await unlockVault('change which workspaces may use a login'); setScope(host, username, scope); saveVault(); });
ipcMain.handle('vault:remove', async (_e, { host, username }) => { await unlockVault('remove a login'); removeLogin(host, username); saveVault(); });
ipcMain.handle('vault:reveal', async (_e, { host, username }) => {
  // Showing a password is the one thing that must not ride on the session unlock: a fresh
  // biometric check every time, and no fallback when Touch ID cannot be presented.
  if (!SKIP_BIOMETRICS && (process.platform !== 'darwin' || !systemPreferences.canPromptTouchID())) throw new Error('Touch ID is needed to show a password (open the lid, or use a Mac with Touch ID)');
  await unlockVault('show a password');
  await promptBiometrics(`show the password for ${username || host} on ${host}`);
  const e = findEntry(host, username);
  if (!e) throw new Error('no such login');
  log(`vault: revealed password for ${e.username} on ${siteLabel(e)}`);
  return e.password;
});
ipcMain.handle('vault:importCsv', async (_e, { scope } = {}) => {
  const r = await dialog.showOpenDialog(vaultWin, { properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }], title: 'Import logins (Apple Passwords / Bitwarden / Chrome export)' });
  if (r.canceled || !r.filePaths[0]) return null;
  await unlockVault('import logins into the cobrowser vault');
  const n = importCsv(fs.readFileSync(r.filePaths[0], 'utf8'), scope); saveVault();
  const del = await dialog.showMessageBox(vaultWin, { message: `Imported ${n} login(s).`, detail: 'The CSV is plaintext. Delete it now?', buttons: ['Delete the CSV', 'Keep'], defaultId: 0 });
  if (del.response === 0) fs.rmSync(r.filePaths[0], { force: true });
  return n;
});
ipcMain.handle('vault:lock', () => lockVault());

const workspaces = new Map(); // workspace path -> Workspace
let nextTabId = 1;

class Tab {
  constructor(workspace, { url, width, height }) {
    this.workspace = workspace;
    this.id = `t${nextTabId++}`;
    this.subscribers = new Set(); // sockets receiving frames
    this.targetId = undefined;
    /** CSS size the panel wants, the render scale (device pixels per CSS px), and the
     *  per-site zoom. The window is css*scale pixels wide and the page is zoomed by
     *  scale*zoom, so it lays out at css/zoom CSS px and rasterizes at `scale` px per CSS px.
     *  Offscreen painting always produces exactly the window's pixels, so this is the only
     *  way to get a genuinely 2x (or supersampled) frame with a correctly sized layout. */
    this.layout = { cssW: Math.round(width) || 1280, cssH: Math.round(height) || 800, scale: 1, zoom: 1 };
    this.win = new BrowserWindow({
      show: false,
      width: Math.max(100, Math.round(width) || 1280),
      height: Math.max(100, Math.round(height) || 800),
      webPreferences: {
        offscreen: true,
        partition: workspace.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const wc = this.win.webContents;
    wc.setFrameRate(FRAME_RATE);
    wc.debugger.attach('1.3');
    wc.on('paint', (_e, _dirty, image) => this.onPaint(image));
    // Chromium forgets the zoom factor on cross-origin navigation; the panel's scale must not.
    wc.on('did-navigate', () => this.applyZoom());
    // An offscreen page is never focused as far as Chromium knows, which breaks
    // navigator.clipboard.writeText ("Document is not focused") and anything else gated on
    // focus. Emulate it: the panel IS what the human is looking at.
    wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
    // A page opening a window (target=_blank, window.open) gets a real tab of its own, which
    // the editor adopts through puppeteer's targetcreated exactly like a Chrome popup.
    wc.setWindowOpenHandler(({ url: u }) => {
      const [w, h] = this.win.getContentSize();
      const t = workspace.openTab({ url: u, width: w, height: h });
      // The target id arrives asynchronously; announcing before it is known gave the editor a
      // tab with no target, so every target=_blank link looked like a dead click.
      void t.ready.then(() => workspace.broadcast({ type: 'tab', ...t.info(), url: u, opener: this.id }));
      return { action: 'deny' };
    });
    wc.on('destroyed', () => workspace.onTabGone(this));
    this.win.on('closed', () => workspace.onTabGone(this));
    this.ready = wc.debugger.sendCommand('Target.getTargetInfo').then((r) => {
      this.targetId = r.targetInfo.targetId;
      return this.targetId;
    });
    void wc.loadURL(url || 'about:blank');
  }

  onPaint(image) {
    if (this.subscribers.size === 0) return;
    const size = image.getSize();
    const jpeg = image.toJPEG(JPEG_QUALITY);
    const { cssW, cssH, zoom } = this.layout;
    // deviceWidth/Height is the page's CSS coordinate space (what input events map to);
    // frameWidth/Height is the bitmap. They differ by scale*zoom.
    const metaBuf = Buffer.from(JSON.stringify({
      tabId: this.id,
      deviceWidth: Math.round(cssW / zoom), deviceHeight: Math.round(cssH / zoom),
      frameWidth: size.width, frameHeight: size.height,
    }));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(metaBuf.length, 0);
    const frame = Buffer.concat([head, metaBuf, jpeg]);
    for (const ws of this.subscribers) {
      if (ws.readyState !== ws.OPEN) { this.subscribers.delete(ws); continue; }
      // Never queue frames behind a slow socket: skip this one, the next paint is newer anyway.
      if (ws.bufferedAmount > 2 * 1024 * 1024) continue;
      ws.send(frame, { binary: true });
    }
  }

  resize(cssW, cssH, scale = 1, zoom = 1) {
    this.layout = { cssW: Math.max(50, Math.round(cssW)), cssH: Math.max(50, Math.round(cssH)), scale: Math.max(1, Number(scale) || 1), zoom: Math.max(0.25, Number(zoom) || 1) };
    const w = Math.round(this.layout.cssW * this.layout.scale), h = Math.round(this.layout.cssH * this.layout.scale);
    const [cw, ch] = this.win.getContentSize();
    if (cw !== w || ch !== h) this.win.setContentSize(w, h);
    this.applyZoom();
  }

  applyZoom() {
    const wc = this.win.webContents;
    if (wc.isDestroyed()) return;
    const zf = this.layout.scale * this.layout.zoom;
    if (Math.abs(wc.getZoomFactor() - zf) > 0.001) wc.setZoomFactor(zf);
  }

  info() {
    return { tabId: this.id, targetId: this.targetId, url: this.win.webContents.getURL() };
  }

  close() {
    this.subscribers.clear();
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}

class Workspace {
  constructor(id) {
    this.id = id;
    this.partition = `persist:ws-${crypto.createHash('sha1').update(id).digest('hex').slice(0, 16)}`;
    this.tabs = new Map();
    this.sockets = new Set();
    const ses = session.fromPartition(this.partition);
    ses.setUserAgent(CHROME_UA);
    // Several passkeys for one site: without a listener Chromium cancels the request. The
    // page is offscreen, so ask with a native dialog instead of in-page UI.
    try {
      ses.on('select-webauthn-account', (_event, details, callback) => {
        const accounts = details.accounts || details.credentials || [];
        if (accounts.length === 1) return callback(accounts[0].id ?? accounts[0].credentialId ?? accounts[0]);
        const names = accounts.map((a) => a.userName || a.displayName || a.name || String(a.id ?? ''));
        dialog.showMessageBox({ type: 'question', message: 'Which passkey?', detail: details.relyingPartyId || '', buttons: [...names, 'Cancel'], cancelId: names.length })
          .then(({ response }) => callback(response < names.length ? (accounts[response].id ?? accounts[response].credentialId ?? accounts[response]) : undefined))
          .catch(() => callback(undefined));
      });
    } catch { /* older Electron without the event */ }
  }

  openTab(opts) {
    const tab = new Tab(this, opts);
    this.tabs.set(tab.id, tab);
    return tab;
  }

  onTabGone(tab) {
    if (!this.tabs.delete(tab.id)) return;
    this.broadcast({ type: 'tabClosed', tabId: tab.id });
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.sockets) if (ws.readyState === ws.OPEN) ws.send(s);
  }

  detach(ws) {
    this.sockets.delete(ws);
    for (const t of this.tabs.values()) t.subscribers.delete(ws);
  }

  closeAll() {
    for (const t of [...this.tabs.values()]) t.close();
  }
}

function workspaceFor(id) {
  let w = workspaces.get(id);
  if (!w) { w = new Workspace(id); workspaces.set(id, w); }
  return w;
}

async function handle(ws, state, m) {
  if (m.type === 'hello') {
    if (typeof m.workspace !== 'string' || !m.workspace) return;
    state.workspace = workspaceFor(m.workspace);
    state.workspace.sockets.add(ws);
    rememberWorkspace(m.workspace);
    const tabs = [];
    for (const t of state.workspace.tabs.values()) { await t.ready; tabs.push(t.info()); }
    ws.send(JSON.stringify({ type: 'hello', debugWs: debugWsEndpoint, version: VERSION, tabs }));
    return;
  }
  if (m.type === 'importCookies') {
    // Migration from the pre-app releases: cookies read out of an old Chrome profile, written
    // into the named workspace's partition. Addressed explicitly so one window can import
    // for every workspace at once.
    const target = workspaceFor(String(m.workspace || ''));
    const ses = session.fromPartition(target.partition);
    let imported = 0, failed = 0;
    for (const c of m.cookies || []) {
      try { await ses.cookies.set(c); imported++; } catch (e) { failed++; if (failed <= 3) log('importCookies', c.name, e.message); }
    }
    await ses.cookies.flushStore().catch(() => undefined);
    log(`importCookies ${target.id}: ${imported} imported, ${failed} failed`);
    ws.send(JSON.stringify({ type: 'imported', imported, failed, requestId: m.requestId }));
    return;
  }
  if (typeof m.type === 'string' && m.type.startsWith('vault.')) {
    const reply = (obj) => ws.send(JSON.stringify({ ...obj, requestId: m.requestId }));
    try {
      switch (m.type) {
        // Added over the socket, a login defaults to the calling workspace's scope.
        case 'vault.add': { await unlockVault('add a login to the cobrowser vault'); upsertLogin(m.host, m.username, m.password, m.scope ?? [state.workspace?.id].filter(Boolean)); saveVault(); return reply({ ok: true }); }
        case 'vault.import': { await unlockVault('import logins into the cobrowser vault'); const n = importCsv(String(m.csv || ''), m.scope ?? [state.workspace?.id].filter(Boolean)); saveVault(); return reply({ ok: true, count: n }); }
        case 'vault.list': {
          const v = await unlockVault('list the logins in the cobrowser vault');
          const wsId = state.workspace?.id;
          return reply({ logins: v.entries.filter((e) => wsId && allowed(e, wsId)).map((e) => ({ host: siteLabel(e), username: e.username })) });
        }
        case 'vault.lock': { lockVault(); return reply({ ok: true }); }
        case 'vault.scrub': return reply({ text: scrubSecrets(m.text) });
        case 'vault.fill': {
          const tab = state.workspace?.tabs.get(m.tabId);
          if (!tab) return reply({ filled: [], error: 'no such tab in this workspace' });
          return reply(await fillCredentials(tab, m));
        }
        default: return reply({ error: `unknown ${m.type}` });
      }
    } catch (e) {
      log('vault', m.type, e);
      return reply({ error: e.message || String(e) });
    }
  }
  const w = state.workspace;
  if (!w) return;
  switch (m.type) {
    case 'openTab': {
      const t = w.openTab(m);
      await t.ready;
      ws.send(JSON.stringify({ type: 'tab', ...t.info(), requestId: m.requestId }));
      return;
    }
    case 'listTabs': {
      const tabs = [];
      for (const t of w.tabs.values()) { await t.ready; tabs.push(t.info()); }
      ws.send(JSON.stringify({ type: 'tabs', tabs, requestId: m.requestId }));
      return;
    }
    case 'closeTab': return void w.tabs.get(m.tabId)?.close();
    case 'closeAll': return void w.closeAll();
    case 'resize': return void w.tabs.get(m.tabId)?.resize(m.width, m.height, m.scale, m.zoom);
    case 'subscribe': {
      const t = w.tabs.get(m.tabId);
      if (!t) return;
      t.subscribers.add(ws);
      t.win.webContents.invalidate(); // a fresh subscriber wants a frame now, not on next change
      return;
    }
    case 'unsubscribe': return void w.tabs.get(m.tabId)?.subscribers.delete(ws);
  }
}

let debugWsEndpoint = '';

function readDebugEndpoint() {
  // Written by Chromium once the port is bound: "<port>\n<browser ws path>".
  const f = path.join(app.getPath('userData'), 'DevToolsActivePort');
  const deadline = Date.now() + 10000;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const [port, p] = fs.readFileSync(f, 'utf8').trim().split('\n');
        if (port && p) return resolve(`ws://127.0.0.1:${port}${p}`);
      } catch { /* not yet */ }
      if (Date.now() > deadline) return reject(new Error('DevToolsActivePort never appeared'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function makeTray() {
  // A TEMPLATE image (monochrome + alpha, filename ends in "Template"): macOS recolors it for
  // light and dark menu bars. The app icon is dark-on-dark at 18px and simply vanished.
  let icon = nativeImage.createEmpty();
  if (ICON && fs.existsSync(ICON)) {
    icon = nativeImage.createFromPath(ICON);
    icon.setTemplateImage(true);
    if (icon.isEmpty()) log('tray: icon unreadable:', ICON);
  } else {
    log('tray: no icon at', ICON || '(unset)');
  }
  const tray = new Tray(icon);
  tray.setToolTip('cobrowser');
  if (icon.isEmpty()) tray.setTitle('cb');
  const refresh = () => {
    const items = [{ label: `cobrowser ${VERSION}`, enabled: false }, { type: 'separator' }];
    for (const w of workspaces.values()) {
      items.push({ label: `${path.basename(w.id)} — ${w.tabs.size} tab${w.tabs.size === 1 ? '' : 's'}`, enabled: false });
    }
    if (workspaces.size) items.push({ type: 'separator' });
    items.push({ label: vault ? `Vault: unlocked, ${vault.entries.length} login${vault.entries.length === 1 ? '' : 's'}` : 'Vault: locked', enabled: false });
    items.push({ label: 'Logins…', click: () => openVaultWindow() });
    if (vault) items.push({ label: 'Lock vault', click: () => lockVault() });
    items.push({ type: 'separator' });
    items.push({ label: 'Quit cobrowser', click: () => app.quit() });
    tray.setContextMenu(Menu.buildFromTemplate(items));
  };
  refresh();
  setInterval(refresh, 2000);
  return tray;
}

app.whenReady().then(async () => {
  debugWsEndpoint = await readDebugEndpoint();
  const token = crypto.randomBytes(24).toString('hex');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.searchParams.get('token') !== token) { ws.close(4001, 'unauthorized'); return; }
    const state = { workspace: undefined };
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      handle(ws, state, m).catch((e) => log('handle', m.type, e));
    });
    ws.on('close', () => state.workspace?.detach(ws));
  });
  wss.on('listening', () => {
    const { port } = wss.address();
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ wsPort: port, token, debugWs: debugWsEndpoint, pid: process.pid, version: VERSION, webauthn: !!WEBAUTHN_GROUP }),
      { mode: 0o600 },
    );
    log(`cobrowser app ${VERSION}: ws://127.0.0.1:${port}, debug ${debugWsEndpoint}, data ${DATA_DIR}`);
  });
  try {
    globalThis.tray = makeTray(); // keep a reference or the menu-bar item is collected
    log('tray: created');
  } catch (e) {
    log('tray: failed', e);
  }
  if (process.env.COBROWSER_OPEN_VAULT === '1') openVaultWindow(); // dev/test: open it without a tray click
  app.on('will-quit', () => { try { if (JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(STATE_FILE); } catch { /* fine */ } });
});

app.on('window-all-closed', () => { /* menu-bar app: stay alive with zero tabs */ });
