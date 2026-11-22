import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrationKeeper } from '../src/daemon/client';

type State = 'ok' | 'missing' | 'down';

/** A keeper over a scripted daemon: `state` and `ensure` answer what the test sets, and every
 *  call is recorded in order. */
function keeper(up: boolean) {
  const calls: string[] = [];
  const daemon = { state: 'down' as State, ensures: false };
  const check = registrationKeeper({
    state: async () => (calls.push(`state:${daemon.state}`), daemon.state),
    ensure: async () => (calls.push(`ensure:${daemon.ensures}`), daemon.ensures),
    register: async () => void calls.push('register'),
    first: async () => void calls.push('first'),
    up,
    log: () => undefined,
  });
  return { calls, daemon, check };
}

test('a window whose daemon was not there at its start keeps trying, then does what it skipped once', async () => {
  // VS Code restarting starts every window at once; this one found port 39273 held by a
  // daemon that did not answer yet, and gave up for good (until a reload) before this fix.
  const { calls, daemon, check } = keeper(false);
  await check();
  assert.deepEqual(calls, ['state:down', 'ensure:false'], 'still nothing: try again next time, register nothing');

  calls.length = 0;
  daemon.state = 'missing'; // the daemon is up now, without this workspace
  daemon.ensures = true;
  await check();
  assert.deepEqual(calls, ['state:missing', 'ensure:true', 'first'], 'it checks the daemon is this build, then registers for the first time');

  calls.length = 0;
  daemon.state = 'ok';
  await check();
  assert.deepEqual(calls, ['state:ok'], 'registered: nothing more to do');

  calls.length = 0;
  daemon.state = 'missing'; // the daemon restarted later and forgot every window
  await check();
  assert.deepEqual(calls, ['state:missing', 'register'], 'from then on a forgotten workspace only registers again');
});

test('a window that started with its daemon registers again when the daemon forgets it, and restarts a stopped one', async () => {
  const { calls, daemon, check } = keeper(true);
  daemon.state = 'ok';
  await check();
  assert.deepEqual(calls, ['state:ok']);

  calls.length = 0;
  daemon.state = 'missing';
  await check();
  assert.deepEqual(calls, ['state:missing', 'register'], 'a restarted daemon: register again, without a version check');

  calls.length = 0;
  daemon.state = 'down';
  daemon.ensures = true;
  await check();
  assert.deepEqual(calls, ['state:down', 'ensure:true', 'register'], 'a stopped daemon: start it, then register');

  calls.length = 0;
  daemon.ensures = false;
  await check();
  assert.deepEqual(calls, ['state:down', 'ensure:false'], 'it could not be started: nothing to register with yet');
});
