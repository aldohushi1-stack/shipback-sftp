'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MemoryRemoteFs, SftpRemoteFs } = require('../src/remote-fs');
const { runPrune, chooseTargets } = require('../src/prune');
const { start } = require('./helpers/sftp-server');

const R = '/home/u/public_html';

// A server the way three deploys of the same two play files leave it: the live files,
// two identical older backups and the newest backup — exactly the 25 Sep situation.
async function world() {
  const m = new MemoryRemoteFs();
  await m.mkdirp(R + '/play/data');
  await m.writeFile(R + '/play/track.php', Buffer.from('NEW TRACK'));
  await m.writeFile(R + '/play/stats.php', Buffer.from('NEW STATS'));
  await m.writeFile(R + '/index.html', Buffer.from('HOME'));
  for (const stamp of ['2026-09-24-2352', '2026-09-25-0004', '2026-09-25-0054']) {
    await m.mkdirp(`${R}/_backup-${stamp}/play`);
    await m.writeFile(`${R}/_backup-${stamp}/play/track.php`, Buffer.from('OLD TRACK'));
    await m.writeFile(`${R}/_backup-${stamp}/play/stats.php`, Buffer.from('OLD STATS'));
  }
  return m;
}
const dirsOf = m => [...m.dirs].filter(d => d.includes('_backup-')).sort();

test('chooseTargets: by name (validated) or keep-newest-N; nothing implicit', () => {
  const b = ['_backup-2026-09-24-2352', '_backup-2026-09-25-0004', '_backup-2026-09-25-0054'];
  assert.deepEqual(chooseTargets(b, { names: ['_backup-2026-09-25-0004', '_backup-2026-09-25-0004'] }), ['_backup-2026-09-25-0004']);
  assert.deepEqual(chooseTargets(b, { keep: 1 }), ['_backup-2026-09-24-2352', '_backup-2026-09-25-0004']);
  assert.deepEqual(chooseTargets(b, { keep: 5 }), []);
  assert.deepEqual(chooseTargets(b, { keep: 0 }), b);
  assert.throws(() => chooseTargets(b, {}), /names.*keep/);
  assert.throws(() => chooseTargets(b, { names: ['play'] }), /Not a backup folder name/);
  assert.throws(() => chooseTargets(b, { names: ['_backup-2026-01-01-0000'] }), /No such backup/);
  assert.throws(() => chooseTargets(b, { names: ['_backup-x/../play'] }), /Not a backup folder name/);
});

test('dry run reports the plan and removes nothing', async () => {
  const m = await world();
  const before = m.dump();
  const s = await runPrune({ remoteRoot: R, remoteFs: m, names: ['_backup-2026-09-24-2352'], dryRun: true });
  assert.equal(s.dryRun, true);
  assert.deepEqual(s.pruned.map(p => p.name), ['_backup-2026-09-24-2352']);
  assert.equal(s.pruned[0].files, 2); assert.equal(s.deleted, 2);
  assert.deepEqual(m.dump(), before);
});

test('removes named backups whose files all have a twin, files then folders, and touches nothing else', async () => {
  const m = await world();
  const events = [];
  const s = await runPrune({ remoteRoot: R, remoteFs: m, names: ['_backup-2026-09-24-2352', '_backup-2026-09-25-0004'], onEvent: e => events.push(e) });
  assert.deepEqual(s.pruned.map(p => p.name), ['_backup-2026-09-24-2352', '_backup-2026-09-25-0004']);
  assert.deepEqual(s.refused, []);
  assert.equal(s.deleted, 4); assert.equal(s.bytes, 4 * 9);
  assert.deepEqual(dirsOf(m), [`${R}/_backup-2026-09-25-0054`, `${R}/_backup-2026-09-25-0054/play`]);
  assert.equal((await m.readFile(`${R}/_backup-2026-09-25-0054/play/track.php`)).toString(), 'OLD TRACK');
  assert.equal((await m.readFile(`${R}/play/track.php`)).toString(), 'NEW TRACK');
  assert.equal((await m.readFile(`${R}/index.html`)).toString(), 'HOME');
  const order = events.filter(e => e.type === 'delete' || e.type === 'rmdir').map(e => e.type);
  assert.deepEqual(order, ['delete', 'delete', 'rmdir', 'rmdir', 'delete', 'delete', 'rmdir', 'rmdir'], 'files go before their folders');
});

test('keep: N keeps the newest N and prunes the rest', async () => {
  const m = await world();
  const s = await runPrune({ remoteRoot: R, remoteFs: m, keep: 1 });
  assert.deepEqual(s.kept, ['_backup-2026-09-25-0054']);
  assert.deepEqual(dirsOf(m), [`${R}/_backup-2026-09-25-0054`, `${R}/_backup-2026-09-25-0054/play`]);
});

test('a backup holding the only copy of a file is refused (kept intact) unless force', async () => {
  const m = await world();
  await m.writeFile(`${R}/_backup-2026-09-24-2352/play/only-here.php`, Buffer.from('UNIQUE'));
  const s = await runPrune({ remoteRoot: R, remoteFs: m, keep: 1 });
  assert.deepEqual(s.refused, [{ name: '_backup-2026-09-24-2352', unique: ['play/only-here.php'] }]);
  assert.deepEqual(s.pruned.map(p => p.name), ['_backup-2026-09-25-0004']);
  assert.equal((await m.readFile(`${R}/_backup-2026-09-24-2352/play/only-here.php`)).toString(), 'UNIQUE');
  assert.equal((await m.readFile(`${R}/_backup-2026-09-24-2352/play/track.php`)).toString(), 'OLD TRACK', 'refused folder left whole');
  const f = await runPrune({ remoteRoot: R, remoteFs: m, names: ['_backup-2026-09-24-2352'], force: true });
  assert.equal(f.pruned[0].forced, true);
  assert.equal(await m.stat(`${R}/_backup-2026-09-24-2352`), null);
});

test('a twin must match by content, not just by path: a changed same-named file counts as unique', async () => {
  const m = await world();
  // the one backup being kept has a different track.php, and live has moved on too ⇒ both older copies are the last of their kind
  await m.writeFile(`${R}/_backup-2026-09-25-0054/play/track.php`, Buffer.from('OLDER TRACK'));
  const s = await runPrune({ remoteRoot: R, remoteFs: m, keep: 1 });
  assert.deepEqual(s.refused.map(r => r.name), ['_backup-2026-09-24-2352', '_backup-2026-09-25-0004']);
  assert.deepEqual(s.refused[0].unique, ['play/track.php']);
  assert.deepEqual(s.pruned, []);
});

test('a live twin is enough: a backup of a file that was uploaded unchanged is removable', async () => {
  const m = await world();
  await m.mkdirp(`${R}/_backup-2026-09-25-0100/css`);
  await m.writeFile(`${R}/_backup-2026-09-25-0100/index.html`, Buffer.from('HOME'));
  await m.writeFile(`${R}/_backup-2026-09-25-0100/css/site.css`, Buffer.from('CSS'));
  await m.mkdirp(`${R}/css`); await m.writeFile(`${R}/css/site.css`, Buffer.from('CSS'));
  const s = await runPrune({ remoteRoot: R, remoteFs: m, names: ['_backup-2026-09-25-0100'] });
  assert.deepEqual(s.refused, []);
  assert.equal(await m.stat(`${R}/_backup-2026-09-25-0100`), null);
});

test('never runs against a missing root', async () => {
  const m = new MemoryRemoteFs();
  await assert.rejects(runPrune({ remoteRoot: '/nope', remoteFs: m, keep: 0 }), /not found/);
});

test('through real SFTP: files unlinked, nested folders removed deepest-first, the kept backup untouched', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-prune-'));
  const P = path.join(root, 'home/deploy/public_html');
  for (const stamp of ['2026-09-24-2352', '2026-09-25-0054']) {
    await fs.mkdir(path.join(P, `_backup-${stamp}/play/data/deep`), { recursive: true });
    await fs.writeFile(path.join(P, `_backup-${stamp}/play/track.php`), 'OLD TRACK');
    await fs.writeFile(path.join(P, `_backup-${stamp}/play/data/deep/x.json`), '{}');
  }
  await fs.mkdir(path.join(P, 'play'), { recursive: true });
  await fs.writeFile(path.join(P, 'play/track.php'), 'NEW TRACK');
  const srv = await start({ root, username: 'deploy', password: 'secret' });
  const rfs = await SftpRemoteFs.connect({ host: '127.0.0.1', port: srv.port, username: 'deploy', password: 'secret' });
  try {
    const s = await runPrune({ remoteRoot: '/home/deploy/public_html', remoteFs: rfs, keep: 1 });
    assert.deepEqual(s.pruned.map(p => p.name), ['_backup-2026-09-24-2352']);
    assert.equal(await fs.stat(path.join(P, '_backup-2026-09-24-2352')).catch(() => null), null, 'folder gone');
    assert.equal(await fs.readFile(path.join(P, '_backup-2026-09-25-0054/play/data/deep/x.json'), 'utf8'), '{}');
    assert.equal(await fs.readFile(path.join(P, 'play/track.php'), 'utf8'), 'NEW TRACK');
  } finally { await rfs.close(); await srv.close(); }
});
