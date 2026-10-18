'use strict';
// Local folder scan → manifest [{ path, size, mtime, sha256 }], with gitignore-style ignore rules.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_IGNORE = ['.git/', 'node_modules/', 'Thumbs.db', '.DS_Store', 'desktop.ini', '*.tmp', '.deployignore', '_backup-*/'];
const IGNORE_FILE = '.deployignore';

function parseIgnoreFile(text) {
  return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

function globToRegex(glob) {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

/** makeMatcher(globs) → (relPosixPath, isDir) => boolean */
function makeMatcher(globs) {
  const rules = globs.map(g => {
    let dirOnly = false, pattern = g;
    if (pattern.endsWith('/')) { dirOnly = true; pattern = pattern.slice(0, -1); }
    const anchored = pattern.includes('/');
    if (anchored && pattern.startsWith('/')) pattern = pattern.slice(1);
    const body = globToRegex(pattern);
    // anchored patterns match from the root; bare names match at any depth
    const re = anchored ? new RegExp('^' + body + '(/|$)') : new RegExp('(^|/)' + body + '(/|$)');
    return { re, dirOnly };
  });
  return (rel, isDir) => {
    for (const r of rules) {
      const m = r.re.exec(rel);
      if (!m) continue;
      if (!r.dirOnly) return true;
      // dir-only rule: matches if the matched segment is a directory (i.e. something follows it, or the entry itself is a dir)
      const matchedToEnd = m[0].length === rel.length - m.index && !m[0].endsWith('/');
      if (!matchedToEnd || isDir) return true;
    }
    return false;
  };
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    createReadStream(p).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/**
 * loadIgnore(dir, ignore) → (relPosixPath, isDir) => boolean
 * The one set of ignore rules for a site: built-in defaults + the site's "ignore" list + the local .deployignore.
 * Used for the local scan AND to filter the server listing, so an ignored path is hands-off in both directions
 * (never uploaded, never pulled, never mirror-deleted).
 */
async function loadIgnore(dir, ignore = []) {
  let globs = [...DEFAULT_IGNORE, ...(ignore || [])];
  try { globs = globs.concat(parseIgnoreFile(await fs.readFile(path.join(dir, IGNORE_FILE), 'utf8'))); } catch { /* none */ }
  return makeMatcher(globs);
}

/** dropIgnored(remoteListing, ignored) → the listing without ignored files ([{ path, ... }], paths relative to the root) */
function dropIgnored(listing, ignored) {
  return listing.filter(f => !ignored(f.path, false));
}

/** scanLocal(dir, { ignore }) → sorted manifest */
async function scanLocal(dir, opts = {}) {
  let st;
  try { st = await fs.stat(dir); } catch (e) { throw new Error(`Local folder not found: ${dir}`); }
  if (!st.isDirectory()) throw new Error(`Not a folder: ${dir}`);
  const ignored = await loadIgnore(dir, opts.ignore);
  const out = [];
  async function walk(abs, rel) {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!ignored(r, true)) await walk(path.join(abs, e.name), r); continue; }
      if (!e.isFile()) continue;
      if (ignored(r, false)) continue;
      const full = path.join(abs, e.name);
      const s = await fs.stat(full);
      out.push({ path: r, size: s.size, mtime: Math.floor(s.mtimeMs), sha256: await sha256File(full) });
    }
  }
  await walk(dir, '');
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

module.exports = { scanLocal, loadIgnore, dropIgnored, makeMatcher, parseIgnoreFile, DEFAULT_IGNORE, IGNORE_FILE, sha256File };
