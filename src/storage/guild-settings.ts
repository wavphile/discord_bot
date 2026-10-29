import type { DatabaseSync } from "node:sqlite";

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function validateKey(guildId: string, settingKey: string): void {
  if (!/^\d{17,20}$/.test(guildId)) {
    throw new TypeError("guildId must be a Discord snowflake.");
  }
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(settingKey)) {
    throw new TypeError("settingKey must use a lowercase configuration key.");
  }
}

export function getGuildSetting(
  database: DatabaseSync,
  guildId: string,
  settingKey: string,
): JsonValue | undefined {
  validateKey(guildId, settingKey);
  const row = database
    .prepare(
      "SELECT value_json FROM guild_settings WHERE guild_id = ? AND setting_key = ?",
    )
    .get(guildId, settingKey) as { value_json: string } | undefined;

  return row ? (JSON.parse(row.value_json) as JsonValue) : undefined;
}

export function setGuildSetting(
  database: DatabaseSync,
  guildId: string,
  settingKey: string,
  value: JsonValue,
): void {
  validateKey(guildId, settingKey);
  const valueJson = JSON.stringify(value);
  if (valueJson === undefined) {
    throw new TypeError("value must be JSON serializable.");
  }

  database
    .prepare(
      `
      INSERT INTO guild_settings (guild_id, setting_key, value_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (guild_id, setting_key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `,
    )
    .run(guildId, settingKey, valueJson, new Date().toISOString());
}

