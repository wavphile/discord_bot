import {
  ChannelType,
  escapeMarkdown,
  MessageFlags,
  OverwriteType,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
} from "discord.js";
import type { DatabaseSync } from "node:sqlite";
import {
  authorizeInteraction,
  authorizePlanApprover,
  type ApprovalPolicy,
  type AuthorizationPolicy,
} from "../../core/authorization.js";
import {
  buildRoleOverwriteChanges,
  buildSlowmodeChanges,
  buildTopicChanges,
  parseChannelSelectors,
  resolveChannelTargets,
  type ChannelSelection,
  type PermissionKey,
  type PermissionState,
  type RoleOverwriteTarget,
  type SlowmodeTarget,
  type TopicTarget,
} from "../../features/plan-builders.js";
import {
  formatChangePlanPreview,
  type ChangePlanChange,
} from "../../features/change-plans.js";
import { describePlanJob } from "../../features/durable-plan-jobs.js";
import type { DurablePlanJobRunner } from "../plan-job-runner.js";
import { preflightChangePlanOnDiscord } from "../change-plan-preflight.js";
import {
  approveChangePlan,
  ChangePlanTransitionError,
  createChangePlan,
  getChangePlan,
  markChangePlanConflicted,
  rejectChangePlan,
  submitChangePlanForApproval,
} from "../../storage/change-plans.js";
import {
  enqueueApprovedPlan,
  getPlanJob,
  PlanJobStorageError,
} from "../../storage/plan-jobs.js";
import {
  getLatestConfigurationSnapshots,
  UnsupportedSnapshotSchemaVersionError,
} from "../../storage/snapshots.js";

const maxSelectorLength = 1_024;

export type PlanCommandContext = Readonly<{
  requesterAuthorization: AuthorizationPolicy;
  approvalAuthorization: ApprovalPolicy;
  jobRunner: DurablePlanJobRunner;
}>;

export const planCommand = new SlashCommandBuilder()
  .setName("plan")
  .setDescription("Preview and manage bounded server change plans.")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("topic")
      .setDescription("Preview a topic for selected text channels.")
      .addStringOption((option) =>
        option
          .setName("channels")
          .setDescription("Comma-separated channel mentions or IDs (up to 25).")
          .setMaxLength(maxSelectorLength)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("value")
          .setDescription("New topic (up to 1,024 characters), or CLEAR.")
          .setMaxLength(1_024)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("slowmode")
      .setDescription("Preview slowmode for selected text channels.")
      .addStringOption((option) =>
        option
          .setName("channels")
          .setDescription("Comma-separated channel mentions or IDs (up to 25).")
          .setMaxLength(maxSelectorLength)
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("seconds")
          .setDescription("Slowmode seconds (0 disables slowmode).")
          .setMinValue(0)
          .setMaxValue(21_600)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("permission")
      .setDescription("Preview one selected role permission bit.")
      .addStringOption((option) =>
        option
          .setName("channels")
          .setDescription("Comma-separated channel mentions or IDs (up to 25).")
          .setMaxLength(maxSelectorLength)
          .setRequired(true),
      )
      .addRoleOption((option) =>
        option
          .setName("role")
          .setDescription("Custom role target.")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("permission")
          .setDescription("Permission bit to set on each selected channel.")
          .addChoices(
            { name: "View Channel", value: "view_channel" },
            { name: "Send Messages", value: "send_messages" },
            { name: "Read Message History", value: "read_message_history" },
            { name: "Connect", value: "connect" },
            { name: "Speak", value: "speak" },
          )
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("state")
          .setDescription("Allow, deny, or inherit this one permission.")
          .addChoices(
            { name: "Allow", value: "allow" },
            { name: "Deny", value: "deny" },
            { name: "Inherit", value: "inherit" },
          )
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("submit")
      .setDescription("Submit your saved plan for approval.")
      .addStringOption((option) =>
        option
          .setName("plan_id")
          .setDescription("The full plan UUID shown in the private preview.")
          .setMinLength(36)
          .setMaxLength(36)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("review")
      .setDescription("Privately inspect a plan awaiting your decision.")
      .addStringOption((option) =>
        option
          .setName("plan_id")
          .setDescription("The full plan UUID.")
          .setMinLength(36)
          .setMaxLength(36)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("approve")
      .setDescription("Approve a plan after a fresh read-only preflight.")
      .addStringOption((option) =>
        option
          .setName("plan_id")
          .setDescription("The full plan UUID.")
          .setMinLength(36)
          .setMaxLength(36)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("reject")
      .setDescription("Reject a plan awaiting approval.")
      .addStringOption((option) =>
        option
          .setName("plan_id")
          .setDescription("The full plan UUID.")
          .setMinLength(36)
          .setMaxLength(36)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("apply")
      .setDescription("Start a durable job for an approved plan.")
      .addStringOption((option) =>
        option
          .setName("plan_id")
          .setDescription("The full approved plan UUID.")
          .setMinLength(36)
          .setMaxLength(36)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("cancel")
      .setDescription("Request cancellation between job items.")
      .addStringOption((option) =>
        option
          .setName("job_id")
          .setDescription("The full execution job UUID.")
          .setMinLength(36)
          .setMaxLength(36)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("status")
      .setDescription("Privately check a plan execution job.")
      .addStringOption((option) =>
        option
          .setName("job_id")
          .setDescription("The full execution job UUID.")
          .setMinLength(36)
          .setMaxLength(36)
          .setRequired(true),
      ),
  );

export async function executePlanCommand(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
  context?: PlanCommandContext,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "This command can only be used in the configured test server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "topic") {
      await createTopicPreview(interaction, database);
      return;
    }
    if (subcommand === "slowmode") {
      await createSlowmodePreview(interaction, database);
      return;
    }
    if (subcommand === "permission") {
      await createPermissionPreview(interaction, database);
      return;
    }
    if (subcommand === "submit") {
      await submitPlan(interaction, database, context);
      return;
    }
    if (subcommand === "review") {
      await reviewPlan(interaction, database, context);
      return;
    }
    if (subcommand === "approve") {
      await approvePlan(interaction, database, context);
      return;
    }
    if (subcommand === "reject") {
      await rejectPlan(interaction, database, context);
      return;
    }
    if (subcommand === "apply") {
      await applyPlan(interaction, database, context);
      return;
    }
    if (subcommand === "cancel") {
      await cancelJob(interaction, database, context);
      return;
    }
    if (subcommand === "status") {
      await showJobStatus(interaction, database, context);
    }
  } catch (error) {
    if (error instanceof ChangePlanTransitionError) {
      await editPrivateReply(interaction, error.message);
      return;
    }
    if (error instanceof PlanJobStorageError) {
      await editPrivateReply(interaction, error.message);
      return;
    }
    if (error instanceof TypeError || error instanceof RangeError) {
      await editPrivateReply(interaction, error.message);
      return;
    }
    const discordCode = getDiscordErrorCode(error);
    if (discordCode === 10_003) {
      await editPrivateReply(
        interaction,
        "A selected channel is no longer available in this server. No plan was saved.",
      );
      return;
    }
    if (discordCode === 50_001) {
      await editPrivateReply(
        interaction,
        "The bot cannot read a selected channel's settings. Grant it View Channel access there, then try again. No plan was saved.",
      );
      return;
    }
    throw error;
  }
}

async function applyPlan(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
  context: PlanCommandContext | undefined,
): Promise<void> {
  if (!isApprover(interaction, context)) {
    await editPrivateReply(
      interaction,
      "You are not configured to apply approved change plans.",
    );
    return;
  }
  const guildId = interaction.guildId;
  if (!guildId || !context) return;
  const job = enqueueApprovedPlan(
    database,
    guildId,
    interaction.options.getString("plan_id", true),
    interaction.user.id,
  );
  context.jobRunner.schedule(guildId, job.id);
  await editPrivateReply(
    interaction,
    `Execution job \`${job.id}\` is queued. Use \`/plan status job_id:${job.id}\` to check progress.`,
  );
}

async function cancelJob(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
  context: PlanCommandContext | undefined,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId || !context) return;
  const jobId = interaction.options.getString("job_id", true);
  const job = getPlanJob(database, guildId, jobId);
  if (!job) {
    await editPrivateReply(
      interaction,
      "Plan execution job not found in this server.",
    );
    return;
  }
  const requesterOwnsJob = job.requestedBy === interaction.user.id;
  const approver = isApprover(interaction, context);
  if (!requesterOwnsJob && !approver) {
    await editPrivateReply(
      interaction,
      "Only the original requester or a configured approver can cancel this job.",
    );
    return;
  }
  context.jobRunner.requestCancellation(guildId, jobId);
  await editPrivateReply(
    interaction,
    `Cancellation requested for job \`${jobId}\`. Any current Discord operation will finish before the job stops.`,
  );
}

async function showJobStatus(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
  context: PlanCommandContext | undefined,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId || !context) return;
  const job = getPlanJob(
    database,
    guildId,
    interaction.options.getString("job_id", true),
  );
  if (!job) {
    await editPrivateReply(
      interaction,
      "Plan execution job not found in this server.",
    );
    return;
  }
  if (
    job.requestedBy !== interaction.user.id &&
    !isApprover(interaction, context)
  ) {
    await editPrivateReply(
      interaction,
      "Only the original requester or a configured approver can inspect this job.",
    );
    return;
  }
  await sendPrivateMessages(interaction, describePlanJob(job));
}

async function createTopicPreview(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;
  const selectors = interaction.options.getString("channels", true);
  const requestedValue = interaction.options.getString("value", true);
  const after =
    requestedValue.toUpperCase() === "CLEAR" ? null : requestedValue;
  const channels = await fetchSelectedChannels(guild, selectors, [
    ChannelType.GuildText,
  ]);
  const targets: TopicTarget[] = channels.map((channel) => {
    if (channel.type !== ChannelType.GuildText) {
      throw new TypeError("Only ordinary text channels support topic plans.");
    }
    return { id: channel.id, name: channel.name, topic: channel.topic };
  });
  const result = buildTopicChanges(targets, after);
  await saveAndReply(interaction, database, result, channels);
}

async function createSlowmodePreview(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;
  const selectors = interaction.options.getString("channels", true);
  const after = interaction.options.getInteger("seconds", true);
  const channels = await fetchSelectedChannels(guild, selectors, [
    ChannelType.GuildText,
  ]);
  const targets: SlowmodeTarget[] = channels.map((channel) => {
    if (channel.type !== ChannelType.GuildText) {
      throw new TypeError(
        "Only ordinary text channels support slowmode plans.",
      );
    }
    return {
      id: channel.id,
      name: channel.name,
      slowmode: channel.rateLimitPerUser,
    };
  });
  const result = buildSlowmodeChanges(targets, after);
  await saveAndReply(interaction, database, result, channels);
}

async function createPermissionPreview(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;
  const selectors = interaction.options.getString("channels", true);
  const requestedRole = interaction.options.getRole("role", true);
  const permission = interaction.options.getString(
    "permission",
    true,
  ) as PermissionKey;
  const state = interaction.options.getString("state", true) as PermissionState;

  if (requestedRole.id === guild.id) {
    throw new TypeError("The @everyone role cannot be a plan target.");
  }
  if (requestedRole.managed) {
    throw new TypeError("Managed roles cannot be plan targets.");
  }

  await guild.roles.fetch(undefined, { force: true });
  const role = guild.roles.cache.get(requestedRole.id);
  if (!role || role.managed || role.id === guild.id) {
    throw new TypeError(
      "Choose an existing custom role in this server. No plan was saved.",
    );
  }

  const channels = await fetchSelectedChannels(guild, selectors, [
    ChannelType.GuildText,
    ChannelType.GuildVoice,
  ]);
  const targets: RoleOverwriteTarget[] = channels.map((channel) => {
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildVoice
    ) {
      throw new TypeError(
        "Role permission plans only support ordinary text and voice channels.",
      );
    }
    const overwrite = channel.permissionOverwrites.cache.get(role.id);
    if (overwrite && overwrite.type !== OverwriteType.Role) {
      throw new TypeError(
        `The overwrite target on #${channel.name} is not a role. No plan was saved.`,
      );
    }
    return {
      id: channel.id,
      name: channel.name,
      channelType: channel.type === ChannelType.GuildText ? "text" : "voice",
      overwrite: overwrite
        ? {
            allow: overwrite.allow.bitfield.toString(10),
            deny: overwrite.deny.bitfield.toString(10),
          }
        : null,
    };
  });

  const result = buildRoleOverwriteChanges(targets, role.id, permission, state);
  await saveAndReply(interaction, database, result, channels, role.name);
}

async function submitPlan(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
  context?: PlanCommandContext,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId || !context) {
    await editPrivateReply(
      interaction,
      "Plan approval is not configured for this bot.",
    );
    return;
  }
  const authorization = authorizeInteraction(
    {
      guildId,
      userId: interaction.user.id,
      roleIds: getInteractionRoleIds(interaction),
    },
    context.requesterAuthorization,
  );
  if (!authorization.allowed) {
    await editPrivateReply(
      interaction,
      "You are not authorized to submit plans in this server.",
    );
    return;
  }

  const plan = submitChangePlanForApproval(
    database,
    guildId,
    interaction.options.getString("plan_id", true),
    interaction.user.id,
  );
  await editPrivateReply(
    interaction,
    `Plan \`${plan.id}\` was submitted for approval. No Discord changes have been applied.`,
  );
}

async function reviewPlan(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
  context?: PlanCommandContext,
): Promise<void> {
  if (!isApprover(interaction, context)) {
    await editPrivateReply(
      interaction,
      "You are not configured to review change plans.",
    );
    return;
  }
  const guildId = interaction.guildId;
  if (!guildId) return;
  const plan = getChangePlan(
    database,
    guildId,
    interaction.options.getString("plan_id", true),
  );
  if (!plan) {
    await editPrivateReply(
      interaction,
      "Change plan not found in this server.",
    );
    return;
  }
  if (plan.status !== "awaiting_approval") {
    await editPrivateReply(
      interaction,
      `This plan is ${plan.status} and is not awaiting approval.`,
    );
    return;
  }
  await sendPrivateMessages(interaction, [
    ...formatChangePlanPreview(plan),
    "Review only. No decision has been recorded and no Discord changes have been applied.",
  ]);
}

async function approvePlan(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
  context?: PlanCommandContext,
): Promise<void> {
  if (!isApprover(interaction, context)) {
    await editPrivateReply(
      interaction,
      "You are not configured to approve change plans.",
    );
    return;
  }
  const guild = interaction.guild;
  if (!guild) return;
  const guildId = guild.id;
  const planId = interaction.options.getString("plan_id", true);
  const plan = getChangePlan(database, guildId, planId);
  if (!plan) {
    await editPrivateReply(
      interaction,
      "Change plan not found in this server.",
    );
    return;
  }
  if (plan.status !== "awaiting_approval") {
    await editPrivateReply(
      interaction,
      plan.status === "expired"
        ? "This plan has expired. Create a new preview before requesting approval."
        : `This plan is ${plan.status} and is not awaiting approval.`,
    );
    return;
  }
  if (plan.requestedBy === interaction.user.id) {
    await editPrivateReply(
      interaction,
      "The requester cannot approve their own change plan.",
    );
    return;
  }

  const requesterAuthorization = context?.requesterAuthorization ?? {
    guildId,
    allowedUserIds: new Set<string>(),
    allowedRoleIds: new Set<string>(),
  };
  const preflight = await preflightChangePlanOnDiscord(
    guild,
    plan,
    requesterAuthorization,
  );
  if (!preflight.ready) {
    const conflicted = markChangePlanConflicted(
      database,
      guildId,
      plan.id,
      interaction.user.id,
    );
    const messages = [
      `Plan \`${conflicted.id}\` was marked conflicted. No Discord settings were changed.`,
      ...preflight.issues.map((issue) =>
        issue.item === null
          ? `• ${issue.reason}`
          : `• Item ${issue.item}, channel \`${issue.channelId}\`: ${issue.reason}`,
      ),
      "Create a new preview from the current configuration before requesting approval again.",
    ];
    await sendPrivateMessages(interaction, messages);
    return;
  }

  const approved = approveChangePlan(
    database,
    guildId,
    plan.id,
    interaction.user.id,
  );
  await sendPrivateMessages(interaction, [
    ...formatChangePlanPreview(approved),
    `Approved by <@${interaction.user.id}> after a fresh read-only preflight. No Discord changes have been applied; execution is not available yet.`,
  ]);
}

async function rejectPlan(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
  context?: PlanCommandContext,
): Promise<void> {
  if (!isApprover(interaction, context)) {
    await editPrivateReply(
      interaction,
      "You are not configured to reject change plans.",
    );
    return;
  }
  const guildId = interaction.guildId;
  if (!guildId) return;
  const plan = rejectChangePlan(
    database,
    guildId,
    interaction.options.getString("plan_id", true),
    interaction.user.id,
  );
  await editPrivateReply(
    interaction,
    `Plan \`${plan.id}\` was rejected. No Discord changes have been applied.`,
  );
}

function isApprover(
  interaction: ChatInputCommandInteraction,
  context: PlanCommandContext | undefined,
): boolean {
  if (!context) return false;
  return authorizePlanApprover(
    {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      roleIds: getInteractionRoleIds(interaction),
    },
    context.approvalAuthorization,
  ).allowed;
}

function getInteractionRoleIds(
  interaction: ChatInputCommandInteraction,
): Iterable<string> {
  if (!interaction.inGuild() || !interaction.member) return [];
  const roles = interaction.member.roles;
  return "cache" in roles ? roles.cache.keys() : roles;
}

async function fetchSelectedChannels(
  guild: NonNullable<ChatInputCommandInteraction["guild"]>,
  selectors: string,
  allowedTypes: readonly number[],
): Promise<GuildBasedChannel[]> {
  const ids = parseChannelSelectors(selectors);
  const fetched = await Promise.all(
    ids.map((id) => guild.channels.fetch(id, { force: true })),
  );
  const available: ChannelSelection[] = fetched.flatMap((channel) =>
    channel
      ? [
          {
            id: channel.id,
            guildId: channel.guildId,
            type: channel.type,
            name: channel.name,
            viewable: channel.viewable,
          },
        ]
      : [],
  );
  const resolved = resolveChannelTargets(
    selectors,
    guild.id,
    available,
    allowedTypes,
  );
  const channelsById = new Map(
    fetched.flatMap((channel) =>
      channel ? [[channel.id, channel] as const] : [],
    ),
  );
  return resolved.map((selection) => {
    const channel = channelsById.get(selection.id);
    if (!channel) {
      throw new TypeError(
        `Channel \`${selection.id}\` could not be resolved. No plan was saved.`,
      );
    }
    return channel;
  });
}

async function saveAndReply(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
  result: Readonly<{
    changes: readonly ChangePlanChange[];
    noOpChannelIds: readonly string[];
  }>,
  channels: readonly GuildBasedChannel[],
  roleName?: string,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const channelNames = new Map(
    channels.map((channel) => [channel.id, channel.name]),
  );
  if (result.changes.length === 0) {
    const notes = formatNoOpMessages(result.noOpChannelIds, channelNames, true);
    await sendPrivateMessages(interaction, notes);
    return;
  }

  let sourceSnapshotId: string | null = null;
  let sourceSnapshotNote: string | null = null;
  try {
    sourceSnapshotId =
      getLatestConfigurationSnapshots(database, guildId, 1)[0]?.id ?? null;
  } catch (error) {
    if (!(error instanceof UnsupportedSnapshotSchemaVersionError)) throw error;
    sourceSnapshotNote =
      "The latest saved snapshot uses an unsupported schema; this plan uses the current live values instead.";
  }
  const plan = createChangePlan(database, {
    guildId,
    requestedBy: interaction.user.id,
    sourceSnapshotId,
    changes: result.changes,
  });
  const roleNames = new Map<string, string>();
  if (roleName) {
    for (const change of plan.changes) {
      if (change.settingKey === "channel.role_overwrite") {
        roleNames.set(change.roleId, roleName);
      }
    }
  }
  const messages = formatChangePlanPreview(plan, new Date(), {
    channels: channelNames,
    roles: roleNames,
  });
  if (sourceSnapshotNote) messages.push(sourceSnapshotNote);
  if (result.noOpChannelIds.length > 0) {
    messages.push(
      ...formatNoOpMessages(result.noOpChannelIds, channelNames, false),
    );
  }

  await sendPrivateMessages(interaction, messages);
}

function formatNoOpMessages(
  channelIds: readonly string[],
  channelNames: ReadonlyMap<string, string>,
  allNoOps: boolean,
): string[] {
  const limit = 1_800;
  const heading = allNoOps
    ? "No plan was saved: every selected target already has the requested value."
    : "Already at the requested value:";
  const messages: string[] = [];
  let current = heading;
  for (const id of channelIds) {
    const name = escapeUntrustedName(channelNames.get(id) ?? "channel");
    const line = `\n• #${name} (\`${id}\`)`;
    if (current.length + line.length > limit) {
      messages.push(current);
      current = `${heading} (continued)`;
    }
    current += line;
  }
  messages.push(current);
  return messages;
}

async function sendPrivateMessages(
  interaction: ChatInputCommandInteraction,
  messages: readonly string[],
): Promise<void> {
  await interaction.editReply({
    content: messages[0] ?? "A preview could not be formatted.",
    allowedMentions: { parse: [] },
  });
  for (const content of messages.slice(1)) {
    await interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
}

async function editPrivateReply(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  await interaction.editReply({
    content,
    allowedMentions: { parse: [] },
  });
}

function escapeUntrustedName(value: string): string {
  return escapeMarkdown(value)
    .replace(/@(everyone|here)/gi, "@​$1")
    .replace(/[\r\n]+/g, " ");
}

function getDiscordErrorCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  return typeof error.code === "number" ? error.code : null;
}
