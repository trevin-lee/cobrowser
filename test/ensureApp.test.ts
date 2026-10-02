import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceReason } from '../src/app/ensureApp';

const mine = { version: '0.9.18', build: 'b2', signed: false, unbranded: false };

test('the running app is replaced only by a newer extension, or by the same version built differently', () => {
  assert.match(replaceReason({ version: '0.9.17', build: 'b1', webauthn: false }, mine) ?? '', /older than this extension/);
  assert.match(replaceReason({ version: '0.9.18', build: 'b1', webauthn: false }, mine) ?? '', /older build of this version/);
  assert.equal(replaceReason({ version: '0.9.18', build: 'b2', webauthn: false }, mine), undefined);
});

test('a window still on the old extension never swaps a newer app back to its own', () => {
  const old = { version: '0.9.17', build: 'b1', signed: true, unbranded: true };
  assert.equal(replaceReason({ version: '0.9.18', build: 'b2', webauthn: false }, old), undefined);
});

test('the same version restarts to take on its name and icon, or its passkey signing', () => {
  assert.match(replaceReason({ version: '0.9.18', build: 'b2', webauthn: false }, { ...mine, unbranded: true }) ?? '', /renamed/);
  assert.match(replaceReason({ version: '0.9.18', build: 'b2', webauthn: false }, { ...mine, signed: true }) ?? '', /signed for passkeys/);
  assert.equal(replaceReason({ version: '0.9.18', build: 'b2', webauthn: true }, { ...mine, signed: true }), undefined);
});
