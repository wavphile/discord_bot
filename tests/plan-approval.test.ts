import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  type Guild,
  type GuildMember,
} from "discord.js";
import {
  authorizeInteraction,
  authorizePlanApprover,
} from "../src/core/authorization.js";
import { evaluatePlanPreflight } from "../src/features/plan-approval.js";
import type {
  ChangePlan,
  ChangePlanChange,
} from "../src/features/change-plans.js";
import { openDatabase } from "../src/storage/database.js";
import { preflightChangePlanOnDiscord } from "../src/discord/change-plan-preflight.js";
import {
  approveChangePlan,
  ChangePlanTransitionError,
  createChangePlan,
  getChangePlan,
  markChangePlanConflicted,
  rejectChangePlan,
  submitChangePlanForApproval,
} from "../src/storage/change-plans.js";

const guildId = "11111111111111111";
const otherGuildId = "99999999999999999";
const requesterId = "22222222222222222";
const approverId = "33333333333333333";
const roleId = "44444444444444444";
const channelId = "55555555555555555";
const now = new Date("2026-10-30T00:00:00.000Z");

function planChanges(): ChangePlanChange[] {
  return [
    {
      channelId,
      settingKey: "channel.topic",
      before: "before",
      after: "after",
    },
    {
      channelId: "66666666666666666",
      settingKey: "channel.slowmode",
      before: 0,
      after: 5,
    },
    {
      channelId: "77777777777777777",
      channelType: "text",
      roleId,
      settingKey: "channel.role_overwrite",
      before: { allow: "0", deny: "0" },
      after: { allow: "1024", deny: "0" },
    },
  ];
}

function createPendingPlan(
  changes = planChanges(),
  createdAt = now,
): { database: ReturnType<typeof openDatabase>; plan: ChangePlan } {
  const database = openDatabase(":memory:");
  const plan = createChangePlan(
    database,
    { guildId, requestedBy: requesterId, changes },
    createdAt,
  );
  return { database, plan };
}

test("request and approval policies are independent and guild-scoped", () => {
  const requestPolicy = {
    guildId,
    allowedUserIds: new Set([requesterId]),
    allowedRoleIds: new Set<string>(),
  };
  const approvalPolicy = {
    guildId,
    approverUserIds: new Set([approverId]),
    approverRoleIds: new Set([roleId]),
  };

  assert.equal(
    authorizeInteraction(
      { guildId, userId: requesterId, roleIds: [] },
      requestPolicy,
    ).allowed,
    true,
  );
  assert.equal(
    authorizePlanApprover(
      { guildId, userId: requesterId, roleIds: [] },
      approvalPolicy,
    ).allowed,
    false,
  );
  assert.equal(
    authorizePlanApprover(
      { guildId, userId: approverId, roleIds: [] },
      approvalPolicy,
    ).allowed,
    true,
  );
  assert.equal(
    authorizePlanApprover(
      { guildId, userId: "88888888888888888", roleIds: [roleId] },
      approvalPolicy,
    ).allowed,
    true,
  );
  assert.deepEqual(
    authorizePlanApprover(
      { guildId: "99999999999999999", userId: approverId, roleIds: [] },
      approvalPolicy,
    ),
    { allowed: false, reason: "wrong_guild" },
  );
});

test("preflight accepts exact current values and rejects every stale target", () => {
  const changes = planChanges();
  const plan = { changes };
  const matches = evaluatePlanPreflight(plan, true, [
    { current: "before", canWrite: true },
    { current: 0, canWrite: true },
    { current: { allow: "0", deny: "0" }, canWrite: true },
  ]);
  assert.deepEqual(matches, { ready: true, issues: [] });

  const stale = evaluatePlanPreflight(plan, true, [
    { current: "changed", canWrite: true },
    { current: 0, canWrite: false, reason: "Manage Channels is missing." },
    { current: { allow: "0", deny: "1" }, canWrite: true },
  ]);
  assert.equal(stale.ready, false);
  assert.equal(stale.issues.length, 3);
  assert.match(stale.issues[0]?.reason ?? "", /changed since/);
  assert.match(stale.issues[1]?.reason ?? "", /Manage Channels/);
  assert.match(stale.issues[2]?.reason ?? "", /changed since/);
});

test("preflight fails closed when requester authorization or target reads fail", () => {
  const result = evaluatePlanPreflight(
    { changes: planChanges().slice(0, 1) },
    false,
    [null],
  );
  assert.equal(result.ready, false);
  assert.equal(result.issues.length, 2);
  assert.match(
    result.issues[0]?.reason ?? "",
    /requester is no longer authorized/,
  );
  assert.match(result.issues[1]?.reason ?? "", /could not be checked/);
});

test("Discord preflight reads current channel state and performs no writes", async () => {
  let currentTopic = "before";
  let writeCount = 0;
  let channelReads = 0;
  let requesterReads = 0;
  let manageChannels = true;
  const channel = {
    id: channelId,
    guildId,
    type: ChannelType.GuildText,
    get topic() {
      return currentTopic;
    },
    set topic(value: string | null) {
      currentTopic = value ?? "";
      writeCount += 1;
    },
    permissionsFor: () =>
      new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        ...(manageChannels ? [PermissionFlagsBits.ManageChannels] : []),
      ]),
  };
  const botMember = {
    roles: { highest: { position: 10 } },
  } as unknown as GuildMember;
  const requester = {
    id: requesterId,
    roles: { cache: { keys: () => [][Symbol.iterator]() } },
  } as unknown as GuildMember;
  const guild = {
    id: guildId,
    channels: {
      fetch: async () => {
        channelReads += 1;
        return channel;
      },
    },
    members: {
      me: botMember,
      fetch: async () => {
        requesterReads += 1;
        return requester;
      },
      fetchMe: async () => botMember,
    },
    roles: { cache: new Map(), fetch: async () => new Map() },
  } as unknown as Guild;
  const policy = {
    guildId,
    allowedUserIds: new Set([requesterId]),
    allowedRoleIds: new Set<string>(),
  };
  const plan = {
    requestedBy: requesterId,
    changes: [planChanges()[0]!],
  };

  const result = await preflightChangePlanOnDiscord(guild, plan, policy);

  assert.deepEqual(result, { ready: true, issues: [] });
  assert.equal(channelReads, 1);
  assert.equal(requesterReads, 1);
  assert.equal(writeCount, 0);
  assert.equal(currentTopic, "before");

  currentTopic = "changed by another admin";
  const changed = await preflightChangePlanOnDiscord(guild, plan, policy);
  assert.equal(changed.ready, false);
  assert.match(changed.issues[0]?.reason ?? "", /changed since/);

  currentTopic = "before";
  manageChannels = false;
  const inaccessible = await preflightChangePlanOnDiscord(guild, plan, policy);
  assert.equal(inaccessible.ready, false);
  assert.match(inaccessible.issues[0]?.reason ?? "", /Manage Channels/);
  assert.equal(writeCount, 0);
});

test("only the requester can submit an unexpired preview and approval is a one-time recorded transition", () => {
  const { database, plan } = createPendingPlan();
  try {
    assert.throws(
      () =>
        submitChangePlanForApproval(
          database,
          guildId,
          plan.id,
          approverId,
          now,
        ),
      (error: unknown) =>
        error instanceof ChangePlanTransitionError &&
        error.code === "not_requester",
    );
    const submitted = submitChangePlanForApproval(
      database,
      guildId,
      plan.id,
      requesterId,
      now,
    );
    assert.equal(submitted.status, "awaiting_approval");
    assert.equal(submitted.submittedAt, now.toISOString());
    assert.equal(submitted.decisionBy, null);
    assert.equal(submitted.decisionAt, null);

    const approved = approveChangePlan(
      database,
      guildId,
      plan.id,
      approverId,
      new Date(now.getTime() + 1_000),
    );
    assert.equal(approved.status, "approved");
    assert.equal(approved.decisionBy, approverId);
    assert.equal(
      approved.decisionAt,
      new Date(now.getTime() + 1_000).toISOString(),
    );
    assert.throws(
      () => approveChangePlan(database, guildId, plan.id, approverId, now),
      (error: unknown) =>
        error instanceof ChangePlanTransitionError &&
        error.code === "wrong_status",
    );
  } finally {
    database.close();
  }
});

test("requesters cannot approve their own plans and failed transitions do not change state", () => {
  const { database, plan } = createPendingPlan();
  try {
    submitChangePlanForApproval(database, guildId, plan.id, requesterId, now);
    assert.throws(
      () => approveChangePlan(database, guildId, plan.id, requesterId, now),
      (error: unknown) =>
        error instanceof ChangePlanTransitionError &&
        error.code === "self_approval",
    );
    assert.equal(
      getChangePlan(database, guildId, plan.id, now)?.status,
      "awaiting_approval",
    );
    assert.equal(
      database
        .prepare("SELECT decision_by FROM change_plans WHERE plan_id = ?")
        .get(plan.id)?.["decision_by"],
      null,
    );
  } finally {
    database.close();
  }
});

test("approval transitions cannot cross server boundaries", () => {
  const { database, plan } = createPendingPlan();
  try {
    submitChangePlanForApproval(database, guildId, plan.id, requesterId, now);
    assert.throws(
      () => approveChangePlan(database, otherGuildId, plan.id, approverId, now),
      (error: unknown) =>
        error instanceof ChangePlanTransitionError &&
        error.code === "not_found",
    );
    assert.equal(
      getChangePlan(database, guildId, plan.id, now)?.status,
      "awaiting_approval",
    );
  } finally {
    database.close();
  }
});

test("rejection records the approver and time and cannot be repeated", () => {
  const { database, plan } = createPendingPlan();
  try {
    submitChangePlanForApproval(database, guildId, plan.id, requesterId, now);
    const rejected = rejectChangePlan(
      database,
      guildId,
      plan.id,
      approverId,
      now,
    );
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.decisionBy, approverId);
    assert.equal(rejected.decisionAt, now.toISOString());
    assert.throws(
      () => rejectChangePlan(database, guildId, plan.id, approverId, now),
      /not in a state/,
    );
  } finally {
    database.close();
  }
});

test("expired plans are stored as expired instead of entering approval", () => {
  const { database, plan } = createPendingPlan(
    planChanges(),
    new Date(now.getTime() - 31 * 60 * 1_000),
  );
  try {
    assert.throws(
      () =>
        submitChangePlanForApproval(
          database,
          guildId,
          plan.id,
          requesterId,
          now,
        ),
      (error: unknown) =>
        error instanceof ChangePlanTransitionError && error.code === "expired",
    );
    assert.equal(
      getChangePlan(database, guildId, plan.id, now)?.status,
      "expired",
    );
    assert.equal(
      database
        .prepare("SELECT status FROM change_plans WHERE plan_id = ?")
        .get(plan.id)?.["status"],
      "expired",
    );
  } finally {
    database.close();
  }
});

test("a failed preflight marks the whole plan conflicted and records the decision", () => {
  const { database, plan } = createPendingPlan();
  try {
    submitChangePlanForApproval(database, guildId, plan.id, requesterId, now);
    const conflicted = markChangePlanConflicted(
      database,
      guildId,
      plan.id,
      approverId,
      now,
    );
    assert.equal(conflicted.status, "conflicted");
    assert.equal(conflicted.decisionBy, approverId);
    assert.equal(conflicted.decisionAt, now.toISOString());
    assert.throws(
      () => approveChangePlan(database, guildId, plan.id, approverId, now),
      /not in a state/,
    );
  } finally {
    database.close();
  }
});
