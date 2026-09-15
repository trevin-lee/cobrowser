import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BRIDGE_EXTENSION_ID } from '../src/firefox/managedManifest';

const repo = path.join(__dirname, '..');

/**
 * The id appears in two files that must agree: the WebExtension's manifest, and the editor
 * side, which names the managed-storage file after it. If they drift, the extension installs
 * fine and simply never receives its endpoint — a silent failure with no error anywhere.
 */
test('the extension manifest and the editor agree on the add-on id', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repo, 'firefox-extension', 'manifest.json'), 'utf8'),
  ) as { browser_specific_settings: { gecko: { id: string } } };
  assert.equal(manifest.browser_specific_settings.gecko.id, BRIDGE_EXTENSION_ID);
});

test('the id is a shape Firefox accepts', () => {
  // Gecko allows either a braced GUID or an email-like string. Anything else is rejected
  // at install time, which would only be discovered by hand-installing the build.
  const guid = /^\{[0-9a-fA-F-]{36}\}$/;
  const emailLike = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  assert.ok(
    guid.test(BRIDGE_EXTENSION_ID) || emailLike.test(BRIDGE_EXTENSION_ID),
    `${BRIDGE_EXTENSION_ID} is neither a braced GUID nor an email-like id`,
  );
});
