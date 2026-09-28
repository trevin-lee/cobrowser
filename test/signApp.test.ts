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

import { chooseIdentity, signingState, type SigningIdentity } from '../src/app/signApp';

const id = (team: string, paid: boolean, developerId = false): SigningIdentity => ({
  name: `${developerId ? 'Developer ID Application' : 'Apple Development'}: Someone (${team})`,
  team,
  teamName: `Team ${team}`,
  paid,
  developerId,
});

test('without a requested team, signing prefers Developer ID, then a paid team, then anything', () => {
  const free = id('FREE000001', false), paid = id('PAID000001', true), devId = id('PAID000001', true, true);
  assert.equal(chooseIdentity([free, paid])?.team, 'PAID000001', 'a paid team beats a free one (a year, not 7 days)');
  assert.equal(chooseIdentity([free, paid, devId])?.developerId, true);
  assert.equal(chooseIdentity([free])?.team, 'FREE000001');
  assert.equal(chooseIdentity([]), undefined);
});

test('a requested team is used, or nothing: renewal must not silently switch teams', () => {
  const free = id('FREE000001', false), paid = id('PAID000001', true);
  assert.equal(chooseIdentity([paid, free], 'FREE000001')?.team, 'FREE000001');
  assert.equal(chooseIdentity([paid], 'GONE000001'), undefined);
});

test('the signing is renewed only once it has expired (Xcode returns the same profile before that)', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  const days = (n: number) => new Date(now.getTime() + n * 86400000);
  assert.equal(signingState(undefined, now), 'unsigned');
  assert.equal(signingState(days(365), now), 'ok');
  assert.equal(signingState(days(1), now), 'ok');
  assert.equal(signingState(now, now), 'expired');
  assert.equal(signingState(days(-1), now), 'expired');
});
