# The undo promise

Any deploy Shipback makes can be undone with one command:

```bash
shipback mysite --restore
```

Agents get the same thing as `preview_restore` then `restore`. Here is exactly what it does. Each line has a test with
the same number in [`test/promise.test.js`](test/promise.test.js). Those tests run on every push, on Windows, macOS
and Linux, and compare every byte on the server, not a sample.

| | When you undo a deploy |
| --- | --- |
| **P1** | Every file it replaced or deleted comes back byte for byte. Every file it added is removed, along with any folder it created for them. Nothing else on the server is touched: uploads, form data and `.well-known` stay as they are. |
| **P2** | If the deploy was cut off part way (Wi-Fi dropped, laptop lid shut), the live site never had half a file on it, and the same one command still undoes it. No `--force`. |
| **P3** | That holds on servers that can't swap a file in one step too. |
| **P4** | If it was cut off while it was still saving backups, it hadn't changed anything yet. Undo says so and doesn't guess. |
| **P5** | If the backup can't be saved (a full disk, say), nothing goes up. |
| **P6** | If the undo itself is cut off, run it again and it finishes. |
| **P7** | If someone changed one of those files on the server after the deploy, undo stops, names the file and changes nothing at all. You decide what happens next. |
| **P8** | A backup copy that's been damaged since is never written back, even with `--force`. |
| **P9** | The undo can be undone. |
| **P10** | All of this works through a real SFTP server, and replaced files keep their permissions. |
| **P11** | A dropped connection fails the deploy out loud and tells you how to undo it. It never stops in silence. |
| **P12** | Only one deploy or undo writes to a site at a time. A second one is turned away without changing anything, so two runs can never get mixed into one backup. A lock left behind by a run that was cut off clears itself. |
| **P13** | Undo never touches anything outside the site folder, even if a backup record has been tampered with to say it should. A record that can't be read is refused, never guessed at. |

These have also been run on a real cPanel host, including cutting the connection halfway through a deploy and running
two deploys at once.

## If it doesn't

If undo ever fails to do one of those things, [open an "Undo didn't work" issue](https://github.com/aldohushi1-stack/shipback-sftp/issues/new?template=undo_failed.yml).

- It's the first thing I fix, ahead of everything else.
- I'll help you get your files back by hand. Everything the deploy replaced is still in its `_backup-…` folder on your server.
- The fix ships with a test built from your case, so it can't happen again.

## What it doesn't cover

- **Deploys made with `--no-backup`.** They have nothing to undo from. The agent tools can't make them.
- **Backups that are gone.** Undo needs that deploy's `_backup-…` folder. `--prune` will remove old ones if you ask, and so can you or your host.
- **Anything outside the site folder:** databases, server settings, cron jobs, email.
- **Backups made before 0.2.** Those still restore, but they don't carry the checksums behind P4 and P8.
- **File dates and owners.** Restored files get the current time. A file brought back after a deploy deleted it gets the server's default permissions.
- **Losing the hosting account.** Backups sit on the same server as the site. Keep your host's own backups too.

This is a promise about what the software does and how I'll treat it when it doesn't. It isn't insurance, and the
MIT licence's "no warranty" still stands.

Aldo Hushi, 20 October 2026
