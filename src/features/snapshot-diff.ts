import type {
  ConfigurationSnapshot,
  SavedConfigurationSnapshot,
} from "../storage/snapshots.js";

export type SnapshotDiffEntry = Readonly<{
  category: "guild" | "role" | "channel";
  kind:
    | "changed"
    | "added"
    | "removed"
    | "newly_returned"
    | "no_longer_returned"
    | "incomplete";
  entity: string;
  field?: string;
  before?: string;
  after?: string;
}>;

export type ConfigurationSnapshotDiff = Readonly<{
  before: SavedConfigurationSnapshot;
  after: SavedConfigurationSnapshot;
  entries: readonly SnapshotDiffEntry[];
}>;

export class SnapshotComparisonError extends Error {
  constructor(
    readonly reason: "same_snapshot" | "different_guilds" | "schema_mismatch",
  ) {
    super(
      reason === "same_snapshot"
        ? "Choose two different configuration snapshots."
        : reason === "different_guilds"
          ? "Configuration snapshots can only be compared within the same server."
          : "Configuration snapshots use different schema versions and cannot be compared.",
    );
  }
}

const guildFields = [
  "name",
  "description",
  "icon",
  "features",
  "preferred_locale",
  "verification_level",
  "default_message_notifications",
  "explicit_content_filter",
  "afk_channel_id",
  "afk_timeout",
  "system_channel_id",
  "system_channel_flags",
  "rules_channel_id",
  "public_updates_channel_id",
  "mfa_level",
  "nsfw_level",
  "premium_tier",
] as const;

const roleFields = [
  "name",
  "position",
  "permissions",
  "colors.primary_color",
  "colors.secondary_color",
  "colors.tertiary_color",
  "hoist",
  "managed",
  "mentionable",
  "flags",
] as const;

const channelFields = [
  "type",
  "name",
  "position",
  "parent_id",
  "topic",
  "nsfw",
  "rate_limit_per_user",
] as const;

export function compareConfigurationSnapshots(
  before: SavedConfigurationSnapshot,
  after: SavedConfigurationSnapshot,
): ConfigurationSnapshotDiff {
  if (before.id === after.id) {
    throw new SnapshotComparisonError("same_snapshot");
  }
  if (before.guildId !== after.guildId) {
    throw new SnapshotComparisonError("different_guilds");
  }
  if (before.schemaVersion !== after.schemaVersion) {
    throw new SnapshotComparisonError("schema_mismatch");
  }
  if (
    before.payload.guild.id !== after.payload.guild.id ||
    before.payload.guild.id !== before.guildId
  ) {
    throw new SnapshotComparisonError("different_guilds");
  }

  const entries: SnapshotDiffEntry[] = [];
  compareFields(
    entries,
    "guild",
    "Server settings",
    before.payload.guild,
    after.payload.guild,
    guildFields,
  );
  compareRoles(entries, before.payload.roles, after.payload.roles);
  compareChannels(entries, before.payload, after.payload);

  if (
    before.payload.visibility.returned_unviewable_channel_count !==
    after.payload.visibility.returned_unviewable_channel_count
  ) {
    entries.push({
      category: "channel",
      kind: "changed",
      entity: "Channel visibility",
      field: "returned unviewable channel count",
      before: String(
        before.payload.visibility.returned_unviewable_channel_count,
      ),
      after: String(after.payload.visibility.returned_unviewable_channel_count),
    });
  }

  return { before, after, entries };
}

export function formatConfigurationSnapshotDiff(
  diff: ConfigurationSnapshotDiff,
): string {
  const lines = [
    "**Server snapshot comparison**",
    `Older: ${formatCapturedAt(diff.before.capturedAt)} (\`${escapeText(diff.before.id.slice(0, 8))}\`)`,
    `Newer: ${formatCapturedAt(diff.after.capturedAt)} (\`${escapeText(diff.after.id.slice(0, 8))}\`)`,
    "Both channel lists have limited visibility. A channel returned in only one snapshot may have been added or removed, or may have become visible or inaccessible; presence alone does not prove which. Unviewable channel details are not compared.",
    diff.entries.length === 0
      ? "No supported differences were found in the comparable data."
      : `${diff.entries.length} difference(s) found in the comparable data:`,
  ];

  let content = lines.join("\n");
  let omitted = 0;
  for (const entry of diff.entries) {
    const line = `• ${formatEntry(entry)}`;
    if (content.length + line.length + 1 > 1_850) {
      omitted += 1;
      continue;
    }
    content += `\n${line}`;
  }

  if (omitted > 0) {
    content += `\n… ${omitted} additional difference(s) omitted to fit in one message.`;
  }
  return content;
}

function compareRoles(
  entries: SnapshotDiffEntry[],
  beforeRoles: ConfigurationSnapshot["roles"],
  afterRoles: ConfigurationSnapshot["roles"],
): void {
  const before = mapUniqueById(beforeRoles, "role");
  const after = mapUniqueById(afterRoles, "role");
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();

  for (const id of ids) {
    const older = before.get(id);
    const newer = after.get(id);
    if (!older && newer) {
      entries.push({ category: "role", kind: "added", entity: newer.name });
    } else if (older && !newer) {
      entries.push({ category: "role", kind: "removed", entity: older.name });
    } else if (older && newer) {
      compareFields(entries, "role", newer.name, older, newer, roleFields);
    }
  }
}

function compareChannels(
  entries: SnapshotDiffEntry[],
  beforeSnapshot: ConfigurationSnapshot,
  afterSnapshot: ConfigurationSnapshot,
): void {
  const before = mapUniqueById(beforeSnapshot.channels, "channel");
  const after = mapUniqueById(afterSnapshot.channels, "channel");
  const roleNames = new Map(
    [...beforeSnapshot.roles, ...afterSnapshot.roles].map((role) => [
      role.id,
      role.name,
    ]),
  );
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();

  for (const id of ids) {
    const older = before.get(id);
    const newer = after.get(id);
    if (!older && newer) {
      entries.push({
        category: "channel",
        kind: "newly_returned",
        entity: newer.name,
        after: newer.viewable ? "viewable" : "not viewable",
      });
      continue;
    }
    if (older && !newer) {
      entries.push({
        category: "channel",
        kind: "no_longer_returned",
        entity: older.name,
        before: older.viewable ? "viewable" : "not viewable",
      });
      continue;
    }
    if (!older || !newer) continue;

    if (older.viewable !== newer.viewable) {
      entries.push({
        category: "channel",
        kind: "changed",
        entity: newer.name,
        field: "visibility to the bot",
        before: older.viewable ? "viewable" : "not viewable",
        after: newer.viewable ? "viewable" : "not viewable",
      });
    }

    if (!older.viewable || !newer.viewable) {
      entries.push({
        category: "channel",
        kind: "incomplete",
        entity: newer.name,
        before: older.viewable ? "viewable" : "not viewable",
        after: newer.viewable ? "viewable" : "not viewable",
      });
      continue;
    }

    compareFields(entries, "channel", newer.name, older, newer, channelFields);
    compareOverwrites(entries, older, newer, roleNames);
  }
}

function compareOverwrites(
  entries: SnapshotDiffEntry[],
  olderChannel: ConfigurationSnapshot["channels"][number],
  newerChannel: ConfigurationSnapshot["channels"][number],
  roleNames: ReadonlyMap<string, string>,
): void {
  const before = new Map(
    olderChannel.permission_overwrites.map((overwrite) => [
      `${overwrite.type}:${overwrite.id}`,
      overwrite,
    ]),
  );
  const after = new Map(
    newerChannel.permission_overwrites.map((overwrite) => [
      `${overwrite.type}:${overwrite.id}`,
      overwrite,
    ]),
  );
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();

  for (const key of keys) {
    const older = before.get(key);
    const newer = after.get(key);
    const target = newer ?? older;
    if (!target) continue;
    const targetName = formatOverwriteTarget(target, roleNames);
    const fieldPrefix = `permission overwrite ${targetName}`;

    if (!older && newer) {
      entries.push({
        category: "channel",
        kind: "added",
        entity: newerChannel.name,
        field: fieldPrefix,
        before: "none",
        after: `allow ${newer.allow}, deny ${newer.deny}`,
      });
      continue;
    }
    if (older && !newer) {
      entries.push({
        category: "channel",
        kind: "removed",
        entity: olderChannel.name,
        field: fieldPrefix,
        before: `allow ${older.allow}, deny ${older.deny}`,
        after: "none",
      });
      continue;
    }
    if (!older || !newer) continue;

    if (older.allow !== newer.allow) {
      entries.push({
        category: "channel",
        kind: "changed",
        entity: newerChannel.name,
        field: `${fieldPrefix} allow bits`,
        before: older.allow,
        after: newer.allow,
      });
    }
    if (older.deny !== newer.deny) {
      entries.push({
        category: "channel",
        kind: "changed",
        entity: newerChannel.name,
        field: `${fieldPrefix} deny bits`,
        before: older.deny,
        after: newer.deny,
      });
    }
  }
}

function compareFields(
  entries: SnapshotDiffEntry[],
  category: SnapshotDiffEntry["category"],
  entity: string,
  older: object,
  newer: object,
  fields: readonly string[],
): void {
  for (const field of fields) {
    const before = getFieldValue(older, field);
    const after = getFieldValue(newer, field);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    entries.push({
      category,
      kind: "changed",
      entity,
      field,
      before: displayValue(before),
      after: displayValue(after),
    });
  }
}

function getFieldValue(value: object, field: string): unknown {
  return field.split(".").reduce<unknown>(
    (current, key) => {
      if (typeof current !== "object" || current === null) return undefined;
      return (current as Record<string, unknown>)[key];
    },
    value as Record<string, unknown>,
  );
}

function mapUniqueById<T extends { id: string }>(
  values: readonly T[],
  kind: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.id)) {
      throw new Error(`A snapshot contains duplicate ${kind} identifiers.`);
    }
    result.set(value.id, value);
  }
  return result;
}

function formatOverwriteTarget(
  overwrite: ConfigurationSnapshot["channels"][number]["permission_overwrites"][number],
  roleNames: ReadonlyMap<string, string>,
): string {
  if (overwrite.type === 0) {
    return `role ${roleNames.get(overwrite.id) ?? overwrite.id}`;
  }
  return `member ${overwrite.id}`;
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) return "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "none";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatEntry(entry: SnapshotDiffEntry): string {
  const entity = `**${escapeText(entry.entity)}**`;
  if (entry.kind === "added") {
    return `${categoryName(entry.category)} added: ${entity}${formatField(entry.field)}${formatTransition(entry)}`;
  }
  if (entry.kind === "removed") {
    return `${categoryName(entry.category)} removed: ${entity}${formatField(entry.field)}${formatTransition(entry)}`;
  }
  if (entry.kind === "newly_returned") {
    return `Channel newly returned: ${entity} (${escapeText(entry.after ?? "visibility unknown")}; may be new or newly visible)`;
  }
  if (entry.kind === "no_longer_returned") {
    return `Channel no longer returned: ${entity} (${escapeText(entry.before ?? "visibility unknown")}; may be removed or inaccessible)`;
  }
  if (entry.kind === "incomplete") {
    return `Channel ${entity}: details not compared because it was unviewable in at least one snapshot`;
  }
  return `${categoryName(entry.category)} ${entity} ${formatField(entry.field)} changed: ${escapeText(entry.before ?? "none")} → ${escapeText(entry.after ?? "none")}`;
}

function categoryName(category: SnapshotDiffEntry["category"]): string {
  if (category === "guild") return "Server setting";
  if (category === "role") return "Role";
  return "Channel";
}

function formatField(field: string | undefined): string {
  if (!field) return "";
  return (
    " `" + escapeText(field.replaceAll("_", " ").replaceAll(".", " › ")) + "`"
  );
}

function formatTransition(entry: SnapshotDiffEntry): string {
  if (entry.before === undefined && entry.after === undefined) return "";
  return `: ${escapeText(entry.before ?? "none")} → ${escapeText(entry.after ?? "none")}`;
}

function formatCapturedAt(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? `<t:${Math.floor(timestamp / 1000)}:F>`
    : "unknown time";
}

function escapeText(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\*_~|`>])/g, "\\$1")
    .replace(/@(everyone|here)/gi, "@​$1")
    .slice(0, 140);
}
