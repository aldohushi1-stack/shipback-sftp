'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { MemoryRemoteFs } = require('../src/remote-fs');
const { MemoryStore } = require('../src/credentials');

let app, base, remote, local, store, sitesFile;

async function api(method, p, body, headers = {}) {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
async function events(jobId) {
  const res = await fetch(base + '/api/events/' + jobId);
  const text = await res.text();
  return text.split('\n\n').filter(Boolean).map(chunk => JSON.parse(chunk.replace(/^data: /, '')));
}

test.before(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-srv-app-'));
  sitesFile = path.join(dir, 'sites.json');
  await fs.writeFile(sitesFile, JSON.stringify({ sites: [{ name: 'mysite', host: 'example.invalid', port: 22, username: 'deploy', remoteRoot: '/home/deploy/public_html', localDir: dir }] }));
  local = path.join(dir, 'site'); await fs.mkdir(local);
  await fs.writeFile(path.join(local, 'index.html'), 'NEW');
  remote = new MemoryRemoteFs();
  await remote.mkdirp('/home/deploy/public_html');
  await remote.writeFile('/home/deploy/public_html/index.html', Buffer.from('OLD'));
  store = new MemoryStore();
  app = await createApp({
    sitesFile, credentials: store, now: () => new Date(2026, 8, 20, 14, 0),
    historyFile: path.join(dir, 'deploys.jsonl'), queueDir: path.join(dir, 'queue'), queuePollMs: 50,
    connect: async ({ password }) => { if (password !== 'pw') { const e = new Error('All configured authentication methods failed'); throw e; } return remote; },
  });
  await app.listen(0);
  base = 'http://127.0.0.1:' + app.port;
});
test.after(() => app.close());

test('GET /api/sites returns sites without any password field', async () => {
  const r = await api('GET', '/api/sites');
  assert.equal(r.status, 200);
  assert.equal(r.json.sites[0].name, 'mysite');
  assert.ok(!('password' in r.json.sites[0]));
});

test('connect with wrong password → 401 and nothing stored; right password → stored', async () => {
  let r = await api('POST', '/api/connect', { site: 'mysite', password: 'bad' });
  assert.equal(r.status, 401);
  assert.equal(await store.get('mysite'), null);
  r = await api('POST', '/api/connect', { site: 'mysite', password: 'pw' });
  assert.equal(r.status, 200);
  assert.equal(await store.get('mysite'), 'pw');
  // subsequent calls don't need the password
  r = await api('POST', '/api/connect', { site: 'mysite' });
  assert.equal(r.status, 200);
});

test('preview returns a plan and changes nothing', async () => {
  const r = await api('POST', '/api/preview', { site: 'mysite', localDir: local, remoteDir: '/home/deploy/public_html' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.plan.upload.map(u => u.path), ['index.html']);
  assert.equal((await remote.readFile('/home/deploy/public_html/index.html')).toString(), 'OLD');
});

test('deploy streams events and finishes with a summary', async () => {
  const r = await api('POST', '/api/deploy', { site: 'mysite', localDir: local, remoteDir: '/home/deploy/public_html' });
  assert.equal(r.status, 200);
  const ev = await events(r.json.jobId);
  const done = ev.find(e => e.type === 'done');
  assert.ok(done, 'done event');
  assert.deepEqual(done.summary.uploaded, ['index.html']);
  assert.equal((await remote.readFile('/home/deploy/public_html/index.html')).toString(), 'NEW');
  assert.equal((await remote.readFile('/home/deploy/public_html/_backup-2026-09-20-1400/index.html')).toString(), 'OLD');
});

test('quick upload (multipart) puts files under the chosen remote dir with backup', async () => {
  const fd = new FormData();
  fd.append('site', 'mysite');
  fd.append('remoteDir', '/home/deploy/public_html/docs');
  fd.append('files', new Blob(['PDF-BYTES']), 'guide.pdf');
  fd.append('files', new Blob(['<p>x</p>']), 'note.html');
  const res = await fetch(base + '/api/upload', { method: 'POST', body: fd });
  assert.equal(res.status, 200);
  const { jobId } = await res.json();
  const ev = await events(jobId);
  const done = ev.find(e => e.type === 'done');
  assert.deepEqual(done.summary.uploaded.sort(), ['guide.pdf', 'note.html']);
  assert.equal((await remote.readFile('/home/deploy/public_html/docs/guide.pdf')).toString(), 'PDF-BYTES');
});

test('unknown site → 404; non-loopback Host header → 403', async () => {
  let r = await api('POST', '/api/preview', { site: 'nope', localDir: local, remoteDir: '/x' });
  assert.equal(r.status, 404);
  // fetch() won't override Host, so use a raw request (this is what a DNS-rebinding page would send)
  const status = await new Promise((resolve, reject) => {
    require('node:http').request({ host: '127.0.0.1', port: app.port, path: '/api/sites', headers: { host: 'evil.example.com' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  });
  assert.equal(status, 403);
});

test('POST /api/sites saves a site and never persists a password', async () => {
  const r = await api('POST', '/api/sites', { name: 'example.org', host: 'h', port: 22, username: 'u', remoteRoot: '/home/u/example.org', localDir: 'C:\\x', password: 'SHOULD-NOT-SAVE' });
  assert.equal(r.status, 200);
  const raw = await fs.readFile(sitesFile, 'utf8');
  assert.ok(!raw.includes('SHOULD-NOT-SAVE'));
  assert.ok(raw.includes('example.org'));
});

test('pull downloads server changes into the local folder with a local backup; server untouched', async () => {
  await remote.writeFile('/home/deploy/public_html/index.html', Buffer.from('EDITED LIVE'));
  await remote.mkdirp('/home/deploy/public_html/intake');
  await remote.writeFile('/home/deploy/public_html/intake/config.php', Buffer.from('<?php'));
  const before = JSON.stringify(remote.dump());
  const r = await api('POST', '/api/pull', { site: 'mysite', localDir: local, remoteDir: '/home/deploy/public_html' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const ev = await events(r.json.jobId);
  const done = ev.find(e => e.type === 'done');
  assert.deepEqual(done.summary.downloaded.sort(), ['docs/guide.pdf', 'docs/note.html', 'index.html', 'intake/config.php']);
  assert.equal(await fs.readFile(path.join(local, 'index.html'), 'utf8'), 'EDITED LIVE');
  assert.equal(await fs.readFile(path.join(local, '_backup-2026-09-20-1400', 'index.html'), 'utf8'), 'NEW');
  assert.equal(JSON.stringify(remote.dump()), before);
});

test('history records deploy, upload and pull runs, newest first', async () => {
  const r = await api('GET', '/api/history?site=mysite');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.history.map(h => h.action), ['pull', 'upload', 'deploy']);
  assert.ok(r.json.history.every(h => h.ok && h.trigger === 'ui'));
  assert.deepEqual(r.json.history[2].uploaded, ['index.html']);
});

test('queue: a request file dropped in queue/ is run and answered, and shows in history as trigger=queue', async () => {
  await fs.writeFile(path.join(local, 'queued.html'), 'Q');
  await fs.writeFile(path.join(app.queueDir, 'job-a.request.json'), JSON.stringify({ action: 'deploy', site: 'mysite', localDir: local, remoteDir: '/home/deploy/public_html', note: 'from test' }));
  const t0 = Date.now();
  let result = null;
  while (!result && Date.now() - t0 < 5000) { result = await fs.readFile(path.join(app.queueDir, 'job-a.result.json'), 'utf8').then(JSON.parse).catch(() => null); if (!result) await new Promise(r => setTimeout(r, 50)); }
  assert.ok(result, 'result.json written');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.summary.uploaded, ['queued.html']);
  assert.equal((await remote.readFile('/home/deploy/public_html/queued.html')).toString(), 'Q');
  const h = (await api('GET', '/api/history')).json.history[0];
  assert.equal(h.trigger, 'queue'); assert.equal(h.action, 'deploy');
  // preview via queue: no changes now
  await fs.writeFile(path.join(app.queueDir, 'job-b.request.json'), JSON.stringify({ action: 'preview', site: 'mysite', localDir: local }));
  let r2 = null; const t1 = Date.now();
  while (!r2 && Date.now() - t1 < 5000) { r2 = await fs.readFile(path.join(app.queueDir, 'job-b.result.json'), 'utf8').then(JSON.parse).catch(() => null); if (!r2) await new Promise(r => setTimeout(r, 50)); }
  assert.equal(r2.ok, true); assert.deepEqual(r2.summary.plan.upload, []);
});

test('queue: prune removes named backup folders (twin-checked) and refuses without names/keep', async () => {
  const R = '/home/deploy/public_html';
  for (const stamp of ['2026-09-24-2352', '2026-09-25-0004', '2026-09-25-0054']) {
    await remote.mkdirp(`${R}/_backup-${stamp}/play`);
    await remote.writeFile(`${R}/_backup-${stamp}/play/track.php`, Buffer.from('OLD TRACK'));
  }
  const run = async (name, req) => {
    await fs.writeFile(path.join(app.queueDir, name + '.request.json'), JSON.stringify(req));
    let r = null; const t0 = Date.now();
    while (!r && Date.now() - t0 < 5000) { r = await fs.readFile(path.join(app.queueDir, name + '.result.json'), 'utf8').then(JSON.parse).catch(() => null); if (!r) await new Promise(res => setTimeout(res, 50)); }
    return r;
  };
  const bad = await run('prune-0', { action: 'prune', site: 'mysite' });
  assert.equal(bad.ok, false); assert.match(bad.error, /names.*keep/);
  const dry = await run('prune-1', { action: 'prune', site: 'mysite', names: ['_backup-2026-09-24-2352', '_backup-2026-09-25-0004'], dryRun: true });
  assert.equal(dry.ok, true); assert.equal(dry.summary.dryRun, true); assert.ok(await remote.stat(`${R}/_backup-2026-09-24-2352/play/track.php`));
  const go = await run('prune-2', { action: 'prune', site: 'mysite', names: ['_backup-2026-09-24-2352', '_backup-2026-09-25-0004'], note: 'tidy' });
  assert.equal(go.ok, true, JSON.stringify(go));
  assert.deepEqual(go.summary.pruned.map(p => p.name), ['_backup-2026-09-24-2352', '_backup-2026-09-25-0004']);
  assert.equal(await remote.stat(`${R}/_backup-2026-09-24-2352`), null);
  assert.ok(await remote.stat(`${R}/_backup-2026-09-25-0054/play/track.php`), 'kept backup intact');
  const log = await fs.readFile(path.join(app.queueDir, 'prune-2.log.txt'), 'utf8');
  assert.match(log, /prune 2 \(_backup-2026-09-24-2352, _backup-2026-09-25-0004\), keep \d+/);
  assert.match(log, /rmdir _backup-2026-09-25-0004/);
  const h = (await api('GET', '/api/history')).json.history[0];
  assert.equal(h.action, 'prune'); assert.equal(h.trigger, 'queue'); assert.deepEqual(h.pruned, ['_backup-2026-09-24-2352', '_backup-2026-09-25-0004']); assert.equal(h.deleted, 2);
});

test('GET /api/browse lists local folders for the picker', async () => {
  const r = await api('GET', '/api/browse?dir=' + encodeURIComponent(path.dirname(local)));
  assert.equal(r.status, 200);
  assert.ok(r.json.dirs.includes('site'));
});

test('a key-based site that fails auth is not answered with a password prompt', async () => {
  let r = await api('POST', '/api/sites', { name: 'keysite', host: 'h', port: 2222, username: 'u', remoteRoot: '/home/u/x', localDir: 'C:\\x', privateKeyPath: 'C:\\no-such-key' });
  assert.equal(r.status, 200);
  try {
    r = await api('POST', '/api/connect', { site: 'keysite' }); // key sites connect without a password; the mock rejects it
    assert.equal(r.status, 401);
    assert.notEqual(r.json.needPassword, true, 'the typed password would be ignored for a key site, so never ask for one');
    assert.equal(await store.get('keysite'), null);
  } finally { await api('DELETE', '/api/sites', { name: 'keysite' }); }
});
