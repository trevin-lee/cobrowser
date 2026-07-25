import type { Server } from 'node:http';

/**
 * Bind `server` to `preferred` on 127.0.0.1. If that port is taken, fall back to
 * an ephemeral port (0). Resolves with the actually-bound port.
 */
export function bindPort(server: Server, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && preferred !== 0) {
        server.removeListener('error', onError);
        server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
      } else {
        reject(err);
      }
    };
    server.once('error', onError);
    server.listen(preferred, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve((server.address() as { port: number }).port);
    });
  });
}
