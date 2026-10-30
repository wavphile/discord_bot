import "dotenv/config";
import {
  createDatabaseBackup,
  restoreDatabaseBackup,
} from "./backup-restore.js";

const [operation, ...arguments_] = process.argv.slice(2);
const databasePath =
  process.env["DATABASE_PATH"] ?? "./data/discord-bot.sqlite";

try {
  if (operation === "backup") {
    if (arguments_.length > 1) {
      throw new Error("Usage: storage:backup [destination-path]");
    }
    const destination = await createDatabaseBackup(databasePath, arguments_[0]);
    console.log(`Database backup created: ${destination}`);
  } else if (operation === "restore") {
    const [sourcePath, confirmation, extra] = arguments_;
    if (!sourcePath || confirmation !== "--confirm-stopped" || extra) {
      throw new Error("Usage: storage:restore <backup-path> --confirm-stopped");
    }
    const result = await restoreDatabaseBackup(databasePath, sourcePath, true);
    console.log(`Database restored from: ${sourcePath}`);
    if (result.previousBackupPath) {
      console.log(
        `Previous database preserved at: ${result.previousBackupPath}`,
      );
    }
  } else {
    throw new Error(
      "Choose `backup` or `restore`. Restore also requires --confirm-stopped.",
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unexpected error.";
  console.error(`Storage operation failed: ${message}`);
  process.exitCode = 1;
}
