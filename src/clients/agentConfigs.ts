/**
 * What each MCP client needs to reach the cobrowser daemon. Pure: no editor, no files.
 *
 * The clients that can be registered through their own interface are: VS Code (extension
 * API), Cursor (its extension API) and Claude Code (its CLI). For the rest, the human adds
 * the snippet built here to that client's config (Cobrowser: Connect Another Agent).
 * Every entry is the daemon's one URL; only the token differs (a workspace's own for Claude
 * Code, which scopes that session to the folder, and the daemon's for the rest).
 */

export interface Endpoint {
  /** The entry's name: `cobrowser`, or `cobrowser-dev` for the development host. */
  name: string;
  /** The daemon's MCP URL, e.g. http://127.0.0.1:39273/mcp */
  url: string;
  token: string;
}

/** `claude mcp add` arguments for a per-project ("local" scope) entry. Run in the folder. */
export function claudeAddArgs(ep: Endpoint): string[] {
  return ['mcp', 'add', '--scope', 'local', '--transport', 'http', ep.name, ep.url, '--header', `Authorization: Bearer ${ep.token}`];
}

/** The entry Claude Code keeps for it, to tell whether registering again would change anything. */
export function claudeEntry(ep: Endpoint): Record<string, unknown> {
  return { type: 'http', url: ep.url, headers: { Authorization: `Bearer ${ep.token}` } };
}

/** Cursor's vscode.cursor.mcp.registerServer config. */
export function cursorServer(ep: Endpoint): { name: string; server: { url: string; headers: Record<string, string> } } {
  return { name: ep.name, server: { url: ep.url, headers: { Authorization: `Bearer ${ep.token}` } } };
}

export type OtherClient = 'claude-desktop' | 'codex' | 'windsurf' | 'other';

export interface Snippet {
  client: OtherClient;
  label: string;
  /** Where it goes, as the human would look for it. */
  where: string;
  /** The config file, when there is a known one to open. */
  file?: string;
  language: 'json' | 'toml' | 'plaintext';
  text: string;
}

const json = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';

export function snippetFor(client: OtherClient, ep: Endpoint, home: string): Snippet {
  const bearer = `Bearer ${ep.token}`;
  switch (client) {
    case 'claude-desktop':
      // Claude Desktop starts local programs only, so mcp-remote carries its stdio to the
      // daemon's HTTP. The header goes through an env var, without spaces in the argument,
      // which some clients mangle when they start npx.
      return {
        client,
        label: 'Claude Desktop',
        where: 'the "mcpServers" object in claude_desktop_config.json (Settings → Developer → Edit Config), then restart Claude Desktop',
        file: `${home}/Library/Application Support/Claude/claude_desktop_config.json`,
        language: 'json',
        text: json({
          mcpServers: {
            [ep.name]: {
              command: 'npx',
              args: ['-y', 'mcp-remote', ep.url, '--allow-http', '--header', 'Authorization:${COBROWSER_AUTH}'],
              env: { COBROWSER_AUTH: bearer },
            },
          },
        }),
      };
    case 'codex':
      return {
        client,
        label: 'Codex',
        where: '~/.codex/config.toml',
        file: `${home}/.codex/config.toml`,
        language: 'toml',
        text: `[mcp_servers.${JSON.stringify(ep.name)}]\nurl = ${JSON.stringify(ep.url)}\nhttp_headers = { Authorization = ${JSON.stringify(bearer)} }\n`,
      };
    case 'windsurf':
      return {
        client,
        label: 'Windsurf',
        where: 'the "mcpServers" object in its mcp_config.json (the MCP settings → View raw config)',
        language: 'json',
        text: json({ mcpServers: { [ep.name]: { serverUrl: ep.url, headers: { Authorization: bearer } } } }),
      };
    case 'other':
      return {
        client,
        label: 'Another client',
        where: "the client's MCP settings, as a Streamable HTTP server",
        language: 'plaintext',
        text: `URL:    ${ep.url}\nHeader: Authorization: ${bearer}\n`,
      };
  }
}
