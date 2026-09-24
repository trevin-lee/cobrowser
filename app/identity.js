'use strict';
/**
 * How Cobrowser describes itself to sites. The rule: say what it is. A Chromium-based
 * browser named Cobrowser, driven by a human on a real display — the same shape every
 * other Chromium browser (Edge, Brave, Opera) reports, with its own name in the places
 * they put theirs. Nothing here claims to be Google Chrome, and nothing is invented:
 * every number is read from the running build or the OS.
 */

const BRAND = 'Cobrowser';

const major = (v) => String(v || '').split('.')[0] || '0';

/** The reduced UA every Chromium browser sends, plus our own token where Edge puts "Edg/". */
function userAgent(chromeVersion, appVersion) {
  return (
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${major(chromeVersion)}.0.0.0 Safari/537.36 ${BRAND}/${appVersion || '0'}`
  );
}

/**
 * The language list Chromium turns into Accept-Language and navigator.languages: each OS
 * language followed by its bare base language. ['en-US'] -> 'en-US,en'. No q-values here:
 * Chromium adds them itself (en-US,en;q=0.9) and would double them if given any.
 */
function acceptLanguages(preferred) {
  const out = [];
  for (const raw of preferred || []) {
    const lang = String(raw).replace('_', '-');
    if (!lang) continue;
    if (!out.includes(lang)) out.push(lang);
    const base = lang.split('-')[0];
    if (base && !out.includes(base)) out.push(base);
  }
  if (out.length === 0) out.push('en-US', 'en');
  return out.join(',');
}

/** Client-hint metadata matching the UA — Sec-CH-UA and navigator.userAgentData. */
function metadata({ chromeVersion, appVersion, osVersion, arch }) {
  const cm = major(chromeVersion);
  const full = /^\d+(\.\d+){3}$/.test(chromeVersion || '') ? chromeVersion : `${cm}.0.0.0`;
  const app = String(appVersion || '0');
  const os = String(osVersion || '').split('.').filter(Boolean);
  while (os.length < 3) os.push('0');
  return {
    brands: [
      { brand: 'Chromium', version: cm },
      { brand: BRAND, version: major(app) },
      { brand: 'Not?A_Brand', version: '24' },
    ],
    fullVersion: full,
    fullVersionList: [
      { brand: 'Chromium', version: full },
      { brand: BRAND, version: app },
      { brand: 'Not?A_Brand', version: '24.0.0.0' },
    ],
    platform: 'macOS',
    platformVersion: os.slice(0, 3).join('.'),
    architecture: arch === 'arm64' ? 'arm' : 'x86',
    bitness: '64',
    model: '',
    mobile: false,
    wow64: false,
  };
}

module.exports = { BRAND, userAgent, acceptLanguages, metadata };
