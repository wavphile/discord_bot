import "dotenv/config";
import { getGuildSetting, setGuildSetting } from "./guild-settings.js";
import { openDatabase } from "./database.js";

const [action, guildId] = process.argv.slice(2);
const settingKey = "storage_tryout_marker";
const marker = "discord-bot-storage-tryout-v1";

if ((action !== "write" && action !== "verify") || !guildId) {
  console.error(
    "Usage: npm run storage:tryout -- <write|verify> <test-guild-id>",
  );
  process.exitCode = 2;
} else {
  const database = openDatabase(
    process.env["DATABASE_PATH"] ?? "./data/discord-bot.sqlite",
  );
  try {
    if (action === "write") {
      setGuildSetting(database, guildId, settingKey, {
        marker,
        writtenAt: new Date().toISOString(),
      });
      console.info(
        "Storage tryout marker saved. Restart the process, then verify it.",
      );
    } else {
      const value = getGuildSetting(database, guildId, settingKey);
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        value["marker"] === marker
      ) {
        console.info(
          "PASS: the storage tryout marker survived a process restart.",
        );
      } else {
        console.error("No tryout marker found. Run the write command first.");
        process.exitCode = 1;
      }
    }
  } finally {
    database.close();
  }
}
