import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction, Client } from "discord.js";
import type { DatabaseSync } from "node:sqlite";
import { captureConfigurationSnapshot } from "../../features/server-inspection.js";

export const serverCommand = new SlashCommandBuilder()
  .setName("server")
  .setDescription("Inspect supported server configuration.")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("inspect")
      .setDescription("Capture a private configuration snapshot."),
  );

export async function executeServerCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  database: DatabaseSync,
): Promise<void> {
  if (interaction.options.getSubcommand() !== "inspect") return;

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "This command can only be used in the configured test server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const snapshot = await captureConfigurationSnapshot(
    client,
    database,
    guildId,
    interaction.user.id,
  );
  const categories = snapshot.payload.channels.filter(
    (channel) => channel.type === 4,
  ).length;
  const overwriteCount = snapshot.payload.channels.reduce(
    (total, channel) => total + channel.permission_overwrites.length,
    0,
  );
  const unviewable =
    snapshot.payload.visibility.returned_unviewable_channel_count;

  await interaction.editReply(
    `Captured a configuration snapshot for **${snapshot.payload.guild.name}**.\n` +
      `Snapshot ID: \`${snapshot.id}\` · Captured: <t:${Math.floor(Date.parse(snapshot.capturedAt) / 1000)}:F>\n` +
      `Included ${snapshot.payload.roles.length} roles, ${categories} categories, ` +
      `${snapshot.payload.channels.length - categories} channels, and ${overwriteCount} permission overwrites.\n` +
      `Visibility is limited to channels returned by Discord; ${unviewable} returned channel(s) are not viewable by the bot. ` +
      "This snapshot is not a complete server backup.",
  );
}
