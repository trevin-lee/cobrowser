import type { Registration } from './protocol';

/** A wedged window is worse than an absent one: its host is alive, so prune() keeps the
 *  registration, and without a deadline every call to it would hang the agent forever. */
export const UPSTREAM_TIMEOUT_MS = 30_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface UpstreamOptions {
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Identifies us in the handshake if a stateless server demands one. */
  version?: string;
}

/** JSON-RPC ids only need to be unique per connection. */
let rpcId = 0;

/**
 * Parse a JSON-RPC reply that may arrive as plain JSON or SSE-framed.
 *
 * The window's transport runs with `enableJsonResponse`, so plain JSON is the normal case;
 * tolerating SSE keeps this working if that is ever switched back to streaming.
 */
export function parseRpcBody(text: string): Record<string, unknown> {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    const last = trimmed
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .pop();
    if (!last) throw new Error('SSE reply carried no data frame');
    return JSON.parse(last.slice('data:'.length).trim()) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** Does this error mean "the server never saw initialize"? Stateless servers are rebuilt per
 *  POST, so a tools/* call can land on an instance that never shook hands. */
export function needsHandshake(message: string | undefined): boolean {
  return /not initialized|initialization/i.test(message ?? '');
}

/**
 * One JSON-RPC round trip to a window's MCP server, with a deadline.
 *
 * On a "not initialized" error we shake hands and retry once, rather than failing the
 * agent's call for an implementation detail of stateless transports.
 */
export async function callUpstream(
  reg: Registration,
  method: string,
  params: unknown,
  opts: UpstreamOptions = {},
): Promise<unknown> {
  const { timeoutMs = UPSTREAM_TIMEOUT_MS, fetchImpl = fetch as FetchLike, version = '0.0.0' } = opts;

  const send = async (m: string, p: unknown): Promise<Record<string, unknown>> => {
    const res = await fetchImpl(reg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${reg.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: m, params: p ?? {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return parseRpcBody(await res.text());
  };

  let body: Record<string, unknown>;
  try {
    body = await send(method, params);
  } catch (e) {
    // Surface a deadline as something an agent can act on, not a bare DOMException.
    if ((e as Error)?.name === 'TimeoutError' || /aborted|timeout/i.test(String(e))) {
      throw new Error(`"${reg.name}" did not respond within ${timeoutMs / 1000}s`);
    }
    throw e;
  }

  const err = body.error as { message?: string } | undefined;
  if (err && needsHandshake(err.message)) {
    await send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'cobrowserd', version },
    });
    const retried = await send(method, params);
    const retryErr = retried.error as { message?: string } | undefined;
    if (retryErr) throw new Error(retryErr.message ?? 'upstream error');
    return retried.result;
  }
  if (err) throw new Error(err.message ?? 'upstream error');
  return body.result;
}

/** Is this failure the window being gone, rather than the call failing? */
export function isUnreachable(e: unknown): boolean {
  return /ECONNREFUSED|fetch failed|did not respond/i.test(String(e));
}
