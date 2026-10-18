'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MemoryRemoteFs, SftpRemoteFs } = require('../src/remote-fs');
const { runDeploy, previewDeploy, MANIFEST_NAME } = require('../src/deploy');
const { runRestore, describeBackups, chooseBackup } = require('../src/restore');
const { runPrune } = require('../src/prune');
const { BACKUP_INFO } = require('../src/backup');
const { start } = require('./helpers/sftp-server');

async function tmpTree(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-rst-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
  return dir;
}

const ROOT = '/home/deploy/public_html';
const T1 = new Date(2026, 9, 18, 14, 0);
const T2 = new Date(2026, 9, 18, 14, 5);
const T3 = new Date(2026, 9, 18, 14, 10);
const read = async (r, p) => (await r.readFile(`${ROOT}/${p}`)).toString();

async function seededRemote() {
  const r = new MemoryRemoteFs();
  await r.mkdirp(ROOT + '/css');
  await r.writeFile(ROOT + '/index.html', Buffer.from('OLD'));
  await r.writeFile(ROOT + '/css/site.css', Buffer.from('OLD CSS'));
  await r.writeFile(ROOT + '/stale.html', Buffer.from('STALE'));
  return r;
}

/** A deploy that overwrites index.html, adds new.html and (mirror) deletes stale.html. */
async function deployed() {
  const local = await tmpTree({ 'index.html': 'NEW', 'css/site.css': 'OLD CSS', 'new.html': 'N' });
  const remote = await seededRemote();
  const s = await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: T1, mirror: true });
  return { local, remote, s };
}

test('a deploy writes .backup.json saying what it overwrote, added and deleted', async () => {
  const { remote, s } = await deployed();
  assert.equal(s.backupDir, ROOT + '/_backup-2026-10-18-1400');
  const info = JSON.parse(await read(remote, '_backup-2026-10-18-1400/' + BACKUP_INFO));
  assert.equal(info.action, 'deploy');
  assert.deepEqual(info.overwritten.map(e => e.path), ['index.html']);
  assert.deepEqual(info.added.map(e => e.path), ['new.html']);
  assert.deepEqual(info.deleted.map(e => e.path), ['stale.html']);
  assert.equal(info.overwritten[0].sha256.length, 64);
});

test('restore latest undoes the deploy: old copies back, added files gone, deleted files back', async () => {
  const { remote } = await deployed();
  const s = await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2 });
  assert.equal(s.refused, false);
  assert.equal(s.backup, '_backup-2026-10-18-1400');
  assert.deepEqual(s.put, ['index.html', 'stale.html']);
  assert.deepEqual(s.remove, ['new.html']);
  assert.equal(await read(remote, 'index.html'), 'OLD');
  assert.equal(await read(remote, 'stale.html'), 'STALE');
  assert.equal(await remote.stat(ROOT + '/new.html'), null);
  assert.equal(await read(remote, 'css/site.css'), 'OLD CSS', 'untouched files stay');
  // the restore made its own backup of what it replaced
  assert.equal(s.undoBackupDir, ROOT + '/_backup-2026-10-18-1405');
  assert.equal(await read(remote, '_backup-2026-10-18-1405/index.html'), 'NEW');
  assert.equal(await read(remote, '_backup-2026-10-18-1405/new.html'), 'N');
  const undo = JSON.parse(await read(remote, '_backup-2026-10-18-1405/' + BACKUP_INFO));
  assert.equal(undo.action, 'restore'); assert.equal(undo.from, '_backup-2026-10-18-1400');
});

test('after a restore the manifest forgets the touched paths, so the next deploy puts them back', async () => {
  const { local, remote } = await deployed();
  await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2 });
  const m = JSON.parse(await read(remote, MANIFEST_NAME));
  assert.equal(m.files['index.html'], undefined);
  assert.equal(m.files['new.html'], undefined);
  assert.ok(m.files['css/site.css'], 'untouched entries kept');
  const { plan } = await previewDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, mirror: true });
  assert.deepEqual(plan.upload.map(u => u.path), ['index.html', 'new.html']);
  assert.deepEqual(plan.delete, ['stale.html']);
});

test('restoring the restore brings the deploy back', async () => {
  const { remote } = await deployed();
  await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2 });
  const s = await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T3 });
  assert.equal(s.backup, '_backup-2026-10-18-1405');
  assert.equal(await read(remote, 'index.html'), 'NEW');
  assert.equal(await read(remote, 'new.html'), 'N');
  assert.equal(await remote.stat(ROOT + '/stale.html'), null);
});

test('dry run reports the same plan and changes nothing', async () => {
  const { remote } = await deployed();
  const before = JSON.stringify(remote.dump());
  const s = await runRestore({ remoteRoot: ROOT, remoteFs: remote, dryRun: true, now: T2 });
  assert.deepEqual(s.put, ['index.html', 'stale.html']);
  assert.deepEqual(s.remove, ['new.html']);
  assert.equal(s.undoBackupDir, null);
  assert.equal(JSON.stringify(remote.dump()), before);
});

test('a file edited on the server since the deploy is a conflict: nothing changes unless forced', async () => {
  const { remote } = await deployed();
  await remote.writeFile(ROOT + '/index.html', Buffer.from('HOTFIX MADE LIVE'));
  await remote.writeFile(ROOT + '/new.html', Buffer.from('N, edited'));
  const before = JSON.stringify(remote.dump());
  const s = await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2 });
  assert.equal(s.refused, true);
  assert.deepEqual(s.conflicts.map(c => c.path).sort(), ['index.html', 'new.html']);
  assert.match(s.conflicts.find(c => c.path === 'index.html').why, /edited on the server/);
  assert.equal(JSON.stringify(remote.dump()), before, 'refused restore wrote nothing');

  const f = await runRestore({ remoteRoot: ROOT, remoteFs: remote, force: true, now: T2 });
  assert.equal(f.refused, false);
  assert.equal(await read(remote, 'index.html'), 'OLD');
  assert.equal(await read(remote, '_backup-2026-10-18-1405/index.html'), 'HOTFIX MADE LIVE', 'the live edit is kept in the undo backup');
  assert.equal(await read(remote, '_backup-2026-10-18-1405/new.html'), 'N, edited');
});

test('a file the deploy deleted that came back since is a conflict', async () => {
  const { remote } = await deployed();
  await remote.writeFile(ROOT + '/stale.html', Buffer.from('SOMEONE PUT IT BACK'));
  const s = await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2 });
  assert.equal(s.refused, true);
  assert.deepEqual(s.conflicts, [{ path: 'stale.html', why: 'put back on the server after that run deleted it' }]);
});

test('files already back to the old copy count as same, not as work', async () => {
  const { remote } = await deployed();
  await remote.writeFile(ROOT + '/index.html', Buffer.from('OLD'));
  await remote.remove(ROOT + '/new.html');
  const s = await runRestore({ remoteRoot: ROOT, remoteFs: remote, dryRun: true, now: T2 });
  assert.equal(s.refused, false);
  assert.deepEqual(s.put, ['stale.html']);
  assert.deepEqual(s.remove, []);
  assert.deepEqual(s.same, ['index.html', 'new.html']);
});

test('two deploys in the same minute get separate backup folders, and restore latest undoes only the second', async () => {
  const local = await tmpTree({ 'index.html': 'V1' });
  const remote = await seededRemote();
  const a = await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: T1 });
  await fs.writeFile(path.join(local, 'index.html'), 'V2');
  const b = await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: T1 });
  assert.equal(a.backupDir, ROOT + '/_backup-2026-10-18-1400');
  assert.equal(b.backupDir, ROOT + '/_backup-2026-10-18-1400-2');
  assert.equal(await read(remote, '_backup-2026-10-18-1400/index.html'), 'OLD', 'first backup not overwritten');
  await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2 });
  assert.equal(await read(remote, 'index.html'), 'V1');
});

test('an additions-only deploy is still undoable, and its backup folder can be pruned', async () => {
  const local = await tmpTree({ 'index.html': 'OLD', 'css/site.css': 'OLD CSS', 'stale.html': 'STALE', 'blog/post.html': 'P' });
  const remote = await seededRemote();
  const s = await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: T1 });
  assert.deepEqual(s.uploaded, ['blog/post.html']);
  assert.deepEqual(s.backedUp, []);
  assert.equal(s.backupDir, ROOT + '/_backup-2026-10-18-1400');
  const p = await runPrune({ remoteRoot: ROOT, remoteFs: remote, names: ['_backup-2026-10-18-1400'], dryRun: true });
  assert.deepEqual(p.refused, [], 'the .backup.json record alone does not block a prune');
  const r = await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2 });
  assert.deepEqual(r.remove, ['blog/post.html']);
  assert.equal(await remote.stat(ROOT + '/blog/post.html'), null);
});

test('a backup without .backup.json (older version) restores its files only', async () => {
  const remote = await seededRemote();
  await remote.mkdirp(ROOT + '/_backup-2026-09-01-0900');
  await remote.writeFile(ROOT + '/_backup-2026-09-01-0900/index.html', Buffer.from('ANCIENT'));
  const s = await runRestore({ remoteRoot: ROOT, remoteFs: remote, name: '_backup-2026-09-01-0900', now: T2 });
  assert.equal(s.legacy, true);
  assert.deepEqual(s.put, ['index.html']);
  assert.deepEqual(s.remove, []);
  assert.equal(await read(remote, 'index.html'), 'ANCIENT');
});

test('describeBackups lists newest first with what each one holds', async () => {
  const { remote } = await deployed();
  await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2 });
  const list = await describeBackups({ remoteRoot: ROOT, remoteFs: remote });
  assert.deepEqual(list.map(b => [b.name, b.action]), [['_backup-2026-10-18-1405', 'restore'], ['_backup-2026-10-18-1400', 'deploy']]);
  assert.deepEqual([list[1].overwritten, list[1].added, list[1].deleted, list[1].files], [1, 1, 1, 2]);
});

test('chooseBackup: latest, exact names only, nothing outside _backup-*', () => {
  const b = ['_backup-2026-10-18-1400', '_backup-2026-10-18-1405'];
  assert.equal(chooseBackup(b), '_backup-2026-10-18-1405');
  assert.equal(chooseBackup(b, 'latest'), '_backup-2026-10-18-1405');
  assert.equal(chooseBackup(b, '_backup-2026-10-18-1400'), '_backup-2026-10-18-1400');
  assert.throws(() => chooseBackup(b, '_backup-2026-01-01-0000'), /No such backup/);
  assert.throws(() => chooseBackup(b, '_backup-x/../../etc'), /Not a backup folder name/);
  assert.throws(() => chooseBackup(b, 'css'), /Not a backup folder name/);
  assert.throws(() => chooseBackup([], 'latest'), /no _backup-\* folders/);
});

test('deploy then restore through real SFTP', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-srv-'));
  const P = path.join(root, 'home/deploy/public_html');
  await fs.mkdir(P, { recursive: true });
  await fs.writeFile(path.join(P, 'index.html'), 'OLD');
  const srv = await start({ root, username: 'deploy', password: 'secret' });
  const rfs = await SftpRemoteFs.connect({ host: '127.0.0.1', port: srv.port, username: 'deploy', password: 'secret' });
  try {
    const local = await tmpTree({ 'index.html': 'NEW', 'img/logo.svg': '<svg/>' });
    await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: rfs, now: T1 });
    assert.equal(await fs.readFile(path.join(P, 'index.html'), 'utf8'), 'NEW');
    const s = await runRestore({ remoteRoot: ROOT, remoteFs: rfs, now: T2 });
    assert.equal(s.refused, false);
    assert.equal(await fs.readFile(path.join(P, 'index.html'), 'utf8'), 'OLD');
    assert.equal(await fs.stat(path.join(P, 'img')).catch(() => null), null, 'the folder the deploy made is gone too');
    assert.equal(await fs.readFile(path.join(P, '_backup-2026-10-18-1405/index.html'), 'utf8'), 'NEW');
  } finally { await rfs.close(); await srv.close(); }
});
