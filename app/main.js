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
const { app, BrowserWindow, Tray, Menu, nativeImage, session, safeStorage, systemPreferences, ipcMain, dialog, Notification, shell, clipboard } = require('electron');
const { WebSocketServer } = require('ws');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseSite, siteMatches, siteLabel, isIp } = require('./site.js');
const identity = require('./identity.js');
const { TabLog } = require('./capture.js');
const { checkParams } = require('./protocolGuard.js');
const uploads = require('./uploads.js');
const appMigrations = require('./migrations.js');

// Overridable so tests can run a second instance beside the real one without clobbering its state.
const STATE_DIR = process.env.COBROWSER_STATE_DIR || path.join(os.homedir(), '.cobrowser');
const STATE_FILE = path.join(STATE_DIR, 'app.json');
const JPEG_QUALITY = 90; // q80 rings around glyphs; the frame is the thing the human reads
const FRAME_RATE = 60;
/** A tab no panel is showing still runs, but paints 4 times a second: three hidden animated
 *  tabs cost 24% of a core at 60 fps (measured). The first command to an idle hidden tab waits
 *  for its next frame — up to a second at 1 fps (measured: 130–950 ms, evenly spread), at most
 *  250 ms at 4 — and anything acting on a tab raises it to full rate (see boost). */
const HIDDEN_FRAME_RATE = 4;
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
// state file for a moment and spawns its own). Electron's lock is not enough on its own: two
// copies started in the same instant sometimes both get it (measured: two apps, two ports,
// two menu-bar icons). So a lock file of our own is a second gate — created exclusively, so
// exactly one starter can make it, and holding the owner's pid, so a crashed app's leftover
// file is recognised and cleared. The loser exits before it has a tray, a socket or a state file.
const APP_LOCK = path.join(DATA_DIR, 'app.lock');
function lockOwnerLives(pid) {
  if (!pid) return true; // the owner has created it but not written its pid yet
  try { process.kill(pid, 0); } catch { return false; }
  try {
    // A pid reused by an unrelated process does not count as the owner.
    return require('node:child_process').execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).includes('/app/main.js');
  } catch {
    return false;
  }
}
function acquireAppLock() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(APP_LOCK, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return true; // cannot lock at all: never refuse to start over it
      let pid = 0;
      try { pid = Number(fs.readFileSync(APP_LOCK, 'utf8').trim()) || 0; } catch { continue; } // just released
      if (lockOwnerLives(pid)) return false;
      // Left by an app that is gone. Clear it only if it is still that one (another starter
      // may have cleared and re-made it meanwhile), then try again.
      try { if ((Number(fs.readFileSync(APP_LOCK, 'utf8').trim()) || 0) === pid) fs.unlinkSync(APP_LOCK); } catch { /* raced; retry */ }
    }
  }
  return false;
}
if (!app.requestSingleInstanceLock() || !acquireAppLock()) {
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

// Site permissions: a real browser asks. Decisions are remembered per workspace, origin and
// permission (each workspace is its own browser); until asked, a site has nothing
// (Notification.permission reads "denied", not "granted").
const sitePermissions = require('./site-permissions.js');
const PERMISSIONS_FILE = path.join(DATA_DIR, 'permissions.json');
const AUTO_ALLOW = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'keyboardLock', 'background-sync']);
const PERMISSION_VERB = { media: 'use your camera or microphone', geolocation: 'know your location', notifications: 'show notifications', midi: 'use MIDI devices', midiSysex: 'use MIDI devices', 'clipboard-read': 'read your clipboard', 'display-capture': 'capture your screen', 'idle-detection': 'know when you are idle', openExternal: 'open another application', hid: 'use a HID device', serial: 'use a serial port', usb: 'use a USB device', 'window-management': 'manage windows', 'speaker-selection': 'choose an audio output', 'storage-access': 'use its cookies while embedded', 'top-level-storage-access': 'use its cookies while embedded', 'deprecated-sync-clipboard-read': 'read your clipboard' };
let permissions = null;
function loadPermissions() {
  if (!permissions) {
    let raw = null; try { raw = JSON.parse(fs.readFileSync(PERMISSIONS_FILE, 'utf8')); } catch { /* none yet */ }
    permissions = sitePermissions.load(raw);
  }
  return permissions;
}
function savePermissions() {
  try { fs.writeFileSync(PERMISSIONS_FILE, JSON.stringify(permissions, null, 2)); } catch { /* best effort */ }
}
function permissionDecision(workspaceId, origin, permission, details) {
  return sitePermissions.decision(loadPermissions(), workspaceId, origin, permission, details);
}
function rememberPermission(workspaceId, origin, permission, details, allowed) {
  sitePermissions.remember(loadPermissions(), workspaceId, origin, permission, details, allowed);
  savePermissions();
}
/** What a permission lets a site do, as the ask dialog and the review list say it. */
function permissionVerb(permission, kind) {
  if (permission === 'media' && kind) return `use your ${kind.split('+').map((k) => (k === 'video' ? 'camera' : k === 'audio' ? 'microphone' : k)).join(' and ')}`;
  return PERMISSION_VERB[permission] || `use "${permission}"`;
}
const pendingPermission = new Map(); // key -> Promise<boolean>, so one dialog serves parallel asks
function askPermission(workspaceId, origin, permission, details) {
  const key = `${workspaceId}\n${sitePermissions.permissionKey(origin, permission, details)}`;
  if (pendingPermission.has(key)) return pendingPermission.get(key);
  const verb = permissionVerb(permission, details?.mediaTypes ? details.mediaTypes.join('+') : '');
  let host = origin; try { host = new URL(origin).host; } catch { /* keep */ }
  focusApp();
  // Allow and Block are remembered; dismissing it (Escape, or Not now) denies this once and asks
  // again next time, as Chrome does.
  const p = dialog.showMessageBox({ type: 'question', message: `${host} wants to ${verb}`, detail: `cobrowser remembers Allow or Block for the site in the ${path.basename(workspaceId)} workspace. Not now asks again next time.`, buttons: ['Allow', 'Block', 'Not now'], defaultId: 2, cancelId: 2 })
    .then(({ response }) => { if (response === 2) return false; const ok = response === 0; rememberPermission(workspaceId, origin, permission, details, ok); return ok; })
    .catch(() => false)
    .finally(() => pendingPermission.delete(key));
  pendingPermission.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------------------
// Vault: logins the agent can USE without ever SEEING. Encrypted at rest through the OS
// keychain (safeStorage), unlocked per app session behind Touch ID or the Mac's password, filled straight into
// the page over this process's debugger. Nothing here ever returns a password to a client.
// ---------------------------------------------------------------------------------------
const VAULT_FILE = path.join(DATA_DIR, 'vault.bin');
// The logins themselves live in vault-store.js (pure, tested); these bind it to the open vault.
const store = require('./vault-store.js');
const { normalizeScope, allowed, publicEntry, parseCsv } = store;
const upsertLogin = (site, username, password, scope, opts) => store.upsertLogin(vault, site, username, password, scope, opts);
const updateLogin = (from, fields) => store.updateLogin(vault, from, fields);
const findEntry = (label, username) => store.findEntry(vault, label, username);
const setScope = (host, username, scope) => store.setScope(vault, host, username, scope);
const removeLogin = (host, username) => store.removeLogin(vault, host, username);
const importCsv = (text, scope) => store.importCsv(vault, text, scope);
const exportCsv = () => store.exportCsv(vault);
let vault = null; // { entries: [{ id, host, username, password, updatedAt }] } while unlocked

// Test-only: the UI tests run an isolated instance nobody is sitting at, so they cannot
// answer a Touch ID prompt. Never set in normal use; every skip is logged.
const SKIP_BIOMETRICS = process.env.COBROWSER_TEST_NO_BIOMETRICS === '1';
// Test-only: an isolated instance has nobody to answer page dialogs ('accept' | 'dismiss'),
// certificate warnings ('accept' | 'reject') or login boxes ('user:pass' | '').
const TEST_DIALOG = SKIP_BIOMETRICS ? process.env.COBROWSER_TEST_DIALOG : undefined;
const TEST_CERT = SKIP_BIOMETRICS ? process.env.COBROWSER_TEST_CERT : undefined;
const TEST_LOGIN = SKIP_BIOMETRICS ? process.env.COBROWSER_TEST_LOGIN : undefined;
// The helper that asks macOS for Touch ID or the Mac's password (app/auth, built beside this
// file). Electron's own prompt is Touch ID only, which strands a Mac whose sensor is out of
// reach (a closed lid, a desktop without Apple's Touch ID keyboard).
// In an app bundle of its own, with cobrowser's name and icon, which the Touch ID sheet shows.
const AUTH_HELPER = path.join(__dirname, 'cobrowser-auth.app', 'Contents', 'MacOS', 'cobrowser-auth');
const CONFIRM_TIMEOUT_MS = 60000;

/** Ask through the helper. Resolves true when confirmed, false when the helper cannot be used
 *  here (missing, not runnable, or macOS has no way to ask); rejects when the person declines. */
function askHelper(reason) {
  if (process.platform !== 'darwin' || !fs.existsSync(AUTH_HELPER)) return Promise.resolve(false);
  try { fs.chmodSync(AUTH_HELPER, 0o755); } catch { /* read-only install: try as it is */ }
  return new Promise((resolve, reject) => {
    let err = '';
    let child;
    try { child = require('child_process').spawn(AUTH_HELPER, [reason], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { log('vault: auth helper did not start: ' + e.message); return resolve(false); }
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('no answer to the confirmation')); }, CONFIRM_TIMEOUT_MS);
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); log('vault: auth helper failed: ' + e.message); resolve(false); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(true);
      if (code === 1) return reject(new Error('cancelled'));
      log(`vault: auth helper cannot ask (exit ${code}): ${err.trim()}`);
      resolve(false);
    });
  });
}

/**
 * A person must be there, every time it counts: Touch ID, or the Mac's password when Touch ID
 * is out of reach (macOS offers both, as Safari does before it shows a password). Rejects when
 * they decline. Without the helper (a checkout without Swift), Electron's Touch ID prompt, and
 * failing that a dialog to click. Test instances skip it, logged.
 */
async function confirmPerson(reason) {
  if (SKIP_BIOMETRICS) { log('vault: TEST MODE — confirmation skipped for: ' + reason); return; }
  if (await askHelper(reason)) return;
  if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
    await Promise.race([
      systemPreferences.promptTouchID(reason),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('no answer to the confirmation')), CONFIRM_TIMEOUT_MS)),
    ]);
    return;
  }
  focusApp();
  const { response } = await dialog.showMessageBox({ type: 'question', message: `cobrowser wants to ${reason}`, buttons: ['Allow', 'Cancel'], defaultId: 1, cancelId: 1 });
  if (response !== 0) throw new Error('cancelled');
}

/** When Cobrowser: Fill Card unlocked the vault to list the cards, so the fill that follows
 *  within FILL_UNLOCK_MS does not ask again. */
let fillUnlockAt = 0;
const FILL_UNLOCK_MS = 60000;

/** A fresh confirmation for this one act (a change, showing or exporting passwords), which
 *  also unlocks the vault if it was locked. It never rides on an earlier unlock. */
async function confirmFresh(reason) {
  if (!vault) return void (await unlockVault(reason));
  await confirmPerson(reason);
}

async function unlockVault(reason) {
  if (vault) return vault;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS keychain encryption is unavailable');
  // Read before asking: a vault this key cannot open fails at once, instead of after every
  // Touch ID. What is read is only kept once the person confirms.
  const opened = fs.existsSync(VAULT_FILE) ? readVaultFile() : { entries: [] };
  await confirmPerson(reason || 'unlock the cobrowser vault'); // rejects on cancel/failure
  vault = opened;
  log(`vault: unlocked (${vault.entries.length} logins)`);
  vaultChanged(); // an open vault window shows it unlocked, whoever unlocked it
  return vault;
}
/** The vault file, decrypted. One this Mac's keychain key cannot open (the "cobrowser Safe
 *  Storage" item was deleted or refused) is reported as such, so the window can offer to
 *  start over (vault:startOver) instead of asking for Touch ID again and again. */
const UNREADABLE = 'the vault file cannot be read with this Mac\'s keychain key: open the vault (Cobrowser: Open Vault) to start a new one';
function readVaultFile() {
  try {
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(VAULT_FILE)));
  } catch (e) {
    log(`vault: unreadable: ${e.message}`);
    throw new Error(UNREADABLE);
  }
}

// Test-only: 'accept' or 'deny' answers Start a new vault. Never set in normal use.
const TEST_START_OVER = SKIP_BIOMETRICS ? process.env.COBROWSER_TEST_START_OVER : undefined;

/** Start a new, empty vault in place of one that cannot be read. The old file is kept beside
 *  it, renamed with the date, never deleted: a key that turns up again still opens it. */
async function startOverVault() {
  if (!fs.existsSync(VAULT_FILE)) return { error: 'there is no vault file' };
  try { readVaultFile(); return { error: 'the vault can still be read: unlock it instead' }; } catch { /* unreadable, as it should be */ }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const backup = path.join(DATA_DIR, `vault-unreadable-${stamp}.bin`);
  let ok;
  if (TEST_START_OVER !== undefined) ok = TEST_START_OVER === 'accept';
  else {
    focusApp();
    const { response } = await dialog.showMessageBox(vaultWin && !vaultWin.isDestroyed() ? vaultWin : undefined, {
      type: 'warning',
      message: 'Start a new, empty vault?',
      detail: `The vault cannot be read with this Mac's keychain key, so its logins and cards are out of reach. The file is kept as ${path.basename(backup)} in ${DATA_DIR}, never deleted, and a new, empty vault takes its place. Import your last CSV export to fill it again.`,
      buttons: ['Start a new vault', 'Cancel'], defaultId: 1, cancelId: 1,
    });
    ok = response === 0;
  }
  if (!ok) return { canceled: true };
  fs.renameSync(VAULT_FILE, backup);
  vault = null;
  log(`vault: started over; the unreadable vault is kept as ${backup}`);
  vaultChanged();
  return { ok: true, backup };
}

/** Written whole to a temporary file and renamed over the vault, so a crash, a power cut or a
 *  full disk mid-write leaves the previous vault intact rather than a truncated one. */
function saveVault() {
  const tmp = `${VAULT_FILE}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, safeStorage.encryptString(JSON.stringify(vault)));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, VAULT_FILE);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  vaultChanged();
}

/** After an import: offer to move the plaintext CSV to the Trash. Keep is the default, so Esc
 *  or Return never removes what may be the person's only copy. */
async function offerToTrashCsv(file, message, detail) {
  const { response } = await dialog.showMessageBox(vaultWin, { message, detail, buttons: ['Move the CSV to the Trash', 'Keep'], defaultId: 1, cancelId: 1 });
  if (response === 0) await shell.trashItem(file).catch((e) => log(`vault: could not move ${file} to the Trash: ${e.message}`));
}
function lockVault() {
  vault = null;
  void clearCopiedPassword(); // a password copied from the vault does not outlive its unlock
  oneTimeGrants.clear(); // "Allow once" ends with the unlock it was given under
  log('vault: locked');
  vaultChanged();
}
/** Tell an open vault window what the vault holds now: a grant from an agent's request, a login
 *  added from the editor or a Lock from the menu bar shows there at once, and its next change
 *  starts from the vault as it is. Sends only what the window lists anyway. */
function vaultChanged() {
  if (!vaultWin || vaultWin.isDestroyed()) return;
  vaultWin.webContents.send('vault:changed', vault
    ? { locked: false, logins: vault.entries.map(publicEntry), cards: (vault.cards || []).map(store.publicCard), workspaces: knownWorkspaces() }
    : { locked: true });
}

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
  vaultChanged(); // an open vault window can offer it at once
}


// One-time grants from the request dialog ("Allow once"): entry id + workspace → when it lapses.
// One grant is one sign-in: it is spent when the password is filled, so a sign-in that asks for
// the email first and the password on the next page gets both. Unused, it lapses after ten
// minutes, or when the vault is locked. Never persisted.
const oneTimeGrants = new Map();
const ONE_TIME_GRANT_MS = 10 * 60_000;
const grantKey = (entry, workspaceId) => `${entry.id}|${workspaceId}`;
function hasGrant(entry, workspaceId) {
  const key = grantKey(entry, workspaceId);
  if ((oneTimeGrants.get(key) || 0) > Date.now()) return true;
  oneTimeGrants.delete(key);
  return false;
}
function usable(entry, workspaceId) {
  return allowed(entry, workspaceId) || hasGrant(entry, workspaceId);
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
  let matches = v.entries.filter((e) => store.loginMatches(e, page));
  if (username) matches = matches.filter((e) => e.username === username);
  const already = matches.find((e) => allowed(e, workspaceId));
  if (already) return { granted: 'already', host: label, username: already.username };
  // Asked again before using an "Allow once": that grant still stands, no second dialog.
  const pending = matches.find((e) => hasGrant(e, workspaceId));
  if (pending) return { granted: 'once', host: label, username: pending.username };
  // The same account saved for several of the site's hosts is offered once.
  matches = store.closestPerUsername(matches, page);
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
    // Several logins for the site: pick one, and choose once or from now on, the same
    // choices a single login gets.
    const names = matches.slice(0, 3).map((e) => e.username || '(no username)');
    focusApp();
    const { response, checkboxChecked } = await dialog.showMessageBox({
      type: 'question',
      message: `The agent in "${name}" asks to use a login on ${label} — which one?`,
      detail: `${why}

The agent never sees the password. Workspace: ${workspaceId}`,
      buttons: [...names, 'Deny'], defaultId: names.length, cancelId: names.length,
      checkboxLabel: 'Allow in this workspace from now on (otherwise, just this once)',
      checkboxChecked: false,
    });
    if (response < names.length) { entry = matches[response]; mode = checkboxChecked ? 'workspace' : 'once'; } else mode = 'denied';
  }
  if (mode === 'workspace') {
    entry.scope = normalizeScope([...(entry.scope === 'all' ? [] : entry.scope), workspaceId]);
    saveVault();
  } else if (mode === 'once') {
    oneTimeGrants.set(grantKey(entry, workspaceId), Date.now() + ONE_TIME_GRANT_MS);
  }
  log(`vault: request from ${name} for ${entry.username} on ${label}: ${mode}`);
  if (mode === 'denied') return { granted: 'denied', error: `no login for ${label} was granted` };
  return { granted: mode, host: label, username: entry.username };
}

/** How long confirmed files wait for the picker the agent's click opens. */
const UPLOAD_ARM_MS = 15000;
// Test-only: 'accept' or 'deny' answers the upload confirmation. Never set in normal use.
const TEST_UPLOAD_CONFIRM = SKIP_BIOMETRICS ? process.env.COBROWSER_TEST_UPLOAD_CONFIRM : undefined;

/**
 * The agent asks to upload files from this Mac to the page (upload_file). The paths are
 * checked (uploads.js), the human confirms them in a dialog naming the site, and the tab is
 * armed: the next file picker it opens takes these files instead of asking.
 */
async function confirmUpload(tab, paths, workspaceName, ask = true) {
  const checked = uploads.checkPaths(paths, { home: os.homedir(), refused: [DATA_DIR, STATE_DIR] });
  if (checked.error) return { error: checked.error };
  const host = hostOf(tab.win.webContents.getURL());
  const list = checked.files.map((f) => `${f.shown} (${uploads.formatSize(f.size)})`).join('\n');
  let ok;
  if (!ask) {
    ok = true; // the workspace's cobrowser.uploadsWithoutAsking: the human is told afterwards instead
  } else if (TEST_UPLOAD_CONFIRM !== undefined) {
    log(`upload: TEST MODE — upload to ${host} auto-answered "${TEST_UPLOAD_CONFIRM}"`);
    ok = TEST_UPLOAD_CONFIRM === 'accept';
  } else {
    tab.pendingDialogs++;
    try {
      focusApp();
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: `The agent in "${workspaceName}" asks to upload ${checked.files.length === 1 ? 'a file' : `${checked.files.length} files`} to ${host}`,
        detail: `${list}\n\nAllow only files you mean to send to this site.`,
        buttons: ['Upload', 'Cancel'], defaultId: 1, cancelId: 1,
      });
      ok = response === 0;
    } finally {
      tab.pendingDialogs--;
    }
  }
  log(`upload: ${checked.files.length} file(s) to ${host} from ${workspaceName}: ${!ask ? 'allowed without asking' : ok ? 'allowed' : 'declined'}`);
  if (!ok) return { declined: true, error: 'the human declined the upload' };
  // The human allowed this site; a page that moved to another while they read does not get them.
  const now = hostOf(tab.win.webContents.getURL());
  if (now !== host) return { error: `the page moved from ${host} to ${now} while the human was asked: call upload_file again` };
  tab.armUpload(checked.files.map((f) => f.path), ask ? undefined : workspaceName);
  return { armed: checked.files.map((f) => f.name) };
}



/**
 * Export the vault to a CSV file the human chooses. Every password leaves the keychain's
 * protection here, so it takes a fresh confirmation every time (as showing one password does) and
 * says plainly that the file is plaintext. The passwords are written by the app itself; they
 * never cross to the editor.
 */
async function exportVault(parent) {
  await confirmFresh('export every login in the vault, with its password, to a file');
  let file = SKIP_BIOMETRICS ? process.env.COBROWSER_TEST_EXPORT_PATH : undefined;
  if (!file) {
    focusApp();
    const opts = { title: 'Export logins', defaultPath: path.join(app.getPath('documents'), 'cobrowser-logins.csv'), buttonLabel: 'Export', filters: [{ name: 'CSV', extensions: ['csv'] }], message: 'The file holds every password in plain text. Import it where you need it, then delete it.' + iCloudNote() };
    const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    file = r.filePath;
  }
  fs.writeFileSync(file, exportCsv(), { mode: 0o600 });
  log(`vault: exported ${vault.entries.length} login(s) to ${file}`);
  return { count: vault.entries.length, file };
}

/** When iCloud syncs Desktop & Documents (their contents then live under iCloud Drive's own
 *  folder), a plaintext export saved there is uploaded: the save dialog says so. */
function iCloudNote() {
  const synced = ['Documents', 'Desktop'].filter((d) => fs.existsSync(path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', d)));
  return synced.length ? ` Your ${synced.join(' and ')} folder${synced.length > 1 ? 's sync' : ' syncs'} to iCloud Drive: save it somewhere that does not, or it is uploaded.` : '';
}

/** The cards' backup, the same way: a fresh confirmation, a plaintext file the person chooses. */
async function exportCards(parent) {
  await confirmFresh('export every card in the vault, with its number and security code, to a file');
  let file = SKIP_BIOMETRICS ? process.env.COBROWSER_TEST_EXPORT_PATH : undefined;
  if (!file) {
    focusApp();
    const opts = { title: 'Export cards', defaultPath: path.join(app.getPath('documents'), 'cobrowser-cards.csv'), buttonLabel: 'Export', filters: [{ name: 'CSV', extensions: ['csv'] }], message: 'The file holds every card number and code in plain text. Keep it somewhere safe, or delete it once it is imported.' + iCloudNote() };
    const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    file = r.filePath;
  }
  fs.writeFileSync(file, store.exportCards(vault), { mode: 0o600 });
  const count = (vault.cards || []).length;
  log(`vault: exported ${count} card(s) to ${file}`);
  return { count, file };
}


/** Replace any unlocked password or saved card number that appears in `text` — what keeps
 *  evaluate_script, page text and snapshots from carrying a filled value back to the agent.
 *  A card number is found however a page groups it (4242 4242 4242 4242, 4242-4242-…). A
 *  security code is not scrubbed from free text: three digits would take every such number
 *  with it; snapshots never print a code field's value instead. */
function scrubSecrets(text) {
  if (!vault || typeof text !== 'string') return text;
  let out = text;
  for (const e of vault.entries) {
    if (e.password && e.password.length >= 4 && out.includes(e.password)) out = out.split(e.password).join('••••••••');
  }
  for (const c of vault.cards || []) {
    if (!c.number) continue;
    const grouped = new RegExp('(?<!\\d)' + c.number.split('').join('[ -]?') + '(?!\\d)', 'g');
    out = out.replace(grouped, '•••• •••• •••• ' + c.number.slice(-4));
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
  let matches = v.entries.filter((e) => usable(e, tab.workspace.id) && store.loginMatches(e, page));
  if (username) matches = matches.filter((e) => e.username === username);
  // The same account saved for several of the site's hosts is one login here.
  matches = store.closestPerUsername(matches, page);
  if (matches.length === 0) return { filled: [], error: `no saved login for ${host}` };
  if (matches.length > 1) return { filled: [], error: 'several logins match — pass username', candidates: matches.map((e) => e.username) };
  const entry = matches[0];
  const dbg = tab.win.webContents.debugger;
  const filled = [];
  for (const [uid, value, label] of [[usernameUid, entry.username, 'username'], [passwordUid, entry.password, 'password']]) {
    if (!uid || !value) continue;
    // A password goes only into a password field, which the page draws as dots: typed into a
    // text field it would be on screen, in the agent's next screenshot.
    const { result } = await dbg.sendCommand('Runtime.evaluate', {
      expression: `(() => { const sel = '[data-cobrowser-uid=${JSON.stringify(String(uid))}]'; let el = document.querySelector(sel); const visit = (root, d) => { for (const n of root.querySelectorAll('*')) { if (el) return; if (n.shadowRoot) { el = n.shadowRoot.querySelector(sel); if (!el && d < 8) visit(n.shadowRoot, d + 1); } } }; if (!el) visit(document, 0); if (!el) return 'missing'; if (${label === 'password'} && !(el instanceof HTMLInputElement && el.type === 'password')) return 'not-password'; el.focus(); if (el.select) el.select(); return 'ok'; })()`,
      returnByValue: true,
    });
    if (result.value === 'not-password') return { filled, error: `uid ${uid} is not a password field: the password goes only into one (an input of type password). Pass the password field's uid.` };
    if (result.value !== 'ok') return { filled, error: `uid ${uid} not found — take a fresh snapshot` };
    await dbg.sendCommand('Input.insertText', { text: value }); // trusted keystrokes, never page JS
    filled.push(label);
  }
  // A one-time grant is spent by the password, or, for a login with none, by its username.
  if (filled.includes('password') || (!entry.password && filled.includes('username'))) oneTimeGrants.delete(grantKey(entry, tab.workspace.id));
  log(`vault: filled ${filled.join('+') || 'nothing'} for ${entry.username} on ${host}`);
  if (!entry.password) return { filled, username: entry.username, noPassword: true, note: 'This login has no password: the site signs in with an emailed link or a one-time code. Fill the username, submit, and leave the link or the code to the human.' };
  return { filled, username: entry.username };
}


/**
 * The card fields on a page, in one frame: marked with data-cobrowser-card so the fill can find
 * them again, and described (what each holds, input or select). Visible, enabled fields only: a
 * hidden field filled with a card number is how autofill theft works. Runs in the page, so it
 * must be self-contained (it is sent as source).
 */
function detectCardFields() {
  const visible = (el) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05 && !el.disabled && !el.readOnly;
  };
  const words = (el) => [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('data-elements-stable-field-name'), ...(el.labels ? [...el.labels].map((l) => l.innerText) : [])].filter(Boolean).join(' ').toLowerCase();
  const BY_AUTOCOMPLETE = { 'cc-number': 'number', 'cc-name': 'name', 'cc-exp': 'exp', 'cc-exp-month': 'month', 'cc-exp-year': 'year', 'cc-csc': 'cvc' };
  const kindOf = (el) => {
    for (const t of (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/)) if (BY_AUTOCOMPLETE[t]) return BY_AUTOCOMPLETE[t];
    const t = words(el);
    if (/cvc|cvv|csc|security.?code|card.?code|card.?verification/.test(t)) return 'cvc';
    if (/card.?num|cc.?num|cardnumber|credit.?card.?(no|number)|\bpan\b/.test(t)) return 'number';
    if (/name.?on.?card|card.?holder|cc.?name|nameoncard|cardname/.test(t)) return 'name';
    if (/(exp|expir)\w*.?(month|mm)\b|\bcc.?month/.test(t)) return 'month';
    if (/(exp|expir)\w*.?(year|yy)|\bcc.?year/.test(t)) return 'year';
    if (/\bexp(iry|iration)?\b|exp.?date|mm.?\/.?yy/.test(t)) return 'exp';
    return null;
  };
  const out = []; let n = 0;
  const walk = (root) => {
    for (const el of root.querySelectorAll('input, select')) {
      if (el.type === 'hidden' || !visible(el)) continue;
      const kind = kindOf(el); if (!kind) continue;
      const id = 'c' + (n++) + '-' + Math.random().toString(36).slice(2, 6);
      el.setAttribute('data-cobrowser-card', id);
      out.push({ id, kind, select: el.tagName === 'SELECT', maxLength: el.maxLength > 0 ? el.maxLength : 0, options: el.tagName === 'SELECT' ? [...el.options].map((o) => [o.value, o.text]) : undefined });
    }
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot);
    for (const f of root.querySelectorAll('iframe')) { try { if (f.contentDocument) walk(f.contentDocument); } catch { /* another site's frame: its own session handles it */ } }
  };
  walk(document);
  return out;
}

/** In the page: focus a marked field (selecting what is in it), or set a marked select. */
function touchCardField(id, selectValue) {
  let el = null;
  const find = (root) => {
    el = el || root.querySelector('[data-cobrowser-card="' + id + '"]');
    if (el) return;
    for (const e of root.querySelectorAll('*')) { if (e.shadowRoot) find(e.shadowRoot); if (el) return; }
    for (const f of root.querySelectorAll('iframe')) { try { if (f.contentDocument) find(f.contentDocument); } catch { /* other site */ } if (el) return; }
  };
  find(document);
  if (!el) return false;
  if (selectValue != null) {
    el.value = selectValue;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  el.focus();
  if (el.select) el.select();
  return true;
}

/** What goes in each kind of card field, shaped to the field (2- or 4-digit year, MM/YY). */
function cardValue(card, f) {
  const mm = String(card.expMonth).padStart(2, '0'), yyyy = String(card.expYear), yy = yyyy.slice(-2);
  if (f.select) {
    const want = f.kind === 'month' ? [mm, String(card.expMonth), new Date(2000, card.expMonth - 1).toLocaleString('en', { month: 'long' }).toLowerCase(), new Date(2000, card.expMonth - 1).toLocaleString('en', { month: 'short' }).toLowerCase()] : [yyyy, yy];
    const hit = (f.options || []).find(([v, t]) => want.includes(String(v).trim().toLowerCase()) || want.includes(String(t).trim().toLowerCase()) || (f.kind === 'month' && want.some((w) => String(t).trim().toLowerCase().startsWith(w + ' '))));
    return hit ? { select: hit[0] } : undefined;
  }
  switch (f.kind) {
    case 'number': return { text: card.number };
    case 'name': return card.name ? { text: card.name } : undefined;
    case 'cvc': return card.cvc ? { text: card.cvc } : undefined;
    case 'month': return { text: mm };
    case 'year': return { text: f.maxLength === 2 ? yy : yyyy };
    case 'exp': return { text: f.maxLength && f.maxLength < 5 ? mm + yy : mm + '/' + yy };
  }
  return undefined;
}

/**
 * Fill a saved card into the page: its own fields and those in the payment provider's frames
 * (Stripe and the like put each field in a frame of their own). Asks the person first, every
 * time, whoever asked for it; the number and code are typed by the app, never returned.
 */
async function fillCard(tab, { card: which, by, workspaceName }) {
  const wc = tab.win.webContents;
  const host = hostOf(wc.getURL());
  // A locked vault is unlocked for this fill, and that one prompt is the fill's confirmation:
  // a second one straight after it adds nothing. So it names the site, and the card if named.
  const wasLocked = !vault;
  const named = which ? `your card "${which}"` : 'a saved card';
  const v = await unlockVault(by === 'agent' ? `let the agent in "${workspaceName}" fill ${named} on ${host}` : `fill ${named} on ${host}`);
  const card = store.findCard(v, which);
  if (!card) {
    const have = (v.cards || []).map((c) => store.publicCard(c).label);
    return { filled: [], error: have.length ? (which ? `no saved card "${which}"` : 'several cards are saved: name one') : 'no card is saved in the vault', cards: have };
  }
  const pub = store.publicCard(card);
  const dbg = wc.debugger;
  const run = (expression, sessionId) => dbg.sendCommand('Runtime.evaluate', { expression, returnByValue: true }, sessionId).then((r) => r.result.value).catch(() => undefined);
  // Find the fields first, so nothing is asked for a page with nowhere to put a card.
  const targets = [undefined, ...tab.frameSessions.values()];
  const found = [];
  for (const sessionId of targets) {
    for (const f of (await run(`(${detectCardFields.toString()})()`, sessionId)) || []) found.push({ ...f, sessionId });
  }
  if (!found.length) return { filled: [], error: `no card fields on ${host}` };
  // Cobrowser: Fill Card lists the cards first, unlocking for this fill (vault.cards forFill).
  const unlockedForThis = wasLocked || (by === 'human' && Date.now() - fillUnlockAt < FILL_UNLOCK_MS);
  fillUnlockAt = 0;
  if (!unlockedForThis) {
    await confirmFresh(by === 'agent'
      ? `let the agent in "${workspaceName}" fill your card ${pub.label} (•••• ${pub.last4}) on ${host}`
      : `fill your card ${pub.label} (•••• ${pub.last4}) on ${host}`);
  }
  tab.boost();
  const filled = [];
  for (const f of found) {
    const value = cardValue(card, f);
    if (!value) continue;
    if (value.select !== undefined) {
      if (await run(`(${touchCardField.toString()})(${JSON.stringify(f.id)}, ${JSON.stringify(value.select)})`, f.sessionId)) filled.push(f.kind);
      continue;
    }
    if (!(await run(`(${touchCardField.toString()})(${JSON.stringify(f.id)}, null)`, f.sessionId))) continue;
    await dbg.sendCommand('Input.insertText', { text: value.text }, f.sessionId).catch(() => undefined); // trusted keystrokes, never page JS
    filled.push(f.kind);
  }
  log(`vault: filled card ${pub.label} (${filled.join('+')}) on ${host} for the ${by}`);
  return { filled, card: pub.label, last4: pub.last4 };
}

// ---------------------------------------------------------------------------------------
// Vault window: the menu-bar way to add, remove and import logins. A real (visible) window;
// the page talks to the app only through the preload's narrow bridge.
// ---------------------------------------------------------------------------------------
const VAULT_HTML = `<!doctype html><meta charset="utf-8"><title>cobrowser vault</title>
<style>
  :root {
    color-scheme: light dark;
    /* cobrowser's palette, from its mark: black, white, and cobalt where the two panes meet,
       the space shared with the agent. Cobalt marks what concerns the agent and what is chosen. */
    --bg: #0a0a0c; --panel: #111114; --lift: #19191d; --line: rgba(255,255,255,.08); --line-2: rgba(255,255,255,.15);
    --fg: #fafafa; --muted: #8e8e99; --dim: #4a4a53;
    /* Every shade of the accent, cobalt, comes from it. */
    --accent: #2b5bff; --danger: #ff5a52; --pane: #3a3a44;
    --accent-text: color-mix(in srgb, var(--accent) 62%, white); --accent-soft: color-mix(in srgb, var(--accent) 16%, transparent);
    --accent-glow: color-mix(in srgb, var(--accent) 40%, transparent); --sel-ring: color-mix(in srgb, var(--accent) 14%, var(--panel));
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #f4f4f5; --panel: #fff; --lift: #f6f6f7; --line: rgba(0,0,0,.08); --line-2: rgba(0,0,0,.16);
      --fg: #0a0a0c; --muted: #6b6b76; --dim: #b9b9c1; --danger: #d93a32; --pane: #c9c9d1;
      --accent-text: color-mix(in srgb, var(--accent) 80%, black); --accent-soft: color-mix(in srgb, var(--accent) 10%, transparent);
      --accent-glow: color-mix(in srgb, var(--accent) 30%, transparent); --sel-ring: color-mix(in srgb, var(--accent) 9%, var(--panel)); }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { background: var(--bg); color: var(--fg); font: 13px/1.45 -apple-system, "SF Pro Text", system-ui, sans-serif; -webkit-user-select: none; display: grid; grid-template-rows: auto 1fr; -webkit-font-smoothing: antialiased; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: -.01em; }
  input { font: inherit; color: var(--fg); }
  button { font: inherit; color: var(--fg); background: var(--lift); border: 1px solid var(--line-2); border-radius: 6px; height: 28px; padding: 0 12px; cursor: default; }
  button:hover { border-color: var(--muted); }
  button.quiet { background: transparent; border-color: transparent; color: var(--muted); } button.quiet:hover { color: var(--fg); background: var(--lift); }
  button.primary { background: var(--fg); border-color: transparent; color: var(--bg); font-weight: 600; } button.primary:disabled { opacity: .4; }
  button.danger:hover { color: var(--danger); border-color: var(--danger); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  ::-webkit-scrollbar { width: 8px; } ::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 4px; border: 2px solid transparent; background-clip: padding-box; }

  header { -webkit-app-region: drag; display: flex; align-items: center; gap: 10px; padding: 30px 22px 14px; }
  header svg { width: 20px; height: 20px; }
  header h1 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -.025em; }
  header .sub { color: var(--muted); margin-left: 2px; }
  .kinds { display: flex; gap: 2px; margin-left: 6px; -webkit-app-region: no-drag; }
  .kinds button { padding: 3px 10px; border-radius: 6px; color: var(--muted); }
  .kinds button.on { color: var(--fg); background: var(--lift); }
  header .spacer { flex: 1; } header button, header .state { -webkit-app-region: no-drag; }
  .state { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; padding: 0 4px; }
  .state i { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); } .state.on i { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }

  .panes { display: grid; grid-template-columns: 340px 1fr; gap: 14px; padding: 0 22px 22px; min-height: 0; }
  button { white-space: nowrap; }
  .pane { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }

  /* roster */
  .search { padding: 10px 12px; border-bottom: 1px solid var(--line); }
  .search input { width: 100%; background: var(--lift); border: 1px solid var(--line); border-radius: 7px; height: 28px; padding: 0 10px 0 28px; outline: 0; -webkit-user-select: text;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%238b919c' stroke-width='2.2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='M20 20l-3.5-3.5'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: 9px center; }
  .search input::placeholder { color: var(--dim); }
  .list { overflow: auto; flex: 1; }
  .item { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
  .item:hover { background: var(--lift); } .item.sel { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
  .item .id { min-width: 0; flex: 1; }
  .item b { display: block; font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } b em { font-style: normal; color: var(--muted); font-weight: 400; }
  .item .id span { display: block; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .foot { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); } .foot .primary { flex: 1; }
  .empty { margin: auto; padding: 24px; text-align: center; color: var(--muted); max-width: 300px; line-height: 1.5; }

  /* the signature: where a login meets a workspace. One square per workspace, in its shade of
     cobalt, overlapping as the panes of the mark do. */
  .discs { display: inline-flex; align-items: center; flex: none; }
  .disc { width: 13px; height: 13px; border-radius: 3px; border: 1.5px solid var(--dim); background: transparent; flex: none; }
  .discs .disc { margin-left: -5px; box-shadow: 0 0 0 2px var(--panel); } .discs .disc:first-child { margin-left: 0; }
  .item.sel .discs .disc { box-shadow: 0 0 0 2px var(--sel-ring); }
  .disc.on { border-color: transparent; background: var(--c, var(--accent)); }
  .disc.all { border-color: var(--accent); background: linear-gradient(var(--accent), var(--accent)) center / 5px 5px no-repeat; }
  .disc.none { border-style: dashed; }
  .discs small { color: var(--muted); font-size: 11px; margin-left: 5px; }

  /* card */
  .detail { padding: 20px 22px; display: flex; flex-direction: column; gap: 18px; min-height: 0; overflow: auto; }
  /* a login's websites: one row each, as a list */
  .sites { border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  .site { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 6px 0 14px; border-bottom: 1px solid var(--line); background: var(--lift); }
  .site:last-child { border-bottom: 0; }
  .site input { flex: 1; min-width: 0; background: none; border: 0; outline: 0; height: 40px; padding: 0; -webkit-user-select: text; } .site input::placeholder { color: var(--dim); }
  .site .x { width: 26px; height: 26px; padding: 0; color: var(--muted); }
  .site.add button { padding: 0; height: 40px; color: var(--accent-text); } .site.add { background: transparent; }
  /* notes: Markdown, written in a box, read formatted */
  textarea.notes { width: 100%; min-height: 120px; resize: vertical; background: var(--lift); border: 1px solid var(--line); border-radius: 6px; padding: 10px 14px; outline: 0; color: var(--fg); font: 12.5px/1.55 ui-monospace, "SF Mono", Menlo, monospace; -webkit-user-select: text; }
  textarea.notes::placeholder { color: var(--dim); }
  .md { border: 1px solid var(--line); border-radius: 6px; padding: 10px 14px; background: var(--lift); line-height: 1.55; -webkit-user-select: text; overflow-wrap: anywhere; }
  .md > :first-child { margin-top: 0; } .md > :last-child { margin-bottom: 0; }
  .md p, .md ul, .md ol, .md pre { margin: 0 0 8px; } .md ul, .md ol { padding-left: 20px; }
  .md h4, .md h5, .md h6 { margin: 10px 0 4px; font-size: 13px; }
  .md code { font: 12px ui-monospace, "SF Mono", Menlo, monospace; background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
  .md pre { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; overflow: auto; } .md pre code { border: 0; padding: 0; background: none; }
  .md a { color: var(--accent-text); }
  .md.none { color: var(--muted); }
  /* The detail pane scrolls; its sections keep their size rather than being squeezed under
     the buttons when a form is taller than the window. */
  .card-in { display: flex; flex-direction: column; gap: 18px; flex: 1 0 auto; }
  .sec.grow { flex: 1 0 auto; }
  .title { display: flex; align-items: flex-start; gap: 12px; }
  .title .id { flex: 1; min-width: 0; } .title h2 { margin: 0; font-size: 22px; font-weight: 600; line-height: 1.2; overflow-wrap: anywhere; } .title h2 em { font-style: normal; font-weight: 400; color: var(--muted); }
  .title .user { color: var(--muted); margin-top: 3px; font-size: 13px; }
  .title .acts { display: flex; gap: 4px; flex: none; }
  h3 { margin: 0; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
  .sec { display: flex; flex-direction: column; gap: 8px; }
  .fields { border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  .field { display: grid; grid-template-columns: 96px 1fr; align-items: center; min-height: 40px; padding: 0 14px; border-bottom: 1px solid var(--line); background: var(--lift); }
  .field:last-child { border-bottom: 0; } .field label { color: var(--muted); font-size: 12.5px; }
  .field input { background: none; border: 0; outline: 0; height: 40px; padding: 0; -webkit-user-select: text; } .field input::placeholder { color: var(--dim); }
  .pw { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .pw span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); letter-spacing: .12em; }
  .pw span.revealed { color: var(--fg); letter-spacing: 0; -webkit-user-select: text; }
  .scope { border: 1px solid var(--line); border-radius: 6px; overflow: hidden; display: flex; flex-direction: column; flex: 1; min-height: 220px; }
  .row { display: flex; align-items: center; gap: 12px; padding: 0 14px; height: 40px; border-bottom: 1px solid var(--line); }
  .row:last-child { border-bottom: 0; }
  .row.every { background: var(--lift); } .row.every b { flex: 1; font-weight: 600; } .row.every small { color: var(--muted); }
  .switch { width: 34px; height: 20px; border-radius: 999px; background: var(--dim); position: relative; border: 0; padding: 0; transition: background .15s; }
  .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; }
  .switch[aria-checked="true"] { background: var(--accent); } .switch[aria-checked="true"]::after { transform: translateX(14px); }
  .wsfilter { padding: 8px 10px; border-bottom: 1px solid var(--line); } .wsfilter input { width: 100%; background: var(--panel); border: 1px solid var(--line); border-radius: 7px; height: 26px; padding: 0 9px; outline: 0; -webkit-user-select: text; font-size: 12.5px; }
  .wslist { overflow: auto; flex: 1; }
  .ws { height: 38px; } .ws:hover { background: var(--lift); }
  .ws .disc { transition: transform .12s ease, background-color .12s ease; } .ws:hover .disc { transform: scale(1.15); }
  .ws .disc.on { box-shadow: 0 0 0 3px var(--accent-glow); }
  .ws .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .ws .name small { color: var(--muted); margin-left: 8px; }
  .ws.inherit { opacity: .5; pointer-events: none; }
  .hint { color: var(--muted); font-size: 12px; margin: 0; line-height: 1.5; }
  .actions { display: flex; gap: 8px; padding-top: 2px; align-items: center; flex: none; } .actions .spacer { flex: 1; }
  #status { color: var(--muted); font-size: 12px; min-height: 17px; }
  #notice { color: var(--muted); font-size: 12px; padding: 0 22px 10px; }
  .lockcard { margin: auto; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px; color: var(--muted); max-width: 320px; line-height: 1.5; }
  .lockcard svg { width: 28px; height: 28px; opacity: .6; }
  @media (prefers-reduced-motion: reduce) { .switch, .switch::after, .ws .disc { transition: none; } }
</style>
<header>
  <svg viewBox="0 0 100 100" aria-hidden="true"><rect x="12" y="12" width="52" height="52" fill="var(--fg)"/><rect x="36" y="36" width="52" height="52" fill="var(--pane)"/><rect x="36" y="36" width="28" height="28" fill="var(--accent)"/></svg>
  <h1>Vault</h1>
  <span class="kinds"><button class="quiet on" id="k-logins">Logins</button><button class="quiet" id="k-cards">Cards</button></span>
  <span class="sub" id="sub">what the agent may sign in with, and where</span>
  <span class="spacer"></span>
  <button class="quiet" id="import">Import CSV…</button><button class="quiet" id="export">Export CSV…</button>
  <span class="state" id="state"><i></i><span>Locked</span></span>
  <button class="quiet" id="lock">Lock</button>
</header>
<div id="notice" role="status" hidden></div>
<div class="panes">
  <section class="pane">
    <div class="search"><input id="q" placeholder="Filter" autocomplete="off" spellcheck="false"></div>
    <div class="list" id="list" tabindex="0"></div>
    <div class="foot"><button class="primary" id="new">Add login</button></div>
  </section>
  <section class="pane detail" id="detail"></section>
</div>
<script>
  ${markdownToHtml.toString()}
  const $ = (id) => document.getElementById(id);
  let known = [], rows = [], unlocked = false, unlocking = false, lastError = '', sel = null, mode = 'view';
  // scopeFrom: the workspaces the form started from, for a login already saved, so saving
  // applies what changed here to the login as it is then (another grant may land meanwhile).
  // hadPass: the login being edited has a password; dropPass: the person chose to remove it.
  const draft = { sites: [''], user: '', pass: '', notes: '', scope: [], scopeFrom: undefined, from: null, matched: null, hadPass: false, dropPass: false };
  const resetDraft = () => Object.assign(draft, { sites: [''], user: '', pass: '', notes: '', scope: [], scopeFrom: undefined, from: null, matched: null, hadPass: false, dropPass: false });
  const cleanSites = () => draft.sites.map((x) => x.trim()).filter(Boolean);
  // A login's websites, one row each: every site it fills on, matched as strictly as any other.
  function sitesEditor(onEnter) {
    const box = el('div', 'sites');
    const paint = (focusLast) => {
      box.innerHTML = '';
      draft.sites.forEach((value, i) => {
        const row = el('div', 'site'); const inp = el('input', 'mono'); inp.value = value; inp.placeholder = i === 0 ? 'costco.com, or 192.168.1.50:8080' : 'another site this account signs in on, e.g. live.com'; inp.autocomplete = 'off'; inp.spellcheck = false;
        inp.oninput = () => { draft.sites[i] = inp.value; sync(); }; inp.onkeydown = (e) => { if (e.key === 'Enter') onEnter(); };
        row.append(inp);
        if (draft.sites.length > 1) { const x = el('button', 'quiet x', '×'); x.title = 'Remove this website'; x.onclick = () => { draft.sites.splice(i, 1); paint(); sync(); }; row.append(x); }
        box.append(row);
        if (focusLast && i === draft.sites.length - 1) setTimeout(() => inp.focus(), 0);
      });
      const add = el('div', 'site add'); const b = el('button', 'quiet', '+ Add website'); b.onclick = () => { draft.sites.push(''); paint(true); }; add.append(b); box.append(add);
    };
    paint();
    return box;
  }
  function notesEditor(get, set) {
    const t = el('textarea', 'notes'); t.value = get(); t.spellcheck = true;
    t.placeholder = 'Markdown, for you and for agents: which account this is, how 2FA works, anything an agent should know before signing in.';
    t.oninput = () => set(t.value);
    return t;
  }
  function notesView(text, empty) {
    const d = el('div', 'md' + (text ? '' : ' none'));
    if (text) d.innerHTML = markdownToHtml(text); else d.textContent = empty;
    return d;
  }
  let repaintScope = () => {};
  // A typed site, reduced to what a login's label shows, to spot a login that already exists.
  // The same reading as the vault's own (site.js parseSite), so the window's "replaces" is the vault's.
  const siteKey = (h) => { const v = String(h || '').trim(); if (!v) return ''; try { const u = new URL(v.includes('://') ? v : 'https://' + v); return u.hostname.toLowerCase() + (u.port ? ':' + u.port : ''); } catch { return v.toLowerCase(); } };
  const existingFor = () => rows.find((r) => siteKey(r.host) === siteKey(cleanSites()[0]) && r.username === draft.user.trim());
  const failed = (e) => (String(e && e.message || e).includes('cancelled') ? 'Nothing changed.' : String(e && e.message || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const base = (p) => p.split('/').filter(Boolean).slice(-1)[0] || p;
  const dir = (p) => ('/' + p.split('/').filter(Boolean).slice(0, -1).join('/')).replace(new RegExp('^/Users/[^/]+'), '~');
  // A message goes beside the login or card on show, or the form; with neither (nothing
  // selected, as after an import or an export), to the line under the header, for a while.
  let noticeTimer;
  const say = (t) => {
    const s = $('status'); if (s) { s.textContent = t; return; }
    const n = $('notice'); n.textContent = t; n.hidden = !t;
    clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { n.hidden = true; }, 12000);
  };
  const hostParts = (h) => { const [hostOnly, port] = h.split(':'); const p = hostOnly.split('.'); const tail = port ? ':' + port : ''; return p.length > 2 && !/^\\d+$/.test(p[0]) ? [p.slice(0, -2).join('.') + '.', p.slice(-2).join('.') + tail] : ['', h]; };
  const scopeText = (sc) => sc === 'all' ? 'everywhere' : !sc || !sc.length ? 'nowhere' : sc.length === 1 ? base(sc[0]) : sc.length + ' workspaces';

  /** A stable shade of the accent per workspace, from deep to light. */
  const SHADES = ['var(--accent)', 'color-mix(in oklab, var(--accent) 78%, white)', 'color-mix(in oklab, var(--accent) 58%, white)', 'color-mix(in oklab, var(--accent) 78%, black)', 'color-mix(in oklab, var(--accent) 62%, black)'];
  const color = (w) => { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return SHADES[h % SHADES.length]; };
  function disc(cls, w) { const d = el('span', 'disc' + (cls ? ' ' + cls : '')); if (w) { d.style.setProperty('--c', color(w)); d.title = base(w); } return d; }
  function discStack(sc) {
    const box = el('span', 'discs');
    if (sc === 'all') { box.append(disc('all')); box.append(el('small', null, 'everywhere')); return box; }
    if (!sc || !sc.length) { box.append(disc('none')); box.append(el('small', null, 'nowhere')); return box; }
    for (const w of sc.slice(0, 4)) box.append(disc('on', w));
    box.append(el('small', null, sc.length > 4 ? '+' + (sc.length - 4) : sc.length === 1 ? base(sc[0]) : ''));
    return box;
  }

  function state() {
    $('state').className = 'state' + (unlocked ? ' on' : '');
    $('lock').hidden = !unlocked;
    // What this view holds: logins in Logins, cards in Cards.
    const n = kind === 'cards' ? cards.length : rows.length, what = kind === 'cards' ? ' card' : ' login';
    $('state').lastElementChild.textContent = unlocked ? n + what + (n === 1 ? '' : 's') + ' · unlocked' : 'Locked';
  }

  let shown = []; // the logins the filter lets through, in the order listed
  function renderList() {
    const q = $('q').value.trim().toLowerCase();
    const list = $('list'); list.innerHTML = '';
    shown = rows.filter((r) => !q || (r.host + ' ' + r.username + ' ' + scopeText(r.scope)).toLowerCase().includes(q));
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
      // A login can still list a workspace that was forgotten, renamed or deleted: show it, so
      // it can be taken off.
      const gone = all ? [] : sc.filter((w) => !known.includes(w));
      const items = [...known, ...gone].filter((w) => !q || w.toLowerCase().includes(q)).sort((a, b) => { const A = !all && sc.includes(a), B = !all && sc.includes(b); return A === B ? base(a).localeCompare(base(b)) : A ? -1 : 1; });
      wl.innerHTML = '';
      if (!items.length && !q) wl.append(el('div', 'empty', 'Workspaces appear here once they have opened cobrowser.'));
      for (const w of items) {
        const on = all || sc.includes(w);
        const r = el('div', 'row ws' + (all ? ' inherit' : ''));
        const name = el('div', 'name'); name.append(base(w), el('small', null, gone.includes(w) ? dir(w) + ' · no longer known to cobrowser' : dir(w))); name.title = w;
        r.append(disc(on ? 'on' : '', w), name);
        r.onclick = () => { if (all) return; setScope(on ? sc.filter((x) => x !== w) : [...sc, w]); paint(); };
        wl.append(r);
      }
    };
    sw.onclick = () => { setScope(getScope() === 'all' ? [] : 'all'); paint(); };
    fi.oninput = paint; paint();
    box.repaint = paint;
    return box;
  }

  function section(title, body, grow) { const s = el('div', 'sec' + (grow ? ' grow' : '')); s.append(el('h3', null, title), body); return s; }

  function renderDetail() {
    const d = $('detail'); d.innerHTML = '';
    const wrap = el('div', 'card-in'); d.append(wrap);
    if (!unlocked) {
      const lc = el('div', 'lockcard');
      lc.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
      const b = el('button', 'primary', unlocking ? 'Waiting for you to confirm…' : 'Unlock'); b.disabled = unlocking; b.onclick = refresh;
      lc.append(el('div', null, 'Locked. Unlock with Touch ID or your Mac password. Every change, and showing or exporting a password, asks again.'), b);
      // In the window, its own pointer to the window is dropped.
      if (lastError && !unlocking) lc.append(el('p', 'hint', lastError.replace(/: open the vault \(Cobrowser: Open Vault\) to start a new one$/, '.')));
      // A vault this Mac's keychain key cannot open: unlocking again will not help.
      if (/cannot be read with this Mac/.test(lastError) && !unlocking) {
        const fresh = el('button', 'quiet danger', 'Start a new vault');
        fresh.onclick = async () => {
          try { const r = await vault.startOver(); if (r && r.ok) { lastError = ''; say('A new, empty vault: the old file is kept as ' + base(r.backup) + '. Import your last export to fill it.'); render(); } else if (r && r.error) say(r.error); } catch (e) { say(failed(e)); }
        };
        lc.append(el('p', 'hint', 'The old file is kept, renamed with the date, and a new, empty vault takes its place.'), fresh);
      }
      wrap.append(lc); return;
    }
    if (mode === 'add' || mode === 'import' || mode === 'edit') {
      const importing = mode === 'import', editing = mode === 'edit';
      const t = el('div', 'title'); const id = el('div', 'id'); id.append(el('h2', null, importing ? 'Import logins' : editing ? 'Edit login' : 'New login')); t.append(id); wrap.append(t);
      if (importing) wrap.append(el('p', 'hint', 'Logins exported from cobrowser keep the workspaces the file notes for them; the others get the ones you choose here. A login already in the vault gets the password (and the notes, if the file has some) from the file, keeps its workspaces and gains the new ones. You can change each one afterwards.'));
      else {
        const go = () => { if (canSave()) (editing ? saveEdit : save)(); };
        const f = el('div', 'fields');
        const passHint = editing ? (draft.dropPass ? 'removed' : draft.hadPass ? 'unchanged' : 'none: signs in with a link or a code') : 'none if it signs in with a link or a code';
        for (const [key, label, ph, type] of [['user', 'Username', 'you@example.com', 'text'], ['pass', 'Password', passHint, 'password']]) {
          const row = el('div', 'field'); const inp = el('input', key === 'pass' ? '' : 'mono'); inp.type = type; inp.placeholder = ph; inp.value = draft[key]; inp.autocomplete = 'off'; inp.spellcheck = false;
          inp.oninput = () => { draft[key] = inp.value; if (key === 'pass' && inp.value) draft.dropPass = false; sync(); }; inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
          row.append(el('label', null, label), inp); f.append(row);
        }
        wrap.append(section('Websites', sitesEditor(go)));
        wrap.append(section('Login', f));
        // A saved password can be taken off: the account signs in with a link or a code from then on.
        if (editing && draft.hadPass) {
          const drop = el('button', 'quiet', draft.dropPass ? 'The saved password will be removed · Keep it' : 'Remove the saved password');
          drop.onclick = () => { draft.dropPass = !draft.dropPass; if (draft.dropPass) draft.pass = ''; render(); };
          // Not an 'actions' row: the form's own buttons (Cancel, Save) are the one row of those.
          const line = el('div'); line.style.display = 'flex'; line.append(drop); wrap.append(line);
        }
        wrap.append(section('Notes', notesEditor(() => draft.notes, (v) => { draft.notes = v; })));
      }
      const editor = scopeEditor(() => draft.scope, (v) => { draft.scope = v; sync(); });
      repaintScope = editor.repaint;
      wrap.append(section('Where the agent may use it', editor, true));
      const a = el('div', 'actions'); const st = el('div'); st.id = 'status'; a.append(st, el('span', 'spacer'));
      const cancel = el('button', 'quiet', 'Cancel'); cancel.onclick = () => { resetDraft(); mode = 'view'; render(); };
      const ok = el('button', 'primary', importing ? 'Choose CSV…' : editing ? 'Save changes' : 'Save login'); ok.id = 'save'; ok.onclick = importing ? doImport : editing ? saveEdit : save;
      a.append(cancel, ok); wrap.append(a); sync();
      if (!importing) wrap.querySelector('input').focus();
      return;
    }
    if (!sel) { wrap.append(el('div', 'empty', rows.length ? 'Pick a login to see where the agent may use it.' : 'Add a login and choose which workspaces may use it. The agent can sign in with it, but never sees the password.')); return; }

    const t = el('div', 'title'); const id = el('div', 'id'); const h2 = el('h2', 'mono'); const [pre, dom] = hostParts(sel.host); h2.append(el('em', null, pre), dom);
    id.append(h2, el('div', 'user mono', sel.username || '(no username)'));
    t.append(id);
    const acts = el('div', 'acts');
    const ed = el('button', 'quiet', 'Edit'); ed.onclick = () => { Object.assign(draft, { sites: [sel.host, ...(sel.also || [])], user: sel.username, pass: '', notes: sel.notes || '', scope: sel.scope, scopeFrom: sel.scope, from: { host: sel.host, username: sel.username }, hadPass: !!sel.hasPassword, dropPass: false }); mode = 'edit'; render(); };
    // Removing asks for Touch ID or the Mac's password, which is the confirmation.
    const rm = el('button', 'quiet danger', 'Remove'); rm.onclick = async () => { try { await vault.remove(sel.host, sel.username); sel = null; await refresh(); } catch (e) { say(failed(e)); } };
    acts.append(ed, rm); t.append(acts); wrap.append(t);

    const pw = el('div', 'fields'); const prow = el('div', 'field'); prow.style.gridTemplateColumns = '1fr';
    const pval = el('div', 'pw'); const dots = el('span', 'mono', '••••••••••'); pval.append(dots);
    const copyBtn = el('button', 'quiet', 'Copy'); copyBtn.hidden = true; const show = el('button', 'quiet', 'Show'); let hideTimer;
    const hide = () => { clearTimeout(hideTimer); dots.textContent = '••••••••••'; dots.classList.remove('revealed'); show.textContent = 'Show'; copyBtn.hidden = true; };
    show.onclick = async () => {
      if (dots.classList.contains('revealed')) return hide();
      try { const secret = await vault.reveal(sel.host, sel.username); dots.textContent = secret; dots.classList.add('revealed'); show.textContent = 'Hide'; copyBtn.hidden = false;
        copyBtn.onclick = async () => { await vault.copyPassword(secret); copyBtn.textContent = 'Copied · cleared in 90 s'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2500); };
        hideTimer = setTimeout(hide, 30000); } catch (e) { say(failed(e)); }
    };
    pval.append(copyBtn, show); prow.append(pval); pw.append(prow);
    if (!sel.hasPassword) { pw.textContent = ''; pw.append(el('div', 'hint', 'None: this account signs in with an emailed link or a one-time code. The agent can fill the username; you finish the sign-in.')); }
    wrap.append(section('Password', pw));
    const sites = el('div', 'sites');
    for (const s of [sel.host, ...(sel.also || [])]) { const row = el('div', 'site'); row.append(el('span', 'mono', s)); sites.append(row); }
    wrap.append(section('Websites', sites));
    wrap.append(section('Notes', notesView(sel.notes, 'No notes. Edit to add some for you and for agents: which account this is, how 2FA works.')));
    // A tick is a change from what is shown; until it is confirmed it shows, and if it is not, the
    // login goes back to the workspaces it has.
    wrap.append(section('Where the agent may use it', scopeEditor(() => sel.scope, async (v) => {
      const login = sel, before = login.scope; login.scope = v; renderList();
      try { await vault.setScope(login.host, login.username, before, v); } catch (e) { login.scope = before; render(); say(failed(e)); }
    }), true));
    const a = el('div', 'actions'); const st = el('div'); st.id = 'status'; a.append(st); wrap.append(a);
  }
  const canSave = () => !!(cleanSites().length && (draft.scope === 'all' || draft.scope.length));
  const sync = () => {
    const b = $('save'); if (!b) return;
    const scoped = draft.scope === 'all' || draft.scope.length > 0;
    b.disabled = mode === 'add' || mode === 'edit' ? !canSave() : !scoped;
    // Adding a login that already exists replaces it: say so before, not after, and start from
    // its workspaces, so saving changes only what is changed here.
    const existing = mode === 'add' ? existingFor() : undefined;
    const replacing = !!existing;
    const matchKey = existing ? existing.host + ' | ' + existing.username : null;
    if (matchKey !== draft.matched) {
      draft.matched = matchKey;
      draft.scopeFrom = existing ? existing.scope : undefined;
      if (existing) { draft.scope = existing.scope === 'all' ? 'all' : [...existing.scope]; repaintScope(); }
    }
    if (mode === 'add') b.textContent = replacing ? 'Replace login' : 'Save login';
    // Say why Save is off, once the rest is filled in — the missing piece is otherwise invisible.
    const st = $('status'); if (st && (mode !== 'add' || cleanSites().length)) st.textContent = !scoped ? 'Choose a workspace, or Everywhere.' : replacing ? 'This site and username are already saved: saving ' + (draft.pass ? 'replaces the password' : 'keeps its password') + ', and the workspaces shown are the ones it has now.' : '';
  };
  async function save() {
    try {
      const sites = cleanSites(); const u = draft.user.trim(); const k = siteKey(sites[0]);
      await vault.add(sites[0], u, draft.pass, draft.scope, sites.slice(1), draft.notes, draft.scopeFrom);
      resetDraft(); mode = 'view'; await refresh(); sel = rows.find((r) => siteKey(r.host) === k && r.username === u) || null; render();
    } catch (e) { say(failed(e)); }
  }
  async function saveEdit() {
    try {
      const sites = cleanSites(); const u = draft.user.trim(); const k = siteKey(sites[0]);
      await vault.update(draft.from, { site: sites[0], also: sites.slice(1), username: u, password: draft.dropPass ? null : draft.pass || undefined, scope: draft.scope, scopeFrom: draft.scopeFrom, notes: draft.notes });
      resetDraft(); mode = 'view'; await refresh(); sel = rows.find((r) => siteKey(r.host) === k && r.username === u) || null; render();
    } catch (e) { say(failed(e)); }
  }
  async function doImport() {
    try {
      const r = await vault.importCsv(draft.scope); if (r == null) return; mode = 'view'; resetDraft(); await refresh();
      const n = (k) => k + ' login' + (k === 1 ? '' : 's');
      say('Imported ' + n(r.count) + ': ' + r.added + ' new, ' + r.replaced + ' already here (password replaced, workspaces kept and added to).' + (r.skipped ? ' ' + r.skipped + (r.skipped === 1 ? ' row was' : ' rows were') + ' skipped, with no website or neither a username nor a password.' : ''));
    } catch (e) { say(failed(e)); }
  }
  // ---- cards: the same window, a second kind of thing the vault holds ----
  let kind = 'logins', cards = [], selCard = null, cardMode = 'view';
  const cdraft = { id: null, label: '', name: '', number: '', exp: '', cvc: '', notes: '', hadCode: false, forgetCode: false };
  const resetCard = () => Object.assign(cdraft, { id: null, label: '', name: '', number: '', exp: '', cvc: '', notes: '', hadCode: false, forgetCode: false });
  const cardLine = (c) => c.brand + ' •••• ' + c.last4 + ' · ' + c.exp;
  function paintKinds() {
    const cardsOn = kind === 'cards';
    $('k-logins').classList.toggle('on', !cardsOn); $('k-cards').classList.toggle('on', cardsOn);
    $('sub').textContent = cardsOn ? 'filled into checkout pages, always with your confirmation' : 'what the agent may sign in with, and where';
    $('new').textContent = cardsOn ? 'Add card' : 'Add login';
    $('q').parentElement.hidden = cardsOn;
  }
  function renderCards() {
    const list = $('list'); list.innerHTML = '';
    if (!unlocked) list.append(el('div', 'empty', 'Locked.'));
    else if (!cards.length) list.append(el('div', 'empty', 'No cards yet. Add one, and it can be filled into a checkout page: by you, or by the agent, each time after you confirm.'));
    else for (const c of cards) {
      const it = el('div', 'item' + (selCard && selCard.id === c.id ? ' sel' : ''));
      const id = el('div', 'id'); id.append(el('b', null, c.label), el('span', 'mono', cardLine(c)));
      it.append(id); it.onclick = () => { selCard = c; cardMode = 'view'; render(); };
      list.append(it);
    }
    if (!unlocked) { renderDetail(); return; }
    const d = $('detail'); d.innerHTML = '';
    const wrap = el('div', 'card-in'); d.append(wrap);
    if (cardMode === 'add' || cardMode === 'edit') {
      const editing = cardMode === 'edit';
      const t = el('div', 'title'); const id = el('div', 'id'); id.append(el('h2', null, editing ? 'Edit card' : 'New card')); t.append(id); wrap.append(t);
      const f = el('div', 'fields');
      for (const [key, label, ph, type] of [['label', 'Label', 'optional, e.g. Personal Visa', 'text'], ['name', 'Name on card', '', 'text'], ['number', 'Card number', editing ? 'unchanged' : '', 'text'], ['exp', 'Expiry', 'MM/YY', 'text'], ['cvc', 'Security code', editing ? 'unchanged' : '3 or 4 digits', 'password']]) {
        const row = el('div', 'field'); const inp = el('input', key === 'name' || key === 'label' ? '' : 'mono'); inp.type = type; inp.placeholder = ph; inp.value = cdraft[key]; inp.autocomplete = 'off'; inp.spellcheck = false;
        inp.oninput = () => { cdraft[key] = inp.value; }; inp.onkeydown = (e) => { if (e.key === 'Enter') saveCard(); };
        row.append(el('label', null, label), inp); f.append(row);
      }
      wrap.append(section('Card', f));
      // A saved code can be taken off again: from then on it is typed at checkout.
      if (editing && cdraft.hadCode) {
        const forget = el('button', 'quiet', cdraft.forgetCode ? 'The saved code will be removed · Keep it' : 'Remove the saved security code');
        forget.onclick = () => { cdraft.forgetCode = !cdraft.forgetCode; render(); };
        const line = el('div', 'actions'); line.append(forget); wrap.append(line);
      }
      const notes = notesEditor(() => cdraft.notes, (v) => { cdraft.notes = v; });
      notes.placeholder = 'Markdown, for you and for agents: which purchases this card is for, a spending limit, the billing address.';
      wrap.append(section('Notes', notes));
      wrap.append(el('p', 'hint', 'The number and security code stay in the vault: lists show the last four digits, and filling types them into the page without the agent ever seeing them. Notes are read by agents in every workspace, since a card is not limited to workspaces as a login is.'));
      const a = el('div', 'actions'); const st = el('div'); st.id = 'status'; a.append(st, el('span', 'spacer'));
      const cancel = el('button', 'quiet', 'Cancel'); cancel.onclick = () => { resetCard(); cardMode = 'view'; render(); };
      const ok = el('button', 'primary', editing ? 'Save changes' : 'Save card'); ok.onclick = saveCard;
      a.append(cancel, ok); wrap.append(a);
      wrap.querySelector('input').focus();
      return;
    }
    if (!selCard) { wrap.append(el('div', 'empty', cards.length ? 'Pick a card.' : 'Add a card to fill checkout pages with it.')); return; }
    const t = el('div', 'title'); const id = el('div', 'id'); id.append(el('h2', null, selCard.label), el('div', 'user mono', cardLine(selCard))); t.append(id);
    const acts = el('div', 'acts');
    const ed = el('button', 'quiet', 'Edit'); ed.onclick = () => { Object.assign(cdraft, { id: selCard.id, label: selCard.label, name: selCard.name, number: '', exp: selCard.exp, cvc: '', notes: selCard.notes || '', hadCode: selCard.hasCode, forgetCode: false }); cardMode = 'edit'; render(); };
    const rm = el('button', 'quiet danger', 'Remove'); rm.onclick = async () => { try { await vault.removeCard(selCard.id); selCard = null; cards = await vault.cards(); render(); } catch (e) { say(failed(e)); } };
    acts.append(ed, rm); t.append(acts); wrap.append(t);
    const info = el('div', 'fields');
    for (const [k, v] of [['Name on card', selCard.name || '(none)'], ['Expires', selCard.exp], ['Security code', selCard.hasCode ? 'saved' : 'not saved: typed at checkout']]) { const row = el('div', 'field'); row.append(el('label', null, k), el('div', 'mono', v)); info.append(row); }
    wrap.append(section('Card', info));
    wrap.append(section('Notes', notesView(selCard.notes, 'No notes. Edit to add some for you and for agents: which purchases this card is for.')));
    wrap.append(el('p', 'hint', 'Filling it asks you first, with Touch ID or your Mac password: when you use Cobrowser: Fill Card, and every time the agent asks to (it never sees the number, and the pay button stays yours).'));
    const a = el('div', 'actions'); const st = el('div'); st.id = 'status'; a.append(st); wrap.append(a);
  }
  async function saveCard() {
    const fields = { label: cdraft.label, name: cdraft.name, exp: cdraft.exp, notes: cdraft.notes };
    if (cdraft.number.trim()) fields.number = cdraft.number;
    if (cdraft.cvc.trim()) fields.cvc = cdraft.cvc; else if (cdraft.forgetCode) fields.cvc = null;
    try {
      const saved = cardMode === 'edit' ? await vault.updateCard(cdraft.id, fields) : await vault.addCard(fields);
      resetCard(); cardMode = 'view'; cards = await vault.cards(); selCard = cards.find((c) => c.id === saved.id) || null; render();
    } catch (e) { say(failed(e)); }
  }
  function render() {
    paintKinds();
    if (kind === 'cards') renderCards(); else { renderList(); renderDetail(); }
    state();
  }
  async function refresh() {
    if (unlocking) return; unlocking = true; render();
    try { rows = await vault.list(); cards = await vault.cards(); unlocked = true; lastError = ''; } catch (e) { unlocked = false; rows = []; cards = []; lastError = String(e && e.message || e).includes('cancelled') ? '' : failed(e); } finally { unlocking = false; }
    known = await vault.workspaces();
    if (sel) sel = rows.find((r) => r.host === sel.host && r.username === sel.username) || null;
    render();
  }
  const ensureUnlocked = async () => { if (!unlocked) await refresh(); return unlocked; };
  $('q').oninput = renderList;
  $('new').onclick = async () => {
    if (!(await ensureUnlocked())) return;
    if (kind === 'cards') { resetCard(); cardMode = 'add'; selCard = null; } else { mode = 'add'; sel = null; }
    render();
  };
  $('k-logins').onclick = () => { kind = 'logins'; render(); };
  $('k-cards').onclick = () => { kind = 'cards'; render(); };
  const plural = (n, what) => n + ' ' + what + (n === 1 ? '' : 's');
  // Import and Export act on the view that is showing: logins, or cards (a file of their own).
  $('import').onclick = async () => {
    if (!(await ensureUnlocked())) return;
    if (kind === 'logins') { mode = 'import'; sel = null; render(); return; }
    try {
      const r = await vault.importCards(); if (r == null) return;
      cardMode = 'view'; render();
      say('Imported ' + plural(r.count, 'card') + ': ' + r.added + ' new, ' + r.replaced + ' already here (updated)' + (r.skipped ? ', ' + r.skipped + ' skipped as not valid cards.' : '.'));
    } catch (e) { say(failed(e)); }
  };
  $('export').onclick = async () => {
    try {
      const r = kind === 'cards' ? await vault.exportCards() : await vault.exportCsv();
      if (r) say('Exported ' + plural(r.count, kind === 'cards' ? 'card' : 'login') + ' to ' + r.file + '. The file is plain text: keep it safe, or delete it once it is imported elsewhere.');
    } catch (e) { say(failed(e)); }
  };
  const showLocked = () => { unlocked = false; rows = []; sel = null; mode = 'view'; cards = []; selCard = null; cardMode = 'view'; render(); };
  $('lock').onclick = async () => { await vault.lock(); showLocked(); };
  // The vault changed outside this window. A form being filled in keeps what is typed; the
  // lists behind it, and a login or card being looked at, show the vault as it is now.
  vault.onChanged((now) => {
    if (now.locked) { if (unlocked) showLocked(); return; }
    rows = now.logins; cards = now.cards; known = now.workspaces; unlocked = true; lastError = '';
    if (sel) sel = rows.find((r) => r.host === sel.host && r.username === sel.username) || null;
    if (selCard) selCard = cards.find((c) => c.id === selCard.id) || null;
    if (kind === 'logins') { renderList(); if (mode === 'view') renderDetail(); } else if (cardMode === 'view') renderCards();
    state();
  });
  // ↑/↓ move the selection through the list as shown: the filtered logins, or the cards.
  $('list').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = kind === 'cards' ? cards : shown; if (!items.length) return;
    e.preventDefault();
    const at = kind === 'cards' ? items.findIndex((c) => selCard && c.id === selCard.id) : items.indexOf(sel);
    const next = items[Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (kind === 'cards') { selCard = next; cardMode = 'view'; } else { sel = next; mode = 'view'; }
    render();
  });
  vault.workspaces().then((w) => { known = w; });
  render(); refresh();
</script>`;

/** Big enough to see a login and its workspaces at once, without outgrowing the screen. */
function vaultWindowSize() {
  const area = require('electron').screen.getPrimaryDisplay().workAreaSize;
  return { width: Math.min(1180, Math.round(area.width * 0.85)), height: Math.min(860, Math.round(area.height * 0.88)), minWidth: 860, minHeight: 560 };
}

/**
 * Notes are Markdown, shown formatted in the vault window: paragraphs, headings, lists, code,
 * bold, italics and links (web and mail only). Everything is escaped first, so a note can never
 * become markup of its own. Runs in the window (its source is put into the page).
 */
function markdownToHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (raw) => {
    const codes = [];
    let s = esc(raw).replace(/`([^`]+)`/g, (_m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])[*_]([^*_]+)[*_](?![\w*])/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => '<code>' + codes[Number(i)] + '</code>');
  };
  const out = []; let para = []; let list = null; let code = null;
  const flushPara = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
  const flushList = () => { if (list) { out.push('<' + list.tag + '>' + list.items.map((i) => '<li>' + inline(i) + '</li>').join('') + '</' + list.tag + '>'); list = null; } };
  for (const line of String(md || '').split('\n')) {
    if (code) { if (/^```/.test(line)) { out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code = null; } else code.push(line); continue; }
    if (/^```/.test(line)) { flushPara(); flushList(); code = []; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); const n = h[1].length + 3; out.push('<h' + n + '>' + inline(h[2]) + '</h' + n + '>'); continue; }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line), ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) { flushPara(); const tag = ul ? 'ul' : 'ol'; if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; } list.items.push((ul || ol)[1]); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList(); para.push(line);
  }
  if (code) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
  flushPara(); flushList();
  return out.join('');
}

let vaultWin;
function openVaultWindow() {
  if (vaultWin && !vaultWin.isDestroyed()) { vaultWin.show(); vaultWin.focus(); return; }
  const { nativeTheme } = require('electron');
  vaultWin = new BrowserWindow({
    ...vaultWindowSize(), title: 'cobrowser vault', show: false,
    titleBarStyle: 'hiddenInset', backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0c' : '#f4f4f5',
    webPreferences: { preload: path.join(__dirname, 'vault-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  vaultWin.once('ready-to-show', () => { vaultWin.show(); vaultWin.focus(); });
  vaultWin.on('closed', () => { vaultWin = undefined; });
  // A link in someone's notes opens in their browser, never inside the vault window.
  const outside = (url) => { if (/^(https?:|mailto:)/.test(url)) void shell.openExternal(url); };
  vaultWin.webContents.setWindowOpenHandler(({ url }) => { outside(url); return { action: 'deny' }; });
  vaultWin.webContents.on('will-navigate', (e, url) => { e.preventDefault(); outside(url); });
  void vaultWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(VAULT_HTML));
}


ipcMain.handle('vault:list', async () => (await unlockVault('show the logins in the cobrowser vault')).entries.map(publicEntry));
ipcMain.handle('vault:workspaces', () => knownWorkspaces());
// A form's workspaces are a change from the ones it started with (scopeFrom), applied to the
// login as it is when saved: a grant made meanwhile is kept (store.applyScopeChange).
const scopeNow = (host, username, scopeFrom, scope) => {
  const e = findEntry(host, username || '');
  return e && scopeFrom !== undefined ? store.applyScopeChange(e.scope, scopeFrom, scope) : scope;
};
ipcMain.handle('vault:add', async (_e, { host, username, password, scope, scopeFrom, also, notes }) => {
  if (!host) throw new Error('a website is required');
  const exists = !!vault && !!findEntry(host, username || '');
  await confirmFresh(exists ? (password ? `replace the saved password for ${username || 'the login'} on ${host}` : `change the login for ${username || 'the login'} on ${host}`) : `add a login for ${host}`);
  // The form's scope is the one the human chose for this login, so it replaces the old one.
  const r = upsertLogin(host, username || '', password, scopeNow(host, username, scopeFrom, scope), { mergeScope: false, also, notes }); saveVault();
  return { replaced: r.replaced };
});
ipcMain.handle('vault:update', async (_e, { from, site, username, password, scope, scopeFrom, also, notes }) => {
  // Tried on a copy first, as card changes are: a clash with another login is said before
  // Touch ID is asked for, not after.
  if (vault) store.updateLogin(structuredClone(vault), from, { site, username, password: password === null ? null : password || undefined, scope, also, notes });
  await confirmFresh(`change the login for ${from.username || 'the login'} on ${from.host}`);
  // null removes a saved password (the login signs in with a link or a code); empty keeps it.
  updateLogin(from, { site, username, password: password === null ? null : password || undefined, scope: scopeNow(from.host, from.username, scopeFrom, scope), also, notes }); saveVault();
});
ipcMain.handle('vault:setScope', async (_e, { host, username, before, after }) => {
  await confirmFresh(`change which workspaces may use ${username || 'the login'} on ${host}`);
  if (!findEntry(host, username)) throw new Error('that login is no longer in the vault');
  setScope(host, username, scopeNow(host, username, before, after)); saveVault();
});
ipcMain.handle('vault:remove', async (_e, { host, username }) => { await confirmFresh(`remove the login for ${username || 'the login'} on ${host}`); removeLogin(host, username); saveVault(); });
/** How long a copied password stays on the clipboard. Cleared only if it is still there:
 *  anything copied since is the person's and is left alone. */
const CLIPBOARD_CLEAR_MS = (SKIP_BIOMETRICS && Number(process.env.COBROWSER_TEST_CLIPBOARD_MS)) || 90000;
ipcMain.handle('vault:startOver', () => startOverVault());
/** The password last copied, until it leaves the clipboard: after CLIPBOARD_CLEAR_MS, or when
 *  the vault locks or the app quits, whichever comes first. */
let copiedSecret = null;
async function clearCopiedPassword(secret = copiedSecret) {
  if (!secret) return;
  // Awaited: Electron 44's clipboard calls in the main process return promises.
  if ((await clipboard.readText()) === secret) await clipboard.clear();
  if (copiedSecret === secret) copiedSecret = null;
}
ipcMain.handle('vault:copyPassword', async (_e, { secret }) => {
  if (typeof secret !== 'string' || !secret) return;
  await clipboard.writeText(secret);
  copiedSecret = secret;
  setTimeout(() => void clearCopiedPassword(secret), CLIPBOARD_CLEAR_MS);
});
ipcMain.handle('vault:reveal', async (_e, { host, username }) => {
  // Showing a password never rides on the session unlock: a fresh confirmation every time.
  await confirmFresh(`show the password for ${username || host} on ${host}`);
  const e = findEntry(host, username);
  if (!e) throw new Error('no such login');
  if (!e.password) throw new Error('this login has no password');
  log(`vault: revealed password for ${e.username} on ${siteLabel(e)}`);
  return e.password;
});
ipcMain.handle('vault:importCsv', async (_e, { scope } = {}) => {
  const r = await dialog.showOpenDialog(vaultWin, { properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }], title: 'Import logins (Apple Passwords / Bitwarden / Chrome export)' });
  if (r.canceled || !r.filePaths[0]) return null;
  const text = fs.readFileSync(r.filePaths[0], 'utf8');
  store.importCsv({ entries: [] }, text, scope); // a file that cannot be read is said before Touch ID
  await confirmFresh('import logins from a CSV file');
  const res = importCsv(text, scope); saveVault();
  await offerToTrashCsv(r.filePaths[0], `Imported ${res.count} login${res.count === 1 ? '' : 's'} (${res.added} new, ${res.replaced} replaced)${res.skipped ? `; ${res.skipped} row${res.skipped === 1 ? '' : 's'} skipped, with no website or neither a username nor a password` : ''}.`, res.skipped ? 'Some rows were not imported: keep the file to check them. It holds the passwords in plain text.' : 'The CSV holds the passwords in plain text. Move it to the Trash?');
  return res;
});
ipcMain.handle('vault:exportCsv', () => exportVault(vaultWin));
ipcMain.handle('vault:exportCards', () => exportCards(vaultWin));
ipcMain.handle('vault:importCards', async () => {
  let file = SKIP_BIOMETRICS ? process.env.COBROWSER_TEST_IMPORT_PATH : undefined;
  if (!file) {
    const r = await dialog.showOpenDialog(vaultWin, { properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }], title: 'Import cards (a cobrowser cards export)' });
    if (r.canceled || !r.filePaths[0]) return null;
    file = r.filePaths[0];
  }
  const text = fs.readFileSync(file, 'utf8');
  store.importCards({ cards: [] }, text); // a file that cannot be read is said before Touch ID
  await confirmFresh('import cards from a CSV file');
  const res = store.importCards(vault, text); saveVault();
  log(`vault: imported ${res.count} card(s) (${res.added} new, ${res.replaced} replaced, ${res.skipped} skipped)`);
  if (!SKIP_BIOMETRICS) {
    await offerToTrashCsv(file, `Imported ${res.count} card${res.count === 1 ? '' : 's'} (${res.added} new, ${res.replaced} updated${res.skipped ? `, ${res.skipped} not valid cards, skipped` : ''}).`, 'The CSV holds the card numbers and codes in plain text. Move it to the Trash?');
  }
  return res;
});
ipcMain.handle('vault:lock', () => lockVault());
ipcMain.handle('vault:cards', async () => ((await unlockVault('show the cards in the cobrowser vault')).cards || []).map(store.publicCard));
// Each card change is first tried on a copy, so a mistyped number, a bad expiry or a card
// already saved is said before Touch ID is asked for, not after.
ipcMain.handle('vault:addCard', async (_e, fields) => {
  if (vault) store.addCard(structuredClone(vault), fields || {});
  await confirmFresh('add a card to the cobrowser vault');
  const c = store.addCard(vault, fields || {}); saveVault();
  return store.publicCard(c);
});
ipcMain.handle('vault:updateCard', async (_e, { id, ...fields }) => {
  if (vault) store.updateCard(structuredClone(vault), id, fields);
  await confirmFresh('change a card in the cobrowser vault');
  const c = store.updateCard(vault, id, fields); saveVault();
  return store.publicCard(c);
});
ipcMain.handle('vault:removeCard', async (_e, { id }) => {
  await confirmFresh('remove a card from the cobrowser vault');
  store.removeCard(vault, id); saveVault();
});

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

// ---------------------------------------------------------------------------------------
// Certificate warnings and login boxes. Both are asked of the human the way Chrome asks.
// ---------------------------------------------------------------------------------------
/** Workspace + host + certificate → allowed, for this app session. Each workspace is its own
 *  browser (Chromium's own memory of it is per partition too). */
const certDecisions = new Map();
const pendingCert = new Map();
app.on('certificate-error', (event, contents, url, error, certificate, callback) => {
  event.preventDefault();
  let host = '';
  try { host = new URL(url).host; } catch { /* keep */ }
  const tab = tabOf(contents);
  const key = `${tab?.workspace.id || ''}|${host}|${certificate.fingerprint}`;
  if (certDecisions.has(key)) return callback(certDecisions.get(key));
  // Only what the human navigated to gets a question: a bad certificate on an embedded
  // resource of another host is just refused, as Chrome does.
  let pageHost = '';
  try { pageHost = new URL(contents.getURL()).host; } catch { /* keep */ }
  if (pageHost && pageHost !== host) { log(`certificate refused for ${host} (embedded in ${pageHost}): ${error}`); return callback(false); }
  if (TEST_CERT !== undefined) {
    const ok = TEST_CERT === 'accept';
    log(`certificate: TEST MODE — ${host} ${error} → ${ok ? 'accept' : 'reject'}`);
    certDecisions.set(key, ok);
    return callback(ok);
  }
  if (pendingCert.has(key)) { pendingCert.get(key).push(callback); return; }
  pendingCert.set(key, [callback]);
  if (tab) tab.pendingDialogs++;
  focusApp();
  dialog.showMessageBox({
    type: 'warning',
    message: `Your connection to ${host} is not private`,
    detail: `${error.replace(/^net::/, '')}\n\nThe certificate is for "${certificate.subjectName}", issued by "${certificate.issuerName}". This is normal for a device on your own network; on the internet it can mean someone is intercepting the connection. Proceeding allows it for ${host}${tab ? ` in the ${path.basename(tab.workspace.id)} workspace` : ''} until cobrowser quits.`,
    buttons: ['Proceed anyway', 'Go back'], defaultId: 1, cancelId: 1,
  }).then(({ response }) => {
    const ok = response === 0;
    certDecisions.set(key, ok);
    log(`certificate for ${host}: ${ok ? 'accepted' : 'rejected'} (${error})`);
    for (const cb of pendingCert.get(key) || []) cb(ok);
  }).catch(() => { for (const cb of pendingCert.get(key) || []) cb(false); })
    .finally(() => { pendingCert.delete(key); if (tab) tab.pendingDialogs--; });
});

/** A page asked for a username and password with the browser's own login box. */
app.on('login', (event, contents, details, authInfo, callback) => {
  event.preventDefault();
  if (TEST_LOGIN !== undefined) {
    log(`login: TEST MODE — ${authInfo.host} answered ${TEST_LOGIN ? 'with credentials' : 'cancel'}`);
    const i = TEST_LOGIN.indexOf(':');
    return TEST_LOGIN ? callback(TEST_LOGIN.slice(0, i), TEST_LOGIN.slice(i + 1)) : callback();
  }
  const tab = tabOf(contents);
  if (tab) tab.pendingDialogs++;
  const where = authInfo.isProxy ? `The proxy ${authInfo.host}` : `${authInfo.host}${authInfo.port && authInfo.port !== 80 && authInfo.port !== 443 ? ':' + authInfo.port : ''}`;
  loginWindow(where, authInfo.realm).then((c) => {
    if (c) callback(c.username, c.password); else callback();
  }).catch(() => callback()).finally(() => { if (tab) tab.pendingDialogs--; });
});

function loginWindow(where, realm) {
  return new Promise((resolve) => {
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const html = `<!doctype html><meta charset="utf-8"><title>Sign in to ${esc(where)}</title>
<style>:root{color-scheme:light dark}body{font:13px -apple-system,system-ui;margin:18px 20px}h1{font-size:13px;font-weight:600;margin:0 0 4px}p{margin:0 0 12px;color:GrayText}
label{display:block;margin:8px 0 3px}input{width:100%;box-sizing:border-box;font:inherit;padding:5px 7px}div{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}button{font:inherit;padding:4px 14px}</style>
<h1>Sign in to ${esc(where)}</h1><p>${realm ? esc(realm) : 'This site asks for a username and password.'}</p>
<form id="f"><label for="u">Username</label><input id="u" autocomplete="username"><label for="p">Password</label><input id="p" type="password" autocomplete="current-password">
<div><button type="button" id="c">Cancel</button><button>Sign in</button></div></form>
<script>document.getElementById('u').focus();
document.getElementById('f').onsubmit=(e)=>{e.preventDefault();document.title='ok:'+JSON.stringify([document.getElementById('u').value,document.getElementById('p').value])};
document.getElementById('c').onclick=()=>{document.title='cancel'};addEventListener('keydown',(e)=>{if(e.key==='Escape')document.title='cancel'});</script>`;
    const win = new BrowserWindow({ width: 420, height: 250, show: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, alwaysOnTop: true, title: `Sign in to ${where}`, webPreferences: { sandbox: true, contextIsolation: true } });
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; resolve(v); if (!win.isDestroyed()) win.close(); };
    win.on('page-title-updated', (e, title) => {
      e.preventDefault();
      if (title.startsWith('ok:')) { try { const [username, password] = JSON.parse(title.slice(3)); finish({ username, password }); } catch { finish(null); } }
      else if (title === 'cancel') finish(null);
    });
    win.on('closed', () => finish(null));
    win.once('ready-to-show', () => { focusApp(); win.show(); });
    void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

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
    /** Which agent's task the tab belongs to, when agents work in parallel (new_page owner). */
    this.owner = typeof opts.owner === 'string' && opts.owner ? opts.owner.slice(0, 60) : undefined;
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
    /** Files the human allowed the agent to upload, for the next file picker (armUpload). */
    this.armedUpload = null;
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
      // A page's requestFullscreen() would otherwise take the whole display for a window
      // that is not even on screen (measured). Not fullscreenable, the page still enters
      // fullscreen — filling the tab, which is the panel — and nothing appears.
      fullscreenable: false,
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
    // A page that could not load: Electron leaves a blank document, so write an error page
    // into it (the address stays the one that failed), for the human and for the agent's reads.
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3: aborted, e.g. a new navigation replaced it
      wc.executeJavaScript(errorPageScript(url, description)).catch(() => undefined);
    });
    // Fullscreen is the tab itself; the panel hides its toolbar while it lasts, and Escape
    // leaves it (see routeHuman), as in Chrome.
    this.htmlFullscreen = false;
    wc.on('enter-html-full-screen', () => { this.htmlFullscreen = true; workspace.broadcast({ type: 'fullscreen', tabId: this.id, on: true }); });
    wc.on('leave-html-full-screen', () => { this.htmlFullscreen = false; workspace.broadcast({ type: 'fullscreen', tabId: this.id, on: false }); });
    wc.on('did-navigate', () => { if (this.htmlFullscreen) { this.htmlFullscreen = false; workspace.broadcast({ type: 'fullscreen', tabId: this.id, on: false }); } });
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
    // "Leave this site?" Electron wants the answer synchronously, and a synchronous dialog
    // freezes the whole app (every tab, every agent) until someone answers it. So for a
    // navigation of ours (address bar, back/forward/reload, an agent's navigate) the page
    // stays for now, the question is asked without blocking, and Leave redoes the navigation.
    // One the page starts itself (a link clicked in it) cannot be redone, so it just leaves.
    this.leaving = false;
    this.navIntent = undefined;
    wc.on('will-prevent-unload', (event) => {
      if (this.leaving) { this.leaving = false; event.preventDefault(); return; }
      const redo = this.navIntent;
      if (!redo) { log(`tab ${this.id}: left ${hostOf(wc.getURL())} despite its unsaved-changes prompt (a navigation the page started)`); event.preventDefault(); return; }
      if (this.askingToLeave) return; // already asking; stay until answered
      this.askingToLeave = true;
      this.pendingDialogs++;
      // Test instances answer as told, through the same stay-then-redo path.
      const ask = TEST_DIALOG !== undefined
        ? Promise.resolve({ response: TEST_DIALOG === 'accept' ? 0 : 1 })
        : (focusApp(), dialog.showMessageBox({ type: 'question', message: 'Leave this site?', detail: `${hostOf(wc.getURL())}: changes you made may not be saved.`, buttons: ['Leave', 'Stay'], defaultId: 1, cancelId: 1 }));
      ask
        .then(({ response }) => {
          // Redo once Chromium has finished cancelling the navigation the page held up.
          if (response === 0) setTimeout(() => { if (!wc.isDestroyed()) { this.leaving = true; redo(); } }, 100);
        })
        .catch(() => undefined)
        .finally(() => { this.askingToLeave = false; this.pendingDialogs--; });
    });
    wc.on('destroyed', () => workspace.onTabGone(this));
    this.win.on('closed', () => workspace.onTabGone(this));
    void wc.loadURL(url || 'about:blank');
  }

  /** Paint at full rate while a panel shows the tab or something is acting on it, once a
   *  second otherwise. */
  setWatched() {
    if (this.win.isDestroyed()) return; // a boost timer can outlive its tab
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
    // The agent's upload_file, already confirmed by the human: those files, no picker.
    const armed = this.armedUpload;
    if (armed && !armed.taken && Date.now() < armed.until) {
      armed.taken = true;
      if (mode !== 'selectMultiple' && armed.files.length > 1) {
        return void armed.settle({ error: `this file picker takes one file and ${armed.files.length} were given: upload them one at a time, or find the input that takes several` });
      }
      try {
        await this.win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { files: armed.files, backendNodeId }, sessionId);
        const names = armed.files.map((f) => path.basename(f));
        const host = hostOf(this.win.webContents.getURL());
        // Nobody was asked: say what went where, so no upload happens unseen.
        if (armed.notifyFor !== undefined && Notification.isSupported()) {
          new Notification({ title: `Uploaded to ${host}`, body: `${names.join(', ')}, by the agent in "${armed.notifyFor}"`, silent: true }).show();
        }
        armed.settle({ uploaded: names, host });
      } catch (e) {
        log(`tab ${this.id}: upload: ${e.message}`);
        armed.settle({ error: `the page's file input did not take the files: ${e.message}` });
      }
      return;
    }
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

  /** Hold confirmed files for the next file picker this tab opens. They lapse after a few
   *  seconds, so a picker the human opens later asks them as always. */
  armUpload(files, notifyFor) {
    this.armedUpload?.settle({ error: 'replaced by a newer upload' });
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    this.armedUpload = { files, until: Date.now() + UPLOAD_ARM_MS, taken: false, notifyFor, settle, done };
  }

  /** What became of the armed files: given to a picker, refused by it, or no picker opened. */
  async uploadOutcome(waitMs) {
    const armed = this.armedUpload;
    if (!armed) return { error: 'no upload is waiting on this tab' };
    let timer;
    const r = await Promise.race([armed.done, new Promise((resolve) => { timer = setTimeout(() => resolve({ error: 'no file picker opened', noPicker: true }), waitMs); })]);
    clearTimeout(timer);
    if (this.armedUpload === armed) this.armedUpload = null;
    return r;
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
      let intent;
      const finish = (extra) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.navIntent === intent) this.navIntent = undefined;
        wc.off('dom-ready', ok); wc.off('did-navigate-in-page', inPage); wc.off('did-fail-load', fail);
        resolve({ url: wc.isDestroyed() ? '' : wc.getURL(), title: wc.isDestroyed() ? '' : wc.getTitle(), ...extra });
      };
      const ok = () => finish({});
      const inPage = (_e, _u, isMain) => { if (isMain) finish({}); };
      // -3 is ERR_ABORTED: a navigation superseded by another, or a download — not a failure.
      const fail = (_e, code, desc, _u, isMain) => { if (isMain && code !== -3) finish({ error: `${desc || 'load failed'} (${code})` }); };
      wc.on('dom-ready', ok); wc.on('did-navigate-in-page', inPage); wc.on('did-fail-load', fail);
      const timer = setTimeout(() => finish({ timedOut: true }), timeout);
      const start = () => {
        if (kind === 'url') wc.loadURL(url).catch(() => undefined); // failures arrive as did-fail-load
        else if (kind === 'reload') wc.reload();
        else {
          const h = wc.navigationHistory;
          const can = kind === 'back' ? h.canGoBack() : h.canGoForward();
          if (!can) return finish({ noop: true });
          if (kind === 'back') h.goBack(); else h.goForward();
        }
      };
      // If the page asks "Leave this site?", this is what Leave redoes (will-prevent-unload).
      intent = () => { try { start(); } catch (e) { finish({ error: e.message }); } };
      this.navIntent = intent;
      try {
        start();
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
        // Date, time and color inputs open a picker popup, which an offscreen page cannot
        // show either (measured: the field focuses and nothing appears), like a select's list.
        const PICKERS = ['date', 'time', 'datetime-local', 'month', 'week', 'color'];
        if (el && el.tagName === 'INPUT' && PICKERS.includes(el.type) && !el.disabled && !el.readOnly) {
          window.__cobrowserPicker = el;
          el.focus();
          const r = el.getBoundingClientRect();
          return { picker: { type: el.type, value: el.value, min: el.min, max: el.max, step: el.step }, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
        }
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

  /** Apply a picker's value to the page's input, through the native setter so frameworks'
   *  value tracking sees it, with the events they listen for. */
  applyPicker(value) {
    return this.win.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: `(() => { const el = window.__cobrowserPicker; if (!el) return false;
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(String(value))});
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
      returnByValue: true,
    }, this.selectSession).catch(() => undefined);
  }

  /** The page's date/time/color control, shown in a small real window of the app's own at the
   *  cursor, where Chromium's picker popup works; the choice goes back into the page. */
  popupPicker({ picker }) {
    const test = SKIP_BIOMETRICS ? process.env.COBROWSER_TEST_PICKER_VALUE : undefined;
    if (test !== undefined) { log(`tab ${this.id}: TEST MODE — ${picker.type} picker answered ${test}`); return this.applyPicker(test); }
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const attr = (k) => (picker[k] ? ` ${k}="${esc(picker[k])}"` : '');
    const html = `<!doctype html><meta charset="utf-8"><title>Choose</title>
<style>:root{color-scheme:light dark}body{font:13px -apple-system,system-ui;margin:14px 16px}input{font:inherit;width:100%;box-sizing:border-box;padding:5px 7px}input[type=color]{height:36px;padding:2px}
div{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}button{font:inherit;padding:4px 14px}</style>
<form id="f"><input id="i" type="${esc(picker.type)}" value="${esc(picker.value)}"${attr('min')}${attr('max')}${attr('step')}><div><button type="button" id="c">Cancel</button><button>OK</button></div></form>
<script>const i=document.getElementById('i');i.focus();
document.getElementById('f').onsubmit=(e)=>{e.preventDefault();document.title='ok:'+i.value};
document.getElementById('c').onclick=()=>{document.title='cancel'};addEventListener('keydown',(e)=>{if(e.key==='Escape')document.title='cancel'});</script>`;
    const { screen } = require('electron');
    const pt = screen.getCursorScreenPoint();
    const win = new BrowserWindow({ x: pt.x, y: pt.y, width: 300, height: picker.type === 'color' ? 120 : 110, show: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, alwaysOnTop: true, title: 'Choose', webPreferences: { sandbox: true, contextIsolation: true } });
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; if (v !== null) void this.applyPicker(v); if (!win.isDestroyed()) win.close(); };
    win.on('page-title-updated', (e, title) => { e.preventDefault(); if (title.startsWith('ok:')) finish(title.slice(3)); else if (title === 'cancel') finish(null); });
    win.on('closed', () => finish(null));
    win.once('ready-to-show', () => { focusApp(); win.show(); });
    void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
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
    // Escape leaves fullscreen (the browser's key, not the page's).
    if (this.htmlFullscreen && method === 'Input.dispatchKeyEvent' && params.key === 'Escape') {
      if (params.type === 'keyDown' || params.type === 'rawKeyDown') {
        return { dispatched: dbg.sendCommand('Runtime.evaluate', { expression: 'document.exitFullscreen && document.exitFullscreen(); 0', returnByValue: true }, this.inputSession).catch(() => undefined) };
      }
      return { dispatched: Promise.resolve({}) };
    }
    if (method === 'Input.dispatchMouseEvent') {
      const r = await this.routePoint(params.x, params.y);
      if (params.button === 'left' && params.type === 'mousePressed') {
        const sel = await this.selectAt(r.x, r.y, r.sessionId).catch(() => null);
        if (sel) {
          this.swallowRelease = true;
          if (sel.picker) this.popupPicker(sel); else this.popupSelect(sel, { x: r.x, y: r.y });
          return { dispatched: Promise.resolve({ selectMenu: true }) };
        }
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
    return { tabId: this.id, url: wc.isDestroyed() ? '' : wc.getURL(), title: wc.isDestroyed() ? '' : wc.getTitle(), by: this.by, ...(this.owner ? { owner: this.owner } : {}), ...(this.opener ? { opener: this.opener } : {}) };
  }

  close() {
    this.subscribers.clear();
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}

/** A workspace's browser profile: its session partition, and where that lives on disk. */
function partitionOf(id) {
  const name = `ws-${crypto.createHash('sha1').update(id).digest('hex').slice(0, 16)}`;
  return { partition: `persist:${name}`, dir: path.join(DATA_DIR, 'Partitions', name) };
}

/** Everything a workspace's browser kept: cookies and sign-ins, site storage, cache. */
async function clearBrowsingData(ses) {
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.clearAuthCache();
  await ses.clearHostResolverCache();
}

/**
 * Forget a workspace: its tabs, browsing data, site permissions and certificate exceptions,
 * and its place in the list. Its logins stay in the vault (a login may be allowed in several
 * workspaces; the vault window changes that). Refused while an editor window has it open.
 */
async function forgetWorkspace(id) {
  const w = workspaces.get(id);
  if (w && w.sockets.size) throw new Error(`${path.basename(id)} is open in an editor window; use Clear Browsing Data there instead`);
  if (w) {
    w.closeAll();
    await clearBrowsingData(session.fromPartition(w.partition));
    workspaces.delete(id);
  } else {
    // Never loaded since the app started, so no session holds the files: remove them.
    fs.rmSync(partitionOf(id).dir, { recursive: true, force: true });
  }
  sitePermissions.dropWorkspace(loadPermissions(), id); savePermissions();
  for (const k of [...certDecisions.keys()]) if (k.startsWith(id + '|')) certDecisions.delete(k);
  const list = knownWorkspaces().filter((x) => x !== id);
  fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(list, null, 2));
  vaultChanged();
  // Its editor still has the tab list it saved; the next time that folder connects it is told
  // to start fresh instead of reopening them (see hello).
  writeForgotten([...new Set([...readForgotten(), id])]);
  log(`forgot workspace ${id}`);
}
const FORGOTTEN_FILE = path.join(DATA_DIR, 'forgotten.json');
function readForgotten() {
  try { return JSON.parse(fs.readFileSync(FORGOTTEN_FILE, 'utf8')); } catch { return []; }
}
function writeForgotten(list) {
  try { fs.writeFileSync(FORGOTTEN_FILE, JSON.stringify(list, null, 2)); } catch { /* best effort */ }
}

/** The error page written into a tab whose page could not load (see did-fail-load). */
function errorPageScript(url, error) {
  let host = url;
  try { host = new URL(url).host || url; } catch { /* keep */ }
  const code = String(error || 'ERR_FAILED').replace(/^net::/, '');
  const local = /^(localhost|127\.|\[::1\]|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local(host)?(:|$)/.test(host);
  const why = {
    ERR_CONNECTION_REFUSED: `${host} refused to connect.`,
    ERR_NAME_NOT_RESOLVED: `${host}'s address could not be found.`,
    ERR_INTERNET_DISCONNECTED: 'You are not connected to the internet.',
    ERR_CONNECTION_TIMED_OUT: `${host} took too long to respond.`,
    ERR_TIMED_OUT: `${host} took too long to respond.`,
    ERR_SSL_PROTOCOL_ERROR: `${host} sent a response that is not HTTPS.`,
    ERR_CONNECTION_RESET: 'The connection was reset.',
    ERR_ADDRESS_UNREACHABLE: `${host} is unreachable.`,
  }[code] || `${host} could not be loaded.`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const plain = 'http://' + url.slice('https://'.length);
  const hint = code === 'ERR_SSL_PROTOCOL_ERROR' && url.startsWith('https://')
    ? `If it serves plain HTTP (most development servers do), try <a href="${esc(plain)}">${esc(plain)}</a>.`
    : code === 'ERR_CONNECTION_REFUSED' && local ? 'Is the server running, and on this port?' : '';
  const html = `<head><meta charset="utf-8"><title>${esc(host)}</title><style>
    :root{color-scheme:light dark} body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;color:CanvasText;background:Canvas}
    main{max-width:560px;padding:32px} h1{font-size:22px;font-weight:600;margin:0 0 8px} p{margin:6px 0;opacity:.85} code{font:12px ui-monospace,Menlo,monospace;opacity:.6} button{margin-top:16px;font:inherit;padding:6px 14px;border-radius:6px;border:1px solid #8886;background:transparent;color:inherit;cursor:pointer}
  </style></head><body><main><h1>This site can't be reached</h1><p>${esc(why)}</p>${hint ? `<p>${hint}</p>` : ''}<p><code>${esc(code)} · ${esc(url)}</code></p><button onclick="location.reload()">Try again</button></main></body>`;
  return `document.documentElement.innerHTML = ${JSON.stringify(html)}; 0`;
}

class Workspace {
  constructor(id) {
    this.id = id;
    this.partition = partitionOf(id).partition;
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
      return permissionDecision(id, origin, permission, details) === true;
    });
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (AUTO_ALLOW.has(permission)) return callback(true);
      const origin = details?.requestingUrl ? new URL(details.requestingUrl).origin : (wc && !wc.isDestroyed() ? new URL(wc.getURL()).origin : '');
      if (!origin || origin === 'null') return callback(false);
      const decided = permissionDecision(id, origin, permission, details);
      if (typeof decided === 'boolean') return callback(decided);
      askPermission(id, origin, permission, details).then(callback, () => callback(false));
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
    // Forgotten since it last connected: its editor drops the tabs it saved (said once).
    const pending = readForgotten();
    const forgotten = pending.includes(m.workspace);
    if (forgotten) writeForgotten(pending.filter((x) => x !== m.workspace));
    const tabs = [];
    for (const t of state.workspace.tabs.values()) { await t.ready; tabs.push(t.info()); }
    ws.send(JSON.stringify({ type: 'hello', version: VERSION, tabs, ...(forgotten ? { forgotten: true } : {}) }));
    return;
  }
  if (typeof m.type === 'string' && m.type.startsWith('vault.')) {
    const reply = (obj) => ws.send(JSON.stringify({ ...obj, requestId: m.requestId }));
    try {
      switch (m.type) {
        // Added over the socket, a login defaults to the calling workspace's scope.
        case 'vault.add': {
          const exists = !!vault && !!findEntry(m.host, m.username || '');
          await confirmFresh(exists ? (m.password ? `replace the saved password for ${m.username || 'the login'} on ${m.host}` : `change the login for ${m.username || 'the login'} on ${m.host}`) : `add a login for ${m.host}`);
          // From a command: widen the login's scope to this workspace, never narrow it.
          const r = upsertLogin(m.host, m.username || '', m.password, m.scope ?? [state.workspace?.id].filter(Boolean), { mergeScope: true, also: m.also, notes: m.notes }); saveVault();
          return reply({ ok: true, replaced: r.replaced });
        }
        case 'vault.export': { const r = await exportVault(); return reply(r ? { ok: true, ...r } : { ok: false, canceled: true }); }
        case 'vault.import': { const scope = m.scope ?? [state.workspace?.id].filter(Boolean); store.importCsv({ entries: [] }, String(m.csv || ''), scope); await confirmFresh('import logins from a CSV file'); const r = importCsv(String(m.csv || ''), scope); saveVault(); return reply({ ok: true, count: r.count, added: r.added, replaced: r.replaced, skipped: r.skipped }); }
        case 'vault.list': {
          const v = await unlockVault('list the logins in the cobrowser vault');
          const wsId = state.workspace?.id;
          return reply({ logins: v.entries.filter((e) => wsId && allowed(e, wsId)).map((e) => ({ host: siteLabel(e), ...(e.also && e.also.length ? { alsoOn: e.also.map(siteLabel) } : {}), username: e.username, ...(e.password ? {} : { noPassword: true }), ...(e.notes ? { notes: e.notes } : {}) })) });
        }
        case 'vault.lock': { lockVault(); return reply({ ok: true }); }
        case 'vault.open': { focusApp(); openVaultWindow(); return reply({ ok: true }); }
        // Test instances only: drive the vault window and photograph it, for the UI suite.
        case 'vault.window': {
          if (!SKIP_BIOMETRICS) return reply({ error: 'not available' });
          openVaultWindow();
          const wc = vaultWin.webContents;
          if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r));
          await new Promise((r) => setTimeout(r, 400));
          const value = m.script ? await wc.executeJavaScript(String(m.script)) : undefined;
          await new Promise((r) => setTimeout(r, Number(m.wait) || 400));
          const [width, height] = vaultWin.getSize();
          const png = m.capture ? (await wc.capturePage()).toPNG().toString('base64') : undefined;
          return reply({ value, width, height, png });
        }
        case 'vault.addCard': {
          if (vault) store.addCard(structuredClone(vault), m.card || {}); // mistakes before Touch ID
          await confirmFresh('add a card to the cobrowser vault');
          const c = store.addCard(vault, m.card || {}); saveVault();
          return reply({ card: store.publicCard(c) });
        }
        case 'vault.cards': {
          // forFill: Cobrowser: Fill Card picking a card; an unlock here confirms that fill.
          const wasLocked = !vault;
          const v = await unlockVault(m.forFill ? 'fill a saved card into the page in front of you' : 'list the cards in the cobrowser vault');
          if (wasLocked && m.forFill) fillUnlockAt = Date.now();
          return reply({ cards: (v.cards || []).map(store.publicCard) });
        }
        case 'vault.fillCard': {
          const tab = state.workspace?.tabs.get(m.tabId);
          if (!tab) return reply({ filled: [], error: 'no such tab in this workspace' });
          return reply(await fillCard(tab, { card: m.card, by: m.by === 'agent' ? 'agent' : 'human', workspaceName: path.basename(state.workspace.id) }));
        }
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
  // The human's housekeeping from the editor: site permissions, browsing data, workspaces.
  if (typeof m.type === 'string' && m.type.startsWith('profile.')) {
    const reply = (obj) => ws.send(JSON.stringify({ ...obj, requestId: m.requestId }));
    const w = state.workspace;
    try {
      switch (m.type) {
        case 'profile.permissions': {
          if (!w) return reply({ error: 'no workspace' });
          return reply({ permissions: sitePermissions.list(loadPermissions(), w.id).map((p) => ({ ...p, label: permissionVerb(p.permission, p.kind) })) });
        }
        case 'profile.forgetPermissions': {
          if (!w) return reply({ error: 'no workspace' });
          const n = sitePermissions.forget(loadPermissions(), w.id, Array.isArray(m.keys) ? m.keys.map(String) : []); savePermissions();
          return reply({ forgotten: n });
        }
        case 'profile.clearBrowsingData': {
          if (!w) return reply({ error: 'no workspace' });
          await clearBrowsingData(session.fromPartition(w.partition));
          log(`cleared browsing data for ${w.id}`);
          return reply({ ok: true });
        }
        case 'profile.workspaces': {
          return reply({ workspaces: knownWorkspaces().map((id) => ({ id, tabs: workspaces.get(id)?.tabs.size || 0, open: (workspaces.get(id)?.sockets.size || 0) > 0 })) });
        }
        case 'profile.forgetWorkspace': {
          if (!knownWorkspaces().includes(String(m.id))) return reply({ error: 'no such workspace' });
          await forgetWorkspace(String(m.id));
          return reply({ ok: true });
        }
        default: return reply({ error: `unknown ${m.type}` });
      }
    } catch (e) {
      log('profile', m.type, e);
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
      // Files reach a page only through a picker: the human's, or upload_file after the human
      // confirmed the paths (upload.arm). Never straight from the editor.
      if (m.method === 'DOM.setFileInputFiles') return reply({ error: 'DOM.setFileInputFiles is refused: upload files with upload_file' });
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
    case 'upload.arm': {
      const t = w.tabs.get(m.tabId);
      const reply = (obj) => ws.send(JSON.stringify({ ...obj, requestId: m.requestId }));
      if (!t || t.win.isDestroyed()) return reply({ error: 'no such tab in this workspace' });
      try { return reply(await confirmUpload(t, m.files, path.basename(w.id) || w.id, m.ask !== false)); } catch (e) { return reply({ error: e.message || String(e) }); }
    }
    case 'upload.outcome': {
      const t = w.tabs.get(m.tabId);
      const reply = (obj) => ws.send(JSON.stringify({ ...obj, requestId: m.requestId }));
      if (!t || t.win.isDestroyed()) return reply({ error: 'no such tab in this workspace' });
      return reply(await t.uploadOutcome(Math.min(Math.max(Number(m.wait ?? 5000) || 0, 0), 30000)));
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
    case 'markTab': {
      const t = w.tabs.get(m.tabId);
      if (t) { t.by = m.by === 'agent' ? 'agent' : 'human'; if (typeof m.owner === 'string' && m.owner) t.owner = m.owner.slice(0, 60); }
      return;
    }
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
  tray.setToolTip(process.env.COBROWSER_DEV === '1' ? 'cobrowser (development)' : 'cobrowser');
  if (icon.isEmpty()) tray.setTitle('cb');
  const refresh = () => {
    const items = [{ label: `cobrowser ${VERSION}`, enabled: false }, { type: 'separator' }];
    for (const w of workspaces.values()) {
      items.push({ label: `${path.basename(w.id)} — ${w.tabs.size} tab${w.tabs.size === 1 ? '' : 's'}`, enabled: false });
    }
    if (workspaces.size) items.push({ type: 'separator' });
    const n = (k, what) => `${k} ${what}${k === 1 ? '' : 's'}`;
    items.push({ label: vault ? `Vault: unlocked, ${n(vault.entries.length, 'login')}, ${n((vault.cards || []).length, 'card')}` : 'Vault: locked', enabled: false });
    items.push({ label: 'Vault…', click: () => openVaultWindow() });
    if (vault) items.push({ label: 'Lock Vault', click: () => lockVault() });
    items.push({ type: 'separator' });
    items.push({ label: 'Quit cobrowser', click: () => app.quit() });
    tray.setContextMenu(Menu.buildFromTemplate(items));
  };
  refresh();
  setInterval(refresh, 2000);
  return tray;
}

app.whenReady().then(async () => {
  // What an older version left in the data folder, converted once, before it is read.
  const migrated = appMigrations.runMigrations({ dataDir: DATA_DIR, knownWorkspaces, log });
  if (migrated.length) log(`migrations: ${migrated.join(', ')}`);
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
  app.on('will-quit', () => { try { if (Number(fs.readFileSync(APP_LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(APP_LOCK); } catch { /* fine */ } });
});

app.on('window-all-closed', () => { /* menu-bar app: stay alive with zero tabs */ });

// Quitting closes every tab window, and each close reaches the editors as a tab closing. Say
// so first: without this, an editor took a quit (menu bar, or an update replacing the app)
// for the human closing every tab, saved an empty tab list, and never restored them.
// Sent before any window closes, on the same sockets, so it arrives ahead of those closes.
let quitAnnounced = false;
function announceQuit() {
  if (quitAnnounced) return;
  quitAnnounced = true;
  for (const w of workspaces.values()) w.broadcast({ type: 'quitting' });
}
app.on('before-quit', announceQuit);
// A password copied from the vault does not outlive the app: the quit waits for it to be
// cleared (the clipboard's calls are asynchronous), then goes on.
app.on('before-quit', (e) => {
  if (!copiedSecret) return;
  e.preventDefault();
  void clearCopiedPassword().finally(() => app.quit());
});
// The extension replaces the app with SIGTERM; make that a normal quit, announced.
process.on('SIGTERM', () => { announceQuit(); app.quit(); });
