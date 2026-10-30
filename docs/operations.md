# Operations and recovery

## Health and graceful stop

The container exposes its readiness check only on `127.0.0.1:3000/readyz` inside the container. It returns HTTP 200 only when Discord is connected and SQLite answers a query; startup, shutdown, or a failed database check returns HTTP 503. Docker uses this endpoint for the image health status. No host port is published. An unhealthy status is an alert for the operator; Docker's `unless-stopped` restart policy restarts an exited process, not a process that is merely unhealthy.

Check status and logs:

```sh
docker compose ps
docker compose logs --tail=100 bot
```

Stop the bot and allow its SIGTERM shutdown to finish within the Compose grace period:

```sh
docker compose stop --timeout 20 bot
```

The shutdown sequence stops scheduled plan work, unregisters message-retention listeners, disconnects Discord, closes the readiness server, and closes SQLite. If Docker reports that the grace period elapsed, inspect the logs and database before starting another copy. Do not run multiple bot processes against the same database.

## Database backups

The SQLite file can contain server configuration snapshots, plan audit history, and opted-in message text. Treat each backup as sensitive data: restrict access to the volume and backup copies, keep them out of source control and public file sharing, and remove them when their retention period ends. A backup contains the entire database, including content that has not yet reached its message-retention expiry.

The online backup command uses SQLite's backup API and may run while the bot is operating. It validates database integrity and the exact application schema, checks the destination filesystem has room for the estimated database size plus at least 16 MiB or 5% reserve, then publishes a unique backup without replacing an existing file. The default location is `backups/` beside the database, which is inside the persistent `bot-data` volume in Compose.

For Compose:

```sh
docker compose exec bot node dist/storage/operations.js backup
```

The output gives the path of the new backup. To choose a path inside the volume:

```sh
docker compose exec bot node dist/storage/operations.js backup /app/data/backups/before-maintenance.sqlite
```

The requested path must not already exist. Copy backups off the host using a secure method only after reviewing the destination's access controls. Do not include message text or backup contents in support logs.

## Restore and rehearsal

Restore requires the bot to be stopped. First record the current Compose image/commit, then stop the service and choose a validated backup from the persistent volume:

```sh
docker compose stop --timeout 20 bot
docker compose run --rm --no-deps bot node dist/storage/operations.js restore /app/data/backups/<backup-file>.sqlite --confirm-stopped
```

The restore command requires `--confirm-stopped`, checks integrity and schema compatibility, preflights room for both the current and restored database plus a safety reserve, and writes a separate pre-restore backup before replacing the live file. It preserves the old database if validation or installation fails. It removes old SQLite WAL sidecars only after checkpointing and preserving the old database. Keep the printed pre-restore path until the recovered service is verified.

Bring the service back and verify readiness and application logs:

```sh
docker compose up -d bot
docker compose ps
docker compose logs --tail=100 bot
```

For a restore rehearsal, use a disposable deployment and non-sensitive test records. Create a known test marker in a test database, back up while the bot is online, stop the service, change or remove that marker only in the disposable database, restore the backup, then verify the marker and `/health` result. Confirm that the pre-restore backup still contains the database state from immediately before restore. Do not rehearse by deleting the production volume. `docker compose down` preserves the named volume; `docker compose down --volumes` deletes it.

Backups use online SQLite snapshots. Restore is an offline operation: do not start another bot process until it has finished. The CLI cannot prove that an operator has stopped every other copy; `--confirm-stopped` is an explicit operator check. If a restore reports insufficient space, do not remove unverified files or Docker volumes. Check the data filesystem and Docker's usage first:

```sh
df -h / /var/lib/docker
docker system df
docker compose exec bot df -h /app/data
```

Free space or move an already verified backup to an approved secure destination, then retry. Never run broad prune commands as a database-recovery step.

## Rotate the Discord bot token

1. Stop the Compose service with `docker compose stop --timeout 20 bot`.
2. In the Discord Developer Portal, reset the development bot token. Resetting revokes the previous token.
3. Edit the local, ignored `.env` file in a text editor and replace only `DISCORD_BOT_TOKEN`. Do not place the token in a command-line argument, shell history, issue, chat, or log.
4. Start a fresh container with `docker compose up -d --force-recreate bot`.
5. Confirm `docker compose ps` reports healthy and review `docker compose logs --tail=100 bot` for a successful Discord connection. The logger must not display the token.

If the bot does not become healthy, stop it, verify the new token in the Developer Portal, and correct `.env` locally. Do not restore or share a database backup to fix a credential problem.
