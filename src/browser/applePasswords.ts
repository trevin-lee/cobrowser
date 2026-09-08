import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type Log = (message: string) => void;

/** Apple's iCloud Passwords extension, as published on the Chrome Web Store. */
const EXTENSION_ID = 'pejdijmoenmkgeppbflobdenhhabjlaj';

/**
 * Where Chrome for Testing looks for native-messaging manifests. NOT the same as Google
 * Chrome's `/Library/Google/Chrome/...` (where macOS installs Apple's helper), and NOT the
 * spaced "Chrome for Testing" — the string is baked into the framework binary as
 * `ChromeForTesting`. Verified by probing: manifests in every user-level location are
 * ignored, so this system directory is the only one that works.
 */
export const NATIVE_HOST_DIR = '/Library/Google/ChromeForTesting/NativeMessagingHosts';
const NATIVE_HOST_FILE = 'com.apple.passwordmanager.json';
/** Where macOS itself installs the helper's manifest, for Google Chrome. */
const APPLE_HOST_SOURCE = `/Library/Google/Chrome/NativeMessagingHosts/${NATIVE_HOST_FILE}`;

/** The one-time, admin-only step this extension cannot do for the user. */
export const NATIVE_HOST_INSTALL_COMMAND =
  `sudo mkdir -p "${NATIVE_HOST_DIR}" && sudo cp "${APPLE_HOST_SOURCE}" "${NATIVE_HOST_DIR}/"`;

/** True once the helper manifest is visible to Chrome for Testing. */
export function nativeHostInstalled(): boolean {
  return fs.existsSync(path.join(NATIVE_HOST_DIR, NATIVE_HOST_FILE));
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
  if (!source) return undefined;
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
