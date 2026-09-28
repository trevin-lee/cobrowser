import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callZenTool } from '../src/daemon/zenTools';
import type { ZenHub } from '../src/daemon/zenHub';

/** A hub that answers like an installed add-on would, recording what it was asked. */
function fakeHub(answer: (params: Record<string, unknown>, n: number) => unknown) {
  const calls: Record<string, unknown>[] = [];
  const hub = { call: async (_ws: string, _method: string, params: Record<string, unknown>) => { calls.push(params); return answer(params, calls.length); } } as unknown as ZenHub;
  return { hub, calls };
}
const text = (r: { content: { type: string; text?: string }[] }) => JSON.parse(r.content[0].text!);

test('an old add-on\'s sign-out refusal is gone past: the click is re-issued', async () => {
  const { hub, calls } = fakeHub((p, n) => (n === 1 ? { refused: 'destructive', label: 'Sign out' } : { clicked: true, override: p.allowDestructive }));
  const r = text(await callZenTool(hub, '/ws', 'bridge_click', { tabId: 1, text: 'Sign out' }));
  assert.equal(calls.length, 2);
  assert.deepEqual(r, { clicked: true, override: true });
});

test('but never past a payment button', async () => {
  const { hub, calls } = fakeHub(() => ({ refused: 'destructive', label: 'Delete account and pay now' }));
  const r = text(await callZenTool(hub, '/ws', 'bridge_click', { tabId: 1, text: 'x' }));
  assert.equal(calls.length, 1);
  assert.equal(r.refused, 'payment');
});

test('allowPayment reaches the add-on under both its names; without it, neither is set', async () => {
  const { hub, calls } = fakeHub(() => ({ clicked: true }));
  await callZenTool(hub, '/ws', 'bridge_click', { tabId: 1, ref: 'cb1', allowPayment: true });
  await callZenTool(hub, '/ws', 'bridge_click', { tabId: 1, ref: 'cb1' });
  assert.equal(calls[0].allowPayment, true); assert.equal(calls[0].allowDestructive, true);
  assert.equal(calls[1].allowPayment, false); assert.equal(calls[1].allowDestructive, false);
});

test('tool names from the old add-on are brought up to date, in results and in errors', async () => {
  const ok = fakeHub(() => ({ hint: 'use a ref from firefox_snapshot' }));
  assert.equal(text(await callZenTool(ok.hub, '/ws', 'bridge_click', { tabId: 1 })).hint, 'use a ref from bridge_snapshot');
  const bad = { call: async () => { throw new Error('Pass exact:true, or use a ref from firefox_snapshot.'); } } as unknown as ZenHub;
  await assert.rejects(callZenTool(bad, '/ws', 'bridge_click', { tabId: 1 }), /bridge_snapshot/);
});

test('a click that changed nothing comes back pointing at the panel, where input is real', async () => {
  const { hub } = fakeHub(() => ({ clicked: 'cb3', noVisibleEffect: true }));
  const r = text(await callZenTool(hub, '/ws', 'bridge_click', { tabId: 1, ref: 'cb3' }));
  assert.equal(r.noVisibleEffect, true);
  assert.match(r.hint, /panel/);
  const { hub: ok } = fakeHub(() => ({ clicked: 'cb3' }));
  assert.equal(text(await callZenTool(ok, '/ws', 'bridge_click', { tabId: 1, ref: 'cb3' })).hint, undefined);
});

test('settle reaches the add-on with its quiet time', async () => {
  const { hub, calls } = fakeHub(() => ({ found: true, settled: true }));
  await callZenTool(hub, '/ws', 'bridge_wait_for', { tabId: 1, settle: true, quietMs: 800 });
  assert.equal(calls[0].settle, true);
  assert.equal(calls[0].quietMs, 800);
});
