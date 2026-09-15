# Cobrowser Bridge (Firefox extension)

Works in Firefox and any fork with containers and managed storage — Zen, LibreWolf, Floorp,
Waterfox. It was developed against Zen, which is why the notes below cite Zen specifics.

Lets Cobrowser drive **your own browser** — the tabs you already have open, already signed
in — instead of a separate automation browser. Each editor workspace is bound to exactly
one container, and this extension refuses every call that touches a tab outside it.

## Why this exists

The usual way to automate Firefox (`--remote-debugging-port`, WebDriver BiDi) only works if
the browser was launched with that flag. You can't attach to the browser you already have open,
which is precisely the browser with your sessions in it. An extension has no such
restriction: it is simply there, in the profile, all the time.

## Install

Two routes. Both install permanently (unlike `about:debugging`, which is wiped on restart).

**Signed (recommended).** Mozilla signs *unlisted* add-ons automatically — self-distributed,
never published, never publicly reviewed, usually signed within seconds.

1. Get API credentials at <https://addons.mozilla.org/developers/addon/api/key/> (the secret
   is shown once) and put them in `.env.amo` at the repo root, or export them:
   `AMO_JWT_ISSUER=user:…` and `AMO_JWT_SECRET=…`
2. `npm run sign:firefox` → writes `cobrowser-bridge-signed.xpi`
3. In your browser: `about:addons` → gear icon → **Install Add-on From File…**

This installs with `xpinstall.signatures.required` left at `true`. Bump the version in
`manifest.json` before re-signing — AMO refuses a version it has already signed.

**Unsigned.** `cd firefox-extension && zip -r ../cobrowser-bridge.xpi .`, then install the same
way. Zen's Gecko layer ships `xpinstall.signatures.required` as `false`, but `browser/omni.ja`
overrides it back to `true`, so the install is refused ("could not be verified") until you set
that pref to `false` in `about:config`. Unlike stock Firefox release, the flip does take effect
here. Note it disables signature checks for every future add-on install in that profile.
3. In your editor, set **`cobrowser.firefoxContainer`** for the workspace (workspace settings,
   not user settings) to the container name it may drive, e.g. `School`. Reload the window.

That's it. Cobrowser registers the workspace's endpoint through Firefox's managed-storage
manifest at `~/Library/Application Support/Mozilla/ManagedStorage/` (Linux:
`~/.mozilla/managed-storage/`), and the extension picks it up. Repeat step 3 per workspace;
four workspaces bound to four containers all share this one extension.

If auto-registration doesn't work (Windows keeps managed storage in the registry, which
Cobrowser doesn't write), run **Cobrowser: Copy Firefox Bridge URL** and paste the result into
the extension's options page. The toolbar badge shows how many workspaces are bound.

## What it can and can't do

The agent gets `firefox_list_tabs`, `firefox_snapshot`, `firefox_click`, `firefox_fill`, `firefox_navigate`,
`firefox_read_page`, `firefox_screenshot`, `firefox_new_tab`, `firefox_activate_tab`, `firefox_list_containers`.

Input is **synthetic** (`isTrusted: false`) — no extension API can generate real input
events. Ordinary links, buttons, and form fields work; values are set through the native
setter and followed by `input`/`change`, so React and Vue notice them. What does not work:
file inputs (impossible from an extension), OS-level dialogs and pickers, drag-and-drop,
and sites that explicitly check event trust. For those, use the CDP-backed tools against
Cobrowser's embedded browser.

Content scripts can't run on `about:` pages or addons.mozilla.org, so tabs there are
listed but not scriptable.

## You can see what it touches

Every action that reaches a tab draws a marker on it: a purple frame with a label
("cobrowser: clicked", "cobrowser: read this page"), plus a ● prefix on the tab title so a
tab being driven in the *background* is visible in the tab strip too. Both clear themselves
after a couple of seconds.

The frame is `pointer-events: none`, so it never intercepts your clicks or the agent's.
Screenshots are captured *before* the marker is drawn, so it never appears in what the agent
sees. Privileged pages can't be scripted, so they simply go unmarked — an action is never
failed just because its indicator couldn't be drawn.

Nothing here is Zen-specific: a WebExtension cannot style the tab strip directly, so both
surfaces are injected into the page, which works the same in any Firefox.

## Bulk reads, and the guards around them

`firefox_evaluate_script` is the tool for collecting many things at once: read fifty order
links in one call rather than snapshotting and clicking fifty times. It runs in the
**isolated world** (shares the DOM, not the page's JavaScript); `world: "page"` reaches the
site's own globals and is logged. Treat it as read-only — it *can* touch the DOM, so that is
a contract with the agent, not something the browser enforces.

`firefox_fetch` issues a **same-origin** request from a tab, carrying that tab's cookies —
for JSON APIs and downloads behind a login, and for responses that aren't scriptable (the
JSON viewer). Cross-origin is refused.

Prefer a site's official export where one exists (bank CSV, "request your data", statements)
over scraping rendered pages.

Everything that reaches a site is **paced**: 1–3s with jitter, a 100-request per-session cap,
and a one-minute backoff on 429/403 or a CAPTCHA page. Hitting the cap is a stop, not a
retry.

Three things the agent will not do, each returning `needsUserAction` instead:

- fill passwords, one-time codes, CVVs or card numbers
- click sign-out, delete-account or cancel-subscription controls
- click pay / place-order / send-money buttons

`allowDestructive` and `allowCredentials` exist for when the human explicitly asks. The
sign-out guard is not hypothetical: a broad selector signed the user out of their bank
mid-session.

## Scoping is enforced here, not by the browser

The extension holds permission for every container in the profile — WebExtensions have no
per-container permission model. What keeps the `school` workspace out of `personal` is
`assertInScope()` in `background.js`, which checks each tab's `cookieStoreId` against the
one the workspace declared. That is a real boundary against an agent wandering, and it is
not a boundary against malicious code running in this extension. Read it before you trust
it; it's about ten lines.

Each endpoint URL carries a bearer token and only ever points at `127.0.0.1`.
