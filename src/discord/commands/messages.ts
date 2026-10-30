import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type {
  ChatInputCommandInteraction,
  GuildBasedChannel,
} from "discord.js";
import type { DatabaseSync } from "node:sqlite";
import type { AiProvider } from "../../ai/types.js";
import type { GatewayCapabilities } from "../gateway-capabilities.js";
import { unavailableGatewayCapabilityMessage } from "../gateway-capabilities.js";
import type {
  MessageProviderId,
  MessageRetrievalSettings,
} from "../../features/message-retrieval.js";
import {
  getMessageRetrievalSettings,
  setMessageRetrievalSettings,
} from "../../storage/message-retrieval.js";
import {
  disableMessageRetention,
  enableMessageRetention,
  getMessageRetentionSettings,
  purgeExpiredMessages,
  purgeStoredMessages,
} from "../../storage/message-retention.js";

const maximumChannelCount = 25;

export const messagesCommand = new SlashCommandBuilder()
  .setName("messages")
  .setDescription("Configure opt-in, bounded message analysis.")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("status")
      .setDescription("Show the current message analysis settings."),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("config")
      .setDescription("Change server message analysis settings.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("enable")
          .setDescription("Allow retrieval from one text channel.")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("Text channel whose recent messages may be read.")
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
              )
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("disable")
          .setDescription("Remove one channel or disable message retrieval.")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("Channel to remove; omit to disable the feature.")
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
              ),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("limits")
          .setDescription("Set the maximum lookback age and message count.")
          .addIntegerOption((option) =>
            option
              .setName("max_age_days")
              .setDescription(
                "Maximum message age eligible for retrieval (1–7).",
              )
              .setMinValue(1)
              .setMaxValue(7),
          )
          .addIntegerOption((option) =>
            option
              .setName("max_messages")
              .setDescription("Maximum messages included in one answer (1–50).")
              .setMinValue(1)
              .setMaxValue(50),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("provider")
          .setDescription("Select the provider used for message questions.")
          .addStringOption((option) =>
            option
              .setName("provider")
              .setDescription("Provider configured locally for this bot.")
              .addChoices(
                { name: "Mock test output", value: "mock" },
                { name: "OpenAI", value: "openai" },
              )
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("storage-enable")
          .setDescription("Opt a text channel and its threads into retention.")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("Text channel whose new messages may be stored.")
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
              )
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("retention_days")
              .setDescription("Maximum message retention period (1–7 days).")
              .setMinValue(1)
              .setMaxValue(7)
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("storage-disable")
          .setDescription("Stop retention and delete stored messages.")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription(
                "Channel to disable; omit to disable this server.",
              )
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
              ),
          ),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("purge")
      .setDescription("Delete retained messages without disabling storage.")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Channel to purge; omit to purge this server.")
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
          ),
      )
      .addBooleanOption((option) =>
        option
          .setName("confirm")
          .setDescription("Confirm permanent deletion of retained messages.")
          .setRequired(true),
      ),
  );

export async function executeMessagesCommand(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
  defaultProvider: MessageProviderId,
  availableProviders: ReadonlyMap<string, AiProvider>,
  gatewayCapabilities: GatewayCapabilities = {
    guildMembers: false,
    messageContent: false,
  },
): Promise<void> {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  if (!guild || !guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "status") {
    await interaction.reply({
      content: formatSettings(
        getMessageRetrievalSettings(database, guildId, defaultProvider),
        getMessageRetentionSettings(database, guildId),
      ),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const actor = await guild.members.fetch({
    user: interaction.user.id,
    force: true,
  });
  if (!actor.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: "Manage Server permission is required to change these settings.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const current = getMessageRetrievalSettings(
    database,
    guildId,
    defaultProvider,
  );
  const group = interaction.options.getSubcommandGroup();

  if (subcommand === "purge") {
    const channel = interaction.options.getChannel("channel");
    if (!interaction.options.getBoolean("confirm")) {
      await interaction.reply({
        content:
          "Confirm the destructive action by running `/messages purge confirm:true`. No messages were deleted.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (channel && !isAllowedConfigurationChannel(channel, guildId)) {
      await interaction.reply({
        content: "Choose a text or announcement channel from this server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const deleted = purgeStoredMessages(database, guildId, channel?.id);
    await interaction.reply({
      content: `Purged ${deleted} retained message(s)${channel ? ` from ${channel} and its threads` : " from this server"}. Retention settings remain enabled, so future eligible messages may be stored.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (group !== "config") return;

  if (subcommand === "enable") {
    const channel = interaction.options.getChannel("channel", true);
    if (!isAllowedConfigurationChannel(channel, guildId)) {
      await interaction.reply({
        content: "Choose a text or announcement channel from this server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const channelIds = current.channelIds.includes(channel.id)
      ? [...current.channelIds]
      : [...current.channelIds, channel.id];
    if (channelIds.length > maximumChannelCount) {
      await interaction.reply({
        content: `A server can enable at most ${maximumChannelCount} channels.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    saveSettings(database, guildId, { ...current, enabled: true, channelIds });
    await interaction.reply({
      content: `Message retrieval is enabled for ${channel}. Content is fetched only for an explicit /ask request and is not stored. The Message Content capability must also be enabled locally.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "disable") {
    const channel = interaction.options.getChannel("channel");
    if (channel && !isAllowedConfigurationChannel(channel, guildId)) {
      await interaction.reply({
        content: "Choose a text or announcement channel from this server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const channelIds = channel
      ? current.channelIds.filter((channelId) => channelId !== channel.id)
      : [...current.channelIds];
    const enabled = channel ? current.enabled && channelIds.length > 0 : false;
    saveSettings(database, guildId, { ...current, enabled, channelIds });
    await interaction.reply({
      content: channel
        ? `Message retrieval is ${enabled ? "still enabled" : "now disabled"} for this server. ${channel} was removed.`
        : "Message retrieval is disabled for this server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "limits") {
    const maxAgeDays = interaction.options.getInteger("max_age_days");
    const maxMessages = interaction.options.getInteger("max_messages");
    if (maxAgeDays === null && maxMessages === null) {
      await interaction.reply({
        content: "Set max_age_days, max_messages, or both.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    saveSettings(database, guildId, {
      ...current,
      ...(maxAgeDays === null ? {} : { maxAgeDays }),
      ...(maxMessages === null ? {} : { maxMessages }),
    });
    await interaction.reply({
      content: `Updated retrieval limits. ${formatSettings(getMessageRetrievalSettings(database, guildId, defaultProvider), getMessageRetentionSettings(database, guildId))}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "provider") {
    const provider = interaction.options.getString(
      "provider",
      true,
    ) as MessageProviderId;
    if (!availableProviders.has(provider)) {
      await interaction.reply({
        content:
          provider === "openai"
            ? "The OpenAI provider is not configured locally. Configure OPENAI_API_KEY and restart the bot before selecting it."
            : "That provider is not available.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    saveSettings(database, guildId, { ...current, provider });
    await interaction.reply({
      content: `Message questions will use the ${provider} provider. ${provider === "openai" ? "Review the documented provider data handling before enabling message analysis." : "Mock responses are test output, not factual answers."}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "storage-enable") {
    const channel = interaction.options.getChannel("channel", true);
    const retentionDays = interaction.options.getInteger(
      "retention_days",
      true,
    );
    if (!isAllowedConfigurationChannel(channel, guildId)) {
      await interaction.reply({
        content: "Choose a text or announcement channel from this server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const capabilityMessage = unavailableGatewayCapabilityMessage(
      "messageContent",
      gatewayCapabilities,
    );
    if (capabilityMessage) {
      await interaction.reply({
        content: capabilityMessage,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const botChannel = await guild.channels.fetch(channel.id).catch(() => null);
    if (!botChannel || !isAllowedConfigurationChannel(botChannel, guildId)) {
      await interaction.reply({
        content: "The selected channel could not be fetched from this server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const currentRetention = getMessageRetentionSettings(database, guildId);
    if (
      !currentRetention.channels.some(
        (entry) => entry.channelId === botChannel.id,
      ) &&
      currentRetention.channels.length >= maximumChannelCount
    ) {
      await interaction.reply({
        content: `A server can retain messages from at most ${maximumChannelCount} channels.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const botMember = guild.members.me ?? (await guild.members.fetchMe());
    const botPermissions = (botChannel as GuildBasedChannel).permissionsFor(
      botMember,
    );
    if (
      !botPermissions?.has(PermissionFlagsBits.ViewChannel) ||
      !botPermissions.has(PermissionFlagsBits.ReadMessageHistory)
    ) {
      await interaction.reply({
        content:
          "The bot needs current View Channel and Read Message History access before retention can be enabled.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    enableMessageRetention(database, guildId, botChannel.id, retentionDays);
    purgeExpiredMessages(database);
    await interaction.reply({
      content: `Message retention is enabled for ${botChannel} and its threads. New human-authored message text is stored in this bot's local SQLite database for up to ${retentionDays} day(s); edits do not extend expiry.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "storage-disable") {
    const channel = interaction.options.getChannel("channel");
    if (channel && !isAllowedConfigurationChannel(channel, guildId)) {
      await interaction.reply({
        content: "Choose a text or announcement channel from this server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const deleted = disableMessageRetention(database, guildId, channel?.id);
    await interaction.reply({
      content: channel
        ? `Retention is disabled for ${channel} and its threads. ${deleted} stored message(s) were deleted.`
        : `Retention is disabled for this server. ${deleted} stored message(s) were deleted.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

function saveSettings(
  database: DatabaseSync,
  guildId: string,
  settings: MessageRetrievalSettings,
): void {
  setMessageRetrievalSettings(database, guildId, settings);
}

function isAllowedConfigurationChannel(
  channel: {
    id: string;
    type: ChannelType;
    guildId?: string | null;
    guild_id?: string;
  },
  guildId: string,
): boolean {
  const channelGuildId = channel.guildId ?? channel.guild_id;
  return (
    channelGuildId === guildId &&
    (channel.type === ChannelType.GuildText ||
      channel.type === ChannelType.GuildAnnouncement)
  );
}

function formatSettings(
  settings: MessageRetrievalSettings,
  retention: ReturnType<typeof getMessageRetentionSettings>,
): string {
  const channels =
    settings.channelIds.length > 0
      ? settings.channelIds.map((channelId) => `<#${channelId}>`).join(", ")
      : "none";
  const storageChannels =
    retention.channels.length > 0
      ? retention.channels
          .map(
            (channel) =>
              `<#${channel.channelId}> (${channel.retentionDays} day(s))`,
          )
          .join(", ")
      : "none";
  return [
    `Message retrieval: ${settings.enabled ? "enabled" : "disabled"}`,
    `Allowed channels: ${channels}`,
    `Maximum lookback: ${settings.maxAgeDays} day(s)`,
    `Maximum messages per request: ${settings.maxMessages}`,
    `Provider: ${settings.provider}`,
    `Message retention: ${retention.channels.length > 0 ? "enabled" : "disabled"}`,
    `Storage channels: ${storageChannels}`,
    "Each channel's retention period starts at the message's original timestamp.",
    "On-demand retrieval does not itself store messages.",
  ].join("\n");
}
