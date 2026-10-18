'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryRemoteFs } = require('../src/remote-fs');
const { backupFiles, makeStamp } = require('../src/backup');

test('makeStamp is local YYYY-MM-DD-HHMM', () => {
  assert.equal(makeStamp(new Date(2026, 8, 20, 9, 5)), '2026-09-20-0905');
  assert.equal(makeStamp(new Date(2026, 11, 1, 23, 59)), '2026-12-01-2359');
});

test('backs up only files that exist on the server, into _backup-<stamp>/<same path>', async () => {
  const fs = new MemoryRemoteFs();
  await fs.mkdirp('/home/u/public_html/css');
  await fs.writeFile('/home/u/public_html/index.html', Buffer.from('OLD INDEX'));
  await fs.writeFile('/home/u/public_html/css/site.css', Buffer.from('OLD CSS'));
  const events = [];
  const res = await backupFiles({
    remoteFs: fs, root: '/home/u/public_html',
    paths: ['index.html', 'css/site.css', 'brand-new.html'],
    stamp: '2026-09-20-0905', onEvent: e => events.push(e),
  });
  assert.equal(res.backupDir, '/home/u/public_html/_backup-2026-09-20-0905');
  assert.deepEqual(res.copied, ['index.html', 'css/site.css']);
  assert.equal((await fs.readFile('/home/u/public_html/_backup-2026-09-20-0905/index.html')).toString(), 'OLD INDEX');
  assert.equal((await fs.readFile('/home/u/public_html/_backup-2026-09-20-0905/css/site.css')).toString(), 'OLD CSS');
  assert.equal(await fs.stat('/home/u/public_html/_backup-2026-09-20-0905/brand-new.html'), null);
  // originals untouched
  assert.equal((await fs.readFile('/home/u/public_html/index.html')).toString(), 'OLD INDEX');
  assert.ok(events.some(e => e.type === 'backup' && e.path === 'index.html'));
});

test('nothing to back up ⇒ no backup folder is created', async () => {
  const fs = new MemoryRemoteFs();
  await fs.mkdirp('/root');
  const res = await backupFiles({ remoteFs: fs, root: '/root', paths: ['nope.html'], stamp: '2026-01-01-0000' });
  assert.deepEqual(res.copied, []);
  assert.equal(await fs.stat('/root/_backup-2026-01-01-0000'), null);
});
