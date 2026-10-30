import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statfsSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { migrations } from "./migrations.js";

const mebibyte = 1024 * 1024;
const reservedFreeBytes = 16 * mebibyte;

type MigrationRow = Readonly<{ version: number; name: string }>;
type SchemaObjectRow = Readonly<{
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}>;
type DatabaseDetails = Readonly<{ logicalBytes: number }>;

export async function createDatabaseBackup(
  databasePath: string,
  destinationPath?: string,
): Promise<string> {
  const sourcePath = resolveDatabasePath(databasePath);
  const targetPath = resolve(
    destinationPath ?? defaultBackupPath(sourcePath, "backup"),
  );
  if (samePath(sourcePath, targetPath)) {
    throw new Error(
      "The backup destination must differ from the database path.",
    );
  }
  if (existsSync(targetPath)) {
    throw new Error(`Backup destination already exists: ${targetPath}`);
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  const temporaryDirectory = mkdtempSync(
    join(dirname(targetPath), ".discord-bot-backup-"),
  );
  const temporaryPath = join(temporaryDirectory, "database.sqlite");
  try {
    const details = await copyValidatedDatabase(sourcePath, temporaryPath);
    assertDiskSpace(dirname(targetPath), details.logicalBytes);
    validateDatabaseFile(temporaryPath);
    setPrivateFileMode(temporaryPath);

    // A same-directory hard link publishes the finished file atomically and
    // fails if another backup has already claimed the requested path.
    linkSync(temporaryPath, targetPath);
    return targetPath;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function restoreDatabaseBackup(
  databasePath: string,
  backupPath: string,
  confirmStopped: boolean,
): Promise<Readonly<{ previousBackupPath?: string }>> {
  if (!confirmStopped) {
    throw new Error(
      "Restore requires the bot to be stopped. Re-run with --confirm-stopped only after stopping every bot process.",
    );
  }

  const targetPath = resolveDatabasePath(databasePath);
  const sourcePath = resolve(backupPath);
  if (samePath(targetPath, sourcePath)) {
    throw new Error("The restore source must differ from the database path.");
  }
  mkdirSync(dirname(targetPath), { recursive: true });

  const sourceDetails = validateDatabaseFile(sourcePath);
  const targetExists = existsSync(targetPath);
  let targetDetails: DatabaseDetails | undefined;
  if (targetExists) targetDetails = validateDatabaseFile(targetPath);

  const requiredBytes =
    sourceDetails.logicalBytes + (targetDetails?.logicalBytes ?? 0);
  assertDiskSpace(dirname(targetPath), requiredBytes);

  const previousBackupPath = targetExists
    ? defaultBackupPath(targetPath, "pre-restore")
    : undefined;

  if (targetExists) {
    checkpointDatabase(targetPath);
    await createDatabaseBackup(targetPath, previousBackupPath);
  }

  const temporaryDirectory = mkdtempSync(
    join(dirname(targetPath), ".discord-bot-restore-"),
  );
  const temporaryPath = join(temporaryDirectory, "restored.sqlite");
  const rollbackPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.rollback-${randomUUID()}`,
  );
  const displacedPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.displaced-${randomUUID()}`,
  );
  let rollbackLinked = false;
  let originalMoved = false;
  let restoredInstalled = false;
  try {
    await copyValidatedDatabase(sourcePath, temporaryPath);
    validateDatabaseFile(temporaryPath);
    setPrivateFileMode(temporaryPath);

    if (targetExists) {
      rmSync(`${targetPath}-wal`, { force: true });
      rmSync(`${targetPath}-shm`, { force: true });
      linkSync(targetPath, rollbackPath);
      rollbackLinked = true;
      if (process.platform === "win32") {
        renameSync(targetPath, displacedPath);
        originalMoved = true;
      }
    }

    try {
      renameSync(temporaryPath, targetPath);
      restoredInstalled = true;
      validateDatabaseFile(targetPath);
    } catch (error) {
      if (restoredInstalled) rmSync(targetPath, { force: true });
      if (rollbackLinked && existsSync(rollbackPath)) {
        if (existsSync(targetPath)) {
          unlinkSync(rollbackPath);
        } else {
          renameSync(rollbackPath, targetPath);
        }
        rollbackLinked = false;
      }
      if (originalMoved) rmSync(displacedPath, { force: true });
      throw error;
    }

    if (originalMoved) unlinkSync(displacedPath);
    if (rollbackLinked) unlinkSync(rollbackPath);
    return previousBackupPath ? { previousBackupPath } : {};
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function assertSufficientFreeSpace(
  availableBytes: number,
  requiredBytes: number,
): void {
  const reserve = Math.max(reservedFreeBytes, Math.ceil(requiredBytes * 0.05));
  if (availableBytes < requiredBytes + reserve) {
    throw new Error(
      `Insufficient free space: operation needs ${formatBytes(requiredBytes)} plus a ${formatBytes(reserve)} safety reserve; ${formatBytes(availableBytes)} is available.`,
    );
  }
}

export function validateDatabaseFile(databasePath: string): DatabaseDetails {
  const path = resolveDatabasePath(databasePath);
  const database = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
  try {
    return validateOpenDatabase(database);
  } finally {
    database.close();
  }
}

function resolveDatabasePath(databasePath: string): string {
  if (!databasePath || databasePath === ":memory:") {
    throw new Error("A file-backed SQLite database path is required.");
  }
  const path = resolve(databasePath);
  if (existsSync(path) && !lstatSync(path).isFile()) {
    throw new Error("Database and backup paths must be regular files.");
  }
  return path;
}

function defaultBackupPath(databasePath: string, purpose: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(
    dirname(databasePath),
    "backups",
    `${basename(databasePath)}-${purpose}-${stamp}-${randomUUID().slice(0, 8)}.sqlite`,
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

async function copyValidatedDatabase(
  sourcePath: string,
  destinationPath: string,
): Promise<DatabaseDetails> {
  const source = new DatabaseSync(sourcePath, {
    readOnly: true,
    timeout: 5_000,
  });
  try {
    const details = validateOpenDatabase(source);
    assertDiskSpace(dirname(destinationPath), details.logicalBytes);
    await backup(source, destinationPath);
    return details;
  } finally {
    source.close();
  }
}

function validateOpenDatabase(database: DatabaseSync): DatabaseDetails {
  const integrity = database.prepare("PRAGMA integrity_check").all() as Array<{
    integrity_check: string;
  }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("Database integrity check failed.");
  }

  const applied = database
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
    .all() as MigrationRow[];
  if (
    applied.length !== migrations.length ||
    applied.some(
      (row, index) =>
        row.version !== migrations[index]?.version ||
        row.name !== migrations[index]?.name,
    )
  ) {
    throw new Error(
      "Database schema is incomplete or does not match this application version.",
    );
  }

  assertExpectedSchema(database);

  const pageCount = database.prepare("PRAGMA page_count").get() as {
    page_count: number;
  };
  const pageSize = database.prepare("PRAGMA page_size").get() as {
    page_size: number;
  };
  return { logicalBytes: pageCount.page_count * pageSize.page_size };
}

function assertExpectedSchema(database: DatabaseSync): void {
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
    for (const migration of migrations) migration.up(expected);

    const actualRows = database
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      )
      .all() as SchemaObjectRow[];
    const expectedRows = expected
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      )
      .all() as SchemaObjectRow[];
    if (JSON.stringify(actualRows) !== JSON.stringify(expectedRows)) {
      throw new Error(
        "Database schema is incomplete or does not match this application version.",
      );
    }
  } finally {
    expected.close();
  }
}

function assertDiskSpace(directoryPath: string, requiredBytes: number): void {
  const { bavail, bsize } = statfsSync(directoryPath);
  assertSufficientFreeSpace(bavail * bsize, requiredBytes);
}

function checkpointDatabase(databasePath: string): void {
  const database = new DatabaseSync(databasePath, { timeout: 5_000 });
  try {
    const result = database
      .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
      .get() as { busy: number };
    if (result.busy !== 0) {
      throw new Error(
        "SQLite could not checkpoint the database. Confirm every bot process is stopped and retry.",
      );
    }
  } finally {
    database.close();
  }
}

function setPrivateFileMode(path: string): void {
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function formatBytes(value: number): string {
  return `${value.toLocaleString("en-US")} bytes`;
}
