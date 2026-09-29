import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { updateJson, type JsonObject } from './jsonFile';

/**
 * Take cobrowser's registrations back out of the agents' configs: every per-project Claude
 * Code entry, the user-scope one older versions wrote, and Cursor's. Run when the extension
 * is uninstalled (vscode:uninstall), so no project is left showing a server that is gone.
 * Entries added by hand through Connect Another Agent are the human's to remove.
 */
const OURS = (name: string): boolean => name === 'cobrowser' || name.startsWith('cobrowser-');

function drop(servers: unknown): number {
  if (!servers || typeof servers !== 'object') return 0;
  const s = servers as Record<string, unknown>;
  const names = Object.keys(s).filter(OURS);
  for (const n of names) delete s[n];
  return names.length;
}

/** Claude Code's ~/.claude.json: `projects[<folder>].mcpServers` and the user-scope `mcpServers`. */
export function withoutClaudeEntries(json: JsonObject): number {
  let removed = drop(json.mcpServers);
  for (const project of Object.values((json.projects ?? {}) as Record<string, JsonObject>)) removed += drop(project?.mcpServers);
  return removed;
}

/** Cursor's ~/.cursor/mcp.json. */
export function withoutCursorEntries(json: JsonObject): number {
  return drop(json.mcpServers);
}

export function unregisterEverywhere(home = os.homedir(), log: (m: string) => void = console.log): void {
  const files: [string, (j: JsonObject) => number][] = [
    [path.join(home, '.claude.json'), withoutClaudeEntries],
    [path.join(home, '.cursor', 'mcp.json'), withoutCursorEntries],
  ];
  for (const [file, strip] of files) {
    if (!fs.existsSync(file)) continue; // never create a config that is not there
    let removed = 0;
    updateJson(file, (json) => ((removed = strip(json)), json), log);
    if (removed) log(`cobrowser: removed ${removed} entr${removed === 1 ? 'y' : 'ies'} from ${file}`);
  }
}
