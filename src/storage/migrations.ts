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
];

