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
