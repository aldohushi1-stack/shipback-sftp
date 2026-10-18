'use strict';
// Pull: server → local. Downloads new/changed files into the local folder, backing up anything it
// overwrites into <localDir>/_backup-<stamp>/. Never writes to the server.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { scanLocal, loadIgnore, dropIgnored } = require('./manifest');
const { MANIFEST_NAME, BACKUP_PREFIX } = require('./diff');
const { makeStamp } = require('./backup');

const isBackupDir = name => name.startsWith(BACKUP_PREFIX);
const VERIFY_MAX = 8 * 1024 * 1024;

async function readRemoteManifest(remoteFs, root) {
  try { return JSON.parse((await remoteFs.readFile(`${root}/${MANIFEST_NAME}`)).toString('utf8')); } catch { return null; }
}

/**
 * planPull({ localFiles, remoteListing, remoteManifest, mirror })
 * → { download: [{ path, size, reason }], verify: [{ path, size, localSha }], skip: [path], extra: [path], delete: [path] }
 */
function planPull({ localFiles, remoteListing, remoteManifest, mirror = false }) {
  const local = new Map(localFiles.map(f => [f.path, f]));
  const manifest = (remoteManifest && remoteManifest.files) || {};
  const deployedAt = remoteManifest && remoteManifest.deployedAt ? Date.parse(remoteManifest.deployedAt) : NaN;
  const download = [], verify = [], skip = [];
  const remoteSet = new Set();
  for (const r of [...remoteListing].sort((a, b) => a.path.localeCompare(b.path))) {
    if (r.path === MANIFEST_NAME) continue;
    remoteSet.add(r.path);
    const l = local.get(r.path);
    if (!l) { download.push({ path: r.path, size: r.size, reason: 'new' }); continue; }
    if (l.size !== r.size) { download.push({ path: r.path, size: r.size, reason: 'changed' }); continue; }
    const m = manifest[r.path];
    // We deployed this exact content and the server copy hasn't been touched since → unchanged without reading it.
    const trusted = m && m.sha256 === l.sha256 && Number.isFinite(deployedAt) && r.mtime <= deployedAt + 60_000;
    if (trusted) skip.push(r.path); else verify.push({ path: r.path, size: r.size, localSha: l.sha256 });
  }
  const extra = [...local.keys()].filter(p => !remoteSet.has(p)).sort();
  return { download, verify, skip, extra, delete: mirror ? [...extra] : [] };
}

async function removeEmptyDirs(dir, stopAt) {
  // walk up from dir removing empty folders until stopAt
  let cur = dir;
  while (cur.startsWith(stopAt) && cur !== stopAt) {
    try { const ents = await fs.readdir(cur); if (ents.length) break; await fs.rmdir(cur); } catch { break; }
    cur = path.dirname(cur);
  }
}

/**
 * runPull({ localDir, remoteRoot, remoteFs, dryRun, backup, mirror, ignore, now, onEvent })
 * → { dryRun, plan, downloaded, backedUp, backupDir, deleted, bytes }
 */
async function runPull({ localDir, remoteRoot, remoteFs, dryRun = false, backup = true, mirror = false, ignore, now = new Date(), onEvent = () => {} }) {
  const root = remoteRoot.replace(/\/$/, '');
  const summary = { dryRun, plan: null, downloaded: [], backedUp: [], backupDir: null, deleted: [], bytes: 0 };
  try {
    onEvent({ type: 'scan', side: 'remote', dir: root });
    const rootStat = await remoteFs.stat(root);
    if (!rootStat) throw new Error(`Remote folder not found on server: ${root}`);
    if (!rootStat.isDir) throw new Error(`Remote path is a file, not a folder: ${root}`);
    const fullListing = await remoteFs.listRecursive(root, { skipDir: isBackupDir });
    const remoteManifest = await readRemoteManifest(remoteFs, root);
    onEvent({ type: 'scan', side: 'local', dir: localDir });
    await fs.mkdir(localDir, { recursive: true });
    const localFiles = await scanLocal(localDir, { ignore });
    // ignored paths are hands-off on the server too: never offered as "new", never pulled over local copies
    const remoteListing = dropIgnored(fullListing, await loadIgnore(localDir, ignore));
    const plan = planPull({ localFiles, remoteListing, remoteManifest, mirror });

    // settle same-size files by reading the server copy (once; content is kept so it isn't fetched twice)
    const fetched = new Map();
    for (const v of plan.verify) {
      if (v.size > VERIFY_MAX) { plan.skip.push(v.path); continue; }
      onEvent({ type: 'verify', path: v.path });
      const data = await remoteFs.readFile(`${root}/${v.path}`);
      if (crypto.createHash('sha256').update(data).digest('hex') === v.localSha) plan.skip.push(v.path);
      else { plan.download.push({ path: v.path, size: v.size, reason: 'changed' }); fetched.set(v.path, data); }
    }
    plan.verify = []; plan.download.sort((a, b) => a.path.localeCompare(b.path)); plan.skip.sort();
    plan.downloadBytes = plan.download.reduce((n, d) => n + d.size, 0);
    summary.plan = plan;
    onEvent({ type: 'plan', plan, localCount: localFiles.length, remoteCount: remoteListing.length, direction: 'pull' });
    if (dryRun) { onEvent({ type: 'done', summary }); return summary; }

    // 1. local backup of files about to be overwritten or deleted
    const stamp = makeStamp(now);
    const backupDir = path.join(localDir, `${BACKUP_PREFIX}${stamp}`);
    if (backup) {
      const targets = [...plan.download.filter(d => d.reason === 'changed').map(d => d.path), ...plan.delete];
      for (const rel of targets) {
        const src = path.join(localDir, ...rel.split('/'));
        const dest = path.join(backupDir, ...rel.split('/'));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(src, dest);
        summary.backedUp.push(rel);
        onEvent({ type: 'backup', path: rel, to: dest });
      }
      if (summary.backedUp.length) summary.backupDir = backupDir;
    }

    // 2. download
    let i = 0;
    for (const d of plan.download) {
      const data = fetched.get(d.path) || await remoteFs.readFile(`${root}/${d.path}`);
      const dest = path.join(localDir, ...d.path.split('/'));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, data);
      summary.downloaded.push(d.path); summary.bytes += data.length;
      onEvent({ type: 'download', path: d.path, bytes: data.length, reason: d.reason, done: ++i, total: plan.download.length });
    }

    // 3. mirror deletes (local)
    for (const rel of plan.delete) {
      const p = path.join(localDir, ...rel.split('/'));
      await fs.rm(p, { force: true });
      await removeEmptyDirs(path.dirname(p), localDir);
      summary.deleted.push(rel);
      onEvent({ type: 'delete', path: rel, side: 'local' });
    }
    onEvent({ type: 'done', summary });
    return summary;
  } catch (err) {
    onEvent({ type: 'error', message: err.message, summary });
    throw err;
  }
}

module.exports = { runPull, planPull };
