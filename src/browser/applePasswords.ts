import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type Log = (message: string) => void;

/** Apple's iCloud Passwords extension, as published on the Chrome Web Store. */
const EXTENSION_ID = 'pejdijmoenmkgeppbflobdenhhabjlaj';

/** Where macOS itself registers Apple's helper — a root-owned symlink into
 *  /System/Cryptexes, so it survives uninstalling Chrome and survives OS updates. */
const APPLE_HOST_SOURCE = '/Library/Google/Chrome/NativeMessagingHosts/com.apple.passwordmanager.json';
const NATIVE_HOST_FILE = 'com.apple.passwordmanager.json';

/**
 * Register Apple's password helper for ONE browser profile.
 *
 * Chromium looks for user-level native-messaging manifests in `<user-data-dir>/
 * NativeMessagingHosts/` — relative to the PROFILE, not to a product directory. That is the
 * whole trick: cobrowser owns its profile directories, so this needs no admin rights at all.
 *
 * It was not obvious. Chrome for Testing reads a *system* path
 * (/Library/Google/ChromeForTesting/...), which needs sudo, and every user-level product
 * directory I tried — "Chrome for Testing", "Chromium", "Google/Chrome" — was ignored.
 * Measured: with the manifest in the profile, both Chromium and Chrome for Testing find and
 * launch the helper.
 *
 * Returns whether the manifest is in place.
 */
export function installNativeHost(profileDir: string, log: Log): boolean {
  const dir = path.join(profileDir, 'NativeMessagingHosts');
  const dest = path.join(dir, NATIVE_HOST_FILE);
  try {
    if (!fs.existsSync(APPLE_HOST_SOURCE)) {
      log('Apple password helper not present on this system — skipping autofill setup.');
      return false;
    }
    // Copy rather than symlink: the source is itself a symlink into a sealed system volume,
    // and a chain of links is one more thing to break on an OS update.
    const want = fs.readFileSync(APPLE_HOST_SOURCE, 'utf8');
    if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === want) return true;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dest, want, 'utf8');
    log(`Registered Apple's password helper for this profile (${dest}).`);
    return true;
  } catch (e) {
    log(`Could not register the password helper: ${(e as Error).message}`);
    return false;
  }
}

/** A copy we staged earlier, so autofill survives Chrome being uninstalled. */
function newestStaged(globalStorage: string): string | undefined {
  const dir = path.join(globalStorage, 'extensions');
  try {
    const hits = fs
      .readdirSync(dir)
      .filter((d) => d.startsWith('icloud-passwords-'))
      .filter((d) => fs.existsSync(path.join(dir, d, 'manifest.json')))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return hits.length ? path.join(dir, hits[hits.length - 1]) : undefined;
  } catch {
    return undefined;
  }
}

/** Newest copy of the extension across the user's real Chrome profiles, if they have it. */
function findInstalledCopy(): { dir: string; version: string } | undefined {
  const chrome = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  let best: { dir: string; version: string } | undefined;
  let profiles: string[] = [];
  try {
    profiles = fs.readdirSync(chrome);
  } catch {
    return undefined; // no Google Chrome installed
  }
  for (const profile of profiles) {
    const base = path.join(chrome, profile, 'Extensions', EXTENSION_ID);
    let versions: string[] = [];
    try {
      versions = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const version of versions) {
      if (!fs.existsSync(path.join(base, version, 'manifest.json'))) continue;
      if (!best || version.localeCompare(best.version, undefined, { numeric: true }) > 0) {
        best = { dir: path.join(base, version), version };
      }
    }
  }
  return best;
}

/**
 * Make the iCloud Passwords extension available to launch, returning its unpacked path.
 *
 * It is COPIED into our own storage rather than loaded from the Chrome profile in place:
 * Chrome deletes the old version directory when it updates an extension, which would pull
 * the directory out from under a running cobrowser session.
 *
 * Returns undefined when the user does not have the extension in Chrome — there is nothing
 * to install from, since the Web Store cannot be scripted.
 */
export function ensureApplePasswords(globalStorage: string, log: Log): string | undefined {
  const source = findInstalledCopy();
  if (!source) {
    // Chrome may have been uninstalled since we staged it. A copy we already took is just
    // as good — the extension is self-contained, and this is the only thing tying autofill
    // to Google Chrome being present at all.
    const staged = newestStaged(globalStorage);
    if (staged) {
      log(`iCloud Passwords: reusing the staged copy (${path.basename(staged)}).`);
      return staged;
    }
    return undefined;
  }
  const dest = path.join(globalStorage, 'extensions', `icloud-passwords-${source.version}`);
  if (!fs.existsSync(path.join(dest, 'manifest.json'))) {
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(source.dir, dest, { recursive: true });
      log(`Copied iCloud Passwords ${source.version} for the browser to load.`);
      // Drop superseded copies so storage doesn't accumulate one per Chrome update.
      for (const entry of fs.readdirSync(path.dirname(dest))) {
        if (entry.startsWith('icloud-passwords-') && entry !== path.basename(dest)) {
          fs.rmSync(path.join(path.dirname(dest), entry), { recursive: true, force: true });
        }
      }
    } catch (e) {
      log(`Could not stage iCloud Passwords: ${(e as Error).message}`);
      return undefined;
    }
  }
  return dest;
}
