/**
 * cobrowserd — the single MCP endpoint shared by every editor window.
 *
 * Why a separate process: each window's webview panels hold a BrowserSession in THAT
 * window's extension host, so no one process can own every browser. The daemon therefore
 * owns only the port, the token and the tool surface, and PROXIES each call to the window
 * that owns the named workspace. Living outside every window means the URL survives windows
 * opening and closing, which is what lets one config entry stay valid forever.
 *
 * Routing depends on the credential presented. A window's own token pins the caller to THAT
 * workspace — which is what the per-project Claude Code entry carries, so an AI session opened
 * in a folder can only ever drive that folder's browser. The admin token (the daemon's own
 * token file) is unscoped and must name a `workspace` on every call.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { isLoopbackHost, isLoopbackUrl } from '../util/localhost';
import { IDLE_EXIT_MS, type HealthResponse, type Registration } from './protocol';
import { Registry, isSelf } from './registry';
import { listWorkspacesTool, withWorkspaceArg, type Tool } from './toolSchema';
import { callUpstream, isUnreachable } from './upstream';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const PORT = Number(arg('--port'));
const TOKEN_FILE = arg('--token-file') ?? '';
const VERSION = arg('--version') ?? '0.0.0';

if (!Number.isInteger(PORT) || !TOKEN_FILE) {
  console.error('usage: daemon.js --port <n> --token-file <path> --version <v>');
  process.exit(2);
}

/** Read fresh every time rather than caching at startup: a window may regenerate the token
 *  file, and a daemon holding the old value would 401 every client with no way to recover
 *  (the shutdown route is itself authenticated). */
function currentToken(): string | undefined {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

const registry = new Registry(undefined, () => {
  toolCache = undefined; // membership changed: a new window may run a different build
});
/** Upstream tools are identical in every window, so fetch them once. Cleared whenever the
 *  registry changes, since a new window may be running a different build. Stored RAW: the
 *  `workspace` parameter is injected per caller, and a workspace-scoped caller never sees it. */
let toolCache: Tool[] | undefined;
let lastOccupied = Date.now();

const log = (m: string): void => console.log(`[cobrowserd] ${m}`);

// ---------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------
// Upstream (per-window) JSON-RPC
// ---------------------------------------------------------------------------------------


/** The tool surface exactly as a window publishes it. */
let toolsInFlight: Promise<Tool[]> | undefined;
async function rawTools(): Promise<Tool[]> {
  if (toolCache) return toolCache;
  // Several clients can ask for tools/list at once; without this they each hit a window.
  if (toolsInFlight) return toolsInFlight;
  toolsInFlight = fetchRawTools().finally(() => (toolsInFlight = undefined));
  return toolsInFlight;
}

async function fetchRawTools(): Promise<Tool[]> {
  if (toolCache) return toolCache;
  for (const reg of registry.list()) {
    try {
      const result = (await callUpstream(reg, 'tools/list', {}, { version: VERSION })) as { tools?: Tool[] };
      toolCache = result.tools ?? [];
      return toolCache;
    } catch (e) {
      log(`tools/list failed against ${reg.name}: ${String(e)}`);
    }
  }
  return [];
}

/**
 * Who is calling.
 *
 * The daemon token (the file on disk) is the ADMIN credential: it registers windows and can
 * name any workspace. A window's own token identifies that WORKSPACE, and is what the
 * per-project Claude Code entry carries — so a session opened in a folder can only ever reach
 * that folder's browser. The restriction is enforced by the credential, not by trusting what
 * the caller asks for.
 */
type Caller = { kind: 'admin' } | { kind: 'workspace'; reg: Registration };

function authenticate(req: http.IncomingMessage): Caller | undefined {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
  const presented = header.slice('Bearer '.length);
  if (!presented) return undefined;
  const admin = currentToken();
  if (admin && presented === admin) return { kind: 'admin' };
  const scoped = registry.byToken(presented);
  return scoped ? { kind: 'workspace', reg: scoped } : undefined;
}

// ---------------------------------------------------------------------------------------
// MCP endpoint
// ---------------------------------------------------------------------------------------

/** `scope` is set when the caller presented a workspace's own token: every call is then
 *  pinned to that workspace and no argument can widen it. */
function buildServer(scope: Registration | undefined): Server {
  const server = new Server(
    { name: 'cobrowser', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const raw = await rawTools();
    return scope
      ? { tools: [listWorkspacesTool(true), ...raw] }
      : { tools: [listWorkspacesTool(false), ...withWorkspaceArg(raw)] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = { ...((req.params.arguments ?? {}) as Record<string, unknown>) };

    if (name === 'list_workspaces') {
          // A scoped session is told about its own workspace only — it cannot reach any other,
      // so listing them would just be noise.
      const list = (scope ? [scope] : registry.list()).map((r) => ({ id: r.id, name: r.name }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }] };
    }

    let target: Registration;
    if (scope) {
      const asked = typeof args.workspace === 'string' ? args.workspace : '';
      // Refuse rather than silently redirect: an agent that thinks it is driving another
      // workspace should be corrected, not quietly given its own browser.
      if (asked && !isSelf(scope, asked)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `This session is bound to the "${scope.name}" workspace and cannot act on "${asked}". Open that folder in its own editor window to drive its browser.`,
            },
          ],
          isError: true,
        };
      }
      target = scope;
    } else {
      const want = typeof args.workspace === 'string' ? args.workspace : '';
      if (!want) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `This tool needs a "workspace" argument. ${registry.hint()}`,
            },
          ],
          isError: true,
        };
      }
      const resolved = registry.resolve(want);
      if ('error' in resolved) {
        return { content: [{ type: 'text' as const, text: resolved.error }], isError: true };
      }
      target = resolved.ok;
    }
    delete args.workspace; // the window's tools never saw this parameter

    try {
      const result = await callUpstream(target, 'tools/call', { name, arguments: args }, { version: VERSION });
      return result as { content: { type: 'text'; text: string }[] };
    } catch (e) {
      // A refused connection means the window is gone but its host pid lingers; drop it so
      // the next list_workspaces is honest.
      if (isUnreachable(e)) {
        registry.remove(target.id);
      }
      return {
        content: [{ type: 'text' as const, text: `cobrowser (${target.name}): ${String(e)}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 8 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const json = (res: http.ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

const httpServer = http.createServer((req, res) => {
  void (async () => {
    const caller = authenticate(req);
    if (!caller) {
      res.writeHead(401).end('Unauthorized');
      return;
    }
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403).end('Forbidden host');
      return;
    }
    const url = (req.url ?? '').split('?')[0];
    // Registering windows, reading the full registry and shutting the daemon down are admin
    // operations. A workspace token must not be able to enrol another workspace or kill the
    // daemon out from under every other window.
    if (url !== '/mcp' && !url.startsWith('/mcp') && caller.kind !== 'admin') {
      res.writeHead(403).end('Forbidden');
      return;
    }

    if (req.method === 'GET' && url === '/health') {
      const body: HealthResponse = {
        version: VERSION,
        pid: process.pid,
        workspaces: registry.list().map((r) => ({ id: r.id, name: r.name })),
      };
      json(res, 200, body);
      return;
    }

    if (req.method === 'POST' && url === '/register') {
      const reg = (await readBody(req)) as Registration;
      // pid is as required as the rest: without a live one, prune() cannot tell whether the
      // window still exists and the entry would either linger forever or vanish at once.
      if (!reg?.id || !reg.url || !reg.token || !Number.isInteger(reg.pid)) {
        json(res, 400, { error: 'id, url, token and pid are required' });
        return;
      }
      // Never proxy anywhere but this machine: a registration is a URL we will send a
      // bearer token to, so it must not be able to point outward.
      if (!isLoopbackUrl(reg.url)) {
        json(res, 400, { error: 'url must be a loopback address' });
        return;
      }
      registry.add(reg);
      lastOccupied = Date.now();
      log(`registered ${reg.name} (${reg.id}) -> ${reg.url}`);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url === '/deregister') {
      const { id } = ((await readBody(req)) ?? {}) as { id?: string };
      if (id && registry.remove(id)) log(`deregistered ${id}`);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url === '/shutdown') {
      log('shutdown requested');
      json(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 50);
      return;
    }

    if (req.method === 'POST' && url.startsWith('/mcp')) {
      // Same shape as the per-window server: a FRESH server+transport per POST, since in
      // stateless mode the two are 1:1 and correlate replies by JSON-RPC id — one shared
      // instance would misroute concurrent requests from several clients.
      const body = await readBody(req);
      const server = buildServer(caller.kind === 'workspace' ? caller.reg : undefined);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    res.writeHead(404).end('Not Found');
  })().catch((err) => {
    log(`handler error: ${String(err)}`);
    if (!res.headersSent) res.writeHead(500).end('Internal Server Error');
    else res.end();
  });
});

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  // Two windows can race to spawn us; the loser simply exits and uses the winner's daemon.
  log(err.code === 'EADDRINUSE' ? `port ${PORT} already in use — exiting` : `listen error: ${String(err)}`);
  process.exit(1);
});

httpServer.listen(PORT, '127.0.0.1', () => log(`listening on http://127.0.0.1:${PORT}/mcp (v${VERSION})`));

setInterval(() => {
  if (registry.size > 0) lastOccupied = Date.now();
  else if (Date.now() - lastOccupied > IDLE_EXIT_MS) {
    log('no workspaces registered — exiting');
    process.exit(0);
  }
}, 15_000).unref?.();

// Never die with the editor window that happened to spawn us.
process.on('SIGHUP', () => undefined);
