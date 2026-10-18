#!/usr/bin/env node
'use strict';
// Claude Code PreToolUse hook: stops Claude deploying with --mirror (deletes server files that
// only live there: uploads, form data, .well-known) or --no-backup (overwrites with no copy),
// whether by CLI flag, queue request file, or the local server's API.
// Register it in ~/.claude/settings.json (see README). Exit 2 = blocked; stderr goes back to Claude.
// Hooks only gate Claude's tool calls: you can still run either flag yourself in a terminal.

// The flag inside the same simple command as the CLI (so `grep -- --mirror bin/cli.js` passes).
const CLI_FLAG = /(?:cli\.js|npm\s+(?:run\s+)?deploy|\b(?:sftp-deploy|shipback)(?:\.cmd)?\s)[^\n;&|]*?\s--(mirror|no-backup)(?=$|[\s'";&|)])/i;
const MIRROR_ON = /\bmirror["'\\]*\s*:\s*true\b/i;
const BACKUP_OFF = /\bbackup["'\\]*\s*:\s*false\b/i;
const QUEUE_OR_API = /\.request\.json|localhost|127\.0\.0\.1/i;
const REQUEST_FILE = /\.request\.json$/i;

function reason(what) {
  return `shipback guard: ${what} is blocked for Claude. --mirror / "mirror": true deletes server files ` +
    `that aren't in the local folder; --no-backup / "backup": false overwrites with no copy. Deploy without it. ` +
    `If the user explicitly wants this, they run the command themselves in a terminal.`;
}

function jsonOption(text) {
  if (MIRROR_ON.test(text)) return '"mirror": true';
  if (BACKUP_OFF.test(text)) return '"backup": false';
  return null;
}

// Returns the block reason, or null to let the call through.
function check(input) {
  const tool = input && input.tool_name;
  const ti = (input && input.tool_input) || {};
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(ti.command || '');
    const flag = cmd.match(CLI_FLAG);
    if (flag) return reason(`--${flag[1]}`);
    const opt = QUEUE_OR_API.test(cmd) && jsonOption(cmd);
    return opt ? reason(opt) : null;
  }
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') {
    if (!REQUEST_FILE.test(String(ti.file_path || ''))) return null;
    const text = [ti.content, ti.new_string, ...(ti.edits || []).map(e => e && e.new_string)].filter(Boolean).join('\n');
    const opt = jsonOption(text);
    return opt ? reason(opt) : null;
  }
  return null;
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { raw += d; });
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(raw); } catch { process.exit(0); }
    const why = check(input);
    if (why) { process.stderr.write(why + '\n'); process.exit(2); }
    process.exit(0);
  });
}

module.exports = { check };
