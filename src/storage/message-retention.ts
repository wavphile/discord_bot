import type { DatabaseSync } from "node:sqlite";
import { getGuildSetting, setGuildSetting } from "./guild-settings.js";

const settingKey = "message_retention";
const snowflake = /^\d{17,20}$/;
const dayInMilliseconds = 24 * 60 * 60 * 1_000;
const expirationBatchSize = 500;

export type MessageRetentionChannel = Readonly<{
  channelId: string;
  enabledAt: string;
  retentionDays: number;
}>;

export type MessageRetentionSettings = Readonly<{
  channels: readonly MessageRetentionChannel[];
}>;

export type RetentionMessageCandidate = Readonly<{
  guildId: string;
  channelId: string;
  parentChannelId: string | null;
  messageId: string;
  createdAt: string;
  content: string;
  isBot: boolean;
  isWebhook: boolean;
  messageContentEnabled: boolean;
  botCanRead: boolean;
}>;

export function defaultMessageRetentionSettings(): MessageRetentionSettings {
  return { channels: [] };
}

export function isMessageRetentionSettings(
  value: unknown,
): value is MessageRetentionSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as Record<string, unknown>;
  if (
    !Array.isArray(settings["channels"]) ||
    settings["channels"].length > 25
  ) {
    return false;
  }

  const seen = new Set<string>();
  return settings["channels"].every((channel: unknown) => {
    if (!channel || typeof channel !== "object") return false;
    const record = channel as Record<string, unknown>;
    const channelId = record["channelId"];
    const enabledAt = record["enabledAt"];
    const retentionDays = record["retentionDays"];
    if (
      typeof channelId !== "string" ||
      !snowflake.test(channelId) ||
      seen.has(channelId) ||
      typeof enabledAt !== "string" ||
      !Number.isFinite(Date.parse(enabledAt)) ||
      !Number.isInteger(retentionDays) ||
      (retentionDays as number) < 1 ||
      (retentionDays as number) > 7
    ) {
      return false;
    }
    seen.add(channelId);
    return true;
  });
}

export function getMessageRetentionSettings(
  database: DatabaseSync,
  guildId: string,
): MessageRetentionSettings {
  const value = getGuildSetting(database, guildId, settingKey);
  if (!isMessageRetentionSettings(value))
    return defaultMessageRetentionSettings();
  return {
    channels: value.channels.map((channel) => ({ ...channel })),
  };
}

export function setMessageRetentionSettings(
  database: DatabaseSync,
  guildId: string,
  settings: MessageRetentionSettings,
): void {
  if (!isMessageRetentionSettings(settings)) {
    throw new TypeError("message retention settings are invalid");
  }
  setGuildSetting(database, guildId, settingKey, {
    channels: settings.channels.map((channel) => ({ ...channel })),
  });
}

export function enableMessageRetention(
  database: DatabaseSync,
  guildId: string,
  channelId: string,
  retentionDays: number,
  now = new Date(),
): MessageRetentionSettings {
  if (!snowflake.test(channelId))
    throw new TypeError("channelId must be a Discord snowflake");
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 7
  )
    throw new RangeError("retentionDays must be between 1 and 7");

  return inTransaction(database, () => {
    const current = getMessageRetentionSettings(database, guildId);
    const existing = current.channels.find(
      (channel) => channel.channelId === channelId,
    );
    const channels = existing
      ? current.channels.map((channel) =>
          channel.channelId === channelId
            ? { ...channel, retentionDays }
            : channel,
        )
      : [
          ...current.channels,
          { channelId, enabledAt: now.toISOString(), retentionDays },
        ];
    const updated = { channels };
    setMessageRetentionSettings(database, guildId, updated);
    return updated;
  });
}

/** Disable persistence for a channel and its threads, or for an entire guild. */
export function disableMessageRetention(
  database: DatabaseSync,
  guildId: string,
  channelId?: string,
): number {
  if (channelId !== undefined && !snowflake.test(channelId))
    throw new TypeError("channelId must be a Discord snowflake");

  return inTransaction(database, () => {
    const deleted = deleteStoredMessages(database, guildId, channelId);
    if (channelId === undefined) {
      database
        .prepare(
          "DELETE FROM guild_settings WHERE guild_id = ? AND setting_key = ?",
        )
        .run(guildId, settingKey);
      return deleted;
    }

    const current = getMessageRetentionSettings(database, guildId);
    const channels = current.channels.filter(
      (channel) => channel.channelId !== channelId,
    );
    if (channels.length === 0) {
      database
        .prepare(
          "DELETE FROM guild_settings WHERE guild_id = ? AND setting_key = ?",
        )
        .run(guildId, settingKey);
    } else {
      setMessageRetentionSettings(database, guildId, {
        ...current,
        channels,
      });
    }
    return deleted;
  });
}

/** Delete stored content for the guild, optionally including a channel's threads. */
export function deleteStoredMessages(
  database: DatabaseSync,
  guildId: string,
  channelId?: string,
): number {
  if (!snowflake.test(guildId))
    throw new TypeError("guildId must be a Discord snowflake");
  if (channelId !== undefined && !snowflake.test(channelId))
    throw new TypeError("channelId must be a Discord snowflake");

  const result = channelId
    ? database
        .prepare(
          `DELETE FROM retained_messages
           WHERE guild_id = ? AND (channel_id = ? OR parent_channel_id = ?)`,
        )
        .run(guildId, channelId, channelId)
    : database
        .prepare("DELETE FROM retained_messages WHERE guild_id = ?")
        .run(guildId);
  return Number(result.changes);
}

/** Explicit administrator purge is an atomic transaction, including SQLite index updates. */
export function purgeStoredMessages(
  database: DatabaseSync,
  guildId: string,
  channelId?: string,
): number {
  return inTransaction(database, () =>
    deleteStoredMessages(database, guildId, channelId),
  );
}

export function storeNewMessage(
  database: DatabaseSync,
  candidate: RetentionMessageCandidate,
  now = new Date(),
): boolean {
  const eligible = getEligibleMessage(database, candidate, now);
  if (!eligible) return false;

  const result = database
    .prepare(
      `INSERT INTO retained_messages (
         guild_id, message_id, channel_id, parent_channel_id,
         created_at, expires_at, content
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, message_id) DO UPDATE SET
         content = excluded.content,
         expires_at = MIN(retained_messages.expires_at, excluded.expires_at)`,
    )
    .run(
      candidate.guildId,
      candidate.messageId,
      candidate.channelId,
      candidate.parentChannelId,
      eligible.createdAt,
      eligible.expiresAt,
      candidate.content,
    );
  return Number(result.changes) > 0;
}

/** Update only an existing row; an edit can never backfill an untracked message. */
export function updateStoredMessage(
  database: DatabaseSync,
  candidate: RetentionMessageCandidate,
  now = new Date(),
): boolean {
  const existing = database
    .prepare(
      `SELECT message_id FROM retained_messages
       WHERE guild_id = ? AND message_id = ?`,
    )
    .get(candidate.guildId, candidate.messageId);
  if (!existing) return false;

  const eligible = getEligibleMessage(database, candidate, now);
  if (!eligible || !candidate.content.trim()) {
    database
      .prepare(
        "DELETE FROM retained_messages WHERE guild_id = ? AND message_id = ?",
      )
      .run(candidate.guildId, candidate.messageId);
    return false;
  }

  database
    .prepare(
      `UPDATE retained_messages SET content = ?
       WHERE guild_id = ? AND message_id = ? AND channel_id = ?`,
    )
    .run(
      candidate.content,
      candidate.guildId,
      candidate.messageId,
      candidate.channelId,
    );
  return true;
}

export function deleteStoredMessage(
  database: DatabaseSync,
  guildId: string,
  messageId: string,
): number {
  if (!snowflake.test(guildId) || !snowflake.test(messageId)) return 0;
  return Number(
    database
      .prepare(
        "DELETE FROM retained_messages WHERE guild_id = ? AND message_id = ?",
      )
      .run(guildId, messageId).changes,
  );
}

export function deleteStoredMessagesById(
  database: DatabaseSync,
  guildId: string,
  messageIds: readonly string[],
): number {
  if (!snowflake.test(guildId)) return 0;
  const ids = [...new Set(messageIds.filter((id) => snowflake.test(id)))];
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  const result = database
    .prepare(
      `DELETE FROM retained_messages
       WHERE guild_id = ? AND message_id IN (${placeholders})`,
    )
    .run(guildId, ...ids);
  return Number(result.changes);
}

/** Reduce existing deadlines when retention is shortened, then delete expired rows in bounded batches. */
export function purgeExpiredMessages(
  database: DatabaseSync,
  now = new Date(),
): number {
  const nowIso = now.toISOString();
  return inTransaction(database, () => {
    const configuredGuilds = database
      .prepare(
        `SELECT guild_id FROM guild_settings
         WHERE setting_key = ? ORDER BY guild_id`,
      )
      .all(settingKey) as Array<{ guild_id: string }>;

    const reduceDeadline = database.prepare(
      `UPDATE retained_messages
       SET expires_at = MIN(
         expires_at,
         strftime('%Y-%m-%dT%H:%M:%fZ', created_at, ?)
       )
       WHERE guild_id = ?
         AND (channel_id = ? OR parent_channel_id = ?)
         AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', created_at, ?)`,
    );
    for (const { guild_id: guildId } of configuredGuilds) {
      const settings = getMessageRetentionSettings(database, guildId);
      for (const channel of settings.channels) {
        const modifier = `+${channel.retentionDays} days`;
        reduceDeadline.run(
          modifier,
          guildId,
          channel.channelId,
          channel.channelId,
          modifier,
        );
      }
    }

    let deleted = 0;
    while (true) {
      const result = database
        .prepare(
          `DELETE FROM retained_messages
           WHERE rowid IN (
             SELECT rowid FROM retained_messages
             WHERE expires_at <= ?
             ORDER BY expires_at
             LIMIT ?
           )`,
        )
        .run(nowIso, expirationBatchSize);
      const batchCount = Number(result.changes);
      deleted += batchCount;
      if (batchCount < expirationBatchSize) break;
    }
    return deleted;
  });
}

export function removeGuildRetentionData(
  database: DatabaseSync,
  guildId: string,
): number {
  return inTransaction(database, () => {
    const deleted = deleteStoredMessages(database, guildId);
    database
      .prepare(
        "DELETE FROM guild_settings WHERE guild_id = ? AND setting_key = ?",
      )
      .run(guildId, settingKey);
    return deleted;
  });
}

function getEligibleMessage(
  database: DatabaseSync,
  candidate: RetentionMessageCandidate,
  now: Date,
): Readonly<{ createdAt: string; expiresAt: string }> | undefined {
  if (
    !snowflake.test(candidate.guildId) ||
    !snowflake.test(candidate.channelId) ||
    !snowflake.test(candidate.messageId) ||
    (candidate.parentChannelId !== null &&
      !snowflake.test(candidate.parentChannelId)) ||
    candidate.isBot ||
    candidate.isWebhook ||
    !candidate.messageContentEnabled ||
    !candidate.botCanRead ||
    typeof candidate.content !== "string" ||
    !candidate.content.trim() ||
    candidate.content.length > 4_000
  ) {
    return undefined;
  }

  const created = Date.parse(candidate.createdAt);
  if (!Number.isFinite(created) || created > now.getTime()) return undefined;
  const settings = getMessageRetentionSettings(database, candidate.guildId);
  const selectedChannelId = candidate.parentChannelId ?? candidate.channelId;
  const channel = settings.channels.find(
    (entry) => entry.channelId === selectedChannelId,
  );
  if (!channel || created < Date.parse(channel.enabledAt)) return undefined;

  const createdAt = new Date(created).toISOString();
  const expiresAt = new Date(
    created + channel.retentionDays * dayInMilliseconds,
  ).toISOString();
  if (Date.parse(expiresAt) <= now.getTime()) return undefined;
  return { createdAt, expiresAt };
}

function inTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    database.exec("COMMIT;");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK;");
    throw error;
  }
}
