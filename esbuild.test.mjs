// Compile the test files + the modules they import to plain CJS, then `node --test` runs
// them. Avoids adding a TS test-runner dependency for a build that already uses esbuild.
import esbuild from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';

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
console.log(`[cobrowser] built ${tests.length} test file(s)`);
