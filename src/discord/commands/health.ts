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
): Promise<void> {
  await interaction.reply({
    content: "The bot is online and responding.",
    flags: MessageFlags.Ephemeral,
  });
}

