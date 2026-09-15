import * as fs from 'node:fs';
import * as path from 'node:path';
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
  /**
   * Workspaces we have EVER seen, by token — survives a daemon restart.
   *
   * Authentication and liveness are different questions. A daemon restart empties the live
   * registry, and if a token only authenticates against that, every client is met with a bare
   * 401 until its window happens to reload. Clients read 401 as "this server wants OAuth" and
   * fall into Dynamic Client Registration, so a routine upgrade looked like an auth system
   * failure. Remembering the token lets us answer "who are you" even while the window is
   * down, and say something useful instead.
   */
  private known = new Map<string, { id: string; name: string }>();

  constructor(
    private readonly isAlive: IsAlive = pidAlive,
    /** Called whenever membership changes, so cached tool schemas can be dropped. */
    private readonly onChange: () => void = () => undefined,
    /** Where to persist known workspaces. Omitted in tests. */
    private readonly store?: string,
  ) {
    if (store) this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.store!, 'utf8')) as Record<string, { id: string; name: string }>;
      for (const [token, who] of Object.entries(raw)) this.known.set(token, who);
    } catch {
      /* first run, or unreadable — we simply know nobody yet */
    }
  }

  private persist(): void {
    if (!this.store) return;
    try {
      fs.mkdirSync(path.dirname(this.store), { recursive: true });
      const obj = Object.fromEntries(this.known);
      // 0600: this file maps tokens to workspaces, same sensitivity as the token itself.
      fs.writeFileSync(this.store, JSON.stringify(obj), { mode: 0o600 });
    } catch {
      /* best effort: losing persistence costs a 401 after restart, not correctness */
    }
  }

  /** A workspace we have seen before, even if its window is not running right now. */
  knownByToken(token: string): { id: string; name: string } | undefined {
    return token ? this.known.get(token) : undefined;
  }

  get size(): number {
    return this.entries.size;
  }

  add(reg: Registration): void {
    this.entries.set(reg.id, reg);
    if (!this.known.has(reg.token)) {
      this.known.set(reg.token, { id: reg.id, name: reg.name });
      this.persist();
    }
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
