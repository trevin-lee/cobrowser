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
    // Extension host: Node/CJS. Everything (ws, the MCP SDK, zod) is bundled, so the vsix
    // needs no node_modules at all.
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    // Uninstall hook (package.json vscode:uninstall): plain Node, no editor API.
    ...common,
    entryPoints: ['src/uninstall.ts'],
    outfile: 'dist/uninstall.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
  },
  {
    // Daemon: a standalone Node process (spawned detached), so it must be its own bundle
    // rather than part of the extension host's.
    ...common,
    entryPoints: ['src/daemon/main.ts'],
    outfile: 'dist/daemon.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: [],
  },
  {
    // The companion app's main process: a single file Electron runs directly. `electron` is
    // provided by the runtime; ws is bundled so the app needs no node_modules of its own.
    ...common,
    entryPoints: ['app/main.js'],
    outfile: 'dist/app/main.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  },
  {
    // The vault window's preload: a separate file because Electron loads it by path.
    ...common,
    entryPoints: ['app/vault-preload.js'],
    outfile: 'dist/app/vault-preload.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  },
  {
    // Every tab's preload (page dialogs): loaded by path, like the vault's.
    ...common,
    entryPoints: ['app/tab-preload.js'],
    outfile: 'dist/app/tab-preload.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
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

// The vault's Touch-ID-or-password helper (Swift, macOS): built beside the app bundle.
const { buildAuthHelper } = await import('./scripts/build-auth-helper.mjs');
buildAuthHelper();

if (watch) {
  const ctxs = await Promise.all(targets.map((t) => esbuild.context(t)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[cobrowser] watching…');
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
  console.log('[cobrowser] build complete');
}
