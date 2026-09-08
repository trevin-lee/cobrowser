import type * as http from 'node:http';
import type { Duplex } from 'node:stream';

export type UpgradeHandler = (
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
) => void;

/**
 * One 'upgrade' listener per HTTP server, routing by pathname.
 *
 * Node runs EVERY 'upgrade' listener for every upgrade request, so two features that each
 * added their own listener and destroyed sockets they didn't recognise would kill each
 * other's connections (the video hub's `/capture` handler vs the Zen bridge's `/zen`).
 * Registering here keeps exactly one listener that dispatches to the right owner and
 * destroys genuinely unclaimed paths once.
 */
const routers = new WeakMap<http.Server, Map<string, UpgradeHandler>>();

export function claimUpgradePath(
  server: http.Server,
  pathname: string,
  handler: UpgradeHandler,
): void {
  let table = routers.get(server);
  if (!table) {
    table = new Map<string, UpgradeHandler>();
    routers.set(server, table);
    const routes = table;
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const owner = routes.get(url.pathname);
      if (!owner) {
        socket.destroy();
        return;
      }
      owner(req, socket, head, url);
    });
  }
  table.set(pathname, handler);
}
