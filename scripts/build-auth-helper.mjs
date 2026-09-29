// Build app/auth/cobrowser-auth.swift into dist/app/cobrowser-auth: one universal binary (Apple
// silicon and Intel), with its Info.plist embedded so macOS names it "cobrowser", ad hoc signed.
// Skipped (the app then falls back to Electron's Touch-ID-only prompt) where there is no Swift
// compiler, unless COBROWSER_REQUIRE_AUTH_HELPER=1, as releases set.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export function buildAuthHelper(root = process.cwd()) {
  const src = path.join(root, 'app', 'auth', 'cobrowser-auth.swift');
  const plist = path.join(root, 'app', 'auth', 'Info.plist');
  const out = path.join(root, 'dist', 'app', 'cobrowser-auth');
  const required = process.env.COBROWSER_REQUIRE_AUTH_HELPER === '1';
  const skip = (why) => {
    if (required) throw new Error(`cobrowser-auth: ${why}`);
    console.warn(`[cobrowser] cobrowser-auth not built (${why}); the vault will ask with Touch ID only`);
  };
  if (process.platform !== 'darwin') return skip('not macOS');
  try { execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }); } catch { return skip('no Swift compiler'); }
  const newest = Math.max(statSync(src).mtimeMs, statSync(plist).mtimeMs);
  if (existsSync(out) && statSync(out).mtimeMs >= newest) return;
  mkdirSync(path.dirname(out), { recursive: true });
  const tmp = mkdtempSync(path.join(tmpdir(), 'cobrowser-auth-'));
  try {
    const slices = ['arm64', 'x86_64'].map((arch) => {
      const slice = path.join(tmp, arch);
      execFileSync('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${arch}-apple-macos12`,
        '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist,
        '-o', slice, src], { stdio: 'inherit' });
      return slice;
    });
    execFileSync('lipo', ['-create', ...slices, '-output', out]);
    execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'dev.trevin.cobrowser.auth', out]);
    console.log('[cobrowser] built dist/app/cobrowser-auth');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) buildAuthHelper();
