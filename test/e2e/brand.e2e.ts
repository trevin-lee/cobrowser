/* Branding a stock and a signed Electron: renamed, iconed, menu-bar-only, still starting, passkeys kept. */
import { suite, ROOT, scratchDir, sleep, withTimeout, serve, html } from './harness';
import { brandApp, isBranded } from '../../src/app/brandApp';
import { ELECTRON_VERSION } from '../../src/app/ensureApp';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const sh = (c: string, a: string[]): string => { try { return execFileSync(c, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return String((e as { stderr?: string }).stderr ?? e); } };
const PROBE = `const { app, BrowserWindow } = require('electron'); const fs = require('node:fs');
const G = process.env.GROUP; if (G) app.configureWebAuthn({ touchID: { keychainAccessGroup: G } });
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await w.loadURL(process.env.URL); // an http origin: WebAuthn is unavailable to a data: URL
  const avail = await w.webContents.executeJavaScript('PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()');
  fs.writeFileSync(process.env.OUT, JSON.stringify({ started: true, platformAuthenticator: avail }));
  setTimeout(() => app.exit(0), 2500);
});`;

suite('brand', async (r) => {
  const srv = await serve((_q, res) => { const [st, h, b] = html('<title>t</title>'); res.writeHead(st, h); res.end(b); });
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const stock = path.join(ROOT, 'app', 'node_modules', 'electron', 'dist', 'Electron.app');
  const cache = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'trevin-lee.cobrowser', 'electron', `electron-v${ELECTRON_VERSION}-darwin-${arch}`);
  const signedSrc = fs.existsSync(path.join(cache, 'signed.json')) ? cache : undefined;
  const icon = path.join(ROOT, 'media', 'cobrowser.icns');
  const cases: { label: string; src: string; signed?: string }[] = [];
  if (fs.existsSync(stock)) cases.push({ label: 'stock', src: stock });
  if (signedSrc) cases.push({ label: 'signed', src: path.join(signedSrc, fs.existsSync(path.join(signedSrc, 'cobrowser.app')) ? 'cobrowser.app' : 'Electron.app'), signed: path.join(signedSrc, 'signed.json') });
  r.check('setup: at least one Electron bundle to brand (checkout or cache)', cases.length > 0);
  for (const c of cases) {
    const dir = path.join(scratchDir(`brand-${c.label}`), `electron-v${ELECTRON_VERSION}-darwin-${arch}`);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('ditto', [c.src, path.join(dir, 'Electron.app')]);
    if (c.signed) fs.copyFileSync(c.signed, path.join(dir, 'signed.json'));
    const exe = brandApp(dir, icon, () => undefined);
    const app = path.join(dir, 'cobrowser.app');
    const plist = ['CFBundleName', 'CFBundleIdentifier', 'CFBundleIconFile', 'LSUIElement'].map((k) => sh('/usr/libexec/PlistBuddy', ['-c', `Print :${k}`, path.join(app, 'Contents', 'Info.plist')]).trim());
    r.check(`[${c.label}] renamed, identified, iconed and menu-bar-only`, isBranded(dir) && fs.lstatSync(path.join(dir, 'Electron.app')).isSymbolicLink() && plist.join('|') === 'cobrowser|dev.trevin.cobrowser|cobrowser.icns|true', plist);
    r.check(`[${c.label}] the outer bundle's seal verifies`, (sh('codesign', ['--verify', '--strict', app]).trim() || 'valid') === 'valid');
    if (c.signed) r.check('[signed] the passkey entitlement is kept', /keychain-access-groups/.test(sh('codesign', ['-d', '--entitlements', '-', '--xml', app])));
    const out = path.join(dir, 'probe.json');
    fs.writeFileSync(path.join(dir, 'probe.js'), PROBE);
    const env: Record<string, string> = { ...(process.env as Record<string, string>), URL: srv.cross + '/', OUT: out, GROUP: c.signed ? JSON.parse(fs.readFileSync(c.signed, 'utf8')).webauthnGroup : '' };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(exe, [path.join(dir, 'probe.js'), `--user-data-dir=${path.join(dir, 'ud')}`], { env, stdio: 'ignore' });
    for (let i = 0; i < 40 && !fs.existsSync(out); i++) await sleep(250);
    const run = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : undefined;
    const asn = sh('lsappinfo', ['find', `pid=${child.pid}`]).trim();
    const ls = asn ? sh('lsappinfo', ['info', '-only', 'name', '-only', 'ApplicationType', asn]) : '';
    await withTimeout(new Promise<void>((res) => child.on('exit', () => res())), 6000);
    if (child.exitCode === null) child.kill('SIGKILL');
    r.check(`[${c.label}] the branded app starts, and macOS sees "cobrowser" as a menu-bar app`, !!run?.started && /"cobrowser"/.test(ls) && /UIElement/.test(ls), { run, ls: ls.replace(/\s+/g, ' ').trim() });
    if (c.signed) r.check('[signed] the Touch ID authenticator is still available', run?.platformAuthenticator === true, run);
  }
  srv.close();
});
