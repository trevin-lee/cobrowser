import * as vscode from 'vscode';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { BrowserSession } from './browser/BrowserSession';
import { startMcpHttpServer, type McpHttp } from './mcp/server';
import { BrowserPanel } from './webview/BrowserPanel';
import { SessionTreeProvider } from './webview/SessionTreeProvider';
import { writeClientConfigs } from './clients/writeClientConfigs';
import { snippetFor, type OtherClient } from './clients/agentConfigs';
import { daemonToken, deregister, ensureDaemon, register } from './daemon/client';
import { DEFAULT_DAEMON_PORT, DEV_DAEMON_PORT, bridgeEndpointUrl } from './daemon/protocol';
import { AppConnection, readAppState, type AppState } from './app/AppClient';
import { ensureApp, electronExecutable } from './app/ensureApp';
import { APP_BUNDLE_ID, listSigningIdentities, readSignedMarker, signElectronForPasskeys, unsignForPasskeys } from './app/signApp';
import { registerEndpoint, unregisterEndpoint } from './firefox/managedManifest';
import { listFirefoxContainers } from './firefox/containers';

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
/** Which browser the binding above is for: 'firefox' (container) or 'chrome' (tab group). */
const BRIDGE_BROWSER_KEY = 'cobrowser.bridgeBrowser';
interface SavedTab {
  url: string;
  col?: number;
  /** Who opened it: the agent's tabs stay the agent's to tidy up after a restart. */
  by?: 'agent' | 'human';
}

/** Where Chrome loads the bridge from: a fixed folder, so "Load unpacked" survives updates
 *  (this extension's own install folder is renamed with every version). */
const CHROME_BRIDGE_DIR = path.join(os.homedir(), '.cobrowser', 'chrome-extension');

const manifestVersion = (dir: string): string | undefined => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
};

/** Copy the shipped Chrome bridge to CHROME_BRIDGE_DIR: always when installing, otherwise only
 *  to refresh a copy that is already there and out of date. */
function copyChromeBridge(context: vscode.ExtensionContext, install: boolean): { changed: boolean; from?: string; to?: string } {
  const src = path.join(context.extensionUri.fsPath, 'chrome-extension');
  const to = manifestVersion(src);
  const from = manifestVersion(CHROME_BRIDGE_DIR);
  if (!to || (!install && (!from || from === to))) return { changed: false, from, to };
  fs.mkdirSync(CHROME_BRIDGE_DIR, { recursive: true });
  fs.cpSync(src, CHROME_BRIDGE_DIR, { recursive: true, force: true });
  return { changed: from !== to, from, to };
}

let session: BrowserSession | undefined;
let sessionPromise: Promise<BrowserSession> | undefined;
let mcp: McpHttp | undefined;
let output: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext | undefined;
/** Set once this window has registered with the daemon, so deactivate() can withdraw it. */
let registeredWith: { port: number; id: string; dev: boolean } | undefined;

/** The scope this workspace's bridge is bound to (a Firefox container or a Chrome tab group),
 *  set by the Bind commands and kept per workspace without writing a file into the repo. A
 *  binding from before (stored under the pre-rename key, or the retired
 *  cobrowser.firefoxContainer setting) is carried over once. */
function firefoxContainerFor(context: vscode.ExtensionContext): string {
  const bound = context.workspaceState.get<string>(FIREFOX_CONTAINER_KEY)?.trim();
  if (bound) return bound;
  const legacy =
    context.workspaceState.get<string>(LEGACY_CONTAINER_KEY)?.trim() ||
    vscode.workspace.getConfiguration('cobrowser').get<string>('firefoxContainer', '').trim();
  if (legacy) {
    void context.workspaceState.update(FIREFOX_CONTAINER_KEY, legacy);
    void context.workspaceState.update(BRIDGE_BROWSER_KEY, 'firefox');
    void context.workspaceState.update(LEGACY_CONTAINER_KEY, undefined);
    return legacy;
  }
  return '';
}

/** Whether to install the virtual WebAuthn authenticator, which makes passkey ceremonies
 *  fail fast so sites fall back to a password. An offscreen page has no window to host the
 *  OS prompt, so a real ceremony would just hang. Read when the browser connects. */
function passkeyFallback(): boolean {
  return vscode.workspace.getConfiguration('cobrowser').get<boolean>('autoFallbackPasskeys') ?? true;
}

/** The running build's version, so the daemon and the app can be restarted when stale. */
function extensionVersion(context: vscode.ExtensionContext): string {
  return (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '0.0.0';
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  output = vscode.window.createOutputChannel('Cobrowser');
  context.subscriptions.push(output);
  const log = (m: string) => output.appendLine(m);

  // Keep an installed Chrome bridge in step with this release. Chrome picks the new files up
  // when it restarts, or at once with the extension's reload button.
  try {
    const r = copyChromeBridge(context, false);
    if (r.changed) log(`Chrome bridge updated in ${CHROME_BRIDGE_DIR} (${r.from} → ${r.to}); reload it in chrome://extensions.`);
  } catch (err) {
    log(`Chrome bridge update failed: ${String(err)}`);
  }

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
  if (dev) {
    // Its own browser app too: own state (so each build never restarts the other's app) and
    // own browser profiles and vault. The app it starts inherits these.
    process.env.COBROWSER_STATE_DIR = path.join(os.homedir(), '.cobrowser', 'dev');
    process.env.COBROWSER_DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'cobrowser-dev');
    process.env.COBROWSER_DEV = '1';
    log(`Development host: using the dev daemon on port ${daemonPort} and its own browser app (${process.env.COBROWSER_DATA_DIR}), isolated from your installed cobrowser.`);
  }
  const preferredPort = 0;
  // Hand bindPort our previous host's pid so it can reclaim the port from our OWN stale
  // predecessor only — never from another live window. Then record ours for next time.
  const predecessorPid = context.workspaceState.get<number>(EH_PID_KEY);
  await context.workspaceState.update(EH_PID_KEY, process.pid);

  // The app keeps one browser profile (partition) per workspace, keyed by this path, so
  // logins and tabs are isolated per project. A window with no folder shares a default.
  const workspaceId = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.join(context.globalStorageUri.fsPath, 'default');
  const readRender = (c: vscode.WorkspaceConfiguration): void => {
    BrowserPanel.renderScale = c.get<number>('renderScale', 2);
    BrowserPanel.renderBudgetPx = Math.round(c.get<number>('renderBudgetMegapixels', 6.5) * 1_000_000);
    BrowserPanel.tabTitleMax = c.get<number>('tabTitleMaxLength', 30);
  };
  readRender(cfg);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cobrowser.renderScale') || e.affectsConfiguration('cobrowser.renderBudgetMegapixels')) {
        readRender(vscode.workspace.getConfiguration('cobrowser'));
        BrowserPanel.remeasureAll();
      }
      if (e.affectsConfiguration('cobrowser.tabTitleMaxLength')) {
        readRender(vscode.workspace.getConfiguration('cobrowser'));
        BrowserPanel.refreshTitles();
      }
    }),
  );

  // Activity Bar sidebar: profile(s) + their open tabs. Created before getSession
  // so its `() => session` closure is always initialized when first read.
  const tree = new SessionTreeProvider(
    { label: vscode.workspace.name ?? 'Default', path: workspaceId },
    () => session,
  );
  context.subscriptions.push(vscode.window.registerTreeDataProvider('cobrowser.sessions', tree));

  // Wire a fresh OR reconnected session: persistence + listeners + open panels for its
  // existing pages. Shared by launch (getSession) and reconnect-on-activate.
  const wire = async (s: BrowserSession): Promise<BrowserSession> => {
    session = s;
    await context.workspaceState.update(WAS_RUNNING_KEY, true);
    s.onAllClosed(() => {
      // Last tab closed: this workspace has no browser until the next tab opens. Clear the
      // cached session so the next tool call or panel reconnects fresh rather than hitting
      // a session with no pages.
      void context.workspaceState.update(WAS_RUNNING_KEY, false);
      BrowserPanel.disposeAll();
      if (session === s) session = undefined;
      sessionPromise = undefined;
      void s.disconnect();
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
        .map((e) => ({ url: e.url, col: BrowserPanel.columnOf(e.id), by: e.by }));
      void context.workspaceState.update(TABS_KEY, entries);
    };
    s.onPagesChanged(() => {
      tree.refresh();
      saveTabs();
      BrowserPanel.refreshTitles(); // a page-title change carries no navigation event
    });
    // Dragging a panel to another editor group fires no session event — hook the panel
    // layer so layout changes persist too.
    BrowserPanel.onLayoutChanged = saveTabs;

    s.onDisconnected(() => {
      // Only for UNEXPECTED exits (crash / Cmd-Q). Intentional disconnect (reload) and
      // close set isDisposing and are handled by disposeSession, which keeps the tabs for a
      // reconnect in the reload case.
      if (s.isDisposing) return;
      log('The cobrowser app went away — clearing session; it will reconnect on next use.');
      // The saved tab list (and the columns the tabs were in) is what the reconnect restores;
      // closing the panels here must not overwrite it.
      if (BrowserPanel.onLayoutChanged === saveTabs) BrowserPanel.onLayoutChanged = undefined;
      BrowserPanel.disposeAll();
      if (session === s) session = undefined;
      sessionPromise = undefined;
      tree.refresh(); // profile → "stopped"
    });

    // Open panels for pages that already exist (restored/reconnected tabs, or pages that
    // appeared during launch before these listeners were wired) — no orphaned Chrome page.
    s.emitExisting();
    tree.refresh(); // reflect the now-running session (state + initial tabs)
    return s;
  };

  // On a fresh connection (the app had no tabs for this workspace), reopen the tabs we saved
  // from the previous session — or a blank one, so tools always have a page to act on.
  const restoreTabs = async (s: BrowserSession, tabs: SavedTab[]): Promise<void> => {
    try {
      if (s.pageEntries().length > 0) return; // the app still had our tabs
      const saved = tabs.filter((t) => t.url && t.url !== 'about:blank');
      if (saved.length) log(`Restoring ${saved.length} saved tab(s).`);
      // Restoring is the human's act (the agent's target does not move), but each tab keeps
      // its owner: one the agent opened is still the agent's to close when done.
      const [first, ...rest] = saved;
      await s.run(() => s.newPage(first?.url ?? 'about:blank', { byAgent: false, owner: first?.by ?? 'human' }));
      for (const t of rest) await s.run(() => s.newPage(t.url, { background: true, byAgent: false, owner: t.by ?? 'human' }));
    } catch (err) {
      log(`Tab restore failed: ${String(err)}`);
    } finally {
      BrowserPanel.clearColumnPlan(); // whatever's left no longer maps to anything
      BrowserPanel.disposeUnclaimedRestored(); // ghost shells whose pages never came back
    }
  };

  // Start the app (or find it running). It outlives this window.
  const startApp = () =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Cobrowser: starting browser' },
      (progress) =>
        ensureApp({
          appMain: path.join(context.extensionUri.fsPath, 'dist', 'app', 'main.js'),
          cacheDir: path.join(context.globalStorageUri.fsPath, 'electron'),
          devElectron: path.join(context.extensionUri.fsPath, 'app', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
          version: extensionVersion(context),
          iconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'trayTemplate.png').fsPath,
          appIcon: vscode.Uri.joinPath(context.extensionUri, 'media', 'cobrowser.icns').fsPath,
          onProgress: (d, t) => progress.report({ message: t ? `downloading Electron ${Math.round(d / 1e6)} / ${Math.round(t / 1e6)} MB` : `downloading Electron ${Math.round(d / 1e6)} MB` }),
          log,
          onSigningNotice: (level, message) => {
            log(message);
            void (level === 'warning' ? vscode.window.showWarningMessage(`Cobrowser: ${message}`) : vscode.window.showInformationMessage(`Cobrowser: ${message}`));
          },
        }),
    );

  // Every connection to the app goes through here. When this workspace's browser was
  // forgotten (from another window), whichever connection hears it first drops the tabs
  // saved for it, so they are not reopened signed out.
  const connectAs = async (state: AppState) => {
    const r = await AppConnection.connect(state, workspaceId);
    if (r.forgotten) {
      await context.workspaceState.update(TABS_KEY, []);
      log("This workspace's browser was forgotten: starting fresh, without its saved tabs.");
    }
    return r;
  };

  // The vault commands talk to the app as this workspace without opening its browser: the
  // session's connection when there is one, or a short-lived one that opens no tabs.
  const withApp = async <T>(fn: (conn: AppConnection) => Promise<T>): Promise<T> => {
    if (session && BrowserPanel.app) return fn(BrowserPanel.app);
    const { conn } = await connectAs(await startApp());
    try {
      return await fn(conn);
    } finally {
      conn.close();
    }
  };

  // Connect to the app only when first needed (a tool call or a panel opening). The app
  // itself is started on demand and outlives this window.
  const getSession = async (): Promise<BrowserSession> => {
    if (session) return session;
    if (!sessionPromise) {
      sessionPromise = (async () => {
        // Snapshot OUR saved tab list first: wire() fires pagesChanged, which overwrites
        // TABS_KEY before restore could read it.
        let savedTabs = (context.workspaceState.get<Array<string | SavedTab>>(TABS_KEY) ?? [])
          .map((t) => (typeof t === 'string' ? { url: t } : t)); // pre-0.1.25 saves were bare URLs
        BrowserPanel.planColumns(savedTabs.map((t) => t.col));

        const state = await startApp();
        const { conn, tabs, forgotten } = await connectAs(state);
        if (forgotten) savedTabs = [];
        BrowserPanel.app = conn;
        conn.onClose = () => log('App connection closed.');
        // A signed app has a real Touch ID authenticator; the fail-fast virtual one would
        // replace it with a forced password fallback.
        const s = await BrowserSession.connectApp(conn, state.webauthn ? false : passkeyFallback());
        log(`Connected to the cobrowser app ${state.version} (${tabs.length} tab(s) already open for this workspace).`);
        const wired = await wire(s);
        if (tabs.length) BrowserPanel.disposeUnclaimedRestored(); // pages adopted their shells in wire()
        else await restoreTabs(wired, savedTabs);
        return wired;
      })();
      sessionPromise.catch((err) => {
        sessionPromise = undefined;
        log(`Browser start failed: ${String(err)}`);
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

  // The Firefox bridge is served by the DAEMON (fixed port, machine-wide token), so the URL
  // the add-on dials for this workspace never changes across reloads. This window only tells
  // the daemon which container the workspace is bound to, and keeps the managed-storage
  // manifest — which Firefox reads to configure the add-on — pointing at that stable URL.
  const bridgeUrl = (): string => bridgeEndpointUrl(daemonPort, daemonToken(undefined, dev), workspaceId);
  /** (Re)register this window with the daemon, carrying the current Firefox container binding. */
  let registerWithDaemon: () => Promise<void> = async () => undefined;
  const bridgeBrowser = (): 'firefox' | 'chrome' => (context.workspaceState.get<string>(BRIDGE_BROWSER_KEY) === 'chrome' ? 'chrome' : 'firefox');
  const syncBridge = (): void => {
    const container = firefoxContainerFor(context);
    // Only Firefox reads the managed manifest; Chrome is configured by pasting the same URL.
    if (container && bridgeBrowser() === 'firefox') registerEndpoint(workspaceId, bridgeUrl(), log);
    else unregisterEndpoint(workspaceId, log);
    void registerWithDaemon();
  };

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
            { Authorization: `Bearer ${daemonToken(undefined, dev)}` },
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
      const mcpPort = mcp.port;
      registerWithDaemon = () =>
        register(
          daemonPort,
          { id, name: path.basename(id), url: `http://127.0.0.1:${mcpPort}/mcp`, token, pid: process.pid, container: firefoxContainerFor(context) || undefined, browser: bridgeBrowser() },
          log,
          dev,
        );
      await registerWithDaemon();
      if (firefoxContainerFor(context) && bridgeBrowser() === 'firefox') registerEndpoint(workspaceId, bridgeUrl(), log);
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
      // Open a panel for each existing page (reveals the active one). Future
      // pages open their panels via onPageOpened.
      s.emitExisting();
    }),
    vscode.commands.registerCommand('cobrowser.newTab', async () => {
      const s = await getSession();
      await s.newPage('about:blank', { byAgent: false });
    }),
    // Browser-chrome shortcuts, bound in package.json while a cobrowser panel is active.
    vscode.commands.registerCommand('cobrowser.closeTab', () => BrowserPanel.active?.close()),
    vscode.commands.registerCommand('cobrowser.reloadTab', () => BrowserPanel.active?.navigate('reload')),
    vscode.commands.registerCommand('cobrowser.back', () => BrowserPanel.active?.navigate('back')),
    vscode.commands.registerCommand('cobrowser.forward', () => BrowserPanel.active?.navigate('forward')),
    vscode.commands.registerCommand('cobrowser.copyFirefoxBridgeUrl', async () => {
      await vscode.env.clipboard.writeText(bridgeUrl());
      void vscode.window.showInformationMessage(
        'Cobrowser: bridge URL copied. It never changes for this workspace. Firefox configures itself from the managed manifest; ' +
          'paste it into the add-on (toolbar button → Endpoints) only if that did not happen — or into the Chrome extension, which has no manifest.',
      );
    }),
    vscode.commands.registerCommand('cobrowser.installChromeBridge', async () => {
      try {
        copyChromeBridge(context, true);
      } catch (err) {
        void vscode.window.showErrorMessage(`Cobrowser: could not copy the Chrome extension — ${String((err as Error).message ?? err)}`);
        return;
      }
      await vscode.env.clipboard.writeText(CHROME_BRIDGE_DIR);
      const shown = CHROME_BRIDGE_DIR.replace(os.homedir(), '~');
      const next = await vscode.window.showInformationMessage(
        `Cobrowser: the Chrome extension is in ${shown} (path copied). In chrome://extensions, turn on Developer mode, click Load unpacked and choose that folder. ` +
          'Then run "Cobrowser: Bind Chrome Tab Group to This Workspace", and paste the URL from "Cobrowser: Copy Bridge URL" into the extension\'s toolbar popup. ' +
          'Updates to cobrowser update that folder; Chrome loads them when it restarts.',
        'Open Chrome Extensions',
      );
      if (next === 'Open Chrome Extensions') execFile('open', ['-a', 'Google Chrome', 'chrome://extensions'], () => undefined);
    }),
    vscode.commands.registerCommand('cobrowser.bindFirefoxContainer', async () => {
      // Per-workspace, stored in workspaceState: the binding decides what an agent may touch
      // in the human's real browser, and it should not require a file in their repo.
      const containers = listFirefoxContainers();
      const bound = context.workspaceState.get<string>(FIREFOX_CONTAINER_KEY)?.trim() ?? '';
      const current = bridgeBrowser() === 'firefox' ? bound : '';
      // A workspace drives one browser at a time: binding Firefox ends a Chrome binding.
      const replacing = bridgeBrowser() === 'chrome' ? bound : '';
      const items: vscode.QuickPickItem[] = containers.map((c) => ({
        label: c.name,
        description: c.name === current ? 'currently bound' : undefined,
        detail: `container ${c.userContextId} in profile ${c.profile}`,
      }));
      items.push({ label: '$(circle-slash) Unbind', detail: 'Hide the bridge_* tools in this workspace' });
      const picked = await vscode.window.showQuickPick(items, {
        title: replacing ? `Bind this workspace to one Firefox container (replaces the Chrome tab group "${replacing}")` : 'Bind this workspace to one Firefox container',
        placeHolder: containers.length
          ? 'The agent will be able to drive ONLY this container'
          : 'No containers found — create one in Firefox first, then run this again',
      });
      if (!picked) return;
      const next = picked.label.includes('Unbind') ? '' : picked.label;
      await context.workspaceState.update(FIREFOX_CONTAINER_KEY, next);
      await context.workspaceState.update(BRIDGE_BROWSER_KEY, 'firefox');
      syncBridge(); // takes effect now: the daemon re-hellos the add-on's socket, no reload
      void vscode.window.showInformationMessage(
        next
          ? `Cobrowser: this workspace is bound to the "${next}" container${replacing ? ` instead of the Chrome tab group "${replacing}"` : ''}.`
          : 'Cobrowser: Firefox container unbound for this workspace.',
      );
      log(next ? `Firefox bridge: bound to container "${next}".` : 'Firefox bridge: unbound.');
    }),
    vscode.commands.registerCommand('cobrowser.bindChromeTabGroup', async () => {
      // Chrome has no containers; a tab group's title (or "profile" for every tab) is the scope.
      const bound = context.workspaceState.get<string>(FIREFOX_CONTAINER_KEY)?.trim() ?? '';
      const current = bridgeBrowser() === 'chrome' ? bound : '';
      const replacing = bridgeBrowser() === 'firefox' ? bound : '';
      const next = await vscode.window.showInputBox({
        title: replacing ? `Bind this workspace to a Chrome tab group (replaces the Firefox container "${replacing}")` : 'Bind this workspace to a Chrome tab group',
        prompt: 'The tab group\'s name as shown in Chrome\'s tab strip, or "profile" for every tab. Empty unbinds.',
        value: current,
        placeHolder: 'profile',
      });
      if (next === undefined) return;
      await context.workspaceState.update(FIREFOX_CONTAINER_KEY, next.trim());
      await context.workspaceState.update(BRIDGE_BROWSER_KEY, 'chrome');
      syncBridge();
      void vscode.window.showInformationMessage(
        next.trim()
          ? `Cobrowser: bound to Chrome tab group "${next.trim()}"${replacing ? ` instead of the Firefox container "${replacing}"` : ''}. If the extension is not connected yet, run "Cobrowser: Copy Bridge URL" and paste it into its popup.`
          : 'Cobrowser: Chrome tab group unbound for this workspace.',
      );
    }),
    vscode.commands.registerCommand('cobrowser.enablePasskeys', async () => {
      // Sign the downloaded browser so Chromium's Touch ID authenticator can store passkeys.
      const cacheDir = path.join(context.globalStorageUri.fsPath, 'electron');
      const devElectron = path.join(context.extensionUri.fsPath, 'app', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
      const exe = electronExecutable({ cacheDir, devElectron });
      if (!exe) {
        void vscode.window.showErrorMessage('Cobrowser: the browser has not been downloaded yet — open a panel first, then run this again.');
        return;
      }
      // Which team signs it. A free (personal) team's profiles expire after 7 days; a paid
      // team's last a year. Renewal at startup reuses this choice.
      const ids = listSigningIdentities();
      if (!ids.length) {
        void vscode.window.showErrorMessage('Cobrowser: no code-signing identity on this Mac. Sign in to Xcode with your Apple ID (Xcode → Settings → Accounts), then run this again.');
        return;
      }
      const previous = readSignedMarker(exe);
      const order = (i: (typeof ids)[number]): number => (i.developerId ? 0 : i.paid ? 1 : 2);
      const pick = await vscode.window.showQuickPick(
        [...ids].sort((a, b) => order(a) - order(b)).map((i) => ({
          label: i.teamName,
          description: i.developerId ? 'Developer ID' : i.paid ? 'paid team — signing lasts a year' : 'free team — signing lasts 7 days',
          detail: i.name + (previous?.team === i.team ? '  (current)' : ''),
          identity: i,
        })),
        { title: 'Sign the browser for passkeys with which team?', placeHolder: 'Renewal before it expires is automatic, with the same team' },
      );
      if (!pick) return;
      const team = pick.identity.team;
      const bundleId = await vscode.window.showInputBox({
        title: 'App identifier',
        prompt: `A reverse-DNS identifier ${pick.label} can register. One registered to another team is refused; use your own domain, e.g. com.yourcompany.cobrowser.`,
        value: previous?.team === team && previous.bundleId ? previous.bundleId : APP_BUNDLE_ID,
        validateInput: (v) => (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(v.trim()) ? undefined : 'Reverse-DNS, like com.example.cobrowser'),
      });
      if (!bundleId) return;
      try {
        await quitAppForResigning();
        const marker = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Cobrowser: signing the browser for passkeys' },
          () => signElectronForPasskeys(exe, log, { team, bundleId: bundleId.trim() }),
        );
        const until = marker.expires ? ` It lasts until ${new Date(marker.expires).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })} and renews itself before then.` : '';
        void vscode.window.showInformationMessage(`Cobrowser: passkeys enabled with ${pick.label}.${until} The browser restarts signed the next time a panel opens.`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Cobrowser: could not enable passkeys — ${String((err as Error).message ?? err)}`);
      }
    }),
    vscode.commands.registerCommand('cobrowser.addLogin', async () => {
      const site = await vscode.window.showInputBox({ prompt: 'Site (URL or host)', placeHolder: 'https://example.com' });
      if (!site) return;
      const username = await vscode.window.showInputBox({ prompt: `Username for ${site}` });
      if (username === undefined) return;
      const password = await vscode.window.showInputBox({ prompt: `Password for ${username || site}`, password: true });
      if (!password) return;
      try {
        const { replaced } = await withApp((c) => c.vaultAdd(site, username, password));
        void vscode.window.showInformationMessage(
          replaced
            ? `Cobrowser: replaced the saved password for ${username || 'the login'} on ${site}; it is now usable in this workspace too.`
            : `Cobrowser: saved a login for ${site}, usable in this workspace. Change where it can be used with "Cobrowser: Manage Logins".`,
        );
      } catch (err) {
        void vscode.window.showErrorMessage(`Cobrowser: could not save the login — ${String((err as Error).message ?? err)}`);
      }
    }),
    vscode.commands.registerCommand('cobrowser.importLoginsCsv', async () => {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { CSV: ['csv'] }, title: 'Import logins (Apple Passwords / Bitwarden / Chrome CSV export)' });
      if (!picked?.[0]) return;
      const csv = Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8');
      let r: { count: number; added: number; replaced: number };
      try {
        r = await withApp((c) => c.vaultImportDetailed(csv));
      } catch (err) {
        void vscode.window.showErrorMessage(`Cobrowser: could not import logins — ${String((err as Error).message ?? err)}`);
        return;
      }
      const del = await vscode.window.showInformationMessage(
        `Cobrowser: imported ${r.count} login${r.count === 1 ? '' : 's'} (${r.added} new, ${r.replaced} replaced), usable in this workspace. The CSV holds the passwords in plain text — delete it?`,
        'Delete the CSV',
        'Keep',
      );
      if (del === 'Delete the CSV') await vscode.workspace.fs.delete(picked[0]);
    }),
    vscode.commands.registerCommand('cobrowser.disablePasskeys', async () => {
      const exe = electronExecutable({ cacheDir: path.join(context.globalStorageUri.fsPath, 'electron') });
      if (!exe || !readSignedMarker(exe)) {
        void vscode.window.showInformationMessage('Cobrowser: passkeys are not enabled.');
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        'Turn passkeys off?',
        { modal: true, detail: 'The browser is signed again as it was downloaded, and passkey prompts fall back to passwords. Passkeys already saved stay in your keychain, and work again if you enable passkeys with the same team and identifier.' },
        'Turn Off',
      );
      if (ok !== 'Turn Off') return;
      try {
        await quitAppForResigning();
        unsignForPasskeys(exe, log);
        void vscode.window.showInformationMessage('Cobrowser: passkeys turned off. The browser restarts the next time a panel opens.');
      } catch (err) {
        void vscode.window.showErrorMessage(`Cobrowser: could not turn passkeys off — ${String((err as Error).message ?? err)}`);
      }
    }),
    vscode.commands.registerCommand('cobrowser.exportLoginsCsv', async () => {
      try {
        const r = await withApp((c) => c.vaultExport());
        if (r.error) throw new Error(r.error);
        if (r.ok) void vscode.window.showInformationMessage(`Cobrowser: exported ${r.count} login(s) to ${r.file}. The file holds the passwords in plain text — delete it once it is imported elsewhere.`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Cobrowser: could not export logins — ${String((err as Error).message ?? err)}`);
      }
    }),
    // MCP clients cobrowser cannot register through an interface of theirs: show the entry
    // for the human to add. It is the daemon's, unscoped, so its tools name a workspace.
    vscode.commands.registerCommand('cobrowser.connectAgent', async () => {
      const ep = { name: dev ? 'cobrowser-dev' : 'cobrowser', url: `http://127.0.0.1:${daemonPort}/mcp`, token: daemonToken(undefined, dev) };
      const clients: OtherClient[] = ['claude-desktop', 'codex', 'windsurf', 'other'];
      const pick = await vscode.window.showQuickPick(
        clients.map((c) => {
          const s = snippetFor(c, ep, os.homedir());
          return { label: s.label, detail: `Goes in ${s.where}`, snippet: s };
        }),
        { title: 'Connect another agent to cobrowser', placeHolder: 'VS Code, Cursor and Claude Code are connected for you. Pick another client.' },
      );
      if (!pick) return;
      const s = pick.snippet;
      const language = (await vscode.languages.getLanguages()).includes(s.language) ? s.language : 'plaintext';
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language, content: s.text }), { preview: true });
      const open = s.file && fs.existsSync(s.file) ? `Open ${path.basename(s.file)}` : undefined;
      const act = await vscode.window.showInformationMessage(
        `Cobrowser: add this to ${s.where}. It carries cobrowser's token, so keep it out of repositories. The agent there reaches every open workspace, naming one per call.`,
        'Copy',
        ...(open ? [open] : []),
      );
      if (act === 'Copy') await vscode.env.clipboard.writeText(s.text);
      if (act === open && s.file) await vscode.window.showTextDocument(vscode.Uri.file(s.file));
    }),
    // The sidebar's tab rows: show that page's editor tab.
    vscode.commands.registerCommand('cobrowser.showTab', (pageId: string) => BrowserPanel.reveal(pageId)),
    vscode.commands.registerCommand('cobrowser.manageLogins', async () => {
      try {
        await withApp((c) => c.vaultOpenWindow());
      } catch (err) {
        void vscode.window.showErrorMessage(`Cobrowser: could not open the Logins window — ${String((err as Error).message ?? err)}`);
      }
    }),
    vscode.commands.registerCommand('cobrowser.lockVault', async () => {
      // The vault is only ever unlocked in the running app's memory: no app, nothing to lock.
      const st = readAppState();
      if (!st) {
        void vscode.window.showInformationMessage('Cobrowser: the vault is locked (the browser app is not running).');
        return;
      }
      try {
        if (session && BrowserPanel.app) await BrowserPanel.app.vaultLock();
        else {
          const { conn } = await connectAs(st);
          try { await conn.vaultLock(); } finally { conn.close(); }
        }
        void vscode.window.showInformationMessage('Cobrowser: vault locked. Using a login asks for Touch ID again.');
      } catch (err) {
        void vscode.window.showErrorMessage(`Cobrowser: could not lock the vault — ${String((err as Error).message ?? err)}`);
      }
    }),
    vscode.commands.registerCommand('cobrowser.sitePermissions', async () => {
      try {
        const perms = await withApp((c) => c.sitePermissions());
        if (!perms.length) {
          void vscode.window.showInformationMessage('Cobrowser: no site has asked for a permission in this workspace yet. Sites ask the first time they need one.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          perms.map((p) => ({ label: `${p.allowed ? '$(check)' : '$(circle-slash)'} ${p.origin.replace(/^https?:\/\//, '')}`, description: `${p.allowed ? 'allowed' : 'blocked'} to ${p.label}`, key: p.key })),
          { canPickMany: true, title: 'Site permissions in this workspace', placeHolder: 'Pick the ones to forget; those sites ask again next time' },
        );
        if (!picked?.length) return;
        const n = await withApp((c) => c.forgetSitePermissions(picked.map((p) => p.key)));
        void vscode.window.showInformationMessage(`Cobrowser: forgot ${n} permission${n === 1 ? '' : 's'}; ${n === 1 ? 'that site asks' : 'those sites ask'} again next time.`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Cobrowser: could not read site permissions — ${String((err as Error).message ?? err)}`);
      }
    }),
    vscode.commands.registerCommand('cobrowser.clearBrowsingData', async () => {
      const ok = await vscode.window.showWarningMessage(
        'Clear browsing data for this workspace?',
        { modal: true, detail: "Its cookies, sign-ins, site storage and cache are deleted, so every site in this workspace's browser is signed out. Open tabs stay open. Logins in the vault, site permissions and other workspaces are not touched." },
        'Clear',
      );
      if (ok !== 'Clear') return;
      try {
        await withApp((c) => c.clearBrowsingData());
        void vscode.window.showInformationMessage('Cobrowser: browsing data cleared for this workspace. Reload a tab to see it signed out.');
      } catch (err) {
        void vscode.window.showErrorMessage(`Cobrowser: could not clear browsing data — ${String((err as Error).message ?? err)}`);
      }
    }),
    vscode.commands.registerCommand('cobrowser.forgetWorkspace', async () => {
      try {
        const all = (await withApp((c) => c.knownWorkspaces())).filter((w) => w.id !== workspaceId);
        if (!all.length) {
          void vscode.window.showInformationMessage('Cobrowser: no other workspace has a browser.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          all.map((w) => ({ label: path.basename(w.id), description: w.id, detail: w.open ? 'open in an editor window: clear its data from there instead' : w.tabs ? `${w.tabs} tab${w.tabs === 1 ? '' : 's'} open in the app` : undefined, id: w.id, open: w.open })),
          { title: "Forget a workspace's browser", placeHolder: 'Its tabs, cookies, sign-ins, site data and permissions are deleted' },
        );
        if (!pick) return;
        if (pick.open) {
          void vscode.window.showInformationMessage(`Cobrowser: ${pick.label} is open in another editor window. Run Clear Browsing Data for This Workspace there.`);
          return;
        }
        const ok = await vscode.window.showWarningMessage(
          `Forget ${pick.label}'s browser?`,
          { modal: true, detail: `Its tabs, cookies, sign-ins, site data, cache and site permissions are deleted, and it leaves the workspace list. Logins in the vault are kept: change where they may be used in the Logins window. Opening ${pick.label} again starts its browser signed out of every site.` },
          'Forget',
        );
        if (ok !== 'Forget') return;
        await withApp((c) => c.forgetWorkspace(pick.id));
        void vscode.window.showInformationMessage(`Cobrowser: forgot ${pick.label}'s browser.`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Cobrowser: could not forget the workspace — ${String((err as Error).message ?? err)}`);
      }
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

/** Stop the app before re-signing its binary: macOS kills a running process whose binary is
 *  re-signed underneath it, the next time it pages in code — minutes later, mid-session. */
async function quitAppForResigning(): Promise<void> {
  await disposeSession(extensionContext);
  try {
    const st = readAppState();
    if (st) process.kill(st.pid, 'SIGTERM');
  } catch {
    /* not running */
  }
  const gone = Date.now() + 8000;
  while (readAppState() && Date.now() < gone) await new Promise((r) => setTimeout(r, 200));
}

async function disposeSession(
  _context: vscode.ExtensionContext | undefined,
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
        await s.disconnect(); // reload/close → the app keeps the tabs for the reconnect
      } else {
        await s.dispose(); // restartBrowser → close this workspace's tabs in the app
      }
    } catch {
      /* ignore */
    }
  }
}
