'use strict';
// MCP server (stdio, JSON-RPC 2.0, one message per line) so an AI agent can deploy, check and undo.
//
// Safety is in what is NOT here: no mirror (deleting server files), no backup switch, no pruning of
// backups. Every deploy is backed up, every deploy can be restored. On top of that:
//   · deploy and restore need the planId from preview_deploy / preview_restore. If anything changed
//     in between (a local edit, someone editing the live site), the ids differ and nothing runs.
//   · restore refuses when a live file was edited after the run being undone, unless force is passed.
//   · passwords never pass through the model: they come from the OS keychain (stored by the CLI or
//     the app the first time) or SFTP_PASSWORD in the server's environment.
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { loadSites } = require('./config');
const { createCredentialStore } = require('./credentials');
const { SftpRemoteFs } = require('./remote-fs');
const { previewDeploy, runDeploy } = require('./deploy');
const { runPull } = require('./pull');
const { runRestore, describeBackups } = require('./restore');
const { appendHistory, readHistory, recordFromSummary } = require('./history');

const VERSION = require('../package.json').version;
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LIST_MAX = 200;

const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const cap = list => list.length > LIST_MAX ? [...list.slice(0, LIST_MAX), `… and ${list.length - LIST_MAX} more`] : list;

const SITE = { site: { type: 'string', description: 'Site name from sites.json (see list_sites)' } };
const LOCAL = { localDir: { type: 'string', description: "Local folder to deploy from / compare with. Defaults to the site's localDir." } };
const TOOLS = [
  { name: 'list_sites', description: 'List the configured sites: name, host, remote root and default local folder. No passwords.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'preview_deploy', description: 'Show what a deploy would upload (new and changed files). Changes nothing. Returns a planId that deploy needs.',
    inputSchema: { type: 'object', properties: { ...SITE, ...LOCAL }, required: ['site'] } },
  { name: 'deploy', description: 'Upload the previewed plan. Every file it overwrites is backed up on the server first, and the whole deploy can be undone with restore. Never deletes server files. Refuses if the plan changed since preview_deploy.',
    inputSchema: { type: 'object', properties: { ...SITE, ...LOCAL, planId: { type: 'string', description: 'planId from preview_deploy' } }, required: ['site', 'planId'] } },
  { name: 'check_server_changes', description: "Before editing a site's local files: list files that are different or only on the server (someone edited the live site). Changes nothing.",
    inputSchema: { type: 'object', properties: { ...SITE, ...LOCAL }, required: ['site'] } },
  { name: 'pull', description: 'Download the server-side changes into the local folder, so local is the truth before editing. Local files it overwrites are backed up in <localDir>/_backup-<stamp>/. Never deletes local files.',
    inputSchema: { type: 'object', properties: { ...SITE, ...LOCAL }, required: ['site'] } },
  { name: 'list_backups', description: 'List the backups on the server, newest first, with what each run overwrote, added and deleted.',
    inputSchema: { type: 'object', properties: { ...SITE }, required: ['site'] } },
  { name: 'preview_restore', description: 'Show what restoring a backup would put back and remove, and any conflicts (live files edited after that run). Changes nothing. Returns a planId that restore needs.',
    inputSchema: { type: 'object', properties: { ...SITE, backup: { type: 'string', description: 'Backup folder name, e.g. _backup-2026-10-18-1400. Default: the newest.' } }, required: ['site'] } },
  { name: 'restore', description: 'Undo a deploy: put the backed-up files back and remove the files that run added. Backs up the current live files first, so the restore can itself be restored. Refuses on conflicts unless force is true; only pass force when the user has seen the conflicts and said to go ahead.',
    inputSchema: { type: 'object', properties: { ...SITE, backup: { type: 'string', description: 'Backup folder name from preview_restore' }, planId: { type: 'string', description: 'planId from preview_restore' }, force: { type: 'boolean', description: 'Restore over files edited on the server since that run (they are backed up first)' } }, required: ['site', 'backup', 'planId'] } },
  { name: 'history', description: 'Recent deploys, pulls and restores from this machine.',
    inputSchema: { type: 'object', properties: { site: { type: 'string' }, limit: { type: 'number' } } } },
];

class ToolError extends Error {}

/** createMcp({ sitesFile, historyFile, credentials, connect, env, now }) → { handle(message) → response | null } */
function createMcp(opts = {}) {
  const sitesFile = opts.sitesFile || process.env.SHIPBACK_SITES || path.join(process.cwd(), 'sites.json');
  const historyFile = opts.historyFile || path.join(path.dirname(sitesFile), 'deploys.jsonl');
  const env = opts.env || process.env;
  const now = opts.now || (() => new Date());
  let credentials = opts.credentials;
  const store = () => credentials || (credentials = createCredentialStore().store);

  async function getSite(name) {
    if (typeof name !== 'string' || !name) throw new ToolError('Say which site: "site" is required (see list_sites)');
    const { sites } = await loadSites(sitesFile);
    const s = sites.find(x => x.name === name);
    if (!s) throw new ToolError(`Unknown site "${name}". Known: ${sites.map(x => x.name).join(', ') || '(none — add one to ' + sitesFile + ')'}`);
    return s;
  }
  async function connect(site) {
    if (opts.connect) return opts.connect(site);
    const o = { host: site.host, port: site.port, username: site.username };
    if (site.privateKeyPath) o.privateKey = await fs.readFile(site.privateKeyPath);
    else {
      o.password = env.SFTP_PASSWORD ?? await store().get(site.name);
      if (o.password == null) throw new ToolError(`No stored password for "${site.name}". Ask the user to run this once in a terminal, which stores it in the OS keychain: shipback ${site.name} --backups (or node bin/cli.js ${site.name} --backups from a clone)`);
    }
    return SftpRemoteFs.connect(o);
  }
  async function withSite(args, fn) {
    const site = await getSite(args.site);
    const rfs = await connect(site);
    try { return await fn(site, rfs); } finally { await rfs.close(); }
  }
  const record = rec => appendHistory(historyFile, recordFromSummary({ trigger: 'mcp', ...rec })).catch(() => {});
  const localOf = (site, args) => {
    const d = args.localDir || site.localDir;
    if (!d) throw new ToolError(`No local folder: pass "localDir" or set localDir for "${site.name}" in sites.json`);
    return d;
  };
  const deployPlanId = (site, localDir, local, plan) => {
    const sha = new Map(local.map(f => [f.path, f.sha256]));
    return hash({ site: site.name, localDir, root: site.remoteRoot, upload: plan.upload.map(u => [u.path, u.reason, sha.get(u.path)]) });
  };
  const restorePlanId = (site, s) => hash({ site: site.name, root: site.remoteRoot, backup: s.backup, put: s.put, remove: s.remove, conflicts: s.conflicts });

  const tools = {
    async list_sites() {
      const { sites } = await loadSites(sitesFile);
      return { sitesFile, sites: sites.map(s => ({ name: s.name, host: s.host, port: s.port, remoteRoot: s.remoteRoot, localDir: s.localDir })) };
    },

    preview_deploy: args => withSite(args, async (site, rfs) => {
      const localDir = localOf(site, args);
      const { local, plan } = await previewDeploy({ localDir, remoteRoot: site.remoteRoot, remoteFs: rfs, ignore: site.ignore });
      return {
        planId: deployPlanId(site, localDir, local, plan), site: site.name, from: localDir, to: `${site.host}:${site.remoteRoot}`,
        upload: cap(plan.upload.map(u => `${u.reason === 'new' ? '+' : '~'} ${u.path}`)), uploadBytes: plan.uploadBytes,
        unchanged: plan.skip.length, onlyOnServer: plan.extra.length,
        note: plan.upload.length ? `Files marked ~ will be backed up on the server before they are replaced. Nothing is deleted. Call deploy with this planId to go ahead.` : 'Nothing to upload.',
      };
    }),

    deploy: args => withSite(args, async (site, rfs) => {
      const localDir = localOf(site, args);
      const { local, plan } = await previewDeploy({ localDir, remoteRoot: site.remoteRoot, remoteFs: rfs, ignore: site.ignore });
      if (deployPlanId(site, localDir, local, plan) !== args.planId) throw new ToolError('The plan changed since preview_deploy (a local file or the server changed). Nothing was uploaded. Call preview_deploy again and check the new plan.');
      if (!plan.upload.length) return { uploaded: [], note: 'Nothing to upload.' };
      const startedAt = new Date().toISOString();
      try {
        const s = await runDeploy({ localDir, remoteRoot: site.remoteRoot, remoteFs: rfs, backup: true, mirror: false, ignore: site.ignore, now: now() });
        await record({ action: 'deploy', site: site.name, localDir, remoteDir: site.remoteRoot, startedAt, summary: s });
        const backup = s.backupDir && s.backupDir.split('/').pop();
        return { uploaded: cap(s.uploaded), bytes: s.bytes, backedUp: cap(s.backedUp), backup, undo: backup ? `To undo this deploy: preview_restore with backup "${backup}", then restore.` : undefined };
      } catch (e) { await record({ action: 'deploy', site: site.name, localDir, remoteDir: site.remoteRoot, startedAt, error: e.message }); throw e; }
    }),

    check_server_changes: args => withSite(args, async (site, rfs) => {
      const localDir = localOf(site, args);
      const s = await runPull({ localDir, remoteRoot: site.remoteRoot, remoteFs: rfs, dryRun: true, ignore: site.ignore });
      const changed = s.plan.download;
      return {
        site: site.name, serverAhead: changed.length > 0,
        differentOnServer: cap(changed.filter(d => d.reason === 'changed').map(d => d.path)),
        onlyOnServer: cap(changed.filter(d => d.reason === 'new').map(d => d.path)),
        onlyLocal: s.plan.extra.length, same: s.plan.skip.length,
        note: changed.length ? 'The server has files the local folder does not match. If those are live edits to keep, call pull before editing.' : 'Local folder matches the server.',
      };
    }),

    pull: args => withSite(args, async (site, rfs) => {
      const localDir = localOf(site, args);
      const startedAt = new Date().toISOString();
      const s = await runPull({ localDir, remoteRoot: site.remoteRoot, remoteFs: rfs, backup: true, mirror: false, ignore: site.ignore, now: now() });
      await record({ action: 'pull', site: site.name, localDir, remoteDir: site.remoteRoot, startedAt, summary: s });
      return { downloaded: cap(s.downloaded), bytes: s.bytes, localBackup: s.backupDir || undefined };
    }),

    list_backups: args => withSite(args, async (site, rfs) => ({ site: site.name, backups: await describeBackups({ remoteRoot: site.remoteRoot, remoteFs: rfs }) })),

    preview_restore: args => withSite(args, async (site, rfs) => {
      const s = await runRestore({ remoteRoot: site.remoteRoot, remoteFs: rfs, name: args.backup, dryRun: true });
      return {
        planId: restorePlanId(site, s), site: site.name, backup: s.backup, undoes: s.action, legacy: s.legacy || undefined,
        putBack: cap(s.put), remove: cap(s.remove), alreadyRight: s.same.length, conflicts: s.conflicts,
        note: s.conflicts.length ? 'Some live files were changed after that run. Show the user the conflicts; restore refuses them unless force is true.'
          : s.put.length || s.remove.length ? 'Call restore with this backup and planId to go ahead. The current live files are backed up first.' : 'The site already matches this backup.',
      };
    }),

    restore: args => withSite(args, async (site, rfs) => {
      if (typeof args.backup !== 'string' || !args.backup) throw new ToolError('Say which backup: "backup" from preview_restore');
      const dry = await runRestore({ remoteRoot: site.remoteRoot, remoteFs: rfs, name: args.backup, dryRun: true });
      if (restorePlanId(site, dry) !== args.planId) throw new ToolError('The restore plan changed since preview_restore (the live site changed). Nothing was restored. Call preview_restore again.');
      const startedAt = new Date().toISOString();
      const s = await runRestore({ remoteRoot: site.remoteRoot, remoteFs: rfs, name: args.backup, force: args.force === true, now: now() });
      await record({ action: 'restore', site: site.name, remoteDir: site.remoteRoot, startedAt, summary: s });
      if (s.refused) throw new ToolError(`Refused: ${s.conflicts.length} live file(s) changed after that run, so nothing was restored: ${s.conflicts.map(c => `${c.path} (${c.why})`).join('; ')}. Only pass force: true if the user says so.`);
      const undo = s.undoBackupDir && s.undoBackupDir.split('/').pop();
      return { putBack: cap(s.put), removed: cap(s.remove), undo: undo ? `To undo this restore: preview_restore with backup "${undo}", then restore.` : undefined };
    }),

    async history(args) {
      return { history: await readHistory(historyFile, { site: args.site || undefined, limit: Math.min(Number(args.limit) || 20, 100) }) };
    },
  };

  async function callTool(name, args) {
    if (!Object.hasOwn(tools, name)) return { content: [{ type: 'text', text: `Unknown tool "${name}"` }], isError: true };
    try {
      const out = await tools[name](args || {});
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: e.message }], isError: true };
    }
  }

  async function handle(msg) {
    const reply = result => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
    const isNotification = msg.id === undefined;
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params && msg.params.protocolVersion;
        return reply({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'shipback-sftp', version: VERSION },
          instructions: 'Deploy to shared hosting over SFTP. preview_deploy then deploy; every deploy is backed up and can be undone with preview_restore then restore. Before editing a site, check_server_changes (and pull if the server is ahead).',
        });
      }
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': return reply(await callTool(msg.params && msg.params.name, msg.params && msg.params.arguments));
      default:
        if (isNotification) return null; // notifications/initialized and friends need no answer
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  }

  return { handle, TOOLS };
}

/** Wire createMcp to stdin/stdout, newline-delimited JSON. Logs go to stderr only. */
function serveStdio(mcp, { input = process.stdin, output = process.stdout } = {}) {
  let buf = '';
  let chain = Promise.resolve();
  input.setEncoding('utf8');
  input.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      chain = chain.then(async () => {
        let msg;
        try { msg = JSON.parse(line); } catch { output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); return; }
        const res = await mcp.handle(msg).catch(e => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: e.message } }));
        if (res) output.write(JSON.stringify(res) + '\n');
      });
    }
  });
  return new Promise(resolve => input.on('end', () => chain.then(resolve)));
}

module.exports = { createMcp, serveStdio, TOOLS };
