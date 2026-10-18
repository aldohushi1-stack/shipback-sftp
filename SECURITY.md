# Security

Shipback holds SFTP passwords and writes to live servers, so security reports are taken seriously.

## Reporting a problem

Please **don't open a public issue** for a security problem. Report it privately instead:
go to the [Security tab](https://github.com/aldohushi1-stack/shipback-sftp/security) and click
**Report a vulnerability**. Only the maintainer can see it.

Say what you found, how to reproduce it, and which version and OS you used. You'll get a reply within a
week. Once a fix is out, the advisory is published with credit to you unless you'd rather not be named.

## Supported versions

| Version | Fixes |
| --- | --- |
| 0.1.x | yes |

## What counts

These are in scope:

- a password reaching the model, a log, `deploys.jsonl`, a queue file or the local UI's API
- an MCP tool that deletes server files, skips the backup or prunes backups
- `--restore` overwriting a live edit without `--force`, or a backup that can't put back what it replaced
- a deploy, pull or restore writing outside the site's remote root or local folder (path traversal)
- the local UI answering requests from another machine or another site in the browser
- the guard hook missing a plain `--mirror` or `--no-backup` (or `"mirror": true` / `"backup": false` in a
  queue file) that Claude could write

Out of scope: what someone can do with your SFTP password once they have it, a host's own backup or
permission settings, and `--mirror`, `--no-backup`, `--prune` and `--force` (or their queue options) doing
what they say when a person uses them.
