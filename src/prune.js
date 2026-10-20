'use strict';
// Prune: remove _backup-<stamp>/ folders the deploys left on the server.
//
// Safety rule — a backup folder is only removed when every file in it still exists
// byte-for-byte somewhere else on the server: live at the same path under the root, or
// at the same path inside one of the backups being kept. A folder holding the only copy
// of anything is refused (listed in summary.refused with the unique paths) unless
// { force: true } is passed. Nothing is ever removed outside a _backup-* folder.
//
// runPrune({ remoteRoot, remoteFs, names?, keep?, dryRun, force, onEvent })
//   names: exact folder names to remove ('_backup-2026-09-24-2352', …)
//   keep:  or, keep the newest N backups and remove the rest (stamps sort by name)
// → { dryRun, backups, targets, pruned: [{ name, files, bytes }], refused: [{ name, unique }], deleted, bytes }
const crypto = require('node:crypto');
const { BACKUP_PREFIX } = require('./diff');
const { withLock } = require('./lock');
const { BACKUP_INFO } = require('./backup');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function listBackups(remoteFs, root) {
  const st = await remoteFs.stat(root);
  if (!st || !st.isDir) throw new Error(`Remote folder not found: ${root}`);
  return (await remoteFs.listDir(root)).filter(e => e.type === 'dir' && e.name.startsWith(BACKUP_PREFIX)).map(e => e.name).sort();
}

/** All directories under dir (absolute paths), deepest last. */
async function walkDirs(remoteFs, dir) {
  const out = [];
  const walk = async abs => {
    for (const e of await remoteFs.listDir(abs)) if (e.type === 'dir') { const p = abs + '/' + e.name; out.push(p); await walk(p); }
  };
  await walk(dir);
  return out;
}

function chooseTargets(backups, { names, keep }) {
  if (Array.isArray(names) && names.length) {
    const targets = [];
    for (const n of names) {
      if (typeof n !== 'string' || !n.startsWith(BACKUP_PREFIX) || n.includes('/') || n.includes('..')) throw new Error(`Not a backup folder name: "${n}" (must be ${BACKUP_PREFIX}<stamp>)`);
      if (!backups.includes(n)) throw new Error(`No such backup on the server: ${n}`);
      if (!targets.includes(n)) targets.push(n);
    }
    return targets;
  }
  if (Number.isInteger(keep) && keep >= 0) return backups.slice(0, Math.max(0, backups.length - keep)); // sorted ascending ⇒ oldest first
  throw new Error('Say which backups to prune: "names": ["_backup-…"] or "keep": N (newest N stay)');
}

function runPrune(opts) {
  if (opts.dryRun) return pruneNow(opts);
  return withLock({ remoteFs: opts.remoteFs, root: opts.remoteRoot, action: 'prune', onEvent: opts.onEvent }, () => pruneNow(opts));
}

async function pruneNow({ remoteRoot, remoteFs, names, keep, dryRun = false, force = false, onEvent = () => {} }) {
  const root = remoteRoot.replace(/\/$/, '');
  onEvent({ type: 'scan', side: 'remote', dir: root });
  const backups = await listBackups(remoteFs, root);
  const targets = chooseTargets(backups, { names, keep });
  const kept = backups.filter(b => !targets.includes(b));
  const summary = { dryRun, backups, targets, kept, pruned: [], refused: [], deleted: 0, bytes: 0 };
  onEvent({ type: 'prune-plan', backups, targets, kept });

  const hashCache = new Map();
  const hashOf = async abs => {
    if (hashCache.has(abs)) return hashCache.get(abs);
    let h = null;
    try { h = sha256(await remoteFs.readFile(abs)); } catch (e) { if (e.code !== 'ENOENT' && !/No such file/i.test(e.message)) throw e; }
    hashCache.set(abs, h);
    return h;
  };

  for (const name of targets) {
    const dir = `${root}/${name}`;
    const files = await remoteFs.listRecursive(dir);
    const unique = [];
    for (const f of files) {
      if (f.path === BACKUP_INFO) continue; // the folder's own record, not a copy of a site file
      const h = await hashOf(`${dir}/${f.path}`);
      let twin = (await hashOf(`${root}/${f.path}`)) === h;
      for (const k of kept) { if (twin) break; twin = (await hashOf(`${root}/${k}/${f.path}`)) === h; }
      if (!twin) unique.push(f.path);
    }
    const bytes = files.reduce((s, f) => s + f.size, 0);
    onEvent({ type: 'prune-check', name, files: files.length, bytes, unique: unique.length });
    if (unique.length && !force) {
      summary.refused.push({ name, unique });
      onEvent({ type: 'refuse', name, unique });
      continue;
    }
    if (!dryRun) {
      for (const f of files) { await remoteFs.remove(`${dir}/${f.path}`); onEvent({ type: 'delete', path: `${name}/${f.path}` }); }
      const dirs = await walkDirs(remoteFs, dir);
      for (const d of dirs.reverse()) { await remoteFs.rmdir(d); onEvent({ type: 'rmdir', path: d.slice(root.length + 1) }); }
      await remoteFs.rmdir(dir); onEvent({ type: 'rmdir', path: name });
    }
    summary.pruned.push({ name, files: files.length, bytes, forced: unique.length > 0 });
    summary.deleted += files.length; summary.bytes += bytes;
  }
  onEvent({ type: 'done', summary });
  return summary;
}

module.exports = { runPrune, listBackups, chooseTargets };
