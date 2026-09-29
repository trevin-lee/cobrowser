'use strict';
/**
 * Site permissions a person granted or blocked (location, camera, notifications, …), kept
 * per workspace: each workspace is its own browser, so allowing a site in one says nothing
 * about the others. Pure functions over the stored object; the app reads and writes the file.
 *
 * Stored as { version: 2, workspaces: { [workspaceId]: { [key]: boolean } } }, where a key is
 * "origin|permission" plus ":kind" for camera/microphone ("…|media:audio+video").
 */

/** "https://site.example" however it arrives: Chromium hands the permission CHECK a URL with
 *  a trailing slash ("https://site.example/") and the REQUEST a bare origin, and both must
 *  land on the same decision. */
function normalizeOrigin(origin) {
  try {
    const o = new URL(origin).origin;
    return o && o !== 'null' ? o : String(origin);
  } catch {
    return String(origin);
  }
}

/** The key one decision is stored under. */
function permissionKey(origin, permission, details) {
  const kind = details?.mediaTypes?.slice().sort().join('+') || details?.mediaType || '';
  return `${normalizeOrigin(origin)}|${permission}${kind ? ':' + kind : ''}`;
}

/**
 * Read what was on disk. Before version 2 the file was one flat map shared by every
 * workspace; those decisions are copied to each workspace that existed then, so nothing a
 * person decided is lost or starts asking again, and from here on each changes on its own.
 */
function migrate(raw, knownWorkspaces) {
  if (raw && raw.version === 2 && raw.workspaces && typeof raw.workspaces === 'object') return raw;
  const store = { version: 2, workspaces: {} };
  const flat = raw && typeof raw === 'object' ? Object.entries(raw).filter(([k, v]) => k.includes('|') && typeof v === 'boolean') : [];
  if (flat.length) for (const ws of knownWorkspaces) store.workspaces[ws] = Object.fromEntries(flat);
  return store;
}

function decision(store, workspaceId, origin, permission, details) {
  return store.workspaces[workspaceId]?.[permissionKey(origin, permission, details)];
}

function remember(store, workspaceId, origin, permission, details, allowed) {
  (store.workspaces[workspaceId] ||= {})[permissionKey(origin, permission, details)] = allowed;
}

/** One workspace's decisions, for review: [{ key, origin, permission, kind, allowed }]. */
function list(store, workspaceId) {
  return Object.entries(store.workspaces[workspaceId] || {})
    .map(([key, allowed]) => {
      const bar = key.lastIndexOf('|');
      const [permission, kind = ''] = key.slice(bar + 1).split(':');
      return { key, origin: key.slice(0, bar), permission, kind, allowed };
    })
    .sort((a, b) => a.origin.localeCompare(b.origin) || a.permission.localeCompare(b.permission));
}

/** Forget decisions, so the site asks again. Returns how many were forgotten. */
function forget(store, workspaceId, keys) {
  const map = store.workspaces[workspaceId];
  if (!map) return 0;
  let n = 0;
  for (const k of keys) if (k in map) { delete map[k]; n++; }
  if (!Object.keys(map).length) delete store.workspaces[workspaceId];
  return n;
}

/** Everything decided for a workspace, gone (forgetting the workspace). */
function dropWorkspace(store, workspaceId) {
  delete store.workspaces[workspaceId];
}

module.exports = { permissionKey, migrate, decision, remember, list, forget, dropWorkspace };
