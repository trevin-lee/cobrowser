import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { daemonToken } from '../daemon/client';

type Log = (message: string) => void;

/** Claude Code's own registry. `projects[<dir>].mcpServers` is its "local" scope: the
 *  entry applies only to that directory, but the FILE lives in $HOME — which is exactly
 *  what we want, a per-workspace server with nothing written into the repo. */
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
/** Cursor's global server list. Flat — it has no per-project scoping — so each workspace
 *  contributes its own uniquely-named entry (see cursorEntryName). */
const CURSOR_MCP = path.join(os.homedir(), '.cursor', 'mcp.json');

/** Files older versions wrote INTO the repo. Removed on sight now. */
const LEGACY_REPO_FILES = ['.mcp.json', path.join('.cursor', 'mcp.json')];

/**
 * Register the cobrowser daemon with file-based clients. Nothing is written into the repo.
 *
 *   - Claude Code: `~/.claude.json` → projects[<workspace>].mcpServers.cobrowser, carrying
 *     THIS workspace's own token. That scoping is the point: the daemon maps the token back
 *     to one workspace, so an AI session opened in this folder can only ever drive this
 *     folder's browser — enforced by the credential, not by trusting what the agent asks for.
 *   - Cursor: `~/.cursor/mcp.json` → a single `cobrowser` entry with the daemon's admin
 *     token. Cursor's global list has no per-project scoping, so this one is unscoped and
 *     names its target with a `workspace` argument instead.
 *
 * Literal port + token are written (never "${ENV}" placeholders — the CLI's env would not
 * have them); both files live outside version control by construction.
 */
export async function writeClientConfigs(
  daemonPort: number,
  globalStorage: string,
  /** This workspace's token — the credential that scopes a Claude session to this folder. */
  workspaceToken: string,
  log: Log,
): Promise<void> {
  const url = `http://127.0.0.1:${daemonPort}/mcp`;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // --- Claude Code: per-project entry, scoped to this workspace -------------------------
  if (root) {
    updateJson(
      CLAUDE_JSON,
      (json) => {
        const projects = (json.projects ??= {}) as Record<string, Record<string, unknown>>;
        const project = (projects[root] ??= {});
        const servers = (project.mcpServers ??= {}) as Record<string, unknown>;
        servers.cobrowser = { type: 'http', url, headers: { Authorization: `Bearer ${workspaceToken}` } };
        // A user-scope entry would ALSO apply here, giving the session a second, unscoped
        // cobrowser server that could reach every workspace. Remove it.
        const userScope = json.mcpServers as Record<string, unknown> | undefined;
        if (userScope && 'cobrowser' in userScope) delete userScope.cobrowser;
        return json;
      },
      log,
    );
  }

  // --- Cursor: one unscoped entry -------------------------------------------------------
  updateJson(
    CURSOR_MCP,
    (json) => {
      const servers = (json.mcpServers ??= {}) as Record<string, unknown>;
      // Migration: `cobrowser-<folder>` entries each pointed at a window-lifetime port that
      // is now dead. The daemon replaces all of them.
      for (const key of Object.keys(servers)) {
        if (key.startsWith('cobrowser-')) delete servers[key];
      }
      servers.cobrowser = {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${daemonToken(globalStorage)}` },
      };
      return json;
    },
    log,
  );

  // --- Clean up what older versions left in the repo ------------------------------------
  await removeRepoConfigs(log);

  log(
    root
      ? `Registered the cobrowser daemon at ${url}: a per-project entry scoped to "${root}" for Claude Code, and one shared entry for Cursor.`
      : `Registered the cobrowser daemon at ${url} for Cursor (no workspace folder open, so no scoped Claude Code entry).`,
  );
}

type JsonObject = Record<string, unknown>;

/**
 * Read-modify-write a JSON file, atomically and only when the result actually differs.
 *
 * The no-op check matters for `~/.claude.json`: a running Claude Code rewrites that file
 * constantly, and re-saving an identical copy on every activation would be a needless
 * chance to clobber a concurrent write. Writing via a temp file + rename means a reader
 * never observes a half-written config.
 */
function updateJson(file: string, mutate: (json: JsonObject) => JsonObject, log: Log): void {
  let raw: string | undefined;
  let target = file;
  try {
    // Follow symlinks (a dotfile repo may link ~/.cursor/mcp.json elsewhere) so we update
    // the real file instead of replacing the link with a regular file.
    target = fs.realpathSync(file);
  } catch {
    /* missing — created below at the original path */
  }
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    raw = undefined; // missing — safe to create
  }
  let current: JsonObject = {};
  if (raw !== undefined && raw.trim() !== '') {
    try {
      current = JSON.parse(raw) as JsonObject;
    } catch {
      // REFUSE to overwrite: a momentarily-malformed config would otherwise be replaced,
      // silently wiping every other MCP server the user has configured.
      log(`Refusing to overwrite unparseable ${target} — left untouched.`);
      return;
    }
  }
  const next = JSON.stringify(mutate(current), null, 2) + '\n';
  if (raw === next) return; // already correct — don't touch the file at all
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.cobrowser-${process.pid}.tmp`;
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, target);
  } catch (e) {
    log(`Could not write ${target}: ${(e as Error).message}`);
  }
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
