import { test } from 'node:test';
import assert from 'node:assert/strict';

type Card = { id: string; label: string; name: string; number: string; expMonth: number; expYear: number; cvc: string };
type Vault = { entries: unknown[]; cards?: Card[] };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require('../app/vault-store.js') as {
  addCard: (v: Vault, f: Record<string, string>) => Card;
  updateCard: (v: Vault, id: string, f: Record<string, string>) => Card;
  removeCard: (v: Vault, id: string) => number;
  findCard: (v: Vault, which?: string) => Card | undefined;
  publicCard: (c: Card) => Record<string, unknown>;
  cardBrand: (n: string) => string;
};

test('a card is checked when saved: its checksum, expiry and security code', () => {
  const v: Vault = { entries: [] };
  const c = store.addCard(v, { number: '4242 4242 4242 4242', exp: '3/29', cvc: '123', name: 'Ada' });
  assert.deepEqual([c.number, c.expMonth, c.expYear, c.cvc, c.label], ['4242424242424242', 3, 2029, '123', 'Visa 4242']);
  assert.throws(() => store.addCard(v, { number: '4242424242424241', exp: '3/29' }), /not a valid card number/);
  assert.throws(() => store.addCard(v, { number: '4242424242424242', exp: '13/29' }), /month/);
  assert.throws(() => store.addCard(v, { number: '4242424242424242', exp: '03/29', cvc: '12' }), /security code/);
  assert.deepEqual(['4111111111111111', '5555555555554444', '378282246310005', '6011111111111117'].map(store.cardBrand), ['Visa', 'Mastercard', 'American Express', 'Discover']);
});

test("what lists see of a card never includes its number or code", () => {
  const v: Vault = { entries: [] };
  const c = store.addCard(v, { number: '5555555555554444', exp: '12/2030', cvc: '999', label: 'Work' });
  const pub = store.publicCard(c);
  assert.deepEqual(pub, { id: c.id, label: 'Work', brand: 'Mastercard', last4: '4444', exp: '12/30', name: '', hasCode: true });
  assert.ok(!JSON.stringify(pub).includes('5555555555554444') && !JSON.stringify(pub).includes('999'));
});

test('editing keeps the number and code unless new ones are given; cards are found by label or last four', () => {
  const v: Vault = { entries: [] };
  const a = store.addCard(v, { number: '4242424242424242', exp: '01/30', cvc: '123', label: 'Personal' });
  store.addCard(v, { number: '5555555555554444', exp: '01/30' });
  store.updateCard(v, a.id, { label: 'Personal Visa', exp: '02/31' });
  assert.deepEqual([a.number, a.cvc, a.expMonth, a.expYear, a.label], ['4242424242424242', '123', 2, 2031, 'Personal Visa']);
  assert.equal(store.findCard(v, 'personal visa')?.id, a.id);
  assert.equal(store.findCard(v, '4444')?.label, 'Mastercard 4444');
  assert.equal(store.findCard(v), undefined, 'with two cards, one must be named');
  assert.equal(store.removeCard(v, a.id), 1);
  assert.equal(store.findCard(v)?.label, 'Mastercard 4444', 'with one card left, it is the one');
});
