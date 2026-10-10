import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MIGRATIONS, runMigrations, type Migration, type MigrationEnv, type Store } from '../src/migrations';

/** A Memento kept in memory. */
function memento(initial: Record<string, unknown> = {}): Store & { data: Record<string, unknown> } {
  const data = { ...initial };
  return { data, get: <T,>(k: string) => data[k] as T | undefined, update: (k: string, v: unknown) => { if (v === undefined) delete data[k]; else data[k] = v; } };
}

/** A scratch home and workspace folder: the migrations never see the real ones. */
function env(over: Partial<MigrationEnv> = {}, settings: Record<string, unknown> = {}): MigrationEnv & { machine: ReturnType<typeof memento>; workspace: ReturnType<typeof memento> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cobrowser-mig-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cobrowser-mig-ws-'));
  return { machine: memento(), workspace: memento(), workspaceRoot: root, home, setting: (n) => settings[n], log: () => undefined, ...over } as never;
}
const one = (id: string): Migration[] => MIGRATIONS.filter((m) => m.id === id);

test('every migration is dated, scoped and named once', () => {
  const ids = MIGRATIONS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const m of MIGRATIONS) assert.match(m.added, /^\d{4}-\d{2}-\d{2}$/, m.id);
});

test('a migration runs once per scope, and one that fails is tried again next time', async () => {
  let runs = 0, fails = 0;
  const list: Migration[] = [
    { id: 'ok', added: '2026-01-01', scope: 'workspace', run: () => { runs++; } },
    { id: 'flaky', added: '2026-01-01', scope: 'machine', run: () => { if (++fails === 1) throw new Error('not yet'); } },
  ];
  const e = env();
  assert.deepEqual(await runMigrations(e, list), ['ok']);
  assert.deepEqual(await runMigrations(e, list), ['flaky']);
  assert.deepEqual(await runMigrations(e, list), []);
  assert.equal(runs, 1);
  const otherWorkspace = { ...e, workspace: memento() };
  assert.deepEqual(await runMigrations(otherWorkspace, list), ['ok'], 'a workspace not yet opened is migrated when it is');
});

test('saved tabs that were bare URLs become tab objects', async () => {
  const e = env();
  e.workspace.data['cobrowser.openTabs'] = ['https://a.example/', { url: 'https://b.example/', col: 2 }];
  await runMigrations(e, one('saved-tabs-as-objects'));
  assert.deepEqual(e.workspace.data['cobrowser.openTabs'], [{ url: 'https://a.example/' }, { url: 'https://b.example/', col: 2 }]);
});

test('a binding under the Zen-era key, or in the retired setting, becomes the binding once', async () => {
  const fromKey = env();
  fromKey.workspace.data['cobrowser.zenContainerBinding'] = 'personal';
  await runMigrations(fromKey, [...one('binding-from-zen-key'), ...one('binding-from-setting')]);
  assert.equal(fromKey.workspace.data['cobrowser.firefoxContainerBinding'], 'personal');
  assert.equal(fromKey.workspace.data['cobrowser.bridgeBrowser'], 'firefox');
  assert.equal(fromKey.workspace.data['cobrowser.zenContainerBinding'], undefined);

  const fromSetting = env({}, { firefoxContainer: 'work' });
  await runMigrations(fromSetting, one('binding-from-setting'));
  assert.equal(fromSetting.workspace.data['cobrowser.firefoxContainerBinding'], 'work');

  // Unbound since (stored as ''): the old setting never binds it again.
  const unbound = env({}, { firefoxContainer: 'work' });
  unbound.workspace.data['cobrowser.firefoxContainerBinding'] = '';
  await runMigrations(unbound, one('binding-from-setting'));
  assert.equal(unbound.workspace.data['cobrowser.firefoxContainerBinding'], '');
});

test("cobrowser's MCP entries written into a repo are removed, the person's own servers kept", async () => {
  const e = env();
  const root = e.workspaceRoot!;
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { cobrowser: { url: 'x' } } }));
  fs.mkdirSync(path.join(root, '.cursor'));
  fs.writeFileSync(path.join(root, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { cobrowser: { url: 'x' }, mine: { url: 'y' } } }));
  fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), '*.log\n# added by cobrowser\n.mcp.json\n.cursor/mcp.json\n');
  await runMigrations(e, one('repo-mcp-files'));
  assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'mcp.json'), 'utf8')), { mcpServers: { mine: { url: 'y' } } });
  assert.equal(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8'), '*.log\n');
});

test("Cursor's per-folder entries go; its one entry, a dev entry and the person's own stay", async () => {
  const e = env();
  fs.mkdirSync(path.join(e.home, '.cursor'));
  const file = path.join(e.home, '.cursor', 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { cobrowser: {}, 'cobrowser-dev': {}, 'cobrowser-myapp': {}, mine: {} } }));
  await runMigrations(e, one('cursor-per-folder-entries'));
  assert.deepEqual(Object.keys((JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: object }).mcpServers).sort(), ['cobrowser', 'cobrowser-dev', 'mine']);
});

test("an editor's own copy of the daemon token becomes the machine's one, and the copies go", async () => {
  const e = env();
  const old = path.join(e.home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'trevin-lee.cobrowser');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'daemon-token'), 'old-token\n');
  await runMigrations(e, one('daemon-token-from-editor-storage'));
  assert.equal(fs.readFileSync(path.join(e.home, '.cobrowser', 'daemon-token'), 'utf8'), 'old-token');
  assert.equal(fs.existsSync(path.join(old, 'daemon-token')), false);

  // A machine that has its token keeps it.
  const kept = env();
  fs.mkdirSync(path.join(kept.home, '.cobrowser'));
  fs.writeFileSync(path.join(kept.home, '.cobrowser', 'daemon-token'), 'current');
  await runMigrations(kept, one('daemon-token-from-editor-storage'));
  assert.equal(fs.readFileSync(path.join(kept.home, '.cobrowser', 'daemon-token'), 'utf8'), 'current');
});

test('Firefox endpoints from before the daemon are dropped, current ones kept', { skip: process.platform !== 'darwin' }, async () => {
  const e = env();
  const dir = path.join(e.home, 'Library', 'Application Support', 'Mozilla', 'ManagedStorage');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'cobrowser-bridge@trevin.dev.json');
  const now = 'ws://127.0.0.1:39273/zen?token=t&workspace=%2Fa';
  fs.writeFileSync(file, JSON.stringify({ name: 'x', description: 'x', type: 'storage', data: { endpoints: [], workspaces: { '/a': now, '/b': 'ws://127.0.0.1:51111/zen?token=t' } } }));
  await runMigrations(e, one('firefox-pre-daemon-endpoints'));
  const data = (JSON.parse(fs.readFileSync(file, 'utf8')) as { data: { endpoints: string[]; workspaces: Record<string, string> } }).data;
  assert.deepEqual(data.workspaces, { '/a': now });
  assert.deepEqual(data.endpoints, [now]);
});
