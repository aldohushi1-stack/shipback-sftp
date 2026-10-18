'use strict';
// Drop-box queue: another process (an AI agent with no shell, a script, you) writes
//   queue/<name>.request.json   { action: "deploy"|"pull"|"preview", site, localDir?, remoteDir?, dryRun?, mirror?, backup?, note? }
//                               { action: "prune", site, remoteDir?, names?: ["_backup-…"], keep?: N, dryRun?, force?, note? }
//                               { action: "restore", site, remoteDir?, name?: "_backup-…" | "latest", dryRun?, force?, note? }
//                               { action: "backups", site, remoteDir? }   (list the backups and what each holds)
// while the app is running. The watcher runs it and writes
//   queue/<name>.result.json    { ok, action, site, startedAt, finishedAt, summary | error }
//   queue/<name>.log.txt        the same lines the app's log panel shows
// and renames the request to <name>.request.done.json so it is never run twice.
const fs = require('node:fs/promises');
const path = require('node:path');

const QUEUE_SUFFIX = '.request.json';
const ACTIONS = new Set(['deploy', 'pull', 'preview', 'prune', 'restore', 'backups']);
const SITE_ACTIONS = ACTIONS;


function fmtEvent(ev) {
  const t = new Date().toLocaleTimeString();
  switch (ev.type) {
    case 'scan': return `${t}  scanning ${ev.side}: ${ev.dir}`;
    case 'verify': return `${t}  checking ${ev.path}`;
    case 'plan': { const p = ev.plan; const n = (p.upload || p.download || []).length; return `${t}  plan: ${n} to ${p.upload ? 'upload' : 'download'}, ${p.skip.length} unchanged, ${p.extra.length} extra, ${p.delete.length} to delete`; }
    case 'mkdir': return `${t}  created ${ev.path}`;
    case 'backup': return `${t}  backup ${ev.path} -> ${ev.to}`;
    case 'upload': return `${t}  upload ${ev.path} ${ev.done}/${ev.total}`;
    case 'download': return `${t}  download ${ev.path} ${ev.done}/${ev.total}`;
    case 'delete': return `${t}  delete ${ev.path}`;
    case 'rmdir': return `${t}  rmdir ${ev.path}`;
    case 'prune-plan': return `${t}  backups on server: ${ev.backups.length} — prune ${ev.targets.length} (${ev.targets.join(', ') || 'none'}), keep ${ev.kept.length}`;
    case 'prune-check': return `${t}  ${ev.name}: ${ev.files} files, ${ev.bytes} bytes, ${ev.unique} without a copy elsewhere`;
    case 'refuse': return `${t}  REFUSED ${ev.name}: only copy of ${ev.unique.slice(0, 5).join(', ')}${ev.unique.length > 5 ? ` and ${ev.unique.length - 5} more` : ''} — pass "force": true to remove anyway`;
    case 'restore-plan': return `${t}  restore ${ev.backup}${ev.legacy ? ' (no .backup.json: files only)' : ''}: ${ev.put.length} to put back, ${ev.remove.length} to remove, ${ev.same} already right, ${ev.conflicts} conflicts`;
    case 'restore': return `${t}  put back ${ev.path}`;
    case 'conflict': return `${t}  CONFLICT ${ev.path}: ${ev.why}`;
    case 'manifest': return `${t}  wrote ${ev.path}`;
    case 'done': return `${t}  done`;
    case 'error': return `${t}  ERROR ${ev.message}`;
    default: return `${t}  ${ev.type}`;
  }
}

/**
 * createQueueWatcher({ queueDir, runJob, pollMs, log })
 *   runJob({ request, name, onEvent }) → summary (throws on failure)
 * → { start(), stop(), queueDir }
 */
function createQueueWatcher({ queueDir, runJob, pollMs = 1500, log = console.log }) {
  let timer = null, busy = false, stopped = false;
  const retries = new Map(); // name → consecutive parse failures

  async function scan() {
    if (busy || stopped) return;
    busy = true;
    try {
      let names;
      try { names = (await fs.readdir(queueDir)).filter(n => n.endsWith(QUEUE_SUFFIX)).sort(); } catch { names = []; }
      for (const file of names) {
        if (stopped) break;
        const name = file.slice(0, -QUEUE_SUFFIX.length);
        const reqPath = path.join(queueDir, file);
        let request;
        try { request = JSON.parse(await fs.readFile(reqPath, 'utf8')); }
        catch (e) {
          const n = (retries.get(name) || 0) + 1; retries.set(name, n);
          if (n < 8) continue; // probably still being written — try again next round
          await finish(name, reqPath, { ok: false, error: `request.json is not valid JSON: ${e.message}`, startedAt: new Date().toISOString() }, []);
          retries.delete(name); continue;
        }
        retries.delete(name);
        await runOne(name, reqPath, request);
      }
    } finally { busy = false; }
  }

  async function runOne(name, reqPath, request) {
    const startedAt = new Date().toISOString();
    const lines = [];
    const onEvent = ev => lines.push(fmtEvent(ev));
    log(`[queue] ${name}: ${request.action} ${request.site || ''}`);
    let result;
    if (!ACTIONS.has(request.action)) result = { ok: false, error: `Unknown action "${request.action}" — use deploy, pull, preview, prune, restore or backups` };
    else if (SITE_ACTIONS.has(request.action) && (!request.site || typeof request.site !== 'string')) result = { ok: false, error: 'Request is missing "site"' };
    else {
      try { const summary = await runJob({ request, name, onEvent }); result = { ok: true, summary }; }
      catch (e) { result = { ok: false, error: e.message }; lines.push(`ERROR ${e.message}`); }
    }
    await finish(name, reqPath, { ...result, action: request.action, site: request.site, note: request.note, startedAt }, lines);
    log(`[queue] ${name}: ${result.ok ? 'ok' : 'FAILED — ' + result.error}`);
  }

  async function finish(name, reqPath, result, lines) {
    result.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(queueDir, name + '.log.txt'), lines.join('\n') + '\n');
    await fs.writeFile(path.join(queueDir, name + '.result.json'), JSON.stringify(result, null, 2) + '\n');
    await fs.rename(reqPath, path.join(queueDir, name + '.request.done.json')).catch(() => {});
  }

  return {
    queueDir,
    async start() { await fs.mkdir(queueDir, { recursive: true }); stopped = false; timer = setInterval(scan, pollMs); scan(); },
    async stop() { stopped = true; if (timer) clearInterval(timer); timer = null; while (busy) await new Promise(r => setTimeout(r, 20)); },
  };
}

module.exports = { createQueueWatcher, QUEUE_SUFFIX, ACTIONS, SITE_ACTIONS };
