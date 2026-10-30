import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type TextChannel,
  type VoiceChannel,
} from "discord.js";
import type { ChangePlanChange } from "../features/change-plans.js";
import type { ChangePlan } from "../features/change-plans.js";
import {
  evaluatePlanPreflight,
  type PlanTargetObservation,
  type PlanPreflightResult,
} from "../features/plan-approval.js";
import {
  authorizeInteraction,
  type AuthorizationPolicy,
} from "../core/authorization.js";

/** Run the reusable read-only preflight for an entire pending plan. */
export async function preflightChangePlanOnDiscord(
  guild: Guild,
  plan: Pick<ChangePlan, "requestedBy" | "changes">,
  requesterAuthorization: AuthorizationPolicy,
): Promise<PlanPreflightResult> {
  const requester = await guild.members
    .fetch({ user: plan.requestedBy, force: true })
    .catch(() => null);
  const requesterStillAuthorized =
    requester !== null &&
    authorizeInteraction(
      {
        guildId: guild.id,
        userId: requester.id,
        roleIds: requester.roles.cache.keys(),
      },
      requesterAuthorization,
    ).allowed;

  let botMember: GuildMember | null = null;
  try {
    botMember = await guild.members.fetchMe({ force: true });
  } catch {
    // Each target receives a concrete failure below.
  }

  const observations = await Promise.all(
    plan.changes.map((change) => inspectPlanTarget(guild, change, botMember)),
  );
  return evaluatePlanPreflight(plan, requesterStillAuthorized, observations);
}

/** Read one exact plan target and verify the bot can still change it. */
export async function inspectPlanTarget(
  guild: Guild,
  change: ChangePlanChange,
  botMember: GuildMember | null,
): Promise<PlanTargetObservation> {
  const read = await readPlanTargetOnDiscord(guild, change);
  if (!read.readable) {
    return {
      current: null,
      canWrite: false,
      reason: read.reason ?? "The target could not be read safely.",
    };
  }
  if (!read.targetAvailable) {
    return {
      current: read.current,
      canWrite: false,
      reason: read.reason ?? "The planned target is no longer available.",
    };
  }
  if (!botMember) {
    return {
      current: read.current,
      canWrite: false,
      reason: "The bot's current server permissions could not be confirmed.",
    };
  }

  const channel = read.channel;
  if (!channel) {
    return {
      current: read.current,
      canWrite: false,
      reason: "The planned channel is no longer available in this server.",
    };
  }

  try {
    const permissions = channel.permissionsFor(botMember);
    if (!permissions?.has(PermissionFlagsBits.ViewChannel)) {
      return {
        current: read.current,
        canWrite: false,
        reason: "The bot no longer has View Channel access.",
      };
    }
    if (!permissions.has(PermissionFlagsBits.ManageChannels)) {
      return {
        current: read.current,
        canWrite: false,
        reason: "The bot no longer has Manage Channels permission.",
      };
    }

    if (change.settingKey === "channel.topic") {
      if (channel.type !== ChannelType.GuildText) {
        return {
          current: null,
          canWrite: false,
          reason: "The planned text channel is no longer supported.",
        };
      }
      return { current: channel.topic, canWrite: true };
    }
    if (change.settingKey === "channel.slowmode") {
      if (channel.type !== ChannelType.GuildText) {
        return {
          current: null,
          canWrite: false,
          reason: "The planned text channel is no longer supported.",
        };
      }
      return { current: channel.rateLimitPerUser, canWrite: true };
    }

    if (!permissions.has(PermissionFlagsBits.ManageRoles)) {
      return {
        current: read.current,
        canWrite: false,
        reason: "The bot no longer has Manage Roles permission.",
      };
    }
    const role = guild.roles.cache.get(change.roleId);
    if (!role || role.id === guild.id || role.managed) {
      return {
        current: read.current,
        canWrite: false,
        reason: "The planned role is no longer an editable custom role.",
      };
    }
    if (role.comparePositionTo(botMember.roles.highest) >= 0) {
      return {
        current: read.current,
        canWrite: false,
        reason:
          "The planned role is no longer below the bot in role hierarchy.",
      };
    }
    const overwrite = (
      channel as TextChannel | VoiceChannel
    ).permissionOverwrites.cache.get(change.roleId);
    if (overwrite && overwrite.type !== OverwriteType.Role) {
      return {
        current: read.current,
        canWrite: false,
        reason: "The current overwrite target is not a role.",
      };
    }
    return { current: read.current, canWrite: true };
  } catch {
    return {
      current: read.current,
      canWrite: false,
      reason: "The planned target could not be read safely.",
    };
  }
}

export type PlanTargetRead = Readonly<{
  current: PlanTargetObservation["current"];
  readable: boolean;
  targetAvailable: boolean;
  channel?: GuildBasedChannel;
  reason?: string;
}>;

/** Read the observed value for recovery, without requiring write permissions. */
export async function readPlanTargetOnDiscord(
  guild: Guild,
  change: ChangePlanChange,
): Promise<PlanTargetRead> {
  try {
    const channel = await guild.channels.fetch(change.channelId, {
      force: true,
    });
    if (!channel || channel.guildId !== guild.id) {
      return {
        current: null,
        readable: true,
        targetAvailable: false,
        reason: "The planned channel is no longer available in this server.",
      };
    }

    const isRoleOverwrite = change.settingKey === "channel.role_overwrite";
    const expectedType = isRoleOverwrite
      ? change.channelType === "text"
        ? ChannelType.GuildText
        : ChannelType.GuildVoice
      : ChannelType.GuildText;
    if (channel.type !== expectedType) {
      return {
        current: null,
        readable: true,
        targetAvailable: false,
        channel,
        reason: "The planned channel type has changed or is unsupported.",
      };
    }

    if (change.settingKey === "channel.topic") {
      if (channel.type !== ChannelType.GuildText) {
        return {
          current: null,
          readable: true,
          targetAvailable: false,
          reason: "The planned text channel is no longer supported.",
        };
      }
      return {
        current: channel.topic,
        readable: true,
        targetAvailable: true,
        channel,
      };
    }
    if (change.settingKey === "channel.slowmode") {
      if (channel.type !== ChannelType.GuildText) {
        return {
          current: null,
          readable: true,
          targetAvailable: false,
          reason: "The planned text channel is no longer supported.",
        };
      }
      return {
        current: channel.rateLimitPerUser,
        readable: true,
        targetAvailable: true,
        channel,
      };
    }

    await guild.roles.fetch(undefined, { force: true });
    const role = guild.roles.cache.get(change.roleId);
    if (!role || role.id === guild.id || role.managed) {
      return {
        current: null,
        readable: true,
        targetAvailable: false,
        channel,
        reason: "The planned role is no longer an editable custom role.",
      };
    }
    const overwrite = (
      channel as TextChannel | VoiceChannel
    ).permissionOverwrites.cache.get(change.roleId);
    if (overwrite && overwrite.type !== OverwriteType.Role) {
      return {
        current: null,
        readable: true,
        targetAvailable: false,
        channel,
        reason: "The current overwrite target is not a role.",
      };
    }
    return {
      current: overwrite
        ? {
            allow: overwrite.allow.bitfield.toString(10),
            deny: overwrite.deny.bitfield.toString(10),
          }
        : null,
      readable: true,
      targetAvailable: true,
      channel,
    };
  } catch {
    return {
      current: null,
      readable: false,
      targetAvailable: false,
      reason: "The planned target could not be read safely.",
    };
  }
}
