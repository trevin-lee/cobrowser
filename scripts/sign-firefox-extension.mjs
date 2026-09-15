#!/usr/bin/env node
/**
 * Sign the Firefox bridge extension through Mozilla, so it installs on a Firefox with
 * signature enforcement left ON.
 *
 * Channel is ALWAYS unlisted: the add-on is self-distributed, never published to AMO and
 * never publicly reviewed. Unlisted submissions are signed automatically, usually in
 * seconds — the AMO round-trip is a formality, not a review queue.
 *
 * Credentials come from the environment (or .env.amo, which is gitignored):
 *   AMO_JWT_ISSUER  — "JWT issuer"  from https://addons.mozilla.org/developers/addon/api/key/
 *   AMO_JWT_SECRET  — "JWT secret"  from the same page (shown ONCE; regenerate if lost)
 *
 * AMO rejects a version it has already signed, so bump firefox-extension/manifest.json first.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = path.join(root, 'firefox-extension');
const outDir = path.join(root, 'web-ext-artifacts');

// .env.amo is a convenience for local use; the environment always wins.
const envFile = path.join(root, '.env.amo');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*(AMO_JWT_ISSUER|AMO_JWT_SECRET)\s*=\s*(.+?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const issuer = process.env.AMO_JWT_ISSUER;
const secret = process.env.AMO_JWT_SECRET;
if (!issuer || !secret) {
  console.error(
    [
      'Missing AMO credentials.',
      '',
      '  1. Sign in at https://addons.mozilla.org/developers/addon/api/key/',
      '  2. Generate credentials; the SECRET is shown only once.',
      '  3. Either export them:',
      '       export AMO_JWT_ISSUER=user:12345678:123',
      '       export AMO_JWT_SECRET=...',
      '     or write them to .env.amo in the repo root (gitignored):',
      '       AMO_JWT_ISSUER=user:12345678:123',
      '       AMO_JWT_SECRET=...',
      '  4. Re-run: npm run sign:firefox',
    ].join('\n'),
  );
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
console.log(`signing ${manifest.name} ${manifest.version} (${manifest.browser_specific_settings.gecko.id}) — unlisted`);

mkdirSync(outDir, { recursive: true });
execFileSync(
  'npx',
  [
    '--yes', 'web-ext@10', 'sign',
    '--source-dir', srcDir,
    '--artifacts-dir', outDir,
    '--channel', 'unlisted',
    '--api-key', issuer,
    '--api-secret', secret,
  ],
  { cwd: root, stdio: 'inherit' },
);

// web-ext names the artifact after the id+version; copy the newest to a stable path.
const signed = readdirSync(outDir)
  .filter((f) => f.endsWith('.xpi'))
  .map((f) => ({ f, t: existsSync(path.join(outDir, f)) ? readFileSync(path.join(outDir, f)).length : 0 }));
if (signed.length) {
  const newest = readdirSync(outDir)
    .filter((f) => f.endsWith('.xpi'))
    .sort()
    .pop();
  const dest = path.join(root, 'cobrowser-bridge-signed.xpi');
  copyFileSync(path.join(outDir, newest), dest);
  console.log(`\nsigned add-on: ${dest}`);
  console.log('Install it: about:addons → gear → Install Add-on From File…');
  console.log('It installs with xpinstall.signatures.required left at true.');
}
