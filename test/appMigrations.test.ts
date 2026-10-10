import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type Env = { dataDir: string; knownWorkspaces: () => string[]; log: (m: string) => void };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mig = require('../app/migrations.js') as {
  MIGRATIONS: { id: string; added: string }[];
  runMigrations: (env: Env, list?: unknown[]) => string[];
};

/** A scratch data folder: never the app's real one. */
const scratch = (known: string[] = []): Env => ({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cobrowser-appmig-')), knownWorkspaces: () => known, log: () => undefined });

test('every app migration is dated and named once', () => {
  const ids = mig.MIGRATIONS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const m of mig.MIGRATIONS) assert.match(m.added, /^\d{4}-\d{2}-\d{2}$/, m.id);
});

test('the old shared permissions file becomes one per workspace, every decision kept, once', () => {
  const env = scratch(['/a', '/b']);
  const file = path.join(env.dataDir, 'permissions.json');
  fs.writeFileSync(file, JSON.stringify({ 'https://maps.example|geolocation': true, 'https://spam.example|notifications': false }));
  assert.ok(mig.runMigrations(env).includes('site-permissions-per-workspace'));
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(store.version, 2);
  for (const ws of ['/a', '/b']) assert.deepEqual(store.workspaces[ws], { 'https://maps.example|geolocation': true, 'https://spam.example|notifications': false });
  assert.deepEqual(mig.runMigrations(env), [], 'recorded: nothing runs twice');
});

test('a current permissions file is left as it is, and the old accent file goes', () => {
  const env = scratch(['/a']);
  const current = { version: 2, workspaces: { '/a': { 'https://x.example|geolocation': false } } };
  fs.writeFileSync(path.join(env.dataDir, 'permissions.json'), JSON.stringify(current));
  fs.writeFileSync(path.join(env.dataDir, 'accent.json'), JSON.stringify({ accent: '#ff5c1a' }));
  mig.runMigrations(env);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.dataDir, 'permissions.json'), 'utf8')), current);
  assert.equal(fs.existsSync(path.join(env.dataDir, 'accent.json')), false);
});
