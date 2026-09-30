# Cobrowser

An embedded, agent-controllable browser inside your editor — **co-driven** by you and your AI agent. A small companion app renders one isolated browser per workspace *offscreen* and streams it into a webview panel in VS Code / Cursor. You drive it (frames + input); your agent drives the *same* tabs over MCP (Claude Code, Cursor, or VS Code's agent). Log into a site once — the session persists and the agent acts as you, sandboxed from your daily-driver browser.

> **Status:** in daily use on macOS. What it deliberately does not do is under [Limits](#limits).

## Install

**Cursor, VSCodium and other editors that install from [Open VSX](https://open-vsx.org/extension/trevin-lee/cobrowser):** search for **Cobrowser** in the Extensions view and install it. The editor keeps it up to date.

**VS Code** installs from Microsoft's marketplace, where cobrowser is not listed. Download `cobrowser-<version>.vsix` from the [latest release](https://github.com/trevin-lee/cobrowser/releases/latest) and install it:

```bash
code --install-extension cobrowser-<version>.vsix
```

or with the **Extensions: Install from VSIX…** command. To update, install the newer release the same way.

After installing or updating, quit and reopen the editor, then run **Cobrowser: Open Browser Panel** from the Command Palette.

No browser setup required — the companion app (a pinned Electron, ~120 MB) downloads on first run (see [Requirements](#requirements)).

## Why

- **Agent acts as you, but isolated.** Each workspace gets its own browser profile inside the app, separate from your everyday Chrome or Firefox and outside the repo working tree. Manual logins persist there; the agent inherits them. (If you want the agent in your own browser instead, [the bridge](#your-own-chrome-or-firefox) does that, one tab group or container at a time, when you turn it on.)
- **No floating browser windows.** Tabs render offscreen — there is no OS window at all — and appear as editor tabs next to your code.
- **Consistent tool surface.** MCP tool names mirror [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) (`navigate_page`, `take_snapshot`, `click`, `fill`, …).

## Architecture

```
┌──────── cobrowser app (Electron, menu-bar icon; one per machine) ────────┐
│  workspace A ─ partition persist:A ─ tab ─ tab      (offscreen webContents)│
│  workspace B ─ partition persist:B ─ tab                                   │
│  paints → JPEG frames over a local WebSocket   ·   protocol relay          │
└───────────────┬──────────────────────────────────────────┬────────────────┘
                │ frames / resize / open / close            │ CDP over the same socket
┌───────────────┴──────────── extension host (per editor window) ───────────┐
│  BrowserPanel (webview host)             BrowserSession + MCP tools        │
│  postMessage ↔ canvas, forwards input    one action queue per tab          │
└───────────────────────────────────────────────────────────────────────────┘
            │ postMessage                                    │ HTTP (daemon)
     webview <canvas> — you click/type                 agent (Claude Code / …)
```

**The app owns the browsers; the editor is a client.** Tabs are offscreen webContents: rendered into GPU memory with no OS window, so nothing can hide, minimize or stall them, and they keep painting while you work elsewhere. The app outlives editor windows — a reload reconnects and finds the tabs where they were, and session cookies survive. The extension sends DevTools-protocol commands over the same socket and the app runs them on each tab's in-process debugger, so the MCP tools and the panel's input are real input to the very same tabs — with no debugging port open on the machine and no automation switch on the process. Each tab has its own action queue, so an agent's steps on a tab never interleave while different tabs proceed in parallel; your own clicks and keys go straight to the page.

Electron is pinned (`ELECTRON_VERSION`), so the app's Chromium is the browser version for every install — no dependence on what happens to be in `/Applications`.

## How the agent discovers it

Cobrowser runs **one** MCP endpoint for every window: a small background daemon on
`127.0.0.1:39273` (`cobrowser.port`), gated by a Bearer token. Each editor window registers its
workspace — and that workspace's own browser profile in the app — with the daemon, and the
daemon routes each call to the window that owns the workspace.

```
  VS Code, Cursor ─┐                          ┌─ window A → browser + profile A
  Claude Code      ┼─► cobrowserd :39273 ─────┤
  any other agent ─┘   registry + proxy       └─ window B → browser + profile B
```

A Claude Code session, and VS Code's agent, are **bound to their workspace** by that workspace's
own token: their tools act on that folder's browser only and take no `workspace` argument,
enforced by the credential rather than by trusting what the agent asks for. Cursor, and any
client added with Connect Another Agent, use one unscoped entry, so their tools take a required
`workspace` argument (the folder name, or the full path when names collide) and
`list_workspaces` shows what is open. Either way, routing is explicit, so a long-running agent
never lands on another workspace's browser because focus moved.

An agent keeps its tools whatever order things start in. One that connects before its folder's
window is running (or while the daemon restarts after an update) still gets every tool, and a
call made once the window is up works without reconnecting; windows register again on their own
when the daemon restarts.

cobrowser registers itself with each client through that client's own interface, the way MCP servers that come with an editor extension are meant to be:

| Client | How cobrowser registers |
|---|---|
| **VS Code** agent | VS Code's extension API (`registerMcpServerDefinitionProvider`), with the window's workspace token |
| **Cursor** | Cursor's extension API (`vscode.cursor.mcp.registerServer`), unscoped, when cobrowser runs in Cursor; a Cursor without that API gets the entry in `~/.cursor/mcp.json` |
| **Claude Code** | Claude Code's CLI, `claude mcp add --scope local` in the workspace folder, with that workspace's token; without the CLI, the same entry is written to `~/.claude.json` |
| **Anything else** (Claude Desktop, Codex, Windsurf, …) | **Cobrowser: Connect Another Agent** shows the entry for the client you pick (Claude Desktop reaches the daemon through `mcp-remote`, since it only starts local programs), to add to its config |

cobrowser is not a standalone MCP server (its tools need the editor extension and the browser app), so it is not published as a package or in the MCP Registry: the editor extension is how it is installed.

Nothing is written into your repo, and the URL never changes: the daemon outlives every window,
exits ~2 minutes after the last one closes, and is restarted automatically when its version no
longer matches the installed extension. Older versions wrote `<workspace>/.mcp.json`,
`<workspace>/.cursor/mcp.json` and one `cobrowser-<folder>` entry per repo; all of those are
removed on first run.

## Where you watch it

Every tab is an editor tab in a dedicated pane, streamed from the app at up to 60 fps. The address bar takes an address or words to search; `localhost`, IP addresses and `name:port` load over http, as development servers expect, and a page that cannot load says why. The **Cobrowser** icon in the Activity Bar lists this workspace's tabs (a filled dot marks the one the agent is working in); clicking one shows it. There is no OS window to show — the page is rendered offscreen — so prompts that need one (an extension's toolbar popup) cannot appear. Passkeys fail fast to a password by default (`cobrowser.autoFallbackPasskeys`) until you enable them.

### How it identifies itself

Cobrowser says what it is. The user agent is the standard reduced Chromium UA with a `Cobrowser/<version>` token where Edge and Opera put theirs, the client hints name Chromium and Cobrowser (never Google Chrome), Accept-Language comes from your macOS language list, and the page's `screen` is the real display the pane sits on rather than a fake screen the size of the viewport. Sites asking for a permission (camera, location, notifications, clipboard read) get a native Allow/Block dialog, remembered per site in that workspace only; until you answer, they have nothing. **Cobrowser: Site Permissions for This Workspace** lists what you allowed and blocked, and forgets the ones you pick, so those sites ask again. `navigator.webdriver` reads false, as it does in any Electron app: nothing is overridden, the process is simply not launched with a debugging port. The agent can read the page's console and request log (`list_console_messages`, `list_network_requests`); a DevTools window is refused because it would take the tab's debugger session away from the app. A native `<select>` cannot drop down in an offscreen page, so a click on one opens a macOS menu at the cursor and the choice is applied to the page; the agent's `fill` picks an option by its visible text. Cross-origin iframes (video players, embedded tools, sign-in widgets) run in their own renderer process, which offscreen input does not reach through the page, so the app attaches to each one and delivers your clicks, scrolling and typing to it directly.

### Logins

The app keeps a local vault (encrypted through the OS keychain, unlocked with Touch ID or your Mac's password) that the agent fills from without ever seeing a password: `list_credentials` shows the sites and usernames this workspace may use, `fill_credentials` types a login into the fields the agent picked, and the app checks the page is really on that site first. The **Logins** window (**Cobrowser: Manage Logins**, or **Logins…** in the menu-bar icon) is where the vault lives: add, edit and remove logins, and choose for each the workspaces that may use it, or all. **Edit** changes a login's site, username, password or workspaces (a blank password keeps the saved one). Adding a login that already exists says so before you save, and fills in the workspaces it has now, so saving replaces the password and changes the workspaces only if you do. The editor has shortcuts too: **Cobrowser: Add Login to Vault** (a login added again this way keeps its workspaces and gains this one) and **Cobrowser: Import Logins from CSV** (or **Import CSV…** in the window), which says how many logins were new and how many it replaced; a login it replaces keeps its workspaces and gains the import's.

Every vault check is Touch ID, or your Mac's password when Touch ID is out of reach (a closed lid, a desktop without Apple's Touch ID keyboard), from the same macOS prompt Safari uses before it shows a password. Unlocking asks once per app session; every change, and every time a password is shown or exported, asks again. **Export CSV…**, or **Cobrowser: Export Logins to CSV**, writes every login to a CSV other password managers import. Each login's note records the workspaces it may be used in, so importing the file back into cobrowser restores them. The file is plain text, so delete it once it is imported. **Cobrowser: Lock Vault** locks the vault until a login is next needed.

When an agent needs a login its workspace is not scoped for, it calls `request_credential` with the site and a one-line reason. You get a native dialog naming the workspace and the login: **Allow in this workspace** adds the workspace to the login's scope, **Allow once** permits a single fill, **Deny** does nothing. With several logins for the site, you pick one, and it is allowed once unless you tick **Allow in this workspace from now on**. The agent only learns the outcome, and a denial is indistinguishable from there being no such login, so a workspace's agent still cannot enumerate what others hold. That boundary holds for agents scoped to a workspace (Claude Code, VS Code's agent). An unscoped client (Cursor, or one added with Connect Another Agent) names a workspace in each call, so it reaches every workspace's browser and logins: connect those only if you would trust them with all of it.

### Popups, dialogs, uploads and downloads

Tabs are hidden offscreen windows, so everything a page would normally show in a window of its own is handled by the app instead:

- **Sign-in and payment popups** (`window.open` with a size, as "Sign in with Google" uses) open as a real small window on your desktop, as in Chrome, keep `window.opener` so they can report back, and close themselves. Links that open a new tab stay editor tabs.
- **alert, confirm and prompt** show as app dialogs; the page waits for your answer, as it would in Chrome. **"Leave this site?"** prompts are asked the same way.
- **File uploads** use the app's file picker, including inside cross-site iframes.
- **Dropdowns, date, time and color fields** open their picker as a macOS menu or a small window of the app's own at the cursor, and your choice goes back into the page. The agent's `fill` sets them directly.
- **Downloads** save straight to your Downloads folder (never overwriting), with a notification that opens the file in Finder.
- **Fullscreen** (a video player's button) fills the tab, with the panel's toolbar hidden; Escape leaves it. Nothing takes over your display.
- **A self-signed certificate** (a router or a device on your network) gets Chrome's question: proceed anyway, remembered for that host in that workspace until the app quits.
- **A password asked for by the browser itself** (HTTP basic auth) gets a small sign-in window.
- **A crashed page** reloads by itself, unless it crashes three times in a minute.
- **Tabs no panel is showing** draw 4 times a second instead of 60, and at full rate again the moment anything acts on them.

If the agent's action opens a dialog or a file picker, it is shown to you, and the agent's action waits for your answer.

### The app

The browser runs as a menu-bar app named cobrowser, with its own icon. The Electron it downloads is renamed `cobrowser.app` and given the name, bundle id and icon once, before its first start, then re-sealed: with your identity when it is signed for passkeys, ad hoc otherwise. It is marked menu-bar-only, so it never appears in the Dock or the app switcher. The icon is drawn by `scripts/make-icon.js` from the mark in `media/icon.png`.

The menu-bar icon lists each workspace and its tab count, and quits the app. Quitting closes every workspace's tabs; the next panel or tool call starts it again, and each editor window reopens the tabs it had, each still the agent's or yours. **Cobrowser: Restart Browser** does the same for this workspace alone: its tabs close and reopen, and other workspaces are untouched.

In a panel, the usual browser keys work: ⌘T new tab, ⌘W close, ⌘R reload, ⌘[ and ⌘] (or ⌥← and ⌥→) back and forward.

Each workspace's browser keeps its own cookies, sign-ins, site data and permissions. **Cobrowser: Clear Browsing Data for This Workspace** signs it out of everything (open tabs stay open; the vault and permissions are kept). **Cobrowser: Forget Another Workspace's Browser** deletes another workspace's tabs, browsing data and permissions, for a project you are done with; its logins stay in the vault.

### Passkeys

Run **Cobrowser: Enable Passkeys (Sign the Browser)** once. Chromium's Touch ID authenticator only works in an app signed with a `keychain-access-groups` entitlement, and Apple only grants that entitlement through a provisioning profile, so the command re-signs the downloaded browser with your Apple Development identity and an app identifier you choose. It builds a stub Xcode project and lets `xcodebuild -allowProvisioningUpdates` mint the profile, which needs Xcode with an Apple ID signed in (Xcode → Settings → Accounts). After that the Touch ID sheet is a system dialog, so it appears even though the page renders offscreen; passkeys are created inside cobrowser (add one from a site's security settings after a password sign-in) and live in this Mac's Secure Enclave keychain — they do not sync, and existing iCloud Keychain passkeys are not visible here, because Apple grants that only to real browsers. USB security keys work too. The browser restarts signed the next time a panel opens. A Developer ID certificate is used instead when present.

Enable Passkeys asks which of your teams signs it and for an app identifier the team can register (an identifier belongs to the first team that registers it, so a second team needs its own, such as `com.yourcompany.cobrowser`). A free personal team's provisioning profile lasts 7 days; a paid team's lasts a year, so prefer one if you have it. Past expiry macOS refuses to start the signed browser, so before each start the extension checks: an expired signature is renewed with the same team and identifier, and if that fails the browser is signed ad hoc again, so it always starts, passkeys fall back to passwords, and a notification says to run Enable Passkeys. Passkeys belong to the keychain group of the team that signed the browser, so switching teams leaves earlier ones behind.

**Cobrowser: Turn Off Passkeys** signs the browser again as it was downloaded; passkeys already saved stay in your keychain and work again if you re-enable with the same team and identifier. While passkeys are off, a site's passkey prompt fails at once, both for signing in and for creating one, so it falls back to its password form and never records a passkey nobody holds.

## Your own Chrome or Firefox

The panel is where the agent works best, but sometimes the work is already open in your own browser, signed in. The **bridge** is a small browser extension that lets the agent reach it: the `bridge_*` tools (`bridge_list_tabs`, `bridge_new_tab`, `bridge_close_tab`, `bridge_activate_tab`, `bridge_navigate`, `bridge_read_page`, `bridge_snapshot`, `bridge_click`, `bridge_fill`, `bridge_wait_for`, `bridge_query`, `bridge_evaluate_script` (Firefox only; Chrome runs no code sent to an extension, so reads go through `bridge_query`), `bridge_fetch`, `bridge_screenshot`, `bridge_list_containers`). They take the same words as the panel's tools (`uid`, `function`/`args`, `timeout`, `elements`, and `back`/`forward`/`reload`) and follow the same rules. Every agent sees them; in a workspace that is not bound yet, a call says how you bind it, so binding works for an agent that is already running.

A workspace is bound to one scope: one **Chrome tab group** (or the whole Chrome profile), or one **Firefox container**, never both. The extension refuses anything outside it. A tab group limits what the agent can reach, not what the browser knows: every Chrome tab shares the profile's logins.

**Chrome.** Run **Cobrowser: Install Chrome Bridge Extension**: it copies the extension to `~/.cobrowser/chrome-extension` and copies that path. In `chrome://extensions`, turn on Developer mode, click **Load unpacked** and choose the folder. Then run **Cobrowser: Bind Chrome Tab Group to This Workspace**, and paste the URL from **Cobrowser: Copy Bridge URL** into the extension's toolbar popup. Updating cobrowser updates that folder; Chrome loads the new version when it restarts, or at once with the extension's reload button. Each release also carries the extension as `cobrowser-bridge-chrome-<version>.zip`.

**Firefox** (and forks with containers: Zen, LibreWolf, Floorp, Waterfox). Download `cobrowser-bridge-firefox-<version>.xpi` from the [latest release](https://github.com/trevin-lee/cobrowser/releases/latest) and install it from `about:addons` → gear → **Install Add-on From File…**. It is signed by Mozilla (unlisted), and Firefox updates it by itself after each release. Then run **Cobrowser: Bind Firefox Container to This Workspace**; the extension finds the workspace by itself. Details in [firefox-extension/README.md](firefox-extension/README.md).

What to expect:

- **Input is synthetic.** No extension can send real clicks or keystrokes, and some sites ignore synthetic ones. A click that changed nothing on the page comes back saying so, and the agent moves that step to the panel.
- **It goes at a hand's pace.** Everything that reaches a site waits 1 to 3 seconds, stops at 100 requests in a browser session, and pauses for a minute when a site refuses or shows a challenge. The count and a **Reset** button are in the extension's toolbar popup; only you can reset it.
- **It tidies up after itself.** `bridge_list_tabs` marks the tabs the agent opened, and `bridge_close_tab` closes those; one of yours only when you ask (the agent passes `allowHumanTab`), as in the panel.
- **It is released with cobrowser.** The extension carries cobrowser's version; when it is older, the agent's results say so and how to update it.
- The same rule as the panel: no paying and no typing secrets unless you say so. The vault does not reach your own browser; you sign in there yourself.

## Working on cobrowser while using it

Press **F5** (*Run Cobrowser Extension*). That opens an Extension Development Host running
the working tree, and it is fully isolated from your installed cobrowser:

| | installed | dev host (F5) |
|---|---|---|
| daemon port | 39273 | **39274** |
| daemon token | `~/.cobrowser/daemon-token` | `~/.cobrowser/dev-daemon-token` |
| client entry | `cobrowser` | `cobrowser-dev` |
| browser app state | `~/.cobrowser` | `~/.cobrowser/dev` |
| browser profiles and vault | `~/Library/Application Support/cobrowser` | `~/Library/Application Support/cobrowser-dev` |

So a rebuild never restarts the daemon or the browser app your other windows use, never
rewrites their config entry, and never touches their tabs, profiles or vault. The dev host's
app is a second menu-bar icon ("cobrowser (development)"). Point an agent at `cobrowser-dev`
to drive the build you are working on.

`npm run release`, by contrast, is a *global* install: it replaces the extension in every
window and restarts the shared daemon, which drops every other window's MCP auth until each
reloads. Use it when you are done, not while iterating.

A daemon is also never restarted into an older build, so a window still running a previous
release cannot drag everyone backwards.

## MCP tools

`list_pages`, `new_page`, `select_page`, `close_page`, `navigate_page`, `read_page`, `take_snapshot`, `take_screenshot`, `click`, `fill`, `fill_form`, `type_text`, `wait_for`, `evaluate_script`, `list_console_messages`, `list_network_requests`, `list_credentials`, `fill_credentials`, `request_credential`, `get_activity`, `get_editor_layout`, `list_workspaces` (the open workspaces, or the one a scoped session is bound to), and the `bridge_*` tools for your own browser ([above](#your-own-chrome-or-firefox)).

`wait_for` waits for any of the texts it is given, and says which one appeared, so one call covers "Saved" or "Error". `close_page` closes the tabs the agent opened; one of yours only when you asked it to (the agent passes `allowHumanTab`), and never the last one.

Every page tool takes an optional `pageId`, and the agent and the human each have their own current tab. Tabs are independent offscreen windows, so the agent can work in a background tab while you read another: switching tabs in your editor never retargets the agent, and the agent switching tabs (`select_page`) never moves your view unless it passes `bringToFront`. `list_pages` reports both (`selected` is the agent's tab, `humanViewing` yours), actions on different tabs run in parallel while actions on one tab stay in order, and the app remembers which tabs the agent opened, so they stay the agent's to tidy up across reloads.

`read_page` is the cheap way to read: the page's visible text, optionally one region and its links. `take_snapshot` is for acting: visible interactive elements (link destinations, input values, select options, open shadow roots) each with a `[uid]` for `click`/`fill`, filterable by region, text, role and label, capped at 200 by default. **uids are stable**: an element keeps its uid for as long as it exists and uids never repeat within a tab, so agents snapshot again only after a navigation or when new UI appears. Password fields show as `(filled)`, never their value.

## Develop it

### Tests

`npm test` runs the unit tests. `npm run test:e2e` runs the end-to-end suites in `test/e2e/`: each starts its own isolated copy of the app (scratch state and data dirs, biometrics and dialogs auto-answered) and drives it through the real client and session code — pages, input, native selects, cross-origin iframes, tabs and focus, dialogs and popups, credentials, per-workspace permissions and browsing data, the bridge extensions' page code, the Chrome add-on in a real Chrome for Testing (skipped when none is installed; `npx playwright install chromium` adds one), single-instance, branding. They need `npm run build` first and take about two minutes. `npm run bench:e2e` prints measurements (scroll latency, what a site sees, snapshot sizes) without asserting. Nothing in them can reach your real app, tabs or vault.


```bash
npm install
npm --prefix app install   # the pinned Electron, so a checkout needs no download
npm run build              # esbuild → dist/ (extension, webview, daemon, app)
```

Then open this folder in VS Code / Cursor and press **F5** (launches the Extension Development Host). In the dev host:

1. Run **Cobrowser: Open Browser Panel** (Command Palette) — the app starts (from `app/node_modules` in a checkout, no download) and a tab streams into the panel.
2. Navigate + **log into** the sites you want the agent to use. Credentials persist in the workspace's profile.
3. Point your agent at the MCP server (auto-registered per the table above) and drive the same tabs.

The app's source is `app/main.js`, bundled to `dist/app/main.js` by the build; the installed extension runs that bundle with a downloaded Electron, a checkout runs it with the one in `app/node_modules`.

Scripts: `npm run watch` (rebuild on change), `npm run typecheck`.

### Releasing

`npm run release` bumps the version in `package.json` and both add-on manifests (they always match) and installs the build into your editors. Add the version's entry to `CHANGELOG.md`, commit, then tag and push: `git tag vX.Y.Z && git push origin main vX.Y.Z`. The Release workflow checks that the versions match the tag, and publishes the release with the CHANGELOG entry as its notes. It attaches the `.vsix`, the Chrome add-on's zip and the Firefox add-on, signed by Mozilla, and publishes the `.vsix` to Open VSX. Firefox signing needs the `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` repository secrets ([firefox-extension/README.md](firefox-extension/README.md#signing)), Open VSX an `OVSX_PAT` access token for the `trevin-lee` namespace. A job without its secret is skipped with a warning; run the workflow by hand with the tag to fill it in.

## Design decisions worth knowing

- **Per-request MCP transport.** Stateless Streamable HTTP creates a fresh `McpServer` + transport per POST (a single shared instance would misroute concurrent clients).
- **Cursor-safe activation.** The VS Code-only MCP API is feature-detected.
- **Tabs belong to the app, not the socket.** A window's connection can drop (reload) without closing anything; the same workspace reconnecting adopts its tabs by the app's tab id. Another workspace never sees them.
- **Never uncap the frame rate.** Measured twice: `--disable-frame-rate-limit` multiplies CPU ~35x for no extra frames. `setFrameRate` alone reaches 120 fps at a tenth of a core.

## Limits

- **macOS only.** The pinned Electron is downloaded for macOS (arm64 and x64).
- **A browser per folder.** A window without a folder gets a panel, but no agent can reach its browser and it cannot be bound to your own browser. In a multi-root workspace, the first folder is the one agents reach.
- **The agent's tools stop at embedded frames.** A video player or widget embedded from another site is listed in `take_snapshot` as `[frame]`, and the agent hands it to you: your own clicks and typing reach inside it, the agent's do not.
- **No accessibility tree.** `take_snapshot` tags interactive DOM elements with `uid`s rather than walking the accessibility tree.
- **`evaluate_script` runs arbitrary JavaScript in the page.** It is the escape hatch, and it is not subject to the click and fill rule below.
- **Stateless MCP.** No resumable sessions; each request stands alone.
- **Your own browser gets synthetic input only.** No browser extension can send real clicks or keystrokes, and some sites (Google's and Cloudflare's consoles among them) ignore synthetic ones. The own-browser tools report a click that changed nothing and point the agent to the panel, where input is real.
- **The agent does not pay or type secrets on its own.** In both the panel and your own browser, it will not click a button that pays or places an order, or type a password, one-time code or card number, unless you tell it to (`allowPayment`, `allowCredentials`). In the panel, saved logins go in through `fill_credentials`, which never shows it the password; the vault does not reach your own browser, so there you sign in yourself.

## Security notes

Each workspace's browser profile holds live session cookies — treat it as credentials. Profiles live in the app's data folder (`~/Library/Application Support/cobrowser`), outside every repo. The vault is encrypted with a key in your login keychain and unlocks with Touch ID or your Mac's password; every change, and showing or exporting passwords, asks again every time, and a stored password is never sent back out to the editor or the agent. The daemon binds `127.0.0.1` only and is gated by tokens stored with owner-only permissions under `~/.cobrowser`: a daemon-wide one for unscoped clients (and the bridge extensions) and one per workspace for scoped sessions. Copies also sit in each agent's own config (`~/.claude.json`, and whatever you connect by hand), with that app's file permissions. It also rejects any request whose `Host` header is not a loopback address. No remote debugging port is ever opened, so no other process can attach to the browser. Seed each profile only with the accounts your automation needs; don't put high-value logins (primary email, bank) in an agent-driven browser.

## Uninstall

Quit the app (menu-bar icon → Quit), then uninstall the extension from the Extensions view, or with `code --uninstall-extension trevin-lee.cobrowser` (`cursor`, `codium`). Once the editor restarts, cobrowser takes its entries out of Claude Code (every project) and Cursor. Entries you added with Connect Another Agent are yours to remove from those apps. What it leaves behind, all of which is safe to delete:

- `~/Library/Application Support/cobrowser`: every workspace's browser profile (cookies, sign-ins), the vault (`vault.bin`), site permissions and the app's log.
- `~/.cobrowser`: the daemon's and app's tokens and state, and the Chrome bridge folder.
- `~/Library/Application Support/Code/User/globalStorage/trevin-lee.cobrowser` (Cursor and VSCodium: the same path under `Cursor` or `VSCodium`): the downloaded browser.
- `~/Library/Application Support/Mozilla/ManagedStorage/cobrowser-bridge@trevin.dev.json`, if you used the Firefox bridge; remove the extensions from Chrome and Firefox themselves.
- In Keychain Access: the **cobrowser Safe Storage** item (the vault's key), and any passkeys you created in cobrowser.
- If you enabled passkeys: the provisioning profile Xcode keeps for your cobrowser identifier in `~/Library/Developer/Xcode/UserData/Provisioning Profiles`, and the identifier itself (and this Mac, if nothing else uses it) under Certificates, Identifiers & Profiles at developer.apple.com.
- If you worked on cobrowser: `~/Library/Application Support/cobrowser-dev` and `~/.cobrowser/dev`, the development host's app.

## Requirements

- **VS Code, Cursor or VSCodium**, and an agent that speaks MCP over HTTP (Claude Code, Cursor, or VS Code's agent).
- **No browser setup.** On first run the extension downloads the pinned Electron into `globalStorage` (checksum-verified against the release's `SHASUMS256.txt`) and runs the bundled app with it. Nothing depends on what you have installed.
- **macOS** only for now (arm64 and x64).
