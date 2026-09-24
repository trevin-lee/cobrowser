# Cobrowser

An embedded, agent-controllable browser inside your editor — **co-driven** by you and your AI agent. A small companion app renders one isolated browser per workspace *offscreen* and streams it into a webview panel in VS Code / Cursor. You drive it (frames + input); your agent drives the *same* tabs over MCP (Claude Code, Cursor, or VS Code's agent). Log into a site once — the session persists and the agent acts as you, sandboxed from your daily-driver browser.

> **Status: early.** The core loop (per-workspace profile → offscreen frames → agent-over-MCP → same tabs) works and is what you get by default. See [Simplifications](#simplifications) and [Next steps](#next-steps).

## Install

Not on the marketplaces yet — install the VSIX from [Releases](https://github.com/trevin-lee/cobrowser/releases):

```bash
# Cursor
cursor --install-extension cobrowser-0.7.0.vsix
# VS Code
code --install-extension cobrowser-0.7.0.vsix
```

Or use the editor's **Extensions: Install from VSIX…** command. Then reload the window and run **Cobrowser: Open Browser Panel** from the Command Palette.

No browser setup required — the companion app (a pinned Electron, ~120 MB) downloads on first run (see [Requirements](#requirements)).

## Why

- **Agent acts as you, but isolated.** Each workspace gets its own browser profile inside the app, never your real Chrome/Zen profile and never the repo working tree. Manual logins persist there; the agent inherits them.
- **No floating browser windows.** Tabs render offscreen — there is no OS window at all — and appear as editor tabs next to your code.
- **Consistent tool surface.** MCP tool names mirror [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) (`navigate_page`, `take_snapshot`, `click`, `fill`, …).

## Architecture

```
┌──────── cobrowser app (Electron, menu-bar icon; one per machine) ────────┐
│  workspace A ─ partition persist:A ─ tab ─ tab      (offscreen webContents)│
│  workspace B ─ partition persist:B ─ tab                                   │
│  paints → JPEG frames over a local WebSocket   ·   Chromium debugging port │
└───────────────┬──────────────────────────────────────────┬────────────────┘
                │ frames / resize / open / close            │ CDP (puppeteer)
┌───────────────┴──────────── extension host (per editor window) ───────────┐
│  BrowserPanel (webview host)             BrowserSession + MCP tools        │
│  postMessage ↔ canvas, forwards input    run() FIFO serializes all actions │
└───────────────────────────────────────────────────────────────────────────┘
            │ postMessage                                    │ HTTP (daemon)
     webview <canvas> — you click/type                 agent (Claude Code / …)
```

**The app owns the browsers; the editor is a client.** Tabs are offscreen webContents: rendered into GPU memory with no OS window, so nothing can hide, minimize or stall them, and they keep painting while you work elsewhere. The app outlives editor windows — a reload reconnects and finds the tabs where they were, and session cookies survive. The extension's puppeteer attaches to the app's debugging port, so the MCP tools and the panel's trusted input drive the very same tabs. Everything funnels through `run()` so agent and human actions never interleave mid-action.

Electron is pinned (`ELECTRON_VERSION`), so the app's Chromium is the browser version for every install — no dependence on what happens to be in `/Applications`.

## How the agent discovers it

Cobrowser runs **one** MCP endpoint for every window: a small background daemon on
`127.0.0.1:39273` (`cobrowser.port`), gated by a Bearer token. Each editor window keeps its own
browser + Chrome profile and registers it with the daemon; the daemon proxies each call to the
window that owns the named workspace.

```
  ~/.cursor/mcp.json ─┐                     ┌─ window A → browser + profile A
  ~/.claude.json     ─┴─► cobrowserd :39273 ┤
   (ONE entry)            registry + proxy  └─ window B → browser + profile B
```

Every tool therefore takes a required `workspace` argument — the folder name, or the full path
when names collide — and `list_workspaces` shows what is open. Routing is explicit precisely so
a long-running agent can never land on a different workspace's browser because focus moved.

| Client | Mechanism |
|---|---|
| **VS Code** agent | `vscode.lm.registerMcpServerDefinitionProvider` (native), pointed at the daemon |
| **Cursor** | `~/.cursor/mcp.json` → one `cobrowser` entry |
| **Claude Code** | `~/.claude.json` → top-level `mcpServers.cobrowser` (user scope) |

Nothing is written into your repo, and the URL never changes: the daemon outlives every window,
exits ~2 minutes after the last one closes, and is restarted automatically when its version no
longer matches the installed extension. Older versions wrote `<workspace>/.mcp.json`,
`<workspace>/.cursor/mcp.json` and one `cobrowser-<folder>` entry per repo; all of those are
removed on first run.

## Where you watch it

Every tab is an editor tab in a dedicated pane, streamed from the app at up to 60 fps. There is no OS window to show — the page is rendered offscreen — so prompts that need one (an extension's toolbar popup) cannot appear. Passkeys fail fast to a password by default (`cobrowser.autoFallbackPasskeys`) until you enable them.

### Passkeys

Run **Cobrowser: Enable Passkeys (Sign the Browser)** once. Chromium's Touch ID authenticator only works in an app signed with a `keychain-access-groups` entitlement, and Apple only grants that entitlement through a provisioning profile, so the command re-signs the downloaded browser as `dev.trevin.cobrowser` with your Apple Development identity. It builds a stub Xcode project and lets `xcodebuild -allowProvisioningUpdates` mint the profile, which needs Xcode with an Apple ID signed in (Xcode → Settings → Accounts). After that the Touch ID sheet is a system dialog, so it appears even though the page renders offscreen; passkeys are created inside cobrowser (add one from a site's security settings after a password sign-in) and live in this Mac's Secure Enclave keychain — they do not sync, and existing iCloud Keychain passkeys are not visible here, because Apple grants that only to real browsers. USB security keys work too. The browser restarts signed the next time a panel opens. A Developer ID certificate is used instead when present.

The menu-bar icon lists each workspace and its tab count, and quits the app. Quitting closes every workspace's tabs; the next panel or tool call starts it again.

## Working on cobrowser while using it

Press **F5** (*Run Cobrowser Extension*). That opens an Extension Development Host running
the working tree, and it is fully isolated from your installed cobrowser:

| | installed | dev host (F5) |
|---|---|---|
| daemon port | 39273 | **39274** |
| daemon token | `~/.cobrowser/daemon-token` | `~/.cobrowser/dev-daemon-token` |
| client entry | `cobrowser` | `cobrowser-dev` |

So a rebuild never restarts the daemon your other windows are registered with, never rewrites
their config entry, and never touches the repo files they use. Point an agent at
`cobrowser-dev` to drive the build you are working on.

`npm run release`, by contrast, is a *global* install: it replaces the extension in every
window and restarts the shared daemon, which drops every other window's MCP auth until each
reloads. Use it when you are done, not while iterating.

A daemon is also never restarted into an older build, so a window still running a previous
release cannot drag everyone backwards.

## MCP tools

`list_pages`, `new_page`, `select_page`, `navigate_page`, `take_snapshot`, `take_screenshot`, `click`, `fill`, `fill_form`, `type_text`, `wait_for`, `evaluate_script`.

`take_snapshot` returns an interactive-element text tree; each node has a `[uid]` for `click`/`fill`. **uids expire on any DOM change** — re-snapshot before reusing them.

## Develop it

```bash
npm install
npm run build      # esbuild → dist/extension.js + dist/webview.js
```

Then open this folder in VS Code / Cursor and press **F5** (launches the Extension Development Host). In the dev host:

1. Run **Cobrowser: Open Browser Panel** (Command Palette) — the app starts (from `app/node_modules` in a checkout, no download) and a tab streams into the panel.
2. Navigate + **log into** the sites you want the agent to use. Credentials persist in the workspace's profile.
3. Point your agent at the MCP server (auto-registered per the table above) and drive the same tabs.

The app's source is `app/main.js`, bundled to `dist/app/main.js` by the build; the installed extension runs that bundle with a downloaded Electron, a checkout runs it with the one in `app/node_modules`.

Scripts: `npm run watch` (rebuild on change), `npm run typecheck`.

## Design decisions worth knowing

- **Per-request MCP transport.** Stateless Streamable HTTP creates a fresh `McpServer` + transport per POST (a single shared instance would misroute concurrent clients).
- **Cursor-safe activation.** The VS Code-only MCP API is feature-detected.
- **Tabs belong to the app, not the socket.** A window's connection can drop (reload) without closing anything; the same workspace reconnecting adopts its tabs by target id. Another workspace never sees them.
- **Never uncap the frame rate.** Measured twice: `--disable-frame-rate-limit` multiplies CPU ~35x for no extra frames. `setFrameRate` alone reaches 120 fps at a tenth of a core.

## Simplifications

- Stateless MCP (no resumable sessions); single active page tracked; screencast follows the active target only.
- JPEG frames encoded on the app's main thread (~6 ms at panel size). Shared-texture hardware encode is the planned next step, not a switch.
- `uid` model is DOM-attribute tagging, not a full accessibility tree.
- `evaluate_script` runs arbitrary JS in the page (escape hatch).

## Next steps

- Publish to Open VSX so Cursor can install it directly.
- Windows/Linux (the Electron download is macOS-only so far).
- Pop-out to a real window; a local, Touch-ID-unlocked vault the agent fills from without seeing.
- Richer/accessibility-tree `take_snapshot`; multi-tab mirroring UI.
- Input-owner hard lock (currently a FIFO queue + advisory flag).

## Security notes

The profile holds live session cookies — treat it as credentials. It lives in `globalStorageUri` (outside the repo). The MCP server binds `127.0.0.1` only, is token-gated (random Bearer per session), and does manual, port-aware `Host`-header validation (the SDK's built-in `allowedHosts` check matches the port-bearing raw header and would reject everything). Seed the profile only with the accounts your automation needs; don't drop high-value logins (primary email, bank) into an agent-driven browser.

## Requirements

- **VS Code or Cursor**, and an agent that speaks MCP over HTTP (Claude Code, Cursor, or VS Code's agent).
- **No browser setup.** On first run the extension downloads the pinned Electron into `globalStorage` (checksum-verified against the release's `SHASUMS256.txt`) and runs the bundled app with it. Nothing depends on what you have installed.
- **macOS** only for now (arm64 and x64).

## Publishing (Open VSX)

Cursor installs from [Open VSX](https://open-vsx.org), not the MS Marketplace. After signing the Eclipse Publisher Agreement and creating the `trevin-lee` namespace: `npm run package` → `npx ovsx publish cobrowser-<version>.vsix -p <token>`.
