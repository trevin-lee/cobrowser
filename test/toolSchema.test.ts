import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withWorkspaceArg, listWorkspacesTool, type Tool } from '../src/daemon/toolSchema';

const newPage: Tool = {
  name: 'new_page',
  description: 'Open a tab',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string' }, background: { type: 'boolean' } },
    required: ['url'],
  },
};

test('an unscoped caller gets a REQUIRED workspace argument', () => {
  const [t] = withWorkspaceArg([newPage]);
  assert.ok(t.inputSchema.properties?.workspace);
  assert.deepEqual(t.inputSchema.required, ['workspace', 'url']);
});

test('injecting workspace preserves the original parameters exactly', () => {
  const [t] = withWorkspaceArg([newPage]);
  assert.deepEqual(t.inputSchema.properties?.url, { type: 'string' });
  assert.deepEqual(t.inputSchema.properties?.background, { type: 'boolean' });
  assert.equal(t.name, 'new_page');
  assert.equal(t.description, 'Open a tab');
});

test('a tool with no parameters still gets workspace', () => {
  const bare: Tool = { name: 'list_pages', inputSchema: { type: 'object' } };
  const [t] = withWorkspaceArg([bare]);
  assert.deepEqual(t.inputSchema.required, ['workspace']);
  assert.ok(t.inputSchema.properties?.workspace);
});

test('injection does not mutate the cached upstream schema', () => {
  const original = JSON.parse(JSON.stringify(newPage));
  withWorkspaceArg([newPage]);
  assert.deepEqual(newPage, original, 'the tool cache is shared; mutating it would leak workspace into the scoped surface');
});

test('a scoped caller sees NO workspace argument at all', () => {
  // Scoped sessions are served the raw upstream tools; the daemon must never offer an
  // argument whose only use would be attempting to reach another workspace.
  const raw = [newPage];
  assert.equal(raw[0].inputSchema.properties?.workspace, undefined);
  assert.deepEqual(raw[0].inputSchema.required, ['url']);
});

test('list_workspaces describes itself differently for a bound session', () => {
  const scoped = listWorkspacesTool(true);
  const open = listWorkspacesTool(false);
  assert.match(scoped.description!, /bound to/);
  assert.doesNotMatch(scoped.description!, /`workspace` argument/);
  assert.match(open.description!, /`workspace` argument/);
  assert.equal(scoped.name, 'list_workspaces');
});
