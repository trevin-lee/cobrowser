# Cobrowser

An embedded, agent-controllable browser inside your editor — **co-driven** by you and your AI agent. One persistent, isolated Chromium lives in a webview panel in VS Code / Cursor. You drive it (screencast + input); your agent drives the *same* browser over MCP (Claude Code, Cursor, or VS Code's agent). Log into a site once — the session persists and the agent acts as you, sandboxed from your daily-driver browser.

> **Status: early.** The core loop (persistent profile → screencast → agent-over-MCP → same browser) works and is what you get by default. The container backend and the H.264 video pipeline are opt-in and still settling. See [Simplifications](#simplifications) and [Next steps](#next-steps).

## Install

Not on the marketplaces yet — install the VSIX from [Releases](https://github.com/trevin-lee/cobrowser/releases):

```bash
# Cursor
cursor --install-extension cobrowser-0.5.10.vsix
# VS Code
code --install-extension cobrowser-0.5.10.vsix
```

Or use the editor's **Extensions: Install from VSIX…** command. Then reload the window and run **Cobrowser: Open Browser Panel** from the Command Palette.

No Chrome setup required — a dedicated Chrome-for-Testing downloads on first run (see [Requirements](#requirements)).

## Why

- **Agent acts as you, but isolated.** The profile lives in the extension's storage (`globalStorageUri`), never your real Chrome/Zen profile and never the repo working tree. Manual logins persist there; the agent inherits them.
- **One app, no floating browser windows.** The browser is a panel next to your code.
- **Consistent tool surface.** MCP tool names mirror [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) (`navigate_page`, `take_snapshot`, `click`, `fill`, …).

## Architecture

```
┌──────────── VS Code / Cursor extension host (Node) ────────────┐
│                                                                │
│   BrowserSession (single owner)                                │
│     • owns ONE puppeteer-core Chromium (persistent profile)    │
│     • one CDPSession to the active page                        │
│     • run() FIFO queue serializes ALL actions                  │
│        ▲                         ▲                             │
│        │ tool calls              │ input + screencast          │
│   in-process MCP           BrowserPanel (webview host)         │
│   Streamable HTTP          postMessage <-> canvas              │
│   127.0.0.1:PORT/mcp                                           │
│   + Bearer token                                               │
└────────┼─────────────────────────┼────────────────────────────┘
         │ HTTP (localhost)         │ postMessage
   agent (Claude Code /       webview <canvas>  ── you click/type
   Cursor / VS Code)          renders JPEG frames, forwards input
```

**One browser, two drivers.** The extension host owns Chromium and hosts the MCP server *in the same process*, so MCP tool handlers and the webview both call one in-memory `BrowserSession`. No second browser, no cross-process handshake. Everything funnels through `run()` so agent and human actions never interleave mid-action.

Chosen over the alternative (launch with a fixed `--remote-debugging-port` and attach two independent CDP clients) because in-process sharing makes concurrency a local queue instead of cross-process contention. Migrating to survive extension-host reloads later is a `launch()` → `connect()` swap that doesn't touch the MCP or webview layers.

## How the agent discovers it

The server binds `127.0.0.1` on port `39273` (or an ephemeral fallback), gated by a random per-session Bearer token. On activation the extension registers it three ways:

| Client | Mechanism |
|---|---|
| **VS Code** agent | `vscode.lm.registerMcpServerDefinitionProvider` (native; dynamic port, no files) |
| **Cursor** | writes `<workspace>/.cursor/mcp.json` |
| **Claude Code** | writes `<workspace>/.mcp.json` (with the required `"type": "http"`) |

Both written files carry the **literal** live port + token and are added to `.git/info/exclude` (local-only) so the secret never lands in a commit. The VS Code API is feature-detected, so activation doesn't throw in Cursor (which lacks it).

## MCP tools

`list_pages`, `new_page`, `select_page`, `navigate_page`, `take_snapshot`, `take_screenshot`, `click`, `fill`, `fill_form`, `type_text`, `wait_for`, `evaluate_script`.

`take_snapshot` returns an interactive-element text tree; each node has a `[uid]` for `click`/`fill`. **uids expire on any DOM change** — re-snapshot before reusing them.

## Develop it

```bash
npm install
npm run build      # esbuild → dist/extension.js + dist/webview.js
```

Then open this folder in VS Code / Cursor and press **F5** (launches the Extension Development Host). In the dev host:

1. Run **Cobrowser: Open Browser Panel** (Command Palette) — Chromium launches headful and streams into the panel.
2. Navigate + **log into** the sites you want the agent to use. Credentials persist in the profile.
3. Point your agent at the MCP server (auto-registered per the table above) and drive the same browser.

By default the browser runs **headless** — it lives entirely in the Cursor panel with no separate OS window. If you need native-UI moments (file pickers, native `<select>` dropdowns, 2FA, drag-drop, or sign-ins like Google that block headless), set **`cobrowser.headless`** to `false` and reload: a real Chrome window opens alongside the panel, and **Open native window** brings it to the front. Same browser, same session either way.

Scripts: `npm run watch` (rebuild on change), `npm run typecheck`.

## Design decisions worth knowing

- **Per-request MCP transport.** Stateless Streamable HTTP creates a fresh `McpServer` + transport per POST (a single shared instance would misroute concurrent clients).
- **Cursor-safe activation.** The VS Code-only MCP API is feature-detected.
- **Orphan cleanup.** The Chromium PID is persisted; a stale one is killed and `SingletonLock`/`SingletonSocket`/`SingletonCookie` cleared on activate, so the reload loop can't brick the persistent profile.
- **Screencast re-attach.** The pump tears down + re-establishes (and re-acks) on every active-page change.

## Simplifications

- Stateless MCP (no resumable sessions); single active page tracked; screencast follows the active target only.
- JPEG screencast — no adaptive bitrate. The opt-in H.264 pipeline (`cobrowser.videoPipeline`) is experimental.
- `uid` model is DOM-attribute tagging, not a full accessibility tree.
- `evaluate_script` runs arbitrary JS in the page (escape hatch).
- Container backend (`cobrowser.backend: "container"`) needs Docker and pulls a GHCR image; it keeps its own profile, separate from the local one.

## Next steps

- Publish to Open VSX so Cursor can install it directly.
- Cross-platform launch paths (Windows/Linux) — developed against macOS.
- Richer/accessibility-tree `take_snapshot`; multi-tab mirroring UI.
- Input-owner hard lock (currently a FIFO queue + advisory flag).

## Security notes

The profile holds live session cookies — treat it as credentials. It lives in `globalStorageUri` (outside the repo). The MCP server binds `127.0.0.1` only, is token-gated (random Bearer per session), and does manual, port-aware `Host`-header validation (the SDK's built-in `allowedHosts` check matches the port-bearing raw header and would reject everything). Seed the profile only with the accounts your automation needs; don't drop high-value logins (primary email, bank) into an agent-driven browser.

## Requirements

- **VS Code or Cursor**, and an agent that speaks MCP over HTTP (Claude Code, Cursor, or VS Code's agent).
- **No Chrome setup.** On first run the extension resolves an executable in this order: `cobrowser.chromePath` if you set it → a dedicated **Chrome-for-Testing** downloaded into `globalStorage` and pinned by buildId → your system Chrome as a last-resort fallback. Only the third depends on what you have installed.
- **Docker** — *only* if you opt into `cobrowser.backend: "container"`.
- Developed and tested on **macOS**; Windows/Linux launch paths aren't done yet.

## Publishing (Open VSX)

Cursor installs from [Open VSX](https://open-vsx.org), not the MS Marketplace. After signing the Eclipse Publisher Agreement and creating the `trevin-lee` namespace: `npm run package` → `npx ovsx publish cobrowser-<version>.vsix -p <token>`.
