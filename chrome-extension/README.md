# Cobrowser Bridge for Chrome

The Chrome counterpart of the Firefox add-on: lets cobrowser, running in your editor, see and
drive the tabs of your own Chrome — scoped to one tab group, or the whole profile.

Same wire protocol as the Firefox add-on, and the same `bridge_*` MCP tools, on whichever browser
a workspace is bound to; the differences are listed below.

## Install

1. In your editor, run **Cobrowser: Install Chrome Bridge Extension**. It copies this folder to
   `~/.cobrowser/chrome-extension` (a place that survives cobrowser updates, and is refreshed
   by them) and copies that path.
2. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose that folder.
3. Run **Cobrowser: Bind Chrome Tab Group to This Workspace** and give a group name (or
   `profile` for every tab).
4. Run **Cobrowser: Copy Bridge URL**, open the extension's toolbar popup, paste the URL under
   *Connect a workspace*, save. The URL never changes for that workspace, so this is a one-time step.

Chrome has no writable managed-storage manifest outside enterprise policy, which is why step 4
is by hand here and automatic in Firefox. The extension carries cobrowser's version; after an
update, Chrome loads the new files when it restarts, or at once with the extension's reload
button, and until then the agent is told the extension is out of date.

## How scoping works

A workspace is bound to a **tab group** by its title, or to `profile`. The bridge refuses
every call that touches a tab outside that scope. Chrome closes a group with its last tab, and
gives a restored group a new id, so the bridge finds the group again by its title, and if none
is open, the agent's next new tab starts it again under that name. An untitled group cannot be
bound until it is named. **Cobrowser: Unbind Your Own Browser** unbinds the workspace. Tab groups are visible and nameable in the
tab strip, which makes them a good stand-in for Firefox containers — with one honest
difference: a tab group is not a cookie boundary. Every tab in the profile shares the same
logins. The group limits what the agent can *reach*, not what the browser *knows*.

## Pace

Everything that reaches a site waits 1 to 3 seconds, stops at 100 requests in a browser
session, and pauses for a minute when a site answers `bridge_fetch` with 429 or 403 or a
challenge. The count, the pause and which tabs the agent opened survive Chrome stopping and
restarting the extension's service worker. The toolbar popup shows it and
has a **Reset** button; only that page can reset it, not a script in a tab.

## Differences from the Firefox add-on

- Screenshots bring the tab to the front first: Chrome can only capture a window's visible tab.
- No `bridge_evaluate_script`: Chrome runs no code sent to an extension (Manifest V3 forbids
  it, and so does the Chrome Web Store). `bridge_query` covers bulk reads: a CSS selector and
  the fields to return for every match. Anything that needs real code goes in the cobrowser
  panel, whose `evaluate_script` runs anything.
- The service worker is kept alive by a 20 s keepalive on each socket (Chrome 116+) and an
  alarm that reconnects within 30 s if it was torn down anyway.
