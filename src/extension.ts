import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { BrowserSession } from './browser/BrowserSession';
import { ensureChromeExecutable } from './browser/ensureChrome';
import { startMcpHttpServer, type McpHttp } from './mcp/server';
import { BrowserPanel } from './webview/BrowserPanel';
import { SessionTreeProvider } from './webview/SessionTreeProvider';
import { writeClientConfigs } from './clients/writeClientConfigs';
import { CaptureHub } from './video/CaptureHub';
import { ContainerRuntime } from './browser/ContainerRuntime';

const PID_KEY = 'cobrowser.browserPid';
const BUILD_ID_KEY = 'cobrowser.chromeBuildId';
// Bearer token for the local MCP endpoint. Stored in workspaceState (NOT globalState): each
// workspace gets its OWN token, and it PERSISTS across reloads. Per-workspace so two windows
// never share one endpoint (a rotating or shared token invalidates the written client configs
// or makes both agents authenticate to the same server); persisted so the agent's connection
// survives reloads. Paired with a per-workspace port below → a stable, unique endpoint URL.
const TOKEN_KEY = 'cobrowser.mcpToken';
// The MCP port this workspace bound last time — reused on reload so the URL stays stable,
// while a different workspace picks a different free port (no cross-window collision).
const PORT_KEY = 'cobrowser.mcpPort';
// This workspace's previous extension-host pid. Lets bindPort reclaim the port from OUR OWN
// crashed predecessor without ever killing another window's LIVE host (that mutual kill is
// what crashed the extension host and made two repos drive each other's browsers).
const EH_PID_KEY = 'cobrowser.extHostPid';
// Per-workspace: was a browser running here? If so, relaunch it on activation so a
// window reload brings the tabs back instead of leaving the editor tabs empty.
const WAS_RUNNING_KEY = 'cobrowser.wasRunning';
// The kept-alive Chrome's DevTools ws endpoint, so a reload can reconnect to it (tabs
// intact) instead of relaunching + restoring.
const WS_KEY = 'cobrowser.wsEndpoint';
// Our own copy of the open tabs (URL + editor column), updated on every pages-change and
// panel-layout change. Reconnect and --restore-last-session both fail when Chrome dies
// WITH the extension host (a normal window reload kills the whole tree, and an unclean
// exit disables Chrome's restore) — this is the fallback that actually brings the tabs
// back, in the split layout they were arranged in.
const TABS_KEY = 'cobrowser.openTabs';
interface SavedTab {
  url: string;
  col?: number;
}

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

  // Cache the webview assets now, while this version's install dir is guaranteed present —
  // a later release prunes old dirs, and a panel opened afterward must not read from a
  // deleted dir (the unstyled-toolbar bug).
  BrowserPanel.primeAssets(context);

  let token = context.workspaceState.get<string>(TOKEN_KEY);
  if (!token) {
    token = crypto.randomUUID();
    await context.workspaceState.update(TOKEN_KEY, token);
  }
  const cfg = vscode.workspace.getConfiguration('cobrowser');
  // A user-pinned `cobrowser.port` wins; otherwise reuse this workspace's persisted port so
  // the URL is stable across reloads, falling back to 0 (OS picks a free port) the first time.
  const pinnedPort = cfg.get<number>('port', 0);
  const preferredPort = pinnedPort > 0 ? pinnedPort : context.workspaceState.get<number>(PORT_KEY) ?? 0;
  // Hand bindPort our previous host's pid so it can reclaim the port from our OWN stale
  // predecessor only — never from another live window. Then record ours for next time.
  const predecessorPid = context.workspaceState.get<number>(EH_PID_KEY);
  await context.workspaceState.update(EH_PID_KEY, process.pid);

  // Per-workspace profile (isolated logins/tabs per project + no two-window SingletonLock
  // conflict). Falls back to global storage for a window with no folder open.
  const profileBase = context.storageUri ?? context.globalStorageUri;
  const profileDir = path.join(profileBase.fsPath, 'chrome-profile');
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(profileDir));

  // Activity Bar sidebar: profile(s) + their open tabs. Created before getSession
  // so its `() => session` closure is always initialized when first read.
  // Assigned after the MCP HTTP server is up (shares its port); wire() below runs
  // later than that in practice, but keep the reference optional to stay safe.
  let captureHub: CaptureHub | undefined;
  let container: ContainerRuntime | undefined;

  const tree = new SessionTreeProvider(
    { label: vscode.workspace.name ?? 'Default', path: profileDir },
    () => session,
  );
  context.subscriptions.push(vscode.window.registerTreeDataProvider('cobrowser.sessions', tree));

  // Wire a fresh OR reconnected session: persistence + listeners + open panels for its
  // existing pages. Shared by launch (getSession) and reconnect-on-activate.
  const wire = async (s: BrowserSession): Promise<BrowserSession> => {
    session = s;
    captureHub?.setSession(s); // old controller page died with the old Chrome
    const pid = s.pid();
    if (pid !== undefined) await context.globalState.update(PID_KEY, pid);
    await context.workspaceState.update(WAS_RUNNING_KEY, true);
    await context.workspaceState.update(WS_KEY, s.wsEndpoint());
    s.onAllClosed(() => {
      // Last tab closed → the browser quits itself. onDisconnected skips cleanup
      // here (isDisposing is set), so clear the session ourselves — otherwise the
      // dead session stays cached and every later tool call returns "Connection
      // closed". Clearing it makes the next tool/panel relaunch a fresh browser.
      void context.workspaceState.update(WAS_RUNNING_KEY, false);
      void context.workspaceState.update(WS_KEY, undefined);
      void context.globalState.update(PID_KEY, undefined);
      BrowserPanel.disposeAll();
      if (session === s) session = undefined;
      sessionPromise = undefined;
      tree.refresh(); // profile → "stopped", tabs cleared
    });

    // One VS Code editor tab per browser page — VS Code's tab bar is the tab bar.
    s.onPageOpened((page, id, reveal) => BrowserPanel.openForPage(context, s, page, id, reveal));
    s.onPageClosed((id) => BrowserPanel.closeForId(id));
    s.onPageReveal((id) => BrowserPanel.reveal(id));
    s.onAgentHighlight((id, box) => BrowserPanel.get(id)?.postHighlight(box));
    // Keep the Activity Bar sidebar live: re-render its tab list whenever pages open,
    // close, navigate, or the active tab changes. (These fire sites existed but were
    // never connected to the tree, so the sidebar showed a stale first snapshot.)
    // Also persist the open tabs — URL + editor column — so a reload restores both the
    // tabs and the split layout they were arranged in.
    const saveTabs = (): void => {
      const entries = s
        .pageEntries()
        .filter((e) => e.url && e.url !== 'about:blank')
        .map((e) => ({ url: e.url, col: BrowserPanel.columnOf(e.id) }));
      void context.workspaceState.update(TABS_KEY, entries);
    };
    s.onPagesChanged(() => {
      tree.refresh();
      saveTabs();
    });
    // Dragging a panel to another editor group fires no session event — hook the panel
    // layer so layout changes persist too.
    BrowserPanel.onLayoutChanged = saveTabs;

    s.onDisconnected(() => {
      // Only for UNEXPECTED exits (crash / Cmd-Q). Intentional disconnect (reload) and
      // close set isDisposing and are handled by disposeSession — keeping WS_KEY for a
      // reconnect in the reload case.
      if (s.isDisposing) return;
      log('Chromium exited unexpectedly — clearing session; it will relaunch on next use.');
      BrowserPanel.disposeAll();
      if (session === s) session = undefined;
      sessionPromise = undefined;
      void context.workspaceState.update(WS_KEY, undefined);
      void context.globalState.update(PID_KEY, undefined);
      tree.refresh(); // profile → "stopped"
    });

    // Open panels for pages that already exist (restored/reconnected tabs, or pages that
    // appeared during launch before these listeners were wired) — no orphaned Chrome page.
    s.emitExisting();
    tree.refresh(); // reflect the now-running session (state + initial tabs)
    return s;
  };

  // After a fresh launch, reopen the tabs we saved from the previous session. Only runs
  // when the browser came up with nothing but the initial blank page — if Chrome's own
  // --restore-last-session worked, we skip rather than duplicate.
  const restoreTabs = async (s: BrowserSession, tabs: SavedTab[]): Promise<void> => {
    try {
      if (tabs.length === 0) return;
      if (s.pageEntries().some((e) => e.url && e.url !== 'about:blank')) return; // Chrome restored on its own
      log(`Restoring ${tabs.length} saved tab(s).`);
      await s.run(() => s.navigate('url', tabs[0].url)); // reuse the initial blank page
      for (const t of tabs.slice(1)) {
        await s.run(() => s.newPage(t.url, { background: true }));
      }
    } catch (err) {
      log(`Tab restore failed: ${String(err)}`);
    } finally {
      BrowserPanel.clearColumnPlan(); // whatever's left no longer maps to anything
      BrowserPanel.disposeUnclaimedRestored(); // ghost shells whose pages never came back
    }
  };

  // Lazily launch the browser only when first needed (a tool call or the panel opening),
  // so merely opening an editor window doesn't spawn Chrome.
  const getSession = async (): Promise<BrowserSession> => {
    if (session) return session;
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const headless = cfg.get<boolean>('headless', true);
        const autoFallbackPasskeys = cfg.get<boolean>('autoFallbackPasskeys', true);

        // Container backend: run the browser in a container and capture its X11
        // framebuffer, which bypasses Chromium's ~45fps capture ceiling (measured ~248fps
        // of changed frames). Automation is unchanged — we just connect CDP to it.
        if (cfg.get<string>('backend', 'local') === 'container') {
          if (!(await ContainerRuntime.dockerAvailable())) {
            void vscode.window.showErrorMessage(
              'Cobrowser: cobrowser.backend is "container" but Docker is not running.',
            );
            throw new Error('docker unavailable');
          }
          const w = cfg.get<number>('containerWidth', 2200);
          const h = cfg.get<number>('containerHeight', 1400);
          const cdpPort = (mcp?.port ?? 39273) + 1;
          const framePort = (mcp?.port ?? 39273) + 2;
          // MUST be its own profile dir. Mounting the local one made container Chromium
          // refuse to start outright — the macOS Chrome's SingletonLock is in there
          // ("profile appears to be in use ... on another computer"), so it exits before
          // ever binding the debugging port.
          const containerProfile = path.join(profileBase.fsPath, 'container-profile');
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(containerProfile));
          container ??= new ContainerRuntime(
            `cobrowser-${vscode.workspace.name ?? 'default'}`.replace(/[^a-zA-Z0-9_.-]/g, '-'),
            containerProfile,
            log,
          );
          await container.start({ cdpPort, framePort, width: w, height: h });
          const wsEndpoint = await container.wsEndpoint(cdpPort);
          // ownViewport: let the page fill the container's window (that window is what
          // gets captured); puppeteer's default 800x600 override left it tiny on a blank
          // 2200x1400 desktop.
          const s = await BrowserSession.connect(wsEndpoint, true, autoFallbackPasskeys, true);
          // Belt and braces for the container-REUSE case: defaultViewport:null stops us
          // adding an override, but it cannot undo one a previous connection left behind,
          // and a stale 800x600 renders the page tiny on a blank framebuffer.
          await s.clearViewportOverrides();
          // Container frames are always H.264: at these rates PNG would push >100MB/s
          // through the socket, and fragmented MP4 renders in a <video> element that the
          // editor composites natively (no per-frame JavaScript).
          BrowserPanel.containerFrameUrl = container.frameUrl(
            framePort,
            'h264',
            cfg.get<number>('containerFps', 120),
          );
          log(`Container backend ready: CDP ${cdpPort}, frames ${framePort} (${w}x${h}).`);
          return wire(s);
        }

        // Reconnect to a Chrome kept alive across a reload (tabs intact) before launching.
        const savedWs = context.workspaceState.get<string>(WS_KEY);
        if (savedWs) {
          try {
            const s = await BrowserSession.connect(savedWs, headless, autoFallbackPasskeys);
            log('Reconnected to the browser from before the reload — tabs intact.');
            const wired = await wire(s);
            BrowserPanel.disposeUnclaimedRestored(); // pages adopted their shells in wire()
            return wired;
          } catch {
            await context.workspaceState.update(WS_KEY, undefined);
            log('Previous browser is gone; launching a fresh one.');
          }
        }
        // No live browser — clear any stale SingletonLock, then launch fresh.
        // Snapshot OUR saved tab list first: wire() fires pagesChanged for the fresh
        // blank page, which overwrites TABS_KEY before restore could read it.
        const savedTabs = (context.workspaceState.get<Array<string | SavedTab>>(TABS_KEY) ?? [])
          .map((t) => (typeof t === 'string' ? { url: t } : t)); // pre-0.1.25 saves were bare URLs
        // Plan panel columns BEFORE wiring: the first restored page's panel opens during
        // wire()/emitExisting, and each recreated panel must land in its pre-reload group.
        BrowserPanel.planColumns(savedTabs.map((t) => t.col));
        await cleanupOrphan(context, profileDir, log);
        const chromePath = await ensureChrome(context, cfg, log);
        const s = await BrowserSession.launch(
          profileDir,
          chromePath,
          headless,
          autoFallbackPasskeys,
          cfg.get<boolean>('uncapFrameRate', false),
        );
        log(`Chromium launched (pid ${s.pid() ?? '?'}), profile ${profileDir}`);
        const wired = await wire(s);
        void restoreTabs(wired, savedTabs);
        return wired;
      })();
      sessionPromise.catch((err) => {
        sessionPromise = undefined;
        log(`Chromium launch failed: ${String(err)}`);
        void vscode.window.showErrorMessage(`Cobrowser: ${String(err)}`);
      });
    }
    return sessionPromise;
  };

  // Restore cobrowser tabs INSTANTLY on reload, like editor tabs: VS Code recreates the
  // panel shells at startup and hands them here — each paints its toolbar immediately and
  // waits to be adopted by its page once the browser is up (openForPage matches by URL).
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('cobrowser', {
      deserializeWebviewPanel: async (panel, state) => {
        BrowserPanel.addRestored(context, panel, (state as { url?: string } | undefined)?.url);
        void getSession(); // ensure the browser comes back to claim the shells
      },
    }),
  );

  // In-process MCP server (per-request stateless transport).
  mcp = await startMcpHttpServer(token, preferredPort, predecessorPid, getSession, log);

  // Hardware-video pipeline (experimental, cobrowser.videoPipeline): a hidden in-browser
  // controller captures tabs and streams WebCodecs H.264 over a WebSocket on the SAME
  // port/token as the MCP server; panels fall back to the JPEG screencast on any failure.
  captureHub = new CaptureHub(
    token,
    vscode.Uri.joinPath(context.extensionUri, 'media', 'capture.html').fsPath,
    log,
  );
  captureHub.attach(mcp.httpServer, mcp.port);
  captureHub.onFrame((h) => BrowserPanel.routeVideo(h));
  if (session) captureHub.setSession(session); // session may already exist (fast restore)
  BrowserPanel.onDebug = (line) => log(line);
  BrowserPanel.videoHub = captureHub;
  BrowserPanel.videoEnabled = cfg.get<boolean>('videoPipeline', false);
  BrowserPanel.imageFormat = cfg.get<'jpeg' | 'png'>('imageFormat', 'jpeg');
  // Live-apply the toggle: re-read on change and restart streaming so switching
  // pipelines doesn't need a window reload (the setting is read at activation only).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      const video = e.affectsConfiguration('cobrowser.videoPipeline');
      const format = e.affectsConfiguration('cobrowser.imageFormat');
      if (!video && !format) return;
      const c = vscode.workspace.getConfiguration('cobrowser');
      BrowserPanel.videoEnabled = c.get<boolean>('videoPipeline', false);
      BrowserPanel.imageFormat = c.get<'jpeg' | 'png'>('imageFormat', 'jpeg');
      log(
        `Render settings changed: pipeline=${BrowserPanel.videoEnabled ? 'webrtc' : 'screencast'}, format=${BrowserPanel.imageFormat}.`,
      );
      void BrowserPanel.restartStreaming();
    }),
  );
  const hubRef = captureHub;
  context.subscriptions.push({ dispose: () => hubRef.dispose() });
  // Don't leave a container (and its published ports) running after the window closes.
  context.subscriptions.push({ dispose: () => void container?.stop() });
  // Remember the port we actually bound so the next reload of THIS workspace reuses it
  // (stable URL). Skip when the user pinned a port — that's already fixed by config.
  if (pinnedPort <= 0) await context.workspaceState.update(PORT_KEY, mcp.port);

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
      const s = await getSession();
      // Open a panel for each existing page (reveals the active one). Future
      // pages open their panels via onPageOpened.
      s.emitExisting();
    }),
    vscode.commands.registerCommand('cobrowser.newTab', async () => {
      const s = await getSession();
      await s.newPage('about:blank');
    }),
    vscode.commands.registerCommand('cobrowser.restartBrowser', async () => {
      await disposeSession(context);
      await getSession();
      void vscode.window.showInformationMessage('Cobrowser: browser restarted.');
    }),
  );

  // If a browser was running in this workspace before (e.g. a window reload), bring it
  // back now — getSession reconnects to the kept-alive Chrome (tabs intact, no gap), or
  // relaunches if it truly exited — instead of leaving the editor with no browser tabs.
  if (context.workspaceState.get<boolean>(WAS_RUNNING_KEY)) {
    void getSession();
  }

  log(`Cobrowser activated. MCP endpoint: http://127.0.0.1:${mcp.port}/mcp`);
}

export async function deactivate(): Promise<void> {
  // Reload/window-close: DETACH but keep Chrome + its tabs alive, so reactivating
  // reconnects to exactly the same state. Only an explicit restart actually quits it.
  await disposeSession(extensionContext, { keepAlive: true });
  await mcp?.close();
  mcp = undefined;
}

async function disposeSession(
  context: vscode.ExtensionContext | undefined,
  opts?: { keepAlive?: boolean },
): Promise<void> {
  const s = session;
  session = undefined;
  sessionPromise = undefined;
  // Mark teardown first, so disposing panels (which close their pages) doesn't trip the
  // "last tab closed" quit path and clear the relaunch flag during a reload.
  s?.beginDispose();
  BrowserPanel.disposeAll(); // close the browser editor tabs along with the session
  if (s) {
    try {
      if (opts?.keepAlive) {
        await s.disconnect(); // reload/close → leave Chrome + tabs alive to reconnect
      } else {
        await s.dispose(); // restartBrowser → actually quit Chrome
        if (context) await context.workspaceState.update(WS_KEY, undefined);
      }
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
  // Reap EVERY orphaned cobrowser Chromium bound to our profile, not just the last
  // tracked pid. Reloads keep Chrome alive on purpose (for reconnect); when reconnect
  // later fails and we fall through to a fresh launch, any prior instances would
  // otherwise pile up (we saw 9). This only runs on the launch path — never when we
  // just reconnected — so it can't kill an instance we're actually using.
  for (const orphan of findCobrowserChromePids(profileDir)) {
    try {
      process.kill(orphan, 'SIGKILL');
      log(`Reaped orphaned Chromium (pid ${orphan}).`);
    } catch {
      /* already dead */
    }
  }
  await context.globalState.update(PID_KEY, undefined);
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

/** PIDs of all live main Chromium processes launched against our profile dir.
 *  Matches `--user-data-dir=<profileDir>` (only the main process carries that flag,
 *  so helpers/renderers are excluded and die with their parent). */
function findCobrowserChromePids(profileDir: string): number[] {
  try {
    const out = execFileSync('ps', ['ax', '-o', 'pid=,command='], { encoding: 'utf8' });
    const needle = `--user-data-dir=${profileDir}`;
    const pids: number[] = [];
    for (const line of out.split('\n')) {
      if (!line.includes(needle)) continue;
      const pid = Number.parseInt(line.trim().split(/\s+/)[0], 10);
      if (Number.isInteger(pid) && pid !== process.pid) pids.push(pid);
    }
    return pids;
  } catch {
    return []; // ps failed — reap nothing rather than risk a wrong kill
  }
}
