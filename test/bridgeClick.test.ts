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

test('allowPayment reaches the add-on only when given', async () => {
  const { hub, calls } = fakeHub(() => ({ clicked: true }));
  await callZenTool(hub, '/ws', 'bridge_click', { tabId: 1, uid: 'cb1', allowPayment: true });
  await callZenTool(hub, '/ws', 'bridge_click', { tabId: 1, uid: 'cb1' });
  assert.equal(calls[0].allowPayment, true);
  assert.equal(calls[1].allowPayment, false);
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
