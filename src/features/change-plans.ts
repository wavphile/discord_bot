export const CHANGE_PLAN_TTL_MS = 30 * 60 * 1_000;
export const MAX_CHANGE_PLAN_ITEMS = 25;

export type RoleOverwriteValue = Readonly<{
  allow: string;
  deny: string;
}>;

export type PlannedChannelType = "text" | "voice";

export type ChangePlanChange =
  | Readonly<{
      channelId: string;
      settingKey: "channel.topic";
      before: string | null;
      after: string | null;
    }>
  | Readonly<{
      channelId: string;
      settingKey: "channel.slowmode";
      before: number;
      after: number;
    }>
  | Readonly<{
      channelId: string;
      channelType: PlannedChannelType;
      roleId: string;
      settingKey: "channel.role_overwrite";
      before: RoleOverwriteValue | null;
      after: RoleOverwriteValue | null;
    }>;

export type CreateChangePlanInput = Readonly<{
  guildId: string;
  requestedBy: string;
  sourceSnapshotId?: string | null;
  changes: readonly ChangePlanChange[];
}>;

export type ChangePlanStatus =
  | "preview"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "expired"
  | "applying"
  | "applied"
  | "partial"
  | "failed"
  | "conflicted"
  | "cancelled";

export type ChangePlan = Readonly<{
  id: string;
  guildId: string;
  requestedBy: string;
  sourceSnapshotId: string | null;
  createdAt: string;
  expiresAt: string;
  status: ChangePlanStatus;
  submittedAt: string | null;
  decisionBy: string | null;
  decisionAt: string | null;
  changes: readonly ChangePlanChange[];
}>;

export type PreparedChangePlan = Readonly<{
  guildId: string;
  requestedBy: string;
  sourceSnapshotId: string | null;
  createdAt: string;
  expiresAt: string;
  status: "preview";
  changes: readonly ChangePlanChange[];
}>;

export type ChangePlanPreviewNames = Readonly<{
  channels?: ReadonlyMap<string, string>;
  roles?: ReadonlyMap<string, string>;
}>;

export const CHANGE_PLAN_PERMISSION_BITS = {
  view_channel: 1n << 10n,
  send_messages: 1n << 11n,
  read_message_history: 1n << 16n,
  connect: 1n << 20n,
  speak: 1n << 21n,
} as const;

const snowflakePattern = /^\d{17,20}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxPermissionBits = (1n << 64n) - 1n;
const selectedTextOverwriteBits =
  CHANGE_PLAN_PERMISSION_BITS.view_channel |
  CHANGE_PLAN_PERMISSION_BITS.send_messages |
  CHANGE_PLAN_PERMISSION_BITS.read_message_history;
const selectedVoiceOverwriteBits =
  CHANGE_PLAN_PERMISSION_BITS.view_channel |
  CHANGE_PLAN_PERMISSION_BITS.connect |
  CHANGE_PLAN_PERMISSION_BITS.speak;
const previewMessageLimit = 1_850;
const previewValuePartLimit = 900;

export function prepareChangePlan(
  input: CreateChangePlanInput,
  now = new Date(),
): PreparedChangePlan {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Plan creation time must be a valid date.");
  }
  validateSnowflake(input.guildId, "guildId");
  validateSnowflake(input.requestedBy, "requestedBy");

  const sourceSnapshotId = input.sourceSnapshotId ?? null;
  if (sourceSnapshotId !== null && !uuidPattern.test(sourceSnapshotId)) {
    throw new TypeError("sourceSnapshotId must be a saved snapshot UUID.");
  }
  const changes = validateChangePlanChanges(input.changes);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + CHANGE_PLAN_TTL_MS).toISOString();
  return {
    guildId: input.guildId,
    requestedBy: input.requestedBy,
    sourceSnapshotId,
    createdAt,
    expiresAt,
    status: "preview",
    changes,
  };
}

export function validateChangePlanChanges(
  input: readonly ChangePlanChange[],
): readonly ChangePlanChange[] {
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > MAX_CHANGE_PLAN_ITEMS
  ) {
    throw new RangeError(
      `A change plan must contain between 1 and ${MAX_CHANGE_PLAN_ITEMS} items.`,
    );
  }

  const changes = input.map(normalizeChange);
  const seen = new Set<string>();
  for (const change of changes) {
    const key =
      change.settingKey === "channel.role_overwrite"
        ? `${change.channelId}:${change.settingKey}:${change.roleId}`
        : `${change.channelId}:${change.settingKey}`;
    if (seen.has(key)) {
      throw new TypeError(
        "A change plan cannot target the same setting twice.",
      );
    }
    seen.add(key);
  }

  return changes;
}

export function isChangePlanExpired(
  plan: Pick<ChangePlan, "expiresAt">,
  now = new Date(),
): boolean {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Plan check time must be a valid date.");
  }
  const expiry = Date.parse(plan.expiresAt);
  return !Number.isFinite(expiry) || expiry <= now.getTime();
}

export function formatChangePlanPreview(
  plan: ChangePlan,
  now = new Date(),
  names: ChangePlanPreviewNames = {},
): string[] {
  const expired =
    plan.status === "expired" ||
    ((plan.status === "preview" ||
      plan.status === "awaiting_approval" ||
      plan.status === "approved") &&
      isChangePlanExpired(plan, now));
  const header = [
    "**Change plan preview**",
    `Plan ID: \`${escapeInline(plan.id)}\` · Status: ${expired ? "expired" : escapeInline(plan.status)}`,
    `Server: \`${escapeInline(plan.guildId)}\` · Requester: \`${escapeInline(plan.requestedBy)}\``,
    `Created: ${formatTimestamp(plan.createdAt)} · Expires: ${formatTimestamp(plan.expiresAt)}`,
    `Source snapshot: ${plan.sourceSnapshotId ? `\`${escapeInline(plan.sourceSnapshotId.slice(0, 8))}\`` : "none"}`,
    "Preview only. No Discord changes have been applied.",
  ].join("\n");

  const messages = [header];
  for (const [index, change] of plan.changes.entries()) {
    const lines = formatChangeLines(
      index + 1,
      plan.changes.length,
      change,
      names,
    );
    for (const line of lines) {
      let current = messages.at(-1);
      if (!current) throw new Error("A preview message could not be created.");
      if (current.length + line.length + 1 > previewMessageLimit) {
        current = "**Change plan preview** (continued)";
        messages.push(current);
      }
      messages[messages.length - 1] = `${current}\n${line}`;
    }
  }

  return messages;
}

function normalizeChange(change: ChangePlanChange): ChangePlanChange {
  if (!isRecord(change)) {
    throw new TypeError("Every change plan item must be an object.");
  }
  validateSnowflake(change.channelId, "channelId");

  if (change.settingKey === "channel.topic") {
    validateTopic(change.before, "before");
    validateTopic(change.after, "after");
    if (change.before === change.after) {
      throw new TypeError("A change plan item must change its current value.");
    }
    return {
      channelId: change.channelId,
      settingKey: change.settingKey,
      before: change.before,
      after: change.after,
    };
  }

  if (change.settingKey === "channel.slowmode") {
    validateSlowmode(change.before, "before");
    validateSlowmode(change.after, "after");
    if (change.before === change.after) {
      throw new TypeError("A change plan item must change its current value.");
    }
    return {
      channelId: change.channelId,
      settingKey: change.settingKey,
      before: change.before,
      after: change.after,
    };
  }

  if (change.settingKey === "channel.role_overwrite") {
    validateChannelType(change.channelType);
    validateSnowflake(change.roleId, "roleId");
    const before = normalizeOverwrite(change.before, "before");
    const after = normalizeOverwrite(change.after, "after");
    if (JSON.stringify(before) === JSON.stringify(after)) {
      throw new TypeError("A change plan item must change its current value.");
    }
    validateSelectedOverwriteBits(change.channelType, before, after);
    return {
      channelId: change.channelId,
      channelType: change.channelType,
      roleId: change.roleId,
      settingKey: change.settingKey,
      before,
      after,
    };
  }

  throw new TypeError("The change plan setting is not supported.");
}

function validateChannelType(
  value: unknown,
): asserts value is PlannedChannelType {
  if (value !== "text" && value !== "voice") {
    throw new TypeError("channelType must be text or voice.");
  }
}

function validateSelectedOverwriteBits(
  channelType: PlannedChannelType,
  before: RoleOverwriteValue | null,
  after: RoleOverwriteValue | null,
): void {
  const beforeAllow = BigInt(before?.allow ?? "0");
  const beforeDeny = BigInt(before?.deny ?? "0");
  const afterAllow = BigInt(after?.allow ?? "0");
  const afterDeny = BigInt(after?.deny ?? "0");
  const changedBits = (beforeAllow ^ afterAllow) | (beforeDeny ^ afterDeny);
  if (changedBits === 0n) {
    throw new TypeError(
      "A role overwrite plan must change at least one selected permission bit.",
    );
  }
  const supportedBits =
    channelType === "text"
      ? selectedTextOverwriteBits
      : selectedVoiceOverwriteBits;
  if ((changedBits & ~supportedBits) !== 0n) {
    throw new TypeError(
      `Only selected permission bits for ${channelType} channels may change.`,
    );
  }
}

function normalizeOverwrite(
  value: RoleOverwriteValue | null,
  field: string,
): RoleOverwriteValue | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be null or a complete role overwrite.`);
  }
  const allow = validatePermissionBits(value["allow"], `${field}.allow`);
  const deny = validatePermissionBits(value["deny"], `${field}.deny`);
  if ((BigInt(allow) & BigInt(deny)) !== 0n) {
    throw new TypeError(
      `${field} cannot allow and deny the same permission bit.`,
    );
  }
  return { allow, deny };
}

function validatePermissionBits(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value)) {
    throw new TypeError(`${field} must be a decimal permission bitfield.`);
  }
  if (BigInt(value) > maxPermissionBits) {
    throw new RangeError(`${field} must fit in an unsigned 64-bit bitfield.`);
  }
  return value;
}

function validateTopic(
  value: unknown,
  field: string,
): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || value.length > 1_024)) {
    throw new TypeError(
      `${field} must be null or a string of at most 1,024 characters.`,
    );
  }
}

function validateSlowmode(
  value: unknown,
  field: string,
): asserts value is number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 21_600
  ) {
    throw new RangeError(`${field} must be an integer from 0 through 21,600.`);
  }
}

function validateSnowflake(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !snowflakePattern.test(value)) {
    throw new TypeError(`${field} must be a Discord snowflake.`);
  }
}

function formatChangeLines(
  index: number,
  total: number,
  change: ChangePlanChange,
  names: ChangePlanPreviewNames,
): string[] {
  const channelName = names.channels?.get(change.channelId);
  const channelLabel = channelName
    ? `#${escapeInline(channelName)} (${escapeInline(change.channelId)})`
    : escapeInline(change.channelId);
  const target = `Item ${index}/${total} · channel \`${channelLabel}\``;
  const roleName =
    change.settingKey === "channel.role_overwrite"
      ? names.roles?.get(change.roleId)
      : undefined;
  const setting =
    change.settingKey === "channel.role_overwrite"
      ? `${change.settingKey} · ${formatRolePermissionChanges(change)} for role \`${roleName ? `${escapeInline(roleName)} (${escapeInline(change.roleId)})` : escapeInline(change.roleId)}\``
      : change.settingKey;
  return [
    `${target} · ${setting}`,
    ...formatValueLines("Before", change.before),
    ...formatValueLines("After", change.after),
  ];
}

function formatRolePermissionChanges(
  change: Extract<ChangePlanChange, { settingKey: "channel.role_overwrite" }>,
): string {
  const beforeAllow = BigInt(change.before?.allow ?? "0");
  const beforeDeny = BigInt(change.before?.deny ?? "0");
  const afterAllow = BigInt(change.after?.allow ?? "0");
  const afterDeny = BigInt(change.after?.deny ?? "0");
  const changed = (beforeAllow ^ afterAllow) | (beforeDeny ^ afterDeny);
  const labels: Readonly<
    Record<keyof typeof CHANGE_PLAN_PERMISSION_BITS, string>
  > = {
    view_channel: "View Channel",
    send_messages: "Send Messages",
    read_message_history: "Read Message History",
    connect: "Connect",
    speak: "Speak",
  };

  return Object.entries(CHANGE_PLAN_PERMISSION_BITS)
    .filter(([, bit]) => (changed & bit) !== 0n)
    .map(([key, bit]) => {
      const state =
        (afterAllow & bit) !== 0n
          ? "allow"
          : (afterDeny & bit) !== 0n
            ? "deny"
            : "inherit";
      const label = labels[key as keyof typeof labels];
      return `${label}: ${state}`;
    })
    .join(", ");
}

function formatValueLines(label: string, value: unknown): string[] {
  const serialized = escapeInline(JSON.stringify(value) ?? "null");
  const parts = splitText(serialized, previewValuePartLimit);
  return parts.map((part, index) => {
    const suffix = parts.length > 1 ? ` (${index + 1}/${parts.length})` : "";
    return `  ${label}${suffix}: \`${part}\``;
  });
}

function splitText(value: string, maxLength: number): string[] {
  if (value.length <= maxLength) return [value];
  const parts: string[] = [];
  for (let offset = 0; offset < value.length; offset += maxLength) {
    parts.push(value.slice(offset, offset + maxLength));
  }
  return parts;
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? `<t:${Math.floor(timestamp / 1_000)}:R>`
    : "unknown";
}

function escapeInline(value: string): string {
  return value
    .replace(/`/g, "\\u0060")
    .replace(/@(everyone|here)/gi, "@​$1")
    .replace(/[\r\n]+/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
