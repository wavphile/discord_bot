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
  {
    version: 3,
    name: "create_change_plans",
    up(database) {
      database.exec(`
        CREATE TABLE change_plans (
          plan_id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          requested_by TEXT NOT NULL,
          source_snapshot_id TEXT REFERENCES configuration_snapshots(snapshot_id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'preview', 'awaiting_approval', 'approved', 'rejected', 'expired',
            'applying', 'applied', 'partial', 'failed', 'conflicted', 'cancelled'
          ))
        );
        CREATE INDEX change_plans_guild_created
          ON change_plans (guild_id, created_at DESC);

        CREATE TABLE change_plan_items (
          plan_id TEXT NOT NULL REFERENCES change_plans(plan_id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          channel_id TEXT NOT NULL,
          channel_type TEXT NOT NULL CHECK (channel_type IN ('text', 'voice')),
          setting_key TEXT NOT NULL CHECK (setting_key IN (
            'channel.topic', 'channel.slowmode', 'channel.role_overwrite'
          )),
          subject_id TEXT,
          before_json TEXT NOT NULL CHECK (json_valid(before_json)),
          after_json TEXT NOT NULL CHECK (json_valid(after_json)),
          PRIMARY KEY (plan_id, ordinal),
          CHECK (
            (setting_key = 'channel.role_overwrite' AND subject_id IS NOT NULL)
            OR
            (setting_key <> 'channel.role_overwrite' AND subject_id IS NULL)
          ),
          CHECK (
            setting_key = 'channel.role_overwrite' OR channel_type = 'text'
          )
        );
        CREATE INDEX change_plan_items_channel
          ON change_plan_items (channel_id, setting_key);
      `);
    },
  },
  {
    version: 4,
    name: "add_change_plan_approval_metadata",
    up(database) {
      database.exec(`
        ALTER TABLE change_plans ADD COLUMN submitted_at TEXT;
        ALTER TABLE change_plans ADD COLUMN decision_by TEXT;
        ALTER TABLE change_plans ADD COLUMN decision_at TEXT;
      `);
    },
  },
  {
    version: 5,
    name: "create_durable_plan_jobs",
    up(database) {
      database.exec(`
        CREATE TABLE plan_jobs (
          job_id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL UNIQUE REFERENCES change_plans(plan_id),
          guild_id TEXT NOT NULL,
          requested_by TEXT NOT NULL,
          approved_by TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          status TEXT NOT NULL CHECK (status IN (
            'queued', 'running', 'reconciliation_required',
            'applied', 'partial', 'failed', 'conflicted', 'cancelled'
          )),
          cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1))
        );
        CREATE INDEX plan_jobs_guild_status_created
          ON plan_jobs (guild_id, status, created_at);

        CREATE TABLE plan_job_items (
          job_id TEXT NOT NULL REFERENCES plan_jobs(job_id) ON DELETE CASCADE,
          plan_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          status TEXT NOT NULL CHECK (status IN (
            'pending', 'applying', 'applied', 'failed', 'conflicted', 'cancelled'
          )),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          last_error TEXT,
          started_at TEXT,
          finished_at TEXT,
          PRIMARY KEY (job_id, ordinal),
          FOREIGN KEY (plan_id, ordinal)
            REFERENCES change_plan_items(plan_id, ordinal)
        ) WITHOUT ROWID;
        CREATE INDEX plan_job_items_status
          ON plan_job_items (job_id, status, ordinal);
      `);
    },
  },
];
