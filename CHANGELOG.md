# Changelog

Release notes for earlier versions are on the [GitHub releases page](https://github.com/trevin-lee/cobrowser/releases).

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
