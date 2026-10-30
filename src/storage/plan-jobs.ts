import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  PlanJob,
  PlanJobItemStatus,
  PlanJobStatus,
} from "../features/durable-plan-jobs.js";
import type { ChangePlanStatus } from "../features/change-plans.js";
import { getChangePlan } from "./change-plans.js";
import { appendPlanAuditEvent, type PlanAuditAction } from "./plan-audit.js";

type PlanJobRow = Readonly<{
  job_id: string;
  plan_id: string;
  guild_id: string;
  requested_by: string;
  approved_by: string;
  created_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  cancel_requested: number;
}>;

type PlanJobItemRow = Readonly<{
  ordinal: number;
  status: string;
  attempts: number;
  last_error: string | null;
}>;

const snowflakePattern = /^\d{17,20}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const jobStatuses = new Set<PlanJobStatus>([
  "queued",
  "running",
  "reconciliation_required",
  "applied",
  "partial",
  "failed",
  "conflicted",
  "cancelled",
]);
const itemStatuses = new Set<PlanJobItemStatus>([
  "pending",
  "applying",
  "applied",
  "failed",
  "conflicted",
  "cancelled",
]);

export type PlanJobStorageErrorCode =
  | "not_found"
  | "plan_not_approved"
  | "expired"
  | "already_queued"
  | "wrong_status"
  | "cancelled"
  | "raced";

export class PlanJobStorageError extends Error {
  constructor(readonly code: PlanJobStorageErrorCode) {
    super(planJobErrorMessage(code));
    this.name = "PlanJobStorageError";
  }
}

export function enqueueApprovedPlan(
  database: DatabaseSync,
  guildId: string,
  planId: string,
  createdBy: string,
  now = new Date(),
): PlanJob {
  validateInputs(guildId, planId, createdBy, now);
  const plan = getChangePlan(database, guildId, planId, now);
  if (!plan) throw new PlanJobStorageError("not_found");
  if (plan.status === "expired") {
    throw new PlanJobStorageError("expired");
  }
  if (plan.status !== "approved" || !plan.decisionBy) {
    throw new PlanJobStorageError("plan_not_approved");
  }

  const jobId = randomUUID();
  database.exec("BEGIN IMMEDIATE;");
  try {
    const row = database
      .prepare(
        `SELECT requested_by, decision_by, expires_at, status
         FROM change_plans WHERE guild_id = ? AND plan_id = ?`,
      )
      .get(guildId, planId) as
      | {
          requested_by: string;
          decision_by: string | null;
          expires_at: string;
          status: string;
        }
      | undefined;
    if (!row) throw new PlanJobStorageError("not_found");
    if (row.status !== "approved" || !row.decision_by) {
      throw new PlanJobStorageError("plan_not_approved");
    }
    if (Date.parse(row.expires_at) <= now.getTime()) {
      throw new PlanJobStorageError("expired");
    }

    database
      .prepare(
        `INSERT INTO plan_jobs
          (job_id, plan_id, guild_id, requested_by, approved_by, created_by,
           created_at, status, cancel_requested)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0)`,
      )
      .run(
        jobId,
        planId,
        guildId,
        row.requested_by,
        row.decision_by,
        createdBy,
        now.toISOString(),
      );
    const insertItem = database.prepare(
      `INSERT INTO plan_job_items (job_id, plan_id, ordinal, status, attempts)
       VALUES (?, ?, ?, 'pending', 0)`,
    );
    for (const [ordinal] of plan.changes.entries()) {
      insertItem.run(jobId, planId, ordinal);
    }
    const transitioned = database
      .prepare(
        `UPDATE change_plans SET status = 'applying'
         WHERE guild_id = ? AND plan_id = ? AND status = 'approved'`,
      )
      .run(guildId, planId);
    if (Number(transitioned.changes) !== 1) {
      throw new PlanJobStorageError("raced");
    }
    appendJobAuditEvent(
      database,
      guildId,
      jobId,
      "job_queued",
      "queued",
      null,
      now,
    );
    database.exec("COMMIT;");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK;");
    if (isUniqueConstraint(error)) {
      throw new PlanJobStorageError("already_queued");
    }
    throw error;
  }

  const job = getPlanJob(database, guildId, jobId, now);
  if (!job) throw new PlanJobStorageError("not_found");
  return job;
}

export function getPlanJob(
  database: DatabaseSync,
  guildId: string,
  jobId: string,
  now = new Date(),
): PlanJob | undefined {
  validateInputs(guildId, jobId, guildId, now);
  const row = database
    .prepare(
      `SELECT job_id, plan_id, guild_id, requested_by, approved_by, created_by,
              created_at, started_at, finished_at, status, cancel_requested
       FROM plan_jobs WHERE guild_id = ? AND job_id = ?`,
    )
    .get(guildId, jobId) as PlanJobRow | undefined;
  if (!row) return undefined;

  if (
    !uuidPattern.test(row.job_id) ||
    !uuidPattern.test(row.plan_id) ||
    row.guild_id !== guildId ||
    !snowflakePattern.test(row.requested_by) ||
    !snowflakePattern.test(row.approved_by) ||
    !snowflakePattern.test(row.created_by) ||
    !isTimestamp(row.created_at) ||
    (row.started_at !== null && !isTimestamp(row.started_at)) ||
    (row.finished_at !== null && !isTimestamp(row.finished_at)) ||
    !jobStatuses.has(row.status as PlanJobStatus) ||
    (row.cancel_requested !== 0 && row.cancel_requested !== 1)
  ) {
    throw new Error("A saved plan job contains invalid metadata.");
  }

  const plan = getChangePlan(database, guildId, row.plan_id, now);
  if (!plan) throw new Error("A saved plan job has no matching change plan.");
  const itemRows = database
    .prepare(
      `SELECT ordinal, status, attempts, last_error
       FROM plan_job_items WHERE job_id = ? ORDER BY ordinal ASC`,
    )
    .all(row.job_id) as PlanJobItemRow[];
  if (itemRows.length !== plan.changes.length) {
    throw new Error("A saved plan job has an incomplete item list.");
  }
  const items = itemRows.map((item, index) => {
    if (
      item.ordinal !== index ||
      !itemStatuses.has(item.status as PlanJobItemStatus) ||
      !Number.isSafeInteger(item.attempts) ||
      item.attempts < 0 ||
      (item.last_error !== null && item.last_error.length > 500)
    ) {
      throw new Error("A saved plan job item contains invalid metadata.");
    }
    const change = plan.changes[index];
    if (!change) throw new Error("A saved plan job item has no plan target.");
    return {
      ordinal: index,
      change,
      status: item.status as PlanJobItemStatus,
      attempts: item.attempts,
      lastError: item.last_error,
    };
  });

  return {
    id: row.job_id,
    planId: row.plan_id,
    guildId: row.guild_id,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    createdBy: row.created_by,
    reason: plan.reason,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as PlanJobStatus,
    cancelRequested: row.cancel_requested === 1,
    items,
  };
}

export function listRunnablePlanJobs(
  database: DatabaseSync,
  now = new Date(),
): PlanJob[] {
  const rows = database
    .prepare(
      `SELECT job_id, guild_id FROM plan_jobs
       WHERE status IN ('queued', 'running', 'reconciliation_required')
       ORDER BY created_at ASC, job_id ASC`,
    )
    .all() as { job_id: string; guild_id: string }[];
  return rows.flatMap((row) => {
    const job = getPlanJob(database, row.guild_id, row.job_id, now);
    return job ? [job] : [];
  });
}

export function hasOtherUnresolvedPlanJob(
  database: DatabaseSync,
  guildId: string,
  jobId: string,
): boolean {
  const row = database
    .prepare(
      `SELECT 1 AS found FROM plan_jobs
       WHERE guild_id = ? AND job_id <> ?
         AND status IN ('running', 'reconciliation_required')
       LIMIT 1`,
    )
    .get(guildId, jobId) as { found: number } | undefined;
  return row !== undefined;
}

export function claimPlanJob(
  database: DatabaseSync,
  guildId: string,
  jobId: string,
  now = new Date(),
): boolean {
  validateInputs(guildId, jobId, guildId, now);
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = database
      .prepare(
        `UPDATE plan_jobs SET status = 'running', started_at = COALESCE(started_at, ?)
         WHERE guild_id = ? AND job_id = ?
           AND status IN ('queued', 'running', 'reconciliation_required')`,
      )
      .run(now.toISOString(), guildId, jobId);
    if (Number(result.changes) !== 1) {
      database.exec("COMMIT;");
      return false;
    }
    appendJobAuditEvent(
      database,
      guildId,
      jobId,
      "job_started",
      "running",
      null,
      now,
    );
    database.exec("COMMIT;");
    return true;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK;");
    throw error;
  }
}

export function beginPlanJobItemAttempt(
  database: DatabaseSync,
  guildId: string,
  jobId: string,
  ordinal: number,
  now = new Date(),
): number {
  validateInputs(guildId, jobId, guildId, now);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new TypeError("Plan job item ordinal must be non-negative.");
  }
  database.exec("BEGIN IMMEDIATE;");
  try {
    const job = database
      .prepare(
        `SELECT status, cancel_requested FROM plan_jobs
         WHERE guild_id = ? AND job_id = ?`,
      )
      .get(guildId, jobId) as
      { status: string; cancel_requested: number } | undefined;
    if (!job) throw new PlanJobStorageError("not_found");
    if (job.status !== "running") throw new PlanJobStorageError("wrong_status");
    if (job.cancel_requested === 1) throw new PlanJobStorageError("cancelled");
    const result = database
      .prepare(
        `UPDATE plan_job_items SET status = 'applying', attempts = attempts + 1,
             started_at = COALESCE(started_at, ?), finished_at = NULL, last_error = NULL
         WHERE job_id = ? AND ordinal = ? AND status = 'pending'`,
      )
      .run(now.toISOString(), jobId, ordinal);
    if (Number(result.changes) !== 1) {
      throw new PlanJobStorageError("raced");
    }
    const item = database
      .prepare(
        "SELECT attempts FROM plan_job_items WHERE job_id = ? AND ordinal = ?",
      )
      .get(jobId, ordinal) as { attempts: number } | undefined;
    appendJobItemAuditEvent(
      database,
      guildId,
      jobId,
      ordinal,
      "item_attempt_started",
      "applying",
      `Attempt ${item?.attempts ?? 1} started.`,
      now,
    );
    database.exec("COMMIT;");
    if (!item) throw new PlanJobStorageError("not_found");
    return item.attempts;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK;");
    throw error;
  }
}

export function setPlanJobItemStatus(
  database: DatabaseSync,
  guildId: string,
  jobId: string,
  ordinal: number,
  status: Exclude<PlanJobItemStatus, "applying">,
  lastError: string | null,
  now = new Date(),
): void {
  validateInputs(guildId, jobId, guildId, now);
  if (lastError !== null && lastError.length > 500) {
    throw new RangeError("Plan job item error text is too long.");
  }
  const terminal = status !== "pending";
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = database
      .prepare(
        `UPDATE plan_job_items SET status = ?, last_error = ?,
           finished_at = ?
         WHERE job_id = ? AND ordinal = ? AND status IN ('pending', 'applying')`,
      )
      .run(
        status,
        lastError,
        terminal ? now.toISOString() : null,
        jobId,
        ordinal,
      );
    if (Number(result.changes) !== 1) throw new PlanJobStorageError("raced");
    const action: PlanAuditAction =
      status === "pending"
        ? "item_retry_scheduled"
        : lastError?.startsWith("Recovered after restart:") ||
            lastError?.startsWith(
              "Discord confirmed the planned value after an ambiguous response.",
            )
          ? "item_reconciled"
          : "item_outcome";
    appendJobItemAuditEvent(
      database,
      guildId,
      jobId,
      ordinal,
      action,
      status,
      lastError,
      now,
    );
    database.exec("COMMIT;");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK;");
    throw error;
  }
}

export function requestPlanJobCancellation(
  database: DatabaseSync,
  guildId: string,
  jobId: string,
  actorId: string,
  reason = "Cancellation requested.",
  now = new Date(),
): void {
  validateInputs(guildId, jobId, actorId, now);
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = database
      .prepare(
        `UPDATE plan_jobs SET cancel_requested = 1
         WHERE guild_id = ? AND job_id = ?
           AND status IN ('queued', 'running', 'reconciliation_required')`,
      )
      .run(guildId, jobId);
    if (Number(result.changes) !== 1) {
      const job = database
        .prepare(
          "SELECT job_id FROM plan_jobs WHERE guild_id = ? AND job_id = ?",
        )
        .get(guildId, jobId);
      if (!job) throw new PlanJobStorageError("not_found");
      throw new PlanJobStorageError("wrong_status");
    }
    appendJobAuditEvent(
      database,
      guildId,
      jobId,
      "job_cancel_requested",
      "cancellation_requested",
      reason.trim() || "Cancellation requested.",
      now,
      actorId,
    );
    database.exec("COMMIT;");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK;");
    throw error;
  }
}

export function cancelPendingPlanJobItems(
  database: DatabaseSync,
  jobId: string,
  now = new Date(),
): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const job = database
      .prepare("SELECT guild_id FROM plan_jobs WHERE job_id = ?")
      .get(jobId) as { guild_id: string } | undefined;
    if (!job) throw new PlanJobStorageError("not_found");
    const pending = database
      .prepare(
        "SELECT ordinal FROM plan_job_items WHERE job_id = ? AND status = 'pending' ORDER BY ordinal",
      )
      .all(jobId) as { ordinal: number }[];
    const result = database
      .prepare(
        `UPDATE plan_job_items SET status = 'cancelled', finished_at = ?
         WHERE job_id = ? AND status = 'pending'`,
      )
      .run(now.toISOString(), jobId);
    if (Number(result.changes) !== pending.length) {
      throw new PlanJobStorageError("raced");
    }
    for (const item of pending) {
      appendJobItemAuditEvent(
        database,
        job.guild_id,
        jobId,
        item.ordinal,
        "item_cancelled",
        "cancelled",
        "Cancelled before execution completed.",
        now,
      );
    }
    database.exec("COMMIT;");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK;");
    throw error;
  }
}

export function finalizePlanJob(
  database: DatabaseSync,
  guildId: string,
  jobId: string,
  jobStatus: PlanJobStatus,
  planStatus: ChangePlanStatus,
  now = new Date(),
): void {
  validateInputs(guildId, jobId, guildId, now);
  database.exec("BEGIN IMMEDIATE;");
  try {
    const row = database
      .prepare(
        "SELECT plan_id FROM plan_jobs WHERE guild_id = ? AND job_id = ?",
      )
      .get(guildId, jobId) as { plan_id: string } | undefined;
    if (!row) throw new PlanJobStorageError("not_found");
    if (jobStatus === "reconciliation_required") {
      database
        .prepare(
          `UPDATE plan_jobs SET status = 'reconciliation_required'
           WHERE guild_id = ? AND job_id = ?`,
        )
        .run(guildId, jobId);
      appendJobAuditEvent(
        database,
        guildId,
        jobId,
        "job_reconciliation_required",
        "reconciliation_required",
        "An interrupted write could not be verified; later jobs are blocked.",
        now,
      );
      database.exec("COMMIT;");
      return;
    }
    if (jobStatus === "running") {
      database
        .prepare(
          `UPDATE plan_jobs SET status = 'running', finished_at = NULL
           WHERE guild_id = ? AND job_id = ?`,
        )
        .run(guildId, jobId);
      database.exec("COMMIT;");
      return;
    }
    const unfinished = database
      .prepare(
        `SELECT COUNT(*) AS count FROM plan_job_items
         WHERE job_id = ? AND status IN ('pending', 'applying')`,
      )
      .get(jobId) as { count: number };
    if (unfinished.count !== 0) {
      throw new PlanJobStorageError("wrong_status");
    }
    const finishedAt = now.toISOString();
    database
      .prepare(
        `UPDATE plan_jobs SET status = ?, finished_at = ?
         WHERE guild_id = ? AND job_id = ?`,
      )
      .run(jobStatus, finishedAt, guildId, jobId);
    const planUpdate = database
      .prepare(
        `UPDATE change_plans SET status = ?
         WHERE guild_id = ? AND plan_id = ? AND status = 'applying'`,
      )
      .run(planStatus, guildId, row.plan_id);
    if (Number(planUpdate.changes) !== 1) {
      throw new PlanJobStorageError("raced");
    }
    appendJobAuditEvent(
      database,
      guildId,
      jobId,
      "job_finished",
      jobStatus,
      `Plan outcome: ${planStatus}.`,
      now,
    );
    database.exec("COMMIT;");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK;");
    throw error;
  }
}

function validateInputs(
  guildId: string,
  id: string,
  actorId: string,
  now: Date,
): void {
  if (!snowflakePattern.test(guildId) || !snowflakePattern.test(actorId)) {
    throw new TypeError(
      "Plan job guild and actor IDs must be Discord snowflakes.",
    );
  }
  if (!uuidPattern.test(id)) throw new TypeError("Plan job IDs must be UUIDs.");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Plan job time must be a valid date.");
  }
}

function appendJobAuditEvent(
  database: DatabaseSync,
  guildId: string,
  jobId: string,
  action: PlanAuditAction,
  outcome: string,
  details: string | null,
  now: Date,
  actorId?: string,
): void {
  const row = database
    .prepare(
      `SELECT j.plan_id, j.requested_by, j.approved_by, j.created_by, p.reason
       FROM plan_jobs j JOIN change_plans p ON p.plan_id = j.plan_id
       WHERE j.guild_id = ? AND j.job_id = ?`,
    )
    .get(guildId, jobId) as
    | {
        plan_id: string;
        requested_by: string;
        approved_by: string;
        created_by: string;
        reason: string;
      }
    | undefined;
  if (!row) throw new PlanJobStorageError("not_found");
  appendPlanAuditEvent(database, {
    guildId,
    actorId: actorId ?? row.created_by,
    approverId: row.approved_by,
    reason: details && action === "job_cancel_requested" ? details : row.reason,
    action,
    planId: row.plan_id,
    jobId,
    outcome,
    details,
    createdAt: now,
  });
}

function appendJobItemAuditEvent(
  database: DatabaseSync,
  guildId: string,
  jobId: string,
  ordinal: number,
  action: PlanAuditAction,
  outcome: string,
  details: string | null,
  now: Date,
): void {
  const row = database
    .prepare(
      `SELECT j.plan_id, j.approved_by, j.created_by, p.reason,
              c.channel_id, c.setting_key, c.subject_id,
              c.before_json, c.after_json
       FROM plan_jobs j
       JOIN change_plans p ON p.plan_id = j.plan_id
       JOIN change_plan_items c ON c.plan_id = j.plan_id
       WHERE j.guild_id = ? AND j.job_id = ? AND c.ordinal = ?`,
    )
    .get(guildId, jobId, ordinal) as
    | {
        plan_id: string;
        approved_by: string;
        created_by: string;
        reason: string;
        channel_id: string;
        setting_key: string;
        subject_id: string | null;
        before_json: string;
        after_json: string;
      }
    | undefined;
  if (!row) throw new PlanJobStorageError("not_found");
  appendPlanAuditEvent(database, {
    guildId,
    actorId: row.created_by,
    approverId: row.approved_by,
    reason: row.reason,
    action,
    planId: row.plan_id,
    jobId,
    ordinal,
    channelId: row.channel_id,
    settingKey: row.setting_key,
    subjectId: row.subject_id,
    before: JSON.parse(row.before_json),
    after: JSON.parse(row.after_json),
    outcome,
    details,
    createdAt: now,
  });
}

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.includes("CONSTRAINT_UNIQUE")
  );
}

function planJobErrorMessage(code: PlanJobStorageErrorCode): string {
  switch (code) {
    case "not_found":
      return "Plan job or change plan was not found in this server.";
    case "plan_not_approved":
      return "Only an approved, unexpired plan can be queued for execution.";
    case "expired":
      return "This approved plan has expired. Create a new preview and request approval again.";
    case "already_queued":
      return "This plan already has an execution job.";
    case "wrong_status":
      return "This plan job is not in a state that allows that action.";
    case "cancelled":
      return "This plan job has a cancellation request.";
    case "raced":
      return "The plan job changed while this action was being processed. Check its current status.";
  }
}
