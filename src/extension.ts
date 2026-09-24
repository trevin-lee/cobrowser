import * as vscode from 'vscode';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { BrowserSession } from './browser/BrowserSession';
import { startMcpHttpServer, type McpHttp } from './mcp/server';
import { BrowserPanel } from './webview/BrowserPanel';
import { SessionTreeProvider } from './webview/SessionTreeProvider';
import { writeClientConfigs } from './clients/writeClientConfigs';
import { daemonToken, deregister, ensureDaemon, register } from './daemon/client';
import { DEFAULT_DAEMON_PORT, DEV_DAEMON_PORT, bridgeEndpointUrl } from './daemon/protocol';
import { AppConnection } from './app/AppClient';
import { ensureApp } from './app/ensureApp';
import { findLegacyChrome, findOldProfiles, readCookies, toElectronCookie } from './app/importProfiles';
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
}

let session: BrowserSession | undefined;
let sessionPromise: Promise<BrowserSession> | undefined;
let mcp: McpHttp | undefined;
let output: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext | undefined;
/** Set once this window has registered with the daemon, so deactivate() can withdraw it. */
let registeredWith: { port: number; id: string; dev: boolean } | undefined;

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

/** Whether to install the virtual WebAuthn authenticator, which makes passkey ceremonies
 *  fail fast so sites fall back to a password. An offscreen page has no window to host the
 *  OS prompt, so a real ceremony would just hang. Explicit setting wins. */
function passkeyFallbackFor(cfg: vscode.WorkspaceConfiguration): boolean {
  return cfg.get<boolean>('autoFallbackPasskeys') ?? true;
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

  // The app keeps one browser profile (partition) per workspace, keyed by this path, so
  // logins and tabs are isolated per project. A window with no folder shares a default.
  const workspaceId = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.join(context.globalStorageUri.fsPath, 'default');
  const readRender = (c: vscode.WorkspaceConfiguration): void => {
    BrowserPanel.renderScale = c.get<number>('renderScale', 2);
    BrowserPanel.renderBudgetPx = Math.round(c.get<number>('renderBudgetMegapixels', 6.5) * 1_000_000);
  };
  readRender(cfg);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cobrowser.renderScale') || e.affectsConfiguration('cobrowser.renderBudgetMegapixels')) {
        readRender(vscode.workspace.getConfiguration('cobrowser'));
        BrowserPanel.remeasureAll();
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
      // close set isDisposing and are handled by disposeSession, which keeps the tabs for a
      // reconnect in the reload case.
      if (s.isDisposing) return;
      log('The cobrowser app went away — clearing session; it will reconnect on next use.');
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
      const urls = tabs.map((t) => t.url).filter((u) => u && u !== 'about:blank');
      if (urls.length) log(`Restoring ${urls.length} saved tab(s).`);
      await s.run(() => s.newPage(urls[0] ?? 'about:blank'));
      for (const u of urls.slice(1)) await s.run(() => s.newPage(u, { background: true }));
    } catch (err) {
      log(`Tab restore failed: ${String(err)}`);
    } finally {
      BrowserPanel.clearColumnPlan(); // whatever's left no longer maps to anything
      BrowserPanel.disposeUnclaimedRestored(); // ghost shells whose pages never came back
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
        const savedTabs = (context.workspaceState.get<Array<string | SavedTab>>(TABS_KEY) ?? [])
          .map((t) => (typeof t === 'string' ? { url: t } : t)); // pre-0.1.25 saves were bare URLs
        BrowserPanel.planColumns(savedTabs.map((t) => t.col));

        const state = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Cobrowser: starting browser' },
          (progress) =>
            ensureApp({
              appMain: path.join(context.extensionUri.fsPath, 'dist', 'app', 'main.js'),
              cacheDir: path.join(context.globalStorageUri.fsPath, 'electron'),
              devElectron: path.join(context.extensionUri.fsPath, 'app', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
              version: extensionVersion(context),
              iconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'trayTemplate.png').fsPath,
              onProgress: (d, t) => progress.report({ message: t ? `downloading Electron ${Math.round(d / 1e6)} / ${Math.round(t / 1e6)} MB` : `downloading Electron ${Math.round(d / 1e6)} MB` }),
              log,
            }),
        );
        const { conn, tabs } = await AppConnection.connect(state, workspaceId);
        BrowserPanel.app = conn;
        conn.onClose = () => log('App connection closed.');
        const s = await BrowserSession.connectApp(conn, passkeyFallbackFor(cfg));
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
    const container = firefoxContainerFor(context, cfg);
    // Only Firefox reads the managed manifest; Chrome is configured by pasting the same URL.
    if (container && bridgeBrowser() === 'firefox') registerEndpoint(workspaceId, bridgeUrl(), log);
    else unregisterEndpoint(workspaceId, log);
    void registerWithDaemon();
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cobrowser.firefoxContainer') || e.affectsConfiguration('cobrowser.zenContainer')) syncBridge();
    }),
  );

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
      const mcpPort = mcp.port;
      registerWithDaemon = () =>
        register(
          daemonPort,
          { id, name: path.basename(id), url: `http://127.0.0.1:${mcpPort}/mcp`, token, pid: process.pid, container: firefoxContainerFor(context, cfg) || undefined, browser: bridgeBrowser() },
          log,
          dev,
        );
      await registerWithDaemon();
      if (firefoxContainerFor(context, cfg) && bridgeBrowser() === 'firefox') registerEndpoint(workspaceId, bridgeUrl(), log);
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
      await s.newPage('about:blank');
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
        title: 'Bind this workspace to one Firefox container',
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
        next ? `Cobrowser: this workspace is bound to the "${next}" container.` : 'Cobrowser: Firefox container unbound for this workspace.',
      );
      log(next ? `Firefox bridge: bound to container "${next}".` : 'Firefox bridge: unbound.');
    }),
    vscode.commands.registerCommand('cobrowser.bindChromeTabGroup', async () => {
      // Chrome has no containers; a tab group's title (or "profile" for every tab) is the scope.
      const current = bridgeBrowser() === 'chrome' ? context.workspaceState.get<string>(FIREFOX_CONTAINER_KEY) ?? '' : '';
      const next = await vscode.window.showInputBox({
        title: 'Bind this workspace to a Chrome tab group',
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
          ? `Cobrowser: bound to Chrome tab group "${next.trim()}". If the extension is not connected yet, run "Cobrowser: Copy Bridge URL" and paste it into its popup.`
          : 'Cobrowser: Chrome tab group unbound for this workspace.',
      );
    }),
    vscode.commands.registerCommand('cobrowser.importProfiles', async () => {
      // Bring logins over from the per-workspace Chrome profiles of the pre-app releases.
      const chrome = findLegacyChrome(context.globalStorageUri.fsPath);
      if (!chrome) {
        void vscode.window.showErrorMessage('Cobrowser: no Chrome build found to read the old profiles with (Chrome for Testing cache or /Applications/Chromium.app).');
        return;
      }
      const found = findOldProfiles();
      if (!found.length) {
        void vscode.window.showInformationMessage('Cobrowser: no old profiles found.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        found.map((p) => ({ label: path.basename(p.workspace), description: p.workspace, detail: `~${p.cookieCount} cookies`, picked: p.cookieCount > 0, profile: p })),
        { canPickMany: true, title: 'Import logins from old cobrowser profiles', placeHolder: 'Each goes into that workspace\'s new browser profile' },
      );
      if (!picked?.length) return;
      const s = await getSession(); // ensures the app is up
      void s;
      const app = BrowserPanel.app!;
      const lines: string[] = [];
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Cobrowser: importing profiles' }, async (progress) => {
        for (const { profile } of picked) {
          progress.report({ message: path.basename(profile.workspace) });
          try {
            const cookies = await readCookies(profile.profileDir, chrome);
            const r = await app.importCookies(profile.workspace, cookies.map(toElectronCookie));
            lines.push(`${path.basename(profile.workspace)}: ${r.imported} cookies${r.failed ? ` (${r.failed} failed)` : ''}`);
          } catch (err) {
            lines.push(`${path.basename(profile.workspace)}: ${String((err as Error).message || err)}`);
          }
        }
      });
      log(`Profile import:\n  ${lines.join('\n  ')}`);
      void vscode.window.showInformationMessage(`Cobrowser: imported — ${lines.join('; ')}`);
    }),
    vscode.commands.registerCommand('cobrowser.addLogin', async () => {
      const site = await vscode.window.showInputBox({ prompt: 'Site (URL or host)', placeHolder: 'https://example.com' });
      if (!site) return;
      const username = await vscode.window.showInputBox({ prompt: `Username for ${site}` });
      if (username === undefined) return;
      const password = await vscode.window.showInputBox({ prompt: `Password for ${username || site}`, password: true });
      if (!password) return;
      await getSession();
      await BrowserPanel.app!.vaultAdd(site, username, password);
      void vscode.window.showInformationMessage(`Cobrowser: saved a login for ${site}, usable in this workspace. Change its scope from the menu-bar Logins window.`);
    }),
    vscode.commands.registerCommand('cobrowser.importLoginsCsv', async () => {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { CSV: ['csv'] }, title: 'Import logins (Apple Passwords / Bitwarden / Chrome CSV export)' });
      if (!picked?.[0]) return;
      const csv = Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8');
      await getSession();
      const n = await BrowserPanel.app!.vaultImport(csv);
      const del = await vscode.window.showInformationMessage(`Cobrowser: imported ${n} login(s), usable in this workspace. The CSV is plaintext — delete it?`, 'Delete the CSV', 'Keep');
      if (del === 'Delete the CSV') await vscode.workspace.fs.delete(picked[0]);
    }),
    vscode.commands.registerCommand('cobrowser.lockVault', async () => {
      await BrowserPanel.app?.vaultLock();
      void vscode.window.showInformationMessage('Cobrowser: vault locked.');
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
