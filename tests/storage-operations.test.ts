import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSufficientFreeSpace,
  createDatabaseBackup,
  restoreDatabaseBackup,
  validateDatabaseFile,
} from "../src/storage/backup-restore.js";
import { openDatabase } from "../src/storage/database.js";

function withTemporaryDirectory(
  callback: (directory: string) => Promise<void>,
) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "discord-bot-storage-"));
    try {
      await callback(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function createDatabase(databasePath: string, value: number): void {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO ai_usage_daily
          (guild_id, bucket_date, tokens_used, tokens_reserved, updated_at)
         VALUES ('11111111111111111', '2026-01-01', ?, 0, '2026-01-01T00:00:00.000Z')`,
      )
      .run(value);
  } finally {
    database.close();
  }
}

function readMarker(databasePath: string): number {
  const database = openDatabase(databasePath);
  try {
    return (
      database
        .prepare(
          `SELECT tokens_used FROM ai_usage_daily
           WHERE guild_id = '11111111111111111' AND bucket_date = '2026-01-01'`,
        )
        .get() as { tokens_used: number }
    ).tokens_used;
  } finally {
    database.close();
  }
}

test(
  "online backup captures a live WAL database and refuses to overwrite a destination",
  withTemporaryDirectory(async (directory) => {
    const sourcePath = join(directory, "source.sqlite");
    const backupPath = join(directory, "backup.sqlite");
    const database = openDatabase(sourcePath);
    try {
      database
        .prepare(
          `INSERT INTO ai_usage_daily
            (guild_id, bucket_date, tokens_used, tokens_reserved, updated_at)
           VALUES ('11111111111111111', '2026-01-01', 1, 0, '2026-01-01T00:00:00.000Z')`,
        )
        .run();

      await createDatabaseBackup(sourcePath, backupPath);
      assert.equal(readMarker(backupPath), 1);
      await assert.rejects(
        createDatabaseBackup(sourcePath, backupPath),
        /already exists|EEXIST/i,
      );
      assert.equal(readMarker(backupPath), 1);
    } finally {
      database.close();
    }
  }),
);

test(
  "restore requires explicit stopped confirmation and preserves the previous database",
  withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "live.sqlite");
    const sourcePath = join(directory, "restore-source.sqlite");
    createDatabase(databasePath, 2);
    createDatabase(sourcePath, 1);

    await assert.rejects(
      restoreDatabaseBackup(databasePath, sourcePath, false),
      /bot to be stopped/,
    );
    assert.equal(readMarker(databasePath), 2);

    const result = await restoreDatabaseBackup(databasePath, sourcePath, true);
    assert.equal(readMarker(databasePath), 1);
    assert.ok(result.previousBackupPath);
    assert.equal(readMarker(result.previousBackupPath), 2);
    assert.equal(validateDatabaseFile(databasePath).logicalBytes > 0, true);
  }),
);

test(
  "invalid restore source leaves the original database untouched",
  withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "live.sqlite");
    const invalidBackup = join(directory, "invalid.sqlite");
    createDatabase(databasePath, 2);
    writeFileSync(invalidBackup, "not a sqlite database");

    await assert.rejects(
      restoreDatabaseBackup(databasePath, invalidBackup, true),
    );
    assert.equal(readMarker(databasePath), 2);
  }),
);

test(
  "backup validation rejects a database whose schema objects drifted",
  withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "drifted.sqlite");
    const database = openDatabase(databasePath);
    database.exec("DROP TABLE retained_messages");
    database.close();

    await assert.rejects(
      createDatabaseBackup(databasePath, join(directory, "backup.sqlite")),
      /schema is incomplete/,
    );
  }),
);

test("failed disk-space preflight refuses the operation with sizes", () => {
  assert.throws(
    () => assertSufficientFreeSpace(20, 10),
    /Insufficient free space.*10 bytes.*16,777,216 bytes.*20 bytes/,
  );
  assert.doesNotThrow(() => assertSufficientFreeSpace(20_000_000, 10));
});

test(
  "a failed backup does not replace or modify existing files",
  withTemporaryDirectory(async (directory) => {
    const invalidSource = join(directory, "invalid.sqlite");
    const destination = join(directory, "existing.sqlite");
    writeFileSync(invalidSource, "invalid source");
    writeFileSync(destination, "keep this file");

    await assert.rejects(createDatabaseBackup(invalidSource, destination));
    assert.equal(readFileSync(destination, "utf8"), "keep this file");
  }),
);
