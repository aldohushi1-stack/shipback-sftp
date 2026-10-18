'use strict';
// Local HTTP server: serves the UI and a small JSON API on 127.0.0.1 only.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { loadSites, saveSite, deleteSite } = require('./config');
const { createCredentialStore } = require('./credentials');
const { SftpRemoteFs } = require('./remote-fs');
const { previewDeploy, runDeploy, uploadFiles } = require('./deploy');
const { runPull } = require('./pull');
const { runPrune } = require('./prune');
const { runRestore, describeBackups } = require('./restore');
const { appendHistory, readHistory, recordFromSummary } = require('./history');
const { createQueueWatcher } = require('./queue');


const UI_FILE = path.join(__dirname, '..', 'ui', 'index.html');

const DEFAULT_PORT = 4646;

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Body is not valid JSON'); }
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

async function defaultConnect(site, password) {
  const opts = { host: site.host, port: site.port, username: site.username };
  if (site.privateKeyPath) opts.privateKey = await fs.readFile(site.privateKeyPath);
  else opts.password = password;
  return SftpRemoteFs.connect(opts);
}

/** createApp({ sitesFile, credentials, connect, now }) → { listen(port), close(), port } */
async function createApp(opts = {}) {
  const sitesFile = opts.sitesFile || path.join(process.cwd(), 'sites.json');
  let credNote = '';
  let credentials = opts.credentials;
  if (!credentials) { const c = createCredentialStore(); credentials = c.store; credNote = c.note; }
  const now = opts.now || (() => new Date());
  const historyFile = opts.historyFile || path.join(path.dirname(sitesFile), 'deploys.jsonl');
  const queueDir = opts.queueDir || path.join(path.dirname(sitesFile), 'queue');
  const jobs = new Map();
  const record = rec => appendHistory(historyFile, recordFromSummary(rec)).catch(e => console.error('history:', e.message));

  function newJob(kind) {
    const id = crypto.randomBytes(8).toString('hex');
    const job = { id, kind, events: [], listeners: new Set(), done: false, startedAt: Date.now() };
    jobs.set(id, job);
    return job;
  }
  function emit(job, ev) {
    ev.t = Date.now();
    job.events.push(ev);
    for (const l of job.listeners) l(ev);
    if (ev.type === 'done' || ev.type === 'error') job.done = true;
  }
  // Runs a UI job, holding back its last event ('done' / 'error') until the history line is written:
  // the UI reloads history on 'done', so the run has to be on file by then.
  function track(job, run, rec) {
    let last = null;
    const onEvent = ev => { if (ev.type === 'done' || ev.type === 'error') last = ev; else emit(job, ev); };
    return run(onEvent)
      .then(summary => rec(summary), err => rec(last && last.summary, err))
      .finally(() => { if (last) emit(job, last); });
  }

  async function getSite(name) {
    const { sites } = await loadSites(sitesFile);
    const s = sites.find(x => x.name === name);
    if (!s) throw new HttpError(404, `Unknown site "${name}"`);
    return s;
  }
  async function connectSite(site, password) {
    const pw = password ?? (site.privateKeyPath ? '' : await credentials.get(site.name));
    if (pw == null) throw new HttpError(401, 'Password needed', { needPassword: true });
    try { return await (opts.connect ? opts.connect({ site, password: pw }) : defaultConnect(site, pw)); }
    catch (e) { throw new HttpError(401, e.message, { needPassword: !site.privateKeyPath && /auth/i.test(e.message) }); } // a key site ignores any typed password
  }

  const routes = {
    'GET /api/status': async () => ({ ok: true, credentials: credNote, cwd: process.cwd(), platform: process.platform, home: os.homedir(), queueDir, historyFile }),
    'GET /api/sites': async () => loadSites(sitesFile),
    'POST /api/sites': async ({ body }) => { try { return { site: await saveSite(sitesFile, body) }; } catch (e) { throw new HttpError(400, e.message); } },
    'DELETE /api/sites': async ({ body }) => { await deleteSite(sitesFile, body.name); await credentials.delete(body.name); return { ok: true }; },
    'POST /api/forget': async ({ body }) => { await credentials.delete(body.site); return { ok: true }; },

    'POST /api/connect': async ({ body }) => {
      const site = await getSite(body.site);
      const rfs = await connectSite(site, body.password);
      try {
        if (body.password != null && !site.privateKeyPath) await credentials.set(site.name, body.password);
        const st = await rfs.stat(site.remoteRoot);
        const listing = st && st.isDir ? await rfs.listDir(site.remoteRoot) : [];
        return { ok: true, remoteRootExists: !!st, topLevel: listing.length, stored: !site.privateKeyPath };
      } finally { await rfs.close(); }
    },

    'GET /api/remote': async ({ query }) => {
      const site = await getSite(query.get('site'));
      const dir = (query.get('dir') || site.remoteRoot).replace(/\/$/, '') || '/';
      const rfs = await connectSite(site);
      try {
        const entries = await rfs.listDir(dir);
        return { dir, entries };
      } finally { await rfs.close(); }
    },

    'POST /api/preview': async ({ body }) => {
      const site = await getSite(body.site);
      const rfs = await connectSite(site);
      try {
        const r = await previewDeploy({ localDir: body.localDir || site.localDir, remoteRoot: body.remoteDir || site.remoteRoot, remoteFs: rfs, mirror: !!body.mirror, ignore: site.ignore });
        return { plan: r.plan, remoteExists: r.remoteExists, localCount: r.local.length };
      } catch (e) { throw new HttpError(400, e.message); } finally { await rfs.close(); }
    },

    'POST /api/deploy': async ({ body }) => {
      const site = await getSite(body.site);
      const rfs = await connectSite(site);
      const job = newJob('deploy');
      const args = { localDir: body.localDir || site.localDir, remoteRoot: body.remoteDir || site.remoteRoot };
      const startedAt = new Date().toISOString();
      track(job, onEvent => runDeploy({ ...args, remoteFs: rfs, dryRun: !!body.dryRun, backup: body.backup !== false, mirror: !!body.mirror, ignore: site.ignore, now: now(), onEvent }),
        (summary, err) => err ? record({ action: 'deploy', site: site.name, trigger: 'ui', localDir: args.localDir, remoteDir: args.remoteRoot, startedAt, summary, error: err.message })
          : !summary.dryRun && record({ action: 'deploy', site: site.name, trigger: 'ui', localDir: args.localDir, remoteDir: args.remoteRoot, startedAt, summary }))
        .finally(() => rfs.close());
      return { jobId: job.id };
    },

    'POST /api/pull': async ({ body }) => {
      const site = await getSite(body.site);
      const rfs = await connectSite(site);
      const job = newJob('pull');
      const args = { localDir: body.localDir || site.localDir, remoteRoot: body.remoteDir || site.remoteRoot };
      if (!args.localDir) throw new HttpError(400, 'No local folder given');
      const startedAt = new Date().toISOString();
      track(job, onEvent => runPull({ ...args, remoteFs: rfs, dryRun: !!body.dryRun, backup: body.backup !== false, mirror: !!body.mirror, ignore: site.ignore, now: now(), onEvent }),
        (summary, err) => err ? record({ action: 'pull', site: site.name, trigger: 'ui', localDir: args.localDir, remoteDir: args.remoteRoot, startedAt, error: err.message })
          : !summary.dryRun && record({ action: 'pull', site: site.name, trigger: 'ui', localDir: args.localDir, remoteDir: args.remoteRoot, startedAt, summary }))
        .finally(() => rfs.close());
      return { jobId: job.id };
    },

    'GET /api/history': async ({ query }) => ({ history: await readHistory(historyFile, { site: query.get('site') || undefined, limit: Number(query.get('limit')) || 30 }), file: historyFile }),

    'POST /api/upload': async ({ req }) => {
      const form = await new Response(Readable.toWeb(req), { headers: { 'content-type': req.headers['content-type'] || '' } }).formData().catch(() => { throw new HttpError(400, 'Bad multipart body'); });
      const site = await getSite(String(form.get('site') || ''));
      const remoteDir = String(form.get('remoteDir') || site.remoteRoot);
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shipback-up-'));
      const files = [];
      for (const f of form.getAll('files')) {
        if (typeof f === 'string' || !f.name) continue;
        const name = path.posix.basename(f.name.replace(/\\/g, '/'));
        const localPath = path.join(tmp, name);
        await fs.writeFile(localPath, Buffer.from(await f.arrayBuffer()));
        files.push({ name, localPath, size: f.size });
      }
      if (!files.length) throw new HttpError(400, 'No files in upload');
      const rfs = await connectSite(site);
      const job = newJob('upload');
      const startedAt = new Date().toISOString();
      track(job, onEvent => uploadFiles({ files, remoteDir, remoteFs: rfs, backup: form.get('backup') !== 'false', now: now(), onEvent }),
        (summary, err) => record({ action: 'upload', site: site.name, trigger: 'ui', remoteDir, startedAt, ...(err ? { error: err.message } : { summary }) }))
        .finally(async () => { await rfs.close(); await fs.rm(tmp, { recursive: true, force: true }); });
      return { jobId: job.id, files: files.map(f => f.name) };
    },

    'GET /api/browse': async ({ query }) => {
      const dir = query.get('dir') || os.homedir();
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { throw new HttpError(400, `Cannot open ${dir}: ${e.message}`); }
      const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map(e => e.name).sort((a, b) => a.localeCompare(b));
      const files = entries.filter(e => e.isFile()).length;
      return { dir: path.resolve(dir), parent: path.dirname(path.resolve(dir)), dirs, files };
    },
  };

  const server = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host || '').split(':')[0];
      if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) throw new HttpError(403, 'Local access only');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, await fs.readFile(UI_FILE, 'utf8'));
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const m = url.pathname.match(/^\/api\/events\/([a-f0-9]+)$/);
      if (m && req.method === 'GET') {
        const job = jobs.get(m[1]);
        if (!job) throw new HttpError(404, 'Unknown job');
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        const write = ev => res.write('data: ' + JSON.stringify(ev) + '\n\n');
        for (const ev of job.events) write(ev);
        if (job.done) return res.end();
        const l = ev => { write(ev); if (ev.type === 'done' || ev.type === 'error') { job.listeners.delete(l); res.end(); } };
        job.listeners.add(l);
        req.on('close', () => job.listeners.delete(l));
        return;
      }
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw new HttpError(404, 'Not found');
      const body = (req.method === 'POST' || req.method === 'DELETE') && url.pathname !== '/api/upload' ? await readJson(req) : {};
      const out = await handler({ req, body, query: url.searchParams });
      send(res, 200, out);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      send(res, status, { error: e.message, ...(e.extra || {}) });
    }
  });

  // Drop-box queue: queue/<name>.request.json → run → queue/<name>.result.json
  const queue = createQueueWatcher({
    queueDir, pollMs: opts.queuePollMs || 1500, log: opts.log || console.log,
    runJob: async ({ request, onEvent }) => {
      const site = await getSite(request.site);
      const localDir = request.localDir || site.localDir, remoteRoot = request.remoteDir || site.remoteRoot;
      const rfs = await connectSite(site);
      const startedAt = new Date().toISOString();
      const common = { site: site.name, trigger: 'queue', localDir, remoteDir: remoteRoot, startedAt };
      try {
        let summary;
        if (request.action === 'preview') { const r = await previewDeploy({ localDir, remoteRoot, remoteFs: rfs, mirror: !!request.mirror, ignore: site.ignore, onEvent }); summary = { dryRun: true, plan: r.plan, remoteExists: r.remoteExists, localCount: r.local.length }; }
        else if (request.action === 'backups') return { backups: await describeBackups({ remoteRoot, remoteFs: rfs }) };
        else if (request.action === 'restore') summary = await runRestore({ remoteRoot, remoteFs: rfs, name: request.name, dryRun: !!request.dryRun, force: !!request.force, now: now(), onEvent });
        else if (request.action === 'prune') summary = await runPrune({ remoteRoot, remoteFs: rfs, names: request.names, keep: request.keep, dryRun: !!request.dryRun, force: !!request.force, onEvent });
        else if (request.action === 'pull') summary = await runPull({ localDir, remoteRoot, remoteFs: rfs, dryRun: !!request.dryRun, backup: request.backup !== false, mirror: !!request.mirror, ignore: site.ignore, now: now(), onEvent });
        else summary = await runDeploy({ localDir, remoteRoot, remoteFs: rfs, dryRun: !!request.dryRun, backup: request.backup !== false, mirror: !!request.mirror, ignore: site.ignore, now: now(), onEvent });
        if (!summary.dryRun) await record({ ...common, action: request.action, summary });
        return summary;
      } catch (e) { await record({ ...common, action: request.action, error: e.message }); throw e; }
      finally { await rfs.close(); }
    },
  });

  return {
    server, credNote, queueDir, historyFile,
    get port() { return server.address() && server.address().port; },
    listen: async port => { await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', resolve).once('error', reject)); await queue.start(); },
    close: async () => { await queue.stop(); await new Promise(resolve => server.close(resolve)); },
  };
}

if (require.main === module) {
  (async () => {
    const port = Number(process.env.PORT) || DEFAULT_PORT;
    const app = await createApp({ sitesFile: path.join(process.cwd(), 'sites.json') });
    await app.listen(port).catch(e => { console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use — is the app already running? Open http://127.0.0.1:${port}` : e.message); process.exit(1); });
    const url = `http://127.0.0.1:${port}`;
    console.log(`Shipback SFTP running at ${url}`);
    if (app.credNote) console.log(app.credNote);
    console.log(`Drop-box queue: ${app.queueDir}  ·  history: ${app.historyFile}`);
    console.log('Press Ctrl+C to stop.');
    if (!process.env.NO_OPEN) {
      const { exec } = require('node:child_process');
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd, () => {});
    }
  })();
}

module.exports = { createApp, DEFAULT_PORT };
