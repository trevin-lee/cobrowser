// End-to-end suites: each starts its own isolated cobrowser app (scratch dirs, no biometrics)
// and drives it through the real client + session code. Run from the repo root after
// `npm run build`:  node test/e2e/run.mjs [--only name] [--bench]
import esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const bench = args.includes('--bench');
const dir = bench ? 'test/e2e/bench' : 'test/e2e';
const out = 'dist-e2e';
fs.rmSync(out, { recursive: true, force: true });
const files = fs.readdirSync(dir).filter((f) => f.endsWith(bench ? '.bench.ts' : '.e2e.ts')).filter((f) => !only || f.startsWith(only)).sort();
if (!files.length) { console.error(`no suites in ${dir}${only ? ` matching ${only}` : ''}`); process.exit(2); }
await esbuild.build({ entryPoints: files.map((f) => path.join(dir, f)), outdir: out, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'error', sourcemap: 'inline' });

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const summary = [];
const skipped = new Set();
for (const f of files) {
  const name = f.replace(/\.(e2e|bench)\.ts$/, '');
  console.log(`\n=== ${name}`);
  const started = Date.now();
  const code = await new Promise((resolve) => {
    // Output is passed through and watched: a suite with nothing to run (it skipped itself)
    // reports "0/0 passed", and is listed as skipped rather than passed.
    const child = spawn(process.execPath, [path.join(out, f.replace(/\.ts$/, '.js'))], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (d) => { process.stdout.write(d); if (/: 0\/0 passed/.test(String(d))) skipped.add(name); });
    const killer = setTimeout(() => { child.kill('SIGKILL'); console.log(`${name}: killed after 5 minutes`); }, 300000);
    child.on('exit', (c) => { clearTimeout(killer); resolve(c ?? 1); });
  });
  summary.push({ name, code, seconds: Math.round((Date.now() - started) / 1000) });
}
console.log('\n=== summary');
for (const s of summary) console.log(`${s.code !== 0 ? 'FAIL' : skipped.has(s.name) ? 'skip' : 'pass'}  ${s.name} (${s.seconds}s)`);
process.exit(summary.some((s) => s.code !== 0) ? 1 : 0);
