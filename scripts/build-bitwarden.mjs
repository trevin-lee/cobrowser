// Builds cobrowser's Bitwarden core (bitwarden/, Rust) into WebAssembly for the companion app:
// app/bitwarden/bitwarden.js and bitwarden_bg.wasm, which are committed, so building the
// extension never needs Rust. CI runs this and fails when the committed files differ.
//
//   node scripts/build-bitwarden.mjs
//
// Needs the toolchain in bitwarden/rust-toolchain.toml and wasm-bindgen-cli at the version
// bitwarden/Cargo.lock pins (cargo install wasm-bindgen-cli --version <it>).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const crate = path.join(root, 'bitwarden');
const out = path.join(root, 'app', 'bitwarden');
// Build output is scratch: kept in the system's temporary folder, not the repository.
const target = process.env.CARGO_TARGET_DIR || path.join(os.tmpdir(), 'cobrowser-bitwarden-target');

const lock = fs.readFileSync(path.join(crate, 'Cargo.lock'), 'utf8');
const want = lock.match(/name = "wasm-bindgen"\nversion = "([^"]+)"/)?.[1];
const have = execFileSync('wasm-bindgen', ['--version'], { encoding: 'utf8' }).trim().split(' ')[1];
if (want !== have) {
  console.error(`wasm-bindgen ${have} is installed, Cargo.lock pins ${want}: cargo install wasm-bindgen-cli --version ${want}`);
  process.exit(1);
}

// Paths on the building machine end up in the WebAssembly (where a dependency would panic):
// written as /cargo and /crate instead, so a build on any machine is byte for byte the same.
const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
const rustflags = [`--remap-path-prefix=${cargoHome}=/cargo`, `--remap-path-prefix=${crate}=/crate`].join(' ');
execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '--lib'], {
  cwd: crate,
  stdio: 'inherit',
  env: { ...process.env, CARGO_TARGET_DIR: target, RUSTFLAGS: rustflags },
});
fs.mkdirSync(out, { recursive: true });
execFileSync('wasm-bindgen', [
  '--target', 'nodejs',
  '--out-dir', out,
  '--out-name', 'bitwarden',
  '--no-typescript',
  path.join(target, 'wasm32-unknown-unknown', 'release', 'cobrowser_bitwarden.wasm'),
], { stdio: 'inherit' });
const size = fs.statSync(path.join(out, 'bitwarden_bg.wasm')).size;
console.log(`[cobrowser] Bitwarden core built: app/bitwarden (${Math.round(size / 1024)} KB of WebAssembly)`);
