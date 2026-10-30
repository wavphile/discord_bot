import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ChannelType,
  Collection,
  Events,
  type Client,
  type GuildTextBasedChannel,
  type Message,
} from "discord.js";
import {
  deleteStoredMessage,
  deleteStoredMessages,
  deleteStoredMessagesById,
  disableMessageRetention,
  enableMessageRetention,
  getMessageRetentionSettings,
  purgeExpiredMessages,
  removeGuildRetentionData,
  setMessageRetentionSettings,
  storeNewMessage,
  updateStoredMessage,
  type RetentionMessageCandidate,
} from "../src/storage/message-retention.js";
import { getSchemaVersion, openDatabase } from "../src/storage/database.js";
import { setMessageRetrievalSettings } from "../src/storage/message-retrieval.js";
import { setGuildSetting } from "../src/storage/guild-settings.js";
import { migrations } from "../src/storage/migrations.js";
import { registerMessageRetentionEvents } from "../src/discord/message-retention.js";

const guildId = "11111111111111111";
const otherGuildId = "99999999999999999";
const channelId = "22222222222222222";
const otherChannelId = "88888888888888888";
const now = new Date("2026-10-30T10:00:00.000Z");

function candidate(
  index = 0,
  overrides: Partial<RetentionMessageCandidate> = {},
): RetentionMessageCandidate {
  return {
    guildId,
    channelId,
    parentChannelId: null,
    messageId: String(3_000_000_000_000_000_000n + BigInt(index)),
    createdAt: now.toISOString(),
    content: `Message ${index}`,
    isBot: false,
    isWebhook: false,
    messageContentEnabled: true,
    botCanRead: true,
    ...overrides,
  };
}

function retainedRows(database: ReturnType<typeof openDatabase>) {
  return database
    .prepare(
      `SELECT guild_id, message_id, channel_id, parent_channel_id,
              created_at, expires_at, content
       FROM retained_messages ORDER BY guild_id, message_id`,
    )
    .all() as Array<{
    guild_id: string;
    message_id: string;
    channel_id: string;
    parent_channel_id: string | null;
    created_at: string;
    expires_at: string;
    content: string;
  }>;
}

test("schema v8 creates an empty retention store and settings default off", () => {
  const database = openDatabase(":memory:");
  try {
    assert.equal(getSchemaVersion(database), 8);
    assert.deepEqual(getMessageRetentionSettings(database, guildId), {
      channels: [],
    });
    assert.deepEqual(retainedRows(database), []);
  } finally {
    database.close();
  }
});

test("a v7 database migrates without enabling retention or changing retrieval settings", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    for (const migration of migrations.slice(0, 7)) {
      migration.up(database);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, now.toISOString());
    }
    setMessageRetrievalSettings(database, guildId, {
      enabled: true,
      channelIds: [channelId],
      maxAgeDays: 2,
      maxMessages: 10,
      provider: "mock",
    });

    const retentionMigration = migrations.find(
      (migration) => migration.version === 8,
    );
    assert.ok(retentionMigration);
    retentionMigration.up(database);
    database
      .prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      )
      .run(
        retentionMigration.version,
        retentionMigration.name,
        now.toISOString(),
      );

    assert.equal(
      database
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get()?.["version"],
      8,
    );
    assert.deepEqual(getMessageRetentionSettings(database, guildId), {
      channels: [],
    });
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM retained_messages")
        .get()?.["count"],
      0,
    );
    assert.equal(
      database
        .prepare(
          "SELECT value_json FROM guild_settings WHERE guild_id = ? AND setting_key = 'message_retrieval'",
        )
        .get(guildId)?.["value_json"],
      JSON.stringify({
        enabled: true,
        channelIds: [channelId],
        maxAgeDays: 2,
        maxMessages: 10,
        provider: "mock",
      }),
    );
  } finally {
    database.close();
  }
});

test("retrieval alone, disabled content access, and pre-opt-in messages are never stored", () => {
  const database = openDatabase(":memory:");
  try {
    setMessageRetrievalSettings(database, guildId, {
      enabled: true,
      channelIds: [channelId],
      maxAgeDays: 3,
      maxMessages: 20,
      provider: "mock",
    });
    assert.equal(storeNewMessage(database, candidate(), now), false);

    enableMessageRetention(database, guildId, channelId, 2, now);
    assert.equal(
      storeNewMessage(
        database,
        candidate(1, {
          createdAt: new Date(now.getTime() - 1).toISOString(),
        }),
        now,
      ),
      false,
    );
    assert.equal(
      storeNewMessage(
        database,
        candidate(2, { messageContentEnabled: false }),
        now,
      ),
      false,
    );
    assert.equal(storeNewMessage(database, candidate(), now), true);
    assert.equal(retainedRows(database).length, 1);
  } finally {
    database.close();
  }
});

test("only opted-in channels and their threads store readable human messages", () => {
  const database = openDatabase(":memory:");
  try {
    enableMessageRetention(database, guildId, channelId, 2, now);
    assert.equal(
      storeNewMessage(
        database,
        candidate(0, { channelId: otherChannelId }),
        now,
      ),
      false,
    );
    assert.equal(
      storeNewMessage(database, candidate(1, { isBot: true }), now),
      false,
    );
    assert.equal(
      storeNewMessage(database, candidate(2, { isWebhook: true }), now),
      false,
    );
    assert.equal(
      storeNewMessage(database, candidate(3, { botCanRead: false }), now),
      false,
    );
    assert.equal(
      storeNewMessage(
        database,
        candidate(4, {
          channelId: otherChannelId,
          parentChannelId: channelId,
        }),
        now,
      ),
      true,
    );
    assert.equal(retainedRows(database).length, 1);
    assert.equal(retainedRows(database)[0]?.parent_channel_id, channelId);
  } finally {
    database.close();
  }
});

test("edits update existing content without backfilling or extending expiry", () => {
  const database = openDatabase(":memory:");
  try {
    enableMessageRetention(database, guildId, channelId, 3, now);
    const original = candidate(1);
    assert.equal(storeNewMessage(database, original, now), true);
    const originalRow = retainedRows(database)[0];
    assert.ok(originalRow);

    assert.equal(
      updateStoredMessage(
        database,
        candidate(2, { content: "An edit cannot create a new row." }),
        now,
      ),
      false,
    );
    assert.equal(
      updateStoredMessage(
        database,
        { ...original, content: "Edited content" },
        new Date(now.getTime() + 1_000),
      ),
      true,
    );
    const edited = retainedRows(database)[0];
    assert.equal(edited?.content, "Edited content");
    assert.equal(edited?.created_at, originalRow.created_at);
    assert.equal(edited?.expires_at, originalRow.expires_at);
  } finally {
    database.close();
  }
});

test("shorter retention takes effect on the next purge, including after downtime", () => {
  const database = openDatabase(":memory:");
  try {
    enableMessageRetention(database, guildId, channelId, 3, now);
    assert.equal(storeNewMessage(database, candidate(), now), true);
    enableMessageRetention(
      database,
      guildId,
      channelId,
      1,
      new Date(now.getTime() + 12 * 60 * 60 * 1_000),
    );
    assert.equal(
      purgeExpiredMessages(database, new Date(now.getTime() + day + 1)),
      1,
    );
    assert.deepEqual(retainedRows(database), []);

    assert.equal(
      storeNewMessage(
        database,
        candidate(2, {
          createdAt: new Date(now.getTime() + 2 * day).toISOString(),
        }),
        new Date(now.getTime() + 2 * day),
      ),
      true,
    );
    assert.equal(
      purgeExpiredMessages(database, new Date(now.getTime() + 5 * day)),
      1,
    );
    assert.deepEqual(retainedRows(database), []);
  } finally {
    database.close();
  }
});

test("retention periods are independent per channel and cannot extend existing rows", () => {
  const database = openDatabase(":memory:");
  try {
    enableMessageRetention(database, guildId, channelId, 3, now);
    enableMessageRetention(database, guildId, otherChannelId, 1, now);
    storeNewMessage(database, candidate(0), now);
    storeNewMessage(database, candidate(1, { channelId: otherChannelId }), now);

    enableMessageRetention(
      database,
      guildId,
      otherChannelId,
      5,
      new Date(now.getTime() + 12 * 60 * 60 * 1_000),
    );
    assert.equal(
      purgeExpiredMessages(database, new Date(now.getTime() + day + 1)),
      1,
    );
    assert.equal(retainedRows(database)[0]?.channel_id, channelId);

    const later = new Date(now.getTime() + day + 2);
    assert.equal(
      storeNewMessage(
        database,
        candidate(2, {
          channelId: otherChannelId,
          createdAt: later.toISOString(),
        }),
        later,
      ),
      true,
    );
    const laterRow = retainedRows(database).find(
      (row) => row.message_id === candidate(2).messageId,
    );
    assert.equal(
      laterRow?.expires_at,
      new Date(later.getTime() + 5 * day).toISOString(),
    );
    assert.equal(
      retainedRows(database).find((row) => row.channel_id === channelId)
        ?.expires_at,
      new Date(now.getTime() + 3 * day).toISOString(),
    );
  } finally {
    database.close();
  }
});

test("channel purge includes its threads, scopes to one guild, and is idempotent", () => {
  const database = openDatabase(":memory:");
  try {
    enableMessageRetention(database, guildId, channelId, 2, now);
    enableMessageRetention(database, guildId, otherChannelId, 2, now);
    enableMessageRetention(database, otherGuildId, channelId, 2, now);
    storeNewMessage(database, candidate(0), now);
    storeNewMessage(
      database,
      candidate(1, {
        channelId: otherChannelId,
        parentChannelId: channelId,
      }),
      now,
    );
    storeNewMessage(database, candidate(2, { channelId: otherChannelId }), now);
    storeNewMessage(database, candidate(3, { guildId: otherGuildId }), now);

    assert.equal(deleteStoredMessages(database, guildId, channelId), 2);
    assert.equal(deleteStoredMessages(database, guildId, channelId), 0);
    assert.deepEqual(
      retainedRows(database).map((row) => [row.guild_id, row.message_id]),
      [
        [guildId, candidate(2).messageId],
        [otherGuildId, candidate(3).messageId],
      ],
    );
  } finally {
    database.close();
  }
});

test("opt-out, message deletes, and guild removal delete source content and settings", () => {
  const database = openDatabase(":memory:");
  try {
    enableMessageRetention(database, guildId, channelId, 2, now);
    enableMessageRetention(database, guildId, otherChannelId, 2, now);
    storeNewMessage(database, candidate(0), now);
    storeNewMessage(database, candidate(1, { channelId: otherChannelId }), now);
    assert.equal(
      deleteStoredMessage(database, guildId, candidate(0).messageId),
      1,
    );
    assert.equal(
      deleteStoredMessagesById(database, guildId, [candidate(1).messageId]),
      1,
    );
    assert.equal(
      deleteStoredMessagesById(database, guildId, [candidate(1).messageId]),
      0,
    );

    storeNewMessage(database, candidate(2), now);
    storeNewMessage(database, candidate(3, { channelId: otherChannelId }), now);
    assert.equal(disableMessageRetention(database, guildId, channelId), 1);
    assert.deepEqual(
      getMessageRetentionSettings(database, guildId).channels.map(
        (entry) => entry.channelId,
      ),
      [otherChannelId],
    );
    assert.equal(disableMessageRetention(database, guildId), 1);
    assert.deepEqual(
      getMessageRetentionSettings(database, guildId).channels,
      [],
    );
    enableMessageRetention(database, guildId, channelId, 2, now);
    storeNewMessage(database, candidate(4), now);
    assert.equal(removeGuildRetentionData(database, guildId), 1);
    assert.deepEqual(
      getMessageRetentionSettings(database, guildId).channels,
      [],
    );
    assert.deepEqual(retainedRows(database), []);
  } finally {
    database.close();
  }
});

test("retention settings reject invalid channel and day values and fail closed", () => {
  const database = openDatabase(":memory:");
  try {
    assert.throws(
      () => enableMessageRetention(database, guildId, "invalid", 1, now),
      /Discord snowflake/,
    );
    assert.throws(
      () => enableMessageRetention(database, guildId, channelId, 8, now),
      /between 1 and 7/,
    );
    assert.equal(
      storeNewMessage(
        database,
        candidate(0, { content: "x".repeat(4_001) }),
        now,
      ),
      false,
    );
    assert.throws(
      () =>
        setMessageRetentionSettings(database, guildId, {
          channels: [{ channelId, enabledAt: "not a date", retentionDays: 1 }],
        }),
      /invalid/,
    );
    setGuildSetting(database, guildId, "message_retention", {
      channels: [{ channelId, enabledAt: "not a date", retentionDays: 1 }],
    });
    assert.deepEqual(
      getMessageRetentionSettings(database, guildId).channels,
      [],
    );
  } finally {
    database.close();
  }
});

test("Discord message events capture, edit, delete, and bulk-delete rows without logging content or IDs", async () => {
  const database = openDatabase(":memory:");
  const client = new EventEmitter() as unknown as Client;
  let databaseClosed = false;
  enableMessageRetention(database, guildId, channelId, 2, now);
  const stop = registerMessageRetentionEvents(client, database, {
    guildMembers: false,
    messageContent: true,
  });
  try {
    const original = eventMessage(10, "Private source text");
    emitEvent(client, Events.MessageCreate, original);
    assert.equal(retainedRows(database).length, 1);

    const edited = eventMessage(10, "Edited private source text");
    emitEvent(client, Events.MessageUpdate, original, edited);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      retainedRows(database)[0]?.content,
      "Edited private source text",
    );

    const bulkMessage = eventMessage(11, "Another private source");
    emitEvent(client, Events.MessageCreate, bulkMessage);
    const collection = new Collection([
      [bulkMessage.id, bulkMessage as unknown as Message<true>],
    ]);
    emitEvent(client, Events.MessageBulkDelete, collection, {
      guildId,
    } as unknown as GuildTextBasedChannel);
    assert.equal(retainedRows(database).length, 1);

    const thread = eventThread(20, false);
    storeNewMessage(
      database,
      candidate(20, {
        channelId: thread.id,
        parentChannelId: channelId,
      }),
      now,
    );
    emitEvent(client, Events.ThreadUpdate, thread, thread);
    assert.equal(
      retainedRows(database).some(
        (row) => row.message_id === candidate(20).messageId,
      ),
      false,
    );
    const deletedThread = eventThread(21, true);
    storeNewMessage(
      database,
      candidate(21, {
        channelId: deletedThread.id,
        parentChannelId: channelId,
      }),
      now,
    );
    emitEvent(client, Events.ThreadDelete, deletedThread);
    assert.equal(
      retainedRows(database).some(
        (row) => row.message_id === candidate(21).messageId,
      ),
      false,
    );

    storeNewMessage(database, candidate(22), now);
    emitEvent(
      client,
      Events.ChannelUpdate,
      eventChannel(true),
      eventChannel(false),
    );
    assert.deepEqual(
      getMessageRetentionSettings(database, guildId).channels,
      [],
    );
    assert.deepEqual(retainedRows(database), []);

    enableMessageRetention(database, guildId, channelId, 2, now);
    storeNewMessage(database, candidate(23), now);
    emitEvent(client, Events.ChannelDelete, eventChannel(false));
    assert.deepEqual(
      getMessageRetentionSettings(database, guildId).channels,
      [],
    );
    assert.deepEqual(retainedRows(database), []);

    enableMessageRetention(database, guildId, channelId, 2, now);
    storeNewMessage(database, candidate(24), now);
    emitEvent(client, Events.GuildDelete, { id: guildId });
    assert.deepEqual(
      getMessageRetentionSettings(database, guildId).channels,
      [],
    );
    assert.deepEqual(retainedRows(database), []);

    const logged: string[] = [];
    const originalError = console.error;
    console.error = (line?: unknown) => logged.push(String(line));
    try {
      database.close();
      databaseClosed = true;
      emitEvent(
        client,
        Events.MessageCreate,
        eventMessage(12, "Never log this body"),
      );
    } finally {
      console.error = originalError;
    }
    assert.equal(logged.length, 1);
    assert.doesNotMatch(
      logged.join("\n"),
      new RegExp(`Never log this body|${guildId}|${candidate(12).messageId}`),
    );
  } finally {
    stop();
    if (!databaseClosed) database.close();
  }
});

const day = 24 * 60 * 60 * 1_000;

function eventMessage(index: number, content: string): Message {
  const id = String(3_000_000_000_000_000_000n + BigInt(index));
  const botMember = {};
  const channel = {
    id: channelId,
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
  };
  const guild = {
    id: guildId,
    members: { me: botMember },
    channels: { cache: new Map() },
  };
  return {
    partial: false,
    id,
    guildId,
    guild,
    channelId,
    channel,
    author: { bot: false },
    system: false,
    webhookId: null,
    createdAt: now,
    content,
  } as unknown as Message;
}

function eventThread(
  index: number,
  botCanRead: boolean,
): {
  id: string;
  guildId: string;
  parentId: string;
  guild: { members: { me: object } };
  permissionsFor: () => { has: () => boolean };
} {
  return {
    id: String(4_000_000_000_000_000_000n + BigInt(index)),
    guildId,
    parentId: channelId,
    guild: { members: { me: {} } },
    permissionsFor: () => ({ has: () => botCanRead }),
  };
}

function eventChannel(botCanRead: boolean): {
  id: string;
  guildId: string;
  type: ChannelType;
  guild: { members: { me: object } };
  permissionsFor: () => { has: () => boolean };
} {
  return {
    id: channelId,
    guildId,
    type: ChannelType.GuildText,
    guild: { members: { me: {} } },
    permissionsFor: () => ({ has: () => botCanRead }),
  };
}

function emitEvent(client: Client, event: string, ...args: unknown[]): void {
  (client as unknown as EventEmitter).emit(event, ...args);
}
