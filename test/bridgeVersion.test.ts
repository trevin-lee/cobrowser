import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const read = (f: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')) as { version: string };

test('the bridge add-ons carry the extension\'s version, which is how an out-of-date add-on is noticed', () => {
  const { version } = read('package.json');
  assert.equal(read('chrome-extension/manifest.json').version, version);
  assert.equal(read('firefox-extension/manifest.json').version, version);
});
