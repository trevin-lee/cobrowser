import * as fs from 'node:fs';
import type { LaunchOptions } from 'puppeteer-core';

// macOS-first candidates for the spike. (Cross-platform paths are deferred.)
const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
];

export function resolveChromePath(override?: string): string {
  if (override && fs.existsSync(override)) return override;
  for (const c of CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    'Cobrowser: no Chrome/Chromium executable found. Set "cobrowser.chromePath" in settings.',
  );
}

/**
 * Launch options for the co-driven browser.
 *
 * - `userDataDir` is a NON-default, persistent dir under the extension's globalStorage.
 *   This both persists logins across sessions AND satisfies Chrome 136+'s rule that
 *   remote debugging requires a non-default profile dir (satisfied by construction).
 * - `headless: false` so the human can complete logins / 2FA / captchas in the panel.
 * - No fixed `--remote-debugging-port`; puppeteer's `launch()` manages an ephemeral
 *   transport, so we never expose a predictable debug port.
 */
export function resolveLaunchOptions(profileDir: string, chromePath?: string): LaunchOptions {
  return {
    executablePath: chromePath ?? resolveChromePath(),
    headless: false,
    userDataDir: profileDir,
    defaultViewport: null,
    args: ['--no-first-run', '--no-default-browser-check'],
  };
}
