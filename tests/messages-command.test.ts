import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import type { AiProvider } from "../src/ai/types.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { executeMessagesCommand } from "../src/discord/commands/messages.js";
import { openDatabase } from "../src/storage/database.js";
import { getMessageRetrievalSettings } from "../src/storage/message-retrieval.js";
import {
  enableMessageRetention,
  getMessageRetentionSettings,
  storeNewMessage,
} from "../src/storage/message-retention.js";

const guildId = "11111111111111111";
const userId = "22222222222222222";
const channelId = "33333333333333333";
const otherChannelId = "55555555555555555";

function interaction(
  options: Readonly<{
    subcommand: string;
    group?: string | null;
    manageGuild?: boolean;
    channel?: { id: string; guildId: string; type: ChannelType } | null;
    botCanRead?: boolean;
    retentionDays?: number | null;
    confirm?: boolean;
  }>,
): {
  value: ChatInputCommandInteraction;
  replies: string[];
} {
  const replies: string[] = [];
  const selectedChannel =
    options.channel === null
      ? null
      : (options.channel ?? {
          id: channelId,
          guildId,
          type: ChannelType.GuildText,
        });
  const channel = selectedChannel
    ? {
        ...selectedChannel,
        permissionsFor: () => ({
          has: (permission: bigint) =>
            (options.botCanRead ?? true) &&
            (permission === PermissionFlagsBits.ViewChannel ||
              permission === PermissionFlagsBits.ReadMessageHistory),
        }),
      }
    : null;
  const guildMembers = {
    me: { id: "44444444444444444" },
    fetchMe: async () => ({ id: "44444444444444444" }),
    fetch: async () => ({
      permissions: {
        has: (permission: bigint) =>
          permission === PermissionFlagsBits.ManageGuild &&
          (options.manageGuild ?? false),
      },
    }),
  };
  const guild = {
    id: guildId,
    members: guildMembers,
    channels: { fetch: async () => channel },
  };
  return {
    value: {
      guild,
      guildId,
      user: { id: userId },
      options: {
        getSubcommand: () => options.subcommand,
        getSubcommandGroup: () => options.group ?? null,
        getChannel: () => channel,
        getInteger: (name: string) =>
          name === "retention_days" ? (options.retentionDays ?? null) : null,
        getBoolean: () => options.confirm ?? false,
        getString: () => "mock",
      },
      reply: async (reply: { content: string }) => replies.push(reply.content),
    } as unknown as ChatInputCommandInteraction,
    replies,
  };
}

const provider: AiProvider = {
  id: "mock",
  model: "fixture",
  async countInputTokens() {
    return 1;
  },
  async generateText() {
    return {
      text: "fixture",
      provider: "mock",
      model: "fixture",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  },
};

test("message retrieval settings are visible privately but disabled by default", async () => {
  const database = openDatabase(":memory:");
  const mock = interaction({ subcommand: "status" });
  try {
    await executeMessagesCommand(
      mock.value,
      database,
      "mock",
      new Map([["mock", provider]]),
    );
    assert.match(mock.replies[0] ?? "", /Message retrieval: disabled/);
    assert.match(mock.replies[0] ?? "", /Allowed channels: none/);
    assert.match(mock.replies[0] ?? "", /Message retention: disabled/);
    assert.equal(
      getMessageRetrievalSettings(database, guildId, "mock").enabled,
      false,
    );
  } finally {
    database.close();
  }
});

test("retention opt-in requires Manage Server, Message Content, and bot read access", async () => {
  const database = openDatabase(":memory:");
  const noManage = interaction({
    subcommand: "storage-enable",
    group: "config",
    retentionDays: 2,
  });
  const noIntent = interaction({
    subcommand: "storage-enable",
    group: "config",
    manageGuild: true,
    retentionDays: 2,
  });
  const noBotAccess = interaction({
    subcommand: "storage-enable",
    group: "config",
    manageGuild: true,
    botCanRead: false,
    retentionDays: 2,
  });
  const allowed = interaction({
    subcommand: "storage-enable",
    group: "config",
    manageGuild: true,
    retentionDays: 2,
  });
  try {
    await executeMessagesCommand(
      noManage.value,
      database,
      "mock",
      new Map([["mock", provider]]),
      { guildMembers: false, messageContent: true },
    );
    assert.match(noManage.replies[0] ?? "", /Manage Server permission/);

    await executeMessagesCommand(
      noIntent.value,
      database,
      "mock",
      new Map([["mock", provider]]),
    );
    assert.match(noIntent.replies[0] ?? "", /Message Content/);

    await executeMessagesCommand(
      noBotAccess.value,
      database,
      "mock",
      new Map([["mock", provider]]),
      { guildMembers: false, messageContent: true },
    );
    assert.match(noBotAccess.replies[0] ?? "", /Read Message History/);
    assert.deepEqual(
      getMessageRetentionSettings(database, guildId).channels,
      [],
    );

    await executeMessagesCommand(
      allowed.value,
      database,
      "mock",
      new Map([["mock", provider]]),
      { guildMembers: false, messageContent: true },
    );
    assert.match(allowed.replies[0] ?? "", /enabled.*2 day/);
    assert.deepEqual(
      getMessageRetentionSettings(database, guildId).channels.map(
        (entry) => entry.channelId,
      ),
      [channelId],
    );

    assert.equal(
      getMessageRetrievalSettings(database, guildId, "mock").enabled,
      false,
    );
  } finally {
    database.close();
  }
});

test("retention disable and private purge require explicit confirmation and delete scoped rows", async () => {
  const database = openDatabase(":memory:");
  const now = new Date("2026-10-30T10:00:00.000Z");
  const makeMessage = (id: string, targetChannelId: string) => ({
    guildId,
    channelId: targetChannelId,
    parentChannelId: null,
    messageId: id,
    createdAt: now.toISOString(),
    content: `stored ${id}`,
    isBot: false,
    isWebhook: false,
    messageContentEnabled: true,
    botCanRead: true,
  });
  try {
    enableMessageRetention(database, guildId, channelId, 2, now);
    enableMessageRetention(database, guildId, otherChannelId, 2, now);
    storeNewMessage(database, makeMessage("66666666666666666", channelId), now);
    storeNewMessage(
      database,
      makeMessage("77777777777777777", otherChannelId),
      now,
    );

    const unconfirmed = interaction({
      subcommand: "purge",
      manageGuild: true,
      confirm: false,
      channel: {
        id: channelId,
        guildId,
        type: ChannelType.GuildText,
      },
    });
    await executeMessagesCommand(
      unconfirmed.value,
      database,
      "mock",
      new Map([["mock", provider]]),
    );
    assert.match(unconfirmed.replies[0] ?? "", /No messages were deleted/);

    const confirmed = interaction({
      subcommand: "purge",
      manageGuild: true,
      confirm: true,
      channel: {
        id: channelId,
        guildId,
        type: ChannelType.GuildText,
      },
    });
    await executeMessagesCommand(
      confirmed.value,
      database,
      "mock",
      new Map([["mock", provider]]),
    );
    assert.match(confirmed.replies[0] ?? "", /Purged 1 retained message/);

    const disabled = interaction({
      subcommand: "storage-disable",
      group: "config",
      manageGuild: true,
      channel: {
        id: otherChannelId,
        guildId,
        type: ChannelType.GuildText,
      },
    });
    await executeMessagesCommand(
      disabled.value,
      database,
      "mock",
      new Map([["mock", provider]]),
    );
    assert.match(disabled.replies[0] ?? "", /1 stored message.*deleted/);
    assert.deepEqual(
      getMessageRetentionSettings(database, guildId).channels.map(
        (entry) => entry.channelId,
      ),
      [channelId],
    );

    storeNewMessage(database, makeMessage("66666666666666668", channelId), now);
    const disabledServer = interaction({
      subcommand: "storage-disable",
      group: "config",
      manageGuild: true,
      channel: null,
    });
    await executeMessagesCommand(
      disabledServer.value,
      database,
      "mock",
      new Map([["mock", provider]]),
    );
    assert.match(
      disabledServer.replies[0] ?? "",
      /Retention is disabled for this server/,
    );
    assert.deepEqual(
      getMessageRetentionSettings(database, guildId).channels,
      [],
    );
  } finally {
    database.close();
  }
});

test("only a Manage Server member can enable retrieval for a local text channel", async () => {
  const database = openDatabase(":memory:");
  const denied = interaction({ subcommand: "enable", group: "config" });
  try {
    await executeMessagesCommand(
      denied.value,
      database,
      "mock",
      new Map([["mock", provider]]),
    );
    assert.match(denied.replies[0] ?? "", /Manage Server permission/);
    assert.equal(
      getMessageRetrievalSettings(database, guildId, "mock").enabled,
      false,
    );

    const allowed = interaction({
      subcommand: "enable",
      group: "config",
      manageGuild: true,
    });
    await executeMessagesCommand(
      allowed.value,
      database,
      "mock",
      new Map([["mock", provider]]),
    );
    assert.equal(
      getMessageRetrievalSettings(database, guildId, "mock").enabled,
      true,
    );
    assert.deepEqual(
      getMessageRetrievalSettings(database, guildId, "mock").channelIds,
      [channelId],
    );
    assert.match(allowed.replies[0] ?? "", /not stored/);
  } finally {
    database.close();
  }
});

test("configuration rejects channels from another server and non-text channels", async () => {
  const database = openDatabase(":memory:");
  const foreign = interaction({
    subcommand: "enable",
    group: "config",
    manageGuild: true,
    channel: {
      id: channelId,
      guildId: "99999999999999999",
      type: ChannelType.GuildText,
    },
  });
  try {
    await executeMessagesCommand(
      foreign.value,
      database,
      "mock",
      new Map([["mock", provider]]),
    );
    assert.match(foreign.replies[0] ?? "", /text or announcement channel/);
    assert.equal(
      getMessageRetrievalSettings(database, guildId, "mock").channelIds.length,
      0,
    );
  } finally {
    database.close();
  }
});
