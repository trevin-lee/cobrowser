const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * DNS-rebinding guard, done by hand: the MCP SDK's `allowedHosts` check exact-string matches
 * the RAW Host header (which includes the port, e.g. "127.0.0.1:39273"), so its built-in
 * protection would 403 every request. Parse the hostname and compare that instead.
 *
 * Shared by the per-window MCP server and the daemon — both listen on loopback and must
 * refuse a request whose Host header points anywhere else.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return ALLOWED_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}
