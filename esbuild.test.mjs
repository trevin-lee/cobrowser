// Compile the test files + the modules they import to plain CJS, then `node --test` runs
// them. Avoids adding a TS test-runner dependency for a build that already uses esbuild.
import esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';

// Wipe first: `node --test` globs dist-test, so a deleted test keeps running (and failing)
// from its stale build output until someone thinks to clear it by hand.
rmSync('dist-test', { recursive: true, force: true });

const tests = readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`);
await esbuild.build({
  entryPoints: tests,
  outdir: 'dist-test',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: 'inline',
  external: ['vscode', 'puppeteer-core', '@puppeteer/browsers', 'node:*'],
  logLevel: 'warning',
});
// The Bitwarden core's loader, bundled into a test, reads its WebAssembly from beside it.
mkdirSync('dist-test', { recursive: true });
copyFileSync('app/bitwarden/bitwarden_bg.wasm', 'dist-test/bitwarden_bg.wasm');
console.log(`[cobrowser] built ${tests.length} test file(s)`);
