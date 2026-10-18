'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { start } = require('./helpers/sftp-server');
const { SftpRemoteFs } = require('../src/remote-fs');
const { runDeploy, MANIFEST_NAME } = require('../src/deploy');

let srv, root, rfs;
test.before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-srv-'));
  await fs.mkdir(path.join(root, 'home/deploy/public_html/css'), { recursive: true });
  await fs.writeFile(path.join(root, 'home/deploy/public_html/index.html'), 'OLD');
  await fs.writeFile(path.join(root, 'home/deploy/public_html/css/site.css'), 'OLD CSS');
  srv = await start({ root, username: 'deploy', password: 'secret' });
  rfs = await SftpRemoteFs.connect({ host: '127.0.0.1', port: srv.port, username: 'deploy', password: 'secret' });
});
test.after(async () => { await rfs.close(); await srv.close(); });

test('wrong password rejects with a readable error', async () => {
  await assert.rejects(SftpRemoteFs.connect({ host: '127.0.0.1', port: srv.port, username: 'deploy', password: 'nope', readyTimeout: 5000 }), /auth/i);
});

test('stat / listRecursive / mkdirp / writeFile / readFile / uploadFile / rename / remove', async () => {
  const R = '/home/deploy/public_html';
  const st = await rfs.stat(R + '/index.html');
  assert.equal(st.size, 3); assert.equal(st.isDir, false); assert.equal(typeof st.mtime, 'number');
  assert.equal((await rfs.stat(R)).isDir, true);
  assert.equal(await rfs.stat(R + '/missing'), null);

  const listing = await rfs.listRecursive(R);
  assert.deepEqual(listing.map(f => f.path).sort(), ['css/site.css', 'index.html']);

  await rfs.mkdirp(R + '/a/b/c');
  await rfs.mkdirp(R + '/a/b/c'); // idempotent
  await rfs.writeFile(R + '/a/b/c/x.txt', Buffer.from('hello'));
  assert.equal((await rfs.readFile(R + '/a/b/c/x.txt')).toString(), 'hello');

  const localBig = path.join(os.tmpdir(), 'sd-big-' + Date.now());
  const big = Buffer.alloc(300 * 1024, 7);
  await fs.writeFile(localBig, big);
  await rfs.uploadFile(localBig, R + '/a/big.bin');
  assert.equal((await rfs.readFile(R + '/a/big.bin')).length, big.length);

  await rfs.rename(R + '/a/big.bin', R + '/a/big2.bin');
  assert.equal(await rfs.stat(R + '/a/big.bin'), null);
  await rfs.remove(R + '/a/big2.bin');
  assert.equal(await rfs.stat(R + '/a/big2.bin'), null);

  const skipped = await rfs.listRecursive(R, { skipDir: name => name === 'a' });
  assert.ok(!skipped.some(f => f.path.startsWith('a/')));
});

test('full deploy through real SFTP: backup, upload, manifest, then a no-op second run', async () => {
  const local = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-local-'));
  await fs.mkdir(path.join(local, 'css'));
  await fs.writeFile(path.join(local, 'index.html'), 'NEW');
  await fs.writeFile(path.join(local, 'css/site.css'), 'OLD CSS');
  await fs.writeFile(path.join(local, 'new.html'), 'N');
  const R = '/home/deploy/public_html';
  const now = new Date(2026, 8, 20, 12, 0);
  const s = await runDeploy({ localDir: local, remoteRoot: R, remoteFs: rfs, now });
  assert.deepEqual(s.uploaded.sort(), ['index.html', 'new.html']);
  assert.deepEqual(s.backedUp, ['index.html']);
  assert.equal(await fs.readFile(path.join(root, 'home/deploy/public_html/index.html'), 'utf8'), 'NEW');
  assert.equal(await fs.readFile(path.join(root, 'home/deploy/public_html/_backup-2026-09-20-1200/index.html'), 'utf8'), 'OLD');
  const m = JSON.parse(await fs.readFile(path.join(root, 'home/deploy/public_html', MANIFEST_NAME), 'utf8'));
  assert.ok(m.files['new.html']);
  const s2 = await runDeploy({ localDir: local, remoteRoot: R, remoteFs: rfs, now: new Date(2026, 8, 20, 12, 1) });
  assert.deepEqual(s2.uploaded, []);
});
