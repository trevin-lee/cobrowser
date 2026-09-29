import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unregisterEverywhere, withoutClaudeEntries, withoutCursorEntries } from '../src/clients/unregister';

test("uninstalling takes cobrowser out of every project's Claude Code servers, and leaves the rest", () => {
  const json = {
    mcpServers: { cobrowser: {}, other: {} },
    projects: {
      '/a': { mcpServers: { cobrowser: {}, sentry: {} }, allowedTools: [] },
      '/b': { mcpServers: { 'cobrowser-dev': {} } },
      '/c': {},
    },
  };
  assert.equal(withoutClaudeEntries(json), 3);
  assert.deepEqual(json, { mcpServers: { other: {} }, projects: { '/a': { mcpServers: { sentry: {} }, allowedTools: [] }, '/b': { mcpServers: {} }, '/c': {} } });
  const cursor = { mcpServers: { cobrowser: {}, 'cobrowser-myrepo': {}, linear: {} } };
  assert.equal(withoutCursorEntries(cursor), 2);
  assert.deepEqual(cursor, { mcpServers: { linear: {} } });
});

test('it edits only configs that exist, and never creates one', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-unreg-'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { '/a': { mcpServers: { cobrowser: {} } } } }));
  const said: string[] = [];
  unregisterEverywhere(home, (m) => said.push(m));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')), { projects: { '/a': { mcpServers: {} } } });
  assert.equal(fs.existsSync(path.join(home, '.cursor')), false);
  assert.equal(said.length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});
