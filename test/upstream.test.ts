import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { callUpstream, parseRpcBody, needsHandshake, isUnreachable } from '../src/daemon/upstream';
import { isLoopbackUrl } from '../src/util/localhost';
import { isOlder } from '../src/daemon/client';
import type { Registration } from '../src/daemon/protocol';

/** Spin up a throwaway MCP-ish server; returns its Registration and a stop(). */
async function serve(
  handler: (body: Record<string, unknown>, res: http.ServerResponse) => void,
): Promise<{ reg: Registration; seen: Record<string, unknown>[]; stop: () => Promise<void> }> {
  const seen: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push(body);
      handler(body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    seen,
    reg: { id: '/w', name: 'w', url: `http://127.0.0.1:${port}/mcp`, token: 't', pid: process.pid },
    stop: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

const ok = (res: http.ServerResponse, id: unknown, result: unknown): void => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
};

test('a wedged window fails with a deadline instead of hanging forever', async () => {
  // The critical case: host alive (so prune keeps it), server never replies.
  const s = await serve(() => undefined);
  const started = Date.now();
  await assert.rejects(
    () => callUpstream(s.reg, 'tools/call', {}, { timeoutMs: 300 }),
    /did not respond within/,
    'a hung upstream must surface a timeout, not block the agent indefinitely',
  );
  assert.ok(Date.now() - started < 3000, 'must give up promptly');
  await s.stop();
});

test('a timeout is classified as unreachable, so the registration gets dropped', () => {
  assert.ok(isUnreachable(new Error('"w" did not respond within 30s')));
  assert.ok(isUnreachable(new Error('connect ECONNREFUSED 127.0.0.1:5000')));
  assert.ok(!isUnreachable(new Error('page crashed')), 'a real tool error must not evict the window');
});

test('a normal call returns the result', async () => {
  const s = await serve((body, res) => ok(res, body.id, { content: [{ type: 'text', text: 'hi' }] }));
  const r = (await callUpstream(s.reg, 'tools/call', { name: 'x' })) as { content: unknown[] };
  assert.equal((r.content[0] as { text: string }).text, 'hi');
  await s.stop();
});

test('a stateless server that never saw initialize is handshaken and retried once', async () => {
  let calls = 0;
  const s = await serve((body, res) => {
    calls++;
    if (body.method === 'initialize') return ok(res, body.id, { protocolVersion: '2025-06-18' });
    if (calls === 1) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { message: 'Server not initialized' } }));
    }
    return ok(res, body.id, { content: [{ type: 'text', text: 'after handshake' }] });
  });
  const r = (await callUpstream(s.reg, 'tools/call', {})) as { content: { text: string }[] };
  assert.equal(r.content[0].text, 'after handshake');
  assert.deepEqual(s.seen.map((b) => b.method), ['tools/call', 'initialize', 'tools/call']);
  await s.stop();
});

test('a genuine tool error propagates rather than being retried', async () => {
  const s = await serve((body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { message: 'no such page' } }));
  });
  await assert.rejects(() => callUpstream(s.reg, 'tools/call', {}), /no such page/);
  assert.equal(s.seen.length, 1, 'must not handshake-retry an ordinary error');
  await s.stop();
});

test('the bearer token and JSON-RPC envelope reach the window', async () => {
  let auth: string | undefined;
  const server = http.createServer((req, res) => {
    auth = req.headers.authorization;
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => ok(res, JSON.parse(raw).id, {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await callUpstream(
    { id: '/w', name: 'w', url: `http://127.0.0.1:${port}/mcp`, token: 'secret-xyz', pid: process.pid },
    'tools/list',
    {},
  );
  assert.equal(auth, 'Bearer secret-xyz');
  await new Promise<void>((r) => server.close(() => r()));
});

test('an SSE-framed reply is parsed as well as plain JSON', () => {
  assert.deepEqual(parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{"a":1}}').result, { a: 1 });
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":2}}\n\n';
  assert.deepEqual(parseRpcBody(sse).result, { a: 2 });
});

test('only initialization errors trigger a handshake', () => {
  assert.ok(needsHandshake('Server not initialized'));
  assert.ok(needsHandshake('Received request before initialization was complete'));
  assert.ok(!needsHandshake('no such page'));
  assert.ok(!needsHandshake(undefined));
});

test('registrations may only point at this machine', () => {
  assert.ok(isLoopbackUrl('http://127.0.0.1:39273/mcp'));
  assert.ok(isLoopbackUrl('http://localhost:5000/mcp'));
  assert.ok(!isLoopbackUrl('http://evil.example.com/mcp'), 'we send a bearer token to this URL');
  assert.ok(!isLoopbackUrl('http://169.254.169.254/latest/meta-data'), 'cloud metadata must be refused');
  assert.ok(!isLoopbackUrl('file:///etc/passwd'));
  assert.ok(!isLoopbackUrl('not a url'));
});

test('a daemon is never restarted into an OLDER build', () => {
  // A window still running an older release must not drag a shared daemon backwards:
  // otherwise two builds take turns restarting it, and every restart knocks the other
  // windows' agents offline.
  assert.ok(isOlder('0.5.20', '0.5.23'), 'older build sees a newer daemon');
  assert.ok(!isOlder('0.5.23', '0.5.20'), 'newer build may replace an older daemon');
  assert.ok(!isOlder('0.5.23', '0.5.23'), 'same version is not older');
  assert.ok(isOlder('0.9.0', '1.0.0'), 'major bumps compare numerically, not lexically');
  assert.ok(!isOlder('0.10.0', '0.9.0'), '10 is newer than 9 — string compare would get this wrong');
  assert.ok(!isOlder('weird', '0.5.0'), 'unparseable versions never count as older');
});
