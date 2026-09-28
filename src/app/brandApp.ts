import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_BUNDLE_ID, readSignedMarker } from './signApp';

type Log = (message: string) => void;

/** Bump when the branding below changes, so existing installs are re-branded once. */
export const BRAND_REVISION = 1;
export const APP_NAME = 'cobrowser';

/** The pinned Electron's cache directory, from its executable (…/X.app/Contents/MacOS/Electron). */
export function versionDirOf(exe: string): string {
  return path.dirname(path.dirname(path.dirname(path.dirname(exe))));
}

export function brandedExe(versionDir: string): string {
  return path.join(versionDir, `${APP_NAME}.app`, 'Contents', 'MacOS', 'Electron');
}

function markerPath(versionDir: string): string {
  return path.join(versionDir, 'branded.json');
}

/** The cached browser already carries this revision of the cobrowser name and icon. */
export function isBranded(versionDir: string): boolean {
  try {
    const m = JSON.parse(fs.readFileSync(markerPath(versionDir), 'utf8')) as { revision?: number };
    return m.revision === BRAND_REVISION && fs.existsSync(brandedExe(versionDir));
  } catch {
    return false;
  }
}

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Make the downloaded Electron look like what it is: cobrowser. macOS names an app in the
 * Dock, Finder and Activity Monitor by its folder, and shows its icon in every dialog, Touch
 * ID sheet and permission prompt — so a stock bundle reads as "Electron" with Electron's atom.
 *
 *  - Electron.app becomes cobrowser.app. A symlink stays at the old name for editor windows
 *    still running an older extension, which look there and would otherwise download Electron
 *    again.
 *  - Info.plist gets the name, the bundle id (per-app macOS permissions are keyed on it — the
 *    stock id is shared by every Electron app on the machine), the icon, and LSUIElement, so
 *    the menu-bar app can never appear in the Dock or the app switcher.
 *  - Only the outer bundle changes, so only it is re-sealed: with the user's identity and its
 *    existing entitlements when it was signed for passkeys (the identity keeps its keychain
 *    access), ad hoc otherwise — which is how a stock Electron comes.
 *
 * Must run while the app is NOT running: its helper processes are launched by path.
 */
export function brandApp(versionDir: string, iconIcns: string, log: Log): string {
  const stock = path.join(versionDir, 'Electron.app');
  const branded = path.join(versionDir, `${APP_NAME}.app`);
  if (!fs.existsSync(branded)) {
    if (!fs.existsSync(stock) || fs.lstatSync(stock).isSymbolicLink()) throw new Error(`no Electron.app to brand in ${versionDir}`);
    fs.renameSync(stock, branded);
  }
  if (!fs.existsSync(stock)) fs.symlinkSync(`${APP_NAME}.app`, stock);

  const contents = path.join(branded, 'Contents');
  const plist = path.join(contents, 'Info.plist');
  const exe = brandedExe(versionDir);
  const signed = readSignedMarker(exe);
  for (const [key, type, value] of [
    ['CFBundleName', '-string', APP_NAME],
    ['CFBundleDisplayName', '-string', APP_NAME],
    // A signed app keeps the identifier its provisioning profile was issued for.
    ['CFBundleIdentifier', '-string', signed?.bundleId || APP_BUNDLE_ID],
    ['CFBundleIconFile', '-string', `${APP_NAME}.icns`],
    ['LSUIElement', '-bool', 'true'],
  ]) {
    sh('plutil', ['-replace', key, type, value, plist]);
  }
  if (fs.existsSync(iconIcns)) fs.copyFileSync(iconIcns, path.join(contents, 'Resources', `${APP_NAME}.icns`));
  else log(`cobrowser icon missing at ${iconIcns}; keeping Electron's`);

  if (signed) {
    const ent = path.join(os.tmpdir(), `cobrowser-brand-${process.pid}.plist`);
    try {
      fs.writeFileSync(ent, sh('codesign', ['-d', '--entitlements', '-', '--xml', branded]));
      sh('codesign', ['--force', '--sign', signed.identity, '--entitlements', ent, '--options', 'runtime', branded]);
    } finally {
      fs.rmSync(ent, { force: true });
    }
  } else {
    sh('codesign', ['--force', '--sign', '-', branded]);
  }
  sh('codesign', ['--verify', '--strict', branded]);

  // Tell Launch Services the name and icon changed; it caches both per bundle.
  try {
    sh('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', branded]);
  } catch {
    /* only a cache refresh */
  }
  fs.writeFileSync(markerPath(versionDir), JSON.stringify({ revision: BRAND_REVISION, at: new Date().toISOString(), signed: !!signed }, null, 2));
  log(`Browser branded as ${APP_NAME}.app${signed ? ` (re-sealed with ${signed.identity.replace(/:.*/, '')})` : ''}.`);
  return exe;
}
