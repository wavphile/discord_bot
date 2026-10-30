import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { DatabaseSync } from "node:sqlite";
import type { AiProvider } from "../../ai/types.js";
import type {
  MessageProviderId,
  MessageRetrievalSettings,
} from "../../features/message-retrieval.js";
import {
  getMessageRetrievalSettings,
  setMessageRetrievalSettings,
} from "../../storage/message-retrieval.js";

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
      ),
  );

export async function executeMessagesCommand(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
  defaultProvider: MessageProviderId,
  availableProviders: ReadonlyMap<string, AiProvider>,
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
      content: `Updated retrieval limits. ${formatSettings(getMessageRetrievalSettings(database, guildId, defaultProvider))}`,
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

function formatSettings(settings: MessageRetrievalSettings): string {
  const channels =
    settings.channelIds.length > 0
      ? settings.channelIds.map((channelId) => `<#${channelId}>`).join(", ")
      : "none";
  return [
    `Message retrieval: ${settings.enabled ? "enabled" : "disabled"}`,
    `Allowed channels: ${channels}`,
    `Maximum lookback: ${settings.maxAgeDays} day(s)`,
    `Maximum messages per request: ${settings.maxMessages}`,
    `Provider: ${settings.provider}`,
    "Retrieved message content is not stored.",
  ].join("\n");
}
