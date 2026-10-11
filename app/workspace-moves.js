'use strict';
/**
 * Folders that were renamed or moved. A workspace is known by its folder's path, so a renamed
 * folder opens as a new workspace with an empty browser; taking over the old one's (Cobrowser:
 * Take Over a Moved Folder's Browser) gives it the old one's browser data, site permissions and
 * the logins allowed there. Pure functions over the stored object; the app reads and writes
 * moves.json.
 *
 * Stored as { partitions, logins, discard }:
 *   partitions: { [workspaceId]: partitionName }, for a workspace that does not use the
 *     partition named after its path (it took over another's, or gave its own away);
 *   logins: { [oldId]: newId }, renames not yet made in the vault's scopes because it was
 *     locked, made at the next unlock;
 *   discard: partition folders no workspace uses any more, deleted at the next start, before
 *     any session holds their files.
 */
const crypto = require('node:crypto');

function load(raw) {
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return { partitions: obj(raw?.partitions), logins: obj(raw?.logins), discard: Array.isArray(raw?.discard) ? raw.discard : [] };
}

/** The partition named after a workspace's path. */
function ownPartition(id) {
  return `ws-${crypto.createHash('sha1').update(id).digest('hex').slice(0, 16)}`;
}

/** The partition a workspace's browser lives in. */
function partitionName(moves, id) {
  return moves.partitions[id] || ownPartition(id);
}

/**
 * `to` takes over `from`'s browser. `from`'s path gets a fresh partition, so a folder made
 * there later starts empty, and `to`'s own (what it had since the move) is discarded.
 */
function adopt(moves, from, to) {
  if (from === to) throw new Error('a workspace cannot take over its own browser');
  const taken = partitionName(moves, from);
  moves.discard = [...new Set([...moves.discard, partitionName(moves, to)])].filter((p) => p !== taken);
  moves.partitions[to] = taken;
  moves.partitions[from] = `ws-${crypto.randomBytes(8).toString('hex')}`;
  for (const id of [from, to]) if (moves.partitions[id] === ownPartition(id)) delete moves.partitions[id];
  // Logins allowed in `from` move to `to`, and so do any still on their way to `from`.
  for (const [k, v] of Object.entries(moves.logins)) if (v === from) moves.logins[k] = to;
  moves.logins[from] = to;
  for (const [k, v] of Object.entries(moves.logins)) if (k === v) delete moves.logins[k];
}

/** A login's scope with the moved workspaces renamed. */
function renameInScope(scope, logins) {
  if (!Array.isArray(scope)) return scope;
  return [...new Set(scope.map((w) => logins[w] || w))];
}

module.exports = { load, ownPartition, partitionName, adopt, renameInScope };
