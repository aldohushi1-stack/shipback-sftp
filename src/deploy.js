'use strict';
// Deploy orchestrator: scan → plan → backup → upload → (delete) → manifest.
const path = require('node:path');
const posix = path.posix;
const { scanLocal, loadIgnore, dropIgnored, sha256File } = require('./manifest');
const { plan: makePlan, resolveVerify, MANIFEST_NAME, BACKUP_PREFIX } = require('./diff');
const { backupFiles, makeStamp, freeBackupDir, writeBackupInfo } = require('./backup');
const { writeLive } = require('./remote-fs');
const { withLock } = require('./lock');

const isBackupDir = name => name.startsWith(BACKUP_PREFIX);

async function readRemoteManifest(remoteFs, root) {
  try { return JSON.parse((await remoteFs.readFile(`${root}/${MANIFEST_NAME}`)).toString('utf8')); }
  catch { return null; }
}

/** Preview only: scan both sides and return the plan. */
async function previewDeploy({ localDir, remoteRoot, remoteFs, mirror = false, ignore, onEvent = () => {} }) {
  const root = remoteRoot.replace(/\/$/, '');
  onEvent({ type: 'scan', side: 'local', dir: localDir });
  const local = await scanLocal(localDir, { ignore });
  onEvent({ type: 'scan', side: 'remote', dir: root });
  const rootStat = await remoteFs.stat(root);
  if (rootStat && !rootStat.isDir) throw new Error(`Remote path is a file, not a folder: ${root}`);
  // ignored paths are hands-off on the server too: never counted as extra, never mirror-deleted
  const remoteListing = rootStat ? dropIgnored(await remoteFs.listRecursive(root, { skipDir: isBackupDir }), await loadIgnore(localDir, ignore)) : [];
  const remoteManifest = rootStat ? await readRemoteManifest(remoteFs, root) : null;
  const plan = makePlan({ local, remoteManifest, remoteListing, mirror });
  if (plan.verify.length) await resolveVerify(plan, { readFile: p => remoteFs.readFile(`${root}/${p}`), onEvent });
  onEvent({ type: 'plan', plan, localCount: local.length, remoteCount: remoteListing.length, remoteExists: !!rootStat });
  return { local, plan, remoteExists: !!rootStat };
}

/**
 * runDeploy({ localDir, remoteRoot, remoteFs, dryRun, backup, mirror, ignore, now, onEvent })
 * → { dryRun, plan, uploaded, backedUp, backupDir, deleted, bytes }
 */
async function runDeploy(opts) {
  if (opts.dryRun) return deployNow(opts);
  return withLock({ remoteFs: opts.remoteFs, root: opts.remoteRoot, action: 'deploy', createRoot: true, onEvent: opts.onEvent }, () => deployNow(opts));
}

async function deployNow({ localDir, remoteRoot, remoteFs, dryRun = false, backup = true, mirror = false, ignore, now = new Date(), onEvent = () => {} }) {
  const root = remoteRoot.replace(/\/$/, '');
  const summary = { dryRun, plan: null, uploaded: [], backedUp: [], backupDir: null, deleted: [], bytes: 0 };
  try {
    const { local, plan, remoteExists } = await previewDeploy({ localDir, remoteRoot: root, remoteFs, mirror, ignore, onEvent });
    summary.plan = plan;
    if (dryRun) { onEvent({ type: 'done', summary }); return summary; }

    if (!remoteExists) { await remoteFs.mkdirp(root); onEvent({ type: 'mkdir', path: root }); }

    // 1. backup everything about to be overwritten or deleted, plus .backup.json so restore can undo this run.
    //    The record says 'saving' until every copy is made: cut off before that, the run has changed nothing.
    if (backup && (plan.upload.length || plan.delete.length)) {
      const backupDir = await freeBackupDir(remoteFs, root, makeStamp(now));
      await writeBackupInfo({ remoteFs, backupDir, info: { action: 'deploy', at: now.toISOString(), status: 'saving', overwritten: [], added: [], deleted: [] } });
      const targets = [...plan.upload.filter(u => u.reason === 'changed').map(u => u.path), ...plan.delete];
      const res = await backupFiles({ remoteFs, root, paths: targets, backupDir, onEvent });
      const copied = new Set(res.copied);
      const sha = new Map(local.map(f => [f.path, f.sha256]));
      await writeBackupInfo({ remoteFs, backupDir, info: {
        action: 'deploy', at: now.toISOString(),
        overwritten: plan.upload.filter(u => copied.has(u.path)).map(u => ({ path: u.path, sha256: sha.get(u.path), was: res.was.get(u.path) })),
        added: plan.upload.filter(u => !copied.has(u.path)).map(u => ({ path: u.path, sha256: sha.get(u.path) })),
        deleted: plan.delete.filter(p => copied.has(p)).map(p => ({ path: p, was: res.was.get(p) })),
      } });
      summary.backedUp = res.copied;
      summary.backupDir = backupDir;
    }

    // 2. upload new + changed, each swapped in whole (a dropped line leaves the old file, not half a new one)
    const madeDirs = new Set([root]);
    for (const u of plan.upload) {
      const dest = `${root}/${u.path}`;
      const dir = posix.dirname(dest);
      if (!madeDirs.has(dir)) { await remoteFs.mkdirp(dir); madeDirs.add(dir); }
      await writeLive(remoteFs, dest, { localPath: path.join(localDir, ...u.path.split('/')) });
      summary.uploaded.push(u.path); summary.bytes += u.size;
      onEvent({ type: 'upload', path: u.path, bytes: u.size, reason: u.reason, done: summary.uploaded.length, total: plan.upload.length });
    }

    // 3. mirror deletes
    for (const p of plan.delete) {
      await remoteFs.remove(`${root}/${p}`);
      summary.deleted.push(p);
      onEvent({ type: 'delete', path: p });
    }

    // 4. manifest for next time
    const files = {};
    for (const f of local) files[f.path] = { sha256: f.sha256, size: f.size, mtime: f.mtime };
    await remoteFs.writeFile(`${root}/${MANIFEST_NAME}`, JSON.stringify({ version: 1, deployedAt: new Date().toISOString(), files }, null, 1));
    onEvent({ type: 'manifest', path: MANIFEST_NAME, count: local.length });
    onEvent({ type: 'done', summary });
    return summary;
  } catch (err) {
    // a deploy that stopped part way is undone like any other: everything it touched is in its backup record
    if (summary.backupDir && summary.uploaded.length) err.undo = `${summary.uploaded.length} of ${summary.plan.upload.length} files went up before it stopped. --restore undoes them (${posix.basename(summary.backupDir)}).`;
    onEvent({ type: 'error', message: err.message, undo: err.undo, summary });
    throw err;
  }
}

/** Ad-hoc upload of named local files into a remote dir (with backup of anything overwritten). */
function uploadFiles(opts) {
  return withLock({ remoteFs: opts.remoteFs, root: opts.remoteDir, action: 'upload', createRoot: true, onEvent: opts.onEvent }, () => uploadNow(opts));
}

async function uploadNow({ files, remoteDir, remoteFs, backup = true, now = new Date(), onEvent = () => {} }) {
  // files: [{ name, localPath, size }]
  const root = remoteDir.replace(/\/$/, '');
  const summary = { uploaded: [], backedUp: [], backupDir: null, bytes: 0 };
  try {
    await remoteFs.mkdirp(root);
    if (backup && files.length) {
      const backupDir = await freeBackupDir(remoteFs, root, makeStamp(now));
      await writeBackupInfo({ remoteFs, backupDir, info: { action: 'upload', at: now.toISOString(), status: 'saving', overwritten: [], added: [], deleted: [] } });
      const res = await backupFiles({ remoteFs, root, paths: files.map(f => f.name), backupDir, onEvent });
      const copied = new Set(res.copied);
      const shas = new Map();
      for (const f of files) shas.set(f.name, await sha256File(f.localPath));
      await writeBackupInfo({ remoteFs, backupDir, info: {
        action: 'upload', at: now.toISOString(),
        overwritten: files.filter(f => copied.has(f.name)).map(f => ({ path: f.name, sha256: shas.get(f.name), was: res.was.get(f.name) })),
        added: files.filter(f => !copied.has(f.name)).map(f => ({ path: f.name, sha256: shas.get(f.name) })),
        deleted: [],
      } });
      summary.backedUp = res.copied; summary.backupDir = backupDir;
    }
    for (const f of files) {
      await writeLive(remoteFs, `${root}/${f.name}`, { localPath: f.localPath });
      summary.uploaded.push(f.name); summary.bytes += f.size || 0;
      onEvent({ type: 'upload', path: f.name, bytes: f.size || 0, reason: 'upload', done: summary.uploaded.length, total: files.length });
    }
    onEvent({ type: 'done', summary });
    return summary;
  } catch (err) {
    onEvent({ type: 'error', message: err.message, summary });
    throw err;
  }
}

module.exports = { runDeploy, previewDeploy, uploadFiles, MANIFEST_NAME };
