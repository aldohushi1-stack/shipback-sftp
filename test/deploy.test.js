'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MemoryRemoteFs } = require('../src/remote-fs');
const { runDeploy, MANIFEST_NAME } = require('../src/deploy');

async function tmpTree(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-dep-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
  return dir;
}

const NOW = new Date(2026, 8, 20, 10, 30);
const ROOT = '/home/deploy/public_html';

async function seededRemote() {
  const r = new MemoryRemoteFs();
  await r.mkdirp(ROOT + '/css');
  await r.writeFile(ROOT + '/index.html', Buffer.from('OLD'));
  await r.writeFile(ROOT + '/css/site.css', Buffer.from('OLD CSS'));
  await r.writeFile(ROOT + '/stale.html', Buffer.from('STALE'));
  return r;
}

test('dry run reports the plan and writes nothing', async () => {
  const local = await tmpTree({ 'index.html': 'NEW', 'css/site.css': 'OLD CSS', 'new.html': 'N' });
  const remote = await seededRemote();
  const before = JSON.stringify(remote.dump());
  const events = [];
  const s = await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, dryRun: true, now: NOW, onEvent: e => events.push(e) });
  assert.equal(s.dryRun, true);
  assert.deepEqual(s.plan.upload.map(u => u.path).sort(), ['index.html', 'new.html']);
  assert.deepEqual(s.plan.skip, ['css/site.css']);
  assert.deepEqual(s.plan.extra, ['stale.html']);
  assert.equal(JSON.stringify(remote.dump()), before, 'remote untouched');
  assert.ok(events.some(e => e.type === 'plan'));
  assert.ok(!events.some(e => e.type === 'upload'));
});

test('real run: backup existing files first, upload new/changed, write manifest, leave extras', async () => {
  const local = await tmpTree({ 'index.html': 'NEW', 'css/site.css': 'OLD CSS', 'new.html': 'N', 'img/logo.png': 'PNG' });
  const remote = await seededRemote();
  const order = [];
  const s = await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: NOW, onEvent: e => order.push(e.type + ':' + (e.path || '')) });
  assert.equal(s.dryRun, false);
  assert.deepEqual(s.uploaded.sort(), ['img/logo.png', 'index.html', 'new.html']);
  assert.deepEqual(s.backedUp, ['index.html']);
  assert.equal(s.backupDir, ROOT + '/_backup-2026-09-20-1030');
  assert.deepEqual(s.deleted, []);
  assert.equal((await remote.readFile(ROOT + '/index.html')).toString(), 'NEW');
  assert.equal((await remote.readFile(ROOT + '/_backup-2026-09-20-1030/index.html')).toString(), 'OLD');
  assert.equal((await remote.readFile(ROOT + '/img/logo.png')).toString(), 'PNG');
  assert.equal((await remote.readFile(ROOT + '/stale.html')).toString(), 'STALE', 'extra kept when mirror is off');
  const manifest = JSON.parse((await remote.readFile(ROOT + '/' + MANIFEST_NAME)).toString());
  assert.equal(typeof manifest.files['index.html'].sha256, 'string');
  assert.equal(manifest.files['css/site.css'].sha256.length, 64, 'skipped files are still in the manifest');
  // ordering: every backup event precedes the first upload event
  const firstUpload = order.findIndex(x => x.startsWith('upload:'));
  const lastBackup = order.map((x, i) => x.startsWith('backup:') ? i : -1).filter(i => i >= 0).pop();
  assert.ok(lastBackup < firstUpload, `backups (${lastBackup}) must finish before uploads (${firstUpload})`);
});

test('second run after a deploy uploads nothing (manifest hashes match)', async () => {
  const local = await tmpTree({ 'index.html': 'NEW', 'css/site.css': 'OLD CSS' });
  const remote = await seededRemote();
  await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: NOW });
  const s2 = await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: new Date(2026, 8, 20, 11, 0) });
  assert.deepEqual(s2.uploaded, []);
  assert.deepEqual(s2.backedUp, []);
  assert.equal(s2.backupDir, null);
  assert.equal(await remote.stat(ROOT + '/_backup-2026-09-20-1100'), null);
});

test('mirror: extras are backed up then deleted; _backup-* folders survive', async () => {
  const local = await tmpTree({ 'index.html': 'OLD' });
  const remote = await seededRemote();
  await remote.mkdirp(ROOT + '/_backup-2026-09-01-0900');
  await remote.writeFile(ROOT + '/_backup-2026-09-01-0900/index.html', Buffer.from('ANCIENT'));
  const s = await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: NOW, mirror: true });
  assert.deepEqual(s.deleted.sort(), ['css/site.css', 'stale.html']);
  assert.equal(await remote.stat(ROOT + '/stale.html'), null);
  assert.equal((await remote.readFile(ROOT + '/_backup-2026-09-20-1030/stale.html')).toString(), 'STALE');
  assert.equal((await remote.readFile(ROOT + '/_backup-2026-09-01-0900/index.html')).toString(), 'ANCIENT');
});

test('backup:false skips the backup step', async () => {
  const local = await tmpTree({ 'index.html': 'NEW' });
  const remote = await seededRemote();
  const s = await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: NOW, backup: false });
  assert.deepEqual(s.backedUp, []);
  assert.equal(s.backupDir, null);
  assert.equal((await remote.readFile(ROOT + '/index.html')).toString(), 'NEW');
});

test('remote root that does not exist is created (fresh addon domain)', async () => {
  const local = await tmpTree({ 'index.html': 'X' });
  const remote = new MemoryRemoteFs();
  const s = await runDeploy({ localDir: local, remoteRoot: '/home/deploy/example.net', remoteFs: remote, now: NOW });
  assert.deepEqual(s.uploaded, ['index.html']);
  assert.equal((await remote.readFile('/home/deploy/example.net/index.html')).toString(), 'X');
});

test('an upload failure is reported as an error event and the run rejects', async () => {
  const local = await tmpTree({ 'index.html': 'X' });
  const remote = new MemoryRemoteFs();
  remote.failOn = p => p.endsWith('index.html');
  const events = [];
  await assert.rejects(runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: NOW, onEvent: e => events.push(e) }), /index\.html/);
  assert.ok(events.some(e => e.type === 'error'));
});
