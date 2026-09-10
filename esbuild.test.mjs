// Compile the test files + the modules they import to plain CJS, then `node --test` runs
// them. Avoids adding a TS test-runner dependency for a build that already uses esbuild.
import esbuild from 'esbuild';
import { readdirSync } from 'node:fs';

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
