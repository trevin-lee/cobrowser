import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { BrowserSession } from './browser/BrowserSession';
import { ensureChromeExecutable } from './browser/ensureChrome';
import {
  ensureApplePasswords,
  nativeHostInstalled,
  NATIVE_HOST_INSTALL_COMMAND,
} from './browser/applePasswords';
import { startMcpHttpServer, type McpHttp } from './mcp/server';
import { BrowserPanel } from './webview/BrowserPanel';
import { SessionTreeProvider } from './webview/SessionTreeProvider';
import { writeClientConfigs } from './clients/writeClientConfigs';
import { daemonToken, deregister, ensureDaemon, register } from './daemon/client';
import { DEFAULT_DAEMON_PORT, DEV_DAEMON_PORT } from './daemon/protocol';
import { CaptureHub } from './video/CaptureHub';
import { FirefoxBridge } from './firefox/FirefoxBridge';
import { registerEndpoint } from './firefox/managedManifest';
import { listFirefoxContainers } from './firefox/containers';

const PID_KEY = 'cobrowser.browserPid';
const BUILD_ID_KEY = 'cobrowser.chromeBuildId';
// Bearer token for the local MCP endpoint. Stored in workspaceState (NOT globalState): each
// workspace gets its OWN token, and it PERSISTS across reloads. Per-workspace so two windows
// never share one endpoint (a rotating or shared token invalidates the written client configs
// or makes both agents authenticate to the same server); persisted so the agent's connection
// survives reloads. Paired with a per-workspace port below → a stable, unique endpoint URL.
const TOKEN_KEY = 'cobrowser.mcpToken';
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
// Which Firefox container THIS workspace may drive. Kept in workspaceState rather than the
// setting so the binding is per-workspace WITHOUT a .vscode/settings.json in the repo; the
// setting still works and acts as the fallback.
const FIREFOX_CONTAINER_KEY = 'cobrowser.firefoxContainerBinding';
/** Pre-rename key. Read (and migrated forward) so a binding made before the Zen->Firefox
 *  rename is not silently lost, which would present as "I bound it and nothing happened". */
const LEGACY_CONTAINER_KEY = 'cobrowser.zenContainerBinding';
interface SavedTab {
  url: string;
  col?: number;
}

let session: BrowserSession | undefined;
let sessionPromise: Promise<BrowserSession> | undefined;
let mcp: McpHttp | undefined;
let firefoxBridge: FirefoxBridge | undefined;
let output: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext | undefined;
/** Set once this window has registered with the daemon, so deactivate() can withdraw it. */
let registeredWith: { port: number; id: string; dev: boolean } | undefined;

/**
 * Where the human watches the browser.
 *
 *  - 'panel'  : headless Chrome, screencast as images into a webview panel. No OS window.
 *  - 'window' : real Chrome on the desktop, with NO panel. The panel is a mirror of the same
 *               tab, so showing both was the confusing part: one page visible twice, with the
 *               viewport forced to the panel's size and the real window laid out wrong.
 *
 * The agent drives the same browser either way — only the human's view changes.
 */
type DisplayMode = 'panel' | 'window';

function displayMode(cfg: vscode.WorkspaceConfiguration): DisplayMode {
  const explicit = cfg.get<string>('display');
  if (explicit === 'window' || explicit === 'panel') return explicit;
  // Back-compat: `cobrowser.headless: false` used to be the only way to ask for a real
  // window, so honour it when display hasn't been set.
  const legacy = cfg.inspect<boolean>('headless');
  const set = legacy?.workspaceFolderValue ?? legacy?.workspaceValue ?? legacy?.globalValue;
  return set === false ? 'window' : 'panel';
}

/** The container this workspace may drive: the command-set binding first, then the setting,
 *  then the pre-rename setting. Three sources so the binding can be per-workspace without
 *  writing a file into the repo, and so an existing zenContainer keeps working. */
function firefoxContainerFor(
  context: vscode.ExtensionContext,
  cfg: vscode.WorkspaceConfiguration,
): string {
  const bound = context.workspaceState.get<string>(FIREFOX_CONTAINER_KEY)?.trim();
  if (bound) return bound;
  // Carry a pre-rename binding forward once, so it survives this upgrade rather than
  // requiring the user to re-run the bind command for no visible reason.
  const legacy = context.workspaceState.get<string>(LEGACY_CONTAINER_KEY)?.trim();
  if (legacy) {
    void context.workspaceState.update(FIREFOX_CONTAINER_KEY, legacy);
    void context.workspaceState.update(LEGACY_CONTAINER_KEY, undefined);
    return legacy;
  }
  return (
    cfg.get<string>('firefoxContainer', '').trim() || cfg.get<string>('zenContainer', '').trim()
  );
}

/** The running build's version, so the daemon can be restarted when it is stale. */
function extensionVersion(context: vscode.ExtensionContext): string {
  return (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '0.0.0';
}

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
  // `cobrowser.port` is the DAEMON's port — the one stable URL every client is configured
  // with. This window's own server is an internal detail the daemon proxies to, so it takes
  // any free port (0) and never needs to be stable.
  // An Extension Development Host (F5) is a DIFFERENT cobrowser: its own daemon, port,
  // token and client-config entry. Sharing any of those means every rebuild restarts the
  // daemon the user's real windows are registered with, which knocks their agents offline
  // mid-task — the whole reason iterating on this was disruptive.
  const dev = context.extensionMode === vscode.ExtensionMode.Development;
  const daemonPort = dev ? DEV_DAEMON_PORT : cfg.get<number>('port', 0) || DEFAULT_DAEMON_PORT;
  if (dev) log(`Development host: using the dev daemon on port ${daemonPort}, isolated from your installed cobrowser.`);
  const preferredPort = 0;
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

    // Ordinary tabs in one real window when the human is watching Chrome itself; a window
    // per page only helps the screencast, which window mode does not use.
    s.separateWindows = displayMode(cfg) === 'panel';
    // One VS Code editor tab per browser page — VS Code's tab bar is the tab bar. Skipped in
    // window mode: a panel would mirror a page the human can already see, and its viewport
    // override would relayout the real window to the panel's dimensions.
    if (displayMode(cfg) === 'panel') {
      s.onPageOpened((page, id, reveal) => BrowserPanel.openForPage(context, s, page, id, reveal));
      s.onPageClosed((id) => BrowserPanel.closeForId(id));
      s.onPageReveal((id) => BrowserPanel.reveal(id));
      s.onAgentHighlight((id, box) => BrowserPanel.get(id)?.postHighlight(box));
    }
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
        const display = displayMode(cfg);
        const headless = display === 'panel';
        const autoFallbackPasskeys = cfg.get<boolean>('autoFallbackPasskeys', true);

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
          applePasswordsExtensions(context, cfg, log),
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
  mcp = await startMcpHttpServer(token, preferredPort, predecessorPid, getSession, () => firefoxBridge, log);

  // Zen bridge: the human's OWN browser, reached through the Cobrowser Bridge extension,
  // scoped to the single container this workspace is bound to. Only stood up when a
  // container is configured — otherwise the firefox_* tools stay hidden entirely.
  const zenContainer = firefoxContainerFor(context, cfg);
  if (zenContainer) {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? profileDir;
    firefoxBridge = new FirefoxBridge(token, zenContainer, workspacePath, log);
    firefoxBridge.attach(mcp.httpServer, mcp.port);
    log(`Zen bridge listening at ${firefoxBridge.url().replace(/token=.*/, 'token=…')} (container "${zenContainer}").`);
    // Hand the endpoint to the browser extension through Firefox's managed-storage
    // manifest, so installing the extension is the only manual step.
    registerEndpoint(workspacePath, firefoxBridge.url(), log);
  }

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
  BrowserPanel.videoHub = captureHub;
  BrowserPanel.videoEnabled = cfg.get<boolean>('videoPipeline', false);
  BrowserPanel.imageFormat = cfg.get<'jpeg' | 'png'>('imageFormat', 'jpeg');
  // Live-apply the toggle: re-read on change and restart streaming so switching
  // pipelines doesn't need a window reload (the setting is read at activation only).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cobrowser.firefoxContainer') || e.affectsConfiguration('cobrowser.zenContainer')) {
        const next = firefoxContainerFor(context, vscode.workspace.getConfiguration('cobrowser'));
        if (firefoxBridge && next) firefoxBridge.setContainer(next);
        else
          void vscode.window.showInformationMessage(
            'Cobrowser: reload the window to finish changing the Zen container binding.',
          );
      }
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
  context.subscriptions.push({ dispose: () => firefoxBridge?.dispose() });

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
        // The DAEMON's endpoint, not this window's: VS Code's agent gets the same shared,
        // workspace-routed surface every other client sees.
        provideMcpServerDefinitions: () => [
          new McpHttpDef(
            'Cobrowser',
            vscode.Uri.parse(`http://127.0.0.1:${daemonPort}/mcp`),
            { Authorization: `Bearer ${daemonToken()}` },
            context.extension.packageJSON.version,
          ),
        ],
        resolveMcpServerDefinition: (s: unknown) => s,
      }),
    );
    didChange.fire();
    log('Registered MCP server with VS Code (native provider API).');
  } else {
    log('VS Code MCP provider API unavailable (e.g. Cursor) — using file-based registration.');
  }

  // One daemon, shared by every window: it owns the fixed port and the single config entry,
  // and proxies each call to whichever window owns the named workspace.
  const daemonScript = path.join(context.extensionUri.fsPath, 'dist', 'daemon.js');
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (await ensureDaemon({ port: daemonPort, version: extensionVersion(context), daemonScript, log, dev })) {
    if (workspaceFolder) {
      const id = workspaceFolder.uri.fsPath;
      await register(
        daemonPort,
        { id, name: path.basename(id), url: `http://127.0.0.1:${mcp.port}/mcp`, token, pid: process.pid },
        log,
        dev,
      );
      // Hand the port + id to deactivate(), which must unregister before the window goes.
      registeredWith = { port: daemonPort, id, dev };
      context.subscriptions.push({ dispose: () => void deregister(daemonPort, id, dev) });
    } else {
      log('No workspace folder open — this window has no browser to offer the daemon.');
    }
    // Cursor + Claude Code: ONE entry, pointing at the daemon.
    await writeClientConfigs(daemonPort, token, log, dev);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('cobrowser.open', async () => {
      const s = await getSession();
      if (displayMode(cfg) === 'window') {
        // There are no panels to open — put the real Chrome window in front instead.
        await s.run(() => s.bringToFront()).catch(() => undefined);
        return;
      }
      // Open a panel for each existing page (reveals the active one). Future
      // pages open their panels via onPageOpened.
      s.emitExisting();
    }),
    vscode.commands.registerCommand('cobrowser.newTab', async () => {
      const s = await getSession();
      await s.newPage('about:blank');
    }),
    vscode.commands.registerCommand('cobrowser.copyFirefoxBridgeUrl', async () => {
      if (!firefoxBridge) {
        const pick = await vscode.window.showWarningMessage(
          'Cobrowser: set "cobrowser.zenContainer" for this workspace first — it names the one Zen container this workspace may drive.',
          'Open Settings',
        );
        if (pick) {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'cobrowser.zenContainer');
        }
        return;
      }
      await vscode.env.clipboard.writeText(firefoxBridge.url());
      void vscode.window.showInformationMessage(
        'Cobrowser: bridge URL copied. This workspace is normally registered with the Zen extension ' +
          'automatically — only paste it into the extension (toolbar button → Endpoints) if that did not work.',
      );
    }),
    vscode.commands.registerCommand('cobrowser.bindFirefoxContainer', async () => {
      // Per-workspace, stored in workspaceState: the binding decides what an agent may touch
      // in the human's real browser, and it should not require a file in their repo.
      const containers = listFirefoxContainers();
      const current = context.workspaceState.get<string>(FIREFOX_CONTAINER_KEY)?.trim() ?? '';
      const items: vscode.QuickPickItem[] = containers.map((c) => ({
        label: c.name,
        description: c.name === current ? 'currently bound' : undefined,
        detail: `container ${c.userContextId} in profile ${c.profile}`,
      }));
      items.push({ label: '$(circle-slash) Unbind', detail: 'Hide the firefox_* tools in this workspace' });
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Bind this workspace to one Zen container',
        placeHolder: containers.length
          ? 'The agent will be able to drive ONLY this container'
          : 'No containers found — create one in Zen first, then run this again',
      });
      if (!picked) return;
      const next = picked.label.includes('Unbind') ? '' : picked.label;
      await context.workspaceState.update(FIREFOX_CONTAINER_KEY, next);
      await vscode.window.showInformationMessage(
        next
          ? `Cobrowser: this workspace is bound to the "${next}" Zen container. Reload the window to connect the bridge.`
          : 'Cobrowser: Zen container unbound for this workspace.',
      );
      log(next ? `Zen bridge: bound to container "${next}".` : 'Zen bridge: unbound.');
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
  // Withdraw from the daemon BEFORE the server closes, so no agent can be routed at a
  // window that is already tearing down.
  if (registeredWith) {
    await deregister(registeredWith.port, registeredWith.id, registeredWith.dev);
    registeredWith = undefined;
  }
  await mcp?.close();
  mcp = undefined;
}

/** iCloud Passwords, when the user has it in Chrome and hasn't turned it off. Autofill also
 *  needs Apple's native helper, which only an admin can put where Chrome for Testing looks —
 *  so say exactly what to run rather than failing silently at autofill time. */
function applePasswordsExtensions(
  context: vscode.ExtensionContext,
  cfg: vscode.WorkspaceConfiguration,
  log: (m: string) => void,
): string[] {
  if (!cfg.get<boolean>('applePasswords', true)) return [];
  const dir = ensureApplePasswords(context.globalStorageUri.fsPath, log);
  if (!dir) {
    log('iCloud Passwords is not installed in Google Chrome — skipping (nothing to copy from).');
    return [];
  }
  if (!nativeHostInstalled()) {
    log(
      'iCloud Passwords will load, but autofill needs Apple\'s helper registered for Chrome ' +
        `for Testing. Run once:\n  ${NATIVE_HOST_INSTALL_COMMAND}`,
    );
  }
  return [dir];
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
