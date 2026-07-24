import * as fs from 'node:fs';
import {
  install,
  computeExecutablePath,
  resolveBuildId,
  detectBrowserPlatform,
  Browser,
} from '@puppeteer/browsers';
import { findSystemChrome } from './launchFlags';

/** Persists the resolved Chrome-for-Testing buildId (backed by VS Code globalState). */
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
 * Resolve a Chrome/Chromium executable, in precedence order:
 *   1. `override` (cobrowser.chromePath) — for offline / corp / custom binaries.
 *   2. a dedicated Chrome-for-Testing in `cacheDir` — downloaded once, then cached +
 *      pinned by buildId (deterministic; independent of the user's daily Chrome).
 *   3. the user's system Chrome — last-resort fallback if the download fails.
 * Throws only if all three are unavailable.
 */
export async function ensureChromeExecutable(opts: EnsureChromeOptions): Promise<string> {
  const { cacheDir, override, store, onProgress, log } = opts;

  // 1. explicit override
  if (override) {
    if (fs.existsSync(override)) {
      log(`Using configured Chrome: ${override}`);
      return override;
    }
    log(`Configured cobrowser.chromePath does not exist: ${override} — ignoring.`);
  }

  // 2. dedicated Chrome-for-Testing (download-on-first-run, then cached)
  try {
    const platform = detectBrowserPlatform();
    if (!platform) throw new Error('could not detect browser platform');

    // Reuse a previously-installed build if its binary is still present.
    const cachedBuildId = store.get();
    if (cachedBuildId) {
      const cachedPath = computeExecutablePath({ browser: Browser.CHROME, buildId: cachedBuildId, cacheDir });
      if (fs.existsSync(cachedPath)) {
        log(`Using cached Chrome for Testing ${cachedBuildId}`);
        return cachedPath;
      }
    }

    // Resolve current stable, install if the binary isn't already on disk, then pin it.
    const buildId = await resolveBuildId(Browser.CHROME, platform, 'stable');
    const execPath = computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir });
    if (!fs.existsSync(execPath)) {
      log(`Downloading Chrome for Testing ${buildId} → ${cacheDir}`);
      await install({ browser: Browser.CHROME, buildId, cacheDir, downloadProgressCallback: onProgress });
    }
    await store.set(buildId);
    log(`Chrome for Testing ${buildId} ready.`);
    return execPath;
  } catch (err) {
    log(`Chrome for Testing unavailable (${String(err)}); trying system Chrome.`);
  }

  // 3. system Chrome fallback
  const system = findSystemChrome();
  if (system) {
    log(`Using system Chrome: ${system}`);
    return system;
  }

  throw new Error(
    'Cobrowser could not download Chrome for Testing and found no system Chrome. ' +
      'Set "cobrowser.chromePath" to a Chrome/Chromium executable, or check your network.',
  );
}
