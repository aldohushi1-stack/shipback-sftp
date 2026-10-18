'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plan, resolveVerify } = require('../src/diff');

const L = (path, sha256, size = 10, mtime = 2000) => ({ path, sha256, size, mtime });
const R = (path, size = 10, mtime = 2000) => ({ path, size, mtime });

test('new / changed / unchanged / extra with a remote manifest', () => {
  const local = [L('a.html', 'h1'), L('b.html', 'h2', 12), L('c.html', 'h3'), L('d.html', 'h4', 10)];
  const remoteManifest = { files: { 'a.html': { sha256: 'h1' }, 'b.html': { sha256: 'OLD' }, 'd.html': { sha256: 'OLD-SAME-SIZE' }, 'z.html': { sha256: 'zz' } } };
  const remoteListing = [R('a.html'), R('b.html', 10), R('d.html', 10), R('z.html')];
  const p = plan({ local, remoteManifest, remoteListing });
  assert.deepEqual(p.upload.map(u => [u.path, u.reason]), [['b.html', 'changed'], ['c.html', 'new']]);
  assert.deepEqual(p.verify.map(v => v.path), ['d.html'], 'manifest disagrees but same size ⇒ read the server copy (folder may have been pulled since)');
  assert.deepEqual(p.skip, ['a.html']);
  assert.deepEqual(p.extra, ['z.html']);
  assert.deepEqual(p.delete, []);
});

test('no manifest: size differs ⇒ changed; same size ⇒ verify (never trusts mtime)', () => {
  const local = [L('same.html', 'x', 10, 1000), L('bigger.html', 'x', 12, 1000), L('newer.html', 'y', 10, 5000)];
  const remoteListing = [R('same.html', 10, 3000), R('bigger.html', 10, 3000), R('newer.html', 10, 1000)];
  const p = plan({ local, remoteManifest: null, remoteListing });
  assert.deepEqual(p.upload.map(u => u.path), ['bigger.html']);
  assert.deepEqual(p.skip, []);
  assert.deepEqual(p.verify.map(v => v.path), ['newer.html', 'same.html']);
});

test('resolveVerify hashes the server copy: equal ⇒ skip, different ⇒ changed, huge ⇒ skip without reading', async () => {
  const sha = s => require('node:crypto').createHash('sha256').update(s).digest('hex');
  const local = [L('a.html', sha('A'), 1), L('b.html', sha('B'), 1), L('big.bin', 'whatever', 50 * 1024 * 1024)];
  const remoteListing = [R('a.html', 1), R('b.html', 1), R('big.bin', 50 * 1024 * 1024)];
  const p = plan({ local, remoteManifest: null, remoteListing });
  const read = [];
  await resolveVerify(p, { readFile: async path => { read.push(path); return Buffer.from(path === 'a.html' ? 'A' : 'OLD-B'); } });
  assert.deepEqual(read.sort(), ['a.html', 'b.html']);
  assert.deepEqual(p.upload.map(u => [u.path, u.reason]), [['b.html', 'changed']]);
  assert.deepEqual(p.skip, ['a.html', 'big.bin']);
  assert.deepEqual(p.verify, []);
  assert.equal(p.uploadBytes, 1);
});

test('manifest entry present but file missing on server ⇒ new (manifest is stale)', () => {
  const p = plan({ local: [L('a.html', 'h1')], remoteManifest: { files: { 'a.html': { sha256: 'h1' } } }, remoteListing: [] });
  assert.deepEqual(p.upload.map(u => [u.path, u.reason]), [['a.html', 'new']]);
});

test('file on server with no manifest entry but same size ⇒ verify, not skip', () => {
  const p = plan({ local: [L('a.html', 'h1', 10, 1000)], remoteManifest: { files: {} }, remoteListing: [R('a.html', 10, 1000)] });
  assert.deepEqual(p.skip, []);
  assert.deepEqual(p.verify.map(v => v.path), ['a.html']);
});

test('mirror: extras become deletes; backup folders and the manifest itself are never extras', () => {
  const remoteListing = [R('old.html'), R('_backup-2026-09-01-1200/index.html'), R('.deploy-manifest.json'), R('.well-known/acme'), R('cgi-bin/x')];
  const p1 = plan({ local: [], remoteManifest: null, remoteListing });
  assert.deepEqual(p1.extra, ['.well-known/acme', 'cgi-bin/x', 'old.html']);
  assert.deepEqual(p1.delete, []);
  const p2 = plan({ local: [], remoteManifest: null, remoteListing, mirror: true });
  assert.deepEqual(p2.delete, ['.well-known/acme', 'cgi-bin/x', 'old.html']);
});

test('upload list keeps size for progress totals and is sorted by path', () => {
  const p = plan({ local: [L('z.html', 'a', 5), L('a.html', 'b', 7)], remoteManifest: null, remoteListing: [] });
  assert.deepEqual(p.upload.map(u => [u.path, u.size]), [['a.html', 7], ['z.html', 5]]);
  assert.equal(p.uploadBytes, 12);
});
