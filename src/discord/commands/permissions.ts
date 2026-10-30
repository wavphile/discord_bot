import {
  ChannelType,
  escapeMarkdown,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
  type NewsChannel,
  type TextChannel,
} from "discord.js";
import {
  explainChannelPermissions,
  type ChannelPermissionOverwrite,
  type RolePermissionSource,
} from "../../features/permission-explanations.js";

export const permissionsCommand = new SlashCommandBuilder()
  .setName("permissions")
  .setDescription("Explain effective member permissions.")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("explain")
      .setDescription("Explain a member's access to a text channel.")
      .addUserOption((option) =>
        option
          .setName("member")
          .setDescription("The server member to check.")
          .setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("The text or announcement channel to check.")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      ),
  );

export async function executePermissionsCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.options.getSubcommand() !== "explain") return;

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "This command can only be used in the configured test server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const selectedUser = interaction.options.getUser("member", true);
  const selectedChannel = interaction.options.getChannel("channel", true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let member;
  let channel: GuildBasedChannel | null;
  try {
    await guild.roles.fetch(undefined, { force: true });
    member = await guild.members.fetch({ user: selectedUser.id, force: true });
    channel = await guild.channels.fetch(selectedChannel.id, { force: true });
  } catch (error) {
    if (getDiscordErrorCode(error) === 10_007) {
      await interaction.editReply(
        "That user is not a member of the configured server.",
      );
      return;
    }
    if (getDiscordErrorCode(error) === 10_003) {
      await interaction.editReply(
        "That channel is no longer available in the configured server.",
      );
      return;
    }
    if (getDiscordErrorCode(error) === 50_001) {
      await interaction.editReply(
        "The bot cannot read that channel's permission settings. Grant it View Channel access to inspect the channel.",
      );
      return;
    }
    throw error;
  }

  if (!channel || !isSupportedTextChannel(channel)) {
    await interaction.editReply(
      "Choose a text or announcement channel. Other channel types are not supported yet.",
    );
    return;
  }

  const everyoneRole = guild.roles.everyone;
  const memberRoles = [...member.roles.cache.values()]
    .filter((role) => role.id !== everyoneRole.id)
    .map(toRolePermissionSource);
  const overwrites = [...channel.permissionOverwrites.cache.values()].map(
    (overwrite): ChannelPermissionOverwrite => ({
      target: overwrite.type === OverwriteType.Role ? "role" : "member",
      id: overwrite.id,
      name:
        overwrite.id === everyoneRole.id
          ? "@everyone"
          : (guild.roles.cache.get(overwrite.id)?.name ?? "a role"),
      allow: overwrite.allow.bitfield,
      deny: overwrite.deny.bitfield,
    }),
  );

  const explanation = explainChannelPermissions({
    memberId: member.id,
    guildOwnerId: guild.ownerId,
    everyoneRole: toRolePermissionSource(everyoneRole),
    memberRoles,
    overwrites,
    isTimedOut: member.isCommunicationDisabled(),
  });

  const discordPermissions = channel.permissionsFor(member);
  const matchesDiscordJs =
    discordPermissions.has(PermissionFlagsBits.ViewChannel, false) ===
      explanation.viewChannel.rawAllowed &&
    discordPermissions.has(PermissionFlagsBits.SendMessages, false) ===
      explanation.sendMessages.rawAllowed &&
    discordPermissions.has(PermissionFlagsBits.SendMessagesInThreads, false) ===
      explanation.sendMessagesInThreads.rawAllowed;

  if (!matchesDiscordJs) {
    throw new Error("The permission explanation did not match discord.js.");
  }

  const timeoutTimestamp = member.communicationDisabledUntilTimestamp;
  const timeoutNote =
    member.isCommunicationDisabled() && timeoutTimestamp
      ? `\nActive communication timeout until <t:${Math.floor(timeoutTimestamp / 1000)}:F>.`
      : "";

  const content =
    [
      `**Permission explanation for <@${member.id}> in <#${channel.id}>**`,
      formatEvaluation("View Channel", explanation.viewChannel),
      formatEvaluation("Send Messages", explanation.sendMessages),
      formatEvaluation(
        "Send Messages in Threads",
        explanation.sendMessagesInThreads,
      ),
      "Thread replies use a separate permission. This checks the parent channel's setting; thread membership can add further restrictions.",
    ].join("\n") + timeoutNote;

  await interaction.editReply({
    content,
    allowedMentions: { parse: [] },
  });
}

function isSupportedTextChannel(
  channel: GuildBasedChannel,
): channel is TextChannel | NewsChannel {
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement
  );
}

function toRolePermissionSource(role: {
  id: string;
  name: string;
  permissions: { bitfield: bigint };
}): RolePermissionSource {
  return {
    id: role.id,
    name: role.name,
    permissions: role.permissions.bitfield,
  };
}

function formatEvaluation(
  label: string,
  evaluation: Readonly<{ allowed: boolean; details: readonly string[] }>,
): string {
  const state = evaluation.allowed ? "✅ Allowed" : "❌ Denied";
  const details = evaluation.details
    .map((detail) => `  • ${escapeUntrustedText(detail)}`)
    .join("\n");
  return `\n**${label}: ${state}**\n${details}`;
}

function escapeUntrustedText(value: string): string {
  return escapeMarkdown(value).replace(/@(everyone|here)/gi, "@​$1");
}

function getDiscordErrorCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }

  return typeof error.code === "number" ? error.code : null;
}
