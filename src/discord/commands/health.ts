import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";

export const healthCommand = new SlashCommandBuilder()
  .setName("health")
  .setDescription("Check whether the bot is responding.");

export async function executeHealthCommand(
  interaction: ChatInputCommandInteraction,
  schemaVersion: number,
): Promise<void> {
  await interaction.reply({
    content: `The bot is online and responding. SQLite storage is ready (schema v${schemaVersion}).`,
    flags: MessageFlags.Ephemeral,
  });
}

