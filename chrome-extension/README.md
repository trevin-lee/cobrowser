# Cobrowser Bridge for Chrome

The Chrome counterpart of the Firefox add-on: lets cobrowser, running in your editor, see and
drive the tabs of your own Chrome — scoped to one tab group, or the whole profile.

Same wire protocol as the Firefox add-on, so the editor and the agent cannot tell them apart.
The `bridge_*` MCP tools work on whichever browser a workspace is bound to.

## Install (unpacked)

1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose this folder.
2. In your editor, run **Cobrowser: Bind Chrome Tab Group to This Workspace** and pick a group
   name (or `profile` for every tab).
3. Run **Cobrowser: Copy Bridge URL**, open the extension's toolbar popup, paste the URL under
   *Endpoints*, save. The URL never changes for that workspace, so this is a one-time step.

Chrome has no writable managed-storage manifest outside enterprise policy, which is why step 3
is by hand here and automatic in Firefox.

## How scoping works

A workspace is bound to a **tab group** by its title, or to `profile`. The bridge refuses
every call that touches a tab outside that scope. Tab groups are visible and nameable in the
tab strip, which makes them a good stand-in for Firefox containers — with one honest
difference: a tab group is not a cookie boundary. Every tab in the profile shares the same
logins. The group limits what the agent can *reach*, not what the browser *knows*.

## Differences from the Firefox add-on

- Screenshots bring the tab to the front first: Chrome can only capture a window's visible tab.
- `world: "page"` evaluation injects straight into the page's realm (`MAIN` world), so a
  page's CSP cannot block it the way it can the Firefox add-on's `<script>`-tag route.
- The service worker is kept alive by a 20 s keepalive on each socket (Chrome 116+) and an
  alarm that reconnects within 30 s if it was torn down anyway.
