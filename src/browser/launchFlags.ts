import * as fs from 'node:fs';
import type { LaunchOptions } from 'puppeteer-core';

// macOS-first candidates for the system-Chrome fallback. (Windows/Linux paths deferred.)
const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
];

/** Find an installed system Chrome/Chromium (or a valid override). undefined if none. */
export function findSystemChrome(override?: string): string | undefined {
  if (override && fs.existsSync(override)) return override;
  for (const c of CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

/**
 * Launch options for the co-driven browser. `chromePath` is resolved by the caller
 * (ensureChromeExecutable) — a downloaded Chrome-for-Testing, the system Chrome, or the
 * cobrowser.chromePath override.
 *
 * - `userDataDir` is a NON-default, persistent dir under globalStorage: persists logins
 *   across sessions AND satisfies Chrome 136+'s "remote debugging needs a non-default
 *   profile" rule by construction.
 * - `headless: false` so the human can complete logins / 2FA in the panel.
 * - No fixed `--remote-debugging-port`; puppeteer's launch() manages an ephemeral transport.
 */
export function resolveLaunchOptions(profileDir: string, chromePath: string): LaunchOptions {
  return {
    executablePath: chromePath,
    headless: false,
    userDataDir: profileDir,
    defaultViewport: null,
    args: ['--no-first-run', '--no-default-browser-check'],
  };
}
