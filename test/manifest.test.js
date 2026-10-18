'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { scanLocal, makeMatcher, parseIgnoreFile, DEFAULT_IGNORE } = require('../src/manifest');

async function tmpTree(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-man-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
  return dir;
}

test('scanLocal returns POSIX relative paths, sizes and sha256, sorted', async () => {
  const dir = await tmpTree({ 'index.html': '<h1>hi</h1>', 'css/site.css': 'body{}', 'img/a.png': 'PNG' });
  const files = await scanLocal(dir);
  assert.deepEqual(files.map(f => f.path), ['css/site.css', 'img/a.png', 'index.html']);
  const idx = files.find(f => f.path === 'index.html');
  assert.equal(idx.size, 11);
  assert.equal(idx.sha256, crypto.createHash('sha256').update('<h1>hi</h1>').digest('hex'));
  assert.equal(typeof idx.mtime, 'number');
  assert.ok(files.every(f => !f.path.includes('\\')));
});

test('default ignore drops .git, node_modules, Thumbs.db, .DS_Store, *.tmp, .deployignore', async () => {
  const dir = await tmpTree({
    'index.html': 'x', '.git/HEAD': 'ref', 'node_modules/a/index.js': 'x',
    'Thumbs.db': 'x', 'img/.DS_Store': 'x', 'scratch.tmp': 'x', '.deployignore': '',
    'desktop.ini': 'x', '_backup-2026-09-20-1500/index.html': 'pulled backup',
  });
  const files = await scanLocal(dir);
  assert.deepEqual(files.map(f => f.path), ['index.html']);
});

test('.deployignore adds globs, dir/ suffix, comments and blank lines', async () => {
  const dir = await tmpTree({
    'index.html': 'x', 'notes.md': 'x', 'drafts/a.html': 'x', 'drafts/b.html': 'x', 'src/x.md': 'x',
    '.deployignore': '# local only\n*.md\n\ndrafts/\n',
  });
  const files = await scanLocal(dir);
  assert.deepEqual(files.map(f => f.path), ['index.html']);
});

test('parseIgnoreFile and makeMatcher semantics', () => {
  const globs = parseIgnoreFile('# c\n*.log\nbuild/\n\n  \ntmp\n');
  assert.deepEqual(globs, ['*.log', 'build/', 'tmp']);
  const m = makeMatcher([...DEFAULT_IGNORE, ...globs]);
  assert.equal(m('a/b.log', false), true);        // *.log matches at any depth
  assert.equal(m('build', true), true);           // dir rule matches the dir
  assert.equal(m('build/x.js', false), true);     // and everything under it
  assert.equal(m('tmp', false), true);            // bare name matches file
  assert.equal(m('tmp', true), true);             // or dir
  assert.equal(m('src/tmp/x', false), true);      // at any depth
  assert.equal(m('index.html', false), false);
  assert.equal(m('assets/logo.png', false), false);
});

test('scanLocal on a missing folder rejects with a clear error', async () => {
  await assert.rejects(scanLocal(path.join(os.tmpdir(), 'does-not-exist-' + Date.now())), /not found|ENOENT/i);
});
