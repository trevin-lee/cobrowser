import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAddArgs, claudeEntry, cursorServer, snippetFor } from '../src/clients/agentConfigs';

const ep = { name: 'cobrowser', url: 'http://127.0.0.1:39273/mcp', token: 'tok-123' };

test('Claude Code is registered per project through its CLI, as the entry it stores itself', () => {
  assert.deepEqual(claudeAddArgs(ep), ['mcp', 'add', '--scope', 'local', '--transport', 'http', 'cobrowser', ep.url, '--header', 'Authorization: Bearer tok-123']);
  // What `claude mcp add` wrote for these arguments (checked against the real CLI).
  assert.deepEqual(claudeEntry(ep), { type: 'http', url: ep.url, headers: { Authorization: 'Bearer tok-123' } });
});

test("Cursor's extension API gets the URL and the header", () => {
  assert.deepEqual(cursorServer(ep), { name: 'cobrowser', server: { url: ep.url, headers: { Authorization: 'Bearer tok-123' } } });
});

test('Claude Desktop reaches the daemon through mcp-remote, with no space inside an argument', () => {
  const s = snippetFor('claude-desktop', ep, '/Users/me');
  const cfg = JSON.parse(s.text) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
  const server = cfg.mcpServers.cobrowser;
  assert.equal(server.command, 'npx');
  assert.ok(server.args.includes(ep.url) && server.args.includes('--allow-http'));
  assert.ok(server.args.every((a) => !a.includes(' ')), 'some clients split arguments on spaces when they start npx');
  assert.equal(server.env.COBROWSER_AUTH, 'Bearer tok-123');
  assert.equal(s.file, '/Users/me/Library/Application Support/Claude/claude_desktop_config.json');
});

test('Codex gets a TOML table with the URL and the header; Windsurf its serverUrl form', () => {
  const codex = snippetFor('codex', { ...ep, name: 'cobrowser-dev' }, '/Users/me');
  assert.equal(codex.text, '[mcp_servers."cobrowser-dev"]\nurl = "http://127.0.0.1:39273/mcp"\nhttp_headers = { Authorization = "Bearer tok-123" }\n');
  assert.equal(codex.file, '/Users/me/.codex/config.toml');
  const windsurf = JSON.parse(snippetFor('windsurf', ep, '/h').text) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(windsurf.mcpServers.cobrowser, { serverUrl: ep.url, headers: { Authorization: 'Bearer tok-123' } });
  assert.match(snippetFor('other', ep, '/h').text, /URL: +http:\/\/127\.0\.0\.1:39273\/mcp\nHeader: Authorization: Bearer tok-123/);
});
