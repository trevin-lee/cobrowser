# Cobrowser Bridge for Firefox

Works in Firefox and any fork with containers and managed storage: Zen, LibreWolf, Floorp,
Waterfox.

Lets cobrowser's agent reach **your own browser**: the tabs you already have open, already
signed in, in **one container** per editor workspace. The add-on refuses every call that
touches a tab outside that container.

## Why an extension

The usual ways to automate Firefox (`--remote-debugging-port`, WebDriver BiDi) only work if the
browser was started with them, so they cannot reach the browser you already have open, which
is the one with your sessions in it. An extension is simply there, in the profile.

## Install

Download `cobrowser-bridge-firefox-<version>.xpi` from the
[latest cobrowser release](https://github.com/trevin-lee/cobrowser/releases/latest), then in
Firefox: `about:addons` → gear → **Install Add-on From File…**

That is the only time you install it. The add-on carries cobrowser's version and checks the
latest release for a newer one (`update_url` in the manifest), so Firefox updates it by itself
within a day of each release, or at once with **Check for Updates** in the same menu. Until it
has, the agent is told the add-on is older than cobrowser.

Firefox installs only signed add-ons. Mozilla signs this one as **unlisted**: self-distributed,
never published on addons.mozilla.org, never publicly reviewed. The release workflow does it
for every tag (see *Signing* below).

### Signing

`.github/workflows/release.yml` signs the add-on when a release is tagged, using two repository
secrets from <https://addons.mozilla.org/developers/addon/api/key/>, created by the account that
owns the add-on: `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. Without them the release is made without
the Firefox add-on, and the run says so; add them and run the workflow by hand with the tag.
Mozilla signs each version once, so a version that is already on its release is left alone.

To sign on your own machine instead (a fork, or a test build), put the same two values in
`.env.amo` at the repo root and run `npm run sign:firefox`; it writes
`cobrowser-bridge-signed.xpi`. A version you sign locally cannot be signed again by the
workflow, so bump it first.

**Unsigned, for testing:** `cd firefox-extension && zip -r ../cobrowser-bridge.xpi .` installs
only where `xpinstall.signatures.required` is `false` in `about:config` (Zen and some forks honour
it; stock Firefox release does not). That turns off signature checks for every add-on in the
profile.

## Bind a workspace

In the editor, run **Cobrowser: Bind Firefox Container to This Workspace** and pick the
container (`default` is the tabs in no container; a container the list does not show, as in a
fork that keeps its profiles elsewhere, can be typed). That's all: cobrowser registers the workspace through Firefox's managed-storage
manifest (`~/Library/Application Support/Mozilla/ManagedStorage/`) and the add-on connects
within half a minute. Any number of
workspaces, each bound to its own container, share the one add-on. The toolbar badge shows how
many are connected.

If a workspace does not connect, run **Cobrowser: Copy Bridge URL** and paste it into the
add-on's toolbar popup under *Connect a workspace by hand*.

A workspace drives one browser at a time: binding a Firefox container replaces a Chrome tab
group binding, and the other way round. **Cobrowser: Unbind Your Own Browser** stops the
workspace's agent reaching your browser. A container deleted in Firefox is found again if you
make one with the same name; until then the agent is told it is gone.

## What the agent can do

`bridge_list_tabs`, `bridge_new_tab`, `bridge_close_tab`, `bridge_activate_tab`,
`bridge_navigate`, `bridge_read_page`, `bridge_snapshot`, `bridge_click`, `bridge_fill`,
`bridge_wait_for`, `bridge_query`, `bridge_evaluate_script`, `bridge_fetch`, `bridge_screenshot`,
`bridge_list_containers`.

Input is **synthetic** (`isTrusted: false`): no extension can send real input. Links, buttons
and form fields work; values are set through the native setter and followed by
`input`/`change`, so React and Vue notice them. File inputs, OS dialogs and pickers,
drag-and-drop, and sites that check event trust do not; a click that changed nothing comes back
saying so, and the agent moves that step to the cobrowser panel, where input is real.

`about:` pages and addons.mozilla.org cannot be scripted, so tabs there are listed but not
readable.

`bridge_query` is for collecting many things at once: fifty order links in one call rather
than fifty clicks (a CSS selector, and the fields to return for every match).
`bridge_evaluate_script` runs a function when a query is not enough, Firefox only. It runs in
the **isolated world** (the DOM, not the page's JavaScript); `world: "page"` reaches the site's
own globals and is logged. `bridge_fetch` makes
a **same-origin** request from a tab with that tab's cookies, for JSON APIs and downloads
behind a login. Cross-origin is refused.

## Pace, and what it will not do

Everything that reaches a site waits 1 to 3 seconds, stops at 100 requests in a browser
session, and pauses for a minute when a site answers `bridge_fetch` with 429 or 403 or a challenge. The
count, the pause and which tabs the agent opened are kept in memory: they start over when the
browser quits, and when Firefox updates or reloads the add-on. Hitting
the cap is a stop, not a retry: the agent is told to report back. The toolbar popup shows the
count and has a **Reset** button; only that page can reset it, not a script in a tab.

The agent will not, unless you tell it to:

- click a button that pays or places an order (`allowPayment`);
- type a password, one-time code, card number or security code (`allowCredentials`).

`bridge_close_tab` closes tabs the agent opened with `bridge_new_tab`, and one of yours only
when you asked (the agent passes `allowHumanTab`); `bridge_list_tabs`
marks them `openedBy: "agent"`.

## You can see what it touches

Every action that reaches a tab draws a marker on it: a frame with a label ("cobrowser:
clicked") and a ● before the tab title, so a tab driven in the background shows in the tab
strip too. Both clear after a couple of seconds and never intercept clicks. A screenshot's own
marker is drawn after the capture, but one left by an action in the couple of seconds before it
can show in the image.

## Scoping is enforced here, not by the browser

The add-on holds permission for every container in the profile: WebExtensions have no
per-container permissions. What keeps one workspace out of another's container is
`assertInScope()` in `background.js`, which checks each tab's `cookieStoreId` against the one
the workspace was bound to. That is a real boundary against an agent wandering, not against
malicious code in the add-on itself. It is about ten lines; read it before you trust it.

Each endpoint URL carries a token, and the add-on dials only this Mac (`127.0.0.1`,
`localhost`); it ignores any other address.
