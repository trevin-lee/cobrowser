# Cobrowser Bridge (Zen / Firefox extension)

Lets Cobrowser drive **your own browser** — the tabs you already have open, already signed
in — instead of a separate automation browser. Each editor workspace is bound to exactly
one container, and this extension refuses every call that touches a tab outside it.

## Why this exists

The usual way to automate Firefox (`--remote-debugging-port`, WebDriver BiDi) only works if
the browser was launched with that flag. You can't attach to the Zen you already have open,
which is precisely the browser with your sessions in it. An extension has no such
restriction: it is simply there, in the profile, all the time.

## Install

1. **Package it:** `cd zen-extension && zip -r ../cobrowser-bridge.xpi .`
2. In Zen: `about:addons` → gear icon → **Install Add-on From File…** → pick the `.xpi`.
   Zen ships with `MOZ_REQUIRE_SIGNING` off, so an unsigned build installs permanently — no
   AMO round-trip, and unlike `about:debugging` it survives a restart. If the install is
   refused, set `xpinstall.signatures.required` to `false` in `about:config` and retry.
3. In your editor, set **`cobrowser.zenContainer`** for the workspace (workspace settings,
   not user settings) to the container name it may drive, e.g. `School`. Reload the window.

That's it. Cobrowser registers the workspace's endpoint through Firefox's managed-storage
manifest at `~/Library/Application Support/Mozilla/ManagedStorage/` (Linux:
`~/.mozilla/managed-storage/`), and the extension picks it up. Repeat step 3 per workspace;
four workspaces bound to four containers all share this one extension.

If auto-registration doesn't work (Windows keeps managed storage in the registry, which
Cobrowser doesn't write), run **Cobrowser: Copy Zen Bridge URL** and paste the result into
the extension's options page. The toolbar badge shows how many workspaces are bound.

## What it can and can't do

The agent gets `zen_list_tabs`, `zen_snapshot`, `zen_click`, `zen_fill`, `zen_navigate`,
`zen_read_page`, `zen_screenshot`, `zen_new_tab`, `zen_activate_tab`, `zen_list_containers`.

Input is **synthetic** (`isTrusted: false`) — no extension API can generate real input
events. Ordinary links, buttons, and form fields work; values are set through the native
setter and followed by `input`/`change`, so React and Vue notice them. What does not work:
file inputs (impossible from an extension), OS-level dialogs and pickers, drag-and-drop,
and sites that explicitly check event trust. For those, use the CDP-backed tools against
Cobrowser's embedded browser.

Content scripts can't run on `about:` pages or addons.mozilla.org, so tabs there are
listed but not scriptable.

## Scoping is enforced here, not by the browser

The extension holds permission for every container in the profile — WebExtensions have no
per-container permission model. What keeps the `school` workspace out of `personal` is
`assertInScope()` in `background.js`, which checks each tab's `cookieStoreId` against the
one the workspace declared. That is a real boundary against an agent wandering, and it is
not a boundary against malicious code running in this extension. Read it before you trust
it; it's about ten lines.

Each endpoint URL carries a bearer token and only ever points at `127.0.0.1`.
