'use strict';
// Password storage. Windows → Credential Manager (Generic Credentials) via @napi-rs/keyring.
// If the OS vault is unavailable, fall back to memory for this session only and say so.
const SERVICE = 'shipback-sftp';

class MemoryStore {
  constructor() { this.map = new Map(); this.kind = 'memory'; }
  async get(account) { return this.map.has(account) ? this.map.get(account) : null; }
  async set(account, password) { this.map.set(account, password); }
  async delete(account) { this.map.delete(account); }
}

class KeyringStore {
  constructor(Entry) { this.Entry = Entry; this.kind = 'keyring'; }
  async get(account) { try { return new this.Entry(SERVICE, account).getPassword() ?? null; } catch { return null; } }
  async set(account, password) { new this.Entry(SERVICE, account).setPassword(password); }
  async delete(account) { try { new this.Entry(SERVICE, account).deletePassword(); } catch { /* not there */ } }
}

/** Pick the best available store. Returns { store, note } */
function createCredentialStore() {
  try {
    const { Entry } = require('@napi-rs/keyring');
    // probe: the vault must be readable, otherwise fall back
    new Entry(SERVICE, '__probe__').getPassword();
    return { store: new KeyringStore(Entry), note: process.platform === 'win32' ? 'Passwords are kept in Windows Credential Manager.' : 'Passwords are kept in the OS keychain.' };
  } catch (e) {
    return { store: new MemoryStore(), note: `OS credential vault unavailable (${e.message.split('\n')[0]}). Passwords are kept in memory for this session only.` };
  }
}

module.exports = { MemoryStore, KeyringStore, createCredentialStore, SERVICE };
