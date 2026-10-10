import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The popup's few words for a workspace, read out of each add-on's options.js and run on the
 *  messages its own background script sends. */
function stateWords(dir: string): (connected: boolean, error?: string) => string {
  const src = fs.readFileSync(path.join(__dirname, '..', dir, 'options.js'), 'utf8');
  const start = src.indexOf('function stateWords(');
  assert.ok(start >= 0, `${dir}: stateWords not found`);
  const end = src.indexOf('\n}', start) + 2;
  return new Function(`${src.slice(start, end)}; return stateWords;`)() as (connected: boolean, error?: string) => string;
}

for (const [dir, here, other] of [['chrome-extension', 'Chrome', 'Firefox'], ['firefox-extension', 'Firefox', 'Chrome']] as const) {
  test(`${dir}: an unbound workspace reads "Not bound", one bound elsewhere reads where`, () => {
    const words = stateWords(dir);
    const bg = fs.readFileSync(path.join(__dirname, '..', dir, 'background.js'), 'utf8');
    const unbound = new RegExp(`this workspace is not bound to ${here}[^'\`]*`).exec(bg)?.[0];
    assert.ok(unbound, `${dir}: the unbound message was not found`);
    assert.equal(words(true, unbound), 'Not bound');
    assert.equal(words(true, `this workspace is bound to ${other}, not ${here}`), `Bound to ${other}`);
    assert.equal(words(true, undefined), 'Not bound');
    assert.equal(words(false, unbound), 'Not running');
    assert.equal(words(true, 'no such tab'), 'Error');
    const closed = /this workspace\\'s editor window is closed[^']*/.exec(bg)?.[0]?.replace(/\\'/g, "'");
    assert.ok(closed, `${dir}: the window-closed message was not found`);
    assert.equal(words(true, closed), 'Window closed');
  });
}
