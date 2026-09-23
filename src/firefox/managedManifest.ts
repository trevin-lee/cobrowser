import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Must match browser_specific_settings.gecko.id in firefox-extension/manifest.json. */
export const BRIDGE_EXTENSION_ID = 'cobrowser-bridge@trevin.dev';

interface ManagedManifest {
  name: string;
  description: string;
  type: 'storage';
  data: {
    /** What the extension actually reads. Derived from `workspaces` on every write. */
    endpoints: string[];
    /** Ours, so a workspace can update its own entry instead of appending a duplicate. */
    workspaces: Record<string, string>;
  };
}

/**
 * Firefox's managed-storage manifest directory. Verified against Zen 1.21 (Gecko 154): it
 * reads the shared "Mozilla" directory, NOT one named after the fork.
 */
function manifestDir(): string | undefined {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Mozilla', 'ManagedStorage');
  }
  if (process.platform === 'linux') {
    return path.join(home, '.mozilla', 'managed-storage');
  }
  return undefined; // Windows keeps these in the registry — configure the bridge by hand.
}

export function manifestPath(): string | undefined {
  const dir = manifestDir();
  return dir ? path.join(dir, `${BRIDGE_EXTENSION_ID}.json`) : undefined;
}

function read(file: string): ManagedManifest | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ManagedManifest;
    if (parsed && parsed.data && typeof parsed.data === 'object') return parsed;
  } catch {
    // Missing or corrupt — rewritten from scratch below.
  }
  return undefined;
}

/**
 * Register THIS workspace's bridge endpoint so the Zen extension configures itself, instead
 * of the human copying a URL into its options page.
 *
 * All workspaces share one manifest (it is keyed by extension id), so this is a
 * read-modify-write keyed by workspace path. Entries whose workspace directory no longer
 * exists are dropped, which keeps deleted checkouts from leaving the extension retrying a
 * dead port forever.
 *
 * The file carries live localhost tokens, so it is written 0600 — same sensitivity as the
 * MCP client configs.
 */
export function unregisterEndpoint(workspace: string, log: (m: string) => void): void {
  const file = manifestPath();
  if (!file) return;
  const existing = read(file);
  if (!existing?.data.workspaces[workspace]) return;
  const workspaces = { ...existing.data.workspaces };
  delete workspaces[workspace];
  write(file, workspaces, log);
}

function write(file: string, workspaces: Record<string, string>, log: (m: string) => void): void {
  const manifest: ManagedManifest = {
    name: BRIDGE_EXTENSION_ID,
    description: 'Cobrowser workspace endpoints (written by the Cobrowser editor extension).',
    type: 'storage',
    data: { endpoints: [...new Set(Object.values(workspaces))], workspaces },
  };
  const next = JSON.stringify(manifest, null, 2);
  try {
    // Unchanged content is not rewritten: Firefox re-reads the file on change, and a needless
    // rewrite on every activation is exactly the churn that made the add-on reconnect.
    try { if (fs.readFileSync(file, 'utf8') === next) return; } catch { /* absent */ }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, next, { mode: 0o600 });
    fs.renameSync(tmp, file);
    log(`Firefox bridge: wrote ${file} (${manifest.data.endpoints.length} endpoint(s)).`);
  } catch (err) {
    log(`Firefox bridge: could not write the managed-storage manifest (${String(err)}) — paste the URL into the add-on instead.`);
  }
}

export function registerEndpoint(workspace: string, url: string, log: (m: string) => void): void {
  const file = manifestPath();
  if (!file) {
    log('Zen bridge: managed-storage auto-config is not supported on this platform — paste the URL into the extension instead.');
    return;
  }

  const existing = read(file);
  const workspaces: Record<string, string> = { ...(existing?.data.workspaces ?? {}) };
  workspaces[workspace] = url;

  for (const key of Object.keys(workspaces)) {
    if (key === workspace) continue;
    // A deleted checkout, or an entry from before the bridge moved to the daemon (those URLs
    // pointed at per-window ports that no longer exist): either way, the add-on would sit
    // retrying a dead port forever.
    if (!fs.existsSync(key) || !workspaces[key].includes('workspace=')) delete workspaces[key];
  }
  write(file, workspaces, log);
}
