import {
  CHANGE_PLAN_PERMISSION_BITS,
  MAX_CHANGE_PLAN_ITEMS,
  type ChangePlanChange,
  type RoleOverwriteValue,
} from "./change-plans.js";

const snowflakePattern = /^\d{17,20}$/;
const channelMentionPattern = /^<#(\d{17,20})>$/;

export type ChannelSelection = Readonly<{
  id: string;
  guildId: string;
  type: number;
  name: string;
  viewable: boolean;
}>;

export type PlanChannelTarget = Readonly<{
  id: string;
  name: string;
}>;

export type TopicTarget = PlanChannelTarget &
  Readonly<{ topic: string | null }>;
export type SlowmodeTarget = PlanChannelTarget & Readonly<{ slowmode: number }>;

export type RoleOverwriteTarget = PlanChannelTarget &
  Readonly<{
    channelType: "text" | "voice";
    overwrite: RoleOverwriteValue | null;
  }>;

export type PermissionKey = keyof typeof CHANGE_PLAN_PERMISSION_BITS;
export type PermissionState = "allow" | "deny" | "inherit";

export type BuiltPlanChanges = Readonly<{
  changes: readonly ChangePlanChange[];
  noOpChannelIds: readonly string[];
}>;

const textPermissionKeys = new Set<PermissionKey>([
  "view_channel",
  "send_messages",
  "read_message_history",
]);
const voicePermissionKeys = new Set<PermissionKey>([
  "view_channel",
  "connect",
  "speak",
]);

export function parseChannelSelectors(value: string): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Enter at least one channel mention or channel ID.");
  }

  const selectors = value.split(",").map((part) => part.trim());
  if (selectors.some((selector) => selector.length === 0)) {
    throw new TypeError("Remove empty entries from the channel list.");
  }

  const ids = selectors.map((selector) => {
    const mention = channelMentionPattern.exec(selector);
    const id = mention?.[1] ?? selector;
    if (!snowflakePattern.test(id)) {
      throw new TypeError(
        "'" +
          selector +
          "' is not a channel mention or 17–20 digit channel ID.",
      );
    }
    return id;
  });

  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length > MAX_CHANGE_PLAN_ITEMS) {
    throw new RangeError(
      `A plan can target at most ${MAX_CHANGE_PLAN_ITEMS} channels.`,
    );
  }
  return uniqueIds;
}

export function resolveChannelTargets(
  value: string,
  guildId: string,
  channels: readonly ChannelSelection[],
  allowedTypes: readonly number[],
): ChannelSelection[] {
  const ids = parseChannelSelectors(value);
  const channelsById = new Map(
    channels.map((channel) => [channel.id, channel]),
  );
  const resolved = ids.map((id) => {
    const channel = channelsById.get(id);
    if (!channel) {
      throw new TypeError(
        "Channel '" + id + "' was not found in this server. No plan was saved.",
      );
    }
    if (channel.guildId !== guildId) {
      throw new TypeError(
        "Channel '" + id + "' belongs to another server. No plan was saved.",
      );
    }
    if (!channel.viewable) {
      throw new TypeError(
        "Channel #" +
          channel.name +
          " (" +
          id +
          ") is not visible to the bot. No plan was saved.",
      );
    }
    if (!allowedTypes.includes(channel.type)) {
      throw new TypeError(
        "Channel #" +
          channel.name +
          " (" +
          id +
          ") has an unsupported type for this plan. No plan was saved.",
      );
    }
    return channel;
  });

  return resolved;
}

export function buildTopicChanges(
  targets: readonly TopicTarget[],
  after: string | null,
): BuiltPlanChanges {
  const changes: ChangePlanChange[] = [];
  const noOpChannelIds: string[] = [];
  for (const target of targets) {
    if (target.topic === after) {
      noOpChannelIds.push(target.id);
      continue;
    }
    changes.push({
      channelId: target.id,
      settingKey: "channel.topic",
      before: target.topic,
      after,
    });
  }
  return { changes, noOpChannelIds };
}

export function buildSlowmodeChanges(
  targets: readonly SlowmodeTarget[],
  after: number,
): BuiltPlanChanges {
  const changes: ChangePlanChange[] = [];
  const noOpChannelIds: string[] = [];
  for (const target of targets) {
    if (target.slowmode === after) {
      noOpChannelIds.push(target.id);
      continue;
    }
    changes.push({
      channelId: target.id,
      settingKey: "channel.slowmode",
      before: target.slowmode,
      after,
    });
  }
  return { changes, noOpChannelIds };
}

export function buildRoleOverwriteChanges(
  targets: readonly RoleOverwriteTarget[],
  roleId: string,
  permission: PermissionKey,
  state: PermissionState,
): BuiltPlanChanges {
  if (state !== "allow" && state !== "deny" && state !== "inherit") {
    throw new TypeError("Choose allow, deny, or inherit for the permission.");
  }
  if (typeof CHANGE_PLAN_PERMISSION_BITS[permission] !== "bigint") {
    throw new TypeError("Choose one of the supported channel permissions.");
  }

  const changes: ChangePlanChange[] = [];
  const noOpChannelIds: string[] = [];
  const bit = CHANGE_PLAN_PERMISSION_BITS[permission];

  for (const target of targets) {
    const allowedPermissions =
      target.channelType === "text" ? textPermissionKeys : voicePermissionKeys;
    if (!allowedPermissions.has(permission)) {
      throw new TypeError(
        "Permission '" +
          permission +
          "' is not supported on " +
          target.channelType +
          " channel #" +
          target.name +
          ". No plan was saved.",
      );
    }

    const before = target.overwrite;
    const currentAllow = BigInt(before?.allow ?? "0");
    const currentDeny = BigInt(before?.deny ?? "0");
    const allow = state === "allow" ? currentAllow | bit : currentAllow & ~bit;
    const deny = state === "deny" ? currentDeny | bit : currentDeny & ~bit;

    if (allow === currentAllow && deny === currentDeny) {
      noOpChannelIds.push(target.id);
      continue;
    }

    const after: RoleOverwriteValue | null =
      allow === 0n && deny === 0n
        ? null
        : { allow: allow.toString(10), deny: deny.toString(10) };
    changes.push({
      channelId: target.id,
      channelType: target.channelType,
      roleId,
      settingKey: "channel.role_overwrite",
      before,
      after,
    });
  }

  return { changes, noOpChannelIds };
}
