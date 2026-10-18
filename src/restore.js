'use strict';
// Restore: put a _backup-<stamp>/ folder back — the undo for a deploy.
//
// A deploy's backup folder holds the server copies of every file it overwrote or deleted, and
// .backup.json saying which files it added and what it uploaded (sha256). Restore:
//   · checks first that each live file is still what that run left there (or is already the old copy).
//     A file edited on the server since is a conflict, and then nothing is changed unless { force: true }
//   · backs up everything it is about to change into a new _backup-<stamp>/ with its own .backup.json,
//     so a restore can itself be restored
//   · writes each backed-up file back to its live path and removes the files that run added
//   · drops the touched paths from .deploy-manifest.json, so the next deploy compares them by content
// A backup with no .backup.json (made by an older version) restores its files only: summary.legacy = true,
// added files stay, and there is nothing to check edits against.
//
// runRestore({ remoteRoot, remoteFs, name, dryRun, force, now, onEvent })
//   name: the backup folder ('_backup-2026-10-18-1400') or 'latest' / omitted for the newest
// → { dryRun, backup, action, legacy, put, remove, same, conflicts: [{ path, why }], refused, undoBackupDir }
const crypto = require('node:crypto');
const posix = require('node:path').posix;
const { BACKUP_PREFIX, MANIFEST_NAME } = require('./diff');
const { backupFiles, makeStamp, freeBackupDir, writeBackupInfo, readBackupInfo, BACKUP_INFO } = require('./backup');
const { listBackups } = require('./prune');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function chooseBackup(backups, name) {
  if (!backups.length) throw new Error('There are no _backup-* folders on the server to restore from');
  if (name === undefined || name === null || name === '' || name === 'latest') return backups[backups.length - 1];
  if (typeof name !== 'string' || !name.startsWith(BACKUP_PREFIX) || name.includes('/') || name.includes('\\') || name.includes('..')) throw new Error(`Not a backup folder name: "${name}" (must be ${BACKUP_PREFIX}<stamp>, or "latest")`);
  if (!backups.includes(name)) throw new Error(`No such backup on the server: ${name}`);
  return name;
}

/** Backups newest first, each with what it holds: [{ name, action, at, overwritten, added, deleted, files, legacy }] */
async function describeBackups({ remoteRoot, remoteFs }) {
  const root = remoteRoot.replace(/\/$/, '');
  const out = [];
  for (const name of (await listBackups(remoteFs, root)).reverse()) {
    const info = await readBackupInfo(remoteFs, `${root}/${name}`);
    const files = (await remoteFs.listRecursive(`${root}/${name}`)).filter(f => f.path !== BACKUP_INFO).length;
    out.push(info
      ? { name, action: info.action, at: info.at, from: info.from, overwritten: info.overwritten.length, added: info.added.length, deleted: info.deleted.length, files, legacy: false }
      : { name, files, legacy: true });
  }
  return out;
}

async function runRestore({ remoteRoot, remoteFs, name, dryRun = false, force = false, now = new Date(), onEvent = () => {} }) {
  const root = remoteRoot.replace(/\/$/, '');
  onEvent({ type: 'scan', side: 'remote', dir: root });
  const target = chooseBackup(await listBackups(remoteFs, root), name);
  const dir = `${root}/${target}`;
  const info = await readBackupInfo(remoteFs, dir);
  const summary = { dryRun, backup: target, action: info ? info.action : undefined, legacy: !info, put: [], remove: [], same: [], conflicts: [], refused: false, undoBackupDir: null };

  const left = new Map();      // path → sha256 the run left there (overwritten + added)
  const deleted = new Set();   // paths the run deleted
  if (info) {
    for (const e of [...info.overwritten, ...info.added]) left.set(e.path, e.sha256);
    for (const e of info.deleted) deleted.add(e.path);
  }
  const live = async p => {
    const st = await remoteFs.stat(`${root}/${p}`);
    if (!st) return null;
    return st.isDir ? 'dir' : sha256(await remoteFs.readFile(`${root}/${p}`));
  };
  const conflict = (p, why) => summary.conflicts.push({ path: p, why });

  // 1. what goes back: every file in the backup folder
  const puts = [];
  for (const f of (await remoteFs.listRecursive(dir)).filter(f => f.path !== BACKUP_INFO)) {
    const data = await remoteFs.readFile(`${dir}/${f.path}`);
    const now_ = await live(f.path);
    if (now_ === sha256(data)) { summary.same.push(f.path); continue; }
    if (now_ === 'dir') { conflict(f.path, 'is a folder on the server now'); continue; } // can't write a file over it, even forced
    puts.push({ path: f.path, data });
    if (left.has(f.path) && now_ !== left.get(f.path)) conflict(f.path, now_ === null ? 'deleted on the server after that run' : 'edited on the server after that run');
    else if (deleted.has(f.path) && now_ !== null) conflict(f.path, 'put back on the server after that run deleted it');
  }
  // 2. what comes off: the files that run added
  const removes = [];
  if (info) for (const e of info.added) {
    const now_ = await live(e.path);
    if (now_ === null) { summary.same.push(e.path); continue; }
    if (now_ === 'dir') { conflict(e.path, 'is a folder on the server now'); continue; }
    removes.push(e.path);
    if (now_ !== e.sha256) conflict(e.path, 'edited on the server after that run added it');
  }
  summary.put = puts.map(p => p.path).sort();
  summary.remove = removes.sort();
  summary.same.sort();
  onEvent({ type: 'restore-plan', backup: target, put: summary.put, remove: summary.remove, same: summary.same.length, conflicts: summary.conflicts.length, legacy: summary.legacy });
  for (const c of summary.conflicts) onEvent({ type: 'conflict', ...c });

  if (summary.conflicts.length && !force) {
    summary.refused = true;
    onEvent({ type: 'done', summary });
    return summary;
  }
  if (dryRun || (!puts.length && !removes.length)) { onEvent({ type: 'done', summary }); return summary; }

  // 3. back up what is live now, so this restore can be undone too
  const undoDir = await freeBackupDir(remoteFs, root, makeStamp(now));
  const res = await backupFiles({ remoteFs, root, paths: [...summary.put, ...summary.remove], backupDir: undoDir, onEvent });
  const copied = new Set(res.copied);
  await writeBackupInfo({ remoteFs, backupDir: undoDir, info: {
    action: 'restore', from: target, at: now.toISOString(),
    overwritten: puts.filter(p => copied.has(p.path)).map(p => ({ path: p.path, sha256: sha256(p.data) })),
    added: puts.filter(p => !copied.has(p.path)).map(p => ({ path: p.path, sha256: sha256(p.data) })),
    deleted: removes.filter(p => copied.has(p)).map(p => ({ path: p })),
  } });
  summary.undoBackupDir = undoDir;

  // 4. put the old copies back, take the added files off
  const madeDirs = new Set();
  for (const p of puts) {
    const dest = `${root}/${p.path}`;
    const d = posix.dirname(dest);
    if (!madeDirs.has(d)) { await remoteFs.mkdirp(d); madeDirs.add(d); }
    await remoteFs.writeFile(dest, p.data);
    onEvent({ type: 'restore', path: p.path, bytes: p.data.length });
  }
  for (const p of removes) { await remoteFs.remove(`${root}/${p}`); onEvent({ type: 'delete', path: p }); }
  // folders the deploy made just for added files go too, once empty
  for (const d of [...new Set(removes.map(p => posix.dirname(p)).filter(d => d !== '.'))].sort((a, b) => b.length - a.length)) {
    for (let cur = d; cur !== '.'; cur = posix.dirname(cur)) {
      const abs = `${root}/${cur}`;
      if (!(await remoteFs.stat(abs)) || (await remoteFs.listDir(abs)).length) break;
      await remoteFs.rmdir(abs);
    }
  }

  // 5. the manifest no longer describes these paths
  try {
    const m = JSON.parse((await remoteFs.readFile(`${root}/${MANIFEST_NAME}`)).toString('utf8'));
    for (const p of [...summary.put, ...summary.remove]) delete m.files[p];
    await remoteFs.writeFile(`${root}/${MANIFEST_NAME}`, JSON.stringify(m, null, 1));
  } catch { /* no manifest: nothing to correct */ }

  onEvent({ type: 'done', summary });
  return summary;
}

module.exports = { runRestore, describeBackups, chooseBackup };
