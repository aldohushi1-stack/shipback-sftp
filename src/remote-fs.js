'use strict';
// RemoteFs: the small set of server operations the deploy needs.
//   stat(p) → { size, mtime(ms), isDir } | null
//   listRecursive(dir, { skipDir }) → [{ path (posix, relative to dir), size, mtime(ms) }]  (files only)
//   mkdirp(p) · readFile(p) → Buffer · writeFile(p, Buffer) · uploadFile(localPath, p)
//   rename(a, b) · replace(tmp, dest) · remove(p) · rmdir(p) · close()
//
// Live files are never written in place: the new copy goes to partPath(dest) and replace() swaps it in, so a
// dropped connection leaves the old file whole, never half a file. The part name keeps the extension (a stray
// part of config.php is still run as PHP, not served as source) and listRecursive hides part files.
const posix = require('node:path').posix;
const fs = require('node:fs');
const { Client } = require('ssh2');

const PART_PREFIX = '.shipback-part-';
const LOCK_NAME = '.shipback-lock';
const partPath = p => posix.join(posix.dirname(p), PART_PREFIX + posix.basename(p));
const isPart = rel => posix.basename(rel).startsWith(PART_PREFIX);
const isHidden = rel => isPart(rel) || rel === LOCK_NAME; // Shipback's own working files: never deployed, pulled or listed

// ---------------------------------------------------------------- MemoryRemoteFs (tests)
class MemoryRemoteFs {
  // failOn(p): throw before touching p · tornOn(p): write half of p, then throw (a dropped connection)
  constructor() { this.files = new Map(); this.dirs = new Set(['/']); this.failOn = null; this.tornOn = null; }
  _check(p) { if (this.failOn && this.failOn(p)) throw new Error(`Simulated failure on ${p}`); }
  async stat(p) {
    p = posix.normalize(p);
    if (this.files.has(p)) { const f = this.files.get(p); return { size: f.data.length, mtime: f.mtime, isDir: false }; }
    if (this.dirs.has(p)) return { size: 0, mtime: 0, isDir: true };
    return null;
  }
  async listRecursive(dir, { skipDir } = {}) {
    dir = posix.normalize(dir).replace(/\/$/, '');
    const out = [];
    for (const [p, f] of this.files) {
      if (!p.startsWith(dir + '/')) continue;
      const rel = p.slice(dir.length + 1);
      if (skipDir && rel.split('/').slice(0, -1).some(seg => skipDir(seg))) continue;
      if (isHidden(rel)) continue;
      out.push({ path: rel, size: f.data.length, mtime: f.mtime });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
  async listDir(dir) {
    dir = posix.normalize(dir).replace(/\/$/, '') || '/';
    const prefix = dir === '/' ? '/' : dir + '/';
    const out = new Map();
    for (const d of this.dirs) if (d.startsWith(prefix) && d !== dir && !d.slice(prefix.length).includes('/')) out.set(d.slice(prefix.length), { name: d.slice(prefix.length), type: 'dir', size: 0, mtime: 0 });
    for (const [p, f] of this.files) if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) out.set(p.slice(prefix.length), { name: p.slice(prefix.length), type: 'file', size: f.data.length, mtime: f.mtime });
    return [...out.values()].sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
  }
  async mkdirp(p) {
    p = posix.normalize(p);
    const parts = p.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) { cur += '/' + part; if (this.files.has(cur)) throw new Error(`Not a directory: ${cur}`); this.dirs.add(cur); }
  }
  async readFile(p) {
    p = posix.normalize(p); this._check(p);
    const f = this.files.get(p); if (!f) { const e = new Error(`No such file: ${p}`); e.code = 'ENOENT'; throw e; }
    return Buffer.from(f.data);
  }
  async writeFile(p, data) {
    p = posix.normalize(p); this._check(p);
    if (!this.dirs.has(posix.dirname(p))) { const e = new Error(`No such directory: ${posix.dirname(p)}`); e.code = 'ENOENT'; throw e; }
    if (this.tornOn && this.tornOn(p)) {
      this.files.set(p, { data: Buffer.from(data).subarray(0, Math.floor(data.length / 2)), mtime: Date.now() });
      throw new Error(`Simulated connection drop while writing ${p}`);
    }
    this.files.set(p, { data: Buffer.from(data), mtime: Date.now() });
  }
  async uploadFile(localPath, p) { await this.writeFile(p, await fs.promises.readFile(localPath)); }
  async rename(a, b) { a = posix.normalize(a); b = posix.normalize(b); const f = this.files.get(a); if (!f) throw new Error(`No such file: ${a}`); this.files.delete(a); this.files.set(b, f); }
  async replace(tmp, dest) { this._check(posix.normalize(dest)); await this.rename(tmp, dest); }
  async createExclusive(p, data) { p = posix.normalize(p); if (this.files.has(p) || this.dirs.has(p)) return false; await this.writeFile(p, data); return true; }
  async remove(p) { p = posix.normalize(p); this._check(p); if (!this.files.delete(p)) throw new Error(`No such file: ${p}`); }
  async rmdir(p) { this.dirs.delete(posix.normalize(p)); }
  async close() {}
  dump() { return { dirs: [...this.dirs].sort(), files: [...this.files].map(([p, f]) => [p, f.data.toString('base64')]).sort() }; }
}

// ---------------------------------------------------------------- SftpRemoteFs (ssh2)
// Many shared hosts firewall SSH: a wrong port or an unlisted IP is dropped silently, so ssh2 only says "timed out".
const UNREACHABLE_HINT = 'Check the port (many shared hosts run SFTP on their own port, not 22) and that your host lets your '
  + 'current IP in (some make you allow-list it under SSH Access, and home IPs change).';

class SftpRemoteFs {
  constructor(client, sftp) {
    this.client = client; this.sftp = sftp;
    // ssh2 drops pending SFTP callbacks when the line goes: without this a cut-off upload never settles and the
    // CLI exits 0 with nothing said. Every operation fails with this error instead.
    this.lost = null; this.pending = new Set();
    const fail = why => {
      if (this.lost) return;
      this.lost = new Error(`Lost the connection to the server${why ? ` (${why})` : ''}`);
      for (const reject of this.pending) reject(this.lost);
      this.pending.clear();
    };
    client.on('close', () => fail()); client.on('error', e => fail(e.message));
    if (sftp && sftp.on) sftp.on('close', () => fail());
  }
  _guard(op) {
    if (this.lost) return Promise.reject(this.lost);
    let reject;
    const cut = new Promise((_, r) => { reject = r; this.pending.add(r); });
    return Promise.race([op, cut]).finally(() => this.pending.delete(reject));
  }

  /** connect({ host, port, username, password | privateKey, readyTimeout }) */
  static connect(opts) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const cfg = {
        host: opts.host, port: opts.port || 22, username: opts.username,
        readyTimeout: opts.readyTimeout || 20000, keepaliveInterval: 15000,
      };
      if (opts.privateKey) { cfg.privateKey = opts.privateKey; if (opts.passphrase) cfg.passphrase = opts.passphrase; }
      else cfg.password = opts.password;
      let settled = false;
      client.on('ready', () => {
        client.sftp((err, sftp) => {
          if (settled) return; settled = true;
          if (err) { client.end(); return reject(err); }
          resolve(new SftpRemoteFs(client, sftp));
        });
      });
      client.on('error', err => {
        if (settled) return; settled = true;
        const msg = /authentication/i.test(err.message) ? (opts.privateKey
            ? `Authentication failed for ${opts.username}@${opts.host} — the server rejected the key file. Authorize its public key in cPanel → Security → SSH Access → Manage SSH Keys, or clear "Private key file" in Edit site to log in with the password`
            : `Authentication failed for ${opts.username}@${opts.host} (check username/password)`)
          : /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Timed out/i.test(err.message) ? `Cannot reach ${opts.host}:${cfg.port} — ${err.message}. ${UNREACHABLE_HINT}`
          : err.message;
        reject(new Error(msg));
      });
      client.connect(cfg);
    });
  }

  _p(fn) { return this._guard(new Promise((res, rej) => fn((err, val) => err ? rej(err) : res(val)))); }

  async stat(p) {
    try { const a = await this._p(cb => this.sftp.stat(p, cb)); return { size: a.size, mtime: a.mtime * 1000, isDir: a.isDirectory(), mode: a.mode }; }
    catch (e) { if (e.code === 2 || /No such file/i.test(e.message)) return null; throw e; }
  }
  async listRecursive(dir, { skipDir } = {}) {
    const out = [];
    const walk = async (abs, rel) => {
      const entries = await this._p(cb => this.sftp.readdir(abs, cb));
      for (const e of entries) {
        if (e.filename === '.' || e.filename === '..') continue;
        const r = rel ? rel + '/' + e.filename : e.filename;
        if (e.attrs.isDirectory()) { if (!(skipDir && skipDir(e.filename))) await walk(abs + '/' + e.filename, r); }
        else if (e.attrs.isFile() && !isHidden(r)) out.push({ path: r, size: e.attrs.size, mtime: e.attrs.mtime * 1000 });
      }
    };
    await walk(dir.replace(/\/$/, ''), '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
  async listDir(dir) {
    const entries = await this._p(cb => this.sftp.readdir(dir.replace(/\/$/, '') || '/', cb));
    return entries.filter(e => e.filename !== '.' && e.filename !== '..')
      .map(e => ({ name: e.filename, type: e.attrs.isDirectory() ? 'dir' : e.attrs.isFile() ? 'file' : 'other', size: e.attrs.size, mtime: e.attrs.mtime * 1000 }))
      .sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
  }
  async mkdirp(p) {
    const parts = posix.normalize(p).split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      const st = await this.stat(cur);
      if (st) { if (!st.isDir) throw new Error(`Not a directory on server: ${cur}`); continue; }
      await this._p(cb => this.sftp.mkdir(cur, cb));
    }
  }
  readFile(p) {
    return this._guard(new Promise((resolve, reject) => {
      const chunks = [];
      this.sftp.createReadStream(p).on('data', c => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
    }));
  }
  writeFile(p, data) {
    return this._guard(new Promise((resolve, reject) => {
      const ws = this.sftp.createWriteStream(p);
      ws.on('error', reject).on('close', resolve);
      ws.end(Buffer.from(data));
    }));
  }
  uploadFile(localPath, p) {
    return this._p(cb => this.sftp.fastPut(localPath, p, { concurrency: 4, chunkSize: 32768 }, cb));
  }
  rename(a, b) { return this._p(cb => this.sftp.rename(a, b, cb)); }
  /** Create p only if nothing is there yet (O_EXCL): true if created, false if it already exists. */
  async createExclusive(p, data) {
    let handle;
    try { handle = await this._p(cb => this.sftp.open(p, 'wx', cb)); }
    catch (e) { if (await this.stat(p)) return false; throw e; }
    try { const buf = Buffer.from(data); await this._p(cb => this.sftp.write(handle, buf, 0, buf.length, 0, cb)); }
    finally { await this._p(cb => this.sftp.close(handle, cb)).catch(() => {}); }
    return true;
  }
  /** Swap a fully written part file in over dest, keeping dest's permissions (suEXEC hosts 500 on 0666 PHP). */
  async replace(tmp, dest) {
    const st = await this.stat(dest);
    if (st && st.mode !== undefined) await this._p(cb => this.sftp.chmod(tmp, st.mode & 0o7777, cb));
    // OpenSSH (cPanel, Plesk, DirectAdmin, any VPS) has had posix-rename since 2008: one atomic step
    try { return await this._p(cb => this.sftp.ext_openssh_rename(tmp, dest, cb)); }
    catch (e) { if (!/does not support/i.test(e.message)) throw e; }
    if (!st) return this.rename(tmp, dest);
    try { return await this.rename(tmp, dest); } // some servers replace on a plain rename
    catch { await this.remove(dest); return this.rename(tmp, dest); } // restore.js copes if the line drops between these two
  }
  remove(p) { return this._p(cb => this.sftp.unlink(p, cb)); }
  rmdir(p) { return this._p(cb => this.sftp.rmdir(p, cb)); }
  async close() { try { this.client.end(); } catch { /* ignore */ } }
}

/** Write a live file the safe way: to its part file first, then swapped in whole. Give { data } or { localPath }. */
async function writeLive(remoteFs, dest, { data, localPath }) {
  const part = partPath(dest);
  if (localPath !== undefined) await remoteFs.uploadFile(localPath, part);
  else await remoteFs.writeFile(part, data);
  await remoteFs.replace(part, dest);
}

module.exports = { PART_PREFIX, LOCK_NAME, partPath, isPart, isHidden, writeLive, MemoryRemoteFs, SftpRemoteFs };
