/* Two editor windows race to start the app: exactly one copy becomes the app, and the other
 * never gets past the single-instance lock (no menu-bar icon, no socket, no state file).
 *
 * The loser normally exits within a second. On a heavily loaded machine it can sit inside the
 * lock for longer — Electron's lock waits for the winner to answer, and a starved winner
 * answers late — but it has done nothing visible, so what is checked is that only one copy
 * ever started, not how fast the other one left. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { suite, spawnApp, sleep, withTimeout, AppConnection, readAppState, SCRATCH } from './harness';

suite('single-instance', async (r) => {
  const kids = [0, 1].map(() => spawnApp());
  const t0 = Date.now();
  const exits = kids.map((k) => new Promise<number>((res) => k.on('exit', () => res(Date.now() - t0))));
  try {
    let st = readAppState();
    for (let i = 0; i < 100 && !st; i++) { await sleep(200); st = readAppState(); }
    await sleep(3000); // time for a second copy to start, if the lock let it
    const started = fs.readFileSync(path.join(SCRATCH, 'data', 'app.log'), 'utf8').split('\n').filter((l) => /cobrowser app \S+: ws:/.test(l));
    let answered = false;
    if (st) { try { const { conn } = await AppConnection.connect(st, path.join(SCRATCH, 'ws')); answered = Array.isArray(await conn.listTabs()); conn.close(); } catch { /* not answering */ } }
    r.check('exactly one copy ever starts', started.length === 1, started);
    r.check('it owns the state file, is alive, and answers', !!st && kids.some((k) => k.pid === st!.pid && k.exitCode === null) && answered, { statePid: st?.pid, answered });
    const loser = await withTimeout(Promise.race(exits), 25000);
    r.check('the other copy exits', loser !== 'TIMEOUT', { loser });
    r.note('the losing copy exited after', loser === 'TIMEOUT' ? 'more than 25 s' : `${loser} ms`);
  } finally {
    for (const k of kids) k.kill('SIGTERM');
    await withTimeout(Promise.all(exits), 3000);
    for (const k of kids) if (k.exitCode === null) k.kill('SIGKILL');
  }
});
