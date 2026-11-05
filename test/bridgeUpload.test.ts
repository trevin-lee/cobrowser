import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { callZenTool, BRIDGE_UPLOAD_MAX_BYTES, type ConfirmUpload } from '../src/daemon/zenTools';
import type { ZenHub } from '../src/daemon/zenHub';

/** An add-on that finds a file input and records what it was sent. */
function fakeHub(target: Record<string, unknown>) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const hub = {
    status: () => ({ connected: true, browser: 'chrome' }),
    call: async (_ws: string, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return method === 'uploadTarget' ? target : { uploaded: ((params.files as { name: string }[]) ?? []).map((f) => f.name), host: 'jobs.example' };
    },
  } as unknown as ZenHub;
  return { hub, calls };
}
const text = (r: { content: { type: string; text?: string }[] }) => JSON.parse(r.content[0].text!);

test('a bridge upload finds the input, asks the human by site and browser, then sends the files with their type', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobrowser-bridge-up-'));
  const file = path.join(dir, 'cv.pdf');
  fs.writeFileSync(file, '%PDF-1.4');
  const { hub, calls } = fakeHub({ upload: 'cb_upload_x', multiple: false, host: 'jobs.example' });
  const asked: unknown[] = [];
  const confirmUpload: ConfirmUpload = async (paths, host, browser) => { asked.push([paths, host, browser]); return { files: [{ path: file, name: 'cv.pdf', size: 8 }] }; };
  const r = text(await callZenTool(hub, '/ws', 'bridge_upload_file', { tabId: 3, uid: 'cb1', filePaths: [file] }, { confirmUpload }));
  assert.deepEqual(r.uploaded, ['cv.pdf']);
  assert.deepEqual(asked, [[[file], 'jobs.example', 'chrome']]);
  assert.deepEqual(calls.map((c) => c.method), ['uploadTarget', 'upload']);
  assert.equal(calls[0].params.ref, 'cb1');
  assert.deepEqual(calls[1].params.files, [{ name: 'cv.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64') }]);
  assert.equal(calls[1].params.host, 'jobs.example', 'the page must still be on the site the human allowed');
});

test('mistakes are said before the human is asked, and a declined or oversized upload sends nothing', async () => {
  let asks = 0;
  const confirm = (answer: Awaited<ReturnType<ConfirmUpload>>): ConfirmUpload => async () => { asks++; return answer; };
  const none = fakeHub({ error: 'the page has no file input' });
  assert.match(text(await callZenTool(none.hub, '/ws', 'bridge_upload_file', { tabId: 1, filePaths: ['/a'] }, { confirmUpload: confirm({}) })).error, /no file input/);
  const single = fakeHub({ upload: 'u', multiple: false, host: 'h' });
  assert.match(text(await callZenTool(single.hub, '/ws', 'bridge_upload_file', { tabId: 1, filePaths: ['/a', '/b'] }, { confirmUpload: confirm({}) })).error, /takes one file/);
  assert.equal(asks, 0);
  const declined = fakeHub({ upload: 'u', multiple: true, host: 'h' });
  assert.equal(text(await callZenTool(declined.hub, '/ws', 'bridge_upload_file', { tabId: 1, filePaths: ['/a'] }, { confirmUpload: confirm({ declined: true, error: 'the human declined the upload' }) })).declined, true);
  const big = fakeHub({ upload: 'u', multiple: true, host: 'h' });
  assert.match(text(await callZenTool(big.hub, '/ws', 'bridge_upload_file', { tabId: 1, filePaths: ['/a'] }, { confirmUpload: confirm({ files: [{ path: '/nowhere', name: 'a', size: BRIDGE_UPLOAD_MAX_BYTES + 1 }] }) })).error, /over the bridge's 20 MB/);
  for (const h of [declined, big]) assert.deepEqual(h.calls.map((c) => c.method), ['uploadTarget'], 'nothing was sent');
});
