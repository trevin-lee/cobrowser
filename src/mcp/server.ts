import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools';
import { registerFirefoxTools } from './firefoxTools';
import type { BrowserSession } from '../browser/BrowserSession';
import type { FirefoxBridge } from '../firefox/FirefoxBridge';
import { bindPort } from '../util/ports';
import { isLoopbackHost } from '../util/localhost';

export interface McpHttp {
  port: number;
  /** Exposed so the video-capture relay can attach a WebSocket upgrade handler
   *  to the same localhost port (one port, one token, per workspace). */
  httpServer: http.Server;
  close(): Promise<void>;
}

type GetSession = () => Promise<BrowserSession>;
/** Read lazily: the bridge needs this server's port, so it is built after we start. */
type GetZen = () => FirefoxBridge | undefined;
type Log = (message: string) => void;

/**
 * In-process, localhost-only MCP server over Streamable HTTP.
 *
 * B1 fix: in STATELESS mode (`sessionIdGenerator: undefined`) a StreamableHTTPServer
 * transport and McpServer are 1:1 and correlate replies by JSON-RPC id, so a single
 * shared instance would misroute concurrent requests from multiple clients (VS Code +
 * Cursor + Claude Code). We therefore create a FRESH McpServer + transport PER POST,
 * all closing over the ONE shared BrowserSession. Only the wire objects are per-request;
 * the browser stays single-owner.
 */
export async function startMcpHttpServer(
  token: string,
  preferredPort: number,
  predecessorPid: number | undefined,
  getSession: GetSession,
  getZen: GetZen,
  log: Log,
): Promise<McpHttp> {
  const httpServer = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log(`MCP handler error: ${String(err)}`);
      if (!res.headersSent) res.writeHead(500).end('Internal Server Error');
      else res.end();
    });
  });

  // Track live sockets so close() can DESTROY them. http.Server.close() only
  // stops accepting new connections; a keep-alive MCP client connection would
  // otherwise keep the port bound and the extension host alive as a zombie —
  // which is exactly why the preferred port was never free on the next reload.
  const sockets = new Set<import('node:net').Socket>();
  httpServer.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Auth gate BEFORE handing off to the transport.
    if (req.headers['authorization'] !== `Bearer ${token}`) {
      res.writeHead(401).end('Unauthorized');
      return;
    }
    // Liveness probe for the daemon's registry: it prunes a workspace whose window has
    // gone away, and this is how "gone away" is confirmed cheaply.
    if (req.method === 'GET' && req.url?.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }
    if (req.method !== 'POST' || !req.url || !req.url.startsWith('/mcp')) {
      // Stateless mode: the GET SSE stream and DELETE are not supported.
      res.writeHead(405).end('Method Not Allowed');
      return;
    }

    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403).end('Forbidden host');
      return;
    }

    const body = await readJsonBody(req);
    const server = new McpServer({ name: 'cobrowser', version: '0.0.1' });
    registerTools(server, getSession);
    // The firefox_* tools only exist once a bridge is configured, so an agent in a workspace
    // with no Zen binding never sees tools it cannot use.
    const zen = getZen();
    if (zen) registerFirefoxTools(server, zen);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Only the daemon talks to this server now, and a plain JSON reply is far simpler to
      // proxy than an SSE stream.
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const port = await bindPort(httpServer, preferredPort, predecessorPid, log);
  log(`MCP server listening on http://127.0.0.1:${port}/mcp`);

  return {
    port,
    httpServer,
    close: () =>
      new Promise<void>((resolve) => {
        // Destroy live sockets first so the listener actually releases the port
        // now (not whenever a keep-alive client happens to disconnect).
        for (const s of sockets) s.destroy();
        sockets.clear();
        httpServer.close(() => resolve());
        // Belt-and-suspenders: don't let a laggy close() hold up deactivation.
        setTimeout(resolve, 500).unref?.();
      }),
  };
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}
