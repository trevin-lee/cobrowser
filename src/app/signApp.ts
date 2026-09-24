import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

type Log = (message: string) => void;

/** The bundle identity the signed app takes on. Also the keychain namespace for passkeys. */
export const APP_BUNDLE_ID = 'dev.trevin.cobrowser';

export interface SignedMarker {
  identity: string;
  team: string;
  /** The keychain access group WebAuthn credentials live under. */
  webauthnGroup: string;
  profile: string;
  at: string;
}

/** Sidecar written next to the signed Electron.app so ensureApp knows to enable passkeys. */
export function signedMarkerPath(electronExe: string): string {
  // <cache>/electron-vX-darwin-arm64/Electron.app/Contents/MacOS/Electron → <cache>/electron-vX…/signed.json
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

/** A code-signing identity on this Mac: Developer ID if present, else Apple Development. */
export function findSigningIdentity(): { name: string; team: string } | undefined {
  let out = '';
  try {
    out = sh('security', ['find-identity', '-v', '-p', 'codesigning']);
  } catch {
    return undefined;
  }
  const names = [...out.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const name = names.find((n) => n.startsWith('Developer ID Application:')) ?? names.find((n) => n.startsWith('Apple Development:'));
  if (!name) return undefined;
  // The team is the certificate's OU — NOT the parenthesised id in the name, which for
  // Apple Development certificates is the developer, not the team.
  let team = '';
  try {
    const pem = sh('security', ['find-certificate', '-c', name, '-p']);
    const subject = execFileSync('openssl', ['x509', '-noout', '-subject'], { input: pem, encoding: 'utf8' });
    team = /OU\s*=\s*([A-Z0-9]{10})/.exec(subject)?.[1] ?? '';
  } catch {
    /* fall through */
  }
  return team ? { name, team } : undefined;
}

/**
 * Obtain a macOS provisioning profile granting keychain-access-groups for APP_BUNDLE_ID.
 *
 * keychain-access-groups is a RESTRICTED entitlement: an app carrying it without a profile
 * that grants it is killed at launch (SIGKILL, no message). Xcode's automatic signing is the
 * one command-line way to mint one — so build a stub app project with the bundle id and
 * the capability, let xcodebuild talk to Apple, and take the embedded profile it produces.
 * Needs Xcode with an Apple ID signed in.
 */
export function obtainProvisioningProfile(team: string, log: Log): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobrowser-sign-'));
  fs.mkdirSync(path.join(dir, 'Stub'));
  fs.mkdirSync(path.join(dir, 'Stub.xcodeproj'));
  fs.writeFileSync(path.join(dir, 'Stub', 'main.swift'), 'import Foundation\nprint("cobrowser signing stub")\n');
  fs.writeFileSync(
    path.join(dir, 'Stub', 'Stub.entitlements'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>keychain-access-groups</key><array><string>$(AppIdentifierPrefix)${APP_BUNDLE_ID}</string></array></dict></plist>\n`,
  );
  fs.writeFileSync(path.join(dir, 'Stub.xcodeproj', 'project.pbxproj'), STUB_PBXPROJ(team));
  log('Asking Xcode for a provisioning profile (this registers the app id and this Mac with your team)…');
  try {
    sh('xcodebuild', ['-project', 'Stub.xcodeproj', '-scheme', 'Stub', '-configuration', 'Debug', '-derivedDataPath', 'build', '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', 'build'], { cwd: dir });
  } catch (e) {
    const msg = String((e as { stderr?: string; stdout?: string }).stdout ?? '') + String((e as { stderr?: string }).stderr ?? '');
    const line = msg.split('\n').find((l) => /error:/i.test(l)) ?? msg.slice(-400);
    throw new Error(`xcodebuild could not create a provisioning profile: ${line.trim()}`);
  }
  const profile = path.join(dir, 'build', 'Build', 'Products', 'Debug', 'Stub.app', 'Contents', 'embedded.provisionprofile');
  if (!fs.existsSync(profile)) throw new Error('xcodebuild succeeded but produced no embedded.provisionprofile');
  return profile;
}

/**
 * Sign the cached Electron.app for passkeys: give it our bundle id and name, embed the
 * provisioning profile, and sign helpers, frameworks and the app with the entitlements the
 * profile grants (application-identifier, team, keychain-access-groups) plus the JIT
 * exceptions Electron needs under the hardened runtime.
 *
 * The keychain group is listed EXPLICITLY: Chromium compares the configured group against
 * the entitlement by string, and a profile's "TEAM.*" wildcard does not satisfy it. Measured:
 * with only the wildcard the platform authenticator reports unavailable; with the explicit
 * group a passkey is created and asserted.
 */
export function signElectronForPasskeys(electronExe: string, log: Log): SignedMarker {
  const identity = findSigningIdentity();
  if (!identity) throw new Error('no code-signing identity found (Xcode → Settings → Accounts, or a Developer ID certificate)');
  const appDir = path.dirname(path.dirname(path.dirname(electronExe))); // …/Electron.app
  const contents = path.join(appDir, 'Contents');
  const profile = obtainProvisioningProfile(identity.team, log);
  const group = `${identity.team}.${APP_BUNDLE_ID}.webauthn`;

  // Identity + name: the Touch ID prompt says "<name> is trying to …", so not "Electron".
  sh('plutil', ['-replace', 'CFBundleIdentifier', '-string', APP_BUNDLE_ID, path.join(contents, 'Info.plist')]);
  sh('plutil', ['-replace', 'CFBundleName', '-string', 'cobrowser', path.join(contents, 'Info.plist')]);
  sh('plutil', ['-replace', 'CFBundleDisplayName', '-string', 'cobrowser', path.join(contents, 'Info.plist')]);
  fs.copyFileSync(profile, path.join(contents, 'embedded.provisionprofile'));

  // The profile is a CMS envelope; decode it to read the entitlements it grants.
  const decoded = execFileSync('security', ['cms', '-D', '-i', profile], { encoding: 'utf8' });
  const tmpPlist = path.join(os.tmpdir(), `cobrowser-profile-${process.pid}.plist`);
  fs.writeFileSync(tmpPlist, decoded);
  const granted = JSON.parse(sh('plutil', ['-extract', 'Entitlements', 'json', '-o', '-', tmpPlist])) as Record<string, unknown>;
  fs.rmSync(tmpPlist, { force: true });

  const jit = {
    'com.apple.security.cs.allow-jit': true,
    'com.apple.security.cs.allow-unsigned-executable-memory': true,
    'com.apple.security.cs.disable-library-validation': true,
  };
  const appEnt = { ...jit, 'com.apple.application-identifier': granted['com.apple.application-identifier'], 'com.apple.developer.team-identifier': granted['com.apple.developer.team-identifier'], 'keychain-access-groups': [`${identity.team}.${APP_BUNDLE_ID}`, group] };
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
  const marker: SignedMarker = { identity: identity.name, team: identity.team, webauthnGroup: group, profile: path.basename(profile), at: new Date().toISOString() };
  fs.writeFileSync(signedMarkerPath(electronExe), JSON.stringify(marker, null, 2));
  log(`Signed the browser as ${APP_BUNDLE_ID} (${identity.name}); passkeys use keychain group ${group}.`);
  return marker;
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

const STUB_PBXPROJ = (team: string): string => `// !$*UTF8*$!
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
				PRODUCT_BUNDLE_IDENTIFIER = ${APP_BUNDLE_ID};
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
