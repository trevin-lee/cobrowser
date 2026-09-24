import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signedMarkerPath, APP_BUNDLE_ID } from '../src/app/signApp';

test('the signed marker sits beside Electron.app in the versioned cache dir, so a new Electron version starts unsigned', () => {
  const exe = '/cache/electron/electron-v44.4.5-darwin-arm64/Electron.app/Contents/MacOS/Electron';
  assert.equal(signedMarkerPath(exe), '/cache/electron/electron-v44.4.5-darwin-arm64/signed.json');
  assert.notEqual(signedMarkerPath(exe.replace('44.4.5', '45.0.0')), signedMarkerPath(exe));
});

test('the bundle id is a fixed reverse-DNS name (it is also the keychain namespace for passkeys)', () => {
  assert.match(APP_BUNDLE_ID, /^[a-z]+(\.[a-z]+)+$/);
});
