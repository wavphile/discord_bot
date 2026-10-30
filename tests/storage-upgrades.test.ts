import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createDatabaseBackup,
  restoreDatabaseBackup,
} from "../src/storage/backup-restore.js";
import { openDatabase, getSchemaVersion } from "../src/storage/database.js";
import { migrations } from "../src/storage/migrations.js";

const guildId = "11111111111111111";
const bucketDate = "2026-01-01";

function withTemporaryDirectory(
  callback: (directory: string) => Promise<void>,
) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "discord-bot-upgrades-"));
    try {
      await callback(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function createVersionSevenDatabase(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    for (const migration of migrations.slice(0, 7)) {
      migration.up(database);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, "2026-01-01T00:00:00.000Z");
    }
    database
      .prepare(
        `INSERT INTO ai_usage_daily
          (guild_id, bucket_date, tokens_used, tokens_reserved, updated_at)
         VALUES (?, ?, 42, 0, '2026-01-01T00:00:00.000Z')`,
      )
      .run(guildId, bucketDate);
  } finally {
    database.close();
  }
}

function addFutureMigration(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(
      "CREATE TABLE future_records (value TEXT PRIMARY KEY NOT NULL)",
    );
    database
      .prepare("INSERT INTO future_records (value) VALUES (?)")
      .run("preserve future data");
    database
      .prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (9, ?, ?)",
      )
      .run("future_schema_for_rollback_test", "2026-01-02T00:00:00.000Z");
  } finally {
    database.close();
  }
}

function readUsage(databasePath: string): number {
  const database = openDatabase(databasePath);
  try {
    return (
      database
        .prepare(
          `SELECT tokens_used FROM ai_usage_daily
           WHERE guild_id = ? AND bucket_date = ?`,
        )
        .get(guildId, bucketDate) as { tokens_used: number }
    ).tokens_used;
  } finally {
    database.close();
  }
}

test(
  "the current version upgrades a prior schema and preserves existing records",
  withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "version-seven.sqlite");
    createVersionSevenDatabase(databasePath);

    const upgraded = openDatabase(databasePath);
    try {
      assert.equal(getSchemaVersion(upgraded), 8);
      assert.equal(
        (
          upgraded
            .prepare(
              `SELECT tokens_used FROM ai_usage_daily
               WHERE guild_id = ? AND bucket_date = ?`,
            )
            .get(guildId, bucketDate) as { tokens_used: number }
        ).tokens_used,
        42,
      );
      assert.equal(
        (
          upgraded
            .prepare("SELECT COUNT(*) AS count FROM retained_messages")
            .get() as { count: number }
        ).count,
        0,
      );
    } finally {
      upgraded.close();
    }
  }),
);

test(
  "an older application refuses a newer schema without dropping its data",
  withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "version-nine.sqlite");
    const database = openDatabase(databasePath);
    database.close();
    addFutureMigration(databasePath);
    const checkpoint = new DatabaseSync(databasePath);
    checkpoint.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    checkpoint.close();
    const before = createHash("sha256")
      .update(readFileSync(databasePath))
      .digest("hex");

    assert.throws(
      () => openDatabase(databasePath),
      /newer than this application supports/,
    );
    const after = createHash("sha256")
      .update(readFileSync(databasePath))
      .digest("hex");
    assert.equal(after, before);

    const unchanged = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        (
          unchanged.prepare("PRAGMA integrity_check").get() as {
            integrity_check: string;
          }
        ).integrity_check,
        "ok",
      );
      assert.equal(
        (
          unchanged.prepare("SELECT value FROM future_records").get() as {
            value: string;
          }
        ).value,
        "preserve future data",
      );
      assert.equal(
        (
          unchanged
            .prepare("SELECT MAX(version) AS version FROM schema_migrations")
            .get() as { version: number }
        ).version,
        9,
      );
    } finally {
      unchanged.close();
    }
  }),
);

test(
  "a matching older backup restores over a newer schema and preserves the newer copy",
  withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "live.sqlite");
    const backupPath = join(directory, "before-upgrade.sqlite");
    const database = openDatabase(databasePath);
    try {
      database
        .prepare(
          `INSERT INTO ai_usage_daily
            (guild_id, bucket_date, tokens_used, tokens_reserved, updated_at)
           VALUES (?, ?, 11, 0, '2026-01-01T00:00:00.000Z')`,
        )
        .run(guildId, bucketDate);
    } finally {
      database.close();
    }
    await createDatabaseBackup(databasePath, backupPath);

    const modified = openDatabase(databasePath);
    try {
      modified
        .prepare(
          `UPDATE ai_usage_daily SET tokens_used = 99
           WHERE guild_id = ? AND bucket_date = ?`,
        )
        .run(guildId, bucketDate);
    } finally {
      modified.close();
    }
    addFutureMigration(databasePath);

    const result = await restoreDatabaseBackup(databasePath, backupPath, true);
    assert.equal(readUsage(databasePath), 11);
    assert.ok(result.previousBackupPath);

    const preservedNewerDatabase = new DatabaseSync(result.previousBackupPath, {
      readOnly: true,
    });
    try {
      assert.equal(
        (
          preservedNewerDatabase
            .prepare("SELECT value FROM future_records")
            .get() as { value: string }
        ).value,
        "preserve future data",
      );
      assert.equal(
        (
          preservedNewerDatabase
            .prepare("SELECT tokens_used FROM ai_usage_daily")
            .get() as { tokens_used: number }
        ).tokens_used,
        99,
      );
    } finally {
      preservedNewerDatabase.close();
    }
  }),
);
