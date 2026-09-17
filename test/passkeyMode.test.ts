import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Mirrors passkeyFallbackFor in extension.ts. Kept as a pure copy because the real one needs
 * a vscode WorkspaceConfiguration; the RULE is what matters and it is easy to invert by
 * accident — and inverting it is silent, showing up only as "passkeys stopped working" or
 * "the browser hangs on login".
 */
function passkeyFallbackFor(
  inspect: { workspaceFolderValue?: boolean; workspaceValue?: boolean; globalValue?: boolean } | undefined,
  headless: boolean,
): boolean {
  const explicit = inspect?.workspaceFolderValue ?? inspect?.workspaceValue ?? inspect?.globalValue;
  return typeof explicit === 'boolean' ? explicit : headless;
}

test('panel mode (headless) installs the authenticator — nothing can show an OS prompt', () => {
  assert.equal(passkeyFallbackFor(undefined, true), true);
  assert.equal(passkeyFallbackFor({}, true), true);
});

test('window mode leaves passkeys alone — real Chrome CAN show Touch ID', () => {
  assert.equal(passkeyFallbackFor(undefined, false), false);
  assert.equal(passkeyFallbackFor({}, false), false);
});

test('an explicit setting overrides the mode, in both directions', () => {
  assert.equal(passkeyFallbackFor({ globalValue: false }, true), false, 'opt out in panel mode');
  assert.equal(passkeyFallbackFor({ globalValue: true }, false), true, 'opt in in window mode');
});

test('the narrowest scope wins', () => {
  assert.equal(passkeyFallbackFor({ globalValue: true, workspaceValue: false }, true), false);
  assert.equal(
    passkeyFallbackFor({ globalValue: true, workspaceValue: true, workspaceFolderValue: false }, true),
    false,
  );
});

test('false is honoured, not treated as unset', () => {
  // The bug this guards: `explicit || headless` would turn an explicit false back into true
  // in panel mode, silently ignoring the opt-out.
  assert.equal(passkeyFallbackFor({ globalValue: false }, true), false);
});
