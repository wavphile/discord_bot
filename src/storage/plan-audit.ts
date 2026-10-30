import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type PlanAuditAction =
  | "preview_created"
  | "reversal_preview_created"
  | "plan_submitted"
  | "plan_approved"
  | "plan_rejected"
  | "plan_conflicted"
  | "plan_expired"
  | "job_queued"
  | "job_started"
  | "item_attempt_started"
  | "item_retry_scheduled"
  | "item_outcome"
  | "item_reconciled"
  | "job_cancel_requested"
  | "item_cancelled"
  | "job_reconciliation_required"
  | "job_finished";

export type PlanAuditEventInput = Readonly<{
  guildId: string;
  actorId: string;
  approverId?: string | null;
  reason: string;
  action: PlanAuditAction;
  planId?: string | null;
  jobId?: string | null;
  ordinal?: number | null;
  channelId?: string | null;
  settingKey?: string | null;
  subjectId?: string | null;
  before?: unknown;
  after?: unknown;
  outcome: string;
  details?: string | null;
  createdAt?: Date;
}>;

export type PlanAuditEvent = Readonly<{
  id: string;
  guildId: string;
  actorId: string;
  approverId: string | null;
  reason: string;
  action: PlanAuditAction;
  planId: string | null;
  jobId: string | null;
  ordinal: number | null;
  channelId: string | null;
  settingKey: string | null;
  subjectId: string | null;
  before: unknown;
  after: unknown;
  outcome: string;
  details: string | null;
  createdAt: string;
}>;

export type PlanAuditPage = Readonly<{
  events: readonly PlanAuditEvent[];
  nextBeforeEventId: string | null;
}>;

type PlanAuditEventRow = Readonly<{
  event_id: string;
  guild_id: string;
  actor_id: string;
  approver_id: string | null;
  reason: string;
  action: string;
  plan_id: string | null;
  job_id: string | null;
  ordinal: number | null;
  channel_id: string | null;
  setting_key: string | null;
  subject_id: string | null;
  before_json: string | null;
  after_json: string | null;
  outcome: string;
  details: string | null;
  created_at: string;
}>;

const snowflakePattern = /^\d{17,20}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actions = new Set<PlanAuditAction>([
  "preview_created",
  "reversal_preview_created",
  "plan_submitted",
  "plan_approved",
  "plan_rejected",
  "plan_conflicted",
  "plan_expired",
  "job_queued",
  "job_started",
  "item_attempt_started",
  "item_retry_scheduled",
  "item_outcome",
  "item_reconciled",
  "job_cancel_requested",
  "item_cancelled",
  "job_reconciliation_required",
  "job_finished",
]);

export function appendPlanAuditEvent(
  database: DatabaseSync,
  input: PlanAuditEventInput,
): string {
  validateEvent(input);
  const eventId = randomUUID();
  database
    .prepare(
      `INSERT INTO plan_audit_events
        (event_id, guild_id, actor_id, approver_id, reason, action, plan_id,
         job_id, ordinal, channel_id, setting_key, subject_id, before_json,
         after_json, outcome, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventId,
      input.guildId,
      input.actorId,
      input.approverId ?? null,
      input.reason.trim(),
      input.action,
      input.planId ?? null,
      input.jobId ?? null,
      input.ordinal ?? null,
      input.channelId ?? null,
      input.settingKey ?? null,
      input.subjectId ?? null,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.outcome,
      input.details ?? null,
      (input.createdAt ?? new Date()).toISOString(),
    );
  return eventId;
}

export function listPlanAuditEvents(
  database: DatabaseSync,
  guildId: string,
  planId: string,
  limit = 50,
  beforeEventId?: string,
): PlanAuditPage {
  if (!snowflakePattern.test(guildId)) {
    throw new TypeError("guildId must be a Discord snowflake.");
  }
  if (!uuidPattern.test(planId)) {
    throw new TypeError("planId must be a change plan UUID.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Audit event limit must be between 1 and 100.");
  }
  let rows: PlanAuditEventRow[];
  if (beforeEventId !== undefined) {
    if (!uuidPattern.test(beforeEventId)) {
      throw new TypeError("beforeEventId must be an audit event UUID.");
    }
    const cursor = database
      .prepare(
        `SELECT created_at FROM plan_audit_events
         WHERE guild_id = ? AND plan_id = ? AND event_id = ?`,
      )
      .get(guildId, planId, beforeEventId) as
      { created_at: string } | undefined;
    if (!cursor) {
      throw new RangeError("The audit cursor was not found for this plan.");
    }
    rows = database
      .prepare(
        `SELECT event_id, guild_id, actor_id, approver_id, reason, action,
                plan_id, job_id, ordinal, channel_id, setting_key, subject_id,
                before_json, after_json, outcome, details, created_at
         FROM plan_audit_events
         WHERE guild_id = ? AND plan_id = ?
           AND (created_at < ? OR (created_at = ? AND event_id < ?))
         ORDER BY created_at DESC, event_id DESC LIMIT ?`,
      )
      .all(
        guildId,
        planId,
        cursor.created_at,
        cursor.created_at,
        beforeEventId,
        limit + 1,
      ) as PlanAuditEventRow[];
  } else {
    rows = database
      .prepare(
        `SELECT event_id, guild_id, actor_id, approver_id, reason, action,
              plan_id, job_id, ordinal, channel_id, setting_key, subject_id,
              before_json, after_json, outcome, details, created_at
       FROM plan_audit_events
       WHERE guild_id = ? AND plan_id = ?
       ORDER BY created_at DESC, event_id DESC LIMIT ?`,
      )
      .all(guildId, planId, limit + 1) as PlanAuditEventRow[];
  }
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  return {
    events: pageRows.map(parseAuditEvent),
    nextBeforeEventId: hasMore ? (pageRows.at(-1)?.event_id ?? null) : null,
  };
}

function parseAuditEvent(row: PlanAuditEventRow): PlanAuditEvent {
  if (
    !uuidPattern.test(row.event_id) ||
    !snowflakePattern.test(row.guild_id) ||
    !snowflakePattern.test(row.actor_id) ||
    (row.approver_id !== null && !snowflakePattern.test(row.approver_id)) ||
    !actions.has(row.action as PlanAuditAction) ||
    (row.plan_id !== null && !uuidPattern.test(row.plan_id)) ||
    (row.job_id !== null && !uuidPattern.test(row.job_id)) ||
    (row.ordinal !== null &&
      (!Number.isSafeInteger(row.ordinal) || row.ordinal < 0)) ||
    !Number.isFinite(Date.parse(row.created_at))
  ) {
    throw new Error("A saved plan audit event contains invalid metadata.");
  }
  return {
    id: row.event_id,
    guildId: row.guild_id,
    actorId: row.actor_id,
    approverId: row.approver_id,
    reason: row.reason,
    action: row.action as PlanAuditAction,
    planId: row.plan_id,
    jobId: row.job_id,
    ordinal: row.ordinal,
    channelId: row.channel_id,
    settingKey: row.setting_key,
    subjectId: row.subject_id,
    before: row.before_json === null ? null : JSON.parse(row.before_json),
    after: row.after_json === null ? null : JSON.parse(row.after_json),
    outcome: row.outcome,
    details: row.details,
    createdAt: row.created_at,
  };
}

function validateEvent(input: PlanAuditEventInput): void {
  if (!snowflakePattern.test(input.guildId)) {
    throw new TypeError("guildId must be a Discord snowflake.");
  }
  if (!snowflakePattern.test(input.actorId)) {
    throw new TypeError("actorId must be a Discord snowflake.");
  }
  if (input.approverId != null && !snowflakePattern.test(input.approverId)) {
    throw new TypeError("approverId must be a Discord snowflake.");
  }
  if (input.planId != null && !uuidPattern.test(input.planId)) {
    throw new TypeError("planId must be a change plan UUID.");
  }
  if (input.jobId != null && !uuidPattern.test(input.jobId)) {
    throw new TypeError("jobId must be a plan job UUID.");
  }
  if (
    input.ordinal != null &&
    (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0)
  ) {
    throw new TypeError("ordinal must be a non-negative safe integer.");
  }
  if (!actions.has(input.action)) {
    throw new TypeError("action is not a supported plan audit event.");
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) {
    throw new RangeError("reason must contain between 1 and 500 characters.");
  }
  if (!input.outcome.trim() || input.outcome.length > 100) {
    throw new RangeError("outcome must contain between 1 and 100 characters.");
  }
  if (input.details != null && input.details.length > 1_000) {
    throw new RangeError("Audit details cannot exceed 1,000 characters.");
  }
  if (input.settingKey != null && input.settingKey.length > 100) {
    throw new RangeError("settingKey cannot exceed 100 characters.");
  }
  if (input.createdAt && !Number.isFinite(input.createdAt.getTime())) {
    throw new TypeError("createdAt must be a valid date.");
  }
}

export function auditValuesForChange(
  change: Readonly<{
    channelId: string;
    settingKey: string;
    before: unknown;
    after: unknown;
    roleId?: string;
  }>,
): Pick<
  PlanAuditEventInput,
  "channelId" | "settingKey" | "subjectId" | "before" | "after"
> {
  return {
    channelId: change.channelId,
    settingKey: change.settingKey,
    subjectId: change.roleId ?? null,
    before: change.before,
    after: change.after,
  };
}
