import { Client, Events, MessageFlags, type BaseInteraction } from "discord.js";
import { env } from "./config/env.js";
import { createAiProviders } from "./ai/index.js";
import {
  authorizeInteraction,
  authorizePlanApprover,
} from "./core/authorization.js";
import { executeHealthCommand } from "./discord/commands/health.js";
import { executeAskCommand } from "./discord/commands/ask.js";
import { executePlanCommand } from "./discord/commands/plan.js";
import { executePermissionsCommand } from "./discord/commands/permissions.js";
import { executeServerCommand } from "./discord/commands/server.js";
import { executeMessagesCommand } from "./discord/commands/messages.js";
import { executeSummarizeCommand } from "./discord/commands/summarize.js";
import {
  createDiscordPlanJobAdapter,
  DurablePlanJobRunner,
} from "./discord/plan-job-runner.js";
import { logger } from "./observability/logger.js";
import { getSchemaVersion, openDatabase } from "./storage/database.js";
import {
  createGatewayIntents,
  isDisallowedGatewayIntentsError,
} from "./discord/gateway-capabilities.js";

const gatewayCapabilities = {
  guildMembers: env.DISCORD_ENABLE_GUILD_MEMBERS_INTENT,
  messageContent: env.DISCORD_ENABLE_MESSAGE_CONTENT_INTENT,
};
const client = new Client({
  intents: createGatewayIntents(gatewayCapabilities),
});
const aiProviders = createAiProviders(env);
const aiProvider = aiProviders.get(env.AI_PROVIDER);
if (!aiProvider) throw new Error("The configured AI provider is unavailable.");
const database = openDatabase(env.DATABASE_PATH);
const schemaVersion = getSchemaVersion(database);
const authorizationPolicy = {
  guildId: env.DISCORD_DEV_GUILD_ID,
  allowedUserIds: new Set(env.DISCORD_ALLOWED_USER_IDS),
  allowedRoleIds: new Set(env.DISCORD_ALLOWED_ROLE_IDS),
};
const approvalAuthorizationPolicy = {
  guildId: env.DISCORD_DEV_GUILD_ID,
  approverUserIds: new Set(env.DISCORD_APPROVER_USER_IDS),
  approverRoleIds: new Set(env.DISCORD_APPROVER_ROLE_IDS),
};
const planJobRunner = new DurablePlanJobRunner(
  database,
  client,
  authorizationPolicy,
  createDiscordPlanJobAdapter(client, authorizationPolicy),
);
let shuttingDown = false;

logger.info("storage.ready", { schemaVersion });
if (
  authorizationPolicy.allowedUserIds.size === 0 &&
  authorizationPolicy.allowedRoleIds.size === 0
) {
  logger.warn("authorization.allowlist.empty");
}
if (
  approvalAuthorizationPolicy.approverUserIds.size === 0 &&
  approvalAuthorizationPolicy.approverRoleIds.size === 0
) {
  logger.warn("authorization.approver_allowlist.empty");
}

client.once(Events.ClientReady, () => {
  logger.info("discord.ready", { schemaVersion });
  planJobRunner.resumeOnStartup();
});

client.on(Events.InteractionCreate, async (interaction) => {
  const request = {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    roleIds: interactionRoleIds(interaction),
  };
  const decision = authorizeInteraction(request, authorizationPolicy);
  const approvalCommand =
    interaction.isChatInputCommand() &&
    interaction.commandName === "plan" &&
    ["review", "approve", "reject", "apply", "cancel", "status"].includes(
      interaction.options.getSubcommand(false) ?? "",
    );
  const approverDecision = approvalCommand
    ? authorizePlanApprover(request, approvalAuthorizationPolicy)
    : { allowed: false as const };

  if (!decision.allowed && !approverDecision.allowed) {
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
      await executeHealthCommand(
        interaction,
        schemaVersion,
        gatewayCapabilities,
      );
    } else if (interaction.commandName === "ask") {
      await executeAskCommand(
        interaction,
        database,
        aiProvider,
        {
          maxInputTokens: env.AI_MAX_INPUT_TOKENS,
          maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
          dailyTokenBudgetPerGuild: env.AI_DAILY_TOKEN_BUDGET_PER_GUILD,
          requestTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
        },
        aiProviders,
        gatewayCapabilities,
      );
    } else if (interaction.commandName === "plan") {
      await executePlanCommand(interaction, database, {
        requesterAuthorization: authorizationPolicy,
        approvalAuthorization: approvalAuthorizationPolicy,
        jobRunner: planJobRunner,
        aiProvider,
        aiLimits: {
          maxInputTokens: env.AI_MAX_INPUT_TOKENS,
          maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
          dailyTokenBudgetPerGuild: env.AI_DAILY_TOKEN_BUDGET_PER_GUILD,
          requestTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
        },
      });
    } else if (interaction.commandName === "server") {
      await executeServerCommand(interaction, client, database);
    } else if (interaction.commandName === "permissions") {
      await executePermissionsCommand(interaction);
    } else if (interaction.commandName === "messages") {
      await executeMessagesCommand(
        interaction,
        database,
        env.AI_PROVIDER,
        aiProviders,
      );
    } else if (interaction.commandName === "summarize") {
      await executeSummarizeCommand(
        interaction,
        database,
        env.AI_PROVIDER,
        aiProviders,
        {
          maxInputTokens: env.AI_MAX_INPUT_TOKENS,
          maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
          dailyTokenBudgetPerGuild: env.AI_DAILY_TOKEN_BUDGET_PER_GUILD,
          requestTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
        },
        gatewayCapabilities,
      );
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

async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("process.shutdown", { signal });
  await planJobRunner.stop();
  client.destroy();
  database.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await client.login(env.DISCORD_BOT_TOKEN);
} catch (error) {
  logger.error("discord.login.failed", error);
  if (isDisallowedGatewayIntentsError(error)) {
    logger.error("discord.login.disallowed_intents", error, {
      gatewayIntentSetupHint: true,
    });
  }
  database.close();
  process.exitCode = 1;
}
