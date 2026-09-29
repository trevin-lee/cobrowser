import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { daemonToken } from '../daemon/client';
import { claudeAddArgs, claudeEntry, cursorServer, type Endpoint } from './agentConfigs';
import { updateJson, type JsonObject } from './jsonFile';

type Log = (message: string) => void;

/** Claude Code's own registry. `projects[<dir>].mcpServers` is its "local" scope: the
 *  entry applies only to that directory, but the FILE lives in $HOME — which is exactly
 *  what we want, a per-workspace server with nothing written into the repo. */
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
/** Cursor's global server list, for a Cursor without its MCP extension API. */
const CURSOR_MCP = path.join(os.homedir(), '.cursor', 'mcp.json');

/** Files older versions wrote INTO the repo. Removed on sight now. */
const LEGACY_REPO_FILES = ['.mcp.json', path.join('.cursor', 'mcp.json')];

/**
 * Register the cobrowser daemon with the MCP clients that can be registered for you, each
 * through its own supported interface where it has one. Nothing is written into the repo.
 *
 *   - Claude Code: its CLI, `claude mcp add --scope local` run in the workspace folder,
 *     carrying THIS workspace's own token. That scoping is the point: the daemon maps the
 *     token back to one workspace, so an AI session opened in this folder can only ever
 *     drive this folder's browser, enforced by the credential, not by trusting what the
 *     agent asks for. Without the CLI, the same entry is written to ~/.claude.json.
 *   - Cursor (when this is Cursor): its extension API, vscode.cursor.mcp.registerServer,
 *     with the daemon's admin token (Cursor has no per-project scoping, so its entry is
 *     unscoped and names a `workspace` per call). A Cursor without that API gets the entry
 *     in ~/.cursor/mcp.json instead.
 *   - VS Code registers through its own provider API (extension.ts).
 *   - Every other client is the human's to add: Cobrowser: Connect Another Agent.
 *
 * Literal port + token are used (never "${ENV}" placeholders: the CLI's env would not
 * have them); both live outside version control by construction.
 */
export async function writeClientConfigs(
  daemonPort: number,
  /** This workspace's token — the credential that scopes a Claude session to this folder. */
  workspaceToken: string,
  log: Log,
  /** Development host: register under a separate name so it cannot shadow the installed
   *  extension's entry, and the user can point an agent at either deliberately. */
  dev = false,
): Promise<void> {
  const entry = dev ? 'cobrowser-dev' : 'cobrowser';
  const url = `http://127.0.0.1:${daemonPort}/mcp`;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const said: string[] = [];

  // --- Claude Code: per-project entry, scoped to this workspace -------------------------
  if (root) {
    const ep = { name: entry, url, token: workspaceToken };
    // Claude Code keys projects by the folder's real path (a symlinked folder by its target).
    let real = root;
    try { real = fs.realpathSync(root); } catch { /* keep as given */ }
    said.push(await registerClaude(ep, real, dev, log));
  }

  // --- Cursor: its own extension API, or its file where that API is missing ---------------
  const admin = { name: entry, url, token: daemonToken(undefined, dev) };
  const cursorApi = (vscode as unknown as { cursor?: { mcp?: { registerServer?: (c: unknown) => void } } }).cursor?.mcp;
  if (cursorApi?.registerServer) {
    try {
      cursorApi.registerServer(cursorServer(admin));
      said.push('Cursor (its extension API)');
      // Registered through the API now: an entry older versions wrote to the file would be a
      // second, duplicate server.
      if (fs.existsSync(CURSOR_MCP)) {
        updateJson(CURSOR_MCP, (json) => {
          const servers = json.mcpServers as Record<string, unknown> | undefined;
          if (servers) delete servers[entry];
          return json;
        }, log);
      }
    } catch (e) {
      log(`Cursor's MCP API refused the registration (${(e as Error).message}); writing ${CURSOR_MCP} instead.`);
      writeCursorFile(admin, dev, log);
      said.push('Cursor (~/.cursor/mcp.json)');
    }
  } else if (vscode.env.appName.toLowerCase().includes('cursor') && fs.existsSync(path.dirname(CURSOR_MCP))) {
    writeCursorFile(admin, dev, log);
    said.push('Cursor (~/.cursor/mcp.json)');
  }

  // --- Clean up what older versions left in the repo ------------------------------------
  if (!dev) await removeRepoConfigs(log);

  log(`Registered the cobrowser daemon at ${url} with ${said.filter(Boolean).join(' and ') || 'no file-based client'}.`);
}

/** Where the Claude Code CLI is: on PATH, or where its installers put it. */
function claudeCli(): string | undefined {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.claude', 'local'), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const d of dirs) {
    const bin = path.join(d, 'claude');
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

/** Claude Code's entry for this folder: through its CLI when it is installed (only when the
 *  entry would change), otherwise straight into ~/.claude.json. Says which it used. */
async function registerClaude(ep: Endpoint, root: string, dev: boolean, log: Log): Promise<string> {
  const want = claudeEntry(ep);
  let current: JsonObject = {};
  try {
    current = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8')) as JsonObject;
  } catch {
    /* none yet */
  }
  const projects = (current.projects ?? {}) as Record<string, { mcpServers?: Record<string, unknown> }>;
  const has = projects[root]?.mcpServers?.[ep.name];
  // A user-scope entry would ALSO apply here, giving the session a second, unscoped
  // cobrowser server that could reach every workspace. It goes.
  const userScoped = !dev && 'cobrowser' in ((current.mcpServers ?? {}) as Record<string, unknown>);
  if (sameEntry(has, want) && !userScoped) return 'Claude Code';

  const cli = claudeCli();
  if (cli) {
    const run = (args: string[]) => promisify(execFile)(cli, args, { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, timeout: 30000 });
    try {
      if (has !== undefined) await run(['mcp', 'remove', ep.name, '--scope', 'local']);
      if (userScoped) await run(['mcp', 'remove', 'cobrowser', '--scope', 'user']);
      await run(claudeAddArgs(ep));
      return 'Claude Code (its CLI)';
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      log(`The Claude Code CLI could not register cobrowser (${(err.stderr || err.message || '').trim().split('\n')[0]}); writing ${CLAUDE_JSON} instead.`);
    }
  }
  updateJson(
    CLAUDE_JSON,
    (json) => {
      const all = (json.projects ??= {}) as Record<string, Record<string, unknown>>;
      const project = (all[root] ??= {});
      const servers = (project.mcpServers ??= {}) as Record<string, unknown>;
      servers[ep.name] = want;
      const userScope = json.mcpServers as Record<string, unknown> | undefined;
      if (!dev && userScope && 'cobrowser' in userScope) delete userScope.cobrowser;
      return json;
    },
    log,
  );
  return 'Claude Code (~/.claude.json)';
}

/** Whether an existing entry already says what we would register (key order aside). */
function sameEntry(has: unknown, want: Record<string, unknown>): boolean {
  if (!has || typeof has !== 'object') return false;
  const h = has as { type?: string; url?: string; headers?: Record<string, string> };
  const w = want as { type: string; url: string; headers: Record<string, string> };
  return h.type === w.type && h.url === w.url && h.headers?.Authorization === w.headers.Authorization;
}

/** For a Cursor without its extension API: one unscoped entry in its global file. */
function writeCursorFile(ep: Endpoint, dev: boolean, log: Log): void {
  updateJson(
    CURSOR_MCP,
    (json) => {
      const servers = (json.mcpServers ??= {}) as Record<string, unknown>;
      // Migration: `cobrowser-<folder>` entries each pointed at a window-lifetime port that
      // is now dead. Only the production entry prunes them; a dev run must not touch the
      // installed extension's entry at all.
      if (!dev) {
        for (const key of Object.keys(servers)) {
          if (key.startsWith('cobrowser-') && key !== 'cobrowser-dev') delete servers[key];
        }
      }
      servers[ep.name] = { type: 'http', url: ep.url, headers: { Authorization: `Bearer ${ep.token}` } };
      return json;
    },
    log,
  );
}

/**
 * Delete the `.mcp.json` / `.cursor/mcp.json` that older versions wrote into the repo,
 * plus the `.git/info/exclude` lines added to hide them. Only OUR entry is removed: a
 * file that also holds the user's own servers keeps them and stays.
 */
async function removeRepoConfigs(log: Log): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) return;
  for (const rel of LEGACY_REPO_FILES) {
    const file = path.join(root.uri.fsPath, rel);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // not there — nothing to clean
    }
    let json: JsonObject;
    try {
      json = JSON.parse(raw) as JsonObject;
    } catch {
      log(`Leaving unparseable ${rel} alone — remove it by hand if it is ours.`);
      continue;
    }
    const servers = json.mcpServers as Record<string, unknown> | undefined;
    if (!servers || !('cobrowser' in servers)) continue;
    delete servers.cobrowser;
    // Only ours was in there → the whole file is ours to remove.
    const empty = Object.keys(servers).length === 0 && Object.keys(json).length === 1;
    try {
      if (empty) {
        fs.rmSync(file);
        log(`Removed ${rel} (now registered in $HOME instead).`);
      } else {
        fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
        log(`Removed the cobrowser entry from ${rel}; your other servers were left in place.`);
      }
    } catch (e) {
      log(`Could not clean ${rel}: ${(e as Error).message}`);
    }
  }
  // Drop the exclude lines we added; leave anything else in the file untouched.
  const excludeFile = path.join(root.uri.fsPath, '.git', 'info', 'exclude');
  try {
    const lines = fs.readFileSync(excludeFile, 'utf8').split('\n');
    const drop = new Set(['# added by cobrowser', '.mcp.json', '.cursor/mcp.json']);
    const kept = lines.filter((l) => !drop.has(l.trim()));
    if (kept.length !== lines.length) {
      fs.writeFileSync(excludeFile, kept.join('\n'), 'utf8');
    }
  } catch {
    /* not a git repo, or no info/exclude — nothing to do */
  }
}
