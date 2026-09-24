import { test } from 'node:test';
import assert from 'node:assert/strict';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { userAgent, acceptLanguages, metadata, BRAND } = require('../app/identity.js') as typeof import('../app/identity.js');

test('the UA is the standard reduced Chromium UA with a Cobrowser token, never Google Chrome', () => {
  const ua = userAgent('152.0.7977.130', '0.8.0');
  assert.equal(ua, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Cobrowser/0.8.0');
  assert.ok(!ua.includes('Electron') && !ua.includes('Headless'));
});

test('client hints name Chromium and Cobrowser, not Google Chrome, with real versions', () => {
  const m = metadata({ chromeVersion: '152.0.7977.130', appVersion: '0.8.0', osVersion: '26.0', arch: 'arm64' });
  assert.deepEqual(m.brands.map((b) => b.brand).sort(), ['Chromium', BRAND, 'Not?A_Brand'].sort());
  assert.ok(!JSON.stringify(m).includes('Google Chrome'));
  assert.equal(m.fullVersionList.find((b) => b.brand === 'Chromium')?.version, '152.0.7977.130');
  assert.equal(m.fullVersionList.find((b) => b.brand === BRAND)?.version, '0.8.0');
  assert.equal(m.platformVersion, '26.0.0');
  assert.equal(m.architecture, 'arm');
});

test('the language list comes from the OS languages, base languages added, no q-values (Chromium adds those)', () => {
  assert.equal(acceptLanguages(['en-US']), 'en-US,en');
  assert.equal(acceptLanguages(['de-DE', 'en-US']), 'de-DE,de,en-US,en');
  assert.equal(acceptLanguages([]), 'en-US,en');
});
