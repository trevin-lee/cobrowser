import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Puppeteer injects 33 default args tuned for pure automation. Four of them are wrong for a
 * browser a HUMAN looks at, and the failure when one comes back is silent: extensions simply
 * do not load, scrollbars simply are not there. Read out of the source because the launch
 * options are built for a live browser, not exported as data.
 */
const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'browser', 'launchFlags.ts'),
  'utf8',
);

const ignored = (): string => {
  const block = /ignoreDefaultArgs:\s*\[([\s\S]*?)\]/.exec(src);
  assert.ok(block, 'ignoreDefaultArgs must be set — puppeteer injects 33 args by default');
  return block![1];
};

test('puppeteer default args that fight the product stay refused', () => {
  const block = ignored();
  for (const flag of [
    '--disable-extensions', // silently cancelled our own --load-extension
    '--enable-automation', // the canonical automation tell
    '--hide-scrollbars', // measured 0px where real desktop Chrome reports 15
    '--mute-audio', // silences video the human is watching
  ]) {
    assert.ok(block.includes(flag), `${flag} must stay refused`);
  }
});

test('args that keep background panels rendering are NOT refused', () => {
  const block = ignored();
  for (const keep of ['--disable-renderer-backgrounding', '--disable-background-timer-throttling']) {
    assert.ok(!block.includes(keep), `${keep} must stay — it is why hidden panels keep producing frames`);
  }
});

test('window mode launches without the flag that puts a warning bar on the window', async () => {
  const { resolveLaunchOptions } = await import('../src/browser/launchFlags');
  const flag = '--disable-blink-features=AutomationControlled';
  assert.ok(resolveLaunchOptions('/p', '/c', true).args!.includes(flag), 'panel mode keeps it');
  assert.ok(
    !resolveLaunchOptions('/p', '/c', false).args!.includes(flag),
    'a real window shows "unsupported command-line flag" for it',
  );
});
