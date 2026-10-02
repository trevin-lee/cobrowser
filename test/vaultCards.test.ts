import { test } from 'node:test';
import assert from 'node:assert/strict';

type Card = { id: string; label: string; name: string; number: string; expMonth: number; expYear: number; cvc: string };
type Vault = { entries: unknown[]; cards?: Card[] };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require('../app/vault-store.js') as {
  addCard: (v: Vault, f: Record<string, string>) => Card;
  updateCard: (v: Vault, id: string, f: Record<string, string | null>) => Card;
  exportCards: (v: Vault) => string;
  importCards: (v: Vault, text: string) => { count: number; added: number; replaced: number; skipped: number };
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
  assert.deepEqual(pub, { id: c.id, label: 'Work', brand: 'Mastercard', last4: '4444', exp: '12/30', name: '', hasCode: true, notes: '' });
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

test('a card is saved once; its last four find it only when all four are given and only one card ends so', () => {
  const v: Vault = { entries: [] };
  store.addCard(v, { number: '4242424242424242', exp: '01/30', label: 'Personal' });
  assert.throws(() => store.addCard(v, { number: '4242 4242 4242 4242', exp: '02/31' }), /already saved, as Personal/);
  assert.equal(store.findCard(v, '2'), undefined);
  assert.equal(store.findCard(v, '4242')?.label, 'Personal');
  store.addCard(v, { number: '4000000000024242', exp: '01/30' });
  assert.equal(store.findCard(v, '4242'), undefined, 'two cards end in 4242: name one');
});

test('a saved security code can be removed again', () => {
  const v: Vault = { entries: [] };
  const c = store.addCard(v, { number: '4242424242424242', exp: '01/30', cvc: '123' });
  store.updateCard(v, c.id, { cvc: '' });
  assert.equal(c.cvc, '123', 'blank keeps it');
  store.updateCard(v, c.id, { cvc: null });
  assert.equal(c.cvc, '');
});

test('cards export to a CSV of their own and import back whole; a card already saved is updated, not doubled', () => {
  const v: Vault = { entries: [] };
  store.addCard(v, { number: '4242424242424242', exp: '01/30', cvc: '123', label: 'Personal', name: 'Ada Lovelace', notes: 'For **groceries**, "and" more' } as never);
  const csv = store.exportCards(v);
  assert.match(csv, /^label,name,number,expiry,code,notes\n/);
  const back: Vault = { entries: [] };
  assert.deepEqual(store.importCards(back, csv), { count: 1, added: 1, replaced: 0, skipped: 0 });
  const c = back.cards![0] as Card & { notes?: string };
  assert.deepEqual([c.label, c.name, c.number, c.expMonth, c.expYear, c.cvc, c.notes], ['Personal', 'Ada Lovelace', '4242424242424242', 1, 2030, '123', 'For **groceries**, "and" more']);
  assert.deepEqual(store.importCards(back, csv), { count: 1, added: 0, replaced: 1, skipped: 0 });
  assert.equal(back.cards!.length, 1);
  const other = 'Card Number,Expiration Month,Expiration Year,CVV,Cardholder Name\n5555555555554444,12,2031,999,Bo\n1234,1,2030,,x\n';
  assert.deepEqual(store.importCards(back, other), { count: 1, added: 1, replaced: 0, skipped: 1 });
  assert.throws(() => store.importCards(back, 'url,username,password\na.com,me,pw\n'), /card number and expiry/);
});
