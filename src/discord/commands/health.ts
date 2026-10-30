import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  formatConfiguredGatewayCapabilities,
  type GatewayCapabilities,
} from "../gateway-capabilities.js";

export const healthCommand = new SlashCommandBuilder()
  .setName("health")
  .setDescription("Check whether the bot is responding.");

export async function executeHealthCommand(
  interaction: ChatInputCommandInteraction,
  schemaVersion: number,
  gatewayCapabilities: GatewayCapabilities,
): Promise<void> {
  await interaction.reply({
    content: `The bot is online and responding. SQLite storage is ready (schema v${schemaVersion}). Optional Gateway intents requested: ${formatConfiguredGatewayCapabilities(gatewayCapabilities)}.`,
    flags: MessageFlags.Ephemeral,
  });
}
