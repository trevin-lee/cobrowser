import * as vscode from 'vscode';

type Log = (message: string) => void;

/**
 * Auto-register the running MCP server with file-based clients:
 *   - Claude Code: `<workspace>/.mcp.json`         (remote entry REQUIRES "type": "http")
 *   - Cursor:      `<workspace>/.cursor/mcp.json`
 *
 * H4: literal port + token are written (never "${ENV}" placeholders — the CLI's env
 * would not have them). M9: no-op when there is no workspace folder. Both files are added
 * to `.git/info/exclude` (local-only) since they contain a machine-specific port + secret.
 */
export async function writeClientConfigs(port: number, token: string, log: Log): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    log('No workspace folder open — skipping .mcp.json / .cursor/mcp.json registration.');
    return;
  }
  const root = folder.uri;
  const url = `http://127.0.0.1:${port}/mcp`;
  const headers = { Authorization: `Bearer ${token}` };

  // Claude Code
  await mergeJson(vscode.Uri.joinPath(root, '.mcp.json'), (json) => {
    const servers = (json.mcpServers ??= {});
    servers.cobrowser = { type: 'http', url, headers };
    return json;
  }, log);

  // Cursor
  await vscode.workspace.fs
    .createDirectory(vscode.Uri.joinPath(root, '.cursor'))
    .then(undefined, () => undefined);
  await mergeJson(vscode.Uri.joinPath(root, '.cursor', 'mcp.json'), (json) => {
    const servers = (json.mcpServers ??= {});
    servers.cobrowser = { url, headers };
    return json;
  }, log);

  await addGitExclude(root, ['.mcp.json', '.cursor/mcp.json']);
  log(`Registered MCP client configs (.mcp.json, .cursor/mcp.json) pointing at ${url}`);
}

type JsonObject = { mcpServers?: Record<string, unknown> } & Record<string, unknown>;

async function mergeJson(
  uri: vscode.Uri,
  mutate: (json: JsonObject) => JsonObject,
  log: Log,
): Promise<void> {
  // Distinguish "file missing" (start fresh) from "file exists but won't parse". In the
  // latter case, REFUSE to overwrite — otherwise a momentarily-malformed config silently
  // wipes the user's other MCP servers.
  let raw: string | undefined;
  try {
    raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    raw = undefined; // missing — safe to create
  }
  let current: JsonObject = {};
  if (raw !== undefined && raw.trim() !== '') {
    try {
      current = JSON.parse(raw) as JsonObject;
    } catch {
      log(`Refusing to overwrite unparseable ${uri.fsPath} — left untouched.`);
      return;
    }
  }
  const next = mutate(current);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf8'));
}

async function addGitExclude(root: vscode.Uri, entries: string[]): Promise<void> {
  const excludeUri = vscode.Uri.joinPath(root, '.git', 'info', 'exclude');
  let content: string;
  try {
    content = Buffer.from(await vscode.workspace.fs.readFile(excludeUri)).toString('utf8');
  } catch {
    return; // not a git repo (or no info/exclude) — nothing to do
  }
  const existing = new Set(content.split('\n').map((l) => l.trim()));
  const additions = entries.filter((e) => !existing.has(e));
  if (additions.length === 0) return;
  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  const block = prefix + '# added by cobrowser\n' + additions.join('\n') + '\n';
  await vscode.workspace.fs.writeFile(excludeUri, Buffer.from(content + block, 'utf8'));
}
