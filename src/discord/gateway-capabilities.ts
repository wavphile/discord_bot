import { GatewayIntentBits } from "discord.js";

export type GatewayCapabilities = Readonly<{
  guildMembers: boolean;
  messageContent: boolean;
}>;

export type GatewayCapability = keyof GatewayCapabilities;

export function createGatewayIntents(
  capabilities: GatewayCapabilities,
): GatewayIntentBits[] {
  const intents: GatewayIntentBits[] = [GatewayIntentBits.Guilds];
  if (capabilities.guildMembers) intents.push(GatewayIntentBits.GuildMembers);
  if (capabilities.messageContent)
    intents.push(GatewayIntentBits.MessageContent);
  return intents;
}

export function unavailableGatewayCapabilityMessage(
  capability: GatewayCapability,
  capabilities: GatewayCapabilities,
): string | undefined {
  if (capabilities[capability]) return undefined;

  if (capability === "guildMembers") {
    return "This feature needs the Server Members capability. Set DISCORD_ENABLE_GUILD_MEMBERS_INTENT=true in .env, enable Server Members Intent under Discord Developer Portal → your application → Bot → Privileged Gateway Intents, then restart the bot.";
  }

  return "This feature needs message content access. Set DISCORD_ENABLE_MESSAGE_CONTENT_INTENT=true in .env, enable Message Content Intent under Discord Developer Portal → your application → Bot → Privileged Gateway Intents, then restart the bot.";
}

export function formatConfiguredGatewayCapabilities(
  capabilities: GatewayCapabilities,
): string {
  return `Server Members ${capabilities.guildMembers ? "enabled" : "disabled"}; Message Content ${capabilities.messageContent ? "enabled" : "disabled"}`;
}

export function isDisallowedGatewayIntentsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/used disallowed intents/i.test(error.message) ||
      /\b4014\b/.test(error.message))
  );
}
