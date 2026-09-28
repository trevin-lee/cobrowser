import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TAB_TITLE_MAX, fullTabTitle, tabLabel } from '../src/webview/tabTitle';

const graphemeCount = (s: string): number => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)).length;

test('a short title is shown as it is', () => {
  assert.equal(tabLabel('GitHub', 'https://github.com/'), 'GitHub');
  assert.equal(tabLabel('x'.repeat(DEFAULT_TAB_TITLE_MAX), 'https://a.test/'), 'x'.repeat(DEFAULT_TAB_TITLE_MAX));
});

test('a long title is cut to the limit, ellipsis included', () => {
  const long = 'Checkout – Review your order and confirm shipping details | Example Store';
  const label = tabLabel(long, 'https://shop.test/checkout');
  assert.ok(label.endsWith('…'), label);
  assert.ok(graphemeCount(label) <= DEFAULT_TAB_TITLE_MAX, label);
  assert.ok(long.startsWith(label.slice(0, -1)), 'it is the start of the title');
});

test('a cut never leaves a dangling separator or space before the ellipsis', () => {
  assert.equal(tabLabel('Stripe Dashboard | Payments overview and more', 'https://x.test/', 20), 'Stripe Dashboard…');
  assert.equal(tabLabel('Inbox (3) - someone@example.com - Mail', 'https://x.test/', 12), 'Inbox (3)…');
});

test('an emoji or accented letter is never split', () => {
  // The family emoji is one character made of seven code points; it stays whole.
  assert.equal(tabLabel('👩‍👩‍👧‍👦 Family photos from the summer trip', 'https://x.test/', 10), '👩‍👩‍👧‍👦 Family…');
  assert.equal(tabLabel('Photos 👩‍👩‍👧‍👦👩‍👩‍👧‍👦 from the trip', 'https://x.test/', 9), 'Photos 👩‍👩‍👧‍👦…');
  assert.equal(tabLabel('Café résumé naïveté déjà vu encore', 'https://x.test/', 10), 'Café résu…');
});

test('whitespace and line breaks in a title collapse to single spaces', () => {
  assert.equal(fullTabTitle('  Order\n\n  history\t page ', 'https://x.test/'), 'Order history page');
});

test('a page with no title shows its address, and a blank page shows New Tab', () => {
  assert.equal(tabLabel('', 'https://example.com/orders/123'), 'example.com/orders/123');
  assert.equal(tabLabel('   ', 'http://localhost:3000/'), 'localhost:3000');
  assert.equal(tabLabel('', 'about:blank'), 'New Tab');
  assert.equal(tabLabel('', ''), 'New Tab');
});

test('0 means no limit, and a tiny limit is raised to a readable one', () => {
  const long = 'A very long title that goes on well past any sensible tab width';
  assert.equal(tabLabel(long, 'https://x.test/', 0), long);
  assert.equal(tabLabel(long, 'https://x.test/', 3), 'A very…'); // raised to 8; the cut's trailing space is dropped
  assert.ok(graphemeCount(tabLabel(long, 'https://x.test/', 3)) <= 8);
});
