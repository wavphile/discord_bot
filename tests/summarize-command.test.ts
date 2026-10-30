import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelType,
  Collection,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import type { AiCompletion, AiPrompt, AiProvider } from "../src/ai/types.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { executeSummarizeCommand } from "../src/discord/commands/summarize.js";
import { openDatabase } from "../src/storage/database.js";
import {
  getMessageRetrievalSettings,
  setMessageRetrievalSettings,
} from "../src/storage/message-retrieval.js";

const guildId = "11111111111111111";
const channelId = "22222222222222222";
const requesterId = "33333333333333333";
const botId = "44444444444444444";

function fixture(
  options: Readonly<{
    providerId?: "mock" | "openai" | "anthropic";
    text?: string;
    channelType?: ChannelType;
    messageContent?: boolean;
    guildMembers?: boolean;
    messages?: number;
    privateThreadMemberFails?: boolean;
    onGenerate?: () => void;
  }> = {},
) {
  const database = openDatabase(":memory:");
  const providerId = options.providerId ?? "openai";
  let requesterCanView = true;
  let requesterCanHistory = true;
  let botCanHistory = true;
  let providerCalls = 0;
  let generationCalls = 0;
  let messageFetches = 0;
  let threadMemberFetches = 0;
  let lastPrompt: AiPrompt | undefined;
  let lastReply:
    | string
    | { content: string; allowedMentions?: { parse: string[] } }
    | undefined;
  const createdAt = new Date();
  const messages = Array.from({ length: options.messages ?? 2 }, (_, index) => {
    const suffix = String(index + 1).padStart(17, "0");
    return {
      id: suffix,
      guildId,
      channelId,
      author: {
        id: "55555555555555555",
        bot: false,
        username: `Member ${index + 1}`,
      },
      member: { displayName: `Member ${index + 1}` },
      createdAt: new Date(createdAt.getTime() - index * 1_000),
      content: `Recent discussion point ${index + 1}`,
    };
  });
  const channel = {
    id: channelId,
    name: "bots",
    guildId,
    type: options.channelType ?? ChannelType.GuildText,
    parentId:
      options.channelType === ChannelType.PrivateThread ||
      options.channelType === ChannelType.PublicThread ||
      options.channelType === ChannelType.AnnouncementThread
        ? channelId
        : null,
    permissionsFor: (member: { id: string }) => ({
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.ViewChannel
          ? member.id === botId || requesterCanView
          : permission === PermissionFlagsBits.ReadMessageHistory
            ? member.id === botId
              ? botCanHistory
              : requesterCanHistory
            : false,
    }),
    messages: {
      fetch: async ({ limit }: { limit: number }) => {
        messageFetches += 1;
        return new Collection(
          messages
            .slice(0, limit)
            .map((message) => [message.id, message] as const),
        );
      },
    },
    members: {
      fetch: async () => {
        threadMemberFetches += 1;
        if (options.privateThreadMemberFails) {
          throw new Error("not a member");
        }
        return {};
      },
    },
  };
  const requester = { id: requesterId, guild: { id: guildId } };
  const botMember = { id: botId, guild: { id: guildId } };
  const guild = {
    id: guildId,
    members: {
      fetch: async () => requester,
      fetchMe: async () => botMember,
    },
    channels: { fetch: async () => channel },
  };
  const replies: Array<
    string | { content: string; allowedMentions?: { parse: string[] } }
  > = [];
  const interaction = {
    guild,
    guildId,
    user: { id: requesterId },
    options: { getChannel: () => channel },
    deferReply: async (value: { flags: number }) => {
      assert.equal(value.flags, MessageFlags.Ephemeral);
    },
    editReply: async (
      value:
        string | { content: string; allowedMentions?: { parse: string[] } },
    ) => {
      lastReply = value;
      replies.push(value);
    },
    reply: async (value: { content: string }) => replies.push(value.content),
  } as unknown as ChatInputCommandInteraction;
  const provider: AiProvider = {
    id: providerId,
    model: "fixture",
    async countInputTokens(prompt) {
      providerCalls += 1;
      lastPrompt = prompt;
      return 2;
    },
    async generateText(): Promise<AiCompletion> {
      providerCalls += 1;
      generationCalls += 1;
      options.onGenerate?.();
      return {
        text:
          options.text ??
          JSON.stringify({
            summary: "Members are discussing a bot test.",
            source_ids: [1, 2],
          }),
        provider: providerId,
        model: "fixture",
        usage: { inputTokens: 2, outputTokens: 12, totalTokens: 14 },
      };
    },
  };
  setMessageRetrievalSettings(database, guildId, {
    enabled: true,
    channelIds: [channelId],
    maxAgeDays: 1,
    maxMessages: options.messages ?? 2,
    provider: providerId,
  });
  return {
    database,
    interaction,
    provider,
    replies,
    providerCalls: () => providerCalls,
    generationCalls: () => generationCalls,
    messageFetches: () => messageFetches,
    threadMemberFetches: () => threadMemberFetches,
    lastPrompt: () => lastPrompt,
    lastReply: () => lastReply,
    revokeRequesterView: () => {
      requesterCanView = false;
    },
    denyRequesterHistory: () => {
      requesterCanHistory = false;
    },
    denyBotHistory: () => {
      botCanHistory = false;
    },
  };
}

const limits = {
  maxInputTokens: 10_000,
  maxOutputTokens: 256,
  dailyTokenBudgetPerGuild: 100_000,
  requestTimeoutMs: 5_000,
};

function run(
  mock: ReturnType<typeof fixture>,
  capabilities: { guildMembers: boolean; messageContent: boolean } = {
    guildMembers: false,
    messageContent: true,
  },
) {
  return executeSummarizeCommand(
    mock.interaction,
    mock.database,
    "mock",
    new Map([[mock.provider.id, mock.provider]]),
    limits,
    capabilities,
  );
}

test("summarize returns only validated same-channel source links and retrieval bounds", async () => {
  const mock = fixture();
  try {
    await run(mock);
    const reply = mock.lastReply();
    assert.ok(reply && typeof reply !== "string");
    assert.match(reply.content, /AI-generated summary/);
    assert.match(reply.content, /Members are discussing a bot test\./);
    assert.match(
      reply.content,
      /https:\/\/discord\.com\/channels\/11111111111111111\/22222222222222222\/00000000000000001/,
    );
    assert.match(reply.content, /Configured bounds: at most 2 message\(s\)/);
    assert.match(reply.content, /Retrieved <t:/);
    assert.deepEqual(reply.allowedMentions?.parse, []);
    assert.match(
      mock.lastPrompt()?.instructions ?? "",
      /untrusted user content/,
    );
    assert.equal(mock.generationCalls(), 1);
    const storedSettings = mock.database
      .prepare("SELECT value_json FROM guild_settings WHERE guild_id = ?")
      .get(guildId)?.["value_json"] as string;
    assert.doesNotMatch(storedSettings, /Recent discussion point/);
  } finally {
    mock.database.close();
  }
});

test("summarize labels mock output and links only bounded test sources", async () => {
  const mock = fixture({
    providerId: "mock",
    text: "Mock AI response. No hosted provider was contacted.",
  });
  try {
    await run(mock);
    const reply = mock.lastReply();
    assert.ok(reply && typeof reply !== "string");
    assert.match(reply.content, /Mock provider test output/);
    assert.match(reply.content, /https:\/\/discord\.com\/channels/);
  } finally {
    mock.database.close();
  }
});

test("summarize accepts the Anthropic provider through the shared contract", async () => {
  const anthropic = fixture({ providerId: "anthropic" });
  try {
    await run(anthropic);
    const reply = anthropic.lastReply();
    assert.ok(reply && typeof reply !== "string");
    assert.match(reply.content, /AI-generated summary/);
    assert.doesNotMatch(reply.content, /Mock provider test output/);
    assert.equal(anthropic.generationCalls(), 1);
  } finally {
    anthropic.database.close();
  }
});

test("summarize rejects fabricated source references without returning provider text", async () => {
  const mock = fixture({
    text: JSON.stringify({
      summary: "Secret fabricated source",
      source_ids: [99],
    }),
  });
  try {
    await run(mock);
    const reply = mock.lastReply();
    assert.ok(reply && typeof reply === "string");
    assert.match(reply, /valid source-linked summary/);
    assert.doesNotMatch(
      reply,
      /Secret fabricated source|discord\.com\/channels/,
    );
  } finally {
    mock.database.close();
  }
});

test("summarize stops if access is revoked while generation is running", async () => {
  let revoke: (() => void) | undefined;
  const mock = fixture({ onGenerate: () => revoke?.() });
  revoke = mock.revokeRequesterView;
  try {
    await run(mock);
    const reply = mock.lastReply();
    assert.ok(reply && typeof reply === "string");
    assert.match(reply, /access or message-retrieval settings changed/);
    assert.doesNotMatch(reply, /Members are discussing|discord\.com\/channels/);
  } finally {
    mock.database.close();
  }
});

test("summarize stops if server opt-in is disabled while generation is running", async () => {
  let disable: (() => void) | undefined;
  const mock = fixture({ onGenerate: () => disable?.() });
  disable = () => {
    setMessageRetrievalSettings(mock.database, guildId, {
      enabled: false,
      channelIds: [channelId],
      maxAgeDays: 1,
      maxMessages: 2,
      provider: "openai",
    });
  };
  try {
    await run(mock);
    const reply = mock.lastReply();
    assert.ok(reply && typeof reply === "string");
    assert.match(reply, /access or message-retrieval settings changed/);
    assert.doesNotMatch(reply, /Members are discussing|discord\.com\/channels/);
    assert.equal(
      getMessageRetrievalSettings(mock.database, guildId, "mock").enabled,
      false,
    );
  } finally {
    mock.database.close();
  }
});

test("summarize fails closed when private-thread membership cannot be verified", async () => {
  const mock = fixture({
    channelType: ChannelType.PrivateThread,
    privateThreadMemberFails: true,
  });
  try {
    await run(mock, { guildMembers: true, messageContent: true });
    const reply = mock.lastReply();
    assert.ok(reply && typeof reply === "string");
    assert.match(reply, /membership.*could not be verified/);
    assert.equal(mock.threadMemberFetches(), 1);
    assert.equal(mock.messageFetches(), 0);
    assert.equal(mock.providerCalls(), 0);
  } finally {
    mock.database.close();
  }
});

test("summarize verifies current private-thread membership before returning source links", async () => {
  const mock = fixture({ channelType: ChannelType.PrivateThread });
  try {
    await run(mock, { guildMembers: true, messageContent: true });
    const reply = mock.lastReply();
    assert.ok(reply && typeof reply !== "string");
    assert.equal(mock.threadMemberFetches(), 4);
    assert.equal(mock.messageFetches(), 1);
    assert.match(
      reply.content,
      /https:\/\/discord\.com\/channels\/11111111111111111\/22222222222222222/,
    );
  } finally {
    mock.database.close();
  }
});

test("summarize refuses message content when the privileged intent is unavailable", async () => {
  const mock = fixture();
  try {
    await run(mock, { guildMembers: false, messageContent: false });
    assert.match(String(mock.replies.at(-1)), /Message Content Intent/);
    assert.equal(mock.messageFetches(), 0);
    assert.equal(mock.providerCalls(), 0);
  } finally {
    mock.database.close();
  }
});

test("summarize requires the selected channel to be enabled by a server admin", async () => {
  const mock = fixture();
  setMessageRetrievalSettings(mock.database, guildId, {
    enabled: true,
    channelIds: [],
    maxAgeDays: 1,
    maxMessages: 2,
    provider: "openai",
  });
  try {
    await run(mock);
    const reply = mock.lastReply();
    assert.ok(reply && typeof reply === "string");
    assert.match(reply, /disabled for this channel/);
    assert.equal(mock.messageFetches(), 0);
    assert.equal(mock.providerCalls(), 0);
  } finally {
    mock.database.close();
  }
});

test("summarize requires current requester and bot history access before fetching messages", async (t) => {
  await t.test("requester lacks Read Message History", async () => {
    const mock = fixture();
    mock.denyRequesterHistory();
    try {
      await run(mock);
      assert.match(
        String(mock.lastReply()),
        /You need current View Channel and Read Message History access/,
      );
      assert.equal(mock.messageFetches(), 0);
      assert.equal(mock.providerCalls(), 0);
    } finally {
      mock.database.close();
    }
  });

  await t.test("bot lacks Read Message History", async () => {
    const mock = fixture();
    mock.denyBotHistory();
    try {
      await run(mock);
      assert.match(
        String(mock.lastReply()),
        /The bot needs current View Channel and Read Message History access/,
      );
      assert.equal(mock.messageFetches(), 0);
      assert.equal(mock.providerCalls(), 0);
    } finally {
      mock.database.close();
    }
  });
});

test("summarize output stays below Discord's message length limit", async () => {
  const ids = Array.from({ length: 10 }, (_, index) => index + 1);
  const mock = fixture({
    messages: 10,
    text: JSON.stringify({
      summary: "A".repeat(2_500),
      source_ids: ids,
    }),
  });
  try {
    await run(mock);
    const reply = mock.lastReply();
    assert.ok(reply && typeof reply !== "string");
    assert.ok(reply.content.length <= 1_900);
    assert.match(reply.content, /\[Message 10\]\(https:\/\/discord\.com/);
  } finally {
    mock.database.close();
  }
});
