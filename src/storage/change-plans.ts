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

  return { id, ...prepared };
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
             created_at, expires_at, status
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
