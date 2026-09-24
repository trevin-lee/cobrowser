import { test } from 'node:test';
import assert from 'node:assert/strict';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { checkParams } = require('../app/protocolGuard.js') as typeof import('../app/protocolGuard.js');

test('the exact shape that aborted Electron is refused before it can reach the debugger', () => {
  assert.match(checkParams('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 8, windowsVirtualKeyCode: 8 })!, /"code" must be a string, got number/);
  assert.equal(checkParams('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }), undefined);
});

test('what the panel sends on every click and key passes', () => {
  assert.equal(checkParams('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10.5, y: 20, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 }), undefined);
  assert.equal(checkParams('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1, y: 2, deltaX: 0, deltaY: -120 }), undefined);
  assert.equal(checkParams('Input.dispatchKeyEvent', { type: 'keyDown', text: 'a', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }), undefined);
  assert.equal(checkParams('Input.insertText', { text: 'pasted' }), undefined);
});

test('missing required fields, NaN, null and non-object params are refused; unknown methods pass', () => {
  assert.match(checkParams('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1 })!, /missing required parameter "y"/);
  assert.match(checkParams('Input.dispatchMouseEvent', { type: 'mouseMoved', x: NaN, y: 1 })!, /"x" must be a number/);
  assert.match(checkParams('Runtime.evaluate', { expression: null })!, /"expression" must be a string, got null/);
  assert.match(checkParams('Input.insertText', ['x'])!, /params must be an object/);
  assert.equal(checkParams('Emulation.setFocusEmulationEnabled', { enabled: 'yes' }), undefined, 'not covered: passes through');
});
