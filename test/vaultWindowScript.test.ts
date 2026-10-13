import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The vault window's page lives in a template string in app/main.js, so a quote or a backslash
 * that is right in the editor can be wrong in the page, and nothing but opening the window shows
 * it. Its script is evaluated here as the page gets it, and must parse.
 */
test("the vault window's script parses as the page receives it", () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
  const i = s.indexOf('const VAULT_HTML = `');
  const j = s.indexOf('</script>`;', i);
  assert.ok(i > 0 && j > i, 'VAULT_HTML not found');
  // Interpolated into the page as its source; a stand-in of the same shape is enough here.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function markdownToHtml(): void {}
  void markdownToHtml;
  const html = eval(s.slice(i + 'const VAULT_HTML = '.length, j + '</script>`'.length)) as string;
  const body = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new Function(body));
});
