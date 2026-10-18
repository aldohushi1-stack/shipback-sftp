'use strict';
// deploys.jsonl — one line per deploy / upload / pull, so "what went up and when" is answerable later.
const fs = require('node:fs/promises');

async function appendHistory(file, record) {
  await fs.appendFile(file, JSON.stringify(record) + '\n');
}

async function readHistory(file, { site, limit = 50 } = {}) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (!site || r.site === site) out.push(r); } catch { /* skip corrupt line */ }
  }
  return out.reverse().slice(0, limit);
}

/** Build a compact history record from a run summary (deploy / upload / pull). */
function recordFromSummary({ action, site, trigger = 'ui', localDir, remoteDir, startedAt, summary = {}, error }) {
  const plan = summary.plan || {};
  return {
    at: new Date().toISOString(), startedAt, action, site, trigger, ok: !error, error: error || undefined,
    localDir, remoteDir, dryRun: !!summary.dryRun,
    uploaded: summary.uploaded || undefined, downloaded: summary.downloaded || undefined, deleted: summary.deleted || undefined,
    pruned: summary.pruned ? summary.pruned.map(p => p.name) : undefined, refused: Array.isArray(summary.refused) ? summary.refused.map(r => r.name) : undefined,
    restoredFrom: action === 'restore' ? summary.backup : undefined,
    restored: action === 'restore' ? summary.put : undefined, removed: action === 'restore' ? summary.remove : undefined,
    refusedConflicts: summary.conflicts && summary.refused ? summary.conflicts.length : undefined,
    backedUp: summary.backedUp ? summary.backedUp.length : undefined, backupDir: summary.backupDir || summary.undoBackupDir || undefined,
    bytes: summary.bytes || 0,
    unchanged: plan.skip ? plan.skip.length : undefined, extra: plan.extra ? plan.extra.length : undefined,
  };
}

module.exports = { appendHistory, readHistory, recordFromSummary };
