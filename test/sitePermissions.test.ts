import { test } from 'node:test';
import assert from 'node:assert/strict';

type Store = { version: 2; workspaces: Record<string, Record<string, boolean>> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const perms = require('../app/site-permissions.js') as {
  permissionKey: (origin: string, permission: string, details?: { mediaTypes?: string[] }) => string;
  migrate: (raw: unknown, known: string[]) => Store;
  decision: (s: Store, ws: string, origin: string, permission: string, details?: { mediaTypes?: string[] }) => boolean | undefined;
  remember: (s: Store, ws: string, origin: string, permission: string, details: { mediaTypes?: string[] } | undefined, allowed: boolean) => void;
  list: (s: Store, ws: string) => { key: string; origin: string; permission: string; kind: string; allowed: boolean }[];
  forget: (s: Store, ws: string, keys: string[]) => number;
  dropWorkspace: (s: Store, ws: string) => void;
};

test('a permission decided in one workspace says nothing about another', () => {
  const s = perms.migrate(null, []);
  perms.remember(s, '/a', 'https://maps.example', 'geolocation', undefined, true);
  assert.equal(perms.decision(s, '/a', 'https://maps.example', 'geolocation'), true);
  assert.equal(perms.decision(s, '/b', 'https://maps.example', 'geolocation'), undefined, 'undecided: the site asks');
});

test('a check (origin with a trailing slash) finds the decision a request (bare origin) stored', () => {
  const s = perms.migrate(null, []);
  perms.remember(s, '/a', 'https://maps.example', 'notifications', undefined, true);
  assert.equal(perms.decision(s, '/a', 'https://maps.example/', 'notifications'), true);
  assert.equal(perms.decision(s, '/a', 'https://maps.example:443', 'notifications'), true);
});

test('camera and microphone are separate decisions, whatever order the site asks in', () => {
  const s = perms.migrate(null, []);
  perms.remember(s, '/a', 'https://meet.example', 'media', { mediaTypes: ['video', 'audio'] }, true);
  assert.equal(perms.decision(s, '/a', 'https://meet.example', 'media', { mediaTypes: ['audio', 'video'] }), true);
  assert.equal(perms.decision(s, '/a', 'https://meet.example', 'media', { mediaTypes: ['audio'] }), undefined);
  assert.deepEqual(perms.list(s, '/a').map((p) => [p.origin, p.permission, p.kind]), [['https://meet.example', 'media', 'audio+video']]);
});

test('the old shared file carries every decision into each workspace that existed, and nothing is asked again', () => {
  const old = { 'https://maps.example|geolocation': true, 'https://spam.example|notifications': false };
  const s = perms.migrate(old, ['/a', '/b']);
  for (const ws of ['/a', '/b']) {
    assert.equal(perms.decision(s, ws, 'https://maps.example', 'geolocation'), true);
    assert.equal(perms.decision(s, ws, 'https://spam.example', 'notifications'), false);
  }
  perms.forget(s, '/a', [perms.permissionKey('https://maps.example', 'geolocation')]);
  assert.equal(perms.decision(s, '/b', 'https://maps.example', 'geolocation'), true, 'from here on each workspace changes on its own');
  assert.deepEqual(perms.migrate(s, ['/c']), s, 'a current file is read as is');
});

test('forgetting a decision makes the site ask again; forgetting a workspace drops all of its decisions', () => {
  const s = perms.migrate(null, []);
  perms.remember(s, '/a', 'https://x.example', 'notifications', undefined, false);
  perms.remember(s, '/a', 'https://y.example', 'geolocation', undefined, true);
  const [first] = perms.list(s, '/a');
  assert.equal(first.origin, 'https://x.example');
  assert.equal(perms.forget(s, '/a', [first.key, 'not-a-key']), 1);
  assert.equal(perms.decision(s, '/a', 'https://x.example', 'notifications'), undefined);
  perms.dropWorkspace(s, '/a');
  assert.deepEqual(perms.list(s, '/a'), []);
});
