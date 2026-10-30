import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "./guild-settings.js";

export const SNAPSHOT_SCHEMA_VERSION = 1;

export type ConfigurationSnapshot = Readonly<{
  guild: {
    id: string;
    name: string;
    description: string | null;
    icon: string | null;
    features: string[];
    preferred_locale: string;
    verification_level: number;
    default_message_notifications: number;
    explicit_content_filter: number;
    afk_channel_id: string | null;
    afk_timeout: number;
    system_channel_id: string | null;
    system_channel_flags: string;
    rules_channel_id: string | null;
    public_updates_channel_id: string | null;
    mfa_level: number;
    nsfw_level: number;
    premium_tier: number;
  };
  roles: Array<{
    id: string;
    name: string;
    position: number;
    permissions: string;
    colors: {
      primary_color: number;
      secondary_color: number | null;
      tertiary_color: number | null;
    };
    hoist: boolean;
    managed: boolean;
    mentionable: boolean;
    flags: string;
  }>;
  channels: Array<{
    id: string;
    type: number;
    name: string;
    position: number;
    parent_id: string | null;
    topic: string | null;
    nsfw: boolean | null;
    rate_limit_per_user: number | null;
    viewable: boolean;
    permission_overwrites: Array<{
      id: string;
      type: number;
      allow: string;
      deny: string;
    }>;
  }>;
  visibility: {
    state: "limited";
    note: string;
    returned_unviewable_channel_count: number;
  };
}>;

export type SavedConfigurationSnapshot = Readonly<{
  id: string;
  guildId: string;
  requestedBy: string;
  capturedAt: string;
  schemaVersion: number;
  visibility: "limited";
  payload: ConfigurationSnapshot;
}>;

export class UnsupportedSnapshotSchemaVersionError extends Error {
  constructor(readonly version: number) {
    super(`Saved snapshot schema version ${version} is not supported.`);
  }
}

function validateSnowflake(value: string, field: string): void {
  if (!/^\d{17,20}$/.test(value)) {
    throw new TypeError(`${field} must be a Discord snowflake.`);
  }
}

export function saveConfigurationSnapshot(
  database: DatabaseSync,
  input: Omit<
    SavedConfigurationSnapshot,
    "id" | "capturedAt" | "schemaVersion"
  >,
): SavedConfigurationSnapshot {
  validateSnowflake(input.guildId, "guildId");
  validateSnowflake(input.requestedBy, "requestedBy");

  const snapshot: SavedConfigurationSnapshot = {
    ...input,
    id: randomUUID(),
    capturedAt: new Date().toISOString(),
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  };
  const payload = snapshot.payload as unknown as JsonValue;
  const payloadJson = JSON.stringify(payload);
  if (payloadJson === undefined) {
    throw new TypeError("Snapshot payload must be JSON serializable.");
  }

  database
    .prepare(
      `
      INSERT INTO configuration_snapshots
        (snapshot_id, guild_id, requested_by, captured_at, schema_version, visibility, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      snapshot.id,
      snapshot.guildId,
      snapshot.requestedBy,
      snapshot.capturedAt,
      snapshot.schemaVersion,
      snapshot.visibility,
      payloadJson,
    );

  return snapshot;
}

export function getLatestConfigurationSnapshots(
  database: DatabaseSync,
  guildId: string,
  limit = 2,
): SavedConfigurationSnapshot[] {
  validateSnowflake(guildId, "guildId");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Snapshot query limit must be between 1 and 100.");
  }

  const rows = database
    .prepare(
      `
      SELECT snapshot_id, guild_id, requested_by, captured_at,
             schema_version, visibility, payload_json
      FROM configuration_snapshots
      WHERE guild_id = ?
      ORDER BY captured_at DESC, rowid DESC
      LIMIT ?
    `,
    )
    .all(guildId, limit) as Array<{
    snapshot_id: string;
    guild_id: string;
    requested_by: string;
    captured_at: string;
    schema_version: number;
    visibility: string;
    payload_json: string;
  }>;

  return rows.map((row) => {
    if (row.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
      throw new UnsupportedSnapshotSchemaVersionError(row.schema_version);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      throw new Error("A saved snapshot payload could not be read.");
    }

    if (!isConfigurationSnapshot(payload) || payload.guild.id !== guildId) {
      throw new Error("A saved snapshot has an invalid or mismatched payload.");
    }
    if (row.visibility !== "limited") {
      throw new Error("A saved snapshot has an unsupported visibility state.");
    }

    return {
      id: row.snapshot_id,
      guildId: row.guild_id,
      requestedBy: row.requested_by,
      capturedAt: row.captured_at,
      schemaVersion: row.schema_version,
      visibility: "limited",
      payload,
    };
  });
}

function isConfigurationSnapshot(
  value: unknown,
): value is ConfigurationSnapshot {
  if (!isRecord(value) || !isRecord(value["guild"])) return false;
  const guild = value["guild"];
  const roles = value["roles"];
  const channels = value["channels"];
  const visibility = value["visibility"];
  if (
    typeof guild["id"] !== "string" ||
    typeof guild["name"] !== "string" ||
    !isNullableString(guild["description"]) ||
    !isNullableString(guild["icon"]) ||
    !isStringArray(guild["features"]) ||
    typeof guild["preferred_locale"] !== "string" ||
    typeof guild["verification_level"] !== "number" ||
    typeof guild["default_message_notifications"] !== "number" ||
    typeof guild["explicit_content_filter"] !== "number" ||
    !isNullableString(guild["afk_channel_id"]) ||
    typeof guild["afk_timeout"] !== "number" ||
    !isNullableString(guild["system_channel_id"]) ||
    typeof guild["system_channel_flags"] !== "string" ||
    !isNullableString(guild["rules_channel_id"]) ||
    !isNullableString(guild["public_updates_channel_id"]) ||
    typeof guild["mfa_level"] !== "number" ||
    typeof guild["nsfw_level"] !== "number" ||
    typeof guild["premium_tier"] !== "number" ||
    !Array.isArray(roles) ||
    !Array.isArray(channels) ||
    !isRecord(visibility)
  ) {
    return false;
  }

  return (
    roles.every(
      (role) =>
        isRecord(role) &&
        typeof role["id"] === "string" &&
        typeof role["name"] === "string" &&
        typeof role["position"] === "number" &&
        typeof role["permissions"] === "string" &&
        isRecord(role["colors"]) &&
        typeof role["colors"]["primary_color"] === "number" &&
        isNullableNumber(role["colors"]["secondary_color"]) &&
        isNullableNumber(role["colors"]["tertiary_color"]) &&
        typeof role["hoist"] === "boolean" &&
        typeof role["managed"] === "boolean" &&
        typeof role["mentionable"] === "boolean" &&
        typeof role["flags"] === "string",
    ) &&
    channels.every(
      (channel) =>
        isRecord(channel) &&
        typeof channel["id"] === "string" &&
        typeof channel["type"] === "number" &&
        typeof channel["name"] === "string" &&
        typeof channel["position"] === "number" &&
        isNullableString(channel["parent_id"]) &&
        isNullableString(channel["topic"]) &&
        isNullableBoolean(channel["nsfw"]) &&
        isNullableNumber(channel["rate_limit_per_user"]) &&
        typeof channel["viewable"] === "boolean" &&
        Array.isArray(channel["permission_overwrites"]) &&
        channel["permission_overwrites"].every(
          (overwrite) =>
            isRecord(overwrite) &&
            typeof overwrite["id"] === "string" &&
            typeof overwrite["type"] === "number" &&
            typeof overwrite["allow"] === "string" &&
            typeof overwrite["deny"] === "string",
        ),
    ) &&
    visibility["state"] === "limited" &&
    typeof visibility["note"] === "string" &&
    typeof visibility["returned_unviewable_channel_count"] === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}
