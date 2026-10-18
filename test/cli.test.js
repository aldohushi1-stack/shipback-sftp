'use strict';
// The CLI end to end against a real (local, in-process) SFTP server: deploy, list backups, restore.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { start } = require('./helpers/sftp-server');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function cli(args, cwd) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, SFTP_PASSWORD: 'secret' } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err }));
  });
}
const lastJson = out => JSON.parse(out.trim().split('\n').pop());

let srv, root, work, local;
const P = () => path.join(root, 'home/deploy/public_html');
test.before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-cli-srv-'));
  await fs.mkdir(P(), { recursive: true });
  await fs.writeFile(path.join(P(), 'index.html'), 'OLD');
  srv = await start({ root, username: 'deploy', password: 'secret' });
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-cli-'));
  local = path.join(work, 'site');
  await fs.mkdir(local);
  await fs.writeFile(path.join(local, 'index.html'), 'NEW');
  await fs.writeFile(path.join(local, 'about.html'), 'ABOUT');
  await fs.writeFile(path.join(work, 'sites.json'), JSON.stringify({ sites: [{ name: 'mysite', host: '127.0.0.1', port: srv.port, username: 'deploy', remoteRoot: '/home/deploy/public_html', localDir: local }] }));
});
test.after(async () => { await srv.close(); });

test('deploy → --backups → --restore --dry-run → --restore, all from the command line', async () => {
  let r = await cli(['mysite', '--json'], work);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(lastJson(r.out).uploaded.sort(), ['about.html', 'index.html']);
  assert.equal(await fs.readFile(path.join(P(), 'index.html'), 'utf8'), 'NEW');

  r = await cli(['mysite', '--backups', '--json'], work);
  assert.equal(r.code, 0, r.err);
  const list = JSON.parse(r.out.slice(r.out.indexOf('[')));
  assert.equal(list.length, 1);
  assert.equal(list[0].action, 'deploy'); assert.equal(list[0].overwritten, 1); assert.equal(list[0].added, 1);

  r = await cli(['mysite', '--restore', '--dry-run', '--json'], work);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /< index\.html/); assert.match(r.out, /- about\.html/);
  assert.equal(await fs.readFile(path.join(P(), 'index.html'), 'utf8'), 'NEW', 'dry run changed nothing');

  r = await cli(['mysite', '--restore', 'latest', '--json'], work);
  assert.equal(r.code, 0, r.err);
  const s = lastJson(r.out);
  assert.deepEqual(s.put, ['index.html']); assert.deepEqual(s.remove, ['about.html']);
  assert.equal(await fs.readFile(path.join(P(), 'index.html'), 'utf8'), 'OLD');
  assert.match(r.out, /Undo this with --restore _backup-/);

  r = await cli(['--history', 'mysite', '--json'], work);
  const h = JSON.parse(r.out);
  assert.deepEqual(h.map(x => x.action), ['restore', 'deploy']);
  assert.deepEqual(h[0].restored, ['index.html']);
});

test('--restore refuses with exit 4 when a live file was edited after the deploy', async () => {
  await fs.writeFile(path.join(local, 'index.html'), 'NEWER');
  let r = await cli(['mysite'], work);
  assert.equal(r.code, 0, r.err);
  await fs.writeFile(path.join(P(), 'index.html'), 'EDITED IN CPANEL');
  r = await cli(['mysite', '--restore'], work);
  assert.equal(r.code, 4, r.out + r.err);
  assert.match(r.out, /CONFLICT index\.html: edited on the server/);
  assert.match(r.out, /Refused/);
  assert.equal(await fs.readFile(path.join(P(), 'index.html'), 'utf8'), 'EDITED IN CPANEL');
});
