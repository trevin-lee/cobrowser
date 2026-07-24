import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { BrowserSession } from './browser/BrowserSession';
import { ensureChromeExecutable } from './browser/ensureChrome';
import { startMcpHttpServer, type McpHttp } from './mcp/server';
import { BrowserPanel } from './webview/BrowserPanel';
import { writeClientConfigs } from './clients/writeClientConfigs';

const PID_KEY = 'cobrowser.browserPid';
const BUILD_ID_KEY = 'cobrowser.chromeBuildId';

let session: BrowserSession | undefined;
let sessionPromise: Promise<BrowserSession> | undefined;
let mcp: McpHttp | undefined;
let output: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  output = vscode.window.createOutputChannel('Cobrowser');
  context.subscriptions.push(output);
  const log = (m: string) => output.appendLine(m);

  const token = crypto.randomUUID();
  const cfg = vscode.workspace.getConfiguration('cobrowser');
  const preferredPort = cfg.get<number>('port', 39273);

  const profileDir = path.join(context.globalStorageUri.fsPath, 'chrome-profile');
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(profileDir));

  // B3: a previous extension host may have died without closing Chromium, leaving an
  // orphan that holds the persistent profile's SingletonLock. Kill it + clear the locks
  // before we launch, or the reload loop bricks itself.
  await cleanupOrphan(context, profileDir, log);

  // Lazily launch the browser only when first needed (a tool call or the panel opening),
  // so merely opening an editor window doesn't spawn Chrome.
  const getSession = async (): Promise<BrowserSession> => {
    if (session) return session;
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const chromePath = await ensureChrome(context, cfg, log);
        const s = await BrowserSession.launch(profileDir, chromePath);
        session = s;
        const pid = s.pid();
        if (pid !== undefined) await context.globalState.update(PID_KEY, pid);
        // Out-of-band exit (Cmd-Q / crash): drop the dead session so getSession relaunches.
        s.onDisconnected(() => {
          log('Chromium disconnected — clearing session; it will relaunch on next use.');
          if (session === s) session = undefined;
          sessionPromise = undefined;
          void context.globalState.update(PID_KEY, undefined);
        });
        log(`Chromium launched (pid ${pid ?? '?'}), profile ${profileDir}`);
        return s;
      })();
      sessionPromise.catch((err) => {
        sessionPromise = undefined;
        log(`Chromium launch failed: ${String(err)}`);
        void vscode.window.showErrorMessage(`Cobrowser: ${String(err)}`);
      });
    }
    return sessionPromise;
  };

  // In-process MCP server (per-request stateless transport).
  mcp = await startMcpHttpServer(token, preferredPort, getSession, log);

  // B2: VS Code's MCP provider API does not exist in Cursor — feature-detect so
  // activate() doesn't throw there; the file-based writers below cover Cursor/Claude Code.
  const lm = vscode.lm as unknown as {
    registerMcpServerDefinitionProvider?: (id: string, provider: unknown) => vscode.Disposable;
  };
  const McpHttpDef = (vscode as unknown as { McpHttpServerDefinition?: new (...a: unknown[]) => unknown })
    .McpHttpServerDefinition;
  if (typeof lm.registerMcpServerDefinitionProvider === 'function' && McpHttpDef) {
    const didChange = new vscode.EventEmitter<void>();
    context.subscriptions.push(
      didChange,
      lm.registerMcpServerDefinitionProvider('cobrowser.mcp', {
        onDidChangeMcpServerDefinitions: didChange.event,
        provideMcpServerDefinitions: () =>
          mcp
            ? [
                new McpHttpDef(
                  'Cobrowser',
                  vscode.Uri.parse(`http://127.0.0.1:${mcp.port}/mcp`),
                  { Authorization: `Bearer ${token}` },
                  context.extension.packageJSON.version,
                ),
              ]
            : [],
        resolveMcpServerDefinition: (s: unknown) => s,
      }),
    );
    didChange.fire();
    log('Registered MCP server with VS Code (native provider API).');
  } else {
    log('VS Code MCP provider API unavailable (e.g. Cursor) — using file-based registration.');
  }

  // Cursor + Claude Code: write literal port/token into workspace config files.
  await writeClientConfigs(mcp.port, token, log);

  context.subscriptions.push(
    vscode.commands.registerCommand('cobrowser.open', async () => {
      BrowserPanel.show(context, await getSession());
    }),
    vscode.commands.registerCommand('cobrowser.openNativeWindow', async () => {
      const s = await getSession();
      await s.run(() => s.bringActiveToFront());
    }),
    vscode.commands.registerCommand('cobrowser.restartBrowser', async () => {
      await disposeSession(context);
      await getSession();
      void vscode.window.showInformationMessage('Cobrowser: browser restarted.');
    }),
  );

  // Best-effort kill if the host process is torn down abruptly (SIGKILL bypasses this,
  // which is why cleanupOrphan on next activate is the real guard).
  const killer = () => {
    const pid = context.globalState.get<number>(PID_KEY);
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      void context.globalState.update(PID_KEY, undefined);
    }
  };
  process.once('exit', killer);
  process.once('SIGTERM', killer);

  log(`Cobrowser activated. MCP endpoint: http://127.0.0.1:${mcp.port}/mcp`);
}

export async function deactivate(): Promise<void> {
  await disposeSession(extensionContext);
  await mcp?.close();
  mcp = undefined;
}

async function disposeSession(context: vscode.ExtensionContext | undefined): Promise<void> {
  const s = session;
  session = undefined;
  sessionPromise = undefined;
  if (s) {
    try {
      await s.dispose();
    } catch {
      /* ignore */
    }
  }
  if (context) await context.globalState.update(PID_KEY, undefined);
}

async function cleanupOrphan(
  context: vscode.ExtensionContext,
  profileDir: string,
  log: (m: string) => void,
): Promise<void> {
  const pid = context.globalState.get<number>(PID_KEY);
  if (pid !== undefined) {
    // Only SIGKILL if the pid is actually our Chromium — guards against the OS having
    // recycled a stale pid (from a crash that never cleared it) to an unrelated process.
    if (isCobrowserChrome(pid, profileDir)) {
      try {
        process.kill(pid, 'SIGKILL');
        log(`Killed orphaned Chromium (pid ${pid}) from a previous session.`);
      } catch {
        /* already dead */
      }
    }
    await context.globalState.update(PID_KEY, undefined);
  }
  for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.rmSync(path.join(profileDir, lock), { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Resolve the Chrome executable (download-on-first-run), showing a progress notification. */
async function ensureChrome(
  context: vscode.ExtensionContext,
  cfg: vscode.WorkspaceConfiguration,
  log: (m: string) => void,
): Promise<string> {
  const cacheDir = path.join(context.globalStorageUri.fsPath, 'browsers');
  const override = cfg.get<string>('chromePath') || undefined;
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Cobrowser: preparing browser', cancellable: false },
    (progress) =>
      ensureChromeExecutable({
        cacheDir,
        override,
        store: {
          get: () => context.globalState.get<string>(BUILD_ID_KEY),
          set: (id) => context.globalState.update(BUILD_ID_KEY, id),
        },
        onProgress: (downloaded, total) => {
          const mb = (n: number) => Math.round(n / 1e6);
          progress.report({
            message: total
              ? `downloading Chrome ${mb(downloaded)} / ${mb(total)} MB`
              : `downloading Chrome ${mb(downloaded)} MB`,
          });
        },
        log,
      }),
  );
}

/** True only if `pid` is a live process whose command line references our profile dir. */
function isCobrowserChrome(pid: number, profileDir: string): boolean {
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return cmd.includes(profileDir);
  } catch {
    return false; // no such process, or ps failed — do not kill
  }
}
