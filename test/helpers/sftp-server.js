'use strict';
// Minimal SFTP server (ssh2) rooted at a directory on disk — for tests only.
const { Server, utils } = require('ssh2');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { STATUS_CODE, OPEN_MODE } = utils.sftp;

function hostKey() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey;
}

function toAttrs(st) {
  return { mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) };
}

function errCode(e) {
  if (e.code === 'ENOENT') return STATUS_CODE.NO_SUCH_FILE;
  if (e.code === 'EACCES' || e.code === 'EPERM') return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

/** start({ root, username, password }) → { port, close() } */
async function start({ root, username = 'user', password = 'pass' }) {
  const server = new Server({ hostKeys: [hostKey()] }, client => {
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === username && ctx.password === password) ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        session.on('sftp', accept => {
          const sftp = accept();
          const handles = new Map(); // id → { fd } | { dir, entries, sent }
          let nextId = 1;
          const mkHandle = obj => { const id = nextId++; handles.set(id, obj); const b = Buffer.alloc(4); b.writeUInt32BE(id); return b; };
          const getHandle = b => handles.get(b.readUInt32BE(0));
          const abs = p => path.join(root, path.posix.normalize('/' + p));

          sftp.on('REALPATH', (reqid, p) => {
            const norm = path.posix.normalize('/' + p);
            sftp.name(reqid, [{ filename: norm, longname: norm, attrs: {} }]);
          });
          sftp.on('STAT', (reqid, p) => fsp.stat(abs(p)).then(st => sftp.attrs(reqid, toAttrs(st)), e => sftp.status(reqid, errCode(e))));
          sftp.on('LSTAT', (reqid, p) => fsp.lstat(abs(p)).then(st => sftp.attrs(reqid, toAttrs(st)), e => sftp.status(reqid, errCode(e))));
          sftp.on('FSTAT', (reqid, h) => { const o = getHandle(h); if (!o || o.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE); fs.fstat(o.fd, (e, st) => e ? sftp.status(reqid, errCode(e)) : sftp.attrs(reqid, toAttrs(st))); });
          sftp.on('OPENDIR', (reqid, p) => fsp.readdir(abs(p), { withFileTypes: true }).then(async ents => {
            const entries = [];
            for (const d of ents) {
              const st = await fsp.stat(path.join(abs(p), d.name)).catch(() => null);
              if (!st) continue;
              entries.push({ filename: d.name, longname: (st.isDirectory() ? 'd' : '-') + 'rw-r--r-- 1 u g ' + st.size + ' Jan 1 00:00 ' + d.name, attrs: toAttrs(st) });
            }
            sftp.handle(reqid, mkHandle({ dir: true, entries, sent: false }));
          }, e => sftp.status(reqid, errCode(e))));
          sftp.on('READDIR', (reqid, h) => {
            const o = getHandle(h);
            if (!o || !o.dir) return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (o.sent) return sftp.status(reqid, STATUS_CODE.EOF);
            o.sent = true; sftp.name(reqid, o.entries);
          });
          sftp.on('OPEN', (reqid, p, flags) => {
            let f = 'r';
            const w = flags & OPEN_MODE.WRITE, c = flags & OPEN_MODE.CREAT, t = flags & OPEN_MODE.TRUNC, a = flags & OPEN_MODE.APPEND;
            if (a) f = 'a'; else if (w && c && t) f = 'w'; else if (w && c) f = 'w'; else if (w) f = 'r+';
            fs.open(abs(p), f, (e, fd) => e ? sftp.status(reqid, errCode(e)) : sftp.handle(reqid, mkHandle({ fd })));
          });
          sftp.on('READ', (reqid, h, offset, length) => {
            const o = getHandle(h); if (!o || o.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
            const buf = Buffer.alloc(length);
            fs.read(o.fd, buf, 0, length, offset, (e, n) => {
              if (e) return sftp.status(reqid, errCode(e));
              if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF);
              sftp.data(reqid, buf.subarray(0, n));
            });
          });
          sftp.on('WRITE', (reqid, h, offset, data) => {
            const o = getHandle(h); if (!o || o.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
            fs.write(o.fd, data, 0, data.length, offset, e => sftp.status(reqid, e ? errCode(e) : STATUS_CODE.OK));
          });
          sftp.on('CLOSE', (reqid, h) => {
            const o = getHandle(h); handles.delete(h.readUInt32BE(0));
            if (o && o.fd !== undefined) fs.close(o.fd, () => sftp.status(reqid, STATUS_CODE.OK));
            else sftp.status(reqid, STATUS_CODE.OK);
          });
          sftp.on('MKDIR', (reqid, p) => fsp.mkdir(abs(p)).then(() => sftp.status(reqid, STATUS_CODE.OK), e => sftp.status(reqid, errCode(e))));
          sftp.on('RMDIR', (reqid, p) => fsp.rmdir(abs(p)).then(() => sftp.status(reqid, STATUS_CODE.OK), e => sftp.status(reqid, errCode(e))));
          sftp.on('REMOVE', (reqid, p) => fsp.unlink(abs(p)).then(() => sftp.status(reqid, STATUS_CODE.OK), e => sftp.status(reqid, errCode(e))));
          sftp.on('RENAME', (reqid, a, b) => fsp.rename(abs(a), abs(b)).then(() => sftp.status(reqid, STATUS_CODE.OK), e => sftp.status(reqid, errCode(e))));
          sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
          sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
        });
      });
    });
    client.on('error', () => {});
  });
  await new Promise((res, rej) => server.listen(0, '127.0.0.1', res).once('error', rej));
  return { port: server.address().port, close: () => new Promise(res => server.close(res)) };
}

module.exports = { start };
