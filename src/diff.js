'use strict';
// Compare a local manifest against the server and decide what to upload / skip / delete.
const MANIFEST_NAME = '.deploy-manifest.json';
const BACKUP_PREFIX = '_backup-';

function isProtectedRemote(p) {
  return p === MANIFEST_NAME || p.startsWith(BACKUP_PREFIX) || p.includes('/' + BACKUP_PREFIX);
}

/**
 * plan({ local, remoteManifest, remoteListing, mirror })
 *  local:          [{ path, size, mtime, sha256 }]
 *  remoteManifest: { files: { path: { sha256 } } } | null   (written by the last deploy)
 *  remoteListing:  [{ path, size, mtime }]                  (files actually on the server)
 * → { upload: [{ path, size, reason }], skip: [path], verify: [{ path, size, sha256 }], extra: [path], delete: [path], uploadBytes }
 * `verify` = same size on both sides but no manifest hash to compare; resolveVerify() settles those.
 */
function plan({ local, remoteManifest, remoteListing, mirror = false }) {
  const remote = new Map(remoteListing.map(f => [f.path, f]));
  const manifest = (remoteManifest && remoteManifest.files) || {};
  const upload = [], skip = [], verify = [];
  const localSet = new Set();
  for (const f of [...local].sort((a, b) => a.path.localeCompare(b.path))) {
    localSet.add(f.path);
    const r = remote.get(f.path);
    if (!r) { upload.push({ path: f.path, size: f.size, reason: 'new' }); continue; }
    const m = manifest[f.path];
    if (m && m.sha256 === f.sha256 && r.size === f.size) {
      skip.push(f.path);                 // exactly what we deployed last time
    } else if (r.size !== f.size) {
      upload.push({ path: f.path, size: f.size, reason: 'changed' });
    } else {
      // same size but no manifest hash to trust (never deployed by us, or the folder was pulled since): read the server copy
      verify.push({ path: f.path, size: f.size, sha256: f.sha256 });
    }
  }
  const extra = [...remote.keys()].filter(p => !localSet.has(p) && !isProtectedRemote(p)).sort();
  return finalise({ upload, skip, verify, extra, delete: mirror ? [...extra] : [] });
}

function finalise(p) {
  p.upload.sort((a, b) => a.path.localeCompare(b.path));
  p.skip.sort();
  p.uploadBytes = p.upload.reduce((n, u) => n + u.size, 0);
  return p;
}

/**
 * Resolve the `verify` list by hashing the server copies. Files above `maxBytes` are assumed
 * unchanged (same size, too big to be worth a download). Mutates and returns the plan.
 */
async function resolveVerify(plan, { readFile, maxBytes = 8 * 1024 * 1024, onEvent = () => {} }) {
  const crypto = require('node:crypto');
  for (const v of plan.verify) {
    if (v.size > maxBytes) { plan.skip.push(v.path); continue; }
    onEvent({ type: 'verify', path: v.path });
    const remoteHash = crypto.createHash('sha256').update(await readFile(v.path)).digest('hex');
    if (remoteHash === v.sha256) plan.skip.push(v.path);
    else plan.upload.push({ path: v.path, size: v.size, reason: 'changed' });
  }
  plan.verify = [];
  return finalise(plan);
}

module.exports = { plan, resolveVerify, MANIFEST_NAME, BACKUP_PREFIX, isProtectedRemote };
