'use strict';
// Ignore rules (site "ignore" + .deployignore + defaults) are hands-off on BOTH sides:
// an ignored path is never uploaded, never pulled, and never mirror-deleted from the server.
// Regression (a real site, Sep 2026): ignore ['*.bak-*', '/mail/'] hid the files locally only,
// so Preview pull showed 18 "new" server files and a mirror deploy would have deleted example.org/mail (the webmail app).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MemoryRemoteFs } = require('../src/remote-fs');
const { runDeploy, previewDeploy } = require('../src/deploy');
const { runPull } = require('../src/pull');

const ROOT = '/home/deploy/example.org';
const NOW = new Date(2026, 8, 30, 19, 45);
const IGNORE = ['*.bak-*', '/mail/'];

async function tmpTree(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-ign-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
  return dir;
}

// A live site's shape: the site, plus the webmail app (deployed from its own repo) and old hand-made backups.
async function liveSite() {
  const r = new MemoryRemoteFs();
  await r.mkdirp(ROOT + '/mail/api');
  await r.writeFile(ROOT + '/index.html', Buffer.from('SITE'));
  await r.writeFile(ROOT + '/stale.html', Buffer.from('STALE'));
  await r.writeFile(ROOT + '/index.html.bak-2026-09-16-social', Buffer.from('OLD HOME'));
  await r.writeFile(ROOT + '/mail/app.js', Buffer.from('LIVE MAIL APP v2'));
  await r.writeFile(ROOT + '/mail/.deploy-manifest.json', Buffer.from('{"version":1,"files":{}}'));
  await r.writeFile(ROOT + '/mail/api/index.php', Buffer.from('<?php'));
  return r;
}

test('mirror preview never lists ignored server files as extra or to-delete', async () => {
  const local = await tmpTree({ 'index.html': 'SITE' });
  const remote = await liveSite();
  const { plan } = await previewDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, mirror: true, ignore: IGNORE });
  assert.deepEqual(plan.extra, ['stale.html']);
  assert.deepEqual(plan.delete, ['stale.html']);
});

test('mirror deploy keeps ignored server files (the webmail app survives), still deletes real extras', async () => {
  const local = await tmpTree({ 'index.html': 'SITE' });
  const remote = await liveSite();
  const s = await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, mirror: true, ignore: IGNORE, now: NOW });
  assert.deepEqual(s.deleted, ['stale.html']);
  assert.deepEqual(s.backedUp, ['stale.html'], 'only files actually being deleted are backed up');
  assert.equal(await remote.stat(ROOT + '/stale.html'), null);
  assert.equal((await remote.readFile(ROOT + '/mail/app.js')).toString(), 'LIVE MAIL APP v2');
  assert.equal((await remote.readFile(ROOT + '/mail/api/index.php')).toString(), '<?php');
  assert.equal((await remote.readFile(ROOT + '/mail/.deploy-manifest.json')).toString(), '{"version":1,"files":{}}');
  assert.equal((await remote.readFile(ROOT + '/index.html.bak-2026-09-16-social')).toString(), 'OLD HOME');
});

test('pull preview does not offer ignored server files as "new" (the 18-file screen)', async () => {
  const local = await tmpTree({ 'index.html': 'SITE', 'stale.html': 'STALE' });
  const remote = await liveSite();
  const s = await runPull({ localDir: local, remoteRoot: ROOT, remoteFs: remote, dryRun: true, ignore: IGNORE, now: NOW });
  assert.deepEqual(s.plan.download, []);
  assert.deepEqual(s.plan.extra, []);
});

test('real pull leaves ignored local files alone even when the server copy differs', async () => {
  const local = await tmpTree({ 'index.html': 'SITE', 'mail/app.js': 'STALE LOCAL MAIL v1', 'index.html.bak-2026-09-16-social': 'OLD HOME' });
  const remote = await liveSite();
  const s = await runPull({ localDir: local, remoteRoot: ROOT, remoteFs: remote, ignore: IGNORE, now: NOW });
  assert.deepEqual(s.downloaded, ['stale.html']);
  assert.equal(await fs.readFile(path.join(local, 'mail/app.js'), 'utf8'), 'STALE LOCAL MAIL v1');
  assert.equal(await fs.stat(path.join(local, 'mail/api')).catch(() => null), null, 'ignored server folders are not pulled in');
});

test('rules from the local .deployignore protect server files too', async () => {
  const local = await tmpTree({ 'index.html': 'SITE', '.deployignore': '# owned by the webmail repo\n/mail/\n' });
  const remote = await liveSite();
  const s = await runDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, mirror: true, now: NOW });
  assert.deepEqual(s.deleted.sort(), ['index.html.bak-2026-09-16-social', 'stale.html']);
  assert.equal((await remote.readFile(ROOT + '/mail/app.js')).toString(), 'LIVE MAIL APP v2');
});

test('built-in ignores (.git/, Thumbs.db) are hands-off on the server as well', async () => {
  const local = await tmpTree({ 'index.html': 'SITE' });
  const remote = await liveSite();
  await remote.mkdirp(ROOT + '/.git');
  await remote.writeFile(ROOT + '/.git/HEAD', Buffer.from('ref: refs/heads/main'));
  await remote.writeFile(ROOT + '/Thumbs.db', Buffer.from('x'));
  const { plan } = await previewDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, mirror: true, ignore: IGNORE });
  assert.deepEqual(plan.delete, ['stale.html']);
});

test('an anchored rule stays anchored: /mail/ does not protect blog/mail/', async () => {
  const local = await tmpTree({ 'index.html': 'SITE' });
  const remote = await liveSite();
  await remote.mkdirp(ROOT + '/blog/mail');
  await remote.writeFile(ROOT + '/blog/mail/post.html', Buffer.from('P'));
  const { plan } = await previewDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, mirror: true, ignore: IGNORE });
  assert.deepEqual(plan.delete, ['blog/mail/post.html', 'stale.html']);
});

test('with no ignore rules, mirror behaves exactly as before', async () => {
  const local = await tmpTree({ 'index.html': 'SITE' });
  const remote = await liveSite();
  const { plan } = await previewDeploy({ localDir: local, remoteRoot: ROOT, remoteFs: remote, mirror: true });
  assert.deepEqual(plan.delete, ['index.html.bak-2026-09-16-social', 'mail/.deploy-manifest.json', 'mail/api/index.php', 'mail/app.js', 'stale.html']);
});
