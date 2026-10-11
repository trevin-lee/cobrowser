import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Workspaces whose browser was forgotten, or taken over by a moved folder, from another window.
 * A workspace's bridge binding (its Chrome tab group or Firefox container) is kept in its own
 * window's workspace state, which no other window can change, so the window that forgot it
 * leaves a note here, and the workspace's own window unbinds when it next opens.
 */
function file(): string {
  return path.join(process.env.COBROWSER_STATE_DIR || path.join(os.homedir(), '.cobrowser'), 'forgotten-bindings.json');
}

function read(): string[] {
  try {
    const v = JSON.parse(fs.readFileSync(file(), 'utf8')) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function write(list: string[]): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  if (list.length) fs.writeFileSync(file(), JSON.stringify(list, null, 2));
  else fs.rmSync(file(), { force: true });
}

/** Note that `workspace`'s binding is to go. */
export function forgetBinding(workspace: string): void {
  const list = read();
  if (!list.includes(workspace)) write([...list, workspace]);
}

/** Whether `workspace`'s binding was to go; the note is taken, so it is said once. */
export function takeForgottenBinding(workspace: string): boolean {
  const list = read();
  if (!list.includes(workspace)) return false;
  write(list.filter((w) => w !== workspace));
  return true;
}
