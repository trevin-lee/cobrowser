# Changelog

Release notes for earlier versions are on the [GitHub releases page](https://github.com/trevin-lee/cobrowser/releases).

## Unreleased

### Fixed

- A passkey-signed browser no longer stops starting when its provisioning profile expires (after 7 days on a free Apple team). Before each start an expired signature is renewed with the same team, and if that fails the browser starts unsigned with passkeys falling back to passwords. Enable Passkeys now asks which team signs and with what identifier, preferring paid teams, whose profiles last a year.
- Browser tabs no longer grow as wide as their page title.
- Quitting the browser app (from the menu bar, or when an update or renewal restarts it) no longer wipes the saved tabs of every open editor window: the app announces the quit, and the tab closes that follow are no longer taken for yours. A title is cut at 30 characters with an ellipsis, as a browser tab is (`cobrowser.tabTitleMaxLength`, 0 for no limit); hovering the address bar or the sidebar row shows it in full, and a blank tab reads "New Tab".

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
