/* Two editor windows race to start the app: exactly one instance survives and owns the state file. */
import { suite, spawnApp, sleep, withTimeout, AppConnection, readAppState } from './harness';
import * as path from 'node:path';

suite('single-instance', async (r) => {
  const kids = [0, 1].map(() => spawnApp());
  const exits = kids.map((k) => new Promise<void>((res) => k.on('exit', () => res())));
  try {
    // Wait for the race to settle rather than a fixed time: on a loaded machine a copy can take
    // seconds just to reach the lock. The promise is that exactly one survives, not how fast.
    let alive = kids.map((k) => k.pid);
    for (let i = 0; i < 100; i++) {
      await sleep(200);
      alive = kids.filter((k) => k.exitCode === null && k.signalCode === null).map((k) => k.pid);
      if (alive.length <= 1 && readAppState()) break;
    }
    const st = readAppState();
    let answered = false;
    if (st) { try { const { conn } = await AppConnection.connect(st, path.join(process.env.COBROWSER_E2E_SCRATCH!, 'ws')); answered = Array.isArray(await conn.listTabs()); conn.close(); } catch { /* not answering */ } }
    r.check('exactly one instance survives', alive.length === 1, { spawned: kids.map((k) => k.pid), alive });
    r.check('the survivor owns the state file and answers', !!st && alive.length === 1 && st.pid === alive[0] && answered, { statePid: st?.pid, answered });
  } finally {
    for (const k of kids) k.kill('SIGTERM');
    await withTimeout(Promise.all(exits), 3000);
    for (const k of kids) if (k.exitCode === null) k.kill('SIGKILL');
  }
});
