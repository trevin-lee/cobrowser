import * as fs from 'node:fs';
import { computeExecutablePath, Browser } from '@puppeteer/browsers';
import { findSystemChrome, INSTALL_CHROMIUM_HINT } from './launchFlags';

/** Persists a previously-downloaded Chrome-for-Testing buildId, so an existing install
 *  stays usable as a fallback. Nothing writes it any more. */
export interface ChromeBuildStore {
  get(): string | undefined;
  set(buildId: string): void | PromiseLike<void>;
}

export interface EnsureChromeOptions {
  /** Where Chrome-for-Testing is installed (e.g. <globalStorage>/browsers). */
  cacheDir: string;
  /** cobrowser.chromePath — an explicit executable that skips the download entirely. */
  override?: string;
  store: ChromeBuildStore;
  onProgress?: (downloadedBytes: number, totalBytes: number) => void;
  log: (message: string) => void;
}

/**
 * Resolve a Chromium executable, in precedence order:
 *   1. `override` (cobrowser.chromePath) — any build the user prefers.
 *   2. an installed ungoogled Chromium.
 *   3. a previously-downloaded Chrome for Testing, if one is still on disk.
 *
 * There is no automatic download. @puppeteer/browsers can fetch Browser.CHROMIUM, but that
 * pulls Google's Chromium *snapshots*, which are built without proprietary codecs — H.264
 * and AAC would silently stop working. Ungoogled's builds do carry them (measured), and they
 * are distributed outside that tooling, so installing is left to the user with a one-line
 * hint rather than fetching a binary that would quietly be worse.
 */
export async function ensureChromeExecutable(opts: EnsureChromeOptions): Promise<string> {
  const { cacheDir, override, store, log } = opts;

  // 1. explicit override
  if (override) {
    if (fs.existsSync(override)) {
      log(`Using configured Chromium: ${override}`);
      return override;
    }
    log(`Configured cobrowser.chromePath does not exist: ${override} — ignoring.`);
  }

  // 2. installed ungoogled Chromium
  const system = findSystemChrome();
  if (system) {
    log(`Using Chromium: ${system}`);
    return system;
  }

  // 3. a Chrome for Testing left over from a previous version — usable, not downloaded anew.
  try {
    const cachedBuildId = store.get();
    if (cachedBuildId) {
      const cachedPath = computeExecutablePath({
        browser: Browser.CHROME,
        buildId: cachedBuildId,
        cacheDir,
      });
      if (fs.existsSync(cachedPath)) {
        log(`No Chromium found; falling back to the previously downloaded Chrome for Testing ${cachedBuildId}.`);
        return cachedPath;
      }
    }
  } catch {
    /* cache unreadable — treated as absent */
  }

  throw new Error(`Cobrowser needs a Chromium build and found none.\n${INSTALL_CHROMIUM_HINT}`);
}
