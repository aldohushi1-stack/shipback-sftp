'use strict';
// Copy the server's current copy of each file into <root>/_backup-<stamp>/<path> before it is overwritten or deleted.
// A deploy also writes <backup>/.backup.json — what it overwrote, added and deleted, and the sha256 of what it
// uploaded — so restore.js can undo it and tell when a live file was edited after the deploy.
const crypto = require('node:crypto');
const posix = require('node:path').posix;
const { BACKUP_PREFIX, MANIFEST_NAME } = require('./diff');
const { writeLive, isHidden } = require('./remote-fs');

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

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * backupFiles({ remoteFs, root, paths, stamp | backupDir, onEvent }) → { backupDir, copied, was }
 *   was: Map path → sha256 of the copy saved, so restore can check the copy is still intact before using it
 */
async function backupFiles({ remoteFs, root, paths, stamp = makeStamp(), backupDir, onEvent = () => {} }) {
  root = root.replace(/\/$/, '');
  backupDir = backupDir || `${root}/${BACKUP_PREFIX}${stamp}`;
  const copied = [];
  const was = new Map();
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
    was.set(rel, sha256(data));
    onEvent({ type: 'backup', path: rel, bytes: data.length, to: dest });
  }
  return { backupDir, copied, was };
}

/**
 * writeBackupInfo({ remoteFs, backupDir, info })
 *   info: { action, at, overwritten: [{ path, sha256, was }], added: [{ path, sha256 }], deleted: [{ path, was }], from? }
 *   sha256 = the content the run left at that path, so a later restore can tell if it was edited since.
 *   was = the sha256 of the copy saved in the backup folder (from 0.2; older records have none).
 *   status (from 0.2): 'saving' while the copies are being made, so a run cut off then is known to have changed
 *   nothing; a restore also says 'running' while it writes, so cutting it off can be finished by running it again.
 *   No status = the record is whole. It is swapped in whole too, never left half written.
 */
async function writeBackupInfo({ remoteFs, backupDir, info }) {
  await remoteFs.mkdirp(backupDir);
  await writeLive(remoteFs, `${backupDir}/${BACKUP_INFO}`, { data: Buffer.from(JSON.stringify({ version: 1, tool: 'shipback-sftp', ...info }, null, 1)) });
}

/** A path a record may name: relative, inside the site, and not one of Shipback's own files. */
function siteRelative(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\') || p.includes('\0') || /^[A-Za-z]:/.test(p)) return false;
  const segs = p.split('/');
  return segs.every(s => s && s !== '.' && s !== '..' && !s.startsWith(BACKUP_PREFIX)) && p !== MANIFEST_NAME && !isHidden(p);
}

/**
 * The run's record, or null if the folder has none (a backup made before .backup.json existed).
 * A record that can't be read, or that names any path outside the site, throws: restore never guesses from it,
 * and never falls back to putting files back unchecked.
 */
async function readBackupInfo(remoteFs, backupDir) {
  if (!(await remoteFs.stat(`${backupDir}/${BACKUP_INFO}`))) return null;
  let info;
  try { info = JSON.parse((await remoteFs.readFile(`${backupDir}/${BACKUP_INFO}`)).toString('utf8')); }
  catch (e) { throw new Error(`${posix.basename(backupDir)}/${BACKUP_INFO} is damaged (${e.message.split('\n')[0]}), so it can't be restored safely`); }
  if (!info || info.version !== 1) throw new Error(`${posix.basename(backupDir)}/${BACKUP_INFO} is not a record this version understands`);
  for (const key of ['overwritten', 'added', 'deleted']) {
    if (!Array.isArray(info[key])) throw new Error(`${posix.basename(backupDir)}/${BACKUP_INFO} is damaged (no "${key}" list), so it can't be restored safely`);
    for (const e of info[key]) {
      if (!e || !siteRelative(e.path)) throw new Error(`${posix.basename(backupDir)}/${BACKUP_INFO} names a path outside the site (${JSON.stringify(e && e.path)}). Nothing was changed`);
    }
  }
  return info;
}

module.exports = { backupFiles, makeStamp, freeBackupDir, writeBackupInfo, readBackupInfo, siteRelative, BACKUP_INFO };
