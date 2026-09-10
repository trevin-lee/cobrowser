import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickColumn } from '../src/webview/columns';

test('the regression that fragmented the editor: no visible panels still targets the claimed pane', () => {
  // VS Code reports viewColumn as undefined for every panel that is not the active tab in
  // its group. Deriving the target from live panels alone therefore returned undefined the
  // moment the human looked at a code file, and each new browser tab opened a NEW SPLIT.
  assert.equal(pickColumn({ dedicated: 2, liveColumns: [undefined, undefined] }), 2);
});

test('with no memory and nothing visible, the caller must fall back (undefined)', () => {
  assert.equal(pickColumn({ liveColumns: [undefined] }), undefined);
  assert.equal(pickColumn({}), undefined);
});

test('a restored layout plan outranks the dedicated pane', () => {
  // Reload restores each panel to the group it occupied before; that must not collapse
  // a deliberate split into one group.
  assert.equal(pickColumn({ planned: 3, dedicated: 2, liveColumns: [2] }), 3);
});

test('a visible panel is used when nothing has been claimed yet', () => {
  assert.equal(pickColumn({ liveColumns: [undefined, 2] }), 2);
});

test('the claimed pane beats an unrelated visible panel', () => {
  assert.equal(pickColumn({ dedicated: 2, liveColumns: [3] }), 2);
});

test('column 1 is a real column, not a falsy miss', () => {
  assert.equal(pickColumn({ dedicated: 1 }), 1);
  assert.equal(pickColumn({ planned: 1, dedicated: 2 }), 1);
  assert.equal(pickColumn({ liveColumns: [1] }), 1);
});
