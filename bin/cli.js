#!/usr/bin/env node
'use strict';
// Command-line deploy / pull: node bin/cli.js <site> [--pull] [--local DIR] [--remote DIR] [--dry-run] [--no-backup] [--mirror] [--password PW]
//                            node bin/cli.js <site> --prune NAME[,NAME…] | --keep N  [--force] [--dry-run]   (remove _backup-* folders on the server)
//                            node bin/cli.js <site> --restore [NAME|latest] [--force] [--dry-run]   (undo a deploy from its _backup-* folder)
//                            node bin/cli.js <site> --backups   (list the backups on the server)
//                            node bin/cli.js --history [site]
const path = require('node:path');
const readline = require('node:readline');
const { loadSites } = require('../src/config');
const { createCredentialStore } = require('../src/credentials');
const { SftpRemoteFs } = require('../src/remote-fs');
const { runDeploy } = require('../src/deploy');
const { runPull } = require('../src/pull');
const { runPrune } = require('../src/prune');
const { runRestore, describeBackups } = require('../src/restore');
const { appendHistory, readHistory, recordFromSummary } = require('../src/history');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--pull') out.pull = true;
    else if (a === '--history') out.history = true;
    else if (a === '--json') out.json = true;
    else if (a === '--no-backup') out.backup = false;
    else if (a === '--mirror') out.mirror = true;
    else if (a === '--prune') { out.prune = true; const v = argv[i + 1]; if (v && !v.startsWith('--')) { out.names = v.split(',').map(x => x.trim()).filter(Boolean); i++; } }
    else if (a === '--keep') { out.prune = true; out.keep = Number(argv[++i]); }
    else if (a === '--force') out.force = true;
    else if (a === '--restore') { out.restore = true; const v = argv[i + 1]; if (v && !v.startsWith('--')) { out.name = v; i++; } }
    else if (a === '--backups') out.backups = true;
    else if (a === '--local') out.local = argv[++i];
    else if (a === '--remote') out.remote = argv[++i];
    else if (a === '--password') out.password = argv[++i];
    else if (a === '--sites') out.sites = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else out._.push(a);
  }
  return out;
}

function ask(q, hidden) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) { rl._writeToOutput = s => { if (/\n/.test(s)) rl.output.write('\n'); }; process.stdout.write(q); }
    rl.question(hidden ? '' : q, ans => { rl.close(); resolve(ans); });
  });
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const sitesFile = args.sites || path.join(process.cwd(), 'sites.json');
  const historyFile = path.join(path.dirname(sitesFile), 'deploys.jsonl');
  if (args.history) {
    const rows = await readHistory(historyFile, { site: args._[0], limit: 20 });
    if (args.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (!rows.length) { console.log('No deploys recorded yet.'); return; }
    for (const r of rows) {
      const what = r.action === 'pull' ? `${(r.downloaded || []).length} downloaded` : `${(r.uploaded || []).length} uploaded`;
      console.log(`${new Date(r.at).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}  ${r.ok ? 'ok    ' : 'FAILED'}  ${r.action.padEnd(7)} ${r.site.padEnd(14)} ${what}${r.deleted && r.deleted.length ? `, ${r.deleted.length} deleted` : ''}${r.backupDir ? '  backup: ' + r.backupDir : ''}  [${r.trigger}]${r.error ? '  ' + r.error : ''}`);
    }
    return;
  }
  if (args.help || !args._[0]) {
    console.log('Usage: node bin/cli.js <site> [--pull] [--local DIR] [--remote DIR] [--dry-run] [--no-backup] [--mirror] [--password PW] [--sites sites.json]');
    console.log('       node bin/cli.js <site> --prune NAME[,NAME…] | --keep N [--force] [--dry-run]   remove _backup-* folders (only when every file has a copy elsewhere)');
    console.log('       node bin/cli.js <site> --restore [NAME|latest] [--force] [--dry-run]   undo a deploy (refuses if a live file was edited since, unless --force)');
    console.log('       node bin/cli.js <site> --backups [--json]   list the _backup-* folders and what each holds');
    console.log('       node bin/cli.js --history [site] [--json]');
    process.exit(args.help ? 0 : 1);
  }
  const { sites } = await loadSites(sitesFile);
  const site = sites.find(s => s.name === args._[0]);
  if (!site) { console.error(`Unknown site "${args._[0]}". Known: ${sites.map(s => s.name).join(', ') || '(none)'}`); process.exit(1); }
  const localDir = args.local || site.localDir;
  const remoteRoot = args.remote || site.remoteRoot;
  if (!localDir && !args.prune && !args.restore && !args.backups) { console.error('No local folder: pass --local DIR or set localDir on the site'); process.exit(1); }

  // Open the OS keychain only when a password has to come from it (or be saved to it): a --password or
  // SFTP_PASSWORD run, like CI, never touches the vault.
  const needsStore = !site.privateKeyPath && args.password == null && !process.env.SFTP_PASSWORD;
  const { store, note } = needsStore ? createCredentialStore() : {};
  let password = args.password ?? process.env.SFTP_PASSWORD ?? (site.privateKeyPath ? '' : await store.get(site.name));
  if (password == null) { password = await ask(`Password for ${site.username}@${site.host}: `, true); }

  const opts = { host: site.host, port: site.port, username: site.username };
  if (site.privateKeyPath) opts.privateKey = require('node:fs').readFileSync(site.privateKeyPath); else opts.password = password;
  process.stdout.write(`Connecting to ${site.host}… `);
  let rfs;
  try { rfs = await SftpRemoteFs.connect(opts); } catch (e) { console.error('\n' + e.message); process.exit(2); }
  console.log('ok');
  if (needsStore && (await store.get(site.name)) == null) { await store.set(site.name, password); console.log(note); }

  const fmt = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';
  const action = args.backups ? 'backups' : args.restore ? 'restore' : args.prune ? 'prune' : args.pull ? 'pull' : 'deploy';
  const startedAt = new Date().toISOString();
  const onEvent = ev => {
    if (ev.type === 'plan') {
      const list = ev.plan.upload || ev.plan.download, verb = ev.plan.upload ? 'upload' : 'download';
      console.log(args.pull ? `\n${site.host}:${remoteRoot}  →  ${localDir}` : `\n${localDir}  →  ${site.host}:${remoteRoot}`);
      for (const u of list) console.log(`  ${u.reason === 'new' ? '+' : '~'} ${u.path}  (${fmt(u.size)})`);
      for (const d of ev.plan.delete) console.log(`  - ${d}`);
      console.log(`  ${list.length} to ${verb} (${fmt(ev.plan.uploadBytes || ev.plan.downloadBytes || 0)}), ${ev.plan.skip.length} unchanged, ${ev.plan.extra.length} ${args.pull ? 'only local' : 'only on server'}${ev.plan.delete.length ? `, ${ev.plan.delete.length} to delete` : ''}\n`);
    } else if (ev.type === 'backup') console.log(`  backup  ${ev.path}`);
    else if (ev.type === 'upload' || ev.type === 'download') console.log(`  ${ev.type.padEnd(8)}${ev.path}  ${ev.done}/${ev.total}`);
    else if (ev.type === 'delete') console.log(`  delete  ${ev.path}`);
    else if (ev.type === 'rmdir') console.log(`  rmdir   ${ev.path}`);
    else if (ev.type === 'prune-plan') console.log(`\n${site.host}:${remoteRoot}  backups: ${ev.backups.join(', ') || '(none)'}\n  prune: ${ev.targets.join(', ') || '(none)'}\n  keep:  ${ev.kept.join(', ') || '(none)'}\n`);
    else if (ev.type === 'prune-check') console.log(`  ${ev.name}: ${ev.files} files (${fmt(ev.bytes)}), ${ev.unique} without a copy elsewhere`);
    else if (ev.type === 'refuse') console.log(`  REFUSED ${ev.name}: only copy of ${ev.unique.join(', ')} — add --force to remove anyway`);
    else if (ev.type === 'restore-plan') {
      console.log(`
${site.host}:${remoteRoot}  restore from ${ev.backup}${ev.legacy ? '  (older backup, no .backup.json: puts its files back, removes nothing, cannot check for edits)' : ''}`);
      for (const p of ev.put) console.log(`  < ${p}`);
      for (const p of ev.remove) console.log(`  - ${p}`);
      console.log(`  ${ev.put.length} to put back, ${ev.remove.length} to remove, ${ev.same} already right${ev.conflicts ? `, ${ev.conflicts} CONFLICTS` : ''}
`);
    } else if (ev.type === 'conflict') console.log(`  CONFLICT ${ev.path}: ${ev.why}`);
    else if (ev.type === 'restore') console.log(`  restore ${ev.path}`);
    else if (ev.type === 'error') console.error(`  ERROR   ${ev.message}${ev.undo ? `
          ${ev.undo}` : ''}`);
  };
  const common = { localDir, remoteRoot, remoteFs: rfs, dryRun: !!args.dryRun, backup: args.backup !== false, mirror: !!args.mirror, ignore: site.ignore, onEvent };
  try {
    if (args.backups) {
      const list = await describeBackups({ remoteRoot, remoteFs: rfs });
      if (args.json) console.log(JSON.stringify(list, null, 2));
      else if (!list.length) console.log('No backups on the server.');
      else for (const b of list) console.log(`  ${b.name.padEnd(28)} ${b.legacy ? `${b.files} files (older backup, no record)` : `${b.action.padEnd(8)} ${b.overwritten} overwritten, ${b.added} added, ${b.deleted} deleted${b.from ? '  (undo of ' + b.from + ')' : ''}${b.status === 'saving' ? '  [cut off before changing anything]' : b.status ? '  [cut off part way]' : ''}`}`);
      return;
    }
    if (args.restore) {
      const s = await runRestore({ remoteRoot, remoteFs: rfs, name: args.name, dryRun: !!args.dryRun, force: !!args.force, onEvent });
      if (s.resumed) console.log(`(${s.resumed} is a restore that was cut off, so this finishes it: restoring ${s.backup})`);
      if (s.stoppedEarly) console.log(`${s.backup} was cut off while it was still saving backups, before it changed any live file. Nothing to undo.`);
      else if (s.refused) { console.log(`Refused: ${s.conflicts.length} file(s) changed on the server after that run. Nothing was changed. Check them, then add --force to restore anyway (the live copies are backed up first).`); process.exitCode = 4; }
      else if (s.dryRun) console.log('Dry run — nothing was changed.');
      else console.log(`Done: ${s.put.length} put back, ${s.remove.length} removed${s.undoBackupDir ? `. Undo this with --restore ${s.undoBackupDir.split('/').pop()}` : ''}.`);
      if (!s.dryRun) await appendHistory(historyFile, recordFromSummary({ action, site: site.name, trigger: 'cli', remoteDir: remoteRoot, startedAt, summary: s })).catch(() => {});
      if (args.json) console.log(JSON.stringify(s));
      return;
    }
    const s = args.prune ? await runPrune({ remoteRoot, remoteFs: rfs, names: args.names, keep: args.keep, dryRun: !!args.dryRun, force: !!args.force, onEvent })
      : args.pull ? await runPull(common) : await runDeploy(common);
    if (s.dryRun) console.log('Dry run — nothing was changed.');
    else if (args.prune) {
      console.log(`Done: ${s.pruned.length} backup folder(s) removed (${s.deleted} files, ${fmt(s.bytes)})${s.refused.length ? `, ${s.refused.length} refused` : ''}.`);
      await appendHistory(historyFile, recordFromSummary({ action, site: site.name, trigger: 'cli', remoteDir: remoteRoot, startedAt, summary: s })).catch(() => {});
    } else {
      const moved = args.pull ? s.downloaded : s.uploaded;
      console.log(`Done: ${moved.length} ${args.pull ? 'downloaded' : 'uploaded'} (${fmt(s.bytes)}), ${s.backedUp.length} backed up${s.backupDir ? ' to ' + s.backupDir : ''}, ${s.deleted.length} deleted.`);
      await appendHistory(historyFile, recordFromSummary({ action, site: site.name, trigger: 'cli', localDir, remoteDir: remoteRoot, startedAt, summary: s })).catch(() => {});
    }
    if (args.json) console.log(JSON.stringify(s));
  } catch (e) {
    process.exitCode = e.code === 'ELOCKED' ? 5 : 3;
    await appendHistory(historyFile, recordFromSummary({ action, site: site.name, trigger: 'cli', localDir, remoteDir: remoteRoot, startedAt, error: e.message })).catch(() => {});
  }
  finally { await rfs.close(); }
})();
