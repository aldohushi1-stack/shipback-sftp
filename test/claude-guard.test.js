'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { check } = require('../bin/claude-guard');

const bash = (command, cwd = 'C:\\work') => ({ tool_name: 'Bash', tool_input: { command }, cwd });
const write = (file_path, content) => ({ tool_name: 'Write', tool_input: { file_path, content } });
const edit = (file_path, new_string) => ({ tool_name: 'Edit', tool_input: { file_path, old_string: 'x', new_string } });
const Q = 'C:\\work\\shipback-sftp\\queue\\site.request.json';

test('blocks --mirror and --no-backup on the CLI', () => {
  for (const cmd of [
    'node bin/cli.js other-site --mirror',
    'cd /c/work/shipback-sftp && node bin\\cli.js mysite --dry-run --no-backup',
    'timeout 200 node shipback-sftp/bin/cli.js third-site --local "C:\\x" --mirror',
    'npm run deploy -- mysite --mirror',
    'node bin/cli.js other-site --pull --mirror; echo done',
  ]) assert.match(check(bash(cmd)) || '', /shipback guard/, cmd);
  assert.match(check({ tool_name: 'PowerShell', tool_input: { command: 'node bin\\cli.js other-site --no-backup' } }), /--no-backup/);
});

test('lets ordinary deploys and unrelated commands through', () => {
  for (const cmd of [
    'node bin/cli.js other-site --dry-run',
    'node bin/cli.js other-site',
    'node bin/cli.js --history',
    'node bin/cli.js other-site --pull --dry-run',
    'grep -n "\'--mirror\'" bin/cli.js',
    'git push --mirror origin',
    'echo \'{"mirror": true}\' > scene.json',
  ]) assert.equal(check(bash(cmd)), null, cmd);
});

test('blocks mirror/backup:false in queue requests and API calls', () => {
  assert.match(check(write(Q, '{ "action": "deploy", "site": "mysite", "mirror": true }')), /"mirror": true/);
  assert.match(check(write(Q, '{"action":"deploy","site":"x","backup":false}')), /"backup": false/);
  assert.match(check(edit(Q, '"dryRun": false, "mirror": true')), /"mirror": true/);
  assert.match(check(bash(`echo '{"action":"deploy","site":"x","mirror":true}' > shipback-sftp/queue/a.request.json`)), /mirror/);
  assert.match(check(bash(`curl -s -X POST localhost:4317/api/deploy -d "{\\"site\\":\\"x\\",\\"backup\\":false}"`)), /backup/);
});

test('lets normal queue requests and other files through', () => {
  assert.equal(check(write(Q, '{ "action": "deploy", "site": "mysite", "dryRun": true, "mirror": false }')), null);
  assert.equal(check(write(Q, '{ "action": "deploy", "site": "mysite", "backup": true }')), null);
  assert.equal(check(write('C:\\x\\scene.json', '{ "mirror": true }')), null);
  assert.equal(check({ tool_name: 'Read', tool_input: { file_path: Q } }), null);
});

test('as a hook: exit 2 with the reason on stderr, exit 0 otherwise', () => {
  const run = input => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'claude-guard.js')], { input: JSON.stringify(input), encoding: 'utf8' });
  const blocked = run(bash('node bin/cli.js other-site --mirror'));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /shipback guard: --mirror/);
  assert.equal(run(bash('node bin/cli.js other-site --dry-run')).status, 0);
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'claude-guard.js')], { input: 'not json', encoding: 'utf8' }).status, 0);
});
