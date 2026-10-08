import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every page script a bridge extension runs (PAGE_SCRIPTS.<name>) must exist in that extension.
 * Chrome's fetchUrl was deleted with evaluate while its caller stayed, and bridge_fetch then
 * failed on every call, after counting against the request cap, for 13 releases.
 */
for (const dir of ['chrome-extension', 'firefox-extension']) {
  test(`${dir}: every PAGE_SCRIPTS entry it calls is defined`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', dir, 'background.js'), 'utf8');
    const start = src.indexOf('const PAGE_SCRIPTS = {');
    assert.ok(start >= 0, 'PAGE_SCRIPTS not found');
    const end = src.indexOf('\n};', start);
    const defined = new Set([...src.slice(start, end).matchAll(/^ {2}(\w+): /gm)].map((m) => m[1]));
    const called = new Set([...src.matchAll(/PAGE_SCRIPTS\.(\w+)/g)].map((m) => m[1]));
    for (const name of called) assert.ok(defined.has(name), `${dir} calls PAGE_SCRIPTS.${name}, which it does not define`);
  });
}
