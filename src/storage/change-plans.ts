import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isChangePlanExpired,
  prepareChangePlan,
  type ChangePlan,
  type ChangePlanChange,
  type ChangePlanStatus,
  type CreateChangePlanInput,
  validateChangePlanChanges,
  type RoleOverwriteValue,
} from "../features/change-plans.js";

type ChangePlanRow = Readonly<{
  plan_id: string;
  guild_id: string;
  requested_by: string;
  source_snapshot_id: string | null;
  created_at: string;
  expires_at: string;
  status: string;
  submitted_at: string | null;
  decision_by: string | null;
  decision_at: string | null;
}>;

type ChangePlanItemRow = Readonly<{
  ordinal: number;
  channel_id: string;
  channel_type: string;
  setting_key: string;
  subject_id: string | null;
  before_json: string;
  after_json: string;
}>;

const planStatuses = new Set<ChangePlanStatus>([
  "preview",
  "awaiting_approval",
  "approved",
  "rejected",
  "expired",
  "applying",
  "applied",
  "partial",
  "failed",
  "conflicted",
  "cancelled",
]);
const snowflakePattern = /^\d{17,20}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createChangePlan(
  database: DatabaseSync,
  input: CreateChangePlanInput,
  now = new Date(),
): ChangePlan {
  const prepared = prepareChangePlan(input, now);
  const id = randomUUID();
  database.exec("BEGIN IMMEDIATE;");
  try {
    if (prepared.sourceSnapshotId) {
      const snapshot = database
        .prepare(
          "SELECT guild_id FROM configuration_snapshots WHERE snapshot_id = ?",
        )
        .get(prepared.sourceSnapshotId) as { guild_id: string } | undefined;
      if (!snapshot || snapshot.guild_id !== prepared.guildId) {
        throw new TypeError(
          "A source snapshot must exist in the same server as the change plan.",
        );
      }
    }

    database
      .prepare(
        `
        INSERT INTO change_plans
          (plan_id, guild_id, requested_by, source_snapshot_id, created_at, expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        prepared.guildId,
        prepared.requestedBy,
        prepared.sourceSnapshotId,
        prepared.createdAt,
        prepared.expiresAt,
        prepared.status,
      );

    const insertItem = database.prepare(
      `
      INSERT INTO change_plan_items
        (plan_id, ordinal, channel_id, channel_type, setting_key, subject_id, before_json, after_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    );
    for (const [ordinal, change] of prepared.changes.entries()) {
      insertItem.run(
        id,
        ordinal,
        change.channelId,
        change.settingKey === "channel.role_overwrite"
          ? change.channelType
          : "text",
        change.settingKey,
        change.settingKey === "channel.role_overwrite" ? change.roleId : null,
        JSON.stringify(change.before),
        JSON.stringify(change.after),
      );
    }

    database.exec("COMMIT;");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK;");
    throw error;
  }

  return {
    id,
    ...prepared,
    submittedAt: null,
    decisionBy: null,
    decisionAt: null,
  };
}

export function getChangePlan(
  database: DatabaseSync,
  guildId: string,
  planId: string,
  now = new Date(),
): ChangePlan | undefined {
  validateSnowflake(guildId, "guildId");
  if (!uuidPattern.test(planId)) {
    throw new TypeError("planId must be a change plan UUID.");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Plan retrieval time must be a valid date.");
  }

  const row = database
    .prepare(
      `
      SELECT plan_id, guild_id, requested_by, source_snapshot_id,
             created_at, expires_at, status, submitted_at, decision_by, decision_at
      FROM change_plans
      WHERE guild_id = ? AND plan_id = ?
    `,
    )
    .get(guildId, planId) as ChangePlanRow | undefined;
  if (!row) return undefined;

  const items = database
    .prepare(
      `
      SELECT ordinal, channel_id, channel_type, setting_key, subject_id, before_json, after_json
      FROM change_plan_items
      WHERE plan_id = ?
      ORDER BY ordinal ASC
    `,
    )
    .all(planId) as ChangePlanItemRow[];

  if (
    row.guild_id !== guildId ||
    !snowflakePattern.test(row.requested_by) ||
    !uuidPattern.test(row.plan_id) ||
    !isPlanStatus(row.status) ||
    !isValidTimestamp(row.created_at) ||
    !isValidTimestamp(row.expires_at) ||
    Date.parse(row.expires_at) <= Date.parse(row.created_at) ||
    (row.source_snapshot_id !== null &&
      !uuidPattern.test(row.source_snapshot_id))
  ) {
    throw new Error("A saved change plan contains invalid metadata.");
  }
  validateApprovalMetadata(row);

  if (row.source_snapshot_id) {
    const sourceSnapshot = database
      .prepare(
        "SELECT guild_id FROM configuration_snapshots WHERE snapshot_id = ?",
      )
      .get(row.source_snapshot_id) as { guild_id: string } | undefined;
    if (!sourceSnapshot || sourceSnapshot.guild_id !== guildId) {
      throw new Error("A saved change plan has an invalid source snapshot.");
    }
  }

  const parsedChanges = items.map((item, index) => {
    if (item.ordinal !== index) {
      throw new Error(
        "A saved change plan has a missing or out-of-order item.",
      );
    }
    return parseChangePlanItem(item);
  });
  const changes = validateChangePlanChanges(parsedChanges);
  const uniqueTargets = new Set(
    changes.map((change) =>
      change.settingKey === "channel.role_overwrite"
        ? `${change.channelId}:${change.settingKey}:${change.roleId}`
        : `${change.channelId}:${change.settingKey}`,
    ),
  );
  if (uniqueTargets.size !== changes.length) {
    throw new Error("A saved change plan contains duplicate targets.");
  }

  return {
    id: row.plan_id,
    guildId: row.guild_id,
    requestedBy: row.requested_by,
    sourceSnapshotId: row.source_snapshot_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    submittedAt: row.submitted_at,
    decisionBy: row.decision_by,
    decisionAt: row.decision_at,
    status:
      (row.status === "preview" ||
        row.status === "awaiting_approval" ||
        row.status === "approved") &&
      isChangePlanExpired({ expiresAt: row.expires_at }, now)
        ? "expired"
        : row.status,
    changes,
  };
}

export type ChangePlanTransitionErrorCode =
  | "not_found"
  | "not_requester"
  | "wrong_status"
  | "expired"
  | "self_approval"
  | "raced";

export class ChangePlanTransitionError extends Error {
  constructor(readonly code: ChangePlanTransitionErrorCode) {
    super(transitionErrorMessage(code));
    this.name = "ChangePlanTransitionError";
  }
}

export function submitChangePlanForApproval(
  database: DatabaseSync,
  guildId: string,
  planId: string,
  requesterId: string,
  now = new Date(),
): ChangePlan {
  validateTransitionInput(guildId, planId, requesterId, now);
  return transitionPlan(database, {
    guildId,
    planId,
    actorId: requesterId,
    expectedStatus: "preview",
    updateSql: `UPDATE change_plans
      SET status = 'awaiting_approval', submitted_at = ?
      WHERE guild_id = ? AND plan_id = ? AND status = 'preview'`,
    updateValues: [now.toISOString(), guildId, planId],
    requesterId,
    now,
  });
}

export function approveChangePlan(
  database: DatabaseSync,
  guildId: string,
  planId: string,
  approverId: string,
  now = new Date(),
): ChangePlan {
  validateTransitionInput(guildId, planId, approverId, now);
  return transitionPlan(database, {
    guildId,
    planId,
    actorId: approverId,
    expectedStatus: "awaiting_approval",
    updateSql: `UPDATE change_plans
      SET status = 'approved', decision_by = ?, decision_at = ?
      WHERE guild_id = ? AND plan_id = ? AND status = 'awaiting_approval'
        AND requested_by <> ?`,
    updateValues: [approverId, now.toISOString(), guildId, planId, approverId],
    requesterId: approverId,
    now,
    rejectSelfApproval: true,
  });
}

export function rejectChangePlan(
  database: DatabaseSync,
  guildId: string,
  planId: string,
  approverId: string,
  now = new Date(),
): ChangePlan {
  validateTransitionInput(guildId, planId, approverId, now);
  return transitionPlan(database, {
    guildId,
    planId,
    actorId: approverId,
    expectedStatus: "awaiting_approval",
    updateSql: `UPDATE change_plans
      SET status = 'rejected', decision_by = ?, decision_at = ?
      WHERE guild_id = ? AND plan_id = ? AND status = 'awaiting_approval'`,
    updateValues: [approverId, now.toISOString(), guildId, planId],
    requesterId: approverId,
    now,
  });
}

export function markChangePlanConflicted(
  database: DatabaseSync,
  guildId: string,
  planId: string,
  approverId: string,
  now = new Date(),
): ChangePlan {
  validateTransitionInput(guildId, planId, approverId, now);
  return transitionPlan(database, {
    guildId,
    planId,
    actorId: approverId,
    expectedStatus: "awaiting_approval",
    updateSql: `UPDATE change_plans
      SET status = 'conflicted', decision_by = ?, decision_at = ?
      WHERE guild_id = ? AND plan_id = ? AND status = 'awaiting_approval'`,
    updateValues: [approverId, now.toISOString(), guildId, planId],
    requesterId: approverId,
    now,
  });
}

type PlanTransitionInput = Readonly<{
  guildId: string;
  planId: string;
  actorId: string;
  expectedStatus: "preview" | "awaiting_approval";
  updateSql: string;
  updateValues: readonly (string | null)[];
  requesterId: string;
  now: Date;
  rejectSelfApproval?: boolean;
}>;

function transitionPlan(
  database: DatabaseSync,
  input: PlanTransitionInput,
): ChangePlan {
  let expired = false;
  database.exec("BEGIN IMMEDIATE;");
  try {
    const row = database
      .prepare(
        `SELECT requested_by, expires_at, status
         FROM change_plans WHERE guild_id = ? AND plan_id = ?`,
      )
      .get(input.guildId, input.planId) as
      { requested_by: string; expires_at: string; status: string } | undefined;
    if (!row) throw new ChangePlanTransitionError("not_found");
    if (
      input.expectedStatus === "preview" &&
      row.requested_by !== input.requesterId
    ) {
      throw new ChangePlanTransitionError("not_requester");
    }
    if (row.status !== input.expectedStatus) {
      throw new ChangePlanTransitionError("wrong_status");
    }
    if (input.rejectSelfApproval && row.requested_by === input.actorId) {
      throw new ChangePlanTransitionError("self_approval");
    }
    if (Date.parse(row.expires_at) <= input.now.getTime()) {
      database
        .prepare(
          `UPDATE change_plans SET status = 'expired'
           WHERE guild_id = ? AND plan_id = ? AND status = ?`,
        )
        .run(input.guildId, input.planId, input.expectedStatus);
      expired = true;
    } else {
      const result = database
        .prepare(input.updateSql)
        .run(...input.updateValues);
      if (Number(result.changes) !== 1) {
        throw new ChangePlanTransitionError("raced");
      }
    }
    database.exec("COMMIT;");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK;");
    throw error;
  }

  if (expired) throw new ChangePlanTransitionError("expired");
  const plan = getChangePlan(database, input.guildId, input.planId, input.now);
  if (!plan) throw new ChangePlanTransitionError("not_found");
  return plan;
}

function validateTransitionInput(
  guildId: string,
  planId: string,
  actorId: string,
  now: Date,
): void {
  validateSnowflake(guildId, "guildId");
  validateSnowflake(actorId, "actorId");
  if (!uuidPattern.test(planId)) {
    throw new TypeError("planId must be a change plan UUID.");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Plan transition time must be a valid date.");
  }
}

function validateApprovalMetadata(row: ChangePlanRow): void {
  if (
    (row.submitted_at !== null && !isValidTimestamp(row.submitted_at)) ||
    (row.decision_by !== null && !snowflakePattern.test(row.decision_by)) ||
    (row.decision_at !== null && !isValidTimestamp(row.decision_at))
  ) {
    throw new Error("A saved change plan has invalid approval metadata.");
  }
  if (
    (row.status === "awaiting_approval" ||
      row.status === "approved" ||
      row.status === "rejected" ||
      row.status === "conflicted") &&
    row.submitted_at === null
  ) {
    throw new Error("A submitted change plan is missing its submission time.");
  }
  if (
    (row.status === "approved" ||
      row.status === "rejected" ||
      row.status === "conflicted") &&
    (row.decision_by === null || row.decision_at === null)
  ) {
    throw new Error("A decided change plan is missing its decision metadata.");
  }
}

function transitionErrorMessage(code: ChangePlanTransitionErrorCode): string {
  switch (code) {
    case "not_found":
      return "Change plan not found in this server.";
    case "not_requester":
      return "Only the original requester can submit this plan for approval.";
    case "wrong_status":
      return "This plan is not in a state that allows that action.";
    case "expired":
      return "This plan has expired. Create a new preview before requesting approval.";
    case "self_approval":
      return "The requester cannot approve their own change plan.";
    case "raced":
      return "The plan changed while this action was being processed. Review its current status and try again.";
  }
}

function parseChangePlanItem(row: ChangePlanItemRow): ChangePlanChange {
  if (!Number.isSafeInteger(row.ordinal) || row.ordinal < 0) {
    throw new Error("A saved change plan item has an invalid order.");
  }
  validateSnowflake(row.channel_id, "channelId");
  const before = parseJson(row.before_json);
  const after = parseJson(row.after_json);

  if (row.setting_key === "channel.topic") {
    if (row.subject_id !== null || row.channel_type !== "text") {
      throw new Error("A saved channel topic change has an invalid target.");
    }
    return {
      channelId: row.channel_id,
      settingKey: "channel.topic",
      before: validateTopic(before),
      after: validateTopic(after),
    };
  }

  if (row.setting_key === "channel.slowmode") {
    if (row.subject_id !== null || row.channel_type !== "text") {
      throw new Error("A saved slowmode change has an invalid target.");
    }
    return {
      channelId: row.channel_id,
      settingKey: "channel.slowmode",
      before: validateSlowmode(before),
      after: validateSlowmode(after),
    };
  }

  if (row.setting_key === "channel.role_overwrite") {
    if (
      row.subject_id === null ||
      (row.channel_type !== "text" && row.channel_type !== "voice")
    ) {
      throw new Error("A saved role overwrite change has an invalid target.");
    }
    validateSnowflake(row.subject_id, "roleId");
    return {
      channelId: row.channel_id,
      channelType: row.channel_type,
      roleId: row.subject_id,
      settingKey: "channel.role_overwrite",
      before: validateOverwrite(before),
      after: validateOverwrite(after),
    };
  }

  throw new Error("A saved change plan contains an unsupported setting.");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("A saved change plan value could not be read.");
  }
}

function validateTopic(value: unknown): string | null {
  if (value !== null && (typeof value !== "string" || value.length > 1_024)) {
    throw new Error("A saved topic value is invalid.");
  }
  return value;
}

function validateSlowmode(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 21_600
  ) {
    throw new Error("A saved slowmode value is invalid.");
  }
  return value;
}

function validateOverwrite(value: unknown): RoleOverwriteValue | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error("A saved role overwrite is invalid.");
  const allow = value["allow"];
  const deny = value["deny"];
  if (
    typeof allow !== "string" ||
    !/^(0|[1-9]\d{0,19})$/.test(allow) ||
    typeof deny !== "string" ||
    !/^(0|[1-9]\d{0,19})$/.test(deny) ||
    BigInt(allow) > (1n << 64n) - 1n ||
    BigInt(deny) > (1n << 64n) - 1n
  ) {
    throw new Error("A saved role overwrite bitfield is invalid.");
  }
  if ((BigInt(allow) & BigInt(deny)) !== 0n) {
    throw new Error("A saved role overwrite allows and denies the same bit.");
  }
  return { allow, deny };
}

function validateSnowflake(value: string, field: string): void {
  if (!snowflakePattern.test(value)) {
    throw new TypeError(`${field} must be a Discord snowflake.`);
  }
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isPlanStatus(value: string): value is ChangePlanStatus {
  return planStatuses.has(value as ChangePlanStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
