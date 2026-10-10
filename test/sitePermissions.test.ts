import { test } from 'node:test';
import assert from 'node:assert/strict';

type Store = { version: 2; workspaces: Record<string, Record<string, boolean>> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const perms = require('../app/site-permissions.js') as {
  permissionKey: (origin: string, permission: string, details?: { mediaTypes?: string[] }) => string;
  load: (raw: unknown) => Store;
  decision: (s: Store, ws: string, origin: string, permission: string, details?: { mediaTypes?: string[] }) => boolean | undefined;
  remember: (s: Store, ws: string, origin: string, permission: string, details: { mediaTypes?: string[] } | undefined, allowed: boolean) => void;
  list: (s: Store, ws: string) => { key: string; origin: string; permission: string; kind: string; allowed: boolean }[];
  forget: (s: Store, ws: string, keys: string[]) => number;
  dropWorkspace: (s: Store, ws: string) => void;
};

test('a permission decided in one workspace says nothing about another', () => {
  const s = perms.load(null);
  perms.remember(s, '/a', 'https://maps.example', 'geolocation', undefined, true);
  assert.equal(perms.decision(s, '/a', 'https://maps.example', 'geolocation'), true);
  assert.equal(perms.decision(s, '/b', 'https://maps.example', 'geolocation'), undefined, 'undecided: the site asks');
});

test('a check (origin with a trailing slash) finds the decision a request (bare origin) stored', () => {
  const s = perms.load(null);
  perms.remember(s, '/a', 'https://maps.example', 'notifications', undefined, true);
  assert.equal(perms.decision(s, '/a', 'https://maps.example/', 'notifications'), true);
  assert.equal(perms.decision(s, '/a', 'https://maps.example:443', 'notifications'), true);
});

test('camera and microphone are separate decisions, whatever order the site asks in', () => {
  const s = perms.load(null);
  perms.remember(s, '/a', 'https://meet.example', 'media', { mediaTypes: ['video', 'audio'] }, true);
  assert.equal(perms.decision(s, '/a', 'https://meet.example', 'media', { mediaTypes: ['audio', 'video'] }), true);
  assert.equal(perms.decision(s, '/a', 'https://meet.example', 'media', { mediaTypes: ['audio'] }), undefined);
  assert.deepEqual(perms.list(s, '/a').map((p) => [p.origin, p.permission, p.kind]), [['https://meet.example', 'media', 'audio+video']]);
});

test('a file in the current form is read as is; anything else starts empty', () => {
  const s = perms.load(null);
  perms.remember(s, '/a', 'https://maps.example', 'geolocation', undefined, true);
  assert.deepEqual(perms.load(s), s);
  assert.deepEqual(perms.load({ 'https://maps.example|geolocation': true }), { version: 2, workspaces: {} }, 'the old form is converted at start (app/migrations.js), never read here');
});

test('forgetting a decision makes the site ask again; forgetting a workspace drops all of its decisions', () => {
  const s = perms.load(null);
  perms.remember(s, '/a', 'https://x.example', 'notifications', undefined, false);
  perms.remember(s, '/a', 'https://y.example', 'geolocation', undefined, true);
  const [first] = perms.list(s, '/a');
  assert.equal(first.origin, 'https://x.example');
  assert.equal(perms.forget(s, '/a', [first.key, 'not-a-key']), 1);
  assert.equal(perms.decision(s, '/a', 'https://x.example', 'notifications'), undefined);
  perms.dropWorkspace(s, '/a');
  assert.deepEqual(perms.list(s, '/a'), []);
});
