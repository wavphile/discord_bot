import type { DatabaseSync } from "node:sqlite";

type Migration = Readonly<{
  version: number;
  name: string;
  up(database: DatabaseSync): void;
}>;

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "create_guild_settings",
    up(database) {
      database.exec(`
        CREATE TABLE guild_settings (
          guild_id TEXT NOT NULL,
          setting_key TEXT NOT NULL,
          value_json TEXT NOT NULL CHECK (json_valid(value_json)),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (guild_id, setting_key)
        ) WITHOUT ROWID;
      `);
    },
  },
  {
    version: 2,
    name: "create_configuration_snapshots",
    up(database) {
      database.exec(`
        CREATE TABLE configuration_snapshots (
          snapshot_id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          requested_by TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          schema_version INTEGER NOT NULL CHECK (schema_version > 0),
          visibility TEXT NOT NULL CHECK (visibility IN ('limited')),
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
        );
        CREATE INDEX configuration_snapshots_guild_captured
          ON configuration_snapshots (guild_id, captured_at DESC);
      `);
    },
  },
];
