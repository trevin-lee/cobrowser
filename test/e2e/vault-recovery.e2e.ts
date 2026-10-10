/* A vault this Mac's keychain key cannot open (the key was deleted or refused): it says so,
 * the vault window offers to start over, the old file is kept, and a new vault works. */
import { suite, launch, SCRATCH, sleep } from './harness';
import * as fs from 'node:fs';
import * as path from 'node:path';

suite('vault-recovery', async (r) => {
  const data = path.join(SCRATCH, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'vault.bin'), 'not a vault this key can open');
  const L = await launch({ env: { COBROWSER_TEST_START_OVER: 'accept' } });
  try {
    const locked = await L.conn.vaultList().then(() => 'opened', (e: Error) => e.message);
    r.check('a vault this Mac cannot read says so, instead of a decryption error', /cannot be read with this Mac's keychain key/.test(locked), locked);

    const offer = (await L.conn.vaultWindow(`refresh().then(() => [...document.querySelectorAll('#detail button')].map((b) => b.textContent))`, { wait: 600 })).value as string[];
    r.check('the vault window offers to start a new vault', Array.isArray(offer) && offer.includes('Start a new vault'), offer);

    const res = (await L.conn.vaultWindow(`vault.startOver()`, { wait: 400 })).value as { ok?: boolean; backup?: string };
    const files = fs.readdirSync(data);
    r.check('starting over keeps the old file, renamed with the date, and removes nothing else', res?.ok === true && files.some((f) => /^vault-unreadable-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.bin$/.test(f)) && !files.includes('vault.bin'), { res, files });

    await L.conn.vaultAdd('https://after.example', 'me', 'pw', 'all');
    const after = await L.conn.vaultList().then((l) => l.map((e) => e.host), (e: Error) => [e.message]);
    r.check('the new vault works: a login is saved and listed', JSON.stringify(after) === '["after.example"]', after);

    const again = (await L.conn.vaultWindow(`vault.startOver()`)).value as { error?: string };
    r.check('a vault that can be read is never started over', /can still be read/.test(again?.error ?? ''), again);
    await sleep(100);
  } finally {
    await L.stop();
  }
});
