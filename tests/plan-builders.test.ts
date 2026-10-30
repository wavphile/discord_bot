import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, MessageFlags } from "discord.js";
import { executePlanCommand } from "../src/discord/commands/plan.js";
import {
  buildRoleOverwriteChanges,
  buildSlowmodeChanges,
  buildTopicChanges,
  parseChannelSelectors,
  resolveChannelTargets,
  type ChannelSelection,
  type RoleOverwriteTarget,
} from "../src/features/plan-builders.js";
import { formatChangePlanPreview } from "../src/features/change-plans.js";
import { openDatabase } from "../src/storage/database.js";

const guildId = "11111111111111111";
const channelA = "33333333333333333";
const channelB = "44444444444444444";
const roleId = "55555555555555555";

function channel(
  id: string,
  overrides: Partial<ChannelSelection> = {},
): ChannelSelection {
  return {
    id,
    guildId,
    type: ChannelType.GuildText,
    name: "bots",
    viewable: true,
    ...overrides,
  };
}

test("parses channel mentions and IDs into a deduplicated ordered list", () => {
  assert.deepEqual(
    parseChannelSelectors(` <#${channelA}> , ${channelB}, ${channelA} `),
    [channelA, channelB],
  );
});

test("rejects malformed and over-limit channel selectors", () => {
  assert.throws(() => parseChannelSelectors(""), /at least one channel/);
  assert.throws(() => parseChannelSelectors(`${channelA},`), /empty entries/);
  assert.throws(() => parseChannelSelectors("<#1234>"), /channel mention/);

  const ids = Array.from({ length: 26 }, (_, index) =>
    (60_000_000_000_000_000n + BigInt(index)).toString(10),
  ).join(",");
  assert.throws(() => parseChannelSelectors(ids), /at most 25 channels/);
});

test("resolves only visible, supported channels from the current server", () => {
  const channels = [
    channel(channelA),
    channel(channelB, { guildId: "99999999999999999" }),
  ];
  assert.throws(
    () =>
      resolveChannelTargets(channelB, guildId, channels, [
        ChannelType.GuildText,
      ]),
    /another server/,
  );
  assert.throws(
    () =>
      resolveChannelTargets(
        channelA,
        guildId,
        [channel(channelA, { viewable: false })],
        [ChannelType.GuildText],
      ),
    /not visible/,
  );
  assert.throws(
    () =>
      resolveChannelTargets(
        channelA,
        guildId,
        [channel(channelA, { type: ChannelType.GuildCategory })],
        [ChannelType.GuildText],
      ),
    /unsupported type/,
  );
  assert.throws(
    () => resolveChannelTargets(channelB, guildId, [channel(channelA)], [0]),
    /not found in this server/,
  );
});

test("builds topic and slowmode plans while identifying no-op targets", () => {
  const topics = buildTopicChanges(
    [
      { id: channelA, name: "bots", topic: "old" },
      { id: channelB, name: "general", topic: "new" },
    ],
    "new",
  );
  assert.equal(topics.changes.length, 1);
  assert.deepEqual(topics.noOpChannelIds, [channelB]);
  assert.deepEqual(topics.changes[0], {
    channelId: channelA,
    settingKey: "channel.topic",
    before: "old",
    after: "new",
  });

  const slowmode = buildSlowmodeChanges(
    [
      { id: channelA, name: "bots", slowmode: 0 },
      { id: channelB, name: "general", slowmode: 15 },
    ],
    15,
  );
  assert.equal(slowmode.changes.length, 1);
  assert.deepEqual(slowmode.noOpChannelIds, [channelB]);
  assert.equal(
    buildTopicChanges([{ id: channelA, name: "bots", topic: null }], null)
      .changes.length,
    0,
  );
});

test("changes one selected role bit and preserves every unrelated overwrite bit", () => {
  const view = 1n << 10n;
  const unrelatedAllow = 1n << 35n;
  const unrelatedDeny = 1n << 38n;
  const target: RoleOverwriteTarget = {
    id: channelA,
    name: "bots",
    channelType: "text",
    overwrite: {
      allow: (view | unrelatedAllow).toString(10),
      deny: unrelatedDeny.toString(10),
    },
  };

  const result = buildRoleOverwriteChanges(
    [target],
    roleId,
    "view_channel",
    "deny",
  );
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.changes[0], {
    channelId: channelA,
    channelType: "text",
    roleId,
    settingKey: "channel.role_overwrite",
    before: target.overwrite,
    after: {
      allow: unrelatedAllow.toString(10),
      deny: (unrelatedDeny | view).toString(10),
    },
  });
});

test("role overwrite plans handle inherit, no-ops, and channel-type restrictions", () => {
  const inherited: RoleOverwriteTarget = {
    id: channelA,
    name: "bots",
    channelType: "text",
    overwrite: null,
  };
  const noOp = buildRoleOverwriteChanges(
    [inherited],
    roleId,
    "view_channel",
    "inherit",
  );
  assert.equal(noOp.changes.length, 0);
  assert.deepEqual(noOp.noOpChannelIds, [channelA]);

  const emptyAfterInherit = buildRoleOverwriteChanges(
    [
      {
        ...inherited,
        overwrite: {
          allow: (1n << 10n).toString(10),
          deny: "0",
        },
      },
    ],
    roleId,
    "view_channel",
    "inherit",
  );
  const inheritedChange = emptyAfterInherit.changes[0];
  assert.ok(inheritedChange?.settingKey === "channel.role_overwrite");
  assert.equal(inheritedChange.before?.allow, (1n << 10n).toString(10));
  assert.equal(inheritedChange.after, null);

  assert.throws(
    () =>
      buildRoleOverwriteChanges(
        [
          inherited,
          {
            id: channelB,
            name: "voice",
            channelType: "voice",
            overwrite: null,
          },
        ],
        roleId,
        "send_messages",
        "allow",
      ),
    /not supported on voice/,
  );
});

test("preview names exact targets, values, and states that no edits were applied", () => {
  const messages = formatChangePlanPreview(
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      guildId,
      requestedBy: "22222222222222222",
      sourceSnapshotId: null,
      createdAt: "2026-10-30T00:00:00.000Z",
      expiresAt: "2026-10-30T00:30:00.000Z",
      status: "preview",
      submittedAt: null,
      decisionBy: null,
      decisionAt: null,
      changes: [
        {
          channelId: channelA,
          settingKey: "channel.topic",
          before: "before",
          after: "after",
        },
        {
          channelId: channelB,
          channelType: "voice",
          roleId,
          settingKey: "channel.role_overwrite",
          before: null,
          after: { allow: "1024", deny: "0" },
        },
      ],
    },
    new Date("2026-10-30T00:00:00.000Z"),
    {
      channels: new Map([
        [channelA, "bots"],
        [channelB, "voice-lounge"],
      ]),
      roles: new Map([[roleId, "Helpers"]]),
    },
  );
  const preview = messages.join("\n");
  assert.match(preview, /#bots/);
  assert.match(preview, /#voice-lounge/);
  assert.match(preview, /Helpers/);
  assert.match(preview, /View Channel: allow/);
  assert.match(preview, /before/);
  assert.match(preview, /after/);
  assert.match(preview, /No Discord changes have been applied/);
});

test("the slash command replies privately and stores a fixed preview plan", async () => {
  const database = openDatabase(":memory:");
  try {
    const liveChannel = {
      id: channelA,
      guildId,
      type: ChannelType.GuildText,
      name: "bots",
      viewable: true,
      topic: "old topic",
      rateLimitPerUser: 0,
    };
    const guild = {
      id: guildId,
      channels: {
        fetch: async (id: string) => (id === channelA ? liveChannel : null),
      },
    };
    let deferredFlags: number | undefined;
    let reply:
      { content?: string; allowedMentions?: { parse: string[] } } | undefined;
    const interaction = {
      guild,
      guildId,
      user: { id: "22222222222222222" },
      options: {
        getSubcommand: () => "topic",
        getString: (name: string) =>
          name === "channels" ? `<#${channelA}>` : "new topic",
      },
      deferReply: async (options: { flags: number }) => {
        deferredFlags = options.flags;
      },
      editReply: async (payload: typeof reply | string) => {
        reply = typeof payload === "string" ? { content: payload } : payload;
      },
      followUp: async () => undefined,
    } as unknown as Parameters<typeof executePlanCommand>[0];

    await executePlanCommand(interaction, database);

    assert.equal(deferredFlags, MessageFlags.Ephemeral);
    assert.equal(reply?.allowedMentions?.parse.length, 0);
    assert.match(reply?.content ?? "", /#bots/);
    assert.match(reply?.content ?? "", /No Discord changes have been applied/);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM change_plans").get()?.[
        "count"
      ],
      1,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM change_plan_items")
        .get()?.["count"],
      1,
    );
  } finally {
    database.close();
  }
});

test("rejects the whole command before saving when any selected channel is unsupported", async () => {
  const database = openDatabase(":memory:");
  try {
    const firstChannel = {
      id: channelA,
      guildId,
      type: ChannelType.GuildText,
      name: "bots",
      viewable: true,
      topic: "old topic",
      rateLimitPerUser: 0,
    };
    const unsupportedChannel = {
      ...firstChannel,
      id: channelB,
      type: ChannelType.GuildVoice,
      name: "voice",
    };
    const guild = {
      id: guildId,
      channels: {
        fetch: async (id: string) =>
          id === channelA
            ? firstChannel
            : id === channelB
              ? unsupportedChannel
              : null,
      },
    };
    let replyContent = "";
    const interaction = {
      guild,
      guildId,
      user: { id: "22222222222222222" },
      options: {
        getSubcommand: () => "topic",
        getString: (name: string) =>
          name === "channels" ? `<#${channelA}>, <#${channelB}>` : "new topic",
      },
      deferReply: async () => undefined,
      editReply: async (payload: { content?: string } | string) => {
        replyContent =
          typeof payload === "string" ? payload : (payload.content ?? "");
      },
      followUp: async () => undefined,
    } as unknown as Parameters<typeof executePlanCommand>[0];

    await executePlanCommand(interaction, database);

    assert.match(replyContent, /unsupported type/);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM change_plans").get()?.[
        "count"
      ],
      0,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM change_plan_items")
        .get()?.["count"],
      0,
    );
  } finally {
    database.close();
  }
});
