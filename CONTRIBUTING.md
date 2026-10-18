# Contributing

Thanks for helping. Bug reports, fixes and docs are all welcome.

## Reporting a bug

Open an issue with the **Bug report** form. The most useful thing you can add is the output of the
command with `--json`, with the host name and username removed. Security problems go through
[SECURITY.md](SECURITY.md) instead, not a public issue.

## Working on the code

```bash
git clone https://github.com/aldohushi1-stack/shipback-sftp.git
cd shipback-sftp
npm install
npm test
```

It needs Node 18 or newer. The tests use `node:test` and need no network: deploy, restore, the CLI and the
MCP server run end to end against a real SFTP server that the test run starts itself. CI runs the same
suite on Linux, macOS and Windows with Node 18, 20 and 22.

Where things live:

| File | Does |
| --- | --- |
| `src/deploy.js` | plans a deploy, backs up what it will replace, uploads |
| `src/restore.js` | undoes a deploy from a `_backup-…` folder, checks for live edits first |
| `src/pull.js` | brings server changes down, backing up local copies |
| `src/backup.js` | copies server files into `_backup-…` and writes `.backup.json` |
| `src/manifest.js` | scans the local folder (sizes, SHA-256, ignore rules) |
| `src/mcp.js`, `bin/mcp.js` | the MCP server and its tools |
| `src/queue.js` | the drop-box queue |
| `src/server.js`, `ui/index.html` | the local app on 127.0.0.1 |
| `bin/cli.js` | the `shipback` command |
| `bin/claude-guard.js` | the Claude Code hook |

## Pull requests

- Add or change a test with every fix. A bug fix should come with the test that failed before it.
- Run `npm test` before you push.
- Keep the safety rules: the MCP tools never delete server files, skip a backup or prune backups; the
  guard hook blocks `--mirror` and `--no-backup` wherever Claude could write them; and restore never
  overwrites a live edit without `--force`. A change that loosens one of these needs a reason in the PR
  description.
- Small PRs are easier to review than big ones.

By contributing you agree that your work is released under the [MIT licence](LICENSE).
