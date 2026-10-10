import * as fs from 'node:fs';
import * as path from 'node:path';
import { updateJson, type JsonObject } from './clients/jsonFile';
import { pruneEndpoints } from './firefox/managedManifest';

/**
 * What older versions of cobrowser left behind, converted once. Every backward-compatibility
 * step on the editor's side is here (the app's own are in app/migrations.js), so the rest of
 * the code reads only today's forms.
 *
 * Each entry runs once per machine or once per workspace (a workspace is migrated the first
 * time its folder is opened after an update), and is then recorded as done. Updates reach
 * people as one jump to the latest version, never step by step, so each entry converts from
 * whatever old form it finds. `added` is the day the old form was retired: entries older than
 * three months are removed at the next minor release (README: Releasing).
 */

/** Where a migration's progress and the data it converts live (VS Code's Mementos). */
export interface Store {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

export interface MigrationEnv {
  /** Per machine (the editor's globalState). */
  machine: Store;
  /** Per workspace (the editor's workspaceState). */
  workspace: Store;
  /** The workspace's first folder, when it has one. */
  workspaceRoot?: string;
  home: string;
  /** A value from the person's settings, for settings that were retired. */
  setting(name: string): unknown;
  log(message: string): void;
}

export interface Migration {
  id: string;
  /** The day the old form was retired (YYYY-MM-DD). */
  added: string;
  scope: 'machine' | 'workspace';
  run(env: MigrationEnv): Promise<void> | void;
}

const DONE_KEY = 'cobrowser.migrationsDone';

// Keys of the editor's own state, as extension.ts reads them today.
const TABS_KEY = 'cobrowser.openTabs';
const BINDING_KEY = 'cobrowser.firefoxContainerBinding';
const BRIDGE_BROWSER_KEY = 'cobrowser.bridgeBrowser';

export const MIGRATIONS: Migration[] = [
  {
    // Saved tabs were bare URLs; now { url, col, by }.
    id: 'saved-tabs-as-objects',
    added: '2026-07-29',
    scope: 'workspace',
    run: async ({ workspace }) => {
      const tabs = workspace.get<unknown[]>(TABS_KEY);
      if (Array.isArray(tabs) && tabs.some((t) => typeof t === 'string')) {
        await workspace.update(TABS_KEY, tabs.map((t) => (typeof t === 'string' ? { url: t } : t)));
      }
    },
  },
  {
    // MCP entries were written into the repo (.mcp.json, .cursor/mcp.json) and hidden with
    // .git/info/exclude lines; they live in $HOME now. Only cobrowser's entry is removed: a
    // file that also holds the person's own servers keeps them.
    id: 'repo-mcp-files',
    added: '2026-09-08',
    scope: 'workspace',
    run: ({ workspaceRoot, log }) => {
      if (!workspaceRoot) return;
      for (const rel of ['.mcp.json', path.join('.cursor', 'mcp.json')]) {
        const file = path.join(workspaceRoot, rel);
        let json: JsonObject;
        try {
          json = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonObject;
        } catch {
          continue; // not there, or not JSON (then not ours to touch)
        }
        const servers = json.mcpServers as Record<string, unknown> | undefined;
        if (!servers || !('cobrowser' in servers)) continue;
        delete servers.cobrowser;
        if (Object.keys(servers).length === 0 && Object.keys(json).length === 1) {
          fs.rmSync(file);
          log(`Removed ${rel} (registered in $HOME instead).`);
        } else {
          fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
          log(`Removed cobrowser from ${rel}; your other servers there are kept.`);
        }
      }
      const exclude = path.join(workspaceRoot, '.git', 'info', 'exclude');
      try {
        const lines = fs.readFileSync(exclude, 'utf8').split('\n');
        const ours = new Set(['# added by cobrowser', '.mcp.json', '.cursor/mcp.json']);
        const kept = lines.filter((l) => !ours.has(l.trim()));
        if (kept.length !== lines.length) fs.writeFileSync(exclude, kept.join('\n'), 'utf8');
      } catch {
        /* not a git repo, or no info/exclude */
      }
    },
  },
  {
    // Cursor had one `cobrowser-<folder>` entry per window, each at a port that no longer
    // exists; one `cobrowser` entry serves every workspace now.
    id: 'cursor-per-folder-entries',
    added: '2026-09-08',
    scope: 'machine',
    run: ({ home, log }) => {
      const file = path.join(home, '.cursor', 'mcp.json');
      if (!fs.existsSync(file)) return;
      updateJson(file, (json) => {
        const servers = json.mcpServers as Record<string, unknown> | undefined;
        for (const key of Object.keys(servers ?? {})) if (key.startsWith('cobrowser-') && key !== 'cobrowser-dev') delete servers![key];
        return json;
      }, log);
    },
  },
  {
    // The daemon's token was kept in each editor's own storage; it is one file in ~/.cobrowser
    // now. A machine without that file takes the first old one (so agents configured with it
    // keep working), and the old copies are removed.
    id: 'daemon-token-from-editor-storage',
    added: '2026-09-09',
    scope: 'machine',
    run: ({ home }) => {
      const old = ['Cursor', 'Code', 'VSCodium'].map((editor) => path.join(home, 'Library', 'Application Support', editor, 'User', 'globalStorage', 'trevin-lee.cobrowser', 'daemon-token'));
      const current = path.join(home, '.cobrowser', 'daemon-token'); // daemon/client.ts daemonTokenPath()
      if (!fs.existsSync(current)) {
        const found = old.map((f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } }).find(Boolean);
        if (found) {
          fs.mkdirSync(path.dirname(current), { recursive: true });
          fs.writeFileSync(current, found, { encoding: 'utf8', mode: 0o600 });
        }
      }
      for (const f of old) fs.rmSync(f, { force: true });
    },
  },
  {
    // Before the bridge moved to the daemon, the Firefox add-on dialled each window's own port;
    // those endpoints (no workspace= in them) point at ports that no longer exist.
    id: 'firefox-pre-daemon-endpoints',
    added: '2026-09-23',
    scope: 'machine',
    run: ({ home, log }) => pruneEndpoints((_workspace, url) => url.includes('workspace='), log, home),
  },
  {
    // The binding was stored under its name from when the Firefox bridge was called Zen.
    id: 'binding-from-zen-key',
    added: '2026-09-14',
    scope: 'workspace',
    run: async ({ workspace }) => {
      const old = workspace.get<string>('cobrowser.zenContainerBinding')?.trim();
      if (old && workspace.get<string>(BINDING_KEY) === undefined) {
        await workspace.update(BINDING_KEY, old);
        await workspace.update(BRIDGE_BROWSER_KEY, 'firefox');
      }
      if (old !== undefined) await workspace.update('cobrowser.zenContainerBinding', undefined);
    },
  },
  {
    // The binding was a setting, cobrowser.firefoxContainer, before the Bind commands.
    id: 'binding-from-setting',
    added: '2026-10-02',
    scope: 'workspace',
    run: async ({ workspace, setting }) => {
      const old = String(setting('firefoxContainer') ?? '').trim();
      if (old && workspace.get<string>(BINDING_KEY) === undefined) {
        await workspace.update(BINDING_KEY, old);
        await workspace.update(BRIDGE_BROWSER_KEY, 'firefox');
      }
    },
  },
];

/** Run what has not run yet, machine-wide first, then for this workspace. Returns what ran.
 *  A migration that fails is logged and tried again next time; the rest still run. */
export async function runMigrations(env: MigrationEnv, list: Migration[] = MIGRATIONS): Promise<string[]> {
  const ran: string[] = [];
  for (const scope of ['machine', 'workspace'] as const) {
    const store = scope === 'machine' ? env.machine : env.workspace;
    const done = new Set(store.get<string[]>(DONE_KEY) ?? []);
    for (const m of list.filter((x) => x.scope === scope && !done.has(x.id))) {
      try {
        await m.run(env);
        done.add(m.id);
        ran.push(m.id);
      } catch (e) {
        env.log(`Migration ${m.id} failed (tried again next time): ${(e as Error).message}`);
      }
    }
    await store.update(DONE_KEY, [...done]);
  }
  return ran;
}
