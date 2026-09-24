import { test } from 'node:test';
import assert from 'node:assert/strict';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TabLog } = require('../app/capture.js') as typeof import('../app/capture.js');

test('console messages, exceptions and browser log lines land in one list with levels and positions', () => {
  const log = new TabLog();
  log.onEvent('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'string', value: 'slow' }, { type: 'number', value: 3 }], stackTrace: { callFrames: [{ url: 'https://a.test/app.js', lineNumber: 41 }] } }, 'https://a.test/');
  log.onEvent('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', url: 'https://a.test/app.js', lineNumber: 9, exception: { description: 'TypeError: x is not a function\n    at y' } } }, 'https://a.test/');
  log.onEvent('Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'Failed to load resource: the server responded with a status of 404 ()', url: 'https://a.test/missing.png' } }, 'https://a.test/');
  const { entries } = log.consoleSince();
  assert.deepEqual(entries.map((e) => [e.level, e.source, e.line]), [['warning', 'console', 42], ['error', 'exception', 10], ['error', 'network', undefined]]);
  assert.equal(entries[0].text, 'slow 3');
  assert.ok(entries[1].text.startsWith('TypeError'));
  assert.equal(log.consoleSince(0, { level: 'error' }).entries.length, 2);
  assert.equal(log.consoleSince(entries[1].seq).entries.length, 1, 'since is a cursor');
});

test('a request gets its status, a failure gets its error, and a redirect becomes two rows', () => {
  const log = new TabLog();
  log.onEvent('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://a.test/api', method: 'POST' }, type: 'XHR', timestamp: 10 }, 'https://a.test/');
  log.onEvent('Network.responseReceived', { requestId: 'r1', response: { status: 500, statusText: 'Server Error', mimeType: 'application/json' } }, 'https://a.test/');
  log.onEvent('Network.loadingFinished', { requestId: 'r1', timestamp: 10.25 }, 'https://a.test/');
  log.onEvent('Network.requestWillBeSent', { requestId: 'r2', request: { url: 'https://a.test/img.png', method: 'GET' }, type: 'Image', timestamp: 11 }, 'https://a.test/');
  log.onEvent('Network.loadingFailed', { requestId: 'r2', errorText: 'net::ERR_CONNECTION_REFUSED', timestamp: 11.1 }, 'https://a.test/');
  log.onEvent('Network.requestWillBeSent', { requestId: 'r3', request: { url: 'https://a.test/old', method: 'GET' }, type: 'Document', timestamp: 12 }, 'https://a.test/');
  log.onEvent('Network.requestWillBeSent', { requestId: 'r3', request: { url: 'https://a.test/new', method: 'GET' }, type: 'Document', timestamp: 12.05, redirectResponse: { status: 301, statusText: 'Moved' } }, 'https://a.test/');
  log.onEvent('Network.requestWillBeSent', { requestId: 'r4', request: { url: 'data:text/plain,hi', method: 'GET' }, timestamp: 13 }, 'https://a.test/');
  const { entries, pending } = log.requestsSince();
  assert.deepEqual(entries.map((r) => [r.url, r.status, r.error]), [
    ['https://a.test/api', 500, undefined],
    ['https://a.test/img.png', undefined, 'net::ERR_CONNECTION_REFUSED'],
    ['https://a.test/old', 301, undefined],
    ['https://a.test/new', undefined, undefined],
  ]);
  assert.equal(entries[0].durationMs, 250);
  assert.equal(pending, 1, 'the second redirect hop has not answered yet');
  assert.ok(!('_start' in entries[0]), 'timing scratch stays private');
  assert.deepEqual(log.requestsSince(0, { failedOnly: true }).entries.map((r) => r.url), ['https://a.test/api', 'https://a.test/img.png']);
  assert.deepEqual(log.requestsSince(0, { urlContains: '/new' }).entries.map((r) => r.url), ['https://a.test/new']);
});

test('the log is a ring: old rows fall off and stop being addressable by request id', () => {
  const log = new TabLog(3);
  for (let i = 0; i < 5; i++) log.onEvent('Network.requestWillBeSent', { requestId: `r${i}`, request: { url: `https://a.test/${i}`, method: 'GET' }, timestamp: i }, 'https://a.test/');
  log.onEvent('Network.responseReceived', { requestId: 'r0', response: { status: 200 } }, 'https://a.test/');
  assert.deepEqual(log.requestsSince().entries.map((r) => r.url), ['https://a.test/2', 'https://a.test/3', 'https://a.test/4']);
});
