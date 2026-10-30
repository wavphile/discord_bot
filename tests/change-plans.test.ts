import assert from "node:assert/strict";
import test from "node:test";
import {
  CHANGE_PLAN_TTL_MS,
  formatChangePlanPreview,
  isChangePlanExpired,
  type ChangePlanChange,
  type CreateChangePlanInput,
} from "../src/features/change-plans.js";
import { getSchemaVersion, openDatabase } from "../src/storage/database.js";
import {
  createChangePlan,
  getChangePlan,
} from "../src/storage/change-plans.js";
import {
  saveConfigurationSnapshot,
  type ConfigurationSnapshot,
} from "../src/storage/snapshots.js";

const guildId = "11111111111111111";
const otherGuildId = "99999999999999999";
const requesterId = "22222222222222222";
const now = new Date("2026-10-30T00:00:00.000Z");

function snapshotPayload(serverId = guildId): ConfigurationSnapshot {
  return {
    guild: {
      id: serverId,
      name: "Test server",
      description: null,
      icon: null,
      features: [],
      preferred_locale: "en-US",
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      afk_channel_id: null,
      afk_timeout: 300,
      system_channel_id: null,
      system_channel_flags: "0",
      rules_channel_id: null,
      public_updates_channel_id: null,
      mfa_level: 0,
      nsfw_level: 0,
      premium_tier: 0,
    },
    roles: [],
    channels: [],
    visibility: {
      state: "limited",
      note: "The bot sees only channels returned by Discord.",
      returned_unviewable_channel_count: 0,
    },
  };
}

function createInput(
  changes: readonly ChangePlanChange[] = [
    {
      channelId: "33333333333333333",
      settingKey: "channel.topic",
      before: null,
      after: "Welcome to the test channel.",
    },
  ],
  overrides: Partial<CreateChangePlanInput> = {},
): CreateChangePlanInput {
  return {
    guildId,
    requestedBy: requesterId,
    changes,
    ...overrides,
  };
}

test("migration 4 adds approval metadata to the change-plan schema", () => {
  const database = openDatabase(":memory:");
  try {
    assert.equal(getSchemaVersion(database), 4);
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('change_plans', 'change_plan_items')",
        )
        .get()?.["count"],
      2,
    );
  } finally {
    database.close();
  }
});

test("persists ordered exact changes and an optional same-server snapshot", () => {
  const database = openDatabase(":memory:");
  try {
    const snapshot = saveConfigurationSnapshot(database, {
      guildId,
      requestedBy: requesterId,
      visibility: "limited",
      payload: snapshotPayload(),
    });
    const changes: ChangePlanChange[] = [
      {
        channelId: "33333333333333333",
        settingKey: "channel.topic",
        before: "Old topic",
        after: "New topic",
      },
      {
        channelId: "44444444444444444",
        settingKey: "channel.slowmode",
        before: 0,
        after: 90,
      },
      {
        channelId: "55555555555555555",
        channelType: "text",
        roleId: "66666666666666666",
        settingKey: "channel.role_overwrite",
        before: { allow: "0", deny: "2049" },
        after: { allow: "1024", deny: "1" },
      },
      {
        channelId: "77777777777777777",
        channelType: "voice",
        roleId: "88888888888888888",
        settingKey: "channel.role_overwrite",
        before: { allow: "0", deny: "1050624" },
        after: { allow: "2097152", deny: "2048" },
      },
    ];
    const plan = createChangePlan(
      database,
      createInput(changes, { sourceSnapshotId: snapshot.id }),
      now,
    );

    assert.equal(plan.status, "preview");
    assert.equal(plan.createdAt, now.toISOString());
    assert.equal(
      Date.parse(plan.expiresAt) - Date.parse(plan.createdAt),
      CHANGE_PLAN_TTL_MS,
    );
    assert.equal(plan.sourceSnapshotId, snapshot.id);
    assert.deepEqual(plan.changes, changes);
    assert.deepEqual(getChangePlan(database, guildId, plan.id, now), plan);
  } finally {
    database.close();
  }
});

test("scopes plan retrieval by server and returns undefined for missing plans", () => {
  const database = openDatabase(":memory:");
  try {
    const plan = createChangePlan(database, createInput(), now);
    assert.equal(getChangePlan(database, otherGuildId, plan.id), undefined);
    assert.equal(
      getChangePlan(database, guildId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      undefined,
    );
    assert.throws(() => getChangePlan(database, "bad", plan.id), /guildId/);
    assert.throws(
      () => getChangePlan(database, guildId, "not-a-uuid"),
      /planId/,
    );
    const otherSnapshot = saveConfigurationSnapshot(database, {
      guildId: otherGuildId,
      requestedBy: requesterId,
      visibility: "limited",
      payload: snapshotPayload(otherGuildId),
    });
    database
      .prepare(
        "UPDATE change_plans SET source_snapshot_id = ? WHERE plan_id = ?",
      )
      .run(otherSnapshot.id, plan.id);
    assert.throws(
      () => getChangePlan(database, guildId, plan.id),
      /invalid source snapshot/,
    );
  } finally {
    database.close();
  }
});

test("rejects invalid IDs, duplicate settings, and unsupported values", () => {
  const database = openDatabase(":memory:");
  try {
    assert.throws(
      () =>
        createChangePlan(database, createInput([], { guildId: "bad" }), now),
      /guildId/,
    );
    assert.throws(
      () =>
        createChangePlan(
          database,
          createInput([
            {
              channelId: "33333333333333333",
              settingKey: "channel.topic",
              before: null,
              after: "First",
            },
            {
              channelId: "33333333333333333",
              settingKey: "channel.topic",
              before: "First",
              after: "Second",
            },
          ]),
          now,
        ),
      /same setting twice/,
    );
    assert.throws(
      () =>
        createChangePlan(
          database,
          createInput([
            {
              channelId: "33333333333333333",
              settingKey: "channel.topic",
              before: null,
              after: "x".repeat(1_025),
            },
          ]),
          now,
        ),
      /1,024 characters/,
    );
    assert.throws(
      () =>
        createChangePlan(
          database,
          createInput(
            Array.from({ length: 26 }, (_, index) => ({
              channelId: `${7}${String(index).padStart(16, "0")}`,
              settingKey: "channel.topic" as const,
              before: null,
              after: `Topic ${index}`,
            })),
          ),
          now,
        ),
      /between 1 and 25 items/,
    );
    assert.throws(
      () =>
        createChangePlan(
          database,
          createInput([
            {
              channelId: "33333333333333333",
              settingKey: "channel.slowmode",
              before: 0,
              after: 21_601,
            },
          ]),
          now,
        ),
      /0 through 21,600/,
    );
    assert.throws(
      () =>
        createChangePlan(
          database,
          createInput([
            {
              channelId: "33333333333333333",
              channelType: "text",
              roleId: "66666666666666666",
              settingKey: "channel.role_overwrite",
              before: null,
              after: { allow: "18446744073709551616", deny: "0" },
            },
          ]),
          now,
        ),
      /unsigned 64-bit/,
    );
    assert.throws(
      () =>
        createChangePlan(
          database,
          createInput([
            {
              channelId: "33333333333333333",
              channelType: "text",
              roleId: "66666666666666666",
              settingKey: "channel.role_overwrite",
              before: null,
              after: { allow: "1", deny: "0" },
            },
          ]),
          now,
        ),
      /Only selected permission bits/,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM change_plans").get()?.[
        "count"
      ],
      0,
    );
  } finally {
    database.close();
  }
});

test("rejects missing or cross-server source snapshots", () => {
  const database = openDatabase(":memory:");
  try {
    const otherSnapshot = saveConfigurationSnapshot(database, {
      guildId: otherGuildId,
      requestedBy: requesterId,
      visibility: "limited",
      payload: snapshotPayload(otherGuildId),
    });
    assert.throws(
      () =>
        createChangePlan(
          database,
          createInput(undefined, {
            sourceSnapshotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          }),
          now,
        ),
      /same server/,
    );
    assert.throws(
      () =>
        createChangePlan(
          database,
          createInput(undefined, { sourceSnapshotId: otherSnapshot.id }),
          now,
        ),
      /same server/,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM change_plans").get()?.[
        "count"
      ],
      0,
    );
  } finally {
    database.close();
  }
});

test("rolls back the plan and all items if an item insert fails", () => {
  const database = openDatabase(":memory:");
  try {
    database.exec(`
      CREATE TRIGGER reject_second_change_plan_item
      BEFORE INSERT ON change_plan_items
      WHEN NEW.ordinal = 1
      BEGIN
        SELECT RAISE(ABORT, 'forced test failure');
      END;
    `);
    assert.throws(
      () =>
        createChangePlan(
          database,
          createInput([
            {
              channelId: "33333333333333333",
              settingKey: "channel.topic",
              before: null,
              after: "One",
            },
            {
              channelId: "44444444444444444",
              settingKey: "channel.slowmode",
              before: 0,
              after: 30,
            },
          ]),
          now,
        ),
      /forced test failure/,
    );
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

test("preview is read-only, displays exact values, and marks expiry", () => {
  const database = openDatabase(":memory:");
  try {
    const plan = createChangePlan(
      database,
      createInput([
        {
          channelId: "33333333333333333",
          settingKey: "channel.topic",
          before: "Old @everyone topic",
          after: "New topic with `code`",
        },
        {
          channelId: "44444444444444444",
          settingKey: "channel.slowmode",
          before: 0,
          after: 120,
        },
        {
          channelId: "55555555555555555",
          channelType: "text",
          roleId: "66666666666666666",
          settingKey: "channel.role_overwrite",
          before: { allow: "0", deny: "2048" },
          after: { allow: "1024", deny: "0" },
        },
      ]),
      now,
    );
    const beforePlans = database
      .prepare("SELECT COUNT(*) AS count FROM change_plans")
      .get()?.["count"];
    const beforeItems = database
      .prepare("SELECT COUNT(*) AS count FROM change_plan_items")
      .get()?.["count"];
    const output = formatChangePlanPreview(
      plan,
      new Date(Date.parse(plan.expiresAt) + 1),
    ).join("\n");

    assert.equal(isChangePlanExpired(plan, now), false);
    assert.equal(
      isChangePlanExpired(plan, new Date(Date.parse(plan.expiresAt) + 1)),
      true,
    );
    assert.match(output, /Status: expired/);
    assert.match(output, /Old @​everyone topic/);
    assert.match(output, /New topic with \\u0060code\\u0060/);
    assert.match(output, /\"allow\"/);
    assert.match(
      output,
      /Preview only\. No Discord changes have been applied\./,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM change_plans").get()?.[
        "count"
      ],
      beforePlans,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM change_plan_items")
        .get()?.["count"],
      beforeItems,
    );
    assert.equal(
      getChangePlan(database, guildId, plan.id, now)?.status,
      "preview",
    );
    assert.equal(
      getChangePlan(
        database,
        guildId,
        plan.id,
        new Date(Date.parse(plan.expiresAt) + 1),
      )?.status,
      "expired",
    );
    assert.equal(
      database
        .prepare("SELECT status FROM change_plans WHERE plan_id = ?")
        .get(plan.id)?.["status"],
      "preview",
    );
  } finally {
    database.close();
  }
});

test("splits large previews into valid Discord-sized messages", () => {
  const changes: ChangePlanChange[] = Array.from(
    { length: 25 },
    (_, index) => ({
      channelId: `${7}${String(index).padStart(16, "0")}`,
      settingKey: "channel.topic",
      before: "*".repeat(1_024),
      after: "@everyone".repeat(100),
    }),
  );
  const database = openDatabase(":memory:");
  try {
    const plan = createChangePlan(database, createInput(changes), now);
    const messages = formatChangePlanPreview(plan, now);
    assert.ok(messages.length > 1);
    assert.ok(messages.every((message) => message.length <= 2_000));
    assert.ok(messages.join("\n").includes("@​everyone"));
  } finally {
    database.close();
  }
});
