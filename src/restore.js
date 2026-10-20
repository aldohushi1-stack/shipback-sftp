'use strict';
// Restore: put a _backup-<stamp>/ folder back — the undo for a deploy.
//
// A deploy's backup folder holds the server copies of every file it overwrote or deleted, and
// .backup.json saying which files it added and what it uploaded (sha256). Restore:
//   · checks first that each live file is still what that run left there (or is already the old copy).
//     A file edited on the server since is a conflict, and then nothing is changed unless { force: true }
//   · checks each saved copy against the sha256 recorded when it was saved: a damaged copy is never put back
//   · copes with a run that stopped part way: files it never reached are already right, and a file caught
//     between "old removed" and "new swapped in" (servers without posix-rename) is found in its part file
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
const { partPath, writeLive } = require('./remote-fs');
const { withLock } = require('./lock');

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
      ? { name, action: info.action, at: info.at, from: info.from, overwritten: info.overwritten.length, added: info.added.length, deleted: info.deleted.length, files, legacy: false, status: info.status }
      : { name, files, legacy: true });
  }
  return out;
}

function runRestore(opts) {
  if (opts.dryRun) return restoreNow(opts);
  return withLock({ remoteFs: opts.remoteFs, root: opts.remoteRoot, action: 'restore', onEvent: opts.onEvent }, () => restoreNow(opts));
}

async function restoreNow({ remoteRoot, remoteFs, name, dryRun = false, force = false, now = new Date(), onEvent = () => {} }) {
  const root = remoteRoot.replace(/\/$/, '');
  onEvent({ type: 'scan', side: 'remote', dir: root });
  let target = chooseBackup(await listBackups(remoteFs, root), name);
  let info = await readBackupInfo(remoteFs, `${root}/${target}`);
  let resumed = null;
  // the latest run is a restore that was cut off: running it again finishes that restore
  const latest = name === undefined || name === null || name === '' || name === 'latest';
  if (latest && info && info.action === 'restore' && info.status && info.from) {
    resumed = target; target = chooseBackup(await listBackups(remoteFs, root), info.from);
    info = await readBackupInfo(remoteFs, `${root}/${target}`);
  }
  const dir = `${root}/${target}`;
  const summary = { dryRun, backup: target, action: info ? info.action : undefined, legacy: !info, resumed, stoppedEarly: false, put: [], remove: [], same: [], conflicts: [], refused: false, undoBackupDir: null };
  if (info && info.status === 'saving') {
    // that run was cut off while it was still making its backup copies, before it changed a single live file
    summary.stoppedEarly = true;
    onEvent({ type: 'restore-plan', backup: target, put: [], remove: [], same: 0, conflicts: 0, legacy: false, stoppedEarly: true });
    onEvent({ type: 'done', summary });
    return summary;
  }

  const left = new Map();      // path → sha256 the run left there (overwritten + added)
  const deleted = new Set();   // paths the run deleted
  const was = new Map();       // path → sha256 of the copy saved in the backup folder (records from 0.2 on)
  if (info) {
    for (const e of [...info.overwritten, ...info.added]) left.set(e.path, e.sha256);
    for (const e of info.deleted) deleted.add(e.path);
    for (const e of [...info.overwritten, ...info.deleted]) if (e.was) was.set(e.path, e.was);
  }
  const live = async p => {
    const st = await remoteFs.stat(`${root}/${p}`);
    if (!st) {
      // the line dropped mid-swap: the run's whole copy is still in the part file
      const part = partPath(`${root}/${p}`);
      if (left.has(p) && await remoteFs.stat(part) && sha256(await remoteFs.readFile(part)) === left.get(p)) return left.get(p);
      return null;
    }
    return st.isDir ? 'dir' : sha256(await remoteFs.readFile(`${root}/${p}`));
  };
  const conflict = (p, why) => summary.conflicts.push({ path: p, why });

  // 1. what goes back: every file in the backup folder
  const puts = [];
  for (const f of (await remoteFs.listRecursive(dir)).filter(f => f.path !== BACKUP_INFO)) {
    const data = await remoteFs.readFile(`${dir}/${f.path}`);
    if (was.has(f.path) && sha256(data) !== was.get(f.path)) { conflict(f.path, 'its copy in the backup folder is damaged (it no longer matches what was saved)'); continue; } // never put back, even forced
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
  // part files a stopped run left behind (hidden from listings, but they hold the run's bytes)
  const sweepParts = async () => {
    for (const p of new Set([...left.keys(), ...deleted])) {
      const part = partPath(`${root}/${p}`);
      if (await remoteFs.stat(part)) await remoteFs.remove(part).catch(() => {});
    }
  };
  if (dryRun) { onEvent({ type: 'done', summary }); return summary; }
  if (!puts.length && !removes.length) { await sweepParts(); onEvent({ type: 'done', summary }); return summary; }
  try {
    // 3. back up what is live now, so this restore can be undone too. Its record says 'saving', then 'running'
    //    while files are written, then nothing: cut off part way, running restore again finishes the job.
    const undoDir = await freeBackupDir(remoteFs, root, makeStamp(now));
    summary.undoBackupDir = undoDir;
    const head = { action: 'restore', from: target, at: now.toISOString() };
    await writeBackupInfo({ remoteFs, backupDir: undoDir, info: { ...head, status: 'saving', overwritten: [], added: [], deleted: [] } });
    const res = await backupFiles({ remoteFs, root, paths: [...summary.put, ...summary.remove], backupDir: undoDir, onEvent });
    const copied = new Set(res.copied);
    const record = {
      ...head,
      overwritten: puts.filter(p => copied.has(p.path)).map(p => ({ path: p.path, sha256: sha256(p.data), was: res.was.get(p.path) })),
      added: puts.filter(p => !copied.has(p.path)).map(p => ({ path: p.path, sha256: sha256(p.data) })),
      deleted: removes.filter(p => copied.has(p)).map(p => ({ path: p, was: res.was.get(p) })),
    };
    await writeBackupInfo({ remoteFs, backupDir: undoDir, info: { ...record, status: 'running' } });

    // 4. put the old copies back, take the added files off
    const madeDirs = new Set();
    for (const p of puts) {
      const dest = `${root}/${p.path}`;
      const d = posix.dirname(dest);
      if (!madeDirs.has(d)) { await remoteFs.mkdirp(d); madeDirs.add(d); }
      await writeLive(remoteFs, dest, { data: p.data });
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

    await sweepParts();

    // 5. the manifest no longer describes these paths
    try {
      const m = JSON.parse((await remoteFs.readFile(`${root}/${MANIFEST_NAME}`)).toString('utf8'));
      for (const p of [...summary.put, ...summary.remove]) delete m.files[p];
      await remoteFs.writeFile(`${root}/${MANIFEST_NAME}`, JSON.stringify(m, null, 1));
    } catch { /* no manifest: nothing to correct */ }
    await writeBackupInfo({ remoteFs, backupDir: undoDir, info: record });
  } catch (err) {
    err.undo = 'The restore stopped part way. Run the same restore again: it finishes the job.';
    onEvent({ type: 'error', message: err.message, undo: err.undo, summary });
    throw err;
  }

  onEvent({ type: 'done', summary });
  return summary;
}

module.exports = { runRestore, describeBackups, chooseBackup };
