import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { COMMITTING as SHARED_COMMITTING, CREDENTIAL as SHARED_CREDENTIAL } from '../src/browser/guards';

/**
 * One rule for both browsers the agent drives (src/browser/guards.ts): no clicking a button
 * that pays or places an order, no typing a password, one-time code or card number. The
 * browser extensions run in pages and carry copies of the patterns, read here out of their
 * source; the copies must equal the shared ones, so the two tool families cannot drift.
 */
const EXTENSIONS = ['firefox-extension', 'chrome-extension'].map((dir) => ({
  dir,
  src: fs.readFileSync(path.join(__dirname, '..', dir, 'background.js'), 'utf8'),
}));
const src = EXTENSIONS[0].src;

function patternIn(source: string, name: string): RegExp {
  const m = new RegExp(`^const ${name} = (/.*/[gimsuy]*);$`, 'm').exec(source);
  assert.ok(m, `pattern ${name} not found`);
  const body = m![1];
  const lastSlash = body.lastIndexOf('/');
  return new RegExp(body.slice(1, lastSlash), body.slice(lastSlash + 1));
}

const CREDENTIAL = SHARED_CREDENTIAL;
const COMMITTING = SHARED_COMMITTING;

test('both extensions carry exactly the shared patterns', () => {
  for (const { dir, src: source } of EXTENSIONS) {
    assert.equal(patternIn(source, 'COMMITTING').source, SHARED_COMMITTING.source, `${dir}: COMMITTING`);
    assert.equal(patternIn(source, 'CREDENTIAL').source, SHARED_CREDENTIAL.source, `${dir}: CREDENTIAL`);
  }
});

test('sign-out and delete-account controls are not refused in either extension (never part of the rule)', () => {
  for (const { dir, src: source } of EXTENSIONS) {
    assert.ok(!/DESTRUCTIVE|found\.destructive/.test(source), `${dir} still carries the sign-out guard`);
  }
  for (const label of ['Sign out', 'Log out', 'Delete account', 'Cancel subscription']) {
    assert.ok(!COMMITTING.test(label), `${label} is not a payment`);
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

import { humanTabRefusal } from '../src/browser/guards';

test('both add-ons refuse to close a human\'s tab with the shared words, and take the same override', () => {
  const words = humanTabRefusal(1).needsUserAction;
  for (const { dir, src: code } of EXTENSIONS) {
    assert.ok(code.includes(`needsUserAction: '${words}'`), `${dir} says something else`);
    assert.ok(code.includes("params.allowHumanTab !== true"), `${dir} has no allowHumanTab override`);
  }
});
