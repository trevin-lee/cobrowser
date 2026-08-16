import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * How this browser describes itself to sites. Every field is READ from the machine
 * (Chrome's own version, the OS's own version) — nothing is invented, because a value
 * that disagrees with the rest of the fingerprint is a stronger signal than the
 * "HeadlessChrome" token it was meant to hide.
 */
export interface BrowserIdentity {
  /** Full UA string, with the version frozen the way real Chrome freezes it. */
  ua: string;
  /** e.g. "151.0.7922.47" — for the Sec-CH-UA-Full-Version hint. */
  full: string;
  /** e.g. "151" — for the low-entropy brand list. */
  major: string;
  /** e.g. "26.5.0" — the real macOS version, for Sec-CH-UA-Platform-Version. */
  platformVersion: string;
}

/** Read the build's version WITHOUT launching it, so the UA is right on the very
 *  first request rather than after a page-level override has raced the navigation. */
export async function chromeVersionOf(chromePath: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec(chromePath, ['--version'], { timeout: 5000 });
    return /[\d.]+/.exec(stdout)?.[0];
  } catch {
    return undefined; // fall back to the connected browser's version
  }
}

let cachedPlatformVersion: string | undefined;
/** The real macOS version, in Chrome's 3-part hint form ("26.5" -> "26.5.0"). */
async function macOSVersion(): Promise<string> {
  if (cachedPlatformVersion) return cachedPlatformVersion;
  let v = '';
  try {
    const { stdout } = await exec('sw_vers', ['-productVersion'], { timeout: 5000 });
    v = stdout.trim();
  } catch {
    /* not macOS, or sw_vers missing */
  }
  const parts = v.split('.').filter(Boolean);
  while (parts.length < 3) parts.push('0');
  cachedPlatformVersion = parts.length === 3 && parts[0] ? parts.join('.') : '15.0.0';
  return cachedPlatformVersion;
}

/**
 * Build the identity from a Chrome version string ("151.0.7922.47" or
 * "HeadlessChrome/151.0.7922.47" — only the digits are used).
 */
export async function browserIdentity(versionString: string | undefined): Promise<BrowserIdentity> {
  const full = /[\d.]+/.exec(versionString ?? '')?.[0] ?? '';
  const major = full.split('.')[0] || '151';
  return {
    // Real Chrome ships a REDUCED UA: the version is frozen at MAJOR.0.0.0 and the
    // platform at 10_15_7, regardless of the actual build or macOS release (verified
    // against the system Chrome). Emitting the true build number here would itself be
    // anomalous — no real Chrome sends one.
    ua:
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    full: full || `${major}.0.0.0`,
    major,
    platformVersion: await macOSVersion(),
  };
}

/** The client-hint metadata that must accompany the UA — a UA/hint disagreement is
 *  itself a detection signal, so these are always sent together. */
export function identityMetadata(id: BrowserIdentity): {
  brands: { brand: string; version: string }[];
  fullVersion: string;
  fullVersionList: { brand: string; version: string }[];
  platform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  model: string;
  mobile: boolean;
} {
  return {
    // Order and the GREASE ("Not=A?Brand") entry mirror what the system Chrome sends.
    // Headless otherwise omits "Google Chrome" entirely and reports bare "Chromium".
    brands: [
      { brand: 'Not=A?Brand', version: '99' },
      { brand: 'Google Chrome', version: id.major },
      { brand: 'Chromium', version: id.major },
    ],
    fullVersion: id.full,
    fullVersionList: [
      { brand: 'Not=A?Brand', version: '99.0.0.0' },
      { brand: 'Google Chrome', version: id.full },
      { brand: 'Chromium', version: id.full },
    ],
    platform: 'macOS',
    platformVersion: id.platformVersion,
    architecture: 'arm',
    bitness: '64',
    model: '',
    mobile: false,
  };
}
