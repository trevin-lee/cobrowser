'use strict';
/**
 * Type-check the parameters of a DevTools-protocol command before it reaches
 * webContents.debugger.sendCommand.
 *
 * Why this exists: Electron does not validate parameter types. A number where the protocol
 * wants a string (e.g. Input.dispatchKeyEvent with `code: 8`) trips an assertion in the CBOR
 * deserializer and ABORTS THE WHOLE PROCESS — every workspace's tabs die with it (measured
 * on Electron 44: "Assertion failed: state->tokenizer()->TokenTag() == STRING16").
 *
 * Only the commands the editor relays on every keystroke and click are covered; the rest
 * are our own well-typed calls. Unknown methods pass through untouched.
 */

const S = 'string', N = 'number', B = 'boolean';

const SHAPES = {
  'Input.dispatchKeyEvent': { type: S, modifiers: N, timestamp: N, text: S, unmodifiedText: S, keyIdentifier: S, code: S, key: S, windowsVirtualKeyCode: N, nativeVirtualKeyCode: N, autoRepeat: B, isKeypad: B, isSystemKey: B, location: N, commands: 'string[]' },
  'Input.dispatchMouseEvent': { type: S, x: N, y: N, modifiers: N, timestamp: N, button: S, buttons: N, clickCount: N, force: N, tangentialPressure: N, tiltX: N, tiltY: N, twist: N, deltaX: N, deltaY: N, pointerType: S },
  'Input.dispatchTouchEvent': { type: S, modifiers: N, timestamp: N },
  'Input.insertText': { text: S },
  'Input.setIgnoreInputEvents': { ignore: B },
  'Runtime.evaluate': { expression: S, objectGroup: S, includeCommandLineAPI: B, silent: B, contextId: N, returnByValue: B, generatePreview: B, userGesture: B, awaitPromise: B, throwOnSideEffect: B, timeout: N, disableBreaks: B, replMode: B, allowUnsafeEvalBlockedByCSP: B, uniqueContextId: S },
  'Page.captureScreenshot': { format: S, quality: N, fromSurface: B, captureBeyondViewport: B, optimizeForSpeed: B },
  'Page.getLayoutMetrics': {},
  'WebAuthn.enable': { enableUI: B },
};

const REQUIRED = {
  'Input.dispatchKeyEvent': ['type'],
  'Input.dispatchMouseEvent': ['type', 'x', 'y'],
  'Input.dispatchTouchEvent': ['type'],
  'Input.insertText': ['text'],
  'Runtime.evaluate': ['expression'],
};

/** Returns an error string for a malformed command, or undefined when it may be sent. */
function checkParams(method, params) {
  const shape = SHAPES[method];
  if (!shape) return undefined;
  if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) return `${method}: params must be an object`;
  const p = params || {};
  for (const key of REQUIRED[method] || []) {
    if (p[key] === undefined) return `${method}: missing required parameter "${key}"`;
  }
  for (const [key, value] of Object.entries(p)) {
    if (value === undefined) continue;
    const want = shape[key];
    if (!want) continue; // unknown keys are ignored by the protocol
    if (want === 'string[]') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return `${method}: "${key}" must be an array of strings`;
    } else if (typeof value !== want || (want === N && !Number.isFinite(value))) {
      return `${method}: "${key}" must be a ${want}, got ${value === null ? 'null' : typeof value}`;
    }
  }
  return undefined;
}

module.exports = { checkParams };
