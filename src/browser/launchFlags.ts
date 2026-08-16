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
  /** Set the UA at the process level (see the --user-agent note below). Omitted when the
   *  build's version couldn't be read, in which case the per-page override still runs. */
  userAgent?: string,
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
      // human reading a page in the panel. (Client hints are corrected per-page in
      // prepPage; they can only be set over CDP.)
      '--disable-blink-features=AutomationControlled',
      '--lang=en-US,en',
      // Set the UA for the WHOLE process, not just pages we prepare. The per-page
      // override (prepPage) still runs — it is the only way to set client hints — but it
      // cannot cover a page's very first request, workers, or a tab opened by a link
      // click, all of which would otherwise send "HeadlessChrome". Measured: without
      // this, a page that skipped prepPage still leaked the headless token.
      ...(userAgent ? [`--user-agent=${userAgent}`] : []),
      // Headless has no display, so it reports an 800x600 screen while the window is
      // 1280x800 — a window LARGER than the screen is impossible on real hardware and is
      // a standard headless check. Give it an ordinary 4K desktop to sit inside; panels
      // are capped well below this, so the window always fits.
      ...(headless ? ['--screen-info={3840x2160}'] : []),
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
