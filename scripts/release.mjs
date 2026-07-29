#!/usr/bin/env node
/**
 * One clean iteration of the installed extension: bump → typecheck → package →
 * install into Cursor → prune stale installs.
 *
 * Iterating on an *installed* VS Code/Cursor extension is the whole reason
 * cobrowser kept looking "broken" after edits: editing src + `npm run build`
 * only updates the working-tree dist, while the editor keeps running the
 * installed VSIX. Each install also restarts the extension host and moves the
 * MCP port, so you must reload the window afterward — this script ends with that
 * reminder.
 *
 * Usage:
 *   npm run release              # patch bump (0.1.8 → 0.1.9)
 *   npm run release -- minor     # minor bump
 *   npm run release -- 0.2.0     # explicit version
 *   npm run release -- --dry-run # print every action, change nothing
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import * as path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkgPath = path.join(root, 'package.json');
const extDir = path.join(homedir(), '.cursor', 'extensions');

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const bump = args.find((a) => !a.startsWith('-')) ?? 'patch';

const log = (m) => console.log(`${dry ? '[dry] ' : ''}${m}`);
const run = (cmd, cmdArgs) => {
  log(`$ ${cmd} ${cmdArgs.join(' ')}`);
  if (!dry) execFileSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit' });
};

function nextVersion(current, spec) {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;
  const [maj, min, pat] = current.split('.').map(Number);
  if (spec === 'major') return `${maj + 1}.0.0`;
  if (spec === 'minor') return `${maj}.${min + 1}.0`;
  if (spec === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error(`Bad version spec "${spec}" — use patch | minor | major | x.y.z`);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const from = pkg.version;
const to = nextVersion(from, bump);
const id = `${pkg.publisher}.${pkg.name}`;
const vsix = path.join(root, `${pkg.name}-${to}.vsix`);

log(`releasing ${id}: ${from} → ${to}`);

// 1) Bump. Written before packaging so the VSIX carries the new version.
log(`write package.json version = ${to}`);
if (!dry) writeFileSync(pkgPath, JSON.stringify({ ...pkg, version: to }, null, 2) + '\n');

// 2) Typecheck — fail before producing an artifact, not after.
run('npm', ['run', 'typecheck']);

// 3) Package (vsce runs vscode:prepublish → esbuild --production).
run('npm', ['run', 'package']);

// 4) Install into Cursor (replaces the active version).
run('cursor', ['--install-extension', vsix, '--force']);

// 5) Prune: every cobrowser install dir except the one we just made active is an
//    orphan on disk (only the newest is registered in extensions.json). Also drop
//    old .vsix artifacts in the repo. Never touches the new version.
const prefix = `${id}-`;
const staleDirs = existsSync(extDir)
  ? readdirSync(extDir).filter((d) => d.startsWith(prefix) && d !== `${prefix}${to}`)
  : [];
for (const d of staleDirs) {
  log(`prune install ${d}`);
  if (!dry) rmSync(path.join(extDir, d), { recursive: true, force: true });
}
const staleVsix = readdirSync(root).filter(
  (f) => f.startsWith(`${pkg.name}-`) && f.endsWith('.vsix') && f !== `${pkg.name}-${to}.vsix`,
);
for (const f of staleVsix) {
  log(`prune vsix ${f}`);
  if (!dry) rmSync(path.join(root, f), { force: true });
}

log(`done. pruned ${staleDirs.length} install dir(s), ${staleVsix.length} vsix.`);
log('→ Reload the Cursor window to load the new build (Developer: Reload Window).');
