import {
  ChannelType,
  escapeMarkdown,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
  type NewsChannel,
  type TextChannel,
  type GuildTextBasedChannel,
  type ThreadChannel,
} from "discord.js";
import type { GuildMember } from "discord.js";
import {
  AiInputLimitError,
  AiProviderError,
  AiUsageLimitError,
} from "../../ai/errors.js";
import type { AiPrompt, AiProvider } from "../../ai/types.js";
import {
  buildMessageQuestionEvidence,
  type MessageProviderId,
} from "../../features/message-retrieval.js";
import {
  buildConfigurationQuestionEvidence,
  hasCurrentViewAccess,
  MAX_QUESTION_LENGTH,
} from "../../features/configuration-questions.js";
import {
  buildMemberQuestionEvidence,
  isMemberActivityQuestion,
  type MemberQuestionEvidence,
  type MemberQuestionEvidenceError,
} from "../../features/member-questions.js";
import { generateForGuild } from "../../features/ai-generation.js";
import { logger } from "../../observability/logger.js";
import {
  getLatestConfigurationSnapshots,
  UnsupportedSnapshotSchemaVersionError,
} from "../../storage/snapshots.js";
import type { DatabaseSync } from "node:sqlite";
import type { SavedConfigurationSnapshot } from "../../storage/snapshots.js";
import { getMessageRetrievalSettings } from "../../storage/message-retrieval.js";
import {
  unavailableGatewayCapabilityMessage,
  type GatewayCapabilities,
} from "../gateway-capabilities.js";

export const askCommand = new SlashCommandBuilder()
  .setName("ask")
  .setDescription(
    "Ask a read-only question about server configuration or one member.",
  )
  .addStringOption((option) =>
    option
      .setName("question")
      .setDescription("A question about the selected channel or member.")
      .setMinLength(1)
      .setMaxLength(MAX_QUESTION_LENGTH)
      .setRequired(true),
  )
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("Optional channel for configuration or access questions.")
      .addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ),
  )
  .addUserOption((option) =>
    option
      .setName("member")
      .setDescription("Optional server member for a roles or access question."),
  )
  .addBooleanOption((option) =>
    option
      .setName("include_messages")
      .setDescription(
        "Include bounded recent messages from the selected channel.",
      ),
  );

export type AskCommandLimits = Readonly<{
  maxInputTokens: number;
  maxOutputTokens: number;
  dailyTokenBudgetPerGuild: number;
  requestTimeoutMs: number;
}>;

export async function executeAskCommand(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
  provider: AiProvider,
  limits: AskCommandLimits,
  providers: ReadonlyMap<string, AiProvider> = new Map([
    [provider.id, provider],
  ]),
  gatewayCapabilities: GatewayCapabilities = {
    guildMembers: true,
    messageContent: false,
  },
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

  const question = interaction.options.getString("question", true).trim();
  if (!question || question.length > MAX_QUESTION_LENGTH) {
    await interaction.reply({
      content: `Enter a question from 1 to ${MAX_QUESTION_LENGTH} characters.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const selectedChannel = interaction.options.getChannel("channel");
  const selectedUser = interaction.options.getUser("member");
  const includeMessages =
    interaction.options.getBoolean?.("include_messages") ?? false;
  if (!selectedChannel && !selectedUser) {
    await interaction.reply({
      content: "Select a channel, a member, or both to scope the question.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (isMemberActivityQuestion(question) && !includeMessages) {
    await interaction.reply({
      content:
        "Message activity is unavailable because this bot has not collected messages. It will not infer a member's activity from roles or server configuration.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (
    selectedChannel &&
    !(includeMessages
      ? isSupportedMessageChannelOption(selectedChannel)
      : isSupportedTextChannelOption(selectedChannel))
  ) {
    await interaction.reply({
      content: includeMessages
        ? "Choose a text, announcement, or thread channel."
        : "Choose a text or announcement channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (includeMessages && !selectedChannel) {
    await interaction.reply({
      content: "Select one channel or thread when including message evidence.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const defaultProviderId: MessageProviderId =
    provider.id === "openai" ? "openai" : "mock";
  const messageSettings = includeMessages
    ? getMessageRetrievalSettings(database, guildId, defaultProviderId)
    : null;
  if (includeMessages && (!messageSettings?.enabled || !selectedChannel)) {
    await interaction.reply({
      content:
        "Message retrieval is disabled for this server. A server administrator must enable it and allow the selected channel with /messages config enable.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (includeMessages && !gatewayCapabilities.messageContent) {
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
  const selectedProvider = includeMessages
    ? providers.get(messageSettings?.provider ?? defaultProviderId)
    : provider;
  if (!selectedProvider) {
    await interaction.reply({
      content:
        "The server's selected AI provider is not configured locally. Ask a server administrator to choose an available provider.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  let providerForGeneration = selectedProvider;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let requester: GuildMember;
  let channel: GuildBasedChannel | null = null;
  let targetMember: GuildMember | null = null;
  try {
    if (!includeMessages) {
      await guild.roles.fetch(undefined, { force: true });
    }
    [requester, channel] = await Promise.all([
      guild.members.fetch({ user: interaction.user.id, force: true }),
      selectedChannel
        ? guild.channels.fetch(selectedChannel.id, { force: true })
        : Promise.resolve(null),
    ]);
    if (selectedUser) {
      targetMember = await guild.members.fetch({
        user: selectedUser.id,
        force: true,
      });
    }
  } catch (error) {
    const code = getDiscordErrorCode(error);
    if (code === 10_007 && selectedUser) {
      await interaction.editReply("That user is not a member of this server.");
      return;
    }
    if (selectedChannel && (code === 10_003 || code === 50_001)) {
      await interaction.editReply(
        includeMessages
          ? "The bot cannot access that channel right now. Grant it View Channel and Read Message History access, then confirm private-thread membership if applicable."
          : "The bot cannot read that channel's configuration. Grant the bot View Channel access there, then capture a new /server inspect snapshot.",
      );
      return;
    }
    throw error;
  }

  if (guild.id !== guildId) {
    await interaction.editReply(
      "This command can only be used in the configured test server.",
    );
    return;
  }

  if (selectedUser && targetMember?.guild.id !== guildId) {
    await interaction.editReply("That user is not a member of this server.");
    return;
  }

  let prompt: AiPrompt;
  let formatResponse: (answer: string) => string;
  if (includeMessages) {
    if (
      !channel ||
      !isSupportedMessageChannel(channel) ||
      channel.guildId !== guildId ||
      !messageSettings ||
      !selectedChannel
    ) {
      await interaction.editReply(
        "That channel or thread is not available for message analysis in this server.",
      );
      return;
    }
    const configuredChannelId = isThreadType(channel.type)
      ? channel.parentId
      : channel.id;
    if (!messageSettings.channelIds.includes(configuredChannelId ?? "")) {
      await interaction.editReply(
        "The selected channel is not enabled for message retrieval by a server administrator.",
      );
      return;
    }
    let botMember: GuildMember;
    try {
      botMember = await guild.members.fetchMe();
    } catch {
      await interaction.editReply(
        "The bot's current channel access could not be verified. Try again later.",
      );
      return;
    }
    const accessError = await getMessageChannelAccessError(
      channel,
      requester,
      botMember,
      gatewayCapabilities,
    );
    if (accessError) {
      await interaction.editReply(accessError);
      return;
    }

    const currentSettings = getMessageRetrievalSettings(
      database,
      guildId,
      defaultProviderId,
    );
    const currentConfiguredChannelId = isThreadType(channel.type)
      ? channel.parentId
      : channel.id;
    if (
      !currentSettings.enabled ||
      !currentSettings.channelIds.includes(currentConfiguredChannelId ?? "")
    ) {
      await interaction.editReply(
        "Message retrieval was disabled for this channel before the request could read its history.",
      );
      return;
    }
    const currentProvider = providers.get(currentSettings.provider);
    if (!currentProvider) {
      await interaction.editReply(
        "The server's selected AI provider is not configured locally. Ask a server administrator to choose an available provider.",
      );
      return;
    }
    providerForGeneration = currentProvider;

    let fetched;
    try {
      fetched = await channel.messages.fetch({
        limit: currentSettings.maxMessages,
      });
    } catch {
      await interaction.editReply(
        "The selected message history could not be read. Recheck current channel and thread permissions, then try again.",
      );
      return;
    }
    const result = buildMessageQuestionEvidence({
      question,
      guildId,
      channelId: channel.id,
      channelName: channel.name,
      messages: fetched
        .filter((message) => !message.author.bot)
        .filter(
          (message) => !selectedUser || message.author.id === selectedUser.id,
        )
        .map((message) => ({
          guildId: message.guildId ?? "",
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.author.id,
          authorName: message.member?.displayName ?? message.author.username,
          createdAt: message.createdAt.toISOString(),
          content: message.content,
        })),
      maxAgeDays: currentSettings.maxAgeDays,
      maxMessages: currentSettings.maxMessages,
    });
    if (!result.ok) {
      await interaction.editReply(
        result.reason === "no_recent_messages"
          ? "No messages with readable text were found within the configured age and count limits."
          : "The selected message evidence could not be validated safely.",
      );
      return;
    }
    prompt = result.evidence.prompt;
    formatResponse = (answer) =>
      formatMessageAnswer(answer, result.evidence, currentProvider.id);
  } else if (selectedChannel) {
    if (
      !channel ||
      !isSupportedTextChannel(channel) ||
      channel.guildId !== guildId
    ) {
      await interaction.editReply(
        "That channel is not an available text or announcement channel in this server.",
      );
      return;
    }
    if (!hasCurrentViewAccess(channel.permissionsFor(requester) ?? null)) {
      await interaction.editReply(
        "You need current View Channel access to the selected channel before asking about its configuration.",
      );
      return;
    }

    let snapshot;
    try {
      snapshot = getLatestConfigurationSnapshots(database, guildId, 1)[0];
    } catch (error) {
      if (error instanceof UnsupportedSnapshotSchemaVersionError) {
        await interaction.editReply(
          "The latest server snapshot uses a different schema. Run /server inspect with the current bot version and try again.",
        );
        return;
      }
      throw error;
    }
    if (!snapshot) {
      await interaction.editReply(
        "There is no saved configuration snapshot yet. Run /server inspect, then try /ask again.",
      );
      return;
    }

    const now = new Date();
    const result = buildConfigurationQuestionEvidence({
      question,
      channelId: channel.id,
      snapshot,
      ...(targetMember
        ? {
            member: {
              id: targetMember.id,
              roleIds: [...targetMember.roles.cache.keys()],
              guildOwnerId: guild.ownerId,
              isTimedOut: targetMember.isCommunicationDisabled(),
            },
          }
        : {}),
      now,
    });
    if (!result.ok) {
      await interaction.editReply(
        formatEvidenceProblem(result.reason, snapshot),
      );
      return;
    }
    prompt = result.evidence.prompt;
    formatResponse = (answer) =>
      formatAnswer(answer, result.evidence, provider.id);
  } else {
    if (!selectedUser || !targetMember) {
      await interaction.editReply(
        "Choose a member in the configured test server.",
      );
      return;
    }

    const roles = new Map([[guild.roles.everyone.id, guild.roles.everyone]]);
    for (const role of targetMember.roles.cache.values()) {
      roles.set(role.id, role);
    }
    const now = new Date();
    const timeoutTimestamp = targetMember.communicationDisabledUntilTimestamp;
    const result = buildMemberQuestionEvidence({
      question,
      guildId,
      member: {
        id: targetMember.id,
        guildId: targetMember.guild.id,
        roles: [...roles.values()].map((role) => ({
          id: role.id,
          guildId: role.guild.id,
          name: role.name,
          permissions: role.permissions.toArray(),
        })),
        joinedAt: targetMember.joinedAt?.toISOString() ?? null,
        isServerOwner: targetMember.id === guild.ownerId,
        isTimedOut: targetMember.isCommunicationDisabled(),
        timeoutUntil:
          timeoutTimestamp === null
            ? null
            : new Date(timeoutTimestamp).toISOString(),
      },
      now,
    });
    if (!result.ok) {
      await interaction.editReply(formatMemberEvidenceProblem(result.reason));
      return;
    }
    prompt = result.evidence.prompt;
    formatResponse = (answer) =>
      formatMemberAnswer(answer, result.evidence, provider.id);
  }

  try {
    const completion = await generateForGuild(
      database,
      providerForGeneration,
      guildId,
      prompt,
      limits,
    );
    await interaction.editReply({
      content: formatResponse(completion.text),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    if (error instanceof AiInputLimitError) {
      await interaction.editReply(
        "The selected evidence and question exceed the configured input limit. Try a shorter question or a smaller evidence scope.",
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
      logger.warn("ai.configuration_question.failed", {
        commandName: "ask",
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
}

function formatEvidenceProblem(
  reason:
    | "invalid_question"
    | "invalid_snapshot"
    | "stale_snapshot"
    | "channel_not_in_snapshot"
    | "channel_not_viewable"
    | "role_data_missing",
  snapshot: SavedConfigurationSnapshot,
): string {
  switch (reason) {
    case "invalid_question":
      return `Enter a question from 1 to ${MAX_QUESTION_LENGTH} characters.`;
    case "stale_snapshot":
      return `The latest snapshot is missing a valid capture time or is older than 24 hours (captured ${formatTimestamp(snapshot.capturedAt)}). Run /server inspect to refresh it.`;
    case "channel_not_in_snapshot":
      return "The selected channel was not included in the latest snapshot. Grant the bot View Channel access there and run /server inspect again.";
    case "channel_not_viewable":
      return "The latest snapshot says the bot could not view the selected channel. Grant the bot View Channel access there and run /server inspect again.";
    case "role_data_missing":
      return "The latest snapshot does not contain all roles needed for this question. Run /server inspect again.";
    case "invalid_snapshot":
      return "The latest snapshot contains unsupported permission data. Capture a new /server inspect snapshot and try again.";
  }
}

function formatMemberEvidenceProblem(
  reason: MemberQuestionEvidenceError,
): string {
  switch (reason) {
    case "invalid_question":
      return `Enter a question from 1 to ${MAX_QUESTION_LENGTH} characters.`;
    case "activity_unavailable":
      return "Message activity is unavailable because this bot has not collected messages. It will not infer a member's activity from roles or server configuration.";
    case "member_data_too_large":
      return "The member's role data exceeds the safe question limit. Try a channel-specific permission question or select a member with fewer roles.";
    case "cross_guild_member":
      return "That user is not a member of this server.";
    case "cross_guild_role":
      return "The member's roles could not be verified in this server.";
    case "invalid_member":
      return "The member details could not be validated. Try again later.";
  }
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? `<t:${Math.floor(timestamp / 1_000)}:F>`
    : "with an unknown capture time";
}

function formatAnswer(
  answer: string,
  evidence: Readonly<{
    snapshotId: string;
    capturedAt: string;
    channelId: string;
    channelName: string;
    visibilityNote: string;
    memberId?: string;
    membershipReadAt?: string;
    permissionExplanation?: Readonly<{
      viewChannel: Readonly<{ allowed: boolean; details: readonly string[] }>;
    }>;
  }>,
  providerId: string,
): string {
  const label =
    providerId === "mock"
      ? "**Mock provider test output; this is not an AI-generated factual answer.**"
      : "**AI-generated answer**";
  const evidenceLines = [
    "**Evidence**",
    `Channel: ${escapeMarkdown(evidence.channelName)} (ID ${evidence.channelId})`,
    `Snapshot: ${evidence.snapshotId}, captured <t:${Math.floor(Date.parse(evidence.capturedAt) / 1_000)}:F>`,
    `Visibility: ${escapeMarkdown(evidence.visibilityNote)}`,
  ];
  if (evidence.memberId) {
    evidenceLines.push(
      `Member roles read at <t:${Math.floor(Date.parse(evidence.membershipReadAt ?? evidence.capturedAt) / 1_000)}:F> for ID ${evidence.memberId}.`,
    );
    if (evidence.permissionExplanation) {
      const permission = evidence.permissionExplanation.viewChannel;
      evidenceLines.push(
        `View Channel evaluation (snapshot role/overwrite data plus current member state): ${permission.allowed ? "allowed" : "denied"}.`,
        ...permission.details.map((detail) => `- ${escapeMarkdown(detail)}`),
      );
    }
  }

  const footer = evidenceLines.join("\n");
  const heading = `${label}\n\n`;
  const footerBlock = `\n\n${footer}`;
  const availableAnswerLength = Math.max(
    0,
    1_900 - heading.length - footerBlock.length,
  );
  const safeAnswer = escapeUntrustedText(answer.trim());
  const clippedAnswer =
    safeAnswer.length > availableAnswerLength
      ? `${safeAnswer.slice(0, Math.max(0, availableAnswerLength - 1)).trimEnd()}…`
      : safeAnswer;
  return `${heading}${clippedAnswer}${footerBlock}`;
}

function formatMemberAnswer(
  answer: string,
  evidence: MemberQuestionEvidence,
  providerId: string,
): string {
  const label =
    providerId === "mock"
      ? "**Mock provider test output; this is not an AI-generated factual answer.**"
      : "**AI-generated member answer**";
  const roleLines: string[] = [];
  let roleSummaryLength = 0;
  let omittedRoleCount = 0;
  for (const [index, role] of evidence.roles.entries()) {
    const safeRoleName = escapeUntrustedText(role.name).slice(0, 60);
    const permissions = role.permissions.slice(0, 8).join(", ") || "none";
    const omittedPermissionCount = Math.max(0, role.permissions.length - 8);
    const permissionSuffix =
      omittedPermissionCount > 0 ? `, +${omittedPermissionCount} more` : "";
    const line = `- ${safeRoleName} (${role.id}): ${permissions}${permissionSuffix}`;
    if (roleSummaryLength + line.length > 900) {
      omittedRoleCount = evidence.roles.length - index;
      break;
    }
    roleLines.push(line);
    roleSummaryLength += line.length;
  }
  const roleSummary = roleLines.length > 0 ? roleLines.join("\n") : "none";
  const roleSuffix =
    omittedRoleCount > 0
      ? `\n${omittedRoleCount} additional role(s) omitted from this response.`
      : "";
  const joinedAt = evidence.joinedAt
    ? formatTimestamp(evidence.joinedAt)
    : "not available";
  const timeout = evidence.isTimedOut
    ? `Active until ${formatTimestamp(evidence.timeoutUntil ?? evidence.observedAt)}`
    : "No active communication timeout";
  const evidenceLines = [
    "**Evidence**",
    `Member ID: ${evidence.memberId}`,
    `Current roles and permissions read at <t:${Math.floor(Date.parse(evidence.observedAt) / 1_000)}:F>:\n${roleSummary}${roleSuffix}`,
    `Joined server: ${joinedAt}.`,
    `${timeout} at the observation time.`,
    "Message activity: not collected; no activity claims are supported.",
  ];
  const footer = evidenceLines.join("\n");
  const heading = `${label}\n\n`;
  const footerBlock = `\n\n${footer}`;
  const availableAnswerLength = Math.max(
    0,
    1_900 - heading.length - footerBlock.length,
  );
  const safeAnswer = escapeUntrustedText(answer.trim());
  const clippedAnswer =
    safeAnswer.length > availableAnswerLength
      ? `${safeAnswer.slice(0, Math.max(0, availableAnswerLength - 1)).trimEnd()}…`
      : safeAnswer;
  return `${heading}${clippedAnswer}${footerBlock}`;
}

function escapeUntrustedText(value: string): string {
  return escapeMarkdown(value).replace(/@(everyone|here)/gi, "@​$1");
}

function formatMessageAnswer(
  answer: string,
  evidence: Readonly<{
    channelName: string;
    channelId: string;
    messageCount: number;
    oldestMessageAt: string;
    newestMessageAt: string;
    retrievedAt: string;
    maxAgeDays: number;
    maxMessages: number;
  }>,
  providerId: string,
): string {
  const label =
    providerId === "mock"
      ? "**Mock provider test output; this is not an AI-generated factual answer.**"
      : "**AI-generated answer from recent channel messages**";
  const footer = [
    "**Evidence**",
    `Channel: ${escapeMarkdown(evidence.channelName)} (ID ${evidence.channelId})`,
    `Retrieved <t:${Math.floor(Date.parse(evidence.retrievedAt) / 1_000)}:F>; ${evidence.messageCount} message(s) from <t:${Math.floor(Date.parse(evidence.oldestMessageAt) / 1_000)}:F> to <t:${Math.floor(Date.parse(evidence.newestMessageAt) / 1_000)}:F>.`,
    `Configured bounds: at most ${evidence.maxMessages} message(s) from the previous ${evidence.maxAgeDays} day(s). Message text is fetched for this request and not stored.`,
  ].join("\n");
  const heading = `${label}\n\n`;
  const footerBlock = `\n\n${footer}`;
  const maximumAnswerLength = Math.max(
    0,
    1_900 - heading.length - footerBlock.length,
  );
  const safeAnswer = escapeUntrustedText(answer.trim());
  const clippedAnswer =
    safeAnswer.length > maximumAnswerLength
      ? `${safeAnswer.slice(0, Math.max(0, maximumAnswerLength - 1)).trimEnd()}…`
      : safeAnswer;
  return `${heading}${clippedAnswer}${footerBlock}`;
}

async function getMessageChannelAccessError(
  channel: GuildTextBasedChannel,
  requester: GuildMember,
  botMember: GuildMember,
  capabilities: GatewayCapabilities,
): Promise<string | null> {
  const requesterPermissions = channel.permissionsFor(requester);
  if (
    !requesterPermissions?.has(PermissionFlagsBits.ViewChannel) ||
    !requesterPermissions.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    return "You need current View Channel and Read Message History access to the selected channel or thread.";
  }
  const botPermissions = channel.permissionsFor(botMember);
  if (
    !botPermissions?.has(PermissionFlagsBits.ViewChannel) ||
    !botPermissions.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    return "The bot needs current View Channel and Read Message History access to retrieve messages from that channel or thread.";
  }

  if (channel.type !== ChannelType.PrivateThread) return null;
  const requesterCanManage = requesterPermissions.has(
    PermissionFlagsBits.ManageThreads,
  );
  const botCanManage = botPermissions.has(PermissionFlagsBits.ManageThreads);
  if (!requesterCanManage || !botCanManage) {
    if (!capabilities.guildMembers) {
      return (
        unavailableGatewayCapabilityMessage("guildMembers", capabilities) ??
        "The bot cannot verify private-thread membership."
      );
    }
    const thread = channel as ThreadChannel;
    try {
      if (!requesterCanManage) {
        await thread.members.fetch({ member: requester.id, force: true });
      }
      if (!botCanManage) {
        await thread.members.fetch({ member: botMember.id, force: true });
      }
    } catch {
      return "Current membership in the selected private thread could not be verified for both you and the bot.";
    }
  }
  return null;
}

function isThreadType(type: ChannelType): boolean {
  return (
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread
  );
}

function isSupportedMessageChannel(
  channel: GuildBasedChannel | null,
): channel is GuildTextBasedChannel {
  if (!channel) return false;
  return (
    channel?.type === ChannelType.GuildText ||
    channel?.type === ChannelType.GuildAnnouncement ||
    isThreadType(channel.type)
  );
}

function isSupportedMessageChannelOption(channel: {
  type: ChannelType;
}): boolean {
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement ||
    isThreadType(channel.type)
  );
}

function isSupportedTextChannel(
  channel: GuildBasedChannel | null,
): channel is TextChannel | NewsChannel {
  return (
    channel?.type === ChannelType.GuildText ||
    channel?.type === ChannelType.GuildAnnouncement
  );
}

function isSupportedTextChannelOption(
  channel: {
    type: ChannelType;
  } | null,
): boolean {
  return (
    channel?.type === ChannelType.GuildText ||
    channel?.type === ChannelType.GuildAnnouncement
  );
}

function getDiscordErrorCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  return typeof error.code === "number" ? error.code : null;
}
