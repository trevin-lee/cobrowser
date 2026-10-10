'use strict';
/**
 * What older versions of the app left in its data folder, converted once. Every
 * backward-compatibility step on the app's side is here (the editor's own are in
 * src/migrations.ts), so the rest of the app reads only today's forms.
 *
 * Each entry runs once, at start, before the data is read, and is then recorded in
 * migrations.json in the data folder. Updates reach people as one jump to the latest version,
 * so each entry converts from whatever old form it finds. `added` is the day the old form was
 * retired: entries older than three months are removed at the next minor release (README:
 * Releasing).
 */
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS = [
  {
    // Site permissions were one flat map shared by every workspace; each workspace has its
    // own now. The old decisions are copied to each workspace that existed then, so nothing a
    // person decided is lost or starts asking again.
    id: 'site-permissions-per-workspace',
    added: '2026-09-28',
    run({ dataDir, knownWorkspaces }) {
      const file = path.join(dataDir, 'permissions.json');
      let raw;
      try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
      if (!raw || typeof raw !== 'object' || raw.version === 2) return;
      fs.writeFileSync(file, JSON.stringify(permissionsPerWorkspace(raw, knownWorkspaces()), null, 2));
    },
  },
  {
    // The cobrowser.accentColor setting is gone, and the copy the app kept with it.
    id: 'accent-file',
    added: '2026-10-10',
    run({ dataDir }) {
      fs.rmSync(path.join(dataDir, 'accent.json'), { force: true });
    },
  },
];

/** The flat map of before, as one store per workspace. */
function permissionsPerWorkspace(flatMap, workspaces) {
  const store = { version: 2, workspaces: {} };
  const flat = Object.entries(flatMap).filter(([k, v]) => k.includes('|') && typeof v === 'boolean');
  if (flat.length) for (const ws of workspaces) store.workspaces[ws] = Object.fromEntries(flat);
  return store;
}

/**
 * Run what has not run yet. Returns what ran. A migration that fails is logged and tried
 * again at the next start; the rest still run.
 *   env: { dataDir, knownWorkspaces: () => string[], log }
 */
function runMigrations(env, list = MIGRATIONS) {
  const record = path.join(env.dataDir, 'migrations.json');
  let done;
  try { done = new Set(JSON.parse(fs.readFileSync(record, 'utf8'))); } catch { done = new Set(); }
  const ran = [];
  for (const m of list) {
    if (done.has(m.id)) continue;
    try {
      m.run(env);
      done.add(m.id);
      ran.push(m.id);
    } catch (e) {
      env.log(`migration ${m.id} failed (tried again next start): ${e.message}`);
    }
  }
  if (ran.length) fs.writeFileSync(record, JSON.stringify([...done].sort(), null, 2));
  return ran;
}

module.exports = { MIGRATIONS, runMigrations, permissionsPerWorkspace };
