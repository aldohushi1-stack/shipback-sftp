#!/usr/bin/env node
'use strict';
// MCP server over stdio: shipback-mcp [--sites path/to/sites.json]
// (or set SHIPBACK_SITES). See README → "Use it from an AI agent".
const path = require('node:path');
const { createMcp, serveStdio } = require('../src/mcp');

const i = process.argv.indexOf('--sites');
const sitesFile = i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : undefined;
serveStdio(createMcp({ sitesFile })).then(() => process.exit(0));
