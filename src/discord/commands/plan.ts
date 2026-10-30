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
import { createChangePlan } from "../../storage/change-plans.js";
import {
  getLatestConfigurationSnapshots,
  UnsupportedSnapshotSchemaVersionError,
} from "../../storage/snapshots.js";

const maxSelectorLength = 1_024;

export const planCommand = new SlashCommandBuilder()
  .setName("plan")
  .setDescription("Preview a bounded set of server configuration changes.")
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
  );

export async function executePlanCommand(
  interaction: ChatInputCommandInteraction,
  database: DatabaseSync,
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
    }
  } catch (error) {
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
