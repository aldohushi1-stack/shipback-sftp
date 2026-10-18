'use strict';
// Copy the server's current copy of each file into <root>/_backup-<stamp>/<path> before it is overwritten or deleted.
// A deploy also writes <backup>/.backup.json — what it overwrote, added and deleted, and the sha256 of what it
// uploaded — so restore.js can undo it and tell when a live file was edited after the deploy.
const posix = require('node:path').posix;
const { BACKUP_PREFIX } = require('./diff');

const BACKUP_INFO = '.backup.json';

const pad = n => String(n).padStart(2, '0');
function makeStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** First _backup-<stamp> folder name not already on the server (two runs in one minute get -2, -3 …). */
async function freeBackupDir(remoteFs, root, stamp) {
  root = root.replace(/\/$/, '');
  let dir = `${root}/${BACKUP_PREFIX}${stamp}`;
  for (let n = 2; await remoteFs.stat(dir); n++) dir = `${root}/${BACKUP_PREFIX}${stamp}-${n}`;
  return dir;
}

/** backupFiles({ remoteFs, root, paths, stamp | backupDir, onEvent }) → { backupDir, copied } */
async function backupFiles({ remoteFs, root, paths, stamp = makeStamp(), backupDir, onEvent = () => {} }) {
  root = root.replace(/\/$/, '');
  backupDir = backupDir || `${root}/${BACKUP_PREFIX}${stamp}`;
  const copied = [];
  const madeDirs = new Set();
  for (const rel of paths) {
    const src = `${root}/${rel}`;
    const st = await remoteFs.stat(src);
    if (!st || st.isDir) continue;
    const dest = `${backupDir}/${rel}`;
    const dir = posix.dirname(dest);
    if (!madeDirs.has(dir)) { await remoteFs.mkdirp(dir); madeDirs.add(dir); }
    const data = await remoteFs.readFile(src);
    await remoteFs.writeFile(dest, data);
    copied.push(rel);
    onEvent({ type: 'backup', path: rel, bytes: data.length, to: dest });
  }
  return { backupDir, copied };
}

/**
 * writeBackupInfo({ remoteFs, backupDir, info })
 *   info: { action, at, overwritten: [{ path, sha256 }], added: [{ path, sha256 }], deleted: [{ path }], from? }
 *   sha256 = the content the run left at that path, so a later restore can tell if it was edited since.
 */
async function writeBackupInfo({ remoteFs, backupDir, info }) {
  await remoteFs.mkdirp(backupDir);
  await remoteFs.writeFile(`${backupDir}/${BACKUP_INFO}`, JSON.stringify({ version: 1, tool: 'shipback-sftp', ...info }, null, 1));
}

async function readBackupInfo(remoteFs, backupDir) {
  try {
    const info = JSON.parse((await remoteFs.readFile(`${backupDir}/${BACKUP_INFO}`)).toString('utf8'));
    return info && info.version === 1 ? info : null;
  } catch { return null; }
}

module.exports = { backupFiles, makeStamp, freeBackupDir, writeBackupInfo, readBackupInfo, BACKUP_INFO };
