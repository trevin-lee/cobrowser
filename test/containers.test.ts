import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContainers, containerName } from '../src/firefox/containers';

// Shape taken from a real Zen containers.json: built-in containers carry an l10nID and no
// `name`, user-created ones carry `name`. Getting that wrong silently drops containers from
// the picker, which looks like "cobrowser can't see my containers".
const REAL = JSON.stringify({
  version: 5,
  lastUserContextId: 7,
  identities: [
    { userContextId: 1, public: true, icon: 'fingerprint', color: 'blue', l10nID: 'userContextPersonal.label' },
    { userContextId: 2, public: true, icon: 'briefcase', color: 'orange', l10nID: 'userContextWork.label' },
    { userContextId: 6, public: true, icon: 'briefcase', color: 'pink', name: 'School' },
    { userContextId: 7, public: true, icon: 'fence', color: 'purple', name: 'Startup 2' },
    { userContextId: 4, public: false, icon: 'circle', color: 'grey', l10nID: 'userContextIdInternal.thumbnail' },
  ],
});

test('built-in containers resolve to their display names', () => {
  assert.equal(containerName({ l10nID: 'userContextPersonal.label' }), 'Personal');
  assert.equal(containerName({ l10nID: 'userContextWork.label' }), 'Work');
  assert.equal(containerName({ l10nID: 'userContextBanking.label' }), 'Banking');
});

test('a user-created name wins over any l10n id', () => {
  assert.equal(containerName({ name: 'School', l10nID: 'userContextWork.label' }), 'School');
});

test('parses a real profile: both built-in and user-created containers', () => {
  const got = parseContainers(REAL, 'qm4thhsh.Default (release)');
  assert.deepEqual(
    got.map((c) => c.name),
    ['Personal', 'Work', 'School', 'Startup 2'],
  );
  assert.equal(got[2].userContextId, 6);
  assert.equal(got[0].profile, 'qm4thhsh.Default (release)');
});

test('private/internal identities are excluded — they are not bindable containers', () => {
  const got = parseContainers(REAL, 'p');
  assert.ok(!got.some((c) => c.userContextId === 4));
});

test('an identity with no resolvable name is dropped rather than shown blank', () => {
  const json = JSON.stringify({ identities: [{ userContextId: 9, public: true }] });
  assert.deepEqual(parseContainers(json, 'p'), []);
});

test('an empty profile yields no containers rather than throwing', () => {
  assert.deepEqual(parseContainers(JSON.stringify({ version: 5 }), 'p'), []);
});
