import type { Registration } from './protocol';

/** Injectable so tests can simulate a window whose host died. */
export type IsAlive = (pid: number) => boolean;

/** Signal 0 tests for existence without delivering anything. */
export const pidAlive: IsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export type Resolution = { ok: Registration } | { error: string };

/**
 * The set of windows currently offering a browser, keyed by workspace path.
 *
 * Extracted from the daemon's module scope so the routing rules — which decide WHICH
 * browser a call reaches — can be tested directly. Getting these wrong means an agent
 * silently driving another workspace's browser, which no type check would catch.
 */
export class Registry {
  private entries = new Map<string, Registration>();

  constructor(
    private readonly isAlive: IsAlive = pidAlive,
    /** Called whenever membership changes, so cached tool schemas can be dropped. */
    private readonly onChange: () => void = () => undefined,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  add(reg: Registration): void {
    this.entries.set(reg.id, reg);
    this.onChange();
  }

  /** @returns whether anything was actually removed. */
  remove(id: string): boolean {
    const had = this.entries.delete(id);
    if (had) this.onChange();
    return had;
  }

  /** Drop windows whose extension host is gone. A crashed window never deregisters, and a
   *  phantom entry would otherwise sit in list_workspaces forever. */
  prune(): Registration[] {
    const dead: Registration[] = [];
    for (const [id, reg] of this.entries) {
      if (!this.isAlive(reg.pid)) {
        this.entries.delete(id);
        dead.push(reg);
      }
    }
    if (dead.length) this.onChange();
    return dead;
  }

  /** Live registrations, pruned first so callers never see a phantom. */
  list(): Registration[] {
    this.prune();
    return [...this.entries.values()];
  }

  /** The workspace a bearer token belongs to, or undefined. This is what pins an AI
   *  session to one folder: the credential identifies the workspace, not the request. */
  byToken(token: string): Registration | undefined {
    if (!token) return undefined;
    this.prune();
    for (const reg of this.entries.values()) {
      if (reg.token === token) return reg;
    }
    return undefined;
  }

  /** Resolve a `workspace` argument: exact path first, then unique folder-name alias. */
  resolve(want: string): Resolution {
    this.prune();
    const byId = this.entries.get(want);
    if (byId) return { ok: byId };

    const matches = [...this.entries.values()].filter(
      (r) => r.name.toLowerCase() === want.toLowerCase(),
    );
    if (matches.length === 1) return { ok: matches[0] };

    const open = [...this.entries.values()].map((r) => `${r.name} (${r.id})`);
    if (matches.length > 1) {
      return {
        error: `"${want}" matches more than one open workspace. Use the full path: ${open.join(', ')}`,
      };
    }
    return {
      error: open.length
        ? `Unknown workspace "${want}". Open workspaces: ${open.join(', ')}`
        : 'No cobrowser workspaces are open. Open a folder in an editor window with the cobrowser extension active.',
    };
  }

  /** Names only, for the "you must pass a workspace" hint. */
  hint(): string {
    const open = this.list().map((r) => r.name);
    return open.length ? `Open workspaces: ${open.join(', ')}` : 'No cobrowser workspaces are open.';
  }
}

/** Does `want` name this scoped caller's own workspace? */
export function isSelf(reg: Registration, want: string): boolean {
  return want === reg.id || want.toLowerCase() === reg.name.toLowerCase();
}
