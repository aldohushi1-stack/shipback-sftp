# Shipback SFTP

[![test](https://github.com/aldohushi1-stack/shipback-sftp/actions/workflows/test.yml/badge.svg)](https://github.com/aldohushi1-stack/shipback-sftp/actions/workflows/test.yml)

**Let the agent deploy. Keep the undo.**

It's late, and the agent says "Deployed ✓". Then the client's contact form is gone. The agent overwrote a
file someone had fixed by hand in cPanel last week, and shared hosting has no `git revert`.

Shipback deploys a folder to any SFTP host: cPanel, Plesk, DirectAdmin, a plain VPS. Every deploy
can be undone with one command. You can run it yourself, script it, or hand it to Claude Code, Cursor or
any MCP client.

**[The undo promise](UNDO-PROMISE.md):** one command puts the site back byte for byte, even after a deploy that
was cut off halfway. It never overwrites a live edit. Each of the thirteen lines in the promise has its own test, and
if undo ever breaks one of them, that's the first bug I fix.

- **Backup before every overwrite.** The server's copy of each file a deploy replaces is saved into
  `_backup-<time>/` on the server, before the upload starts.
- **Never half a file.** Each file goes up beside the live one and is swapped in whole, so a dropped connection
  leaves the old file, not a broken one.
- **One-command undo.** `--restore` puts those files back and removes the files that deploy added.
- **It won't undo over a live edit.** If someone changed a file on the server after the deploy, restore
  stops and names the file. Nothing is touched unless you pass `--force`, and even then the edited copy is
  backed up first.
- **Restores can be undone too.** A restore backs up what it replaces, the same way a deploy does.
- **One run at a time.** A deploy or restore holds a lock on the site while it writes. A second one is turned away
  with nothing changed, so an agent and a person can't deploy over each other.
- **Safe for agents.** The MCP server has no switch to delete server files or skip the backup. A deploy
  only runs the exact plan the agent previewed: if a file changed in between, it refuses.
- **Spots the drift.** `--pull --dry-run` shows what changed on the server since your last deploy, so
  edits made live in cPanel don't get overwritten by accident.

No git or SSH shell is needed on the server, just SFTP. It needs Node 18+. The tests run on Windows, macOS
and Linux with Node 18, 20 and 22 on every push. Passwords are kept in the OS keychain and never
pass through the model.

**It has run in production.** The deploy engine underneath has shipped [aldo.today](https://aldo.today) 235 times
since September 2026 (2,907 files to a cPanel host). Restore and the MCP server are new since 0.1, and the
cut-off handling behind the promise is new in 0.2.

## Quick start

```bash
npm install -g shipback-sftp          # installs the shipback and shipback-mcp commands
cd ~/sites                            # any folder with a sites.json in it (format below)
shipback mysite --dry-run             # see the plan; asks for the password once and stores it
shipback mysite                       # deploy
shipback mysite --restore             # changed your mind? undo it
```

No global install? `npx -p shipback-sftp shipback mysite --dry-run` works the same way. `--sites <file>`
points at a `sites.json` in another folder.

From source: `git clone https://github.com/aldohushi1-stack/shipback-sftp.git`, `npm install`, then
`node bin/cli.js` wherever these docs say `shipback`.

`sites.json`, one entry per site:

```json
{
  "sites": [
    {
      "name": "mysite",
      "host": "server123.example-host.com",
      "port": 22,
      "username": "cpaneluser",
      "remoteRoot": "/home/cpaneluser/public_html",
      "localDir": "/Users/you/sites/mysite",
      "ignore": ["drafts/", "*.psd"]
    }
  ]
}
```

Many shared hosts run SFTP on their own port rather than 22 (check *SSH Access* in your control panel),
and some only accept connections from allow-listed IPs. If a connection times out, check those two
first. Use `"privateKeyPath"` instead of a password if your host has your key.

## Commands

```bash
shipback <site> --dry-run                 # what a deploy would upload
shipback <site>                           # deploy: backup, upload, record
shipback <site> --local <folder>          # deploy a different folder than localDir
shipback <site> --pull --dry-run          # what changed on the server since the last deploy?
shipback <site> --pull                    # bring those changes down (local copies backed up first)
shipback <site> --backups                 # list backups: what each run overwrote, added, deleted
shipback <site> --restore --dry-run       # what an undo of the latest deploy would do
shipback <site> --restore [<backup>]      # undo it (or name an older _backup-… folder)
shipback <site> --prune --keep 10         # tidy old backups; refuses any holding the only copy of a file
shipback --history [site]                 # what went up, when, from where
```

Add `--json` to any command for machine-readable output. A refused restore exits with code 4, and a run turned away
because another one is writing to the site exits with code 5.

`--mirror` (delete server files that aren't in the local folder) and `--no-backup` exist for humans who
know they want them. The agent tools don't offer them, and the [guard hook](#claude-code-guard-hook)
blocks Claude from typing them.

## How the undo works

Each deploy writes `_backup-YYYY-MM-DD-HHMM/` in the remote root. It holds:

- the server's copy of every file the deploy **overwrote** or **deleted**
- `.backup.json`, a record of what the deploy **added**, a SHA-256 of every file it left on the server, and a
  SHA-256 of every copy it saved, so a damaged copy is never put back

The record says `saving` until every copy is made. A deploy cut off before then hasn't changed anything, and
`--restore` says so. New files go up as `.shipback-part-<name>` beside the live file and are renamed over it in one
step, keeping its permissions. Listings hide part files, and the next deploy or restore clears any that are left.

While a deploy, upload, restore or prune writes, it holds `.shipback-lock` in the remote root and refreshes it every
30 seconds. The lock is never deployed, pulled or listed. A lock goes stale, and the next run takes it over, when its
process on this computer has ended or nothing has refreshed it for 2 minutes. So a run that was cut off never leaves
a site locked for long.

`--restore` reads that record and checks each live file first:

| Live file now | Restore does |
| --- | --- |
| exactly what the deploy uploaded | puts the old copy back (or removes it, if the deploy added it) |
| already the old copy | nothing; it counts as already right |
| different from both | **conflict**: stops, names the file, changes nothing (`--force` overrides) |

Before writing anything, restore saves the current live files into a new `_backup-…` folder with its own
record, so `--restore` on that folder takes you forward again. If a restore is cut off, plain `--restore` sees that
the latest run is an unfinished restore and finishes it. It also clears the restored paths from
`.deploy-manifest.json`, so the next deploy compares them by content instead of trusting stale hashes.

Backup folders are skipped by deploys and pulls, and are never deleted except by `--prune`.

## Use it from an AI agent (MCP)

`shipback-mcp` (`bin/mcp.js`) is an MCP server over stdio.

**Claude Code**

```bash
claude mcp add shipback-sftp -- npx -y -p shipback-sftp shipback-mcp --sites /path/to/sites.json
```

**Cursor, Claude Desktop, and others** (`mcp.json` / `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "shipback-sftp": {
      "command": "npx",
      "args": ["-y", "-p", "shipback-sftp", "shipback-mcp", "--sites", "/path/to/sites.json"]
    }
  }
}
```

On Windows, if the client can't start `npx`, use `"command": "cmd"` with `"/c", "npx"` at the front of
`args`. After a global install, `"command": "shipback-mcp"` works too, and from a clone it's `node` with
`bin/mcp.js` as the first arg.

Run any CLI command for a site once first (for example `shipback mysite --backups`). That stores
the password in the OS keychain, where the MCP server reads it. The model never sees it. For CI you can set
`SFTP_PASSWORD` in the server's environment instead.

| Tool | Does |
| --- | --- |
| `list_sites` | the configured sites (no passwords) |
| `preview_deploy` | what would upload; returns a `planId` |
| `deploy` | uploads that plan; refuses if anything changed since the preview |
| `check_server_changes` | files edited or added on the live server since the last deploy |
| `pull` | brings those down into the local folder (local copies backed up) |
| `list_backups` | backups, newest first, with what each run changed |
| `preview_restore` | what an undo would put back and remove, plus any conflicts; returns a `planId` |
| `restore` | runs that undo; refuses on conflicts unless `force` |
| `history` | recent deploys, pulls and restores |

What the tools leave out is deliberate: there is no mirror/delete, no way to skip the backup, and no
pruning of backups.

## Agents without a shell: the drop-box queue

Some agent setups can write files but can't run commands. While the local app is running
(`npm start`, or `start.bat` on Windows), anything that can write a file can queue a job:

```
queue/<name>.request.json   { "action": "deploy", "site": "mysite", "dryRun": true, "note": "new homepage" }
queue/<name>.result.json    ← written when it finishes, with a .log.txt beside it
```

Actions: `deploy`, `preview`, `pull`, `restore`, `backups`, `prune`.

## The local app

`npm start` opens a small UI on `http://127.0.0.1:4646`: add sites, preview, deploy, pull, drag in
one-off uploads, browse the server, and see history. It only answers requests from your own machine.

## Claude Code guard hook

If Claude also runs the CLI directly, add `bin/claude-guard.js` as a PreToolUse hook. It blocks
`--mirror` and `--no-backup` in shell commands, queue files and API calls, and tells Claude why. You can
still run them yourself in a terminal. After `npm install -g shipback-sftp`, the file is in the folder
`npm root -g` prints, under `shipback-sftp/bin/`.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell|Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "node /path/to/shipback-sftp/bin/claude-guard.js" }]
      }
    ]
  }
}
```

## Tests

```bash
npm test
```

The suite uses `node:test` and needs no network. `test/promise.test.js` holds one test per line of the
[undo promise](UNDO-PROMISE.md). Deploy, restore, the CLI and the MCP server are each
also exercised end to end against a real SFTP server started inside the test run.

## Limits

- It compares by size and SHA-256. The first deploy to a site that already has files reads the server
  copies of any same-size files to compare them.
- Backups live on the same server as the site. They protect against bad deploys, not against losing the
  hosting account. Keep your host's own backups too.
- Files over 8 MB with the same size on both sides are assumed unchanged when there is no manifest hash
  to compare.
- What undo doesn't cover (databases, `--no-backup` deploys, pruned backups and so on) is listed in
  [the undo promise](UNDO-PROMISE.md#what-it-doesnt-cover).

## License

MIT © 2026 Aldo Hushi

Runs aldo.today. Made at [BlueprintAU](https://blueprintau.com).
