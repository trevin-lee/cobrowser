import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  {
    // Extension host: Node/CJS. puppeteer-core is kept external (ships in node_modules);
    // the MCP SDK + zod are bundled so their ESM is transpiled to CJS.
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', 'puppeteer-core', '@puppeteer/browsers'],
  },
  {
    // Webview: browser/IIFE.
    ...common,
    entryPoints: ['webview-src/index.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
];

if (watch) {
  const ctxs = await Promise.all(targets.map((t) => esbuild.context(t)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[cobrowser] watching…');
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
  console.log('[cobrowser] build complete');
}
