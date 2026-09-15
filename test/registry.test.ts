import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry, isSelf, type IsAlive } from '../src/daemon/registry';
import type { Registration } from '../src/daemon/protocol';

const reg = (name: string, over: Partial<Registration> = {}): Registration => ({
  id: `/Users/dev/${name}`,
  name,
  url: `http://127.0.0.1:5000/mcp`,
  token: `tok-${name}`,
  pid: 1000,
  ...over,
});

/** Every pid alive unless listed dead. */
const alive = (dead: number[] = []): IsAlive => (pid) => !dead.includes(pid);

test('resolves a workspace by folder name and by full path', () => {
  const r = new Registry(alive());
  r.add(reg('alpha'));
  r.add(reg('beta', { pid: 1001 }));

  const byName = r.resolve('alpha');
  assert.ok('ok' in byName && byName.ok.name === 'alpha');

  const byPath = r.resolve('/Users/dev/beta');
  assert.ok('ok' in byPath && byPath.ok.name === 'beta');
});

test('name matching is case-insensitive', () => {
  const r = new Registry(alive());
  r.add(reg('CoBrowser'));
  const hit = r.resolve('cobrowser');
  assert.ok('ok' in hit);
});

test('an unknown workspace errors AND lists the valid ones, so one turn self-corrects', () => {
  const r = new Registry(alive());
  r.add(reg('alpha'));
  const miss = r.resolve('nope');
  assert.ok('error' in miss);
  assert.match(miss.error, /Unknown workspace "nope"/);
  assert.match(miss.error, /alpha/); // the agent can retry correctly without guessing
});

test('with nothing registered, the error says to open a window rather than naming none', () => {
  const r = new Registry(alive());
  const miss = r.resolve('alpha');
  assert.ok('error' in miss);
  assert.match(miss.error, /No cobrowser workspaces are open/);
});

test('an ambiguous folder name refuses instead of guessing a browser', () => {
  const r = new Registry(alive());
  r.add(reg('app', { id: '/Users/dev/one/app', token: 'a', pid: 1 }));
  r.add(reg('app', { id: '/Users/dev/two/app', token: 'b', pid: 2 }));
  const hit = r.resolve('app');
  assert.ok('error' in hit, 'must not silently pick one of two same-named workspaces');
  assert.match(hit.error, /matches more than one/);
  assert.match(hit.error, /Use the full path/);
  // ...but the full path still resolves unambiguously.
  const exact = r.resolve('/Users/dev/two/app');
  assert.ok('ok' in exact && exact.ok.token === 'b');
});

test('a token identifies exactly one workspace — the basis of session isolation', () => {
  const r = new Registry(alive());
  r.add(reg('alpha'));
  r.add(reg('beta', { pid: 1001 }));
  assert.equal(r.byToken('tok-alpha')?.name, 'alpha');
  assert.equal(r.byToken('tok-beta')?.name, 'beta');
  assert.equal(r.byToken('tok-unknown'), undefined);
  assert.equal(r.byToken(''), undefined, 'an empty token must never match a workspace');
});

test('a dead host is pruned, so a crashed window leaves no phantom', () => {
  const r = new Registry(alive([1001]));
  r.add(reg('alpha'));
  r.add(reg('beta', { pid: 1001 }));
  assert.equal(r.list().length, 1);
  assert.equal(r.list()[0].name, 'alpha');
});

test('a dead workspace stops resolving and stops accepting its token', () => {
  const r = new Registry(alive([1001]));
  r.add(reg('beta', { pid: 1001 }));
  assert.ok('error' in r.resolve('beta'));
  assert.equal(r.byToken('tok-beta'), undefined, 'a dead window must not authenticate');
});

test('membership changes invalidate cached tool schemas', () => {
  let invalidations = 0;
  const r = new Registry(alive([1001]), () => invalidations++);
  r.add(reg('alpha'));
  assert.equal(invalidations, 1);

  r.remove('/Users/dev/alpha');
  assert.equal(invalidations, 2);

  assert.equal(r.remove('/nope'), false);
  assert.equal(invalidations, 2, 'removing nothing must not invalidate');

  r.add(reg('beta', { pid: 1001 }));
  r.list(); // prunes the dead one
  assert.equal(invalidations, 4, 'a prune that removes an entry must invalidate too');
});

test('isSelf accepts a workspace own name and path, and rejects any other', () => {
  const a = reg('alpha');
  assert.ok(isSelf(a, 'alpha'));
  assert.ok(isSelf(a, 'ALPHA'));
  assert.ok(isSelf(a, '/Users/dev/alpha'));
  assert.ok(!isSelf(a, 'beta'));
  assert.ok(!isSelf(a, '/Users/dev/beta'));
  assert.ok(!isSelf(a, ''), 'empty must not count as self');
});

test('hint names open workspaces, or says none are open', () => {
  const r = new Registry(alive());
  assert.match(r.hint(), /No cobrowser workspaces are open/);
  r.add(reg('alpha'));
  assert.match(r.hint(), /alpha/);
});

test('a token stays recognised after the window goes away — no bare 401 on restart', () => {
  // The regression: workspace tokens authenticated only against LIVE registrations, so a
  // daemon restart met every client with 401. Clients read that as an OAuth challenge and
  // attempted Dynamic Client Registration, making an upgrade look like an auth outage.
  const r = new Registry(alive());
  r.add(reg('alpha'));
  assert.equal(r.byToken('tok-alpha')?.name, 'alpha');

  r.remove('/Users/dev/alpha'); // window closed / daemon restarted
  assert.equal(r.byToken('tok-alpha'), undefined, 'no longer LIVE');
  assert.deepEqual(r.knownByToken('tok-alpha'), { id: '/Users/dev/alpha', name: 'alpha' });
});

test('an unknown token is still rejected outright', () => {
  const r = new Registry(alive());
  r.add(reg('alpha'));
  assert.equal(r.knownByToken('tok-nope'), undefined);
  assert.equal(r.knownByToken(''), undefined);
});

test('known workspaces survive a new Registry over the same store', () => {
  const store = `${process.env.TMPDIR ?? '/tmp'}/cobrowser-known-${process.pid}.json`;
  const first = new Registry(alive(), () => undefined, store);
  first.add(reg('alpha'));

  const second = new Registry(alive(), () => undefined, store);
  assert.deepEqual(second.knownByToken('tok-alpha'), { id: '/Users/dev/alpha', name: 'alpha' });
  assert.equal(second.byToken('tok-alpha'), undefined, 'restored as KNOWN, not as live');
  require('node:fs').rmSync(store, { force: true });
});
