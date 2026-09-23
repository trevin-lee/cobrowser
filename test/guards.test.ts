import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The guard patterns live in the extension (plain JS, injected into pages), so they are read
 * out of the source rather than imported. Pinning them here because a regression is not a
 * crash: it is an agent clicking "Sign out" on a bank, or typing into a password box. That
 * already happened once, which is why these exist.
 */
const src = fs.readFileSync(
  path.join(__dirname, '..', 'firefox-extension', 'background.js'),
  'utf8',
);

function pattern(name: string): RegExp {
  const m = new RegExp(`^const ${name} = (/.*/[gimsuy]*);$`, 'm').exec(src);
  assert.ok(m, `pattern ${name} not found in background.js`);
  const body = m![1];
  const lastSlash = body.lastIndexOf('/');
  return new RegExp(body.slice(1, lastSlash), body.slice(lastSlash + 1));
}

const DESTRUCTIVE = pattern('DESTRUCTIVE');
const CREDENTIAL = pattern('CREDENTIAL');
const COMMITTING = pattern('COMMITTING');

test('the labels that signed the user out of their bank are caught', () => {
  for (const label of ['Sign out', 'Sign Out', 'Log out', 'Logout', 'LOG OUT']) {
    assert.ok(DESTRUCTIVE.test(label), `${label} must be refused by default`);
  }
});

test('account-destroying controls are caught', () => {
  for (const label of [
    'Delete account',
    'Close account',
    'Cancel subscription',
    'Cancel membership',
    'Deactivate',
  ]) {
    assert.ok(DESTRUCTIVE.test(label), `${label} must be refused by default`);
  }
});

test('ordinary controls are NOT refused — the guard must not block real work', () => {
  for (const label of [
    'Load more orders',
    'View order detail',
    'Sign in',
    'Continue',
    'Download CSV',
    'Delete item from cart',
    'Cancel', // a bare dialog Cancel is not "cancel account"
  ]) {
    assert.ok(!DESTRUCTIVE.test(label), `${label} must remain clickable`);
  }
});

test('money-moving buttons are held back for the human', () => {
  for (const label of ['Pay now', 'Confirm payment', 'Place order', 'Send money', 'Transfer now']) {
    assert.ok(COMMITTING.test(label), `${label} is the human's click`);
  }
  assert.ok(!COMMITTING.test('View payment history'), 'reading is not committing');
  assert.ok(!COMMITTING.test('Payment methods'), 'browsing settings is not committing');
});

test('credential fields are refused by what they call themselves', () => {
  for (const desc of [
    'password',
    'current-password',
    'One-time code',
    'otp',
    'verification code',
    'Security code',
    'cvv',
    'card number',
    'ssn',
  ]) {
    assert.ok(CREDENTIAL.test(desc), `${desc} must never be auto-filled`);
  }
});

test('ordinary fields are still fillable', () => {
  for (const desc of ['email', 'search', 'date-range', 'quantity', 'street address', 'coupon code']) {
    assert.ok(!CREDENTIAL.test(desc), `${desc} should be fillable`);
  }
});

test('throttle and cap constants are present and sane', () => {
  const num = (name: string): number => {
    const m = new RegExp(`^const ${name} = (\\d+);$`, 'm').exec(src);
    assert.ok(m, `${name} missing`);
    return Number(m![1]);
  };
  const min = num('THROTTLE_MIN_MS');
  const max = num('THROTTLE_MAX_MS');
  const cap = num('SESSION_REQUEST_CAP');
  assert.ok(min >= 1000, 'a sub-second floor is not human pace');
  assert.ok(max > min, 'jitter needs a range');
  assert.ok(cap > 0 && cap <= 500, 'a per-session cap must exist and be a real ceiling');
});
