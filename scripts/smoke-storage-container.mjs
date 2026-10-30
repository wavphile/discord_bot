import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "/app/dist/storage/database.js";
import { migrations } from "/app/dist/storage/migrations.js";
import {
  createDatabaseBackup,
  restoreDatabaseBackup,
} from "/app/dist/storage/backup-restore.js";

const directory = mkdtempSync(join(tmpdir(), "discord-bot-container-smoke-"));
const databasePath = join(directory, "live.sqlite");
const backupPath = join(directory, "snapshot.sqlite");
const guildId = "11111111111111111";
const bucketDate = "2026-01-01";

function createVersionSevenDatabase() {
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

function writeMarker(value) {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO ai_usage_daily
          (guild_id, bucket_date, tokens_used, tokens_reserved, updated_at)
         VALUES ('11111111111111111', '2026-01-01', ?, 0, '2026-01-01T00:00:00.000Z')
         ON CONFLICT (guild_id, bucket_date) DO UPDATE SET tokens_used = excluded.tokens_used`,
      )
      .run(value);
  } finally {
    database.close();
  }
}

function addFutureMigration() {
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

function readMarker(path) {
  const database = openDatabase(path);
  try {
    return database
      .prepare(
        `SELECT tokens_used FROM ai_usage_daily
         WHERE guild_id = '11111111111111111' AND bucket_date = '2026-01-01'`,
      )
      .get().tokens_used;
  } finally {
    database.close();
  }
}

try {
  createVersionSevenDatabase();
  assert.equal(readMarker(databasePath), 42);
  writeMarker(42);
  await createDatabaseBackup(databasePath, backupPath);
  writeMarker(99);
  addFutureMigration();

  assert.throws(
    () => openDatabase(databasePath),
    /newer than this application supports/,
  );

  const result = await restoreDatabaseBackup(databasePath, backupPath, true);
  assert.equal(readMarker(databasePath), 42);
  assert.ok(result.previousBackupPath);
  const preservedNewerDatabase = new DatabaseSync(result.previousBackupPath, {
    readOnly: true,
  });
  try {
    assert.equal(
      preservedNewerDatabase.prepare("SELECT value FROM future_records").get()
        .value,
      "preserve future data",
    );
    assert.equal(
      preservedNewerDatabase
        .prepare("SELECT tokens_used FROM ai_usage_daily")
        .get().tokens_used,
      99,
    );
  } finally {
    preservedNewerDatabase.close();
  }
  console.log("PASS: production image SQLite upgrade and rollback rehearsal");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
