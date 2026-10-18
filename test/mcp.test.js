'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MemoryRemoteFs } = require('../src/remote-fs');
const { MemoryStore } = require('../src/credentials');
const { createMcp, TOOLS } = require('../src/mcp');
const { start } = require('./helpers/sftp-server');

const ROOT = '/home/deploy/public_html';

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-mcp-'));
  const local = path.join(dir, 'site');
  await fs.mkdir(local);
  await fs.writeFile(path.join(local, 'index.html'), 'NEW');
  await fs.writeFile(path.join(local, 'about.html'), 'ABOUT');
  const sitesFile = path.join(dir, 'sites.json');
  await fs.writeFile(sitesFile, JSON.stringify({ sites: [{ name: 'mysite', host: 'example.invalid', port: 22, username: 'deploy', remoteRoot: ROOT, localDir: local }] }));
  const remote = new MemoryRemoteFs();
  await remote.mkdirp(ROOT);
  await remote.writeFile(ROOT + '/index.html', Buffer.from('OLD'));
  await remote.writeFile(ROOT + '/uploads-only-on-server.jpg', Buffer.from('JPG'));
  let t = 0;
  const mcp = createMcp({ sitesFile, credentials: new MemoryStore(), connect: async () => remote, now: () => new Date(2026, 9, 18, 14, t++) });
  let id = 0;
  const call = async (name, args) => {
    const res = await mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    const text = res.result.content[0].text;
    return { isError: !!res.result.isError, text, json: res.result.isError ? null : JSON.parse(text) };
  };
  return { dir, local, remote, mcp, call, sitesFile };
}

test('initialize, tools/list, ping and unknown methods', async () => {
  const { mcp } = await setup();
  const init = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'shipback-sftp');
  assert.ok(init.result.capabilities.tools);
  const old = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(old.result.protocolVersion, '2025-06-18', 'unknown version → our newest');
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map(t => t.name), TOOLS.map(t => t.name));
  assert.deepEqual((await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'ping' })).result, {});
  assert.equal((await mcp.handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' })).error.code, -32601);
});

test('no tool can delete server files or skip the backup', () => {
  const props = TOOLS.flatMap(t => Object.keys(t.inputSchema.properties || {}));
  for (const banned of ['mirror', 'backup:false', 'noBackup', 'delete', 'prune', 'keep']) assert.ok(!props.includes(banned), banned);
  assert.ok(!TOOLS.some(t => /prune/.test(t.name)));
});

test('list_sites never shows a password', async () => {
  const { call } = await setup();
  const r = await call('list_sites', {});
  assert.deepEqual(r.json.sites.map(s => s.name), ['mysite']);
  assert.ok(!/password/i.test(r.text));
});

test('preview_deploy → deploy → preview_restore → restore, the whole loop', async () => {
  const { call, remote } = await setup();
  const p = await call('preview_deploy', { site: 'mysite' });
  assert.deepEqual(p.json.upload, ['+ about.html', '~ index.html']);
  assert.equal(p.json.onlyOnServer, 1);
  assert.equal((await remote.readFile(ROOT + '/index.html')).toString(), 'OLD', 'preview changed nothing');

  const d = await call('deploy', { site: 'mysite', planId: p.json.planId });
  assert.equal(d.isError, false, d.text);
  assert.deepEqual(d.json.uploaded, ['about.html', 'index.html']);
  assert.match(d.json.undo, /preview_restore with backup "_backup-2026-10-18-14\d\d"/);
  assert.equal((await remote.readFile(ROOT + '/index.html')).toString(), 'NEW');
  assert.equal((await remote.readFile(ROOT + '/uploads-only-on-server.jpg')).toString(), 'JPG', 'server-only files are never deleted');

  const b = await call('list_backups', { site: 'mysite' });
  assert.equal(b.json.backups[0].name, d.json.backup);

  const pr = await call('preview_restore', { site: 'mysite' });
  assert.equal(pr.json.backup, d.json.backup);
  assert.deepEqual(pr.json.putBack, ['index.html']);
  assert.deepEqual(pr.json.remove, ['about.html']);
  const r = await call('restore', { site: 'mysite', backup: pr.json.backup, planId: pr.json.planId });
  assert.equal(r.isError, false, r.text);
  assert.equal((await remote.readFile(ROOT + '/index.html')).toString(), 'OLD');
  assert.equal(await remote.stat(ROOT + '/about.html'), null);
  assert.match(r.json.undo, /preview_restore with backup "_backup-/);

  const h = await call('history', { site: 'mysite' });
  assert.deepEqual(h.json.history.map(x => [x.action, x.trigger]), [['restore', 'mcp'], ['deploy', 'mcp']]);
});

test('deploy refuses a stale or made-up planId and uploads nothing', async () => {
  const { call, remote, local } = await setup();
  const p = await call('preview_deploy', { site: 'mysite' });
  await fs.writeFile(path.join(local, 'index.html'), 'NEW BUT EDITED AFTER THE PREVIEW');
  const d = await call('deploy', { site: 'mysite', planId: p.json.planId });
  assert.equal(d.isError, true);
  assert.match(d.text, /plan changed since preview_deploy/);
  assert.equal((await remote.readFile(ROOT + '/index.html')).toString(), 'OLD');
  assert.equal((await call('deploy', { site: 'mysite', planId: 'deadbeef' })).isError, true);
  assert.equal((await call('deploy', { site: 'mysite' })).isError, true, 'planId is required');
});

test('restore refuses a live edit made after the deploy, unless force', async () => {
  const { call, remote } = await setup();
  const p = await call('preview_deploy', { site: 'mysite' });
  const d = await call('deploy', { site: 'mysite', planId: p.json.planId });
  await remote.writeFile(ROOT + '/index.html', Buffer.from('HOTFIX IN CPANEL'));
  const pr = await call('preview_restore', { site: 'mysite', backup: d.json.backup });
  assert.deepEqual(pr.json.conflicts, [{ path: 'index.html', why: 'edited on the server after that run' }]);
  const r = await call('restore', { site: 'mysite', backup: d.json.backup, planId: pr.json.planId });
  assert.equal(r.isError, true);
  assert.match(r.text, /Refused: 1 live file/);
  assert.equal((await remote.readFile(ROOT + '/index.html')).toString(), 'HOTFIX IN CPANEL');
  const f = await call('restore', { site: 'mysite', backup: d.json.backup, planId: pr.json.planId, force: true });
  assert.equal(f.isError, false, f.text);
  assert.equal((await remote.readFile(ROOT + '/index.html')).toString(), 'OLD');
});

test('restore refuses when the live site changed after preview_restore', async () => {
  const { call, remote } = await setup();
  const p = await call('preview_deploy', { site: 'mysite' });
  const d = await call('deploy', { site: 'mysite', planId: p.json.planId });
  const pr = await call('preview_restore', { site: 'mysite', backup: d.json.backup });
  await remote.writeFile(ROOT + '/about.html', Buffer.from('changed in between'));
  const r = await call('restore', { site: 'mysite', backup: d.json.backup, planId: pr.json.planId });
  assert.equal(r.isError, true);
  assert.match(r.text, /restore plan changed since preview_restore/);
});

test('check_server_changes spots live edits, and pull brings them down with a local backup', async () => {
  const { call, remote, local } = await setup();
  const c = await call('check_server_changes', { site: 'mysite' });
  assert.equal(c.json.serverAhead, true);
  assert.deepEqual(c.json.differentOnServer, ['index.html']);
  assert.deepEqual(c.json.onlyOnServer, ['uploads-only-on-server.jpg']);
  const pl = await call('pull', { site: 'mysite' });
  assert.deepEqual(pl.json.downloaded, ['index.html', 'uploads-only-on-server.jpg']);
  assert.equal(await fs.readFile(path.join(local, 'index.html'), 'utf8'), 'OLD');
  assert.equal(await fs.readFile(path.join(pl.json.localBackup, 'index.html'), 'utf8'), 'NEW');
  assert.equal(await fs.readFile(path.join(local, 'about.html'), 'utf8'), 'ABOUT', 'local-only files are never deleted');
  assert.equal((await call('check_server_changes', { site: 'mysite' })).json.serverAhead, false);
  void remote;
});

test('clear errors: unknown site, missing site, unknown tool, no stored password', async () => {
  const { call, mcp, sitesFile } = await setup();
  assert.match((await call('preview_deploy', { site: 'nope' })).text, /Unknown site "nope". Known: mysite/);
  assert.match((await call('preview_deploy', {})).text, /"site" is required/);
  assert.match((await call('format_disk', {})).text, /Unknown tool/);
  const noPw = createMcp({ sitesFile, credentials: new MemoryStore(), env: {} });
  const r = await noPw.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_backups', arguments: { site: 'mysite' } } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /No stored password for "mysite".*shipback mysite --backups/);
  void mcp;
});

test('stdio: bin/mcp.js speaks newline-delimited JSON-RPC and deploys over real SFTP', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-mcp-srv-'));
  const P = path.join(root, 'home/deploy/public_html');
  await fs.mkdir(P, { recursive: true });
  await fs.writeFile(path.join(P, 'index.html'), 'OLD');
  const srv = await start({ root, username: 'deploy', password: 'secret' });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-mcp-cli-'));
  const local = path.join(dir, 'site');
  await fs.mkdir(local);
  await fs.writeFile(path.join(local, 'index.html'), 'NEW');
  const sitesFile = path.join(dir, 'sites.json');
  await fs.writeFile(sitesFile, JSON.stringify({ sites: [{ name: 'mysite', host: '127.0.0.1', port: srv.port, username: 'deploy', remoteRoot: ROOT, localDir: local }] }));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'mcp.js'), '--sites', sitesFile], { env: { ...process.env, SFTP_PASSWORD: 'secret' } });
  const pending = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending.get(m.id)?.(m); }
  });
  // If the server dies, fail the waiting calls with its stderr instead of waiting forever.
  let stderr = '', exited = null;
  child.stderr.setEncoding('utf8'); child.stderr.on('data', d => { stderr += d; });
  child.on('exit', code => { exited = new Error(`bin/mcp.js exited (${code}): ${stderr}`); for (const r of pending.values()) r(exited); });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (exited) return reject(exited);
    const n = ++id; pending.set(n, m => (m instanceof Error ? reject(m) : resolve(m)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  const tool = async (name, args) => JSON.parse((await rpc('tools/call', { name, arguments: args })).result.content[0].text);
  try {
    assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).result.serverInfo.name, 'shipback-sftp');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const p = await tool('preview_deploy', { site: 'mysite' });
    assert.deepEqual(p.upload, ['~ index.html']);
    const d = await tool('deploy', { site: 'mysite', planId: p.planId });
    assert.deepEqual(d.uploaded, ['index.html']);
    assert.equal(await fs.readFile(path.join(P, 'index.html'), 'utf8'), 'NEW');
  } finally {
    child.stdin.end();
    if (child.exitCode === null) await new Promise(r => child.on('close', r));
    await srv.close();
  }
});
