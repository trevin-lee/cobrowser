import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const uploads = require('../app/uploads.js') as {
  checkPaths: (paths: unknown, opts: { home: string; refused?: string[] }) => { files?: { path: string; name: string; size: number; shown: string }[]; error?: string };
  formatSize: (bytes: number) => string;
  MAX_FILES: number;
};

/** A fake home folder with documents, secrets and cobrowser's own data in it. */
function makeHome(): { home: string; data: string } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cobrowser-uploads-')));
  const put = (rel: string, body = 'x'): void => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), body);
  };
  put('Documents/resume.pdf', 'résumé');
  put('Documents/cover.pdf');
  put('.ssh/id_ed25519');
  put('.netrc');
  put('Library/Keychains/login.keychain-db');
  put('Library/Mobile Documents/com~apple~CloudDocs/statement.pdf');
  put('Library/CloudStorage/GoogleDrive/transcript.pdf');
  put('data/vault.bin');
  fs.symlinkSync(path.join(home, '.ssh/id_ed25519'), path.join(home, 'Documents/innocent.pdf'));
  return { home, data: path.join(home, 'data') };
}

test('documents in the home folder are accepted, with ~ expanded and shown back', () => {
  const { home } = makeHome();
  const r = uploads.checkPaths(['~/Documents/resume.pdf', path.join(home, 'Documents/cover.pdf')], { home });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.files!.map((f) => f.name), ['resume.pdf', 'cover.pdf']);
  assert.equal(r.files![0].shown, path.join('~', 'Documents', 'resume.pdf'));
  assert.equal(r.files![0].size, Buffer.byteLength('résumé'));
});

test('the same file named twice is uploaded once', () => {
  const { home } = makeHome();
  const r = uploads.checkPaths(['~/Documents/resume.pdf', path.join(home, 'Documents/resume.pdf')], { home });
  assert.equal(r.files!.length, 1);
});

test('hidden files and folders are refused, through a symlink too', () => {
  const { home } = makeHome();
  assert.match(uploads.checkPaths(['~/.ssh/id_ed25519'], { home }).error!, /hidden/);
  assert.match(uploads.checkPaths(['~/.netrc'], { home }).error!, /hidden/);
  assert.match(uploads.checkPaths(['~/Documents/innocent.pdf'], { home }).error!, /hidden/, 'resolved before it is checked');
});

test('~/Library is refused, apart from iCloud Drive and cloud-storage folders', () => {
  const { home } = makeHome();
  assert.match(uploads.checkPaths(['~/Library/Keychains/login.keychain-db'], { home }).error!, /Library/);
  assert.equal(uploads.checkPaths(['~/Library/Mobile Documents/com~apple~CloudDocs/statement.pdf'], { home }).error, undefined);
  assert.equal(uploads.checkPaths(['~/Library/CloudStorage/GoogleDrive/transcript.pdf'], { home }).error, undefined);
});

test("cobrowser's own data is refused", () => {
  const { home, data } = makeHome();
  assert.match(uploads.checkPaths([path.join(data, 'vault.bin')], { home, refused: [data] }).error!, /cobrowser's own data/);
});

test('paths are literal, absolute files', () => {
  const { home } = makeHome();
  assert.match(uploads.checkPaths(['Documents/resume.pdf'], { home }).error!, /absolute/);
  assert.match(uploads.checkPaths(['~/Documents/*.pdf'], { home }).error!, /no such file.*wildcards/);
  assert.match(uploads.checkPaths(['~/Documents'], { home }).error!, /folder/);
  assert.match(uploads.checkPaths([], { home }).error!, /at least one/);
  assert.match(uploads.checkPaths([''], { home }).error!, /non-empty/);
  assert.match(uploads.checkPaths('~/Documents/resume.pdf', { home }).error!, /at least one/);
  assert.match(uploads.checkPaths(Array(uploads.MAX_FILES + 1).fill('~/Documents/resume.pdf'), { home }).error!, /at most/);
});

test('sizes read the way the dialog shows them', () => {
  assert.equal(uploads.formatSize(512), '512 B');
  assert.equal(uploads.formatSize(152 * 1024), '152 KB');
  assert.equal(uploads.formatSize(3.5 * 1024 * 1024), '3.5 MB');
});
