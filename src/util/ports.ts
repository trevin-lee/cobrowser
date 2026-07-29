import type { Server } from 'node:http';
import { execFileSync } from 'node:child_process';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tryListen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve((server.address() as { port: number }).port);
    });
  });
}

function pidOnPort(port: number): number | undefined {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = Number.parseInt((out.split('\n')[0] ?? '').trim(), 10);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined; // lsof missing / nothing on the port
  }
}

/**
 * Confirm `pid` is a VS Code / Cursor extension host before we ever SIGKILL it —
 * a guard against pid reuse (the OS may have recycled our predecessor's pid to an
 * unrelated process). Combined with the exact predecessor-pid match in bindPort,
 * this ensures we only ever kill our OWN stale host, never another live window.
 */
function isExtensionHost(pid: number): boolean {
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return /extension-host|Cursor Helper|Code Helper/i.test(cmd);
  } catch {
    return false;
  }
}

/**
 * Bind `server` to this workspace's `preferred` port so the MCP endpoint URL stays
 * STABLE across editor reloads (a changing port rewrites the client config and drops
 * the agent's connection — the churn behind "cobrowser keeps disconnecting").
 *
 * CRITICAL for multi-window: the port is PER-WORKSPACE, and on EADDRINUSE we reclaim
 * it ONLY from our own crashed predecessor — identified by an exact match against
 * `predecessorPid` (this workspace's previous extension-host pid) and confirmed to be
 * an extension host. A port held by a DIFFERENT live window is left alone; we bind a
 * free port instead. This is what stops two windows from SIGKILLing each other's
 * extension hosts in a loop (and both agents landing on one shared browser).
 *
 * `preferred === 0` (or a collision we won't fight) → let the OS pick any free port;
 * the caller persists whatever we return so the next reload reuses it.
 */
export async function bindPort(
  server: Server,
  preferred: number,
  predecessorPid: number | undefined,
  log?: (m: string) => void,
): Promise<number> {
  if (preferred === 0) return tryListen(server, 0);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await tryListen(server, preferred);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      const holder = pidOnPort(preferred);
      const ourOwnStale =
        holder !== undefined && holder === predecessorPid && holder !== process.pid;
      if (ourOwnStale && isExtensionHost(holder)) {
        // Grace on the first pass so a cleanly-reloading predecessor can free the port
        // itself (keeping its kept-alive Chrome). After that it's a real orphan — reclaim.
        if (attempt >= 1) {
          try {
            process.kill(holder, 'SIGKILL');
            log?.(`Reclaimed port ${preferred} from our own stale host (pid ${holder}).`);
          } catch {
            /* already gone */
          }
        }
        await delay(300);
        continue;
      }
      if (holder === undefined && attempt < 2) {
        await delay(300); // transient (socket in TIME_WAIT / handoff) — retry the same port
        continue;
      }
      // Held by a DIFFERENT window (or an unrelated app). NEVER kill it — that starts the
      // mutual-kill loop. Take a free port; the caller persists it for stable reuse.
      log?.(
        `Port ${preferred} is held by another process (pid ${holder ?? '?'}) — binding a free port so windows don't collide.`,
      );
      return tryListen(server, 0);
    }
  }
  return tryListen(server, 0);
}
