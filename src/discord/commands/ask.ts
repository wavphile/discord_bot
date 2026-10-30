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
} from "discord.js";
import type { GuildMember } from "discord.js";
import {
  AiInputLimitError,
  AiProviderError,
  AiUsageLimitError,
} from "../../ai/errors.js";
import type { AiProvider } from "../../ai/types.js";
import {
  buildConfigurationQuestionEvidence,
  hasCurrentViewAccess,
  MAX_QUESTION_LENGTH,
} from "../../features/configuration-questions.js";
import { generateForGuild } from "../../features/ai-generation.js";
import { logger } from "../../observability/logger.js";
import {
  getLatestConfigurationSnapshots,
  UnsupportedSnapshotSchemaVersionError,
} from "../../storage/snapshots.js";
import type { DatabaseSync } from "node:sqlite";
import type { SavedConfigurationSnapshot } from "../../storage/snapshots.js";

export const askCommand = new SlashCommandBuilder()
  .setName("ask")
  .setDescription("Ask a read-only question about saved server configuration.")
  .addStringOption((option) =>
    option
      .setName("question")
      .setDescription("A question about the selected channel's configuration.")
      .setMinLength(1)
      .setMaxLength(MAX_QUESTION_LENGTH)
      .setRequired(true),
  )
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("The channel whose saved configuration to use.")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(true),
  )
  .addUserOption((option) =>
    option
      .setName("member")
      .setDescription("Optional member for a channel-access question."),
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

  const selectedChannel = interaction.options.getChannel("channel", true);
  if (!isSupportedTextChannelOption(selectedChannel)) {
    await interaction.reply({
      content: "Choose a text or announcement channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const selectedUser = interaction.options.getUser("member");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let requester: GuildMember;
  let channel: GuildBasedChannel | null;
  let targetMember: GuildMember | null = null;
  try {
    await guild.roles.fetch(undefined, { force: true });
    [requester, channel] = await Promise.all([
      guild.members.fetch({ user: interaction.user.id, force: true }),
      guild.channels.fetch(selectedChannel.id, { force: true }),
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
    if (code === 10_003 || code === 50_001) {
      await interaction.editReply(
        "The bot cannot read that channel's configuration. Grant the bot View Channel access there, then capture a new /server inspect snapshot.",
      );
      return;
    }
    throw error;
  }

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
    await interaction.editReply(formatEvidenceProblem(result.reason, snapshot));
    return;
  }

  try {
    const completion = await generateForGuild(
      database,
      provider,
      guildId,
      result.evidence.prompt,
      limits,
      now,
    );
    await interaction.editReply({
      content: formatAnswer(completion.text, result.evidence, provider.id),
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

function escapeUntrustedText(value: string): string {
  return escapeMarkdown(value).replace(/@(everyone|here)/gi, "@​$1");
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
