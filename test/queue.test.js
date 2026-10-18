'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createQueueWatcher, QUEUE_SUFFIX } = require('../src/queue');

const wait = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await wait(40); } }
const readJson = async p => JSON.parse(await fs.readFile(p, 'utf8'));

// The watcher is stopped even when an assert fails: a live poll timer would keep the test process open.
// `requests` are queued before the watcher starts, so a poll can't land between two writes.
async function setup(t, runJob, requests = {}) {
  const queueDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'sd-q-')), 'queue');
  const w = createQueueWatcher({ queueDir, pollMs: 50, runJob, log: () => {} });
  t.after(() => w.stop());
  await fs.mkdir(queueDir, { recursive: true });
  for (const [name, req] of Object.entries(requests)) await fs.writeFile(path.join(queueDir, name + QUEUE_SUFFIX), JSON.stringify(req));
  await w.start();
  return { queueDir, w };
}

test('a request file is picked up, run, and answered with result.json + log.txt; request is kept as .done', async t => {
  const ran = [];
  const { queueDir, w } = await setup(t, async ({ request, onEvent }) => { ran.push(request); onEvent({ type: 'upload', path: 'index.html', done: 1, total: 1 }); return { uploaded: ['index.html'], bytes: 5 }; });
  await fs.writeFile(path.join(queueDir, 'job1' + QUEUE_SUFFIX), JSON.stringify({ action: 'deploy', site: 'mysite', localDir: 'C:\\x', note: 'homepage' }));
  // The rename to .done is the watcher's last step (after log.txt and result.json), so wait for that.
  await waitFor(() => fs.stat(path.join(queueDir, 'job1.request.done.json')).catch(() => null));
  const result = await readJson(path.join(queueDir, 'job1.result.json'));
  assert.equal(result.ok, true); assert.equal(result.action, 'deploy'); assert.equal(result.site, 'mysite');
  assert.deepEqual(result.summary.uploaded, ['index.html']);
  assert.ok(result.startedAt && result.finishedAt);
  assert.equal(ran.length, 1); assert.equal(ran[0].note, 'homepage');
  const log = await fs.readFile(path.join(queueDir, 'job1.log.txt'), 'utf8');
  assert.match(log, /upload.*index\.html/);
  assert.equal(await fs.stat(path.join(queueDir, 'job1' + QUEUE_SUFFIX)).catch(() => null), null, 'request renamed away');
  assert.ok(await fs.stat(path.join(queueDir, 'job1.request.done.json')));
  await w.stop();
});

test('errors from the job are written as ok:false with the message; watcher keeps going', async t => {
  let n = 0;
  const { queueDir, w } = await setup(t, async () => { if (++n === 1) throw new Error('Authentication failed'); return { uploaded: [] }; });
  await fs.writeFile(path.join(queueDir, 'a' + QUEUE_SUFFIX), JSON.stringify({ action: 'deploy', site: 's' }));
  const r1 = await waitFor(() => readJson(path.join(queueDir, 'a.result.json')).catch(() => null));
  assert.equal(r1.ok, false); assert.match(r1.error, /Authentication failed/);
  await fs.writeFile(path.join(queueDir, 'b' + QUEUE_SUFFIX), JSON.stringify({ action: 'deploy', site: 's' }));
  const r2 = await waitFor(() => readJson(path.join(queueDir, 'b.result.json')).catch(() => null));
  assert.equal(r2.ok, true);
  await w.stop();
});

test('invalid requests: bad action / missing site are rejected without calling runJob; half-written JSON is retried', async t => {
  let calls = 0;
  const { queueDir, w } = await setup(t, async () => { calls++; return {}; });
  await fs.writeFile(path.join(queueDir, 'bad' + QUEUE_SUFFIX), JSON.stringify({ action: 'format-disk', site: 's' }));
  await fs.writeFile(path.join(queueDir, 'nosite' + QUEUE_SUFFIX), JSON.stringify({ action: 'deploy' }));
  const r1 = await waitFor(() => readJson(path.join(queueDir, 'bad.result.json')).catch(() => null));
  assert.equal(r1.ok, false); assert.match(r1.error, /action/);
  const r2 = await waitFor(() => readJson(path.join(queueDir, 'nosite.result.json')).catch(() => null));
  assert.match(r2.error, /site/);
  const partial = path.join(queueDir, 'partial' + QUEUE_SUFFIX);
  await fs.writeFile(partial, '{"action":"pull","si');
  await wait(150);
  assert.equal(await fs.stat(path.join(queueDir, 'partial.result.json')).catch(() => null), null, 'partial file not answered yet');
  await fs.writeFile(partial, JSON.stringify({ action: 'pull', site: 's' }));
  const r3 = await waitFor(() => readJson(path.join(queueDir, 'partial.result.json')).catch(() => null));
  assert.equal(r3.ok, true);
  assert.equal(calls, 1);
  await w.stop();
});

test('jobs run one at a time in name order', async t => {
  const order = [];
  const { queueDir, w } = await setup(t, async ({ request }) => { order.push('start:' + request.site); await wait(60); order.push('end:' + request.site); return {}; },
    { 2: { action: 'deploy', site: 'two' }, 1: { action: 'deploy', site: 'one' } });
  await waitFor(() => readJson(path.join(queueDir, '2.result.json')).catch(() => null));
  assert.deepEqual(order, ['start:one', 'end:one', 'start:two', 'end:two']);
  await w.stop();
});

test('the site rule still holds for the SFTP actions, and the unknown-action error lists the actions', async t => {
  const { queueDir, w } = await setup(t, async () => ({}));
  await fs.writeFile(path.join(queueDir, 'x' + QUEUE_SUFFIX), JSON.stringify({ action: 'prune' }));
  await fs.writeFile(path.join(queueDir, 'y' + QUEUE_SUFFIX), JSON.stringify({ action: 'reboot', site: 's' }));
  const x = await waitFor(() => readJson(path.join(queueDir, 'x.result.json')).catch(() => null));
  assert.match(x.error, /site/);
  const y = await waitFor(() => readJson(path.join(queueDir, 'y.result.json')).catch(() => null));
  assert.match(y.error, /deploy, pull, preview, prune, restore or backups/);
  await w.stop();
});

