'use strict';
// One run at a time per site. Deploy, upload, restore and prune hold <root>/.shipback-lock while they write: two
// at once would interleave their backups, and an undo could then pick up half of each. A second run is refused
// and told who holds the lock.
//
// A run that is cut off can't take its lock away, so a lock counts as stale (and is taken over) when:
//   · it was taken on this computer by a process that has ended, or by this process for a run that is over, or
//   · nobody has refreshed it for STALE_MS (the holder rewrites it every HEARTBEAT_MS while it runs)
//
// withLock({ remoteFs, root, action, createRoot, onEvent }, fn) → fn's result, the lock held throughout.
// Only a deploy or upload creates a missing root; a restore or prune there has nothing to protect and fails by itself.
const crypto = require('node:crypto');
const os = require('node:os');
const { LOCK_NAME } = require('./remote-fs');

const HEARTBEAT_MS = 30000;
const STALE_MS = 120000;
const held = new Set(); // tokens this process holds right now

// the lock sits in the web root, so it carries a hash of the computer's name, not the name
const machine = () => crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 12);

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function readLock(remoteFs, file) {
  try { return JSON.parse((await remoteFs.readFile(file)).toString('utf8')); } catch { return null; }
}

/** Why a lock can be taken over, or null if its run may still be going. */
function staleReason(lock, mtime, now) {
  if (lock && lock.machine === machine() && Number.isInteger(lock.pid)) {
    if (lock.pid === process.pid ? !held.has(lock.token) : !pidAlive(lock.pid)) return 'its run on this computer has ended';
  }
  if (now - mtime > STALE_MS) return `nothing has refreshed it for ${Math.round((now - mtime) / 60000)} min`;
  return null;
}

class LockedError extends Error {
  constructor(lock) {
    const who = lock && lock.machine === machine() ? 'on this computer' : 'from another computer';
    super(`Another ${lock && lock.action || 'run'} is writing to this site right now (started ${lock && lock.at || 'just now'}, ${who}). `
      + 'Nothing was changed. Try again when it finishes. A lock left by a run that was cut off clears itself within 2 minutes.');
    this.code = 'ELOCKED';
  }
}

async function acquire({ remoteFs, root, action, now = Date.now, onEvent = () => {} }) {
  const file = `${root}/${LOCK_NAME}`;
  const token = crypto.randomBytes(8).toString('hex');
  const body = () => Buffer.from(JSON.stringify({ tool: 'shipback-sftp', action, token, pid: process.pid, machine: machine(), at: new Date(now()).toISOString() }));
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await remoteFs.createExclusive(file, body())) {
      held.add(token);
      let beat = Promise.resolve();
      const timer = setInterval(() => { beat = beat.then(() => remoteFs.writeFile(file, body())).catch(() => {}); }, HEARTBEAT_MS);
      if (timer.unref) timer.unref();
      return async () => {
        clearInterval(timer);
        held.delete(token);
        await beat;
        const cur = await readLock(remoteFs, file);
        if (cur && cur.token === token) await remoteFs.remove(file).catch(() => {});
      };
    }
    const st = await remoteFs.stat(file);
    if (!st) continue; // released between the two calls
    const lock = await readLock(remoteFs, file);
    const why = staleReason(lock, st.mtime, now());
    if (!why) throw new LockedError(lock);
    onEvent({ type: 'stale-lock', action: lock && lock.action, at: lock && lock.at, why });
    await remoteFs.remove(file).catch(() => {});
  }
  throw new LockedError(await readLock(remoteFs, file));
}

async function withLock({ remoteFs, root, action, createRoot = false, now, onEvent = () => {} }, fn) {
  root = root.replace(/\/$/, '');
  let release = null;
  try {
    const exists = await remoteFs.stat(root);
    if (exists || createRoot) {
      if (!exists) await remoteFs.mkdirp(root);
      release = await acquire({ remoteFs, root, action, now, onEvent });
    }
  } catch (err) { onEvent({ type: 'error', message: err.message, code: err.code }); throw err; }
  try { return await fn(); }
  finally { if (release) await release().catch(() => {}); } // a dropped connection can't release: the lock then goes stale
}

module.exports = { withLock, LockedError, STALE_MS, HEARTBEAT_MS };
