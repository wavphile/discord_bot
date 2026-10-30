import {
  ChannelType,
  escapeMarkdown,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
  type GuildTextBasedChannel,
} from "discord.js";
import type { Guild, GuildMember } from "discord.js";
import {
  AiInputLimitError,
  AiProviderError,
  AiUsageLimitError,
} from "../../ai/errors.js";
import type { AiProvider } from "../../ai/types.js";
import {
  buildMessageQuestionEvidence,
  type MessageQuestionEvidence,
  type MessageProviderId,
} from "../../features/message-retrieval.js";
import {
  generateForGuild,
  type AiGenerationLimits,
} from "../../features/ai-generation.js";
import {
  buildMessageSummaryPrompt,
  parseMessageSummary,
  selectMessageSummarySources,
} from "../../features/message-summaries.js";
import { logger } from "../../observability/logger.js";
import { getMessageRetrievalSettings } from "../../storage/message-retrieval.js";
import {
  getMessageChannelAccessError,
  isSupportedMessageChannel,
  isSupportedMessageChannelOption,
  isThreadType,
} from "../message-access.js";
import {
  unavailableGatewayCapabilityMessage,
  type GatewayCapabilities,
} from "../gateway-capabilities.js";
import type { DatabaseSync } from "node:sqlite";

export const summarizeCommand = new SlashCommandBuilder()
  .setName("summarize")
  .setDescription("Summarize bounded recent messages with source links.")
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("Admin-enabled channel or thread to summarize.")
      .addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      )
      .setRequired(true),
  );

type SummaryFailure = Readonly<{ ok: false; message: string }>;

export async function executeSummarizeCommand(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
  defaultProviderId: MessageProviderId,
  providers: ReadonlyMap<string, AiProvider>,
  limits: AiGenerationLimits,
  gatewayCapabilities: GatewayCapabilities,
): Promise<void> {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  if (!guild || !guildId) {
    await interaction.reply({
      content: "This command can only be used in the configured test server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const selectedChannel = interaction.options.getChannel("channel", true);
  if (!isSupportedMessageChannelOption(selectedChannel)) {
    await interaction.reply({
      content: "Choose a text, announcement, or thread channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!gatewayCapabilities.messageContent) {
    await interaction.reply({
      content:
        unavailableGatewayCapabilityMessage(
          "messageContent",
          gatewayCapabilities,
        ) ?? "Message content access is not enabled.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const initialSettings = getMessageRetrievalSettings(
    database,
    guildId,
    defaultProviderId,
  );
  if (!initialSettings.enabled) {
    await interaction.reply({
      content:
        "Message retrieval is disabled for this server. A server administrator must enable it and allow the selected channel with /messages config enable.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const initialProvider = providers.get(initialSettings.provider);
  if (!initialProvider) {
    await interaction.reply({
      content:
        "The server's selected AI provider is not configured locally. Ask a server administrator to choose an available provider.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const prepared = await prepareSummaryEvidence({
    interaction,
    guild,
    guildId,
    database,
    defaultProviderId,
    providers,
    gatewayCapabilities,
  });
  if (!prepared.ok) {
    await interaction.editReply(prepared.message);
    return;
  }

  let completion;
  try {
    const prompt = buildMessageSummaryPrompt(prepared.evidence);
    completion = await generateForGuild(
      database,
      prepared.provider,
      guildId,
      prompt,
      limits,
    );
  } catch (error) {
    if (error instanceof AiInputLimitError) {
      await interaction.editReply(
        "The selected messages exceed the configured input limit. Ask a server administrator to lower the message count, or try again with a smaller channel history.",
      );
      return;
    }
    if (error instanceof AiUsageLimitError) {
      await interaction.editReply(
        "This server has reached its daily AI token allowance. Try again after the UTC day resets.",
      );
      return;
    }
    if (error instanceof AiProviderError) {
      logger.warn("ai.message_summary.failed", {
        commandName: "summarize",
        guildId,
        userId: interaction.user.id,
      });
      await interaction.editReply(
        error.kind === "configuration"
          ? "The configured AI provider is not ready. Check its local provider settings."
          : "The AI provider could not complete this request. Try again later.",
      );
      return;
    }
    throw error;
  }

  const parsedSummary = parseMessageSummary(
    completion.text,
    prepared.evidence.sources,
  );
  const mockFallback =
    !parsedSummary.ok && prepared.provider.id === "mock"
      ? {
          summary: {
            summary: completion.text,
            sourceIds: prepared.evidence.sources
              .slice(-3)
              .map((source) => source.sourceId),
          },
        }
      : null;
  const selectedSummary = parsedSummary.ok
    ? parsedSummary.summary
    : mockFallback?.summary;
  const sources = selectedSummary
    ? selectMessageSummarySources(selectedSummary, prepared.evidence.sources)
    : null;
  if (!selectedSummary || !sources || sources.length === 0) {
    await interaction.editReply(
      "The provider did not return a valid source-linked summary, so no summary was shared.",
    );
    return;
  }

  const stillAuthorized = await verifyCurrentSummaryAccess({
    guild,
    guildId,
    userId: interaction.user.id,
    channelId: prepared.channel.id,
    parentChannelId: isThreadType(prepared.channel.type)
      ? prepared.channel.parentId
      : prepared.channel.id,
    expectedProvider: prepared.provider.id as MessageProviderId,
    database,
    defaultProviderId,
    gatewayCapabilities,
  });
  if (!stillAuthorized) {
    await interaction.editReply(
      "The summary was not returned because channel access or message-retrieval settings changed while it was being generated.",
    );
    return;
  }

  await interaction.editReply({
    content: formatMessageSummary(
      selectedSummary.summary,
      sources,
      prepared.evidence,
      prepared.provider.id,
      mockFallback !== null,
    ),
    allowedMentions: { parse: [] },
  });
}

async function prepareSummaryEvidence(
  input: Readonly<{
    interaction: ChatInputCommandInteraction;
    guild: Guild;
    guildId: string;
    database: DatabaseSync;
    defaultProviderId: MessageProviderId;
    providers: ReadonlyMap<string, AiProvider>;
    gatewayCapabilities: GatewayCapabilities;
  }>,
): Promise<
  | Readonly<{
      ok: true;
      channel: GuildTextBasedChannel;
      provider: AiProvider;
      evidence: MessageQuestionEvidence;
    }>
  | SummaryFailure
> {
  const selectedChannel = input.interaction.options.getChannel("channel", true);
  let requester: GuildMember;
  let channel: GuildBasedChannel | null;
  try {
    [requester, channel] = await Promise.all([
      input.guild.members.fetch({
        user: input.interaction.user.id,
        force: true,
      }),
      input.guild.channels.fetch(selectedChannel.id, { force: true }),
    ]);
  } catch {
    return {
      ok: false,
      message:
        "The bot cannot currently access that channel or verify your membership. Recheck current channel permissions and private-thread membership.",
    };
  }

  if (
    !channel ||
    !isSupportedMessageChannel(channel) ||
    channel.guildId !== input.guildId
  ) {
    return {
      ok: false,
      message: "That channel or thread is not available for summaries here.",
    };
  }
  const configuredChannelId = isThreadType(channel.type)
    ? channel.parentId
    : channel.id;
  let settings = getMessageRetrievalSettings(
    input.database,
    input.guildId,
    input.defaultProviderId,
  );
  if (
    !settings.enabled ||
    !settings.channelIds.includes(configuredChannelId ?? "")
  ) {
    return {
      ok: false,
      message:
        "Message retrieval is disabled for this channel. A server administrator must enable it with /messages config enable.",
    };
  }

  let botMember: GuildMember;
  try {
    botMember = await input.guild.members.fetchMe();
  } catch {
    return {
      ok: false,
      message: "The bot's current channel access could not be verified.",
    };
  }
  const accessError = await getMessageChannelAccessError(
    channel,
    requester,
    botMember,
    input.gatewayCapabilities,
  );
  if (accessError) return { ok: false, message: accessError };

  settings = getMessageRetrievalSettings(
    input.database,
    input.guildId,
    input.defaultProviderId,
  );
  if (
    !settings.enabled ||
    !settings.channelIds.includes(configuredChannelId ?? "")
  ) {
    return {
      ok: false,
      message:
        "Message retrieval was disabled for this channel before the request could read its history.",
    };
  }
  const provider = input.providers.get(settings.provider);
  if (!provider) {
    return {
      ok: false,
      message:
        "The server's selected AI provider is not configured locally. Ask a server administrator to choose an available provider.",
    };
  }

  let fetched;
  try {
    fetched = await channel.messages.fetch({ limit: settings.maxMessages });
  } catch {
    return {
      ok: false,
      message:
        "The selected message history could not be read. Recheck current channel and thread permissions, then try again.",
    };
  }

  const result = buildMessageQuestionEvidence({
    question: "Summarize the recent discussion in this selected channel.",
    guildId: input.guildId,
    channelId: channel.id,
    channelName: channel.name,
    messages: fetched
      .filter((message) => !message.author.bot)
      .map((message) => ({
        guildId: message.guildId ?? "",
        channelId: message.channelId,
        messageId: message.id,
        authorId: message.author.id,
        authorName: message.member?.displayName ?? message.author.username,
        createdAt: message.createdAt.toISOString(),
        content: message.content,
      })),
    maxAgeDays: settings.maxAgeDays,
    maxMessages: settings.maxMessages,
  });
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "no_recent_messages"
          ? "No messages with readable text were found within the configured age and count limits."
          : "The selected message evidence could not be validated safely.",
    };
  }

  return { ok: true, channel, provider, evidence: result.evidence };
}

async function verifyCurrentSummaryAccess(
  input: Readonly<{
    guild: Guild;
    guildId: string;
    userId: string;
    channelId: string;
    parentChannelId: string | null;
    expectedProvider: MessageProviderId;
    database: DatabaseSync;
    defaultProviderId: MessageProviderId;
    gatewayCapabilities: GatewayCapabilities;
  }>,
): Promise<boolean> {
  const currentSettings = getMessageRetrievalSettings(
    input.database,
    input.guildId,
    input.defaultProviderId,
  );
  if (
    !currentSettings.enabled ||
    !currentSettings.channelIds.includes(input.parentChannelId ?? "") ||
    currentSettings.provider !== input.expectedProvider
  ) {
    return false;
  }

  try {
    const [requester, channel, botMember] = await Promise.all([
      input.guild.members.fetch({ user: input.userId, force: true }),
      input.guild.channels.fetch(input.channelId, { force: true }),
      input.guild.members.fetchMe(),
    ]);
    if (
      !channel ||
      !isSupportedMessageChannel(channel) ||
      channel.guildId !== input.guildId ||
      (isThreadType(channel.type) ? channel.parentId : channel.id) !==
        input.parentChannelId
    ) {
      return false;
    }
    const latestSettings = getMessageRetrievalSettings(
      input.database,
      input.guildId,
      input.defaultProviderId,
    );
    if (
      !latestSettings.enabled ||
      latestSettings.provider !== input.expectedProvider ||
      !latestSettings.channelIds.includes(input.parentChannelId ?? "")
    ) {
      return false;
    }
    return (
      (await getMessageChannelAccessError(
        channel,
        requester,
        botMember,
        input.gatewayCapabilities,
      )) === null
    );
  } catch {
    return false;
  }
}

function formatMessageSummary(
  summary: string,
  sources: readonly { sourceId: number; messageId: string }[],
  evidence: MessageQuestionEvidence,
  providerId: string,
  mockFallback: boolean,
): string {
  const label =
    providerId === "mock" || mockFallback
      ? "**Mock provider test output; this is not a factual summary.**"
      : "**AI-generated summary of recent channel messages**";
  const sourceLines = sources.map(
    (source) =>
      `[Message ${source.sourceId}](https://discord.com/channels/${evidence.guildId}/${evidence.channelId}/${source.messageId})`,
  );
  const footer = [
    `**Sources** ${sourceLines.join(" · ")}`,
    `Channel: ${escapeMarkdown(evidence.channelName)}. Retrieved <t:${Math.floor(Date.parse(evidence.retrievedAt) / 1_000)}:F> from ${evidence.messageCount} message(s), between <t:${Math.floor(Date.parse(evidence.oldestMessageAt) / 1_000)}:F> and <t:${Math.floor(Date.parse(evidence.newestMessageAt) / 1_000)}:F>.`,
    `Configured bounds: at most ${evidence.maxMessages} message(s) from the previous ${evidence.maxAgeDays} day(s). Message content is fetched on demand and not stored.`,
  ].join("\n");
  const heading = `${label}\n\n`;
  const footerBlock = `\n\n${footer}`;
  const availableSummaryLength = Math.max(
    0,
    1_900 - heading.length - footerBlock.length,
  );
  const safeSummary = escapeUntrustedText(summary.trim());
  const clippedSummary =
    safeSummary.length > availableSummaryLength
      ? `${safeSummary.slice(0, Math.max(0, availableSummaryLength - 1)).trimEnd()}…`
      : safeSummary;
  return `${heading}${clippedSummary}${footerBlock}`;
}

function escapeUntrustedText(value: string): string {
  return escapeMarkdown(value).replace(/@(everyone|here)/gi, "@​$1");
}
