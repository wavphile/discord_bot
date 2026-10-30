import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import type { AiProvider } from "../src/ai/types.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { executeMessagesCommand } from "../src/discord/commands/messages.js";
import { openDatabase } from "../src/storage/database.js";
import { getMessageRetrievalSettings } from "../src/storage/message-retrieval.js";

const guildId = "11111111111111111";
const userId = "22222222222222222";
const channelId = "33333333333333333";

function interaction(
  options: Readonly<{
    subcommand: string;
    group?: string | null;
    manageGuild?: boolean;
    channel?: { id: string; guildId: string; type: ChannelType };
  }>,
): {
  value: ChatInputCommandInteraction;
  replies: string[];
} {
  const replies: string[] = [];
  const channel = options.channel ?? {
    id: channelId,
    guildId,
    type: ChannelType.GuildText,
  };
  const guild = {
    id: guildId,
    members: {
      fetch: async () => ({
        permissions: {
          has: (permission: bigint) =>
            permission === PermissionFlagsBits.ManageGuild &&
            (options.manageGuild ?? false),
        },
      }),
    },
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
        getInteger: () => null,
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
    assert.equal(
      getMessageRetrievalSettings(database, guildId, "mock").enabled,
      false,
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
