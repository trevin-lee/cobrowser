import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

type Log = (message: string) => void;

const execFileP = promisify(execFile);

/** The default bundle identity of the signed app, and the keychain namespace for passkeys.
 *  An identifier belongs to the first team that registers it, so another team signs with
 *  its own (Enable Passkeys asks); the one in use is recorded in the signed marker. */
export const APP_BUNDLE_ID = 'dev.trevin.cobrowser';

export interface SignedMarker {
  identity: string;
  team: string;
  /** The bundle identifier the app was signed as (absent in markers from before it varied). */
  bundleId?: string;
  /** The keychain access group WebAuthn credentials live under. */
  webauthnGroup: string;
  profile: string;
  /** When the embedded provisioning profile expires (ISO). */
  expires?: string;
  at: string;
}

/** Sidecar written next to the signed app so ensureApp knows to enable passkeys. */
export function signedMarkerPath(electronExe: string): string {
  // <cache>/electron-vX-darwin-arm64/<name>.app/Contents/MacOS/Electron → <cache>/electron-vX…/signed.json
  return path.join(path.dirname(path.dirname(path.dirname(path.dirname(electronExe)))), 'signed.json');
}

export function readSignedMarker(electronExe: string): SignedMarker | undefined {
  try {
    return JSON.parse(fs.readFileSync(signedMarkerPath(electronExe), 'utf8')) as SignedMarker;
  } catch {
    return undefined;
  }
}

function sh(cmd: string, args: string[], opts: { cwd?: string } = {}): string {
  return execFileSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
}

export interface SigningIdentity {
  /** The certificate's name, as codesign takes it ("Apple Development: …"). */
  name: string;
  /** The team: the certificate's OU (NOT the parenthesised id in the name, which for Apple
   *  Development certificates is the developer). */
  team: string;
  teamName: string;
  /** A paid team: its development profiles last a year, not a free team's 7 days. */
  paid: boolean;
  developerId: boolean;
}

/** Xcode's view of the teams it is signed in to: team id → paid. Empty without Xcode. */
function xcodeTeams(): Map<string, boolean> {
  const teams = new Map<string, boolean>();
  const tmp = path.join(os.tmpdir(), `cobrowser-xcode-${process.pid}.plist`);
  try {
    sh('defaults', ['export', 'com.apple.dt.Xcode', tmp]);
    const byAccount = JSON.parse(sh('plutil', ['-extract', 'IDEProvisioningTeamByIdentifier', 'json', '-o', '-', tmp])) as Record<string, unknown>;
    for (const v of Object.values(byAccount)) {
      for (const t of (Array.isArray(v) ? v : [v]) as { teamID?: string; isFreeProvisioningTeam?: boolean }[]) {
        if (t.teamID) teams.set(t.teamID, !t.isFreeProvisioningTeam);
      }
    }
  } catch {
    /* no Xcode, or never signed in */
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return teams;
}

/** Every code-signing identity on this Mac, with its team and whether that team is paid. */
export function listSigningIdentities(): SigningIdentity[] {
  let out = '';
  try {
    out = sh('security', ['find-identity', '-v', '-p', 'codesigning']);
  } catch {
    return [];
  }
  const paidTeams = xcodeTeams();
  const ids: SigningIdentity[] = [];
  for (const m of out.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)) {
    const [, hash, name] = m;
    try {
      // The certificate with this exact hash: two identities can share a name.
      const all = sh('security', ['find-certificate', '-a', '-Z', '-p', '-c', name]);
      const block = all.split(/(?=SHA-256 hash:)/).find((b) => b.includes(`SHA-1 hash: ${hash}`)) ?? all;
      const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(block)?.[0];
      if (!pem) continue;
      const subject = execFileSync('openssl', ['x509', '-noout', '-subject'], { input: pem, encoding: 'utf8' });
      const team = /OU\s*=\s*([A-Z0-9]{10})/.exec(subject)?.[1];
      if (!team) continue;
      const teamName = (/\bO\s*=\s*([^,\n/]+)/.exec(subject)?.[1] ?? team).trim();
      const developerId = name.startsWith('Developer ID Application:');
      if (!developerId && !name.startsWith('Apple Development:')) continue;
      ids.push({ name, team, teamName, developerId, paid: developerId || paidTeams.get(team) === true });
    } catch {
      /* unreadable certificate */
    }
  }
  return ids;
}

/**
 * Which identity to sign with: the requested team's, else Developer ID, else a paid team's
 * Apple Development, else anything. A free team's profiles expire after 7 days.
 */
export function chooseIdentity(ids: SigningIdentity[], team?: string): SigningIdentity | undefined {
  if (team) return ids.find((i) => i.team === team && i.developerId) ?? ids.find((i) => i.team === team);
  return ids.find((i) => i.developerId) ?? ids.find((i) => i.paid) ?? ids[0];
}

/** Kept for callers that only need "an identity"; see chooseIdentity. */
export function findSigningIdentity(): { name: string; team: string } | undefined {
  return chooseIdentity(listSigningIdentities());
}

/**
 * Obtain a macOS provisioning profile granting keychain-access-groups for `bundleId`.
 *
 * keychain-access-groups is a RESTRICTED entitlement: an app carrying it without a profile
 * that grants it is killed at launch (SIGKILL, no message). Xcode's automatic signing is the
 * one command-line way to mint one — so build a stub app project with the bundle id and
 * the capability, let xcodebuild talk to Apple, and take the embedded profile it produces.
 * Needs Xcode with an Apple ID signed in. Asynchronous: it can take a minute, and must not
 * freeze the extension host meanwhile.
 */
export async function obtainProvisioningProfile(team: string, log: Log, bundleId = APP_BUNDLE_ID): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobrowser-sign-'));
  fs.mkdirSync(path.join(dir, 'Stub'));
  fs.mkdirSync(path.join(dir, 'Stub.xcodeproj'));
  fs.writeFileSync(path.join(dir, 'Stub', 'main.swift'), 'import Foundation\nprint("cobrowser signing stub")\n');
  fs.writeFileSync(
    path.join(dir, 'Stub', 'Stub.entitlements'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>keychain-access-groups</key><array><string>$(AppIdentifierPrefix)${bundleId}</string></array></dict></plist>\n`,
  );
  fs.writeFileSync(path.join(dir, 'Stub.xcodeproj', 'project.pbxproj'), STUB_PBXPROJ(team, bundleId));
  log(`Asking Xcode for a provisioning profile for ${bundleId} (this registers the identifier, and this Mac, with the team)…`);
  try {
    await execFileP('xcodebuild', ['-project', 'Stub.xcodeproj', '-scheme', 'Stub', '-configuration', 'Debug', '-derivedDataPath', 'build', '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', 'build'], { cwd: dir, maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    const msg = String((e as { stdout?: string }).stdout ?? '') + String((e as { stderr?: string }).stderr ?? '');
    const line = msg.split('\n').find((l) => /error:/i.test(l)) ?? msg.slice(-400);
    const taken = /not available/i.test(line) ? ` The identifier ${bundleId} belongs to another team; sign with an identifier of this team's own.` : '';
    throw new Error(`xcodebuild could not create a provisioning profile: ${line.trim()}${taken}`);
  }
  const profile = path.join(dir, 'build', 'Build', 'Products', 'Debug', 'Stub.app', 'Contents', 'embedded.provisionprofile');
  if (!fs.existsSync(profile)) throw new Error('xcodebuild succeeded but produced no embedded.provisionprofile');
  return profile;
}

/** A provisioning profile's contents (it is a CMS envelope around a plist). */
function readProfile(profile: string): { expires?: string; entitlements: Record<string, unknown> } {
  const tmp = path.join(os.tmpdir(), `cobrowser-profile-${process.pid}-${Date.now()}.plist`);
  try {
    fs.writeFileSync(tmp, execFileSync('security', ['cms', '-D', '-i', profile], { encoding: 'utf8' }));
    const entitlements = JSON.parse(sh('plutil', ['-extract', 'Entitlements', 'json', '-o', '-', tmp])) as Record<string, unknown>;
    let expires: string | undefined;
    try {
      // Dates do not convert to JSON; the raw XML form does.
      const raw = sh('plutil', ['-extract', 'ExpirationDate', 'raw', '-o', '-', tmp]).trim();
      expires = new Date(raw).toISOString();
    } catch {
      /* no date */
    }
    return { expires, entitlements };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** When the signed app's embedded provisioning profile expires, or undefined if it has none. */
export function signingExpiry(electronExe: string): Date | undefined {
  const profile = path.join(path.dirname(path.dirname(electronExe)), 'embedded.provisionprofile');
  if (!fs.existsSync(profile)) return undefined;
  const { expires } = readProfile(profile);
  return expires ? new Date(expires) : undefined;
}

/**
 * Whether the signing needs renewing before the app starts. Only an EXPIRED profile does:
 * asked for a profile while the current one is still valid, Xcode hands back the same one
 * (measured), so renewing early would only re-run a slow build at every start.
 */
export function signingState(expires: Date | undefined, now = new Date()): 'unsigned' | 'ok' | 'expired' {
  if (!expires) return 'unsigned';
  return expires.getTime() <= now.getTime() ? 'expired' : 'ok';
}

/**
 * Sign the cached browser for passkeys: give it the bundle id and name, embed the
 * provisioning profile, and sign helpers, frameworks and the app with the entitlements the
 * profile grants (application-identifier, team, keychain-access-groups) plus the JIT
 * exceptions Electron needs under the hardened runtime.
 *
 * The keychain group is listed EXPLICITLY: Chromium compares the configured group against
 * the entitlement by string, and a profile's "TEAM.*" wildcard does not satisfy it. Measured:
 * with only the wildcard the platform authenticator reports unavailable; with the explicit
 * group a passkey is created and asserted.
 *
 * The app must not be running: macOS kills a process whose binary is re-signed under it.
 */
export async function signElectronForPasskeys(electronExe: string, log: Log, opts: { team?: string; bundleId?: string } = {}): Promise<SignedMarker> {
  const ids = listSigningIdentities();
  const identity = chooseIdentity(ids, opts.team);
  if (!identity) {
    throw new Error(opts.team ? `no code-signing identity for team ${opts.team} on this Mac (Xcode → Settings → Accounts)` : 'no code-signing identity found (Xcode → Settings → Accounts, or a Developer ID certificate)');
  }
  const bundleId = opts.bundleId || APP_BUNDLE_ID;
  const appDir = path.dirname(path.dirname(path.dirname(electronExe))); // …/<name>.app
  const contents = path.join(appDir, 'Contents');
  const profile = await obtainProvisioningProfile(identity.team, log, bundleId);
  const group = `${identity.team}.${bundleId}.webauthn`;

  // Identity + name: the Touch ID prompt says "<name> is trying to …", so not "Electron".
  sh('plutil', ['-replace', 'CFBundleIdentifier', '-string', bundleId, path.join(contents, 'Info.plist')]);
  sh('plutil', ['-replace', 'CFBundleName', '-string', 'cobrowser', path.join(contents, 'Info.plist')]);
  sh('plutil', ['-replace', 'CFBundleDisplayName', '-string', 'cobrowser', path.join(contents, 'Info.plist')]);
  fs.copyFileSync(profile, path.join(contents, 'embedded.provisionprofile'));
  const { expires, entitlements: granted } = readProfile(profile);

  const jit = {
    'com.apple.security.cs.allow-jit': true,
    'com.apple.security.cs.allow-unsigned-executable-memory': true,
    'com.apple.security.cs.disable-library-validation': true,
  };
  const appEnt = { ...jit, 'com.apple.application-identifier': granted['com.apple.application-identifier'], 'com.apple.developer.team-identifier': granted['com.apple.developer.team-identifier'], 'keychain-access-groups': [`${identity.team}.${bundleId}`, group] };
  const appEntPath = path.join(os.tmpdir(), `cobrowser-app-${process.pid}.plist`);
  const helperEntPath = path.join(os.tmpdir(), `cobrowser-helper-${process.pid}.plist`);
  fs.writeFileSync(appEntPath, toPlist(appEnt));
  fs.writeFileSync(helperEntPath, toPlist(jit));

  const sign = (target: string, entitlements: string): void => {
    sh('codesign', ['--force', '--sign', identity.name, '--entitlements', entitlements, '--options', 'runtime', target]);
  };
  try {
    sh('xattr', ['-cr', appDir]);
    const fw = path.join(contents, 'Frameworks');
    for (const name of fs.readdirSync(fw)) {
      const p = path.join(fw, name);
      if (name.endsWith('.app')) sign(p, helperEntPath);
    }
    for (const name of fs.readdirSync(fw)) {
      const p = path.join(fw, name);
      if (name.endsWith('.framework')) sh('codesign', ['--force', '--sign', identity.name, '--options', 'runtime', p]);
    }
    sign(appDir, appEntPath);
    sh('codesign', ['--verify', '--deep', '--strict', appDir]);
  } finally {
    fs.rmSync(appEntPath, { force: true });
    fs.rmSync(helperEntPath, { force: true });
  }
  refreshLaunchServices(appDir);
  const marker: SignedMarker = { identity: identity.name, team: identity.team, bundleId, webauthnGroup: group, profile: path.basename(profile), expires, at: new Date().toISOString() };
  fs.writeFileSync(signedMarkerPath(electronExe), JSON.stringify(marker, null, 2));
  log(`Signed the browser as ${bundleId} (${identity.name}); passkeys use keychain group ${group}; the profile expires ${expires ?? 'at an unknown date'}.`);
  return marker;
}

/**
 * Undo the passkey signing: ad hoc signatures without entitlements or a profile, the way a
 * downloaded Electron comes, so the browser starts no matter what. Used when the profile has
 * expired and cannot be renewed. Passkeys fall back to passwords until Enable Passkeys runs.
 */
export function unsignForPasskeys(electronExe: string, log: Log): void {
  const appDir = path.dirname(path.dirname(path.dirname(electronExe)));
  const contents = path.join(appDir, 'Contents');
  fs.rmSync(path.join(contents, 'embedded.provisionprofile'), { force: true });
  const fw = path.join(contents, 'Frameworks');
  for (const name of fs.readdirSync(fw)) if (name.endsWith('.app')) sh('codesign', ['--force', '--sign', '-', path.join(fw, name)]);
  for (const name of fs.readdirSync(fw)) if (name.endsWith('.framework')) sh('codesign', ['--force', '--sign', '-', path.join(fw, name)]);
  sh('codesign', ['--force', '--sign', '-', appDir]);
  sh('codesign', ['--verify', '--strict', appDir]);
  fs.rmSync(signedMarkerPath(electronExe), { force: true });
  refreshLaunchServices(appDir);
  log('Passkey signing removed: the browser is signed ad hoc, as downloaded.');
}

function refreshLaunchServices(appDir: string): void {
  try {
    sh('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', appDir]);
  } catch {
    /* only a cache refresh */
  }
}

function toPlist(obj: Record<string, unknown>): string {
  const node = (v: unknown): string => {
    if (v === true) return '<true/>';
    if (v === false) return '<false/>';
    if (Array.isArray(v)) return `<array>${v.map(node).join('')}</array>`;
    if (typeof v === 'object' && v) return `<dict>${Object.entries(v as Record<string, unknown>).map(([k, x]) => `<key>${esc(k)}</key>${node(x)}`).join('')}</dict>`;
    return `<string>${esc(String(v))}</string>`;
  };
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${node(obj)}</plist>\n`;
}

const STUB_PBXPROJ = (team: string, bundleId: string): string => `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 56;
	objects = {
		A1 = {isa = PBXBuildFile; fileRef = F1; };
		F1 = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = main.swift; sourceTree = "<group>"; };
		F2 = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = Stub.entitlements; sourceTree = "<group>"; };
		P1 = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = Stub.app; sourceTree = BUILT_PRODUCTS_DIR; };
		G0 = {isa = PBXGroup; children = (G1, G2); sourceTree = "<group>"; };
		G1 = {isa = PBXGroup; children = (F1, F2); path = Stub; sourceTree = "<group>"; };
		G2 = {isa = PBXGroup; children = (P1); name = Products; sourceTree = "<group>"; };
		S1 = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (A1); runOnlyForDeploymentPostprocessing = 0; };
		T1 = {
			isa = PBXNativeTarget;
			buildConfigurationList = CL2;
			buildPhases = (S1);
			buildRules = ();
			dependencies = ();
			name = Stub;
			productName = Stub;
			productReference = P1;
			productType = "com.apple.product-type.application";
		};
		PR = {
			isa = PBXProject;
			attributes = { BuildIndependentTargetsInParallel = 1; LastUpgradeCheck = 1500; TargetAttributes = { T1 = { CreatedOnToolsVersion = 15.0; }; }; };
			buildConfigurationList = CL1;
			compatibilityVersion = "Xcode 14.0";
			developmentRegion = en;
			hasScannedForEncodings = 0;
			knownRegions = (en, Base);
			mainGroup = G0;
			productRefGroup = G2;
			projectDirPath = "";
			projectRoot = "";
			targets = (T1);
		};
		C1 = { isa = XCBuildConfiguration; buildSettings = { SDKROOT = macosx; MACOSX_DEPLOYMENT_TARGET = 13.0; SWIFT_VERSION = 5.0; }; name = Debug; };
		C2 = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGN_ENTITLEMENTS = Stub/Stub.entitlements;
				CODE_SIGN_STYLE = Automatic;
				DEVELOPMENT_TEAM = ${team};
				ENABLE_HARDENED_RUNTIME = YES;
				GENERATE_INFOPLIST_FILE = YES;
				INFOPLIST_KEY_LSUIElement = YES;
				PRODUCT_BUNDLE_IDENTIFIER = ${bundleId};
				PRODUCT_NAME = "$(TARGET_NAME)";
				PROVISIONING_PROFILE_SPECIFIER = "";
			};
			name = Debug;
		};
		CL1 = { isa = XCConfigurationList; buildConfigurations = (C1); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
		CL2 = { isa = XCConfigurationList; buildConfigurations = (C2); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
	};
	rootObject = PR;
}
`;
