'use strict';
/**
 * Files an agent asks to upload (upload_file), checked before the human is asked. The human
 * confirms every upload, but a confirmation can be clicked through, so some places are
 * refused whatever the answer would be: cobrowser's own data (the vault, the profiles and
 * their cookies, the tokens), hidden files and folders (keys, credentials, shell history),
 * and ~/Library, which holds every app's private data. iCloud Drive and the cloud-storage
 * folders live under ~/Library too, and stay allowed: that is where documents are.
 *
 * Paths are literal. No wildcards, no folders, no relative paths: the agent names each file.
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_FILES = 10;

/** Under ~/Library, the folders that hold the person's documents rather than an app's data. */
const LIBRARY_DOCUMENTS = ['Mobile Documents', 'CloudStorage'];

function realOrSelf(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function within(file, dir) {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** "~/Documents/cv.pdf" for a file in the home folder: what the human reads in the dialog. */
function display(file, home) {
  return within(file, home) ? path.join('~', path.relative(home, file)) : file;
}

/** Why a resolved path is refused, or undefined when it may be offered to the human. */
function refusal(real, { home, refused }) {
  for (const dir of refused) {
    if (within(real, realOrSelf(dir))) return 'it is in cobrowser\'s own data (the vault, profiles and tokens)';
  }
  if (real.split(path.sep).some((seg) => seg.startsWith('.'))) return 'it is a hidden file or inside a hidden folder, where keys and credentials live';
  const library = path.join(realOrSelf(home), 'Library');
  if (within(real, library) && !LIBRARY_DOCUMENTS.some((d) => within(real, path.join(library, d)))) {
    return 'it is in ~/Library, which holds apps\' private data (only iCloud Drive and cloud-storage folders there are allowed)';
  }
  return undefined;
}

/**
 * Resolve and check the paths an agent gave. Returns { files: [{ path, name, size, shown }] }
 * or { error } naming the first path that cannot be uploaded and why.
 *   home    — the person's home folder ("~" expands to it)
 *   refused — folders never uploaded from (cobrowser's data and state folders)
 */
function checkPaths(paths, { home, refused = [] }) {
  if (!Array.isArray(paths) || paths.length === 0) return { error: 'filePaths needs at least one file' };
  if (paths.length > MAX_FILES) return { error: `at most ${MAX_FILES} files per upload` };
  const files = [];
  for (const given of paths) {
    if (typeof given !== 'string' || !given.trim()) return { error: 'every file path must be a non-empty string' };
    const expanded = given === '~' ? home : given.startsWith('~/') ? path.join(home, given.slice(2)) : given;
    if (!path.isAbsolute(expanded)) return { error: `${given}: pass an absolute path (or one starting with ~/)` };
    let real;
    try { real = fs.realpathSync(expanded); } catch {
      return { error: `${given}: no such file (paths are taken literally: no wildcards)` };
    }
    const st = fs.statSync(real);
    if (!st.isFile()) return { error: `${given}: not a file${st.isDirectory() ? ' (a folder: name the files in it)' : ''}` };
    const why = refusal(real, { home, refused });
    if (why) return { error: `${given}: refused, ${why}` };
    if (files.some((f) => f.path === real)) continue;
    files.push({ path: real, name: path.basename(real), size: st.size, shown: display(real, realOrSelf(home)) });
  }
  return { files };
}

/** "152 KB", for the dialog. */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = { checkPaths, formatSize, MAX_FILES };
