import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import type { AiCompletion, AiProvider } from "../src/ai/types.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { executeAskCommand } from "../src/discord/commands/ask.js";
import { openDatabase } from "../src/storage/database.js";
import { saveConfigurationSnapshot } from "../src/storage/snapshots.js";

const guildId = "11111111111111111";
const channelId = "22222222222222222";
const requesterId = "33333333333333333";

function fixture(canView: boolean) {
  const replies: string[] = [];
  let providerCalls = 0;
  const requester = {
    id: requesterId,
    roles: { cache: new Map([[guildId, {}]]) },
    isCommunicationDisabled: () => false,
  };
  const channel = {
    id: channelId,
    guildId,
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => canView }),
  };
  const guild = {
    id: guildId,
    ownerId: "99999999999999999",
    roles: { fetch: async () => undefined },
    members: { fetch: async () => requester },
    channels: { fetch: async () => channel },
  };
  const interaction = {
    guild,
    guildId,
    user: { id: requesterId },
    options: {
      getString: () => "Why can a member see this channel?",
      getChannel: () => channel,
      getUser: () => null,
    },
    deferReply: async () => undefined,
    editReply: async (value: string | { content: string }) => {
      replies.push(typeof value === "string" ? value : value.content);
    },
    reply: async (value: { content: string }) => replies.push(value.content),
  };
  const provider: AiProvider = {
    id: "mock",
    model: "fixture",
    async countInputTokens() {
      providerCalls += 1;
      return 1;
    },
    async generateText(): Promise<AiCompletion> {
      providerCalls += 1;
      return {
        text: "fixture response",
        provider: "mock",
        model: "fixture",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };
  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,
    replies,
    provider,
    providerCalls: () => providerCalls,
  };
}

const limits = {
  maxInputTokens: 100,
  maxOutputTokens: 16,
  dailyTokenBudgetPerGuild: 100,
  requestTimeoutMs: 5_000,
};

test("ask denies a requester who cannot currently view the selected channel", async () => {
  const database = openDatabase(":memory:");
  const mock = fixture(false);
  try {
    await executeAskCommand(mock.interaction, database, mock.provider, limits);
    assert.match(mock.replies.at(-1) ?? "", /current View Channel access/);
    assert.doesNotMatch(mock.replies.at(-1) ?? "", /bots|snapshot/i);
    assert.equal(mock.providerCalls(), 0);
  } finally {
    database.close();
  }
});

test("ask requests a snapshot before sending any question to a provider", async () => {
  const database = openDatabase(":memory:");
  const mock = fixture(true);
  try {
    await executeAskCommand(mock.interaction, database, mock.provider, limits);
    assert.match(mock.replies.at(-1) ?? "", /Run \/server inspect/);
    assert.equal(mock.providerCalls(), 0);
  } finally {
    database.close();
  }
});

test("ask sends bounded selected-channel evidence and appends its provenance", async () => {
  const database = openDatabase(":memory:");
  const mock = fixture(true);
  const snapshot = saveConfigurationSnapshot(database, {
    guildId,
    requestedBy: requesterId,
    visibility: "limited",
    payload: {
      guild: {
        id: guildId,
        name: "Private test server",
        description: null,
        icon: null,
        features: [],
        preferred_locale: "en-US",
        verification_level: 0,
        default_message_notifications: 0,
        explicit_content_filter: 0,
        afk_channel_id: null,
        afk_timeout: 0,
        system_channel_id: null,
        system_channel_flags: "0",
        rules_channel_id: null,
        public_updates_channel_id: null,
        mfa_level: 0,
        nsfw_level: 0,
        premium_tier: 0,
      },
      roles: [
        {
          id: guildId,
          name: "@everyone",
          position: 0,
          permissions: PermissionFlagsBits.ViewChannel.toString(),
          colors: {
            primary_color: 0,
            secondary_color: null,
            tertiary_color: null,
          },
          hoist: false,
          managed: false,
          mentionable: false,
          flags: "0",
        },
      ],
      channels: [
        {
          id: channelId,
          type: ChannelType.GuildText,
          name: "bots",
          position: 0,
          parent_id: null,
          topic: "Only bot testing.",
          nsfw: false,
          rate_limit_per_user: 0,
          viewable: true,
          permission_overwrites: [],
        },
      ],
      visibility: {
        state: "limited",
        note: "Only channels returned by Discord are represented.",
        returned_unviewable_channel_count: 0,
      },
    },
  });
  try {
    await executeAskCommand(mock.interaction, database, mock.provider, limits);
    const reply = mock.replies.at(-1) ?? "";
    assert.match(reply, /Mock provider test output/);
    assert.match(reply, new RegExp(snapshot.id));
    assert.match(reply, new RegExp(channelId));
    assert.match(reply, /Only channels returned by Discord/);
    assert.equal(mock.providerCalls(), 2);
  } finally {
    database.close();
  }
});
