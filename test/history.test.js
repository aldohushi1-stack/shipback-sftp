'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { appendHistory, readHistory, recordFromSummary } = require('../src/history');

test('append + read round-trip, newest first, filter by site, limit', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'sd-hist-')), 'deploys.jsonl');
  assert.deepEqual(await readHistory(file), []);
  await appendHistory(file, { at: '2026-09-20T01:00:00Z', action: 'deploy', site: 'mysite', ok: true, uploaded: ['a'] });
  await appendHistory(file, { at: '2026-09-20T02:00:00Z', action: 'pull', site: 'example.org', ok: true, downloaded: ['b'] });
  await appendHistory(file, { at: '2026-09-20T03:00:00Z', action: 'deploy', site: 'mysite', ok: false, error: 'boom' });
  const all = await readHistory(file);
  assert.deepEqual(all.map(r => r.at), ['2026-09-20T03:00:00Z', '2026-09-20T02:00:00Z', '2026-09-20T01:00:00Z']);
  assert.deepEqual((await readHistory(file, { site: 'mysite' })).map(r => r.ok), [false, true]);
  assert.equal((await readHistory(file, { limit: 1 })).length, 1);
});

test('a corrupt line is skipped, not fatal', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'sd-hist-')), 'deploys.jsonl');
  await fs.writeFile(file, '{"at":"1","action":"deploy"}\nnot json\n{"at":"2","action":"pull"}\n');
  assert.deepEqual((await readHistory(file)).map(r => r.at), ['2', '1']);
});

test('recordFromSummary keeps the useful fields and counts, not the whole plan', () => {
  const rec = recordFromSummary({
    action: 'deploy', site: 'mysite', trigger: 'queue', localDir: 'C:\\x', remoteDir: '/home/b/public_html', startedAt: '2026-09-20T01:00:00Z',
    summary: { dryRun: false, plan: { upload: [{ path: 'a' }], skip: ['b', 'c'], extra: ['z'], delete: [] }, uploaded: ['a'], backedUp: ['a'], backupDir: '/home/b/public_html/_backup-x', deleted: [], bytes: 12 },
  });
  assert.equal(rec.action, 'deploy'); assert.equal(rec.trigger, 'queue'); assert.equal(rec.ok, true);
  assert.deepEqual(rec.uploaded, ['a']); assert.equal(rec.backupDir, '/home/b/public_html/_backup-x'); assert.equal(rec.bytes, 12);
  assert.equal(rec.unchanged, 2); assert.equal(rec.extra, 1);
  assert.ok(!('plan' in rec));
  const err = recordFromSummary({ action: 'deploy', site: 's', error: 'boom', summary: { uploaded: ['a'] } });
  assert.equal(err.ok, false); assert.equal(err.error, 'boom'); assert.deepEqual(err.uploaded, ['a']);
});
