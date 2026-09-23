import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import puppeteer, { type Cookie } from 'puppeteer-core';


/** An old per-workspace Chrome profile from the pre-app releases. */
export interface OldProfile {
  workspace: string;
  profileDir: string;
  cookieCount: number;
}

export interface ImportResult {
  workspace: string;
  imported: number;
  failed: number;
  skipped?: string;
}

/**
 * Old profiles live in each editor's workspaceStorage; the workspace they belonged to is in
 * the sibling workspace.json. Cursor and VS Code each have their own tree.
 */
export function findOldProfiles(): OldProfile[] {
  const roots = [
    path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'),
  ];
  const seen = new Map<string, OldProfile>();
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const hash of entries) {
      const profileDir = path.join(root, hash, 'trevin-lee.cobrowser', 'chrome-profile');
      const cookies = path.join(profileDir, 'Default', 'Cookies');
      if (!fs.existsSync(cookies)) continue;
      let folder: string | undefined;
      try {
        const ws = JSON.parse(fs.readFileSync(path.join(root, hash, 'workspace.json'), 'utf8')) as { folder?: string };
        if (ws.folder?.startsWith('file://')) folder = decodeURIComponent(new URL(ws.folder).pathname);
      } catch {
        /* no workspace.json → nothing to map it to */
      }
      if (!folder) continue;
      // Rough size signal, so the picker can show which profiles are worth importing.
      const cookieCount = Math.max(0, Math.round((fs.statSync(cookies).size - 20 * 1024) / 400));
      const prev = seen.get(folder);
      if (!prev || cookieCount > prev.cookieCount) seen.set(folder, { workspace: folder, profileDir, cookieCount });
    }
  }
  return [...seen.values()].sort((a, b) => b.cookieCount - a.cookieCount);
}

/** A Chrome build able to open the old profiles: the Chrome for Testing they were last
 *  written by, if it is still cached, else whatever Chromium is installed. */
export function findLegacyChrome(globalStorage: string): string | undefined {
  const cft = path.join(globalStorage, 'browsers', 'chrome');
  try {
    const builds = fs.readdirSync(cft).sort().reverse(); // newest version last → first after reverse
    for (const b of builds) {
      const exe = path.join(cft, b, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    /* nothing cached */
  }
  for (const c of [
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

/** Read every cookie out of an old profile by opening it, headless, in a Chrome that can
 *  decrypt it — the same puppeteer defaults it was written with (mock keychain). */
export async function readCookies(profileDir: string, chrome: string): Promise<Cookie[]> {
  if (fs.existsSync(path.join(profileDir, 'SingletonLock'))) {
    // Only the process that owns the lock may open the profile; an editor window still on
    // the old release could be holding it.
    try {
      const target = fs.readlinkSync(path.join(profileDir, 'SingletonLock'));
      const pid = Number(target.split('-').pop());
      process.kill(pid, 0);
      throw new Error(`profile is open in another process (pid ${pid}) — reload that window first`);
    } catch (e) {
      if ((e as Error).message.includes('reload that window')) throw e;
      fs.rmSync(path.join(profileDir, 'SingletonLock'), { force: true }); // stale
    }
  }
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    userDataDir: profileDir,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  try {
    return await browser.cookies();
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** puppeteer's cookie shape → what the app hands to Electron's session.cookies.set. */
export function toElectronCookie(c: Cookie): Record<string, unknown> {
  const host = c.domain.replace(/^\./, '');
  const sameSite =
    c.sameSite === 'Strict' ? 'strict' : c.sameSite === 'Lax' ? 'lax' : c.sameSite === 'None' ? 'no_restriction' : 'unspecified';
  return {
    url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
    name: c.name,
    value: c.value,
    // A leading dot means a domain cookie; without one it is host-only, which Electron
    // expresses by omitting `domain` and taking the host from `url`.
    ...(c.domain.startsWith('.') ? { domain: c.domain } : {}),
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite,
    ...(c.expires && c.expires > 0 ? { expirationDate: c.expires } : {}),
  };
}
