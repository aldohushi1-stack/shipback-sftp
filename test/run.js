'use strict';
// `npm test`: run every test/*.test.js with node:test. Node 18 and 20 don't expand globs passed to
// --test (that arrived in Node 21) and npm doesn't either, so list the files here.
// A test that hangs fails after 60 s instead of stalling the run, and on GitHub Actions each failure
// becomes an annotation, so it shows on the run page without signing in to read the log.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(__dirname, f));
const [major, minor] = process.versions.node.split('.').map(Number);
const flags = [];
if (major >= 22 || (major === 21 && minor >= 2) || (major === 20 && minor >= 11) || (major === 18 && minor >= 19)) flags.push('--test-timeout=60000');
if (major >= 22 || (major === 20 && minor >= 14)) flags.push('--test-force-exit'); // a leaked timer or socket can't keep the run open

const gha = !!process.env.GITHUB_ACTIONS;
if (gha) flags.push('--test-reporter=tap');
const esc = s => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const child = spawn(process.execPath, ['--test', ...flags, ...process.argv.slice(2), ...files], { stdio: gha ? ['inherit', 'pipe', 'inherit'] : 'inherit' });

if (gha) {
  // Tee TAP to stdout; turn "not ok" blocks into ::error annotations. Five silent minutes = hung: say where.
  let buf = '', fail = null, tail = [];
  const flush = () => { if (fail) console.log(`::error title=not ok: ${esc(fail.name)}::${esc(fail.lines.join('\n').slice(0, 3000))}`); fail = null; };
  let quiet;
  const arm = () => { clearTimeout(quiet); quiet = setTimeout(() => {
    console.log(`::error title=npm test hung::${esc('No output for 5 minutes. Last lines:\n' + tail.join('\n'))}`);
    child.kill('SIGKILL');
  }, 5 * 60 * 1000); };
  arm();
  child.stdout.on('data', d => {
    process.stdout.write(d); arm();
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      tail.push(line); if (tail.length > 30) tail.shift();
      const m = line.match(/^\s*not ok \d+ - (.*)$/);
      if (m) { flush(); fail = { name: m[1], lines: [] }; continue; }
      if (fail && /^\s*(ok|not ok) \d+ /.test(line)) flush();
      else if (fail) { fail.lines.push(line); if (/^\s*\.\.\.\s*$/.test(line)) flush(); }
    }
  });
  child.on('close', () => { flush(); clearTimeout(quiet); });
}
child.on('close', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
