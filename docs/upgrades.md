# Upgrade and rollback procedure

SQLite migrations move forward when the bot starts. There are no automatic down migrations. If an older release does not support the database schema, it refuses to start rather than dropping newer data. Rollback then means restoring a backup made before the upgrade and matching the older application version.

## Upgrade

Record the current application revision and schema version. `/health` reports the schema version; `git rev-parse HEAD` records the source revision when building from this repository. Keep the `.env` file and database volume in place.

While the current bot is running, create a validated online backup:

```sh
docker compose exec bot node dist/storage/operations.js backup
```

Keep the printed backup path. It is stored in the persistent data volume and contains the exact current schema. Treat it as sensitive data because it may include opted-in message text.

Stop the bot, select the target release commit or tag, build that source, and start one instance:

```sh
docker compose stop --timeout 20 bot
git fetch --tags origin
git switch --detach <target-commit-or-tag>
docker compose build bot
docker compose up -d bot
docker compose ps
docker compose logs --tail=100 bot
```

Wait for Docker to report `healthy`, then use `/health` in the test server to confirm the bot responds and reports the expected schema version. Review logs for successful startup and migration. Keep the pre-upgrade backup until the new release has been verified.

## Roll back to an older release

If the older release supports the database as it stands, stop the current bot, select and build the older release, and start it. If it reports that the schema is newer than it supports, restore the pre-upgrade backup with the older release's storage tool while the service is stopped:

```sh
docker compose stop --timeout 20 bot
git switch --detach <older-commit-or-tag>
docker compose build bot
docker compose run --rm --no-deps bot node dist/storage/operations.js restore /app/data/backups/<pre-upgrade-backup>.sqlite --confirm-stopped
docker compose up -d bot
docker compose ps
docker compose logs --tail=100 bot
```

The backup schema must match the code performing the restore. The restore tool accepts a validated backup for its own release and preserves the stopped target database as a pre-restore copy even if that database has a newer migration version. Verify that pre-restore copy remains in `backups/` before deleting anything. After startup, confirm Docker health and `/health` before resuming normal use.

Use the same data volume throughout the procedure. Do not run two releases against it at once, do not delete the volume, and do not attempt to edit the migration ledger or manually reverse schema changes. If there is no matching pre-upgrade backup, stop and keep the newer database intact until a forward-compatible recovery path is available.

## Migration verification

The automated upgrade rehearsal starts with schema v7 and representative AI usage data, opens it with the current version, and confirms schema v8 and the original data remain. The rollback rehearsal takes a v8 backup, simulates a future v9 schema, restores the matching v8 backup with v8 code, and checks that both the restored v8 data and the preserved v9 copy remain intact. An older-code test confirms that v9 is refused without losing its future data.
