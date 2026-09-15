/** Wire types shared by the daemon and the extension that registers with it. */

/** One editor window, offering the browser it owns for its workspace. */
export interface Registration {
  /** The workspace folder path — canonical and collision-free. */
  id: string;
  /** The folder's basename, accepted as a friendlier alias when unambiguous. */
  name: string;
  /** That window's own MCP endpoint, e.g. http://127.0.0.1:53211/mcp */
  url: string;
  /** Bearer token for `url` (each window still has its own). */
  token: string;
  /** Extension-host pid, so the daemon can detect a window that died without deregistering. */
  pid: number;
}

export interface HealthResponse {
  version: string;
  pid: number;
  workspaces: { id: string; name: string }[];
}

/** Default daemon port. Fixed, because the whole point is a URL that never moves. */
export const DEFAULT_DAEMON_PORT = 39273;

/**
 * Port for a daemon started by an Extension Development Host (F5).
 *
 * Development must not touch the daemon the user's real windows depend on: sharing it means
 * every rebuild restarts a process eight workspaces are registered with, emptying the
 * registry and knocking their agents offline. A separate port + token keeps the two
 * completely unaware of each other.
 */
export const DEV_DAEMON_PORT = 39274;

/** Exit once no window has been registered for this long, so a closed editor
 *  leaves nothing running behind it. */
export const IDLE_EXIT_MS = 120_000;
