import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { env } from "./config/env.js";
import { executeHealthCommand } from "./discord/commands/health.js";
import { logger } from "./observability/logger.js";
import { getSchemaVersion, openDatabase } from "./storage/database.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const database = openDatabase(env.DATABASE_PATH);
const schemaVersion = getSchemaVersion(database);
let shuttingDown = false;

logger.info("storage.ready", { schemaVersion });

client.once(Events.ClientReady, () => {
  logger.info("discord.ready", { schemaVersion });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "health") {
      await executeHealthCommand(interaction, schemaVersion);
    }
  } catch (error) {
    logger.error("discord.interaction.failed", error, {
      commandName: interaction.commandName,
      ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
      userId: interaction.user.id,
    });

    const reply = {
      content: "The command could not be completed. Please try again later.",
      flags: MessageFlags.Ephemeral as const,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

client.on(Events.Error, (error) => {
  logger.error("discord.client.error", error);
});

function shutdown(signal: "SIGINT" | "SIGTERM"): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("process.shutdown", { signal });
  client.destroy();
  database.close();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

try {
  await client.login(env.DISCORD_BOT_TOKEN);
} catch (error) {
  logger.error("discord.login.failed", error);
  database.close();
  process.exitCode = 1;
}

