'use strict';
// When the host can't be reached, the error has to say what to fix, not just "timed out".
// On shared hosting that's nearly always the SFTP port (often not 22) or an IP the host doesn't
// let in (SSH Access allow-lists, home IPs change) — the firewall drops the packets silently,
// so ssh2 only ever reports "Timed out while waiting for handshake".
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { SftpRemoteFs } = require('../src/remote-fs');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const HINT = /Cannot reach 127\.0\.0\.1:\d+ — .*Check the port.*current IP/is;

test('a silent host (no SSH banner) times out with the port / whitelist hint', async () => {
  const sockets = new Set();
  const server = net.createServer(s => sockets.add(s)); // accepts, never speaks — like a dropped handshake
  const port = await listen(server);
  try {
    await assert.rejects(
      SftpRemoteFs.connect({ host: '127.0.0.1', port, username: 'deploy', password: 'x', readyTimeout: 400 }),
      err => { assert.match(err.message, /Timed out/i); assert.match(err.message, HINT); return true; });
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise(r => server.close(r));
  }
});

test('a closed port is refused with the same hint', async () => {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise(r => server.close(r)); // nothing listening there now
  await assert.rejects(
    SftpRemoteFs.connect({ host: '127.0.0.1', port, username: 'deploy', password: 'x', readyTimeout: 2000 }),
    err => { assert.match(err.message, HINT); return true; });
});

test('a rejected key says the key was rejected, not "check username/password"', async () => {
  const fs = require('node:fs/promises'); const os = require('node:os'); const path = require('node:path');
  const { utils } = require('ssh2');
  const { start } = require('./helpers/sftp-server');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-key-'));
  const srv = await start({ root, username: 'deploy', password: 'secret' }); // password-only server
  try {
    const { private: privateKey } = utils.generateKeyPairSync('ed25519');
    await assert.rejects(
      SftpRemoteFs.connect({ host: '127.0.0.1', port: srv.port, username: 'deploy', privateKey, readyTimeout: 5000 }),
      err => {
        assert.match(err.message, /Authentication failed/);
        assert.match(err.message, /key/i);
        assert.match(err.message, /Manage SSH Keys/);
        assert.doesNotMatch(err.message, /check username\/password/);
        return true;
      });
  } finally { await srv.close(); }
});
