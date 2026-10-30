import type { DatabaseSync } from "node:sqlite";
import { AiUsageLimitError } from "../ai/errors.js";

const snowflakePattern = /^\d{17,20}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AiUsageSnapshot = Readonly<{
  guildId: string;
  bucketDate: string;
  tokensUsed: number;
  tokensReserved: number;
}>;

export function getAiUsage(
  database: DatabaseSync,
  guildId: string,
  now = new Date(),
): AiUsageSnapshot {
  validateGuildAndDate(guildId, now);
  const bucketDate = utcDay(now);
  const row = database
    .prepare(
      `SELECT tokens_used, tokens_reserved FROM ai_usage_daily
       WHERE guild_id = ? AND bucket_date = ?`,
    )
    .get(guildId, bucketDate) as
    { tokens_used: number; tokens_reserved: number } | undefined;
  return {
    guildId,
    bucketDate,
    tokensUsed: row?.tokens_used ?? 0,
    tokensReserved: row?.tokens_reserved ?? 0,
  };
}

export function reserveAiUsage(
  database: DatabaseSync,
  input: Readonly<{
    guildId: string;
    reservationId: string;
    requestedTokens: number;
    dailyLimit: number;
    now?: Date;
    reservationTtlMs: number;
  }>,
): AiUsageSnapshot {
  const now = input.now ?? new Date();
  validateGuildAndDate(input.guildId, now);
  if (!uuidPattern.test(input.reservationId)) {
    throw new TypeError("reservationId must be a UUID.");
  }
  if (
    !Number.isSafeInteger(input.requestedTokens) ||
    input.requestedTokens < 1 ||
    !Number.isSafeInteger(input.dailyLimit) ||
    input.dailyLimit < 1 ||
    !Number.isSafeInteger(input.reservationTtlMs) ||
    input.reservationTtlMs < 1_000
  ) {
    throw new RangeError("AI usage reservation limits are invalid.");
  }

  const bucketDate = utcDay(now);
  const nowIso = now.toISOString();
  database.exec("BEGIN IMMEDIATE;");
  try {
    releaseExpiredReservations(database, nowIso);
    const updatedAt = nowIso;
    database
      .prepare(
        `INSERT INTO ai_usage_daily
          (guild_id, bucket_date, tokens_used, tokens_reserved, updated_at)
         VALUES (?, ?, 0, 0, ?)
         ON CONFLICT (guild_id, bucket_date) DO NOTHING`,
      )
      .run(input.guildId, bucketDate, updatedAt);
    const usage = readUsageRow(database, input.guildId, bucketDate);
    const availableTokens = Math.max(
      0,
      input.dailyLimit - usage.tokens_used - usage.tokens_reserved,
    );
    if (input.requestedTokens > availableTokens) {
      throw new AiUsageLimitError(
        input.dailyLimit,
        input.requestedTokens,
        availableTokens,
      );
    }

    database
      .prepare(
        `INSERT INTO ai_usage_reservations
          (reservation_id, guild_id, bucket_date, reserved_tokens, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.reservationId,
        input.guildId,
        bucketDate,
        input.requestedTokens,
        new Date(now.getTime() + input.reservationTtlMs).toISOString(),
      );
    database
      .prepare(
        `UPDATE ai_usage_daily SET tokens_reserved = tokens_reserved + ?, updated_at = ?
         WHERE guild_id = ? AND bucket_date = ?`,
      )
      .run(input.requestedTokens, nowIso, input.guildId, bucketDate);
    const result = readUsageRow(database, input.guildId, bucketDate);
    database.exec("COMMIT;");
    return {
      guildId: input.guildId,
      bucketDate,
      tokensUsed: result.tokens_used,
      tokensReserved: result.tokens_reserved,
    };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK;");
    throw error;
  }
}

export function settleAiUsage(
  database: DatabaseSync,
  reservationId: string,
  actualTokens: number,
  now = new Date(),
): void {
  if (!uuidPattern.test(reservationId)) {
    throw new TypeError("reservationId must be a UUID.");
  }
  if (!Number.isSafeInteger(actualTokens) || actualTokens < 0) {
    throw new RangeError("actualTokens must be a non-negative safe integer.");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid date.");
  }
  database.exec("BEGIN IMMEDIATE;");
  try {
    const reservation = database
      .prepare(
        `SELECT guild_id, bucket_date, reserved_tokens
         FROM ai_usage_reservations WHERE reservation_id = ?`,
      )
      .get(reservationId) as
      | {
          guild_id: string;
          bucket_date: string;
          reserved_tokens: number;
        }
      | undefined;
    if (!reservation) throw new Error("AI usage reservation was not found.");
    if (actualTokens > reservation.reserved_tokens) {
      throw new RangeError(
        "Actual AI usage cannot exceed the reservation amount.",
      );
    }
    const updated = database
      .prepare(
        `UPDATE ai_usage_daily
         SET tokens_used = tokens_used + ?,
             tokens_reserved = tokens_reserved - ?,
             updated_at = ?
         WHERE guild_id = ? AND bucket_date = ? AND tokens_reserved >= ?`,
      )
      .run(
        actualTokens,
        reservation.reserved_tokens,
        now.toISOString(),
        reservation.guild_id,
        reservation.bucket_date,
        reservation.reserved_tokens,
      );
    if (Number(updated.changes) !== 1) {
      throw new Error("AI usage reservation accounting is inconsistent.");
    }
    database
      .prepare("DELETE FROM ai_usage_reservations WHERE reservation_id = ?")
      .run(reservationId);
    database.exec("COMMIT;");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK;");
    throw error;
  }
}

export function releaseAiUsageReservation(
  database: DatabaseSync,
  reservationId: string,
  now = new Date(),
): void {
  if (!uuidPattern.test(reservationId)) {
    throw new TypeError("reservationId must be a UUID.");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid date.");
  }
  database.exec("BEGIN IMMEDIATE;");
  try {
    const reservation = database
      .prepare(
        `SELECT guild_id, bucket_date, reserved_tokens
         FROM ai_usage_reservations WHERE reservation_id = ?`,
      )
      .get(reservationId) as
      | {
          guild_id: string;
          bucket_date: string;
          reserved_tokens: number;
        }
      | undefined;
    if (!reservation) {
      database.exec("COMMIT;");
      return;
    }
    const updated = database
      .prepare(
        `UPDATE ai_usage_daily
         SET tokens_reserved = tokens_reserved - ?, updated_at = ?
         WHERE guild_id = ? AND bucket_date = ? AND tokens_reserved >= ?`,
      )
      .run(
        reservation.reserved_tokens,
        now.toISOString(),
        reservation.guild_id,
        reservation.bucket_date,
        reservation.reserved_tokens,
      );
    if (Number(updated.changes) !== 1) {
      throw new Error("AI usage reservation accounting is inconsistent.");
    }
    database
      .prepare("DELETE FROM ai_usage_reservations WHERE reservation_id = ?")
      .run(reservationId);
    database.exec("COMMIT;");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK;");
    throw error;
  }
}

function releaseExpiredReservations(database: DatabaseSync, now: string): void {
  const expired = database
    .prepare(
      `SELECT guild_id, bucket_date, SUM(reserved_tokens) AS reserved_tokens
       FROM ai_usage_reservations WHERE expires_at <= ?
       GROUP BY guild_id, bucket_date`,
    )
    .all(now) as {
    guild_id: string;
    bucket_date: string;
    reserved_tokens: number;
  }[];
  for (const group of expired) {
    const updated = database
      .prepare(
        `UPDATE ai_usage_daily
         SET tokens_reserved = tokens_reserved - ?, updated_at = ?
         WHERE guild_id = ? AND bucket_date = ? AND tokens_reserved >= ?`,
      )
      .run(
        group.reserved_tokens,
        now,
        group.guild_id,
        group.bucket_date,
        group.reserved_tokens,
      );
    if (Number(updated.changes) !== 1) {
      throw new Error(
        "Expired AI usage reservation accounting is inconsistent.",
      );
    }
  }
  database
    .prepare("DELETE FROM ai_usage_reservations WHERE expires_at <= ?")
    .run(now);
  const cutoff = new Date(Date.parse(`${now.slice(0, 10)}T00:00:00.000Z`));
  cutoff.setUTCDate(cutoff.getUTCDate() - 90);
  database
    .prepare(
      "DELETE FROM ai_usage_daily WHERE bucket_date < ? AND tokens_reserved = 0",
    )
    .run(utcDay(cutoff));
}

function readUsageRow(
  database: DatabaseSync,
  guildId: string,
  bucketDate: string,
): { tokens_used: number; tokens_reserved: number } {
  const row = database
    .prepare(
      `SELECT tokens_used, tokens_reserved FROM ai_usage_daily
       WHERE guild_id = ? AND bucket_date = ?`,
    )
    .get(guildId, bucketDate) as
    { tokens_used: number; tokens_reserved: number } | undefined;
  if (!row) throw new Error("AI usage aggregate was not found.");
  return row;
}

function validateGuildAndDate(guildId: string, now: Date): void {
  if (!snowflakePattern.test(guildId)) {
    throw new TypeError("guildId must be a Discord snowflake.");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid date.");
  }
}

function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}
