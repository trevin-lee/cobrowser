// cobrowser browser service. Owns every workspace's browser tabs as OFFSCREEN webContents,
// streams their frames to the editor, and runs the editor's DevTools-protocol commands on
// each tab's own in-process debugger — no remote debugging port is ever opened.
//
// Offscreen means rendered into GPU memory with no OS window: nothing for macOS to hide,
// minimize or clamp, which is what stalled every window-based design. The process outlives
// editor windows, so a reload no longer restarts the browser or drops session cookies.
//
// Wire protocol, one WebSocket per editor window (authenticated by the token in app.json):
//   -> {type:'hello', workspace}                       <- {type:'hello', version, tabs:[...]}
//   -> {type:'cdp', tabId, method, params}              <- {result} | {error}   (the tab's debugger)
//   -> {type:'navigate', tabId, kind, url, timeout}     <- {url, title, error?, timedOut?}
//   -> {type:'console'|'network', tabId, since, ...}     <- {entries, latest}
//   <- {type:'tabUpdated', tabId, url, title} on navigation / title change
//   -> {type:'openTab', url, width, height}            <- {type:'tab', tabId, url, title}
//   -> {type:'closeTab'|'resize'|'subscribe'|'unsubscribe', tabId, ...}
//   -> {type:'closeAll'}                               (this workspace's tabs)
//   <- binary frame  [u32 metaLen][meta JSON][jpeg]    meta.tabId says which tab
//   <- {type:'tab', ...} for tabs the page opened itself; {type:'tabClosed', tabId}
const { app, BrowserWindow, Tray, Menu, nativeImage, session, safeStorage, systemPreferences, ipcMain, dialog, Notification, shell } = require('electron');
const { WebSocketServer } = require('ws');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseSite, siteMatches, siteLabel } = require('./site.js');
const identity = require('./identity.js');
const { TabLog } = require('./capture.js');
const { checkParams } = require('./protocolGuard.js');

// Overridable so tests can run a second instance beside the real one without clobbering its state.
const STATE_DIR = process.env.COBROWSER_STATE_DIR || path.join(os.homedir(), '.cobrowser');
const STATE_FILE = path.join(STATE_DIR, 'app.json');
const JPEG_QUALITY = 90; // q80 rings around glyphs; the frame is the thing the human reads
const FRAME_RATE = 60;
/** A tab no panel is showing still runs, but paints once a second: three hidden animated tabs
 *  cost 24% of a core at 60 fps and 1% at 1 (measured). Screenshots raise it briefly. */
const HIDDEN_FRAME_RATE = 1;
const TAB_PRELOAD = path.join(__dirname, 'tab-preload.js');

/** Every tab window's web preferences, popups included (they must match their opener's). */
function tabWebPreferences(partition) {
  return {
    offscreen: true,
    partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    // The preload (page dialogs) runs in every frame; sandboxed, it has no Node either way.
    nodeIntegrationInSubFrames: true,
    preload: TAB_PRELOAD,
  };
}

/** The app is menu-bar only, so macOS does not bring its dialogs forward on its own. */
function focusApp() {
  try { app.focus({ steal: true }); } catch { /* best effort */ }
}

function hostOf(url) {
  try { return new URL(url).host || url; } catch { return url || ''; }
}
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
// One app per data dir. Editor windows race to start the app after a restart (each sees no
// state file for a moment and spawns its own); the lock, keyed on userData, lets exactly one
// live. The loser exits before it has a tray, a socket or a state file.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
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
    // Only the group: passing promptReason aborts Electron 44 at startup (SIGTRAP in Node init).
    app.configureWebAuthn({ touchID: { keychainAccessGroup: WEBAUTHN_GROUP } });
  } catch (e) { console.error('configureWebAuthn failed:', e.message); }
}

// No remote debugging port. The editor drives tabs through THIS process's debugger (the
// `cdp` message below), so nothing else on the machine can attach to the user's sessions
// and the pages are not launched under an automation switch.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.platform === 'darwin') app.dock?.hide(); // menu-bar app, not a Dock app

// ---------------------------------------------------------------------------------------
// Identity: a Chromium browser named Cobrowser, used by a human. The UA, the client hints
// and Accept-Language all say so, in the shape every other Chromium browser uses. It is
// rendered offscreen only because that is how it gets into an editor pane; the screen it
// reports is the real display the pane sits on (sent down with each resize).
// ---------------------------------------------------------------------------------------
const CHROME_FULL = process.versions.chrome;
const USER_AGENT = identity.userAgent(CHROME_FULL, VERSION);
const ACCEPT_LANGUAGES = identity.acceptLanguages(app.getPreferredSystemLanguages ? app.getPreferredSystemLanguages() : ['en-US']);
const UA_METADATA = identity.metadata({ chromeVersion: CHROME_FULL, appVersion: VERSION, osVersion: process.getSystemVersion(), arch: process.arch });

// Site permissions: a real browser asks. Decisions are remembered per origin + permission;
// until asked, a site has nothing (Notification.permission reads "denied", not "granted").
const PERMISSIONS_FILE = path.join(DATA_DIR, 'permissions.json');
const AUTO_ALLOW = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'keyboardLock', 'background-sync']);
const PERMISSION_VERB = { media: 'use your camera or microphone', geolocation: 'know your location', notifications: 'show notifications', midi: 'use MIDI devices', midiSysex: 'use MIDI devices', 'clipboard-read': 'read your clipboard', 'display-capture': 'capture your screen', 'idle-detection': 'know when you are idle', openExternal: 'open another application', hid: 'use a HID device', serial: 'use a serial port', usb: 'use a USB device', 'window-management': 'manage windows', 'speaker-selection': 'choose an audio output', 'storage-access': 'use its cookies while embedded', 'top-level-storage-access': 'use its cookies while embedded', 'deprecated-sync-clipboard-read': 'read your clipboard' };
let permissions = null;
function loadPermissions() {
  if (!permissions) { try { permissions = JSON.parse(fs.readFileSync(PERMISSIONS_FILE, 'utf8')); } catch { permissions = {}; } }
  return permissions;
}
function permissionKey(origin, permission, details) {
  const kind = details?.mediaTypes?.slice().sort().join('+') || details?.mediaType || '';
  return `${origin}|${permission}${kind ? ':' + kind : ''}`;
}
function permissionDecision(origin, permission, details) {
  return loadPermissions()[permissionKey(origin, permission, details)];
}
function rememberPermission(origin, permission, details, allowed) {
  loadPermissions()[permissionKey(origin, permission, details)] = allowed;
  try { fs.writeFileSync(PERMISSIONS_FILE, JSON.stringify(permissions, null, 2)); } catch { /* best effort */ }
}
const pendingPermission = new Map(); // key -> Promise<boolean>, so one dialog serves parallel asks
function askPermission(origin, permission, details) {
  const key = permissionKey(origin, permission, details);
  if (pendingPermission.has(key)) return pendingPermission.get(key);
  const kind = details?.mediaTypes ? details.mediaTypes.join(' and ') : '';
  const verb = permission === 'media' && kind ? `use your ${kind.replace('video', 'camera').replace('audio', 'microphone')}` : PERMISSION_VERB[permission] || `use "${permission}"`;
  let host = origin; try { host = new URL(origin).host; } catch { /* keep */ }
  focusApp();
  const p = dialog.showMessageBox({ type: 'question', message: `${host} wants to ${verb}`, detail: 'cobrowser remembers this choice for the site.', buttons: ['Allow', 'Block'], defaultId: 1, cancelId: 1 })
    .then(({ response }) => { const ok = response === 0; rememberPermission(origin, permission, details, ok); return ok; })
    .catch(() => false)
    .finally(() => pendingPermission.delete(key));
  pendingPermission.set(key, p);
  return p;
}

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
// Test-only: an isolated instance has nobody to answer page dialogs ('accept' | 'dismiss').
const TEST_DIALOG = SKIP_BIOMETRICS ? process.env.COBROWSER_TEST_DIALOG : undefined;
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

// One-time grants from the request dialog ("Allow once"): entry id + workspace, consumed by
// the next successful fill. Never persisted — they die with the app.
const oneTimeGrants = new Set();
const grantKey = (entry, workspaceId) => `${entry.id}|${workspaceId}`;
function usable(entry, workspaceId) {
  return allowed(entry, workspaceId) || oneTimeGrants.has(grantKey(entry, workspaceId));
}

// Test-only: an isolated instance has nobody to answer the dialog. Never set in normal use.
const TEST_GRANT = SKIP_BIOMETRICS ? process.env.COBROWSER_TEST_GRANT : undefined;

/**
 * The agent in a workspace asks to use a login it is not scoped for. The human decides in a
 * native dialog; the agent learns only the outcome. A login that does not exist and a login
 * the human denies look the same to the agent, so a workspace still cannot enumerate what
 * other workspaces hold.
 */
async function requestCredential(workspaceId, { site, username, reason }) {
  const v = await unlockVault('grant a login to a workspace');
  const page = parseSite(String(site || ''));
  if (!page.host) return { granted: 'denied', error: 'site is required' };
  const label = siteLabel(page);
  let matches = v.entries.filter((e) => siteMatches(e, page));
  if (username) matches = matches.filter((e) => e.username === username);
  const already = matches.find((e) => allowed(e, workspaceId));
  if (already) return { granted: 'already', host: label, username: already.username };
  if (matches.length === 0) return { granted: 'denied', error: `no login for ${label} was granted` };
  const name = path.basename(workspaceId) || workspaceId;
  const why = reason ? `Reason given: ${String(reason).slice(0, 300)}` : 'No reason given.';
  let entry = matches[0];
  let mode; // 'workspace' | 'once' | 'denied'
  if (TEST_GRANT) {
    log(`vault: TEST MODE — request for ${label} auto-answered "${TEST_GRANT}"`);
    mode = TEST_GRANT === 'workspace' || TEST_GRANT === 'once' ? TEST_GRANT : 'denied';
  } else if (matches.length === 1) {
    focusApp();
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: `The agent in "${name}" asks to use ${entry.username || 'the login'} on ${label}`,
      detail: `${why}

Allowing lets that workspace's agent fill this login into the page; it never sees the password. Workspace: ${workspaceId}`,
      buttons: ['Allow in this workspace', 'Allow once', 'Deny'], defaultId: 2, cancelId: 2,
    });
    mode = response === 0 ? 'workspace' : response === 1 ? 'once' : 'denied';
  } else {
    const names = matches.slice(0, 3).map((e) => e.username || '(no username)');
    focusApp();
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: `The agent in "${name}" asks to use a login on ${label} — which one?`,
      detail: `${why}

Choosing one allows it in this workspace from now on; the agent never sees the password. Workspace: ${workspaceId}`,
      buttons: [...names, 'Deny'], defaultId: names.length, cancelId: names.length,
    });
    if (response < names.length) { entry = matches[response]; mode = 'workspace'; } else mode = 'denied';
  }
  if (mode === 'workspace') {
    entry.scope = normalizeScope([...(entry.scope === 'all' ? [] : entry.scope), workspaceId]);
    saveVault();
  } else if (mode === 'once') {
    oneTimeGrants.add(grantKey(entry, workspaceId));
  }
  log(`vault: request from ${name} for ${entry.username} on ${label}: ${mode}`);
  if (mode === 'denied') return { granted: 'denied', error: `no login for ${label} was granted` };
  return { granted: mode, host: label, username: entry.username };
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
  let matches = v.entries.filter((e) => usable(e, tab.workspace.id) && siteMatches(e, page));
  if (username) matches = matches.filter((e) => e.username === username);
  if (matches.length === 0) return { filled: [], error: `no saved login for ${host}` };
  if (matches.length > 1) return { filled: [], error: 'several logins match — pass username', candidates: matches.map((e) => e.username) };
  const entry = matches[0];
  const dbg = tab.win.webContents.debugger;
  const filled = [];
  for (const [uid, value, label] of [[usernameUid, entry.username, 'username'], [passwordUid, entry.password, 'password']]) {
    if (!uid || !value) continue;
    const { result } = await dbg.sendCommand('Runtime.evaluate', {
      expression: `(() => { const sel = '[data-cobrowser-uid=${JSON.stringify(String(uid))}]'; let el = document.querySelector(sel); const visit = (root, d) => { for (const n of root.querySelectorAll('*')) { if (el) return; if (n.shadowRoot) { el = n.shadowRoot.querySelector(sel); if (!el && d < 8) visit(n.shadowRoot, d + 1); } } }; if (!el) visit(document, 0); if (!el) return false; el.focus(); if (el.select) el.select(); return true; })()`,
      returnByValue: true,
    });
    if (!result.value) return { filled, error: `uid ${uid} not found — take a fresh snapshot` };
    await dbg.sendCommand('Input.insertText', { text: value }); // trusted keystrokes, never page JS
    filled.push(label);
  }
  if (filled.length) oneTimeGrants.delete(grantKey(entry, tab.workspace.id)); // a one-time grant is spent
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

// ---------------------------------------------------------------------------------------
// Page dialogs (alert / confirm / prompt), sent by app/tab-preload.js. The page is paused on
// a synchronous IPC until the human answers, exactly as it would be on Chromium's own dialog.
// ---------------------------------------------------------------------------------------
function tabOf(contents) {
  for (const w of workspaces.values()) for (const t of w.tabs.values()) if (!t.win.isDestroyed() && t.win.webContents === contents) return t;
  return undefined;
}

async function answerPageDialog({ type, message, def }, origin) {
  if (TEST_DIALOG !== undefined) {
    const yes = TEST_DIALOG === 'accept';
    log(`dialog: TEST MODE — ${type} "${message}" answered ${yes ? 'accept' : 'dismiss'}`);
    return type === 'confirm' ? yes : type === 'prompt' ? (yes ? `${def}` || 'test answer' : null) : undefined;
  }
  focusApp();
  if (type === 'prompt') return promptWindow(origin, message, def);
  const { response } = await dialog.showMessageBox({
    type: type === 'confirm' ? 'question' : 'info',
    message: `${origin} says`,
    detail: message,
    buttons: type === 'confirm' ? ['OK', 'Cancel'] : ['OK'],
    defaultId: 0,
    cancelId: type === 'confirm' ? 1 : 0,
  });
  return type === 'confirm' ? response === 0 : undefined;
}

/** prompt(): macOS has no text-input alert, so a small window of the app's own. */
function promptWindow(origin, message, def) {
  return new Promise((resolve) => {
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const html = `<!doctype html><meta charset="utf-8"><title>${esc(origin)} says</title>
<style>:root{color-scheme:light dark}body{font:13px -apple-system,system-ui;margin:18px 20px}p{margin:0 0 12px;white-space:pre-wrap}
input{width:100%;box-sizing:border-box;font:inherit;padding:5px 7px}div{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}button{font:inherit;padding:4px 14px}</style>
<p>${esc(message)}</p><form id="f"><input id="i" value="${esc(def)}"><div><button type="button" id="c">Cancel</button><button>OK</button></div></form>
<script>const i=document.getElementById('i');i.focus();i.select();
document.getElementById('f').onsubmit=(e)=>{e.preventDefault();document.title='ok:'+i.value};
document.getElementById('c').onclick=()=>{document.title='cancel'};
addEventListener('keydown',(e)=>{if(e.key==='Escape')document.title='cancel'});</script>`;
    const win = new BrowserWindow({ width: 440, height: 190, show: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, alwaysOnTop: true, title: `${origin} says`, webPreferences: { sandbox: true, contextIsolation: true } });
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; resolve(v); if (!win.isDestroyed()) win.close(); };
    win.on('page-title-updated', (e, title) => { e.preventDefault(); if (title.startsWith('ok:')) finish(title.slice(3)); else if (title === 'cancel') finish(null); });
    win.on('closed', () => finish(null));
    win.once('ready-to-show', () => { focusApp(); win.show(); });
    void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

ipcMain.on('cobrowser:dialog', async (e, d) => {
  const tab = tabOf(e.sender);
  const origin = hostOf((e.senderFrame && e.senderFrame.url) || e.sender.getURL()) || 'This page';
  const fallback = d && d.type === 'confirm' ? false : d && d.type === 'prompt' ? null : undefined;
  if (!d || !['alert', 'confirm', 'prompt'].includes(d.type)) { e.returnValue = fallback; return; }
  if (tab) tab.pendingDialogs++;
  try {
    e.returnValue = await answerPageDialog(d, origin);
  } catch (err) {
    log(`dialog: ${err.message}`);
    e.returnValue = fallback;
  } finally {
    if (tab) tab.pendingDialogs--;
  }
});

/** "report.txt", then "report (1).txt", … — never overwrite a download. */
function uniquePath(dir, name) {
  const safe = (name || 'download').replace(/[\\/:]/g, '_');
  const ext = path.extname(safe), stem = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

/** The page's own frame in Tab.frameOwners (the page has no session id). */
const ROOT_FRAME = '(page)';

const workspaces = new Map(); // workspace path -> Workspace
let nextTabId = 1;

class Tab {
  constructor(workspace, opts) {
    const { url, width, height } = opts;
    this.workspace = workspace;
    this.id = `t${nextTabId++}`;
    this.subscribers = new Set(); // sockets receiving frames
    this.opener = opts.opener;
    /** Who opened the tab ('agent' | 'human'), so the agent's own tabs stay its own to tidy
     *  up after an editor reload. */
    this.by = opts.by === 'agent' ? 'agent' : 'human';
    this.log = new TabLog();
    /** Out-of-process iframe sessions, by frame id (see routePoint). */
    this.frameSessions = new Map();
    /** For each frame session (ROOT for the page): its out-of-process child frames, by the
     *  backend node id of the <iframe> element that owns each. */
    this.frameOwners = new Map();
    /** The human's input, waiting to be routed. See queueHuman. */
    this.inputQueue = [];
    this.inputPumping = false;
    /** The frame session keys and text go to (where the last click landed), and the one the
     *  pointer is over, so it can be told when the pointer leaves. undefined = the page. */
    this.inputSession = undefined;
    this.hoverSession = undefined;
    /** Page dialogs and file pickers shown to the human right now (the page waits on them). */
    this.pendingDialogs = 0;
    /** Recent renderer crashes, so a page that keeps crashing is not reloaded forever. */
    this.crashes = [];
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
      webPreferences: tabWebPreferences(workspace.partition),
    });
    const wc = this.win.webContents;
    wc.setFrameRate(HIDDEN_FRAME_RATE); // until a panel shows it — see setWatched
    // Everything the tab's debugger sees goes into the tab's log (console + requests), from
    // the page and from its out-of-process frames alike.
    wc.debugger.on('message', (_e, method, params, sessionId) => {
      if (method === 'Target.attachedToTarget') return this.onFrameAttached(params, sessionId);
      if (method === 'Target.detachedFromTarget') return this.onFrameDetached(params);
      if (method === 'Page.fileChooserOpened') return void this.chooseFiles(params, sessionId || undefined);
      // Request ids are per renderer; keep a frame's apart from the page's.
      const p = sessionId && params && params.requestId ? { ...params, requestId: `${sessionId}:${params.requestId}` } : params;
      this.log.onEvent(method, p, wc.getURL());
    });
    // A DevTools window would take the session away from us; refuse it. Everything DevTools
    // shows is available through the log and the `cdp` channel anyway.
    wc.on('devtools-opened', () => { log(`tab ${this.id}: DevTools refused`); wc.closeDevTools(); });
    // Renderer crash / process swap / anything else that drops the session: come back.
    wc.debugger.on('detach', (_e, reason) => {
      if (wc.isDestroyed()) return;
      log(`tab ${this.id}: debugger detached (${reason}); reattaching`);
      setTimeout(() => { if (!wc.isDestroyed()) this.attachDebugger(); }, 150);
    });
    this.ready = this.attachDebugger();
    wc.on('paint', (_e, _dirty, image) => this.onPaint(image));
    // Chromium forgets the zoom factor on cross-origin navigation; the panel's scale must not.
    wc.on('did-navigate', () => this.applyZoom());
    // Keep the editor's URL bar, tab title and activity log in step with the page.
    const announce = () => workspace.broadcast({ type: 'tabUpdated', ...this.info() });
    wc.on('did-navigate', announce);
    wc.on('did-navigate-in-page', (_e, _u, isMain) => { if (isMain) announce(); });
    wc.on('page-title-updated', announce);
    // A page opening a window.
    //  - A popup window (window.open with a size) is how "Sign in with Google" and payment
    //    checks open, and it must keep window.opener to report back. Electron cannot render a
    //    window.open popup offscreen (measured: it never paints), so it opens as a real small
    //    window on the desktop, as it would in Chrome, and closes itself when done.
    //  - Everything else (target=_blank links) becomes a tab in the editor, as before.
    wc.setWindowOpenHandler((details) => {
      if (details.disposition === 'new-window') {
        return { action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { ...tabWebPreferences(workspace.partition), offscreen: false } } };
      }
      const [w, h] = this.win.getContentSize();
      const t = workspace.openTab({ url: details.url, width: w, height: h, opener: this.id });
      void t.ready.then(() => workspace.broadcast({ type: 'tab', ...t.info(), url: details.url }));
      return { action: 'deny' };
    });
    wc.on('did-create-window', (child, details) => {
      log(`tab ${this.id}: popup window for ${hostOf(details.url)}`);
      let shown = false;
      const show = () => { if (shown || child.isDestroyed()) return; shown = true; child.center(); focusApp(); child.show(); };
      child.once('ready-to-show', show);
      setTimeout(show, 1500); // a popup that never signals ready still appears
    });
    // A crashed page comes back by itself — unless it keeps crashing.
    wc.on('render-process-gone', (_e, d) => {
      log(`tab ${this.id}: page process gone (${d.reason})`);
      if (d.reason === 'clean-exit' || wc.isDestroyed()) return;
      const now = Date.now();
      this.crashes = this.crashes.filter((at) => now - at < 60000);
      if (this.crashes.length >= 3) { log(`tab ${this.id}: crashed 3 times in a minute; leaving it for a manual reload`); return; }
      this.crashes.push(now);
      setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 400);
    });
    // "Leave site? Changes you made may not be saved." Without a handler the navigation was
    // silently cancelled. The answer has to be given synchronously.
    wc.on('will-prevent-unload', (event) => {
      const leave = TEST_DIALOG !== undefined
        ? TEST_DIALOG === 'accept'
        : (focusApp(), dialog.showMessageBoxSync({ type: 'question', message: 'Leave this site?', detail: `${hostOf(wc.getURL())}: changes you made may not be saved.`, buttons: ['Leave', 'Stay'], defaultId: 1, cancelId: 1 }) === 0);
      if (leave) event.preventDefault();
    });
    wc.on('destroyed', () => workspace.onTabGone(this));
    this.win.on('closed', () => workspace.onTabGone(this));
    void wc.loadURL(url || 'about:blank');
  }

  /** Paint at full rate while a panel shows the tab or something is acting on it, once a
   *  second otherwise. */
  setWatched() {
    const wc = this.win.webContents;
    if (wc.isDestroyed()) return;
    wc.setFrameRate(this.subscribers.size || this.boostTimer ? FRAME_RATE : HIDDEN_FRAME_RATE);
  }

  /**
   * Something is acting on this tab (the agent, a screenshot, input): full rate until it has
   * been quiet for 3 s, whether or not a panel shows it. A tab only handles input when it
   * draws a frame, so at 1 fps an agent's click on a hidden tab took 14 s (measured).
   */
  boost() {
    clearTimeout(this.boostTimer);
    this.boostTimer = setTimeout(() => { this.boostTimer = undefined; this.setWatched(); }, 3000);
    this.setWatched();
  }

  /**
   * A page asked for a file. The picker is intercepted (Page.setInterceptFileChooserDialog):
   * Chromium's own is a sheet on the hidden tab window and pulled it onto the desktop. The app
   * shows the picker itself and hands the files to the <input>.
   */
  async chooseFiles({ mode, backendNodeId }, sessionId) {
    let files;
    const test = SKIP_BIOMETRICS ? process.env.COBROWSER_TEST_UPLOAD : undefined;
    if (test !== undefined) {
      files = test ? [test] : [];
    } else {
      const host = hostOf(this.win.webContents.getURL());
      this.pendingDialogs++;
      try {
        focusApp();
        const r = await dialog.showOpenDialog({ title: `Upload to ${host}`, message: `${host} asks for ${mode === 'selectMultiple' ? 'files' : 'a file'}`, buttonLabel: 'Upload', properties: mode === 'selectMultiple' ? ['openFile', 'multiSelections'] : ['openFile'] });
        files = r.canceled ? [] : r.filePaths;
      } finally {
        this.pendingDialogs--;
      }
    }
    if (!files.length) return;
    await this.win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { files, backendNodeId }, sessionId).catch((e) => log(`tab ${this.id}: upload: ${e.message}`));
  }

  /** Attach the in-process debugger and put every per-session override in place: identity,
   *  focus emulation, the domains the log listens to, and the screen the pane sits on. */
  async attachDebugger() {
    const wc = this.win.webContents;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    } catch (e) { log(`tab ${this.id}: debugger attach failed: ${e.message}`); return; }
    const send = (method, params) => wc.debugger.sendCommand(method, params).catch((e) => log(`tab ${this.id}: ${method}: ${e.message}`));
    // The client hints (Sec-CH-UA*, navigator.userAgentData) have no session-level API;
    // they ride on the page's own debugger session, together with the UA it must match.
    await send('Emulation.setUserAgentOverride', { userAgent: USER_AGENT, acceptLanguage: ACCEPT_LANGUAGES, platform: 'MacIntel', userAgentMetadata: UA_METADATA });
    // An offscreen page is never focused as far as Chromium knows, which breaks
    // navigator.clipboard.writeText ("Document is not focused") and anything else gated on
    // focus. Emulate it: the panel IS what the human is looking at.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await send('Runtime.enable', {});
    await send('Log.enable', {});
    await send('Network.enable', {});
    // File pickers come to the app instead of opening as a sheet on the hidden window.
    await send('Page.enable', {});
    await send('Page.setInterceptFileChooserDialog', { enabled: true });
    // Cross-origin iframes (video players, embeds, sign-in widgets) run in their own renderer
    // process, and offscreen, input sent to the page never reaches them (measured: a click on
    // a button in one is lost; same-origin iframes are fine). Attach to each one as its own
    // session so human input can be delivered to it directly — see routePoint.
    this.frameSessions.clear();
    this.frameOwners.clear();
    this.inputSession = this.hoverSession = undefined;
    await send('DOM.enable', {});
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const screenKey = this.screenKey; this.screenKey = undefined;
    if (this.lastScreen) this.applyScreen(this.lastScreen); else this.screenKey = screenKey;
  }

  /** Navigate and settle: resolves once the new document's DOM is ready (or an in-page
   *  navigation happened), with the load error if there was one, or timedOut. */
  navigate(kind, url, timeout = 30000) {
    const wc = this.win.webContents;
    return new Promise((resolve) => {
      let done = false;
      const finish = (extra) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        wc.off('dom-ready', ok); wc.off('did-navigate-in-page', inPage); wc.off('did-fail-load', fail);
        resolve({ url: wc.isDestroyed() ? '' : wc.getURL(), title: wc.isDestroyed() ? '' : wc.getTitle(), ...extra });
      };
      const ok = () => finish({});
      const inPage = (_e, _u, isMain) => { if (isMain) finish({}); };
      // -3 is ERR_ABORTED: a navigation superseded by another, or a download — not a failure.
      const fail = (_e, code, desc, _u, isMain) => { if (isMain && code !== -3) finish({ error: `${desc || 'load failed'} (${code})` }); };
      wc.on('dom-ready', ok); wc.on('did-navigate-in-page', inPage); wc.on('did-fail-load', fail);
      const timer = setTimeout(() => finish({ timedOut: true }), timeout);
      try {
        if (kind === 'url') wc.loadURL(url).catch(() => undefined); // failures arrive as did-fail-load
        else if (kind === 'reload') wc.reload();
        else {
          const h = wc.navigationHistory;
          const can = kind === 'back' ? h.canGoBack() : h.canGoForward();
          if (!can) return finish({ noop: true });
          if (kind === 'back') h.goBack(); else h.goForward();
        }
      } catch (e) { finish({ error: e.message }); }
    });
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
      if (ws.readyState !== ws.OPEN) { this.subscribers.delete(ws); this.setWatched(); continue; }
      // Never queue frames behind a slow socket: skip this one, the next paint is newer anyway.
      if (ws.bufferedAmount > 2 * 1024 * 1024) continue;
      ws.send(frame, { binary: true });
    }
  }

  resize(cssW, cssH, scale = 1, zoom = 1, screen) {
    this.layout = { cssW: Math.max(50, Math.round(cssW)), cssH: Math.max(50, Math.round(cssH)), scale: Math.max(1, Number(scale) || 1), zoom: Math.max(0.25, Number(zoom) || 1) };
    const w = Math.round(this.layout.cssW * this.layout.scale), h = Math.round(this.layout.cssH * this.layout.scale);
    const [cw, ch] = this.win.getContentSize();
    if (cw !== w || ch !== h) this.win.setContentSize(w, h);
    this.applyZoom();
    this.applyScreen(screen);
  }

  /** Report the display the pane is actually on. Offscreen, Chromium would otherwise
   *  claim a "screen" exactly the size of the viewport at 0,0 — a headless signature and
   *  simply untrue. Viewport fields stay 0 = untouched; only the screen is described. */
  applyScreen(screen) {
    if (!screen || !(screen.width > 0 && screen.height > 0)) return;
    this.lastScreen = screen;
    const key = `${screen.width}x${screen.height}@${screen.x | 0},${screen.y | 0}`;
    if (key === this.screenKey) return;
    this.screenKey = key;
    this.win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 0, height: 0, deviceScaleFactor: 0, mobile: false,
      screenWidth: Math.round(screen.width), screenHeight: Math.round(screen.height),
      // Chromium rejects a position off the screen ("View position should be on the screen"),
      // which dropped the whole override; keep it on the display.
      positionX: Math.min(Math.max(0, Math.round(screen.x || 0)), Math.round(screen.width)),
      positionY: Math.min(Math.max(0, Math.round(screen.y || 0)), Math.round(screen.height)),
    }).catch((e) => log(`screen: ${e.message}`));
  }

  applyZoom() {
    const wc = this.win.webContents;
    if (wc.isDestroyed()) return;
    const zf = this.layout.scale * this.layout.zoom;
    if (Math.abs(wc.getZoomFactor() - zf) > 0.001) wc.setZoomFactor(zf);
  }

  /**
   * A native <select> under a human click. Chromium draws a select's dropdown as a separate
   * popup widget (on macOS a native menu attached to the window), and an offscreen window
   * has nowhere to put it: the click focuses the select and nothing appears (measured — no
   * popup pixels, and keyboard selection is dead too). So the app shows a native menu at
   * the cursor itself and applies the choice to the page. x/y are page CSS px.
   */
  async selectAt(x, y, sessionId) {
    this.selectSession = sessionId;
    const { result } = await this.win.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const el = document.elementFromPoint(${Number(x) || 0}, ${Number(y) || 0});
        const s = el && el.closest ? el.closest('select') : null;
        if (!s || s.disabled || s.multiple || s.size > 1) return null;
        window.__cobrowserSelect = s;
        const items = [];
        for (const node of s.children) {
          if (node.tagName === 'OPTGROUP') {
            items.push({ group: node.label || '' });
            for (const o of node.children) if (o.tagName === 'OPTION') items.push({ text: o.text, disabled: o.disabled || node.disabled, selected: o.selected, index: o.index });
          } else if (node.tagName === 'OPTION') items.push({ text: node.text, disabled: node.disabled, selected: node.selected, index: node.index });
        }
        s.focus();
        const r = s.getBoundingClientRect();
        return { items, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
      })()`,
      returnByValue: true,
    }, sessionId);
    return result.value || null;
  }

  /** Apply a menu choice: set the option and fire the events frameworks listen for. */
  chooseOption(index) {
    return this.win.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: `(() => { const s = window.__cobrowserSelect; if (!s) return false; s.selectedIndex = ${Number(index)}; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
      returnByValue: true,
    }, this.selectSession).catch(() => undefined);
  }

  /** A new out-of-process frame: remember its session, which <iframe> element in its parent
   *  owns it (so routing can recognise it with one lookup), and give it what the page has. */
  onFrameAttached({ sessionId, targetInfo }, parentSessionId) {
    if (!targetInfo || targetInfo.type !== 'iframe') return;
    this.frameSessions.set(targetInfo.targetId, sessionId);
    const dbg = this.win.webContents.debugger;
    const parentKey = parentSessionId || ROOT_FRAME;
    // The page's own session arrives as '' in the message event, which sendCommand rejects.
    dbg.sendCommand('DOM.getFrameOwner', { frameId: targetInfo.targetId }, parentSessionId || undefined).then((r) => {
      if (!this.frameSessions.has(targetInfo.targetId)) return; // gone already
      if (!this.frameOwners.has(parentKey)) this.frameOwners.set(parentKey, new Map());
      this.frameOwners.get(parentKey).set(r.backendNodeId, sessionId);
    }).catch((e) => log(`tab ${this.id}: no owner for frame ${targetInfo.url}: ${e.message}`));
    const send = (method, params) => dbg.sendCommand(method, params, sessionId).catch(() => undefined);
    void send('Emulation.setUserAgentOverride', { userAgent: USER_AGENT, acceptLanguage: ACCEPT_LANGUAGES, platform: 'MacIntel', userAgentMetadata: UA_METADATA });
    void send('Emulation.setFocusEmulationEnabled', { enabled: true });
    void send('Runtime.enable', {});
    void send('Log.enable', {});
    void send('Network.enable', {});
    void send('DOM.enable', {});
    void send('Page.enable', {});
    void send('Page.setInterceptFileChooserDialog', { enabled: true });
    // Frames inside frames (an LMS page embedding a tool embedding a player) get the same.
    void send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }

  onFrameDetached({ sessionId }) {
    for (const [frameId, s] of this.frameSessions) if (s === sessionId) this.frameSessions.delete(frameId);
    this.frameOwners.delete(sessionId);
    for (const owners of this.frameOwners.values()) for (const [node, s] of owners) if (s === sessionId) owners.delete(node);
    if (this.inputSession === sessionId) this.inputSession = undefined;
    if (this.hoverSession === sessionId) this.hoverSession = undefined;
  }

  /**
   * Which frame a page point is in, and the point in that frame's coordinates. Walks down
   * through out-of-process iframes: the node under the point is the <iframe> element when the
   * point is over one, and its content box gives the offset into the frame. Cost: nothing on
   * a frame that embeds no out-of-process frames; one lookup when the point is not over one
   * of them; two per level when it is.
   */
  async routePoint(x, y) {
    if (this.frameSessions.size === 0) return { sessionId: undefined, x, y };
    const dbg = this.win.webContents.debugger;
    let sessionId, lx = x, ly = y;
    for (let depth = 0; depth < 6; depth++) {
      const owners = this.frameOwners.get(sessionId || ROOT_FRAME);
      if (!owners || owners.size === 0) break;
      const loc = await dbg.sendCommand('DOM.getNodeForLocation', { x: Math.round(lx), y: Math.round(ly), includeUserAgentShadowDOM: false, ignorePointerEventsNone: true }, sessionId).catch(() => null);
      if (!loc) break;
      const child = owners.get(loc.backendNodeId);
      if (!child) break;
      const box = await dbg.sendCommand('DOM.getBoxModel', { backendNodeId: loc.backendNodeId }, sessionId).catch(() => null);
      if (!box) break;
      lx -= box.model.content[0];
      ly -= box.model.content[1];
      sessionId = child;
    }
    return { sessionId, x: lx, y: ly };
  }

  /**
   * The human's input, in order. Only the ROUTING is serialized; the dispatch is not waited
   * for, because the debugger already runs commands in the order they are sent, and Chromium
   * acknowledges a scroll only once per rendered frame — waiting for each acknowledgement
   * before sending the next backed trackpad scrolling up by over a second (measured).
   *
   * While an event is being routed, scroll and move events that arrive behind it are merged
   * into one (deltas summed, latest position kept), the way browsers coalesce input, so a
   * slow lookup on a busy page never builds a queue.
   */
  queueHuman(method, params) {
    return new Promise((resolve, reject) => {
      const last = this.inputQueue[this.inputQueue.length - 1];
      const mouse = method === 'Input.dispatchMouseEvent';
      if (last && mouse && last.method === method && last.params.type === params.type && (last.params.modifiers || 0) === (params.modifiers || 0)) {
        if (params.type === 'mouseWheel') {
          last.params = { ...params, deltaX: (last.params.deltaX || 0) + (params.deltaX || 0), deltaY: (last.params.deltaY || 0) + (params.deltaY || 0) };
          last.waiters.push({ resolve, reject });
          return;
        }
        if (params.type === 'mouseMoved' && (last.params.buttons || 0) === (params.buttons || 0)) {
          last.params = params;
          last.waiters.push({ resolve, reject });
          return;
        }
      }
      this.inputQueue.push({ method, params, waiters: [{ resolve, reject }] });
      void this.pumpHuman();
    });
  }

  async pumpHuman() {
    if (this.inputPumping) return;
    this.inputPumping = true;
    try {
      while (this.inputQueue.length) {
        const item = this.inputQueue.shift();
        let dispatched;
        try { ({ dispatched } = await this.routeHuman(item.method, item.params)); }
        catch (e) { dispatched = Promise.reject(e); }
        // Settle the callers when the page has the event, without holding up the next one.
        dispatched.then((r) => item.waiters.forEach((w) => w.resolve(r)), (e) => item.waiters.forEach((w) => w.reject(e)));
      }
    } finally {
      this.inputPumping = false;
    }
  }

  /**
   * Route one human event and send it; resolves once it has been SENT, with the dispatch
   * wrapped in an object — an async function returning a bare promise would wait for it. Mouse events go to the frame under the pointer; keys and text go to the frame
   * last clicked, which is where focus is. A click on a native <select> opens the app's menu
   * instead (see selectAt). Agent input never comes here.
   */
  async routeHuman(method, params) {
    const dbg = this.win.webContents.debugger;
    if (method === 'Input.dispatchMouseEvent') {
      const r = await this.routePoint(params.x, params.y);
      if (params.button === 'left' && params.type === 'mousePressed') {
        const sel = await this.selectAt(r.x, r.y, r.sessionId).catch(() => null);
        if (sel) { this.swallowRelease = true; this.popupSelect(sel, { x: r.x, y: r.y }); return { dispatched: Promise.resolve({ selectMenu: true }) }; }
      } else if (params.button === 'left' && params.type === 'mouseReleased' && this.swallowRelease) {
        this.swallowRelease = false;
        return { dispatched: Promise.resolve({ selectMenu: true }) };
      }
      if (params.type === 'mousePressed') this.inputSession = r.sessionId;
      // Leaving a frame: tell it, so its hover state (a player's controls) clears.
      if (this.hoverSession !== r.sessionId) {
        if (this.hoverSession !== undefined) dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: -1, y: -1, button: 'none' }, this.hoverSession).catch(() => undefined);
        this.hoverSession = r.sessionId;
      }
      return { dispatched: dbg.sendCommand(method, { ...params, x: r.x, y: r.y }, r.sessionId) };
    }
    const target = this.inputSession;
    return {
      dispatched: dbg.sendCommand(method, params, target).catch((e) => {
        if (target === undefined) throw e;
        if (this.inputSession === target) this.inputSession = undefined; // that frame went away; the page has focus now
        return dbg.sendCommand(method, params);
      }),
    };
  }

  /** The native menu for a select — the same NSMenu Chrome on macOS uses — anchored the way
   *  Chrome anchors it: at the control's left edge, with the current item lined up over the
   *  control. `click` is where the human clicked, in page CSS px; the cursor is there on
   *  screen, and page px map to screen points by the per-site zoom. */
  popupSelect({ items, rect }, click) {
    // Test-only: an isolated instance has nobody to pick; never set in normal use.
    const pick = SKIP_BIOMETRICS ? process.env.COBROWSER_TEST_SELECT_PICK : undefined;
    if (pick !== undefined) { log(`tab ${this.id}: TEST MODE — select auto-picked ${pick}`); return this.chooseOption(Number(pick)); }
    const template = items.map((it) => it.group !== undefined
      ? { label: it.group || ' ', enabled: false }
      : { label: it.text || ' ', type: 'checkbox', checked: !!it.selected, enabled: !it.disabled, click: () => void this.chooseOption(it.index) });
    if (template.length === 0) return;
    const current = items.findIndex((it) => it.group === undefined && it.selected);
    // A menu needs a window to hang off, and the tab's is offscreen with no screen position.
    // A 1px transparent helper, shown without taking focus, stands in for the control: it is
    // placed where the control's top-left corner is on screen, worked out from the cursor
    // (which is at the click) and the click's offset inside the control.
    const { screen } = require('electron');
    const pt = screen.getCursorScreenPoint();
    const zoom = this.layout.zoom || 1;
    const at = rect && click
      ? { x: Math.round(pt.x - (click.x - rect.left) * zoom), y: Math.round(pt.y - (click.y - rect.top) * zoom) }
      : pt;
    const height = rect ? Math.max(1, Math.round((rect.bottom - rect.top) * zoom)) : 1;
    const helper = new BrowserWindow({ show: false, width: 1, height, x: at.x, y: at.y, frame: false, transparent: true, alwaysOnTop: true, focusable: false, skipTaskbar: true, hasShadow: false });
    helper.showInactive();
    // positioningItem: macOS opens the menu so that item sits over the control, exactly as a
    // pop-up button (and Chrome's select) does.
    Menu.buildFromTemplate(template).popup({ window: helper, x: 0, y: 0, ...(current >= 0 ? { positioningItem: current } : {}), callback: () => { if (!helper.isDestroyed()) helper.close(); } });
  }

  info() {
    const wc = this.win.webContents;
    return { tabId: this.id, url: wc.isDestroyed() ? '' : wc.getURL(), title: wc.isDestroyed() ? '' : wc.getTitle(), by: this.by, ...(this.opener ? { opener: this.opener } : {}) };
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
    ses.setUserAgent(USER_AGENT, ACCEPT_LANGUAGES);
    // Downloads go straight to the Downloads folder, like any browser. Without this Electron
    // asks where to save with a sheet on the hidden tab window, pulling it onto the desktop.
    ses.on('will-download', (_e, item) => {
      const dir = process.env.COBROWSER_DOWNLOADS_DIR || app.getPath('downloads');
      const target = uniquePath(dir, item.getFilename());
      item.setSavePath(target);
      log(`download: ${item.getURL()} -> ${target}`);
      item.once('done', (_e2, state) => {
        log(`download ${state}: ${target}`);
        if (state !== 'completed' || SKIP_BIOMETRICS || !Notification.isSupported()) return; // no banners from test instances
        const n = new Notification({ title: 'Downloaded', body: path.basename(target), silent: true });
        n.on('click', () => shell.showItemInFolder(target));
        n.show();
      });
    });
    ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
      if (AUTO_ALLOW.has(permission)) return true;
      return permissionDecision(origin, permission, details) === true;
    });
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (AUTO_ALLOW.has(permission)) return callback(true);
      const origin = details?.requestingUrl ? new URL(details.requestingUrl).origin : (wc && !wc.isDestroyed() ? new URL(wc.getURL()).origin : '');
      if (!origin || origin === 'null') return callback(false);
      const decided = permissionDecision(origin, permission, details);
      if (typeof decided === 'boolean') return callback(decided);
      askPermission(origin, permission, details).then(callback, () => callback(false));
    });
    // Several passkeys for one site: without a listener Chromium cancels the request. The
    // page is offscreen, so ask with a native dialog instead of in-page UI.
    try {
      ses.on('select-webauthn-account', (_event, details, callback) => {
        const accounts = details.accounts || details.credentials || [];
        if (accounts.length === 1) return callback(accounts[0].id ?? accounts[0].credentialId ?? accounts[0]);
        const names = accounts.map((a) => a.userName || a.displayName || a.name || String(a.id ?? ''));
        focusApp();
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
    for (const t of this.tabs.values()) if (t.subscribers.delete(ws)) t.setWatched();
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
    ws.send(JSON.stringify({ type: 'hello', version: VERSION, tabs }));
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
        case 'vault.request': {
          if (!state.workspace) return reply({ granted: 'denied', error: 'no workspace' });
          return reply(await requestCredential(state.workspace.id, m));
        }
        case 'vault.scrub': return reply({ text: scrubSecrets(m.text) });
        case 'vault.fill': {
          const tab = state.workspace?.tabs.get(m.tabId);
          if (!tab) return reply({ filled: [], error: 'no such tab in this workspace' });
          tab.boost();
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
    case 'cdp': {
      const t = w.tabs.get(m.tabId);
      const reply = (obj) => ws.send(JSON.stringify({ ...obj, requestId: m.requestId }));
      if (!t || t.win.isDestroyed()) return reply({ error: 'no such tab in this workspace' });
      // Wrong-typed parameters abort the whole process inside Electron's deserializer (see
      // protocolGuard.js), so the hot-path commands are type-checked here first.
      const bad = checkParams(m.method, m.params);
      if (bad) { log(`tab ${t.id}: refused ${bad}`); return reply({ error: bad }); }
      t.boost();
      // The human's input is routed into out-of-process frames and native <select>s, in
      // order, without waiting on each dispatch (see Tab.queueHuman).
      if (m.human && /^Input\./.test(m.method)) {
        try { reply({ result: await t.queueHuman(m.method, m.params || {}) }); } catch (e) { reply({ error: e.message || String(e) }); }
        return;
      }
      // A screenshot wants a fresh frame now, not the next scheduled one.
      if (m.method === 'Page.captureScreenshot') t.win.webContents.invalidate();
      // A command the session never answers must not hang the caller forever.
      let timer;
      const timeout = new Promise((_r, rej) => { timer = setTimeout(() => rej(new Error(`${m.method} did not answer within 20s`)), 20000); });
      let timedOut = false;
      try { reply({ result: await Promise.race([t.win.webContents.debugger.sendCommand(m.method, m.params || {}), timeout.catch((e) => { timedOut = true; throw e; })]) }); }
      catch (e) {
        // The page is waiting on a dialog the human has to answer: that is not a stuck session.
        const waiting = timedOut && t.pendingDialogs > 0;
        const msg = waiting ? 'The page is showing a dialog to the human (a confirm, prompt or file picker); it continues when they answer it.' : (e.message || String(e));
        log(`tab ${t.id}: ${m.method}: ${msg}`);
        reply({ error: msg });
        if (waiting) timedOut = false;
      }
      finally { clearTimeout(timer); }
      // Best effort for a session that stopped answering: detaching fires 'detach', which
      // reattaches a fresh one.
      if (timedOut && !t.win.isDestroyed()) { try { t.win.webContents.debugger.detach(); } catch { /* already gone */ } }
      return;
    }
    case 'navigate': {
      const t = w.tabs.get(m.tabId);
      const reply = (obj) => ws.send(JSON.stringify({ ...obj, requestId: m.requestId }));
      if (!t || t.win.isDestroyed()) return reply({ url: '', title: '', error: 'no such tab in this workspace' });
      t.boost();
      return reply(await t.navigate(m.kind, m.url, Number(m.timeout) || 30000));
    }
    case 'console': {
      const t = w.tabs.get(m.tabId);
      const reply = (obj) => ws.send(JSON.stringify({ ...obj, requestId: m.requestId }));
      if (!t) return reply({ entries: [], latest: 0, error: 'no such tab' });
      return reply(t.log.consoleSince(Number(m.since) || 0, { limit: m.limit, level: m.level }));
    }
    case 'network': {
      const t = w.tabs.get(m.tabId);
      const reply = (obj) => ws.send(JSON.stringify({ ...obj, requestId: m.requestId }));
      if (!t) return reply({ entries: [], latest: 0, pending: 0, error: 'no such tab' });
      return reply(t.log.requestsSince(Number(m.since) || 0, { limit: m.limit, failedOnly: !!m.failedOnly, urlContains: m.urlContains, minStatus: m.minStatus }));
    }
    case 'markTab': { const t = w.tabs.get(m.tabId); if (t) t.by = m.by === 'agent' ? 'agent' : 'human'; return; }
    case 'closeTab': return void w.tabs.get(m.tabId)?.close();
    case 'closeAll': return void w.closeAll();
    case 'resize': return void w.tabs.get(m.tabId)?.resize(m.width, m.height, m.scale, m.zoom, m.screen);
    case 'subscribe': {
      const t = w.tabs.get(m.tabId);
      if (!t) return;
      t.subscribers.add(ws);
      t.setWatched();
      t.win.webContents.invalidate(); // a fresh subscriber wants a frame now, not on next change
      return;
    }
    case 'unsubscribe': {
      const t = w.tabs.get(m.tabId);
      if (t) { t.subscribers.delete(ws); t.setWatched(); }
      return;
    }
  }
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
      JSON.stringify({ wsPort: port, token, pid: process.pid, version: VERSION, build: process.env.COBROWSER_BUILD || '', webauthn: !!WEBAUTHN_GROUP }),
      { mode: 0o600 },
    );
    log(`cobrowser app ${VERSION}: ws://127.0.0.1:${port}, data ${DATA_DIR}`);
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
