import type { DatabaseSync } from "node:sqlite";
import { appendPlanAuditEvent } from "./plan-audit.js";

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
  {
    version: 6,
    name: "create_plan_audit_log",
    up(database) {
      database.exec(`
        ALTER TABLE change_plans
          ADD COLUMN reason TEXT NOT NULL DEFAULT 'No reason provided.';
        ALTER TABLE change_plans
          ADD COLUMN reversal_of_job_id TEXT;

        CREATE TABLE plan_audit_events (
          event_id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          approver_id TEXT,
          reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
          action TEXT NOT NULL,
          plan_id TEXT,
          job_id TEXT,
          ordinal INTEGER CHECK (ordinal IS NULL OR ordinal >= 0),
          channel_id TEXT,
          setting_key TEXT,
          subject_id TEXT,
          before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
          after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
          outcome TEXT NOT NULL,
          details TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX plan_audit_events_plan_created
          ON plan_audit_events (guild_id, plan_id, created_at DESC);
        CREATE INDEX plan_audit_events_job_created
          ON plan_audit_events (guild_id, job_id, created_at DESC);

        CREATE TRIGGER plan_audit_events_no_update
          BEFORE UPDATE ON plan_audit_events
          BEGIN
            SELECT RAISE(ABORT, 'plan audit events are append-only');
          END;
        CREATE TRIGGER plan_audit_events_no_delete
          BEFORE DELETE ON plan_audit_events
          BEGIN
            SELECT RAISE(ABORT, 'plan audit events are append-only');
          END;
      `);
      backfillPlanAuditEvents(database);
    },
  },
];

type HistoricalPlanRow = Readonly<{
  plan_id: string;
  guild_id: string;
  requested_by: string;
  reason: string;
  reversal_of_job_id: string | null;
  created_at: string;
  status: string;
  submitted_at: string | null;
  decision_by: string | null;
  decision_at: string | null;
}>;

type HistoricalItemRow = Readonly<{
  ordinal: number;
  channel_id: string;
  setting_key: string;
  subject_id: string | null;
  before_json: string;
  after_json: string;
}>;

type HistoricalJobRow = Readonly<{
  job_id: string;
  approved_by: string;
  created_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
}>;

type HistoricalJobItemRow = Readonly<{
  ordinal: number;
  status: string;
  attempts: number;
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
}>;

function backfillPlanAuditEvents(database: DatabaseSync): void {
  const plans = database
    .prepare(
      `SELECT plan_id, guild_id, requested_by, reason, reversal_of_job_id,
              created_at, status, submitted_at, decision_by, decision_at
       FROM change_plans ORDER BY created_at ASC, plan_id ASC`,
    )
    .all() as HistoricalPlanRow[];
  for (const plan of plans) {
    const items = database
      .prepare(
        `SELECT ordinal, channel_id, setting_key, subject_id,
                before_json, after_json
         FROM change_plan_items WHERE plan_id = ? ORDER BY ordinal ASC`,
      )
      .all(plan.plan_id) as HistoricalItemRow[];
    for (const item of items) {
      appendPlanAuditEvent(database, {
        guildId: plan.guild_id,
        actorId: plan.requested_by,
        reason: plan.reason,
        action: plan.reversal_of_job_id
          ? "reversal_preview_created"
          : "preview_created",
        planId: plan.plan_id,
        jobId: plan.reversal_of_job_id,
        ordinal: item.ordinal,
        channelId: item.channel_id,
        settingKey: item.setting_key,
        subjectId: item.subject_id,
        before: JSON.parse(item.before_json),
        after: JSON.parse(item.after_json),
        outcome: "historical_baseline",
        details:
          "Baseline imported during the audit migration; earlier event history is unavailable.",
        createdAt: parseHistoricalDate(plan.created_at),
      });
    }
    if (plan.submitted_at) {
      appendPlanAuditEvent(database, {
        guildId: plan.guild_id,
        actorId: plan.requested_by,
        reason: plan.reason,
        action: "plan_submitted",
        planId: plan.plan_id,
        outcome: "historical_baseline",
        details:
          "Submission metadata imported during the audit migration; earlier event history is unavailable.",
        createdAt: parseHistoricalDate(plan.submitted_at),
      });
    }
    if (plan.decision_by && plan.decision_at) {
      const action =
        plan.status === "rejected"
          ? "plan_rejected"
          : plan.status === "conflicted"
            ? "plan_conflicted"
            : "plan_approved";
      appendPlanAuditEvent(database, {
        guildId: plan.guild_id,
        actorId: plan.decision_by,
        approverId: plan.decision_by,
        reason: plan.reason,
        action,
        planId: plan.plan_id,
        outcome: plan.status,
        details:
          "Decision metadata imported during the audit migration; earlier event history is unavailable.",
        createdAt: parseHistoricalDate(plan.decision_at),
      });
    } else if (plan.status === "expired") {
      appendPlanAuditEvent(database, {
        guildId: plan.guild_id,
        actorId: plan.requested_by,
        reason: plan.reason,
        action: "plan_expired",
        planId: plan.plan_id,
        outcome: "expired",
        details:
          "Expired plan state imported during the audit migration; earlier event history is unavailable.",
      });
    }

    const jobs = database
      .prepare(
        `SELECT job_id, approved_by, created_by, created_at, started_at,
                finished_at, status
         FROM plan_jobs WHERE guild_id = ? AND plan_id = ? ORDER BY created_at`,
      )
      .all(plan.guild_id, plan.plan_id) as HistoricalJobRow[];
    for (const job of jobs) {
      const appendJobEvent = (
        action:
          | "job_queued"
          | "job_started"
          | "job_reconciliation_required"
          | "job_finished",
        outcome: string,
        createdAt: string | null,
      ) =>
        appendPlanAuditEvent(database, {
          guildId: plan.guild_id,
          actorId: job.created_by,
          approverId: job.approved_by,
          reason: plan.reason,
          action,
          planId: plan.plan_id,
          jobId: job.job_id,
          outcome,
          details:
            "Job state imported during the audit migration; earlier event history is unavailable.",
          ...(createdAt ? { createdAt: parseHistoricalDate(createdAt) } : {}),
        });
      appendJobEvent("job_queued", "queued", job.created_at);
      if (job.started_at)
        appendJobEvent("job_started", "running", job.started_at);

      const jobItems = database
        .prepare(
          `SELECT i.ordinal, i.status, i.attempts, i.last_error,
                  i.started_at, i.finished_at,
                  c.channel_id, c.setting_key, c.subject_id,
                  c.before_json, c.after_json
           FROM plan_job_items i
           JOIN change_plan_items c
             ON c.plan_id = i.plan_id AND c.ordinal = i.ordinal
           WHERE i.job_id = ? ORDER BY i.ordinal ASC`,
        )
        .all(job.job_id) as (HistoricalJobItemRow & HistoricalItemRow)[];
      for (const item of jobItems) {
        const action =
          item.status === "applying"
            ? "item_attempt_started"
            : item.status === "pending" && item.attempts > 0
              ? "item_retry_scheduled"
              : item.status === "applied" ||
                  item.status === "failed" ||
                  item.status === "conflicted" ||
                  item.status === "cancelled"
                ? "item_outcome"
                : null;
        if (!action) continue;
        const historicalItemAt =
          item.finished_at ??
          item.started_at ??
          job.started_at ??
          job.created_at;
        appendPlanAuditEvent(database, {
          guildId: plan.guild_id,
          actorId: job.created_by,
          approverId: job.approved_by,
          reason: plan.reason,
          action,
          planId: plan.plan_id,
          jobId: job.job_id,
          ordinal: item.ordinal,
          channelId: item.channel_id,
          settingKey: item.setting_key,
          subjectId: item.subject_id,
          before: JSON.parse(item.before_json),
          after: JSON.parse(item.after_json),
          outcome: item.status,
          details: [
            "Item state imported during the audit migration; earlier event history is unavailable.",
            `${item.attempts} prior attempt(s).`,
            item.last_error,
          ]
            .filter(Boolean)
            .join(" ")
            .slice(0, 1_000),
          createdAt: parseHistoricalDate(historicalItemAt),
        });
      }

      if (job.status === "reconciliation_required") {
        appendJobEvent(
          "job_reconciliation_required",
          job.status,
          job.started_at ?? job.created_at,
        );
      } else if (job.finished_at) {
        appendJobEvent("job_finished", job.status, job.finished_at);
      }
    }
  }
}

function parseHistoricalDate(value: string): Date {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}
