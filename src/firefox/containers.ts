import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface FirefoxContainer {
  name: string;
  userContextId: number;
  /** Which browser profile it came from, so a chooser can disambiguate. */
  profile: string;
}

interface RawIdentity {
  userContextId?: number;
  name?: string;
  l10nID?: string;
  public?: boolean;
}

/** Firefox ships four built-in containers whose names live in l10n ids rather than `name`. */
const BUILT_IN: Record<string, string> = {
  'userContextPersonal.label': 'Personal',
  'userContextWork.label': 'Work',
  'userContextBanking.label': 'Banking',
  'userContextShopping.label': 'Shopping',
};

export function containerName(identity: RawIdentity): string | undefined {
  if (identity.name) return identity.name;
  const l10n = identity.l10nID;
  return l10n ? (BUILT_IN[l10n] ?? l10n.replace(/^userContext|\.label$/g, '')) : undefined;
}

/** Parse one containers.json. Exported for tests — the shape differs between built-in and
 *  user-created containers, which is easy to get wrong and invisible until a name is missing. */
export function parseContainers(json: string, profile: string): FirefoxContainer[] {
  const parsed = JSON.parse(json) as { identities?: RawIdentity[] };
  return (parsed.identities ?? [])
    .filter((i) => i.public !== false && typeof i.userContextId === 'number')
    .map((i) => ({ name: containerName(i) ?? '', userContextId: i.userContextId!, profile }))
    .filter((c) => c.name);
}

/** Profile roots to search. Zen first only because it is the fork this was developed
 *  against; the bridge is plain Firefox and works in any Gecko browser with containers. */
function profileRoots(): string[] {
  const support = path.join(os.homedir(), 'Library', 'Application Support');
  const linux = os.homedir();
  return process.platform === 'darwin'
    ? [path.join(support, 'zen', 'Profiles'), path.join(support, 'Firefox', 'Profiles')]
    : [path.join(linux, '.zen'), path.join(linux, '.mozilla', 'firefox')];
}

/**
 * Every container across the user's Zen/Firefox profiles.
 *
 * Read straight off disk rather than through the bridge, because the bridge only connects
 * once a container is already bound — asking it first would be a chicken-and-egg.
 */
export function listFirefoxContainers(): FirefoxContainer[] {
  const found: FirefoxContainer[] = [];
  for (const root of profileRoots()) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue; // that browser isn't installed
    }
    for (const entry of entries) {
      const file = path.join(root, entry, 'containers.json');
      try {
        found.push(...parseContainers(fs.readFileSync(file, 'utf8'), entry));
      } catch {
        // No containers.json, or unreadable — a stale/empty profile.
      }
    }
  }
  // Same name in two profiles is the same binding as far as the bridge is concerned.
  const seen = new Set<string>();
  return found.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}
