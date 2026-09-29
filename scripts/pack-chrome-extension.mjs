#!/usr/bin/env node
/**
 * Zip the Chrome bridge extension for a GitHub release: cobrowser-bridge-chrome-<version>.zip.
 * The add-on is released with the editor extension and carries the same version, which is
 * how the daemon tells an add-on that needs updating.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(root, 'chrome-extension', 'manifest.json'), 'utf8'));
if (manifest.version !== version) {
  throw new Error(`chrome-extension/manifest.json is ${manifest.version}, package.json is ${version}: they are released together`);
}
const out = path.join(root, `cobrowser-bridge-chrome-${version}.zip`);
rmSync(out, { force: true });
execFileSync('zip', ['-qr', out, '.', '-x', '.*', '-x', 'README.md'], { cwd: path.join(root, 'chrome-extension'), stdio: 'inherit' });
console.log(out);
