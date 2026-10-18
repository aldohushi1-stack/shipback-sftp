'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MemoryRemoteFs } = require('../src/remote-fs');
const { runPull } = require('../src/pull');
const { scanLocal } = require('../src/manifest');
const { MANIFEST_NAME } = require('../src/diff');

const ROOT = '/home/deploy/public_html';
const NOW = new Date(2026, 8, 20, 15, 0);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

async function tmpTree(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-pull-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
  return dir;
}
async function seededRemote(extra = {}) {
  const r = new MemoryRemoteFs();
  await r.mkdirp(ROOT + '/css'); await r.mkdirp(ROOT + '/_backup-2026-09-01-0900');
  await r.writeFile(ROOT + '/index.html', Buffer.from('LIVE INDEX'));
  await r.writeFile(ROOT + '/css/site.css', Buffer.from('body{}'));
  await r.mkdirp(ROOT + '/intake');
  await r.writeFile(ROOT + '/intake/config.php', Buffer.from('<?php'));
  await r.writeFile(ROOT + '/_backup-2026-09-01-0900/index.html', Buffer.from('ANCIENT'));
  for (const [p, c] of Object.entries(extra)) await r.writeFile(ROOT + '/' + p, Buffer.from(c));
  return r;
}

test('dry run lists what would be downloaded and writes nothing locally', async () => {
  const local = await tmpTree({ 'index.html': 'OLD LOCAL', 'css/site.css': 'body{}', 'drafts/x.html': 'D' });
  const remote = await seededRemote();
  const before = await scanLocal(local);
  const s = await runPull({ localDir: local, remoteRoot: ROOT, remoteFs: remote, dryRun: true, now: NOW });
  assert.equal(s.dryRun, true);
  assert.deepEqual(s.plan.download.map(d => [d.path, d.reason]), [['index.html', 'changed'], ['intake/config.php', 'new']]);
  assert.deepEqual(s.plan.skip, ['css/site.css']);
  assert.deepEqual(s.plan.extra, ['drafts/x.html']);
  assert.deepEqual(await scanLocal(local), before);
  assert.deepEqual(s.downloaded, []);
});

test('real pull: local backup of overwritten files, download new/changed, keep local extras, never write to server', async () => {
  const local = await tmpTree({ 'index.html': 'OLD LOCAL', 'css/site.css': 'body{}', 'drafts/x.html': 'D' });
  const remote = await seededRemote();
  const remoteBefore = JSON.stringify(remote.dump());
  const events = [];
  const s = await runPull({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: NOW, onEvent: e => events.push(e) });
  assert.deepEqual(s.downloaded.sort(), ['index.html', 'intake/config.php']);
  assert.deepEqual(s.backedUp, ['index.html']);
  assert.equal(s.backupDir, path.join(local, '_backup-2026-09-20-1500'));
  assert.equal(await fs.readFile(path.join(local, 'index.html'), 'utf8'), 'LIVE INDEX');
  assert.equal(await fs.readFile(path.join(local, '_backup-2026-09-20-1500/index.html'), 'utf8'), 'OLD LOCAL');
  assert.equal(await fs.readFile(path.join(local, 'intake/config.php'), 'utf8'), '<?php');
  assert.equal(await fs.readFile(path.join(local, 'drafts/x.html'), 'utf8'), 'D');
  assert.equal(await fs.stat(path.join(local, '_backup-2026-09-01-0900')).catch(() => null), null, 'server backup folders are not pulled');
  assert.equal(JSON.stringify(remote.dump()), remoteBefore, 'server untouched');
  assert.ok(events.some(e => e.type === 'download' && e.path === 'index.html'));
  // the local backup folder must not be pushed by a later deploy
  const files = await scanLocal(local);
  assert.ok(!files.some(f => f.path.startsWith('_backup-')));
});

test('same-size file: unchanged when the manifest says we deployed it and the server copy is not newer; otherwise downloaded and compared', async () => {
  const local = await tmpTree({ 'a.html': 'AAAA', 'b.html': 'BBBB', 'c.html': 'CCCC' });
  const remote = await seededRemote({ 'a.html': 'AAAA', 'b.html': 'bbbb', 'c.html': 'CCCC' });
  // manifest: a and c deployed by us with these hashes at T; server copy of b was edited after (its mtime is "now", later than deployedAt)
  const deployedAt = new Date(Date.now() - 60_000).toISOString();
  await remote.writeFile(ROOT + '/' + MANIFEST_NAME, JSON.stringify({ version: 1, deployedAt, files: { 'a.html': { sha256: sha('AAAA'), size: 4 }, 'c.html': { sha256: sha('CCCC'), size: 4 } } }));
  remote.files.get(ROOT + '/a.html').mtime = Date.parse(deployedAt) - 5000; // untouched since deploy
  remote.files.get(ROOT + '/c.html').mtime = Date.parse(deployedAt) + 600_000; // edited 10 min after deploy (same content)
  const reads = [];
  const orig = remote.readFile.bind(remote);
  remote.readFile = p => { reads.push(p); return orig(p); };
  const s = await runPull({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: NOW });
  assert.deepEqual(s.downloaded.sort(), ['b.html', 'css/site.css', 'index.html', 'intake/config.php']);
  assert.ok(!reads.includes(ROOT + '/a.html'), 'a.html trusted from manifest, not read');
  assert.ok(reads.includes(ROOT + '/c.html'), 'c.html read because server copy is newer than the deploy');
  assert.ok(s.plan.skip.includes('a.html') && s.plan.skip.includes('c.html'));
  assert.equal(await fs.readFile(path.join(local, 'b.html'), 'utf8'), 'bbbb');
});

test('mirror: local extras are backed up then deleted; empty folders cleaned', async () => {
  const local = await tmpTree({ 'index.html': 'LIVE INDEX', 'css/site.css': 'body{}', 'drafts/x.html': 'D' });
  const remote = await seededRemote();
  const s = await runPull({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: NOW, mirror: true });
  assert.deepEqual(s.deleted, ['drafts/x.html']);
  assert.equal(await fs.stat(path.join(local, 'drafts/x.html')).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(local, '_backup-2026-09-20-1500/drafts/x.html'), 'utf8'), 'D');
});

test('pull into a folder that does not exist yet creates it', async () => {
  const local = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'sd-pull-')), 'fresh');
  const remote = await seededRemote();
  const s = await runPull({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: NOW });
  assert.equal(await fs.readFile(path.join(local, 'index.html'), 'utf8'), 'LIVE INDEX');
  assert.deepEqual(s.backedUp, []);
});

test('remote root missing ⇒ clear error', async () => {
  const local = await tmpTree({});
  await assert.rejects(runPull({ localDir: local, remoteRoot: '/nope', remoteFs: new MemoryRemoteFs(), now: NOW }), /not found on server/i);
});
