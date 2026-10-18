'use strict';
// sites.json — { sites: [{ name, host, port, username, remoteRoot, localDir, ignore: [] }] }. Never holds passwords.
const fs = require('node:fs/promises');
const path = require('node:path');

const SITE_FIELDS = ['name', 'host', 'port', 'username', 'remoteRoot', 'localDir', 'ignore', 'privateKeyPath'];

function normaliseSite(s) {
  const out = {};
  for (const k of SITE_FIELDS) if (s[k] !== undefined && s[k] !== '') out[k] = s[k];
  out.port = Number(out.port) || 22;
  out.ignore = Array.isArray(out.ignore) ? out.ignore : [];
  for (const k of ['name', 'host', 'username', 'remoteRoot']) if (!out[k] || typeof out[k] !== 'string') throw new Error(`Site is missing "${k}"`);
  if (!/^[\w.-]+$/.test(out.name)) throw new Error('Site name may only use letters, numbers, dots, dashes and underscores');
  out.remoteRoot = out.remoteRoot.replace(/\\/g, '/').replace(/\/$/, '') || '/';
  return out;
}

async function loadSites(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return { sites: (data.sites || []).map(normaliseSite) };
  } catch (e) {
    if (e.code === 'ENOENT') return { sites: [] };
    throw new Error(`Could not read ${path.basename(file)}: ${e.message}`);
  }
}

async function saveSite(file, site) {
  const clean = normaliseSite(site);
  const cfg = await loadSites(file);
  const i = cfg.sites.findIndex(s => s.name === clean.name);
  if (i >= 0) cfg.sites[i] = clean; else cfg.sites.push(clean);
  await fs.writeFile(file, JSON.stringify(cfg, null, 2) + '\n');
  return clean;
}

async function deleteSite(file, name) {
  const cfg = await loadSites(file);
  cfg.sites = cfg.sites.filter(s => s.name !== name);
  await fs.writeFile(file, JSON.stringify(cfg, null, 2) + '\n');
}

module.exports = { loadSites, saveSite, deleteSite, normaliseSite };
