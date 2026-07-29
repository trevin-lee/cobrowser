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
export function resolveLaunchOptions(
  profileDir: string,
  chromePath: string,
  headless: boolean,
  uncapFrameRate = false,
): LaunchOptions {
  return {
    executablePath: chromePath,
    headless,
    userDataDir: profileDir,
    // Headless has no OS window to size the page from, so give it a fixed viewport;
    // headful lets the page fill the (user-resizable) window.
    defaultViewport: headless ? { width: 1280, height: 800 } : null,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      // Present as the ordinary browser this is. Headless Chromium otherwise sets
      // navigator.webdriver = true and ships an "Automation" blink feature set, which
      // sites read as "scripted client" and answer with CAPTCHA walls — even for a
      // human reading a page in the panel. (The UA string is corrected per-page in
      // prepPage, since it must carry a real Chrome version + client hints.)
      '--disable-blink-features=AutomationControlled',
      '--lang=en-US,en',
      // Reopen the previous session's tabs on relaunch, so an editor reload (which closes
      // the browser) doesn't lose your open tabs. Verified to work in headless.
      '--restore-last-session',
      ...(headless ? ['--window-size=1280,800'] : []),
      // Auto-approve getDisplayMedia tab-capture for the video pipeline's hidden
      // controller page: any tab briefly titled with this magic string is selected
      // without a picker (headless has no picker UI). Inert unless capture runs.
      '--auto-select-tab-capture-source-by-title=__cobrowser_capture__',
      // Opt-in beyond-60fps: headless self-paces its compositor at 60 (no real monitor).
      // Removing the limit lifts the screencast to ~90-100fps (JPEG-encode ceiling), but
      // rAF-driven pages then render THOUSANDS of frames/s (measured 6867) — heavy CPU
      // and battery cost, which is why this is off by default.
      ...(uncapFrameRate ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []),
    ],
  };
}
