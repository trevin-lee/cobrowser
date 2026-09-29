import * as fs from 'node:fs';
import * as path from 'node:path';

/** Read-modify-write of another app's JSON config (~/.claude.json, ~/.cursor/mcp.json).
 *  No editor API here: the uninstall script uses it too. */

export type JsonObject = Record<string, unknown>;
type Log = (message: string) => void;

/**
 * Read-modify-write a JSON file, atomically and only when the result actually differs.
 *
 * The no-op check matters for `~/.claude.json`: a running Claude Code rewrites that file
 * constantly, and re-saving an identical copy on every activation would be a needless
 * chance to clobber a concurrent write. Writing via a temp file + rename means a reader
 * never observes a half-written config.
 */
export function updateJson(file: string, mutate: (json: JsonObject) => JsonObject, log: Log): void {
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
