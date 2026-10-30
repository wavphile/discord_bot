import { PermissionFlagsBits } from "discord.js";

export type RolePermissionSource = Readonly<{
  id: string;
  name: string;
  permissions: bigint;
}>;

export type ChannelPermissionOverwrite = Readonly<{
  target: "role" | "member";
  id: string;
  name: string;
  allow: bigint;
  deny: bigint;
}>;

export type PermissionEvaluation = Readonly<{
  allowed: boolean;
  rawAllowed: boolean;
  details: readonly string[];
}>;

export type ChannelPermissionExplanation = Readonly<{
  isOwner: boolean;
  isAdministrator: boolean;
  viewChannel: PermissionEvaluation;
  sendMessages: PermissionEvaluation;
  sendMessagesInThreads: PermissionEvaluation;
}>;

export type ExplainChannelPermissionsInput = Readonly<{
  memberId: string;
  guildOwnerId: string;
  everyoneRole: RolePermissionSource;
  memberRoles: readonly RolePermissionSource[];
  overwrites: readonly ChannelPermissionOverwrite[];
  isTimedOut: boolean;
}>;

const permissionBits = {
  viewChannel: PermissionFlagsBits.ViewChannel,
  sendMessages: PermissionFlagsBits.SendMessages,
  sendMessagesInThreads: PermissionFlagsBits.SendMessagesInThreads,
} as const;

export function explainChannelPermissions(
  input: ExplainChannelPermissionsInput,
): ChannelPermissionExplanation {
  const isOwner = input.memberId === input.guildOwnerId;
  const roles = [
    input.everyoneRole,
    ...input.memberRoles.filter((role) => role.id !== input.everyoneRole.id),
  ];
  const basePermissions = roles.reduce(
    (permissions, role) => permissions | role.permissions,
    0n,
  );
  const isAdministrator = hasPermission(
    basePermissions,
    PermissionFlagsBits.Administrator,
  );
  const bypassesOverwrites = isOwner || isAdministrator;

  const viewChannel = evaluatePermission(
    input,
    "View Channel",
    permissionBits.viewChannel,
    roles,
    bypassesOverwrites,
  );
  const sendMessages = applyImplicitRestrictions(
    evaluatePermission(
      input,
      "Send Messages",
      permissionBits.sendMessages,
      roles,
      bypassesOverwrites,
    ),
    input,
    viewChannel,
    bypassesOverwrites,
  );
  const sendMessagesInThreads = applyImplicitRestrictions(
    evaluatePermission(
      input,
      "Send Messages in Threads",
      permissionBits.sendMessagesInThreads,
      roles,
      bypassesOverwrites,
    ),
    input,
    viewChannel,
    bypassesOverwrites,
  );

  return {
    isOwner,
    isAdministrator,
    viewChannel,
    sendMessages,
    sendMessagesInThreads,
  };
}

function evaluatePermission(
  input: ExplainChannelPermissionsInput,
  label: string,
  bit: bigint,
  roles: readonly RolePermissionSource[],
  bypassesOverwrites: boolean,
): PermissionEvaluation {
  if (input.memberId === input.guildOwnerId) {
    return {
      allowed: true,
      rawAllowed: true,
      details: ["The server owner bypasses permission restrictions."],
    };
  }

  if (bypassesOverwrites) {
    return {
      allowed: true,
      rawAllowed: true,
      details: [
        "Administrator grants all permissions and bypasses channel overwrites.",
      ],
    };
  }

  const baseSources = roles.filter((role) =>
    hasPermission(role.permissions, bit),
  );
  let allowed = baseSources.length > 0;
  const details = [
    baseSources.length > 0
      ? `Base role permissions grant ${label} via ${formatRoleNames(baseSources)}.`
      : `No base role grants ${label}.`,
  ];

  const everyoneOverwrite = input.overwrites.find(
    (overwrite) =>
      overwrite.target === "role" && overwrite.id === input.everyoneRole.id,
  );
  if (everyoneOverwrite && hasPermission(everyoneOverwrite.deny, bit)) {
    allowed = false;
    details.push("The @everyone channel overwrite denies it.");
  }
  if (everyoneOverwrite && hasPermission(everyoneOverwrite.allow, bit)) {
    allowed = true;
    details.push("The @everyone channel overwrite allows it.");
  }

  const memberRoleIds = new Set(
    input.memberRoles
      .filter((role) => role.id !== input.everyoneRole.id)
      .map((role) => role.id),
  );
  const matchingRoleOverwrites = input.overwrites.filter(
    (overwrite) =>
      overwrite.target === "role" && memberRoleIds.has(overwrite.id),
  );
  const denyingRoleOverwrites = matchingRoleOverwrites.filter((overwrite) =>
    hasPermission(overwrite.deny, bit),
  );
  const allowingRoleOverwrites = matchingRoleOverwrites.filter((overwrite) =>
    hasPermission(overwrite.allow, bit),
  );

  if (denyingRoleOverwrites.length > 0) allowed = false;
  if (allowingRoleOverwrites.length > 0) allowed = true;
  if (denyingRoleOverwrites.length > 0 || allowingRoleOverwrites.length > 0) {
    details.push(
      describeRoleOverwrites(denyingRoleOverwrites, allowingRoleOverwrites),
    );
  }

  const memberOverwrite = input.overwrites.find(
    (overwrite) =>
      overwrite.target === "member" && overwrite.id === input.memberId,
  );
  if (memberOverwrite && hasPermission(memberOverwrite.deny, bit)) {
    allowed = false;
    details.push("A member-specific channel overwrite denies it.");
  }
  if (memberOverwrite && hasPermission(memberOverwrite.allow, bit)) {
    allowed = true;
    details.push("A member-specific channel overwrite allows it.");
  }

  return { allowed, rawAllowed: allowed, details };
}

function applyImplicitRestrictions(
  evaluation: PermissionEvaluation,
  input: ExplainChannelPermissionsInput,
  viewChannel: PermissionEvaluation,
  bypassesOverwrites: boolean,
): PermissionEvaluation {
  if (bypassesOverwrites) return evaluation;

  let allowed = evaluation.allowed;
  const details = [...evaluation.details];

  if (!viewChannel.allowed) {
    allowed = false;
    details.push(
      "View Channel is denied, so Discord implicitly blocks channel actions and thread access.",
    );
  }

  if (input.isTimedOut && !bypassesOverwrites) {
    allowed = false;
    details.push(
      "An active communication timeout blocks sending permissions; server owners and administrators are exempt.",
    );
  }

  return { ...evaluation, allowed, details };
}

function describeRoleOverwrites(
  denying: readonly ChannelPermissionOverwrite[],
  allowing: readonly ChannelPermissionOverwrite[],
): string {
  if (denying.length > 0 && allowing.length > 0) {
    return `Role overwrites deny it via ${formatOverwriteNames(denying)}, but allow it via ${formatOverwriteNames(allowing)}; role allows take precedence over role denies.`;
  }
  if (allowing.length > 0) {
    return `Role overwrites allow it via ${formatOverwriteNames(allowing)}.`;
  }
  return `Role overwrites deny it via ${formatOverwriteNames(denying)}.`;
}

function formatRoleNames(roles: readonly RolePermissionSource[]): string {
  return formatNames(roles.map((role) => role.name));
}

function formatOverwriteNames(
  overwrites: readonly ChannelPermissionOverwrite[],
): string {
  return formatNames(overwrites.map((overwrite) => overwrite.name));
}

function formatNames(names: readonly string[]): string {
  const shownNames = names.slice(0, 3);
  const remainingCount = names.length - shownNames.length;
  const shown = shownNames.map((name) => `**${name}**`).join(", ");
  return remainingCount > 0 ? `${shown}, and ${remainingCount} more` : shown;
}

function hasPermission(permissions: bigint, permission: bigint): boolean {
  return (permissions & permission) === permission;
}
