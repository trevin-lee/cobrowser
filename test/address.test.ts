import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAddress, SEARCH_URL } from '../src/browser/address';

const search = (q: string) => SEARCH_URL + encodeURIComponent(q);

test('local addresses load over http, where development servers and devices are', () => {
  assert.equal(resolveAddress('localhost:3000'), 'http://localhost:3000');
  assert.equal(resolveAddress('localhost'), 'http://localhost');
  assert.equal(resolveAddress('127.0.0.1:8080/api?x=1'), 'http://127.0.0.1:8080/api?x=1');
  assert.equal(resolveAddress('192.168.1.1'), 'http://192.168.1.1');
  assert.equal(resolveAddress('app.localhost:5173'), 'http://app.localhost:5173');
  assert.equal(resolveAddress('printer.local'), 'http://printer.local');
  assert.equal(resolveAddress('nas:5000'), 'http://nas:5000');
  assert.equal(resolveAddress('[::1]:8080'), 'http://[::1]:8080');
});

test('domains load over https, and anything with a scheme loads as typed', () => {
  assert.equal(resolveAddress('example.com'), 'https://example.com');
  assert.equal(resolveAddress('github.com/trevin-lee/cobrowser'), 'https://github.com/trevin-lee/cobrowser');
  assert.equal(resolveAddress(' http://localhost:3000 '), 'http://localhost:3000');
  assert.equal(resolveAddress('https://a.b/c'), 'https://a.b/c');
  assert.equal(resolveAddress('about:blank'), 'about:blank');
});

test('words are a search, not an address', () => {
  assert.equal(resolveAddress('cobrowser mcp docs'), search('cobrowser mcp docs'));
  assert.equal(resolveAddress('cobrowser'), search('cobrowser'));
  assert.equal(resolveAddress('what is 2+2?'), search('what is 2+2?'));
  assert.equal(resolveAddress(''), '');
});
