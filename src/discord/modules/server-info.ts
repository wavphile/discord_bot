import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { ReadOnlyFeatureModule } from "./types.js";

const command = new SlashCommandBuilder()
  .setName("server-info")
  .setDescription("Show basic information about this server.");

async function executeServerInfo(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content:
      `Server: ${guild.name}\n` +
      `Created: <t:${Math.floor(guild.createdTimestamp / 1000)}:F>\n` +
      `Server ID: ${guild.id}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

export const serverInfoModule = {
  command,
  execute: executeServerInfo,
} satisfies ReadOnlyFeatureModule;
