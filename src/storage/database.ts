import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "./migrations.js";

type AppliedMigration = Readonly<{ version: number; name: string }>;

function appliedMigrations(database: DatabaseSync): AppliedMigration[] {
  return database
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC")
    .all() as AppliedMigration[];
}

function migrate(database: DatabaseSync): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = appliedMigrations(database);
  if (applied.length > migrations.length) {
    throw new Error(
      `Database schema version ${applied.length} is newer than this application supports.`,
    );
  }

  for (const [index, row] of applied.entries()) {
    const expected = migrations[index];
    if (
      !expected ||
      row.version !== expected.version ||
      row.name !== expected.name
    ) {
      throw new Error("Database migration history is incomplete or invalid.");
    }
  }

  for (const migration of migrations.slice(applied.length)) {
    database.exec("BEGIN IMMEDIATE;");
    try {
      migration.up(database);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, new Date().toISOString());
      database.exec("COMMIT;");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK;");
      throw error;
    }
  }

  return migrations.at(-1)?.version ?? 0;
}

export function openDatabase(databasePath: string): DatabaseSync {
  const resolvedPath =
    databasePath === ":memory:" ? databasePath : resolve(databasePath);
  if (resolvedPath !== ":memory:") {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  }

  const database = new DatabaseSync(resolvedPath, { timeout: 5_000 });
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA synchronous = FULL;");
    migrate(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function getSchemaVersion(database: DatabaseSync): number {
  const row = database
    .prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
    )
    .get() as { version: number };
  return row.version;
}
