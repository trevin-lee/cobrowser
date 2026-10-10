# Cobrowser

An embedded, agent-controllable browser inside your editor — **co-driven** by you and your AI agent. A small companion app renders one isolated browser per workspace *offscreen* and streams it into a webview panel in VS Code / Cursor. You drive it (frames + input); your agent drives the *same* tabs over MCP (Claude Code, Cursor, or VS Code's agent). Log into a site once — the session persists and the agent acts as you, sandboxed from your daily-driver browser.

> **Status:** in daily use on macOS. What it deliberately does not do is under [Limits](#limits).

## Install

Search for **Cobrowser** in your editor's Extensions view and install it; the editor keeps it up to date. VS Code installs it from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=trevin-lee.cobrowser); Cursor, VSCodium and other editors from [Open VSX](https://open-vsx.org/extension/trevin-lee/cobrowser). Both list the macOS builds only.

Each release's `.vsix` is also on [GitHub](https://github.com/trevin-lee/cobrowser/releases/latest), for installing by hand: `cobrowser-darwin-arm64-<version>.vsix` on Apple silicon, `cobrowser-darwin-x64-<version>.vsix` on Intel, with `code --install-extension <file>` or the **Extensions: Install from VSIX…** command.

After installing, run **Cobrowser: Open Browser** from the Command Palette. After an update, restart extensions when the editor offers to (or reload the window); the browser app and the daemon replace themselves with the new version, and windows still on the old one keep working with them.

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

Every tab is an editor tab in a dedicated pane, streamed from the app at up to 60 fps. On a browser tab's title bar, **+** opens a new tab; on any other editor, the cobrowser logo (**Cobrowser: Open Browser**) brings back the browser tab you used last; when the browser is not running it starts it, with the tabs you had or one blank tab. The address bar takes an address or words to search; `localhost`, IP addresses and `name:port` load over http, as development servers expect, and a page that cannot load says why. The **Cobrowser** icon in the Activity Bar lists this workspace's tabs (a filled dot marks the one the agent is working in); clicking one shows it. There is no OS window to show — the page is rendered offscreen — so prompts that need one (an extension's toolbar popup) cannot appear. Passkeys fail fast to a password by default (`cobrowser.autoFallbackPasskeys`) until you enable them.

### How it identifies itself

Cobrowser says what it is. The user agent is the standard reduced Chromium UA with a `Cobrowser/<version>` token where Edge and Opera put theirs, the client hints name Chromium and Cobrowser (never Google Chrome), Accept-Language comes from your macOS language list, and the page's `screen` is the real display the pane sits on rather than a fake screen the size of the viewport. Sites asking for a permission (camera, location, notifications, clipboard read) get a native Allow/Block dialog, remembered per site in that workspace only; until you answer, they have nothing. **Cobrowser: Site Permissions for This Workspace** lists what you allowed and blocked, and forgets the ones you pick, so those sites ask again. `navigator.webdriver` reads false, as it does in any Electron app: nothing is overridden, the process is simply not launched with a debugging port. The agent can read the page's console and request log (`list_console_messages`, `list_network_requests`); a DevTools window is refused because it would take the tab's debugger session away from the app. A native `<select>` cannot drop down in an offscreen page, so a click on one opens a macOS menu at the cursor and the choice is applied to the page; the agent's `fill` picks an option by its visible text. Cross-origin iframes (video players, embedded tools, sign-in widgets) run in their own renderer process, which offscreen input does not reach through the page, so the app attaches to each one and delivers your clicks, scrolling and typing to it directly.

### The vault

The app keeps a local vault (encrypted through the OS keychain, unlocked with Touch ID or your Mac's password) that the agent fills from without ever seeing a password: `list_credentials` shows the sites and usernames this workspace may use, `fill_credentials` types a login into the fields the agent picked, and the app checks the page is really on that site first. The **vault window** (**Cobrowser: Open Vault**, or **Vault…** in the menu-bar icon) has two views, **Logins** and **Cards**. In **Logins** you add, edit and remove logins, and choose for each the workspaces that may use it, or all. **Edit** changes a login's websites, username, password, notes or workspaces (a blank password keeps the saved one). **Websites** is a list: a login fills on each site in it, for a sign-in that moves between sites (a Microsoft account asks for its email on microsoftonline.com and its password on live.com), and each is matched as strictly as any other, so `live.com` never fills on `evil-live.com`. **Notes** are Markdown, for you and for agents (which account this is, how 2FA works): the window shows them formatted, `list_credentials` hands them to agents, and exports carry them in the note column other password managers show. Adding a login that already exists says so before you save, and fills in the workspaces it has now, so saving replaces the password and changes the workspaces only if you do. The editor has shortcuts too: **Cobrowser: Add Login to Vault** (a login added again this way keeps its workspaces and gains this one) and **Cobrowser: Import Logins from CSV** (or **Import CSV…** in the window), which says how many logins were new and how many it replaced; a login it replaces keeps its workspaces and gains the import's.

Every vault check is Touch ID, or your Mac's password when Touch ID is out of reach (a closed lid, a desktop without Apple's Touch ID keyboard), from the same macOS prompt Safari uses before it shows a password. Unlocking asks once per app session; every change, and every time a password is shown or exported, asks again. The one exception is your answer to an agent's request for a login (below): **Allow in this workspace** in that dialog is itself the confirmation. **Export CSV…** in the Logins view, or **Cobrowser: Export Logins to CSV**, writes every login to a CSV other password managers import. Each login's note records the workspaces it may be used in (and its other websites), on lines of its own at the end, so importing the file back into cobrowser restores them; a login already in the vault takes the file's password, and its notes if the file has some. In the Cards view, **Export CSV…** writes every card to a CSV of cobrowser's own (password managers have no common format for cards), which **Import CSV…** there reads back; a card already saved is updated, never doubled. Either file is plain text: keep it somewhere safe, or delete it once it is imported. When iCloud syncs your Desktop and Documents folders, the save dialog says so, since a file saved there is uploaded. A password copied with **Copy** in the vault window is cleared from the clipboard after 90 seconds, unless you have copied something else since. **Cobrowser: Lock Vault** (or **Lock** in the window or the menu-bar icon) locks the vault until it is next needed; an open vault window shows it locked at once, and shows any change made elsewhere (an agent's grant, a login added from the editor) as it happens.

**Cards.** The vault's **Cards** view holds payment cards: label, name, number, expiry, security code and notes, all encrypted with the rest of the vault; lists only ever show the brand and last four digits. **Cobrowser: Fill Card** (or the card button on a browser tab) fills one into the checkout page in front of you, and an agent can ask to with `fill_card`. Cards are added, edited, imported and exported only in the vault window, never through an editor command, so a card number is typed into cobrowser's own window and never into the editor. Every fill, yours or the agent's, asks you first with Touch ID or your Mac password (once: when the vault is locked, unlocking it for the fill is that confirmation), so cards have no per-workspace scope, and a card's notes are read by the agent in every workspace. A saved security code can be removed again (Edit), and is then typed at checkout. The fields are found in the page and inside the payment provider's own frames (Stripe and the like), and only visible fields are filled: a hidden card field, the classic autofill theft, is left alone. Filling is not paying: the agent still does not click the pay button unless you tell it to.

When an agent needs a login its workspace is not scoped for, it calls `request_credential` with the site and a one-line reason. You get a native dialog naming the workspace and the login: **Allow in this workspace** adds the workspace to the login's scope (untick it in the vault window to take it back), **Allow once** permits one sign-in, **Deny** does nothing. A one-time grant lasts until the password is filled, so a sign-in that asks for the email on one page and the password on the next gets both, and lapses after ten minutes, or when the vault is locked, if it is not used. With several logins for the site, you pick one of the first three, and it is allowed once unless you tick **Allow in this workspace from now on**; a fourth or later login for the same site is given to a workspace in the vault window instead. The agent only learns the outcome, and a denial reads the same as there being no such login (only the wait for your answer differs), so a workspace's agent still cannot enumerate what others hold. That boundary holds for agents scoped to a workspace (Claude Code, VS Code's agent). An unscoped client (Cursor, or one added with Connect Another Agent) names a workspace in each call, so it reaches every workspace's browser and logins: connect those only if you would trust them with all of it.

### Popups, dialogs, uploads and downloads

Tabs are hidden offscreen windows, so everything a page would normally show in a window of its own is handled by the app instead:

- **Sign-in and payment popups** (`window.open` with a size, as "Sign in with Google" uses) open as a real small window on your desktop, as in Chrome, keep `window.opener` so they can report back, and close themselves. Links that open a new tab stay editor tabs.
- **alert, confirm and prompt** show as app dialogs; the page waits for your answer, as it would in Chrome. **"Leave this site?"** prompts are asked the same way.
- **File uploads** use the app's file picker, including inside cross-site iframes. The agent can attach files itself with `upload_file` (a résumé to a job application): it names the files and the button or file input, and you confirm them in a dialog naming the site before anything is attached. To skip the dialog in one workspace, turn on **Cobrowser: Uploads Without Asking** in that workspace's settings (Workspace settings only, never User; ignored in an untrusted workspace); each upload then shows a notification naming the files and the site instead. Hidden files and folders, `~/Library` (apart from iCloud Drive and cloud-storage folders) and cobrowser's own data are refused whatever you answer.
- **Dropdowns, date, time and color fields** open their picker as a macOS menu or a small window of the app's own at the cursor, and your choice goes back into the page. The agent's `fill` sets them directly.
- **Downloads** save straight to your Downloads folder (never overwriting), with a notification that opens the file in Finder.
- **Fullscreen** (a video player's button) fills the tab, with the panel's toolbar hidden; Escape leaves it. Nothing takes over your display.
- **A self-signed certificate** (a router or a device on your network) gets Chrome's question: proceed anyway, remembered for that host in that workspace until the app quits.
- **A password asked for by the browser itself** (HTTP basic auth) gets a small sign-in window.
- **A crashed page** reloads by itself, up to three times in a minute; a fourth crash leaves it as it is, for you to reload (⌘R).
- **Tabs no panel is showing** draw 4 times a second instead of 60, and at full rate again the moment anything acts on them.

If the agent's action opens a dialog or a file picker, it is shown to you, and the agent's action waits for your answer (unless it is `upload_file`'s own picker, whose files you already confirmed).

### The app

The browser runs as a menu-bar app named cobrowser, with its own icon. The Electron it downloads is renamed `cobrowser.app` and given the name, bundle id and icon once, before its first start, then re-sealed: with your identity when it is signed for passkeys, ad hoc otherwise. It is marked menu-bar-only, so it never appears in the Dock or the app switcher. Its icon, like every cobrowser icon (the store's, the editor's, the menu bar's, the bridge extensions'), is drawn by `scripts/make-icon.js` from one mark: two square panes, one over the other's corner, and where they meet, the space you share with the agent, in cobalt. Cobalt is also the colour of what concerns the agent: its highlight in a tab, the frame the bridge draws on tabs in your own browser, and selection and the agent's switches in the vault. **`cobrowser.accentColor`** changes it (any `#rrggbb`), everywhere at once; the logo keeps its own colours.

The menu-bar icon shows cobrowser's version, each workspace and its tab count, and whether the vault is locked, with **Vault…**, **Lock Vault** (while it is unlocked) and **Quit cobrowser**. Quitting closes every workspace's tabs; the next panel or tool call starts it again, and each editor window reopens the tabs it had, each still the agent's or yours. **Cobrowser: Restart Browser** does the same for this workspace alone: its tabs close and reopen, and other workspaces are untouched.

In a panel, the usual browser keys work: ⌘T new tab, ⌘W close, ⌘R reload, ⌘L the address bar, ⌘[ and ⌘] back and forward, ⌘+, ⌘− and ⌘0 zoom (remembered per site, in each workspace), and the edit keys: ⌘C, ⌘X and ⌘V (through your Mac's clipboard), ⌘A, ⌘Z and ⌘⇧Z. ⌥← and ⌥→ are left to the text you are typing, as everywhere on a Mac.

Each workspace's browser keeps its own cookies, sign-ins, site data and permissions. **Cobrowser: Clear Browsing Data for This Workspace** signs it out of everything (open tabs stay open; the vault and permissions are kept). **Cobrowser: Forget Another Workspace's Browser** deletes another workspace's tabs, browsing data and permissions, for a project you are done with; its logins stay in the vault.

### Passkeys

Run **Cobrowser: Enable Passkeys (Sign the Browser)** once. Chromium's Touch ID authenticator only works in an app signed with a `keychain-access-groups` entitlement, and Apple only grants that entitlement through a provisioning profile, so the command re-signs the downloaded browser with your Apple Development identity and an app identifier you choose. It builds a stub Xcode project and lets `xcodebuild -allowProvisioningUpdates` mint the profile, which needs Xcode with an Apple ID signed in (Xcode → Settings → Accounts). After that the Touch ID sheet is a system dialog, so it appears even though the page renders offscreen; passkeys are created inside cobrowser (add one from a site's security settings after a password sign-in) and live in this Mac's Secure Enclave keychain — they do not sync, and existing iCloud Keychain passkeys are not visible here, because Apple grants that only to real browsers. USB security keys work too. The browser restarts signed the next time a panel opens. A Developer ID certificate is used instead when present.

Enable Passkeys asks which of your teams signs it and for an app identifier the team can register (an identifier belongs to the first team that registers it, so a second team needs its own, such as `com.yourcompany.cobrowser`). A free personal team's provisioning profile lasts 7 days; a paid team's lasts a year, so prefer one if you have it. Past expiry macOS refuses to start the signed browser, so before each start the extension checks: an expired signature is renewed with the same team and identifier, and if that fails the browser is signed ad hoc again, so it always starts, passkeys fall back to passwords (while `cobrowser.autoFallbackPasskeys` is on, the default), and a notification says to run Enable Passkeys. Passkeys belong to the keychain group of the team that signed the browser, so switching teams leaves earlier ones behind.

**Cobrowser: Turn Off Passkeys** signs the browser again as it was downloaded; passkeys already saved stay in your keychain and work again if you re-enable with the same team and identifier. While passkeys are off and `cobrowser.autoFallbackPasskeys` is on (the default), a site's passkey prompt fails at once, both for signing in and for creating one, so it falls back to its password form and never records a passkey nobody holds.

## Your own Chrome or Firefox

The panel is where the agent works best, but sometimes the work is already open in your own browser, signed in. The **bridge** is a small browser extension that lets the agent reach it: the `bridge_*` tools (`bridge_list_tabs`, `bridge_new_tab`, `bridge_close_tab`, `bridge_activate_tab`, `bridge_navigate`, `bridge_read_page`, `bridge_snapshot`, `bridge_click`, `bridge_fill`, `bridge_wait_for`, `bridge_query`, `bridge_evaluate_script` (Firefox only; Chrome runs no code sent to an extension, so reads go through `bridge_query`), `bridge_fetch`, `bridge_screenshot`, `bridge_list_containers`). They are named after the panel's tools, but their parameters are their own, and each tool's description lists them: a tab is a numeric `tabId` from `bridge_list_tabs` (not a `pageId`), `bridge_new_tab` takes `active` (a new tab comes to the front unless it is `false`) where `new_page` takes `background`, `bridge_fill` takes a list of `elements` as `fill_form` does, and reading and screenshots have fewer options. They follow the same rules on payment buttons, secret fields and your tabs; there are no owners, so agents working in parallel keep to their own `tabId`s. Every agent sees them; in a workspace that is not bound yet, a call says how you bind it, so binding works for an agent that is already running.

A workspace is bound to one scope: one **Chrome tab group** by its name (or `profile`, the whole Chrome profile), or one **Firefox container** (or `default`, the tabs in no container), never both. The extension refuses anything outside it. A tab group limits what the agent can reach, not what the browser knows: every Chrome tab shares the profile's logins. Chrome closes a tab group with its last tab; the agent's next new tab starts it again, under the same name. Run the bind command again to change the scope; **Cobrowser: Unbind Your Own Browser** ends the binding, whichever browser it is. A window needs a folder to be bound.

**Chrome.** Run **Cobrowser: Install Chrome Bridge Extension**: it copies the extension to `~/.cobrowser/chrome-extension` and copies that path. In `chrome://extensions`, turn on Developer mode, click **Load unpacked** and choose the folder. Then run **Cobrowser: Bind Chrome Tab Group to This Workspace**, and paste the URL from **Cobrowser: Copy Bridge URL** into the extension's toolbar popup. Updating cobrowser updates that folder; Chrome loads the new version when it restarts, or at once with the extension's reload button. The folder is hidden in Finder: in the **Load unpacked** dialog, press ⌘⇧G and paste the path.

**Firefox** (and forks with containers: Zen, LibreWolf, Floorp, Waterfox). Download `cobrowser-bridge-firefox-<version>.xpi` from the [latest release](https://github.com/trevin-lee/cobrowser/releases/latest) and install it from `about:addons` → gear → **Install Add-on From File…**. It is signed by Mozilla (unlisted), and Firefox updates it by itself after each release. Then run **Cobrowser: Bind Firefox Container to This Workspace** and pick a container (or type the name of one the list does not show); the extension finds the workspace by itself, and if it does not, paste the URL from **Cobrowser: Copy Bridge URL** into its toolbar popup. Details in [firefox-extension/README.md](firefox-extension/README.md).

What to expect:

- **Input is synthetic.** No extension can send real clicks or keystrokes, and some sites ignore synthetic ones. A click that changed nothing on the page comes back saying so, and the agent moves that step to the panel.
- **It goes at a hand's pace.** Everything that reaches a site waits 1 to 3 seconds and stops at 100 requests in a browser session, counted across every workspace bound to that browser, and when a site refuses `bridge_fetch` or answers it with a challenge, everything pauses for a minute. The count and a **Reset** button are in the extension's toolbar popup; only you can reset it.
- **It tidies up after itself.** `bridge_list_tabs` marks the tabs the agent opened, and `bridge_close_tab` closes those; one of yours only when you ask (the agent passes `allowHumanTab`), as in the panel.
- **It is released with cobrowser.** The extension carries cobrowser's version; when it is older, `bridge_list_tabs` and the errors say so and how to update it. A newer one (Firefox updates it on its own) is fine.
- **Changing `cobrowser.port`** changes the bridge URL: paste the new one into the Chrome extension's popup.
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

`list_pages`, `new_page`, `select_page`, `close_page`, `navigate_page`, `read_page`, `take_snapshot`, `take_screenshot`, `click`, `fill`, `fill_form`, `type_text`, `upload_file`, `wait_for`, `evaluate_script`, `list_console_messages`, `list_network_requests`, `list_credentials`, `fill_credentials`, `fill_card`, `request_credential`, `get_activity`, `get_editor_layout`, `list_workspaces` (the open workspaces, or the one a scoped session is bound to), and the `bridge_*` tools for your own browser ([above](#your-own-chrome-or-firefox)).

**Agents in parallel.** Several agents, or one agent's subagents, can work in the same workspace's browser at once: actions on different tabs run in parallel. Each opens its own tab with `new_page` and an `owner` name for its task, then passes that tab's `pageId` to every tool. Once any tab has an owner, a call without `pageId` is refused instead of landing in whichever tab is current (a call does not say which agent sent it, so an agent without an owner and one named subagent could otherwise act in each other's tabs), `close_page` refuses another owner's tab, and a popup from an agent's tab belongs to that agent. A `pageId` is never reused in a workspace, even after a reload or **Restart Browser**, so an old one gets "no such page" rather than someone else's tab, and restored tabs keep their owners. Every agent is told this, and the rest of cobrowser's house rules, when it connects (the MCP server's instructions). Owners are names the agents agree to use, not identities: MCP does not say which agent is calling, so this keeps cooperating agents out of each other's tabs, and does not fence off one that ignores the rules.

`wait_for` waits for any of the texts it is given, and says which one appeared, so one call covers "Saved" or "Error". `close_page` closes the tabs the agent opened; one of yours only when you asked it to (the agent passes `allowHumanTab`), and never the last one.

Every page tool takes an optional `pageId`, and the agents and the human each have their own current tab (every agent in a workspace shares one, which is why agents in parallel pass `pageId`). Tabs are independent offscreen windows, so the agent can work in a background tab while you read another: switching tabs in your editor never retargets the agent, and the agent switching tabs (`select_page`) never moves your view unless it passes `bringToFront`. `list_pages` reports both (`selected` is the agent's tab, `humanViewing` yours), actions on different tabs run in parallel while actions on one tab stay in order, and the app remembers which tabs the agent opened, so they stay the agent's to tidy up across reloads.

`get_editor_layout` tells the agent how your editor is arranged, including the names of the files you have open, so it can place a tab beside your work.

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

1. Run **Cobrowser: Open Browser** (Command Palette) — the app starts (from `app/node_modules` in a checkout, no download) and a tab streams into the panel.
2. Navigate + **log into** the sites you want the agent to use. Credentials persist in the workspace's profile.
3. Point your agent at the MCP server (auto-registered per the table above) and drive the same tabs.

The app's source is `app/main.js`, bundled to `dist/app/main.js` by the build; the installed extension runs that bundle with a downloaded Electron, a checkout runs it with the one in `app/node_modules`.

Scripts: `npm run watch` (rebuild on change), `npm run typecheck`.

### Releasing

`npm run release` bumps the version in `package.json` and both add-on manifests (they always match) and installs the build into your editors. Add the version's entry to `CHANGELOG.md`, commit, then tag and push: `git tag vX.Y.Z && git push origin main vX.Y.Z`. The Release workflow checks that the versions match the tag and builds the macOS packages into a draft release, with the CHANGELOG entry as its notes. It attaches the Firefox add-on, signed by Mozilla, with its `firefox-updates.json`, and only then publishes the release as the latest, so installed add-ons always find their update file; the macOS packages then go to the Visual Studio Marketplace and Open VSX. Firefox signing needs the `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` repository secrets ([firefox-extension/README.md](firefox-extension/README.md#signing)), Open VSX an `OVSX_PAT` access token for the `trevin-lee` namespace. The Marketplace needs no secret: GitHub Actions signs in to Microsoft through OIDC as a managed identity that is a member of the `trevin-lee` publisher (the `marketplace` environment and the `AZURE_*` repository variables; see `.github/workflows/publish-extension.yml`). Without the Mozilla secrets the release stops as a draft (run the workflow by hand with the tag once they are set, or with `allow_unsigned_firefox` to publish it with installed add-ons kept on the last signed version). A store without its credentials is skipped, noted in the run's summary; run the workflow by hand with the tag to fill it in.

## Design decisions worth knowing

- **Per-request MCP transport.** Stateless Streamable HTTP creates a fresh `McpServer` + transport per POST (a single shared instance would misroute concurrent clients).
- **Cursor-safe activation.** The VS Code-only MCP API is feature-detected.
- **Tabs belong to the app, not the socket.** A window's connection can drop (reload) without closing anything; the same workspace reconnecting adopts its tabs by the app's tab id. Another workspace never sees them.
- **Never uncap the frame rate.** Measured twice: `--disable-frame-rate-limit` multiplies CPU ~35x for no extra frames. `setFrameRate` alone reaches 120 fps at a tenth of a core.

## Limits

- **macOS only.** The pinned Electron is downloaded for macOS (arm64 and x64).
- **A browser per folder.** A window without a folder gets a panel, but no agent can reach its browser, VS Code's agent there gets no cobrowser tools, and it cannot be bound to your own browser. In a multi-root workspace, the first folder is the one agents reach.
- **The agent's tools stop at embedded frames.** A video player or widget embedded from another site is listed in `take_snapshot` as `[frame]`, and the agent hands it to you: your own clicks and typing reach inside it, the agent's do not.
- **No find in page.** ⌘F reaches the page, which can use it (some sites open their own search), but there is no browser find bar: an offscreen page has none.
- **No accessibility tree.** `take_snapshot` tags interactive DOM elements with `uid`s rather than walking the accessibility tree.
- **`evaluate_script` runs arbitrary JavaScript in the page.** It is the escape hatch, and it is not subject to the click and fill rule below.
- **Stateless MCP.** No resumable sessions; each request stands alone.
- **Your own browser gets synthetic input only.** No browser extension can send real clicks or keystrokes, and some sites (Google's and Cloudflare's consoles among them) ignore synthetic ones. The own-browser tools report a click that changed nothing and point the agent to the panel, where input is real.
- **The agent does not pay or type secrets on its own.** In both the panel and your own browser, it will not click a button that pays or places an order, or type a password, one-time code or card number, unless you tell it to (`allowPayment`, `allowCredentials`). In the panel, saved logins go in through `fill_credentials`, which never shows it the password; the vault does not reach your own browser, so there you sign in yourself.

## Security notes

Each workspace's browser profile holds live session cookies — treat it as credentials. Profiles live in the app's data folder (`~/Library/Application Support/cobrowser`), outside every repo. The vault is encrypted with a key in your login keychain and unlocks with Touch ID or your Mac's password; every change, and showing or exporting passwords, asks again every time, and a stored password is never sent back out to the editor or the agent: the vault types it only into a password field, which the page draws as dots, and removes it from page text and script results returned to the agent. That holds for an agent following the tools; one that runs its own script in the page can still read a field once it is filled. The daemon binds `127.0.0.1` only and is gated by tokens stored with owner-only permissions under `~/.cobrowser`: a daemon-wide one for unscoped clients (and the bridge extensions) and one per workspace for scoped sessions. Copies also sit in each agent's own config (`~/.claude.json`, and whatever you connect by hand), with that app's file permissions. Scoping keeps an agent to its own workspace through cobrowser's tools; an agent that can run commands as you can read these files too, so scoping guards against mistakes, not against an agent you would not trust on your Mac. It also rejects any request whose `Host` header is not a loopback address. No remote debugging port is ever opened, so no other process can attach to the browser. Seed each profile only with the accounts your automation needs; don't put high-value logins (primary email, bank) in an agent-driven browser.

**Cutting off the daemon-wide token.** Everything that holds it (Cursor's entry, an agent added with **Connect Another Agent**, a bridge URL pasted into Chrome) reaches every workspace's browser and logins. **Cobrowser: Replace Agent Token** replaces it: the old one stops working at once, connections made with it are closed, and Cursor's entry and the Firefox add-on get the new one by themselves. Then paste the new URL from **Cobrowser: Copy Bridge URL** into Chrome's bridge popup, if you use it, and run **Connect Another Agent** again for anything you connected by hand. The per-workspace tokens of Claude Code and VS Code's agent are not affected.

**Starting the vault over.** The vault is unreadable without its key, the **cobrowser Safe Storage** item in your login keychain. If that item is deleted, or the keychain refuses it, unlocking says the vault cannot be read with this Mac's keychain key, and the vault window offers **Start a new vault**: after you confirm, the old file is kept beside it as `vault-unreadable-<date>.bin` (never deleted, so a key that turns up again still opens it) and a new, empty vault takes its place. Import your last CSV export to fill it. If the key comes back (a keychain restored from a backup), quit cobrowser and rename the kept file back to `vault.bin` in place of the new one, whose logins are then gone.

## Uninstall

Quit the app (menu-bar icon → **Quit cobrowser**), then uninstall the extension from the Extensions view, or with `code --uninstall-extension trevin-lee.cobrowser` (`cursor`, `codium`). Once the editor restarts, cobrowser takes its entries out of Claude Code (every project) and Cursor; if another editor still has cobrowser, it adds each back when that folder is next opened there. Entries you added with Connect Another Agent are yours to remove from those apps. To keep your logins and cards, export them first (**Export CSV…** in the vault window's Logins and Cards views). What it leaves behind, all of which is safe to delete:

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
