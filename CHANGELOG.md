# Changelog

Release notes for earlier versions are on the [GitHub releases page](https://github.com/trevin-lee/cobrowser/releases).

## 0.9.25

### Changed

- **In Chrome, only `profile` binds the whole profile.** `default` used to mean it too, though in Firefox `default` is the tabs in no container, the narrowest scope. A Chrome workspace bound as `default` now gets a tab group of that name.

### Fixed

- **`bridge_fetch` works in Chrome again.** Since 0.9.11 every call failed, after counting against the request cap, so a site's refusal could never start the minute's pause in Chrome.
- **The agent cannot read a card number back after `fill_card`.** A number filled into a checkout form on the page itself showed in the agent's next snapshot or script result. Saved card numbers are now masked in everything the agent reads, and snapshots show card, code and one-time-code fields as (filled).
- **The bridge popups no longer show an unbound workspace as "Bound to Chrome" or "Bound to Firefox".**
- **Unbinding sticks** for a workspace whose binding once came from the retired `cobrowser.firefoxContainer` setting, which kept binding it again.
- **Firefox's bridge does not claim to keep its count, pause and agent tabs across an update**, which 0.9.24 said but could not do; they start over when the add-on updates. Chrome keeps them across its service-worker restarts.
- Cancelling the vault window's Unlock no longer shows a raw error.
- The README and tool descriptions now match the product: the bridge tools' parameters, the shared request cap, the menu-bar menu, the vault's one change without a second Touch ID, the three-login limit of a request, no find bar, and how to replace the daemon-wide token or start the vault over.

## 0.9.24

### Changed

- **Once any tab has an owner, every agent call must say which tab** (`pageId`). Before, that started at two owners, which let a main agent without an owner and one named subagent act in each other's tabs. Closing the tabs of finished tasks lifts it.
- **A site's zoom is remembered per workspace**, like its cookies and permissions. Zoom set before this keeps applying until you zoom the site in a workspace.

### Fixed

- **⌘X, ⌘Z and ⌘⇧Z work in the panel**, and ⌘C copies text selected in a field, not only on the page. The right-click menu has Cut.
- **⌘A then ⌘C copied the panel's address bar** instead of the page's text: VS Code's own Select All selected the panel itself. The panel now keeps no selection of its own outside the address bar.
- **A saved password is typed only into a password field**, never into a text field where a screenshot would show it.
- **The bridge refuses card fields marked only by their autocomplete type**, as the panel does.
- **A Chrome tab group that is closed when the bridge connects comes back** on the agent's next new tab, instead of the workspace refusing every call until the group is recreated.
- **The bridges keep the agent's tabs, the request count and the one-minute pause** when Firefox updates the add-on or Chrome restarts its service worker.
- **Bind Chrome Tab Group no longer unbinds Firefox** when its box is left empty.
- **The vault window says what an import or export did** even with nothing selected.
- **A mistake in a card (number, expiry, a card already saved) is reported before Touch ID**, not after.
- **`get_activity` credits the agent** for `type_text`, `evaluate_script` and `close_page`.
- **The extension package carries only what it uses**: 34 files instead of 72.
- Turn Off Passkeys and the README no longer promise a password fallback while `cobrowser.autoFallbackPasskeys` is off.

## 0.9.23

### Fixed

- **A crash or a full disk while the vault was being saved could leave it unreadable**, losing every login and card. The vault is now written whole to a temporary file and renamed into place, so the previous vault survives any failed save.
- **Pressing Escape after an import deleted the CSV.** The vault window's prompt now defaults to Keep, so Escape and Return keep the file, and choosing to remove it moves it to the Trash instead of deleting it outright. The editor's import command moves it to the Trash too.
- **`upload_file` could click a button that pays or places an order**, the one click the agent leaves to you. It now refuses such a button, as `click` does.
- **Uploads Without Asking was not read from a folder's own settings in a multi-root window**, and a value in User settings was ignored without a word. The first folder's settings now count, and a value in User settings brings a warning that says where to set it.
- **The agent was told that you always confirm uploads**, which is not so while Uploads Without Asking is on. It is now told both cases.

## 0.9.22

### Added

- **`upload_file`: the agent can attach files to a page**, such as a résumé and a cover letter to a job application. It names the files and either the file input (hidden ones too) or the button that opens the file picker, as on sites that hide the input behind an "Upload" button. You confirm the files and the site in a dialog first. Several files go in at once where the picker takes several. Paths are literal (no wildcards, no folders), and hidden files and folders, `~/Library` (apart from iCloud Drive and cloud-storage folders) and cobrowser's own data are refused whatever you answer. Files reach a page only through a picker: yours, or one whose files you confirmed.
- **`cobrowser.uploadsWithoutAsking`**: lets the agent upload in one workspace without the dialog. It is read from Workspace settings only, so it is never on everywhere at once, and ignored in an untrusted workspace. Each upload then shows a notification naming the files and the site, and the refused places stay refused.

### Fixed

- **An agent could see an older window's tools.** With several editor windows open, the daemon handed every agent the tool list of the first window, which after an update could still be running the previous build: new tools were missing, and parameters such as `pageId` on `click` could be too. Each agent now gets its own window's tools.

## 0.9.21

### Changed

- **The bridge's toolbar popup is redesigned**, in Chrome and Firefox: your workspaces first, each by its folder name with its container or tab group in the browser's own colour (or, in a few words, why it is not connected); the agent's request count as a meter, with Reset; the containers or tab groups you can bind to, as chips; and the bridge URL box folded away where the editor connects by itself. In cobrowser's colours, light or dark with the browser.

## 0.9.20

### Fixed

- **The Touch ID prompt showed a Terminal-like icon** instead of cobrowser's. The helper that asks macOS for Touch ID or your password is now an app of its own, with cobrowser's name and icon.

## 0.9.19

### Changed

- **A new mark and colours.** Two square panes, one over the other's corner, and where they meet, the space you share with the agent, in cobalt. Black, white and cobalt replace the blue and green throughout: the app, menu-bar, store and sidebar icons, the vault window (sharper corners, a white main button, each workspace in its own shade of cobalt), and the frame the bridge draws on tabs the agent touches. An installed browser takes the new icon once, the next time it starts.
- **The bridge extensions have an icon**, in the toolbar and in the extensions list, instead of the browser's generic one.

### Added

- **`cobrowser.accentColor`**: the colour of what concerns the agent (its highlight in a tab, the bridge's frame on tabs in your own browser, selection and the agent's switches in the vault). Cobalt by default; any `#rrggbb`, picked in the Settings editor, applies everywhere at once. The logo keeps its own colours.

## 0.9.18

### Added

- **A backup for cards.** In the vault's Cards view, **Export CSV…** writes every card to a CSV of cobrowser's own, and **Import CSV…** reads one back (it also reads files that name their columns card number, expiry and so on). A card already saved is updated, never doubled, and adding the same card twice is refused.
- **A saved security code can be removed** again (Edit → Remove the saved security code); it is then typed at checkout.
- **Firefox binding:** `default` (the tabs in no container) is offered, a container the list does not show can be typed, and LibreWolf, Floorp and Waterfox profiles are searched as well.

### Changed

- **"Allow once" is one sign-in.** It used to be spent by the first fill, so a sign-in that asks for the email on one page and the password on the next (Microsoft's, Google's) lost it halfway. It now lasts until the password is filled, and lapses after ten minutes, or when the vault is locked, if it is not used. Asking again while one is unused does not ask you twice.
- **An open vault window shows the vault as it is.** A grant from an agent's request, a login added from the editor and a Lock from the menu bar show at once, and changing a login's workspaces changes only the ones you touched: it never takes away a grant made since the window loaded.
- **⌥← and ⌥→ are left to text.** They were Back and Forward whenever a browser tab was the active editor, even while typing in a page's form or in a chat box, where they move by word.
- **A site's permission prompt** (camera, location, notifications) has **Not now**, and dismissing it with Escape no longer blocks the site for good; only Allow and Block are remembered.
- The bridge scopes are listed by the names the bind commands take (`profile`, a group's title), and a closed Chrome tab group is started again, under its name, by the agent's next new tab. A Firefox container deleted and made again is found by its name.
- A newer bridge add-on (Firefox updates it on its own) is no longer reported as out of date, and no longer loses tools.
- A tab's `pageId` is never reused in a workspace, even after a reload or **Restart Browser**, and restored tabs keep their owners.
- A window without a folder can no longer be "bound" to your own browser, and VS Code's agent there no longer gets the daemon-wide token: it has no workspace to work in.
- The menu-bar icon counts cards too, and its item is **Lock Vault**, as the command is.

### Fixed

- **A window still on the previous version swapped a newer browser app back to its own**, closing every workspace's tabs each time; it now uses the newer app. You no longer need to quit the editor after an update.
- **An export re-imported could lose a login's workspaces or websites** when its notes mentioned cobrowser's own marker words; only the note's last lines are read as cobrowser's now.
- **Enable Passkeys could leave a browser that would not start** when signing failed partway (a denied keychain prompt); it is now put back as it was. Without Xcode, it says so.
- The first download of the browser says plainly when there is no connection, and gives up on a stalled one after 30 seconds instead of spinning.
- Cancelling Touch ID in the vault window no longer shows raw error text, and a cancelled workspace change no longer looks saved. ↑ and ↓ follow the filtered list, and the Cards list in the Cards view.
- The sidebar and `list_pages` no longer wait for an agent's long action in the current tab.
- The bridge add-ons only dial this Mac, and say which browser a workspace is bound to when it is not theirs.

## 0.9.17

### Added

- **Notes on every login and card**, in Markdown: for you and for agents (which account this is, how 2FA works, what a card is for). The vault shows them formatted, `list_credentials` hands them to agents, and exports carry them in the note column other password managers show.

### Changed

- **One name for one window: the Vault.** It holds Logins and Cards as two views; the menu-bar item is **Vault…** and the command **Cobrowser: Open Vault** (it was Logins…, and Cards were behind it).
- **A login's websites are a list**: one row per site it fills on, each removable, and **Add website**, instead of a comma-separated "Also fills on" field.
- The vault window opens larger, sized to the screen, and its detail side scrolls, so a login's workspaces are always in reach. Import and Export moved to the header, so the Add button no longer wraps; the status counts what the current view holds.

## 0.9.16

### Added

- **Agents in parallel, safely.** `new_page` takes an `owner` name for the agent's task, and `list_pages` shows it. Once tabs belong to more than one owner, a tool called without `pageId` is refused (it lists the tabs) instead of acting in whichever tab is current, which could be another agent's; `close_page` closes only the caller's own owner's tabs; a popup from an agent's tab belongs to that agent. One agent on its own works as before.
- **Agents are told cobrowser's house rules when they connect** (MCP server instructions): panel first, read before snapshotting, tidy tabs, parallel work, logins and cards through the vault, and the console and network logs for a misbehaving page.

## 0.9.15

### Added

- **Card autofill.** Save cards in the Logins window's new Cards view (number, expiry, name and security code, encrypted in the vault). **Cobrowser: Fill Card**, or the card button on a browser tab, fills one into a checkout page, including the fields inside a payment provider's frames; an agent can ask to with the new `fill_card` tool, and `list_credentials` shows the saved cards by brand and last four digits. Every fill asks you first with Touch ID or your Mac password, the agent never sees the number, and only visible fields are filled, never hidden ones.

## 0.9.14

### Changed

- **A light icon on the store listings.** The Marketplace and Open VSX pages are white, and the dark icon read as a black square there; the listings now show the same mark on a light tile. The editor keeps the plain mark.

## 0.9.13

### Fixed

- **"Leave this site?" froze the whole app** until it was answered: every tab, and every agent call, including other workspaces'. It is now asked without blocking, and Leave carries on with the navigation.
- **A slow tool call dropped its editor window from the daemon.** The daemon gave up after 30 seconds (a heavy page such as the Azure portal takes longer) and then treated the window as gone until it registered again. Tool calls now get as long as the slowest tool needs, and only a window that has really gone is dropped.
- A closed tab's repaint timer could throw an error in the app.

### Changed

- Releases publish to the Visual Studio Marketplace without a stored token: GitHub Actions signs in to Microsoft through OIDC. Each release also carries the per-Mac packages the stores get.

## 0.9.12

### Added

- **A login can fill on several websites.** "Also fills on" in the Logins window lists other sites the same account signs in on, such as live.com for a Microsoft login saved from microsoftonline.com, whose password step happens there. Each is matched as strictly as the login's own site; `list_credentials` shows them to the agent, and exports carry them.
- **On the Visual Studio Marketplace.** VS Code installs and updates cobrowser from its Extensions view, like Cursor and VSCodium do from Open VSX. 0.9.11 was the first version there.

## 0.9.11

### Added

- **`bridge_query`**, the way to read many things at once in your own browser: a CSS selector and the fields to return (text, link, value, any attribute) for every match, in Chrome and Firefox.

### Fixed

- **`bridge_evaluate_script` never worked in Chrome.** Chrome refuses to run code sent to an extension, so every call failed with a security-policy error. The Chrome add-on no longer carries any code evaluation (the Chrome Web Store requires that too); a call there says to use `bridge_query`. Firefox keeps `bridge_evaluate_script`.
- Reading a page in your own browser right after another action returned the add-on's own activity label in the text and a "●" in the title.
- A new test suite runs the Chrome add-on in a real Chrome for Testing, which is how both of these were found.

## 0.9.10

### Fixed

- **The address bar** loads `localhost:3000`, IP addresses and `name:port` over http (development servers do not speak HTTPS, so these failed), searches when you type words, and a page that cannot load shows why instead of a blank tab.
- **An agent keeps its tools whatever order things start in.** One that connected before its folder's window was running, or while the daemon restarted after an update, saw only `list_workspaces` until it reconnected; it now gets every tool, and calls work once the window is up. Windows register again on their own when the daemon restarts.
- **Uninstalling takes cobrowser out of Claude Code (every project) and Cursor**, instead of leaving a failing server in each.
- **"Allow once" when a site has several logins.** Picking one allowed it in the workspace from then on; it is now once, unless you tick "Allow in this workspace from now on".
- **Exporting and importing logins back restores their workspaces exactly**; the workspaces chosen for the import apply to rows that did not come from cobrowser.

### Changed

- **VS Code's agent is scoped to its window's workspace**, like Claude Code: it drives that folder's browser and uses that folder's logins only.
- The README says plainly that unscoped clients (Cursor, and anything added with Connect Another Agent) reach every workspace, where the tokens are kept, and what a window without a folder, or a multi-root workspace, gets.

## 0.9.9

### Added

- **Cobrowser: Connect Another Agent** shows the entry for Claude Desktop, Codex, Windsurf or any other MCP client, to add to its config: the URL and cobrowser's token, and for Claude Desktop the `mcp-remote` bridge it needs.

### Changed

- **cobrowser registers with each agent through that agent's own interface** instead of editing its config files: Claude Code through its CLI (`claude mcp add`, per project), Cursor through its extension API. The files remain the fallback where those are missing.

### Fixed

- A workspace opened through a symlink got a Claude Code entry under a path Claude Code never looks up; entries are keyed by the folder's real path now.

## 0.9.8

### Changed

- **macOS only on Open VSX.** Releases remove any Open VSX package for a platform other than macOS, so no one is offered a build that cannot run. open-vsx.org cannot delete from the command line yet (it needs a newer registry), so until it can, a release warns about each one left, and 0.9.6's package for every platform is deleted from its Open VSX page by hand.

### Fixed

- cobrowser created `~/.cursor/mcp.json` on Macs without Cursor; it now writes Cursor's entry only where Cursor has been run.
- The development host gave Cursor the installed daemon's token instead of its own.

## 0.9.7

### Added

- **Touch ID or your Mac's password** for every vault check, from the same macOS prompt Safari uses before it shows a password. A Mac whose Touch ID is out of reach (lid closed, a desktop without Apple's Touch ID keyboard) can now show and export passwords, and no longer falls back to a plain Allow button.
- **Cobrowser: Manage Logins** opens the Logins window from the editor.
- Exported logins keep the workspaces each may be used in (in the CSV's note column), so importing the file back restores them.
- Clicking a tab in the sidebar shows it, and the sidebar says how to start a browser when none is running.

### Changed

- **One rule for closing tabs,** in the panel and in your own browser: the agent closes the tabs it opened, and one of yours only when you asked (`allowHumanTab`). Closing a tab that does not exist is an error instead of "closed".
- **`wait_for` waits for any of its texts**, in both tool families, and says which one appeared.
- The own-browser tools are always listed, so an agent that is already running can use them once you bind; in an unbound workspace, a call says how to bind.
- Adding a login that already exists, in the Logins window, starts from the workspaces it has now.
- Open VSX gets macOS builds only (Apple silicon and Intel), so no other platform is offered one it cannot run.
- The development host (F5) runs its own browser app, profiles and vault, so it no longer restarts yours.
- The `cobrowser.firefoxContainer` setting is gone; a value set there becomes the workspace's Firefox binding once. Settings are read when used, and say when they take effect.
- Back, Forward, Reload Tab and Close Browser Tab appear in the Command Palette only while a browser tab is focused.

### Fixed

- Forgetting another workspace's browser now also drops the tabs that workspace's editor had saved, and the Logins window shows forgotten workspaces on logins that still list them, so they can be removed.

## 0.9.6

### Changed

- **On Open VSX.** Cursor, VSCodium and other editors that use Open VSX can install cobrowser from their Extensions view, and keep it up to date. VS Code still installs the `.vsix` from the release.
- **The Firefox add-on is released with cobrowser.** Each release carries it signed by Mozilla, as `cobrowser-bridge-firefox-<version>.xpi`, built by the release workflow. It no longer needs Mozilla API keys on your machine.
- **Firefox keeps the add-on up to date.** Once this version is installed, Firefox finds and installs each new release by itself.

## 0.9.5

### Added

- **Edit a saved login** in the Logins window: its site, username, password or workspaces (a blank password keeps the saved one).
- **Site permissions per workspace.** Each workspace's browser keeps its own permission choices and certificate exceptions. **Cobrowser: Site Permissions for This Workspace** lists them and forgets the ones you pick. Choices you made before carry over into every workspace.
- **Cobrowser: Clear Browsing Data for This Workspace** signs that browser out of every site, and **Cobrowser: Forget Another Workspace's Browser** deletes a finished project's tabs, browsing data and permissions.
- **Your own browser, completed:**
  - The bridge tools take the panel tools' words (`uid`, `function`/`args`, `timeout`, `elements`) and can go back, forward and reload.
  - `bridge_close_tab` closes the tabs the agent opened, and only those; `bridge_list_tabs` marks them.
  - The extensions carry cobrowser's version, and the agent is told when yours is out of date and how to update it.
  - **Cobrowser: Install Chrome Bridge Extension** puts the Chrome extension in a folder that survives updates and is refreshed by them. Each release carries it as a zip.
  - The extension's toolbar popup shows the request count, with a Reset that only you can press.
  - Waits can watch for any of several texts; an async script's result is awaited.
- An Uninstall section in the README, listing everything cobrowser leaves on disk.

### Changed

- Every change to the vault (add, edit, remove, workspaces, import) asks for Touch ID again, or for a click when Touch ID is unavailable.
- Adding a login that already exists warns before saving and replaces it, instead of silently overwriting. Added again with the Add Login command or an import, it keeps its workspaces and gains the new one; in the Logins window you set them yourself. An import reports how many logins were new and how many it replaced.
- Navigating and opening tabs in your own browser are paced like every other call. In Chrome the request count now survives the extension's background worker restarting.
- The Bind commands say when binding one browser replaces the other.
- The vault commands no longer open this workspace's browser to run, and Lock Vault says when the app is not running.

### Fixed

- A site you allowed a permission (notifications, location) still read as denied to the page. The saved choice now applies.
- With passkeys off, a site could create a passkey nobody holds; creating one now fails at once, as signing in with one did.
- Tabs the agent opened became yours after the app restarted; they stay the agent's to tidy up.
- The Bind commands appeared as "Cobrowser: Cobrowser: …" in the command palette.
- The README said `fill_credentials` works in your own browser; it works in the panel only.

## 0.9.4

### Added

- **The agent can tell when a click did nothing.** In both the panel and your own browser, a click after which nothing on the page changed (no DOM change, no URL change, no form field changed) is reported, and in your own browser the report points the agent to the panel, where input is real.
- **A settle wait**, in both: wait until the page has stopped changing, so a single-page app is read once it has finished updating.

### Fixed

- Radios and checkboxes a page draws over hidden inputs are listed as their visible label, with their checked state, in both snapshots, so the agent clicks what a person would; ARIA radios, checkboxes, tabs and options are listed in your own browser too.
- Your own browser's snapshot returned what was typed in a password field; it now shows only that the field is filled.
- Two copies of the browser app, and two menu-bar icons, could still appear when editor windows started it at the same moment: Electron's single-instance lock sometimes let both through. A lock file of the app's own now lets exactly one start (20 of 20 three-way races), and a crashed app's leftover lock does not block the next start.
- The own-browser tools say what they cannot do (real clicks, real keystrokes) and to use the panel for it.

## 0.9.3

### Changed

- **One rule for what the agent does not do on its own**, in the panel and in your own browser alike: it does not click a button that pays or places an order, or type a password, one-time code or card number, unless you tell it to (`allowPayment`, `allowCredentials`); saved logins go in through `fill_credentials`. The panel's tools did neither before. The own-browser tools also refused sign-out and delete-account controls, which was never part of the rule, and no longer do.
- Snapshots list embedded frames (a video player or widget from another site) as out of the agent's reach, so it hands them to you instead of taking the page for empty.

### Added

- Export logins to CSV, from the Logins window or **Cobrowser: Export Logins to CSV**, with Touch ID each time. Devices on your network export as `http://`, sites as `https://`.
- **Cobrowser: Turn Off Passkeys.**
- Date, time and color fields open a picker when you click them, as dropdowns do; the agent's `fill` sets them directly.

### Fixed

- The README describes the product as it is: install, how agents connect, limits, security.
- Command names are consistent, and the deprecated `cobrowser.zenContainer` setting is gone.
- The Firefox add-on's messages name the tools as they are called now.

## 0.9.2

### Fixed

- A passkey-signed browser no longer stops starting when its provisioning profile expires (after 7 days on a free Apple team). Before each start an expired signature is renewed with the same team, and if that fails the browser starts unsigned with passkeys falling back to passwords. Enable Passkeys now asks which team signs and with what identifier, preferring paid teams, whose profiles last a year.
- Browser tabs no longer grow as wide as their page title. A title is cut at 30 characters with an ellipsis, as a browser tab is (`cobrowser.tabTitleMaxLength`, 0 for no limit); hovering the address bar or the sidebar row shows it in full, and a blank tab reads "New Tab".
- Quitting the browser app (from the menu bar, or when an update or renewal restarts it) no longer wipes the saved tabs of every open editor window: the app announces the quit, and the tab closes that follow are no longer taken for yours.
- A screenshot of, or the first action on, a tab no panel is showing waits at most a quarter of a second for its next frame, not up to a second: hidden tabs draw 4 times a second instead of once.

## 0.9.1

### Fixed

- A page going fullscreen (a video player's button) no longer takes over the whole display for a window that is not even on screen; it fills the tab, the toolbar hides, and Escape leaves it.
- A self-signed certificate asks whether to proceed, as Chrome does, instead of failing with no way past.
- A password asked for by the browser itself (HTTP basic auth, common on router pages) gets a sign-in window instead of a 401 page.

### Changed

- The end-to-end test suites live in the repo (`npm run test:e2e`).

## 0.9.0

The browser app now drives its own tabs. The extension no longer opens a Chromium debugging port or uses puppeteer: every page command runs on the tab's in-process debugger, over the socket the editor already holds.

### Added

- **Agents work in any tab.** Every page tool takes an optional `pageId`, and the agent and the human each have their own current tab: switching tabs in the editor never retargets the agent, and the agent never moves the human's view unless it asks to. Actions on different tabs run in parallel.
- **`read_page`** reads a page's visible text cheaply. `take_snapshot` gains filters (region, text, role, labelled only, limit), shows link destinations, input values and select options, and walks open shadow roots. Element uids stay valid for as long as the element exists.
- **`list_console_messages` and `list_network_requests`**: the page's console output, uncaught exceptions and request log with status codes, for debugging sites that misbehave.
- **`request_credential`**: the agent can ask for a saved login its workspace is not scoped for; the human allows it for the workspace, once, or denies it.
- **Passkeys** through Touch ID, after running *Cobrowser: Enable Passkeys*, which signs the browser with your Apple identity.
- **An identity of its own**: the browser says it is Chromium-based Cobrowser, reports the real display it is on, and asks before granting site permissions. It is named cobrowser, has its own icon, and never appears in the Dock.
- Browser keyboard shortcuts in the panel (new tab, close, reload, back, forward), crisper frames (native 2x rendering), and a working clipboard.
- Tabs remember who opened them, and the tool descriptions tell agents to reuse and close their own.

### Fixed

- Sign-in and payment popups keep `window.opener`, so they can report back; they open as real windows, as in Chrome.
- `alert`, `confirm`, `prompt`, file uploads and downloads no longer pull a blank window onto the desktop or freeze the tab; downloads go straight to Downloads.
- Clicks, typing and scrolling reach cross-origin iframes (embedded players, course tools).
- Native `<select>` dropdowns open, as the same macOS menu Chrome uses.
- Links that open a new tab work; a crashed page reloads by itself.
- Tabs no panel shows draw once a second instead of 60 times (three hidden animated tabs: 24% of a core down to 1%).
- Only one copy of the app can run, and an updated app restarts in place.
