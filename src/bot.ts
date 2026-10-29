import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type BaseInteraction,
} from "discord.js";
import { env } from "./config/env.js";
import { authorizeInteraction } from "./core/authorization.js";
import { executeHealthCommand } from "./discord/commands/health.js";
import { executeServerCommand } from "./discord/commands/server.js";
import { logger } from "./observability/logger.js";
import { getSchemaVersion, openDatabase } from "./storage/database.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const database = openDatabase(env.DATABASE_PATH);
const schemaVersion = getSchemaVersion(database);
const authorizationPolicy = {
  guildId: env.DISCORD_DEV_GUILD_ID,
  allowedUserIds: new Set(env.DISCORD_ALLOWED_USER_IDS),
  allowedRoleIds: new Set(env.DISCORD_ALLOWED_ROLE_IDS),
};
let shuttingDown = false;

logger.info("storage.ready", { schemaVersion });
if (
  authorizationPolicy.allowedUserIds.size === 0 &&
  authorizationPolicy.allowedRoleIds.size === 0
) {
  logger.warn("authorization.allowlist.empty");
}

client.once(Events.ClientReady, () => {
  logger.info("discord.ready", { schemaVersion });
});

client.on(Events.InteractionCreate, async (interaction) => {
  const decision = authorizeInteraction(
    {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      roleIds: interactionRoleIds(interaction),
    },
    authorizationPolicy,
  );

  if (!decision.allowed) {
    logger.warn("authorization.interaction.denied", {
      ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
      userId: interaction.user.id,
    });
    await denyInteraction(interaction);
    return;
  }

  if (interaction.isAutocomplete()) {
    await interaction.respond([]);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "health") {
      await executeHealthCommand(interaction, schemaVersion);
    } else if (interaction.commandName === "server") {
      await executeServerCommand(interaction, client, database);
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

function interactionRoleIds(interaction: BaseInteraction): ReadonlySet<string> {
  if (!interaction.inGuild() || !interaction.member) return new Set();

  const roles = interaction.member.roles;
  return "cache" in roles ? new Set(roles.cache.keys()) : new Set(roles);
}

async function denyInteraction(interaction: BaseInteraction): Promise<void> {
  if (interaction.isAutocomplete()) {
    await interaction.respond([]);
    return;
  }

  if (!interaction.isRepliable()) return;
  await interaction.reply({
    content: "You are not authorized to use this bot here.",
    flags: MessageFlags.Ephemeral,
  });
}

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
