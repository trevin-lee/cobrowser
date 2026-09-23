import { test } from 'node:test';
import assert from 'node:assert/strict';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseSite, siteMatches, registrable } = require('../app/site.js') as {
  parseSite: (s: string) => { host: string; port: string };
  siteMatches: (a: { host: string; port: string }, b: { host: string; port: string }) => boolean;
  registrable: (h: string) => string;
};

const m = (saved: string, page: string): boolean => siteMatches(parseSite(saved), parseSite(page));

test('real domains match by registrable domain', () => {
  assert.ok(m('costco.com', 'https://signin.costco.com/x'));
  assert.ok(m('https://www.github.com', 'https://github.com/login'));
  assert.ok(!m('costco.com', 'https://costco.com.evil.example/'), 'a lookalike suffix must not match');
  assert.ok(!m('github.com', 'https://gitlab.com/'));
});

test('two-part public suffixes do not make unrelated sites match', () => {
  assert.equal(registrable('online.bank.co.uk'), 'bank.co.uk');
  assert.ok(m('bank.co.uk', 'https://online.bank.co.uk/'));
  assert.ok(!m('bank.co.uk', 'https://shop.co.uk/'), 'co.uk is a suffix, not a site');
  assert.ok(!m('a.com.au', 'https://b.com.au/'));
});

test('IP addresses match exactly — 192.168.x.y are different machines', () => {
  assert.ok(m('192.168.1.50', 'http://192.168.1.50/admin'));
  assert.ok(!m('192.168.1.50', 'http://192.168.2.50/'), 'last-two-labels would have said yes');
  assert.ok(!m('192.168.1.50', 'http://10.0.1.50/'));
  assert.ok(!m('10.0.0.1', 'http://10.0.0.10/'));
  assert.ok(m('[::1]', 'http://[::1]:3000/'));
});

test('single-label hosts match exactly', () => {
  assert.ok(m('localhost', 'http://localhost:5173/'));
  assert.ok(m('nas', 'http://nas/'));
  assert.ok(!m('nas', 'http://nas2/'));
  assert.ok(!m('localhost', 'http://localhost.evil.example/'));
});

test('a saved port must match; no saved port matches any port', () => {
  assert.ok(m('192.168.1.50:8080', 'http://192.168.1.50:8080/'));
  assert.ok(!m('192.168.1.50:8080', 'http://192.168.1.50:9090/'), 'different service on the same box');
  assert.ok(!m('192.168.1.50:8080', 'http://192.168.1.50/'));
  assert.ok(m('192.168.1.50', 'http://192.168.1.50:9090/'), 'no port saved → any port');
  assert.ok(m('localhost:3000', 'http://localhost:3000/login'));
  assert.ok(!m('localhost:3000', 'http://localhost:4000/'));
});

test('parseSite accepts what people actually type', () => {
  assert.deepEqual(parseSite('costco.com'), { host: 'costco.com', port: '' });
  assert.deepEqual(parseSite('https://signin.costco.com/a/b?c'), { host: 'signin.costco.com', port: '' });
  assert.deepEqual(parseSite('192.168.1.50:8080'), { host: '192.168.1.50', port: '8080' });
  assert.deepEqual(parseSite('  Localhost:3000 '), { host: 'localhost', port: '3000' });
  assert.deepEqual(parseSite('http://[::1]:3000/'), { host: '[::1]', port: '3000' });
});
