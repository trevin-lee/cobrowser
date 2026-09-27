import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BRAND_REVISION, brandedExe, isBranded, versionDirOf } from '../src/app/brandApp';

test('the version directory is found from either bundle name, so signing and branding share their markers', () => {
  const dir = '/cache/electron/electron-v44.4.5-darwin-arm64';
  assert.equal(versionDirOf(`${dir}/Electron.app/Contents/MacOS/Electron`), dir);
  assert.equal(versionDirOf(brandedExe(dir)), dir);
  assert.equal(brandedExe(dir), `${dir}/cobrowser.app/Contents/MacOS/Electron`);
});

test('an install counts as branded only with the current revision AND the renamed bundle present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-brand-'));
  assert.equal(isBranded(dir), false, 'nothing there');
  fs.writeFileSync(path.join(dir, 'branded.json'), JSON.stringify({ revision: BRAND_REVISION }));
  assert.equal(isBranded(dir), false, 'marker without the bundle');
  fs.mkdirSync(path.dirname(brandedExe(dir)), { recursive: true });
  fs.writeFileSync(brandedExe(dir), '');
  assert.equal(isBranded(dir), true);
  fs.writeFileSync(path.join(dir, 'branded.json'), JSON.stringify({ revision: BRAND_REVISION - 1 }));
  assert.equal(isBranded(dir), false, 'an older revision is re-branded');
  fs.rmSync(dir, { recursive: true, force: true });
});
