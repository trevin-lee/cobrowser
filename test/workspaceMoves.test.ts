import { test } from 'node:test';
import assert from 'node:assert/strict';

type Moves = { partitions: Record<string, string>; logins: Record<string, string>; discard: string[] };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const moves = require('../app/workspace-moves.js') as {
  load: (raw: unknown) => Moves;
  ownPartition: (id: string) => string;
  partitionName: (m: Moves, id: string) => string;
  adopt: (m: Moves, from: string, to: string) => void;
  renameInScope: (scope: unknown, logins: Record<string, string>) => unknown;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const perms = require('../app/site-permissions.js') as {
  moveWorkspace: (store: { workspaces: Record<string, Record<string, boolean>> }, from: string, to: string) => void;
};

test("a renamed folder browses in the old folder's partition, and the old path starts fresh", () => {
  const m = moves.load(null);
  const oldOwn = moves.ownPartition('/code/app'), newOwn = moves.ownPartition('/code/app2');
  moves.adopt(m, '/code/app', '/code/app2');
  assert.equal(moves.partitionName(m, '/code/app2'), oldOwn);
  assert.notEqual(moves.partitionName(m, '/code/app'), oldOwn, 'a folder made at the old path later gets its own');
  assert.notEqual(moves.partitionName(m, '/code/app'), newOwn);
  assert.deepEqual(m.discard, [newOwn], 'what the new path had since the move is given up');
  assert.deepEqual(m.logins, { '/code/app': '/code/app2' });
});

test('renamed back, a folder gets its own partition again and nothing it uses is discarded', () => {
  const m = moves.load(null);
  moves.adopt(m, '/a', '/b');
  moves.adopt(m, '/b', '/a');
  assert.equal(moves.partitionName(m, '/a'), moves.ownPartition('/a'));
  assert.equal(m.partitions['/a'], undefined);
  assert.ok(!m.discard.includes(moves.ownPartition('/a')));
  assert.deepEqual(m.logins, { '/b': '/a' });
});

test('moved twice, logins waiting for the first move follow to the last', () => {
  const m = moves.load(null);
  moves.adopt(m, '/a', '/b');
  moves.adopt(m, '/b', '/c');
  assert.equal(moves.partitionName(m, '/c'), moves.ownPartition('/a'));
  assert.deepEqual(m.logins, { '/a': '/c', '/b': '/c' });
  assert.deepEqual(moves.renameInScope(['/a', '/x', '/c'], m.logins), ['/c', '/x']);
  assert.equal(moves.renameInScope('all', m.logins), 'all');
});

test('a workspace cannot take over itself, and a damaged file reads as empty', () => {
  assert.throws(() => moves.adopt(moves.load(null), '/a', '/a'));
  assert.deepEqual(moves.load({ partitions: [], logins: 'x', discard: {} }), { partitions: {}, logins: {}, discard: [] });
});

test("site permissions move with the folder; one decided at the new path since wins", () => {
  const store = { workspaces: { '/a': { 'https://x.example|geolocation': true, 'https://y.example|notifications': false }, '/b': { 'https://x.example|geolocation': false } } };
  perms.moveWorkspace(store, '/a', '/b');
  assert.deepEqual(store.workspaces, { '/b': { 'https://x.example|geolocation': false, 'https://y.example|notifications': false } });
  const empty = { workspaces: {} as Record<string, Record<string, boolean>> };
  perms.moveWorkspace(empty, '/a', '/b');
  assert.deepEqual(empty.workspaces, {});
});
