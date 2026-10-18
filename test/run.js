'use strict';
// `npm test`: run every test/*.test.js with node:test. Node 18 and 20 don't expand globs passed to
// --test (that arrived in Node 21) and npm doesn't either, so list the files here.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(__dirname, f));
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
