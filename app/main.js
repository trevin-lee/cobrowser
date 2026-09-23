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
const { app, BrowserWindow, Tray, Menu, nativeImage, session, safeStorage, systemPreferences } = require('electron');
const { WebSocketServer } = require('ws');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const STATE_DIR = path.join(os.homedir(), '.cobrowser');
const STATE_FILE = path.join(STATE_DIR, 'app.json');
const JPEG_QUALITY = 80;
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

async function unlockVault(reason) {
  if (vault) return vault;
  if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
    await systemPreferences.promptTouchID(reason || 'unlock the cobrowser vault'); // rejects on cancel/failure
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

/** Registrable-domain match, the way password managers pair logins with sites: the last two
 *  labels must agree (costco.com ↔ signin.costco.com). Two-part public suffixes (co.uk) are
 *  matched too loosely by this; acceptable for a personal vault, noted as a limitation. */
function sameSite(a, b) {
  const key = (h) => String(h || '').toLowerCase().replace(/^www\./, '').split('.').slice(-2).join('.');
  return key(a) === key(b);
}
function hostOf(u) { try { return new URL(u).hostname; } catch { return String(u || '').replace(/^https?:\/\//, '').split('/')[0]; } }

function upsertLogin(host, username, password) {
  host = hostOf(host);
  const existing = vault.entries.find((e) => e.host === host && e.username === username);
  if (existing) { existing.password = password; existing.updatedAt = Date.now(); return existing; }
  const e = { id: crypto.randomBytes(6).toString('hex'), host, username, password, updatedAt: Date.now() };
  vault.entries.push(e);
  return e;
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
function importCsv(text) {
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
    upsertLogin(url, user || '', pass); n++;
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
  const host = hostOf(tab.win.webContents.getURL());
  let matches = v.entries.filter((e) => sameSite(e.host, host));
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

const workspaces = new Map(); // workspace path -> Workspace
let nextTabId = 1;

class Tab {
  constructor(workspace, { url, width, height }) {
    this.workspace = workspace;
    this.id = `t${nextTabId++}`;
    this.subscribers = new Set(); // sockets receiving frames
    this.targetId = undefined;
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
    // A page opening a window (target=_blank, window.open) gets a real tab of its own, which
    // the editor adopts through puppeteer's targetcreated exactly like a Chrome popup.
    wc.setWindowOpenHandler(({ url: u }) => {
      const [w, h] = this.win.getContentSize();
      const t = workspace.openTab({ url: u, width: w, height: h });
      workspace.broadcast({ type: 'tab', tabId: t.id, targetId: t.targetId, url: u, opener: this.id });
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
    const metaBuf = Buffer.from(JSON.stringify({ tabId: this.id, deviceWidth: size.width, deviceHeight: size.height }));
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

  resize(width, height) {
    const w = Math.max(100, Math.round(width)), h = Math.max(100, Math.round(height));
    const [cw, ch] = this.win.getContentSize();
    if (cw !== w || ch !== h) this.win.setContentSize(w, h);
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
        case 'vault.add': { await unlockVault('add a login to the cobrowser vault'); upsertLogin(m.host, m.username, m.password); saveVault(); return reply({ ok: true }); }
        case 'vault.import': { await unlockVault('import logins into the cobrowser vault'); const n = importCsv(String(m.csv || '')); saveVault(); return reply({ ok: true, count: n }); }
        case 'vault.list': { const v = await unlockVault('list the logins in the cobrowser vault'); return reply({ logins: v.entries.map((e) => ({ host: e.host, username: e.username })) }); }
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
    case 'resize': return void w.tabs.get(m.tabId)?.resize(m.width, m.height);
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
      JSON.stringify({ wsPort: port, token, debugWs: debugWsEndpoint, pid: process.pid, version: VERSION }),
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
  app.on('will-quit', () => { try { if (JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(STATE_FILE); } catch { /* fine */ } });
});

app.on('window-all-closed', () => { /* menu-bar app: stay alive with zero tabs */ });
