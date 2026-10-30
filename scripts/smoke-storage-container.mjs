import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "/app/dist/storage/database.js";
import {
  createDatabaseBackup,
  restoreDatabaseBackup,
} from "/app/dist/storage/backup-restore.js";

const directory = mkdtempSync(join(tmpdir(), "discord-bot-container-smoke-"));
const databasePath = join(directory, "live.sqlite");
const backupPath = join(directory, "snapshot.sqlite");

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
  writeMarker(1);
  await createDatabaseBackup(databasePath, backupPath);
  writeMarker(2);

  const result = await restoreDatabaseBackup(databasePath, backupPath, true);
  assert.equal(readMarker(databasePath), 1);
  assert.ok(result.previousBackupPath);
  assert.equal(readMarker(result.previousBackupPath), 2);
  console.log("PASS: production image SQLite backup and restore");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
