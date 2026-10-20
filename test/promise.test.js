'use strict';
// The undo promise (UNDO-PROMISE.md), one test per clause. Each one compares every byte on the server, not a
// sample: "the site as it was" means every file under the remote root except backups and the manifest.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MemoryRemoteFs, SftpRemoteFs, PART_PREFIX, LOCK_NAME } = require('../src/remote-fs');
const { runDeploy, MANIFEST_NAME } = require('../src/deploy');
const { runRestore } = require('../src/restore');
const { start } = require('./helpers/sftp-server');

const ROOT = '/home/deploy/public_html';
const T1 = new Date(2026, 9, 20, 9, 0);
const T2 = new Date(2026, 9, 20, 9, 5);
const T3 = new Date(2026, 9, 20, 9, 10);
const bytes = (n, k) => Buffer.from(Array.from({ length: n }, (_, i) => (i * k + 13) % 256));

async function tmpTree(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-promise-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
  return dir;
}

/** Every live file under ROOT (no backups, no manifest), path → base64. Part files included: none may be left. */
function site(remote) {
  const out = {};
  for (const [p, f] of remote.files) {
    if (!p.startsWith(ROOT + '/')) continue;
    const rel = p.slice(ROOT.length + 1);
    if (rel.startsWith('_backup-') || rel === MANIFEST_NAME) continue;
    out[rel] = f.data.toString('base64');
  }
  return out;
}

/** A live site with things only the server has (uploads, .well-known, form data), and a deploy that
 *  overwrites, adds (in a new folder) and, with mirror, deletes. */
async function setup() {
  const remote = new MemoryRemoteFs();
  const put = async (rel, data) => { await remote.mkdirp(path.posix.dirname(`${ROOT}/${rel}`)); await remote.writeFile(`${ROOT}/${rel}`, data); };
  await put('index.html', 'OLD INDEX');
  await put('b.html', 'OLD B');
  await put('css/site.css', 'OLD CSS');
  await put('img/logo.png', bytes(5000, 7919));
  await put('old-page.html', 'GOING');
  await put('uploads/client-photo.jpg', bytes(3000, 31));
  await put('.well-known/acme-challenge/token', 'ACME');
  await put('intake/data/form-entries.json', '{"n":41}');
  const local = await tmpTree({
    'index.html': 'NEW INDEX', 'b.html': 'NEW B', 'css/site.css': 'NEW CSS', 'img/logo.png': bytes(6000, 104729),
    'blog/first-post.html': 'NEW POST', 'uploads/client-photo.jpg': bytes(3000, 31),
  });
  // ignore what only the server owns, the way a real sites.json would
  const ignore = ['.well-known/', 'intake/data/'];
  return { remote, local, ignore, before: site(remote) };
}

test('P1 undo puts back every overwritten and deleted file byte for byte, removes every added one, and touches nothing else', async () => {
  const { remote, local, ignore, before } = await setup();
  await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: T1, mirror: true, ignore });
  assert.notDeepEqual(site(remote), before);
  const s = await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2 });
  assert.equal(s.refused, false);
  assert.deepEqual(site(remote), before);
  assert.equal(await remote.stat(`${ROOT}/blog`), null, 'the folder the deploy made is gone');
});

test('P2 a deploy cut off mid-upload never leaves half a file live, and one plain --restore puts the site back', async () => {
  const { remote, local, ignore, before } = await setup();
  remote.tornOn = p => p.endsWith(`/${PART_PREFIX}css/site.css`) || p.endsWith(`css/${PART_PREFIX}site.css`);
  const err = await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: T1, ignore }).catch(e => e);
  assert.match(err.message, /connection drop/);
  assert.match(err.undo, /--restore undoes them/);
  remote.tornOn = null;
  // while it is broken off, every live file is whole: the old copy or the new one, never part of one
  const mid = site(remote);
  assert.equal(Buffer.from(mid['css/site.css'], 'base64').toString(), 'OLD CSS');
  for (const [p, b64] of Object.entries(mid)) if (!p.includes(PART_PREFIX)) assert.ok(before[p] === b64 || (await fs.readFile(path.join(local, p))).toString('base64') === b64, p);

  const s = await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2 });
  assert.equal(s.refused, false, 'no --force needed');
  assert.deepEqual(site(remote), before, 'exactly as before, and no part file left behind');
});

test('P3 cut off between removing the old file and swapping in the new one (servers without posix-rename): still undone', async () => {
  const { remote, local, ignore, before } = await setup();
  const replace = remote.replace.bind(remote);
  remote.replace = async (tmp, dest) => {
    if (dest.endsWith('/b.html')) { await remote.remove(dest); throw new Error('Simulated connection drop between remove and rename'); }
    return replace(tmp, dest);
  };
  await assert.rejects(runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: T1, ignore }));
  remote.replace = replace;
  assert.equal(await remote.stat(`${ROOT}/b.html`), null, 'the gap this test is about');
  const s = await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2 });
  assert.equal(s.refused, false);
  assert.deepEqual(site(remote), before);
});

test('P4 cut off while still saving backups: no live file changed, and --restore never writes a half-saved copy back', async () => {
  const { remote, local, ignore, before } = await setup();
  remote.tornOn = p => p.includes('/_backup-') && p.endsWith('/b.html');
  await assert.rejects(runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: T1, ignore }));
  remote.tornOn = null;
  assert.deepEqual(site(remote), before);
  const s = await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2 });
  assert.equal(s.stoppedEarly, true);
  assert.deepEqual(site(remote), before);
});

test('P5 if the backup cannot be saved (a full disk), nothing is uploaded', async () => {
  const { remote, local, ignore, before } = await setup();
  remote.failOn = p => p.includes('/_backup-');
  await assert.rejects(runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: T1, ignore }), /Simulated failure/);
  remote.failOn = null;
  assert.deepEqual(site(remote), before);
});

test('P6 a restore cut off part way is finished by running the same --restore again', async () => {
  const { remote, local, ignore, before } = await setup();
  await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: T1, mirror: true, ignore });
  remote.tornOn = p => p.endsWith(`/${PART_PREFIX}site.css`);
  const err = await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2 }).catch(e => e);
  assert.match(err.undo, /Run the same restore again/);
  remote.tornOn = null;
  const s = await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T3 });
  assert.equal(s.resumed, '_backup-2026-10-20-0905');
  assert.equal(s.backup, '_backup-2026-10-20-0900');
  assert.equal(s.refused, false);
  assert.deepEqual(site(remote), before);
});

test('P7 a file edited live after the deploy stops the undo: it names the file and changes nothing at all', async () => {
  const { remote, local, ignore } = await setup();
  await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: T1, ignore });
  await remote.writeFile(`${ROOT}/b.html`, 'FIXED BY HAND IN CPANEL');
  const snapshot = JSON.stringify(remote.dump());
  const s = await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2 });
  assert.equal(s.refused, true);
  assert.deepEqual(s.conflicts.map(c => c.path), ['b.html']);
  assert.equal(JSON.stringify(remote.dump()), snapshot, 'not one byte changed, backups included');
});

test('P8 a damaged copy in the backup folder is never put back, even with --force', async () => {
  const { remote, local, ignore } = await setup();
  const s1 = await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: T1, ignore });
  await remote.writeFile(`${s1.backupDir}/index.html`, 'OLD IN');
  const dry = await runRestore({ remoteRoot: ROOT, remoteFs: remote, dryRun: true });
  assert.deepEqual(dry.conflicts.map(c => c.path), ['index.html']);
  assert.match(dry.conflicts[0].why, /damaged/);
  const s = await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2, force: true });
  assert.ok(!s.put.includes('index.html'));
  assert.equal((await remote.readFile(`${ROOT}/index.html`)).toString(), 'NEW INDEX', 'left as it was, not overwritten with the damaged copy');
  assert.equal((await remote.readFile(`${ROOT}/b.html`)).toString(), 'OLD B', 'the intact copies still go back');
});

test('P9 the undo can be undone: restoring the restore gives back exactly what the deploy put up', async () => {
  const { remote, local, ignore } = await setup();
  await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: T1, mirror: true, ignore });
  const deployed = site(remote);
  const s = await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2 });
  await runRestore({ remoteRoot: ROOT, remoteFs: remote, name: s.undoBackupDir.split('/').pop(), now: T3 });
  assert.deepEqual(site(remote), deployed);
});

test('P10 through a real SFTP server: deploy and undo are exact, keep file permissions, and leave no part files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-promise-srv-'));
  const P = path.join(root, 'home/deploy/public_html');
  await fs.mkdir(path.join(P, 'cgi-bin'), { recursive: true });
  await fs.writeFile(path.join(P, 'index.html'), 'OLD');
  await fs.writeFile(path.join(P, 'cgi-bin/run.sh'), '#!/bin/sh\necho old\n');
  await fs.writeFile(path.join(P, 'only-on-server.txt'), 'KEEP');
  await fs.chmod(path.join(P, 'cgi-bin/run.sh'), 0o750);
  const snap = async () => {
    const out = {};
    const walk = async (d, rel) => { for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!e.name.startsWith('_backup-')) await walk(path.join(d, e.name), r); }
      else if (r !== MANIFEST_NAME) out[r] = (await fs.readFile(path.join(d, e.name))).toString('base64');
    } };
    await walk(P, '');
    return out;
  };
  const before = await snap();
  const srv = await start({ root, username: 'deploy', password: 'secret' });
  const rfs = await SftpRemoteFs.connect({ host: '127.0.0.1', port: srv.port, username: 'deploy', password: 'secret' });
  try {
    const local = await tmpTree({ 'index.html': 'NEW', 'cgi-bin/run.sh': '#!/bin/sh\necho new\n', 'img/a.png': bytes(70000, 13) });
    await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: rfs, now: T1 });
    assert.equal(await fs.readFile(path.join(P, 'index.html'), 'utf8'), 'NEW');
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(P, 'cgi-bin/run.sh'))).mode & 0o777, 0o750, 'replacing a file keeps its permissions');
    assert.ok(!Object.keys(await snap()).some(p => p.includes(PART_PREFIX)), 'no part files left after a deploy');
    const s = await runRestore({ remoteRoot: ROOT, remoteFs: rfs, now: T2 });
    assert.equal(s.refused, false);
    assert.deepEqual(await snap(), before);
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(P, 'cgi-bin/run.sh'))).mode & 0o777, 0o750, 'and so does putting it back');
  } finally { await rfs.close(); await srv.close(); }
});

test('P11 a dropped connection fails the deploy out loud (never a silent exit), and the undo still works after reconnecting', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-promise-drop-'));
  const P = path.join(root, 'home/deploy/public_html');
  await fs.mkdir(P, { recursive: true });
  for (const n of ['a', 'b', 'c', 'd']) await fs.writeFile(path.join(P, `${n}.html`), `OLD ${n}`);
  const srv = await start({ root, username: 'deploy', password: 'secret' });
  const connect = () => SftpRemoteFs.connect({ host: '127.0.0.1', port: srv.port, username: 'deploy', password: 'secret' });
  let rfs = await connect();
  try {
    const local = await tmpTree({ 'a.html': 'NEW a', 'b.html': 'NEW b', 'c.html': bytes(400000, 3), 'd.html': 'NEW d' });
    let n = 0;
    const up = rfs.uploadFile.bind(rfs);
    rfs.uploadFile = (l, p) => { if (++n === 3) setImmediate(() => rfs.client.end()); return up(l, p); };
    const err = await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: rfs, now: T1 }).catch(e => e);
    assert.ok(err instanceof Error, 'the deploy rejects instead of hanging');
    assert.match(err.message, /Lost the connection/);
    assert.match(err.undo, /2 of 4 files went up/);
    rfs = await connect();
    const s = await runRestore({ remoteRoot: ROOT, remoteFs: rfs, now: T2 });
    assert.equal(s.refused, false);
    for (const n of ['a', 'b', 'c', 'd']) assert.equal(await fs.readFile(path.join(P, `${n}.html`), 'utf8'), `OLD ${n}`);
    assert.ok(!(await fs.readdir(P)).some(f => f.startsWith(PART_PREFIX)), 'no part files left');
  } finally { await rfs.close(); await srv.close(); }
});

test('P12 one run at a time: a second deploy or undo is refused and changes nothing, and a lock left by a cut-off run clears itself', async () => {
  const { remote, local, ignore, before } = await setup();
  const other = await tmpTree({ 'index.html': 'SOMEONE ELSE', 'b.html': 'SOMEONE ELSE B' });
  // two deploys at once: exactly one runs
  const [a, b] = await Promise.allSettled([
    runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: T1, ignore }),
    runDeploy({ localDir: other, remoteRoot: ROOT, remoteFs: remote, now: T1, ignore }),
  ]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.equal(b.reason.code, 'ELOCKED');
  assert.match(b.reason.message, /Nothing was changed/);
  assert.equal((await remote.readFile(`${ROOT}/index.html`)).toString(), 'NEW INDEX');
  assert.equal(await remote.stat(`${ROOT}/${LOCK_NAME}`), null, 'the lock is gone once the run ends');
  assert.ok(!(await remote.listRecursive(ROOT)).some(f => f.path === LOCK_NAME), 'and it is never listed, deployed or pulled');

  // a run going on from another computer: undo waits its turn
  const lock = { tool: 'shipback-sftp', action: 'deploy', token: 'x', pid: 1, machine: '000000000000', at: new Date().toISOString() };
  await remote.writeFile(`${ROOT}/${LOCK_NAME}`, JSON.stringify(lock));
  const snapshot = JSON.stringify(remote.dump());
  await assert.rejects(runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2 }), e => e.code === 'ELOCKED' && /another computer/.test(e.message));
  assert.equal(JSON.stringify(remote.dump()), snapshot, 'not one byte changed');

  // the same lock, left behind three minutes ago by a run that was cut off: taken over
  remote.files.get(`${ROOT}/${LOCK_NAME}`).mtime = Date.now() - 3 * 60000;
  const events = [];
  const s = await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2, onEvent: e => events.push(e) });
  assert.ok(events.some(e => e.type === 'stale-lock'));
  assert.equal(s.refused, false);
  assert.deepEqual(site(remote), before);

  // left by a process on this computer that has ended: taken over straight away
  await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: T3, ignore });
  await remote.writeFile(`${ROOT}/${LOCK_NAME}`, JSON.stringify({ ...lock, machine: require('node:crypto').createHash('sha256').update(require('node:os').hostname()).digest('hex').slice(0, 12), pid: 2 ** 22 + 12345 }));
  const s2 = await runRestore({ remoteRoot: ROOT, remoteFs: remote, now: new Date(2026, 9, 20, 9, 20) });
  assert.equal(s2.refused, false);
  assert.deepEqual(site(remote), before);
});

test('P13 undo never touches anything outside the site folder, even if a backup record says to', async () => {
  for (const bad of ['../outside.txt', '/home/deploy/outside.txt', 'css/../../outside.txt', '_backup-2026-01-01-0000/x', 'C:/outside.txt']) {
    const { remote, local, ignore } = await setup();
    await remote.writeFile('/home/deploy/outside.txt', 'NOT THE SITE');
    const s1 = await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: T1, ignore });
    const rec = JSON.parse((await remote.readFile(`${s1.backupDir}/.backup.json`)).toString());
    rec.added.push({ path: bad, sha256: '0'.repeat(64) });
    await remote.writeFile(`${s1.backupDir}/.backup.json`, JSON.stringify(rec));
    const snapshot = JSON.stringify(remote.dump());
    await assert.rejects(runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2, force: true }), /outside the site/, bad);
    assert.equal(JSON.stringify(remote.dump()), snapshot, `nothing changed for ${bad}`);
  }
  // a record that can't be read is refused too, never treated as an old backup and put back unchecked
  const { remote, local, ignore } = await setup();
  const s1 = await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, now: T1, ignore });
  await remote.writeFile(`${s1.backupDir}/.backup.json`, '{"version":1,"overwr');
  const snapshot = JSON.stringify(remote.dump());
  await assert.rejects(runRestore({ remoteRoot: ROOT, remoteFs: remote, now: T2, force: true }), /damaged/);
  assert.equal(JSON.stringify(remote.dump()), snapshot);
});

test('P13 nor through a symlink: deploy and undo refuse to write through a symlinked folder or over a special file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-promise-link-'));
  const P = path.join(root, 'home/deploy/public_html'), OUT = path.join(root, 'home/deploy/outside');
  await fs.mkdir(P, { recursive: true });
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'secret.txt'), 'NOT THE SITE');
  await fs.writeFile(path.join(P, 'index.html'), 'OLD');
  await fs.symlink(OUT, path.join(P, 'escape'), 'junction'); // a junction on Windows, a plain symlink elsewhere
  const srv = await start({ root, username: 'deploy', password: 'secret' });
  const rfs = await SftpRemoteFs.connect({ host: '127.0.0.1', port: srv.port, username: 'deploy', password: 'secret' });
  const outside = () => fs.readFile(path.join(OUT, 'secret.txt'), 'utf8');
  try {
    // a deploy that would write under the symlink is refused before anything changes, even in a dry run
    const local = await tmpTree({ 'index.html': 'NEW', 'escape/secret.txt': 'OVERWRITTEN' });
    await assert.rejects(runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: rfs, now: T1, dryRun: true }), /escape is a symlink/);
    await assert.rejects(runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: rfs, now: T1 }), /escape is a symlink.*Nothing was changed/);
    assert.equal(await outside(), 'NOT THE SITE');
    assert.equal(await fs.readFile(path.join(P, 'index.html'), 'utf8'), 'OLD');

    // a record tampered to point under the symlink: undo skips that path even with --force
    const safe = await tmpTree({ 'index.html': 'NEW' });
    const s1 = await runDeploy({ localDir: safe, remoteRoot: ROOT, remoteFs: rfs, now: T1 });
    const recPath = path.join(P, s1.backupDir.split('/').pop(), '.backup.json');
    const rec = JSON.parse(await fs.readFile(recPath, 'utf8'));
    rec.added.push({ path: 'escape/secret.txt', sha256: require('node:crypto').createHash('sha256').update('NOT THE SITE').digest('hex') });
    await fs.writeFile(recPath, JSON.stringify(rec));
    const dry = await runRestore({ remoteRoot: ROOT, remoteFs: rfs, dryRun: true });
    assert.ok(dry.conflicts.some(c => c.path === 'escape/secret.txt' && /symlink/.test(c.why)));
    const s = await runRestore({ remoteRoot: ROOT, remoteFs: rfs, now: T2, force: true });
    assert.ok(!s.remove.includes('escape/secret.txt'));
    assert.equal(await outside(), 'NOT THE SITE', 'the file outside the site is still there');
    assert.equal(await fs.readFile(path.join(P, 'index.html'), 'utf8'), 'OLD', 'the rest of the undo still happened');
  } finally { await rfs.close(); await srv.close(); }

  // a symlinked file, and a special file (in memory: the test server can't make a FIFO on Windows)
  const remote = new MemoryRemoteFs();
  await remote.mkdirp(ROOT);
  remote.odd.set(`${ROOT}/link.html`, 'link');
  remote.odd.set(`${ROOT}/pipe`, 'fifo');
  const local2 = await tmpTree({ 'link.html': 'X', 'pipe': 'Y' });
  await assert.rejects(runDeploy({ localDir: local2, remoteRoot: ROOT, remoteFs: remote, now: T1 }), /link\.html is a symlink|pipe is a special file/);
  assert.equal(await remote.stat(`${ROOT}/link.html`), null, 'nothing was written');
});
