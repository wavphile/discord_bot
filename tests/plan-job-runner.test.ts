import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits, type Client } from "discord.js";
import type { AuthorizationPolicy } from "../src/core/authorization.js";
import type { ChangePlanChange } from "../src/features/change-plans.js";
import type { PlanTargetObservation } from "../src/features/plan-approval.js";
import {
  changedPermissionOptions,
  DurablePlanJobRunner,
  type PlanJobAdapter,
} from "../src/discord/plan-job-runner.js";
import { matchesPlanValue } from "../src/features/plan-approval.js";
import { openDatabase } from "../src/storage/database.js";
import {
  approveChangePlan,
  createChangePlan,
  getChangePlan,
  submitChangePlanForApproval,
} from "../src/storage/change-plans.js";
import {
  beginPlanJobItemAttempt,
  claimPlanJob,
  enqueueApprovedPlan,
  getPlanJob,
} from "../src/storage/plan-jobs.js";

const guildId = "11111111111111111";
const requesterId = "22222222222222222";
const approverId = "33333333333333333";
const channelA = "55555555555555555";
const channelB = "66666666666666666";
const authorization: AuthorizationPolicy = {
  guildId,
  allowedUserIds: new Set([requesterId]),
  allowedRoleIds: new Set(),
};

test("permission jobs can only change the permission bits exposed by previews", () => {
  const supportedChange: Extract<
    ChangePlanChange,
    { settingKey: "channel.role_overwrite" }
  > = {
    channelId: channelA,
    channelType: "text",
    roleId: channelB,
    settingKey: "channel.role_overwrite",
    before: { allow: "0", deny: "0" },
    after: {
      allow: PermissionFlagsBits.ViewChannel.toString(),
      deny: "0",
    },
  };
  assert.deepEqual(changedPermissionOptions(supportedChange), [
    { name: "ViewChannel", state: true },
  ]);

  const privilegedChange = {
    ...supportedChange,
    after: {
      allow: PermissionFlagsBits.Administrator.toString(),
      deny: "0",
    },
  };
  assert.throws(
    () => changedPermissionOptions(privilegedChange),
    /permission this command does not support/,
  );
});

function twoChanges(): ChangePlanChange[] {
  return [
    {
      channelId: channelA,
      settingKey: "channel.topic",
      before: "old topic",
      after: "new topic",
    },
    {
      channelId: channelB,
      settingKey: "channel.slowmode",
      before: 0,
      after: 5,
    },
  ];
}

function createQueuedJob(changes = twoChanges()) {
  const database = openDatabase(":memory:");
  const now = new Date(Date.now() - 1_000);
  const plan = createChangePlan(
    database,
    { guildId, requestedBy: requesterId, changes },
    now,
  );
  submitChangePlanForApproval(database, guildId, plan.id, requesterId, now);
  approveChangePlan(
    database,
    guildId,
    plan.id,
    approverId,
    new Date(now.getTime() + 100),
  );
  const job = enqueueApprovedPlan(
    database,
    guildId,
    plan.id,
    approverId,
    new Date(now.getTime() + 200),
  );
  return { database, job, planId: plan.id };
}

function fakeAdapter(
  changes: readonly ChangePlanChange[],
  onWrite: (change: ChangePlanChange, attempt: number) => Promise<void> | void,
  overrides: Partial<PlanJobAdapter> = {},
) {
  const values = new Map<string, PlanTargetObservation["current"]>();
  for (const change of changes) values.set(change.channelId, change.before);
  let writeAttempts = 0;
  const adapter: PlanJobAdapter = {
    async preflight(_guildId, change) {
      return matchesPlanValue(
        change,
        values.get(change.channelId) ?? null,
        "before",
      );
    },
    async read(_guildId, change) {
      return {
        current: values.get(change.channelId) ?? null,
        readable: true,
        targetAvailable: true,
      };
    },
    async write(_guildId, change) {
      writeAttempts += 1;
      await onWrite(change, writeAttempts);
      if (values.get(change.channelId) === change.before) {
        values.set(change.channelId, change.after);
      }
    },
    ...overrides,
  };
  return {
    adapter,
    values,
    get writeAttempts() {
      return writeAttempts;
    },
  };
}

function createRunner(
  database: ReturnType<typeof openDatabase>,
  adapter: PlanJobAdapter,
  options: ConstructorParameters<typeof DurablePlanJobRunner>[4] = {},
): DurablePlanJobRunner {
  return new DurablePlanJobRunner(
    database,
    { guilds: {} } as unknown as Pick<Client, "guilds">,
    authorization,
    adapter,
    options,
  );
}

test("retries transient write failures within the persisted attempt bound", async () => {
  const { database, job } = createQueuedJob();
  const fake = fakeAdapter(twoChanges(), async (change, attempt) => {
    if (attempt < 3) throw { status: 503 };
    if (change.channelId === channelA) return;
  });
  const runner = createRunner(database, fake.adapter, {
    baseRetryDelayMs: 0,
    maxRetryDelayMs: 0,
  });
  try {
    await runner.schedule(guildId, job.id);
    const saved = getPlanJob(database, guildId, job.id);
    assert.equal(fake.writeAttempts, 4);
    assert.equal(saved?.status, "applied");
    assert.deepEqual(
      saved?.items.map((item) => item.attempts),
      [3, 1],
    );
  } finally {
    await runner.stop();
    database.close();
  }
});

test("reports partial completion when a later item fails permanently", async () => {
  const changes = twoChanges();
  const { database, job, planId } = createQueuedJob(changes);
  const fake = fakeAdapter(changes, (change) => {
    if (change.channelId === channelB) throw { status: 400 };
  });
  const runner = createRunner(database, fake.adapter);
  try {
    await runner.schedule(guildId, job.id);
    const saved = getPlanJob(database, guildId, job.id);
    assert.equal(saved?.status, "partial");
    assert.deepEqual(
      saved?.items.map((item) => item.status),
      ["applied", "failed"],
    );
    assert.equal(getChangePlan(database, guildId, planId)?.status, "partial");
  } finally {
    await runner.stop();
    database.close();
  }
});

test("serializes jobs for one server", async () => {
  const database = openDatabase(":memory:");
  const changes = twoChanges();
  const setupNow = new Date(Date.now() - 1_000);
  const planIds = [0, 1].map(() => {
    const plan = createChangePlan(
      database,
      { guildId, requestedBy: requesterId, changes },
      setupNow,
    );
    submitChangePlanForApproval(
      database,
      guildId,
      plan.id,
      requesterId,
      setupNow,
    );
    approveChangePlan(
      database,
      guildId,
      plan.id,
      approverId,
      new Date(setupNow.getTime() + 100),
    );
    return plan.id;
  });
  const jobs = planIds.map((planId) =>
    enqueueApprovedPlan(
      database,
      guildId,
      planId,
      approverId,
      new Date(setupNow.getTime() + 200),
    ),
  );
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const fake = fakeAdapter(
    changes,
    async () => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeWrites -= 1;
    },
    {
      async preflight() {
        return true;
      },
    },
  );
  const runner = createRunner(database, fake.adapter);
  try {
    await Promise.all(jobs.map((job) => runner.schedule(guildId, job.id)));
    assert.equal(maxActiveWrites, 1);
    assert.deepEqual(
      jobs.map((job) => getPlanJob(database, guildId, job.id)?.status),
      ["applied", "applied"],
    );
  } finally {
    await runner.stop();
    database.close();
  }
});

test("cancels only between items and records partial work", async () => {
  const changes = twoChanges();
  const { database, job, planId } = createQueuedJob(changes);
  let runner: DurablePlanJobRunner;
  const fake = fakeAdapter(changes, async (change) => {
    if (change.channelId === channelA) {
      runner.requestCancellation(guildId, job.id, approverId);
    }
  });
  runner = createRunner(database, fake.adapter);
  try {
    await runner.schedule(guildId, job.id);
    const saved = getPlanJob(database, guildId, job.id);
    assert.equal(saved?.status, "cancelled");
    assert.deepEqual(
      saved?.items.map((item) => item.status),
      ["applied", "cancelled"],
    );
    assert.equal(getChangePlan(database, guildId, planId)?.status, "partial");
  } finally {
    await runner.stop();
    database.close();
  }
});

test("restart reconciliation records an already-applied item without replaying it", async () => {
  const changes = twoChanges();
  const { database, job, planId } = createQueuedJob(changes);
  claimPlanJob(database, guildId, job.id);
  beginPlanJobItemAttempt(database, guildId, job.id, 0);
  const fake = fakeAdapter(changes, () => undefined);
  fake.values.set(channelA, "new topic");
  const runner = createRunner(database, fake.adapter);
  try {
    await runner.schedule(guildId, job.id);
    const saved = getPlanJob(database, guildId, job.id);
    assert.equal(fake.writeAttempts, 1);
    assert.equal(saved?.status, "applied");
    assert.deepEqual(
      saved?.items.map((item) => item.status),
      ["applied", "applied"],
    );
    assert.equal(getChangePlan(database, guildId, planId)?.status, "applied");
  } finally {
    await runner.stop();
    database.close();
  }
});

test("holds an unreadable interrupted item for reconciliation instead of retrying", async () => {
  const changes = twoChanges();
  const { database, job } = createQueuedJob(changes);
  claimPlanJob(database, guildId, job.id);
  beginPlanJobItemAttempt(database, guildId, job.id, 0);
  let readable = false;
  const fake = fakeAdapter(changes, () => undefined, {
    async read(_guildId, change) {
      return {
        current: change.before,
        readable,
        targetAvailable: readable,
      };
    },
  });
  const runner = createRunner(database, fake.adapter);
  try {
    await runner.schedule(guildId, job.id);
    assert.equal(
      getPlanJob(database, guildId, job.id)?.status,
      "reconciliation_required",
    );
    assert.equal(fake.writeAttempts, 0);

    readable = true;
    await runner.schedule(guildId, job.id);
    assert.equal(getPlanJob(database, guildId, job.id)?.status, "applied");
    assert.equal(fake.writeAttempts, 2);
  } finally {
    await runner.stop();
    database.close();
  }
});

test("conflicts an interrupted item whose current value matches neither side", async () => {
  const changes = twoChanges();
  const { database, job, planId } = createQueuedJob(changes);
  claimPlanJob(database, guildId, job.id);
  beginPlanJobItemAttempt(database, guildId, job.id, 0);
  const fake = fakeAdapter(changes, () => undefined);
  fake.values.set(channelA, "edited by another admin");
  const runner = createRunner(database, fake.adapter);
  try {
    await runner.schedule(guildId, job.id);
    const saved = getPlanJob(database, guildId, job.id);
    assert.equal(saved?.status, "conflicted");
    assert.deepEqual(
      saved?.items.map((item) => item.status),
      ["conflicted", "cancelled"],
    );
    assert.equal(fake.writeAttempts, 0);
    assert.equal(
      getChangePlan(database, guildId, planId)?.status,
      "conflicted",
    );
  } finally {
    await runner.stop();
    database.close();
  }
});

test("does not start another server job while an earlier one needs reconciliation", async () => {
  const database = openDatabase(":memory:");
  const changes = twoChanges();
  const now = new Date(Date.now() - 1_000);
  const planIds = [0, 1].map(() => {
    const plan = createChangePlan(
      database,
      { guildId, requestedBy: requesterId, changes },
      now,
    );
    submitChangePlanForApproval(database, guildId, plan.id, requesterId, now);
    approveChangePlan(
      database,
      guildId,
      plan.id,
      approverId,
      new Date(now.getTime() + 100),
    );
    return plan.id;
  });
  const jobs = planIds.map((planId) =>
    enqueueApprovedPlan(
      database,
      guildId,
      planId,
      approverId,
      new Date(now.getTime() + 200),
    ),
  );
  claimPlanJob(database, guildId, jobs[0]!.id);
  beginPlanJobItemAttempt(database, guildId, jobs[0]!.id, 0);
  const fake = fakeAdapter(changes, () => undefined, {
    async read(_guildId, change) {
      return {
        current: change.before,
        readable: false,
        targetAvailable: false,
      };
    },
  });
  const runner = createRunner(database, fake.adapter);
  try {
    await Promise.all(jobs.map((job) => runner.schedule(guildId, job.id)));
    assert.equal(
      getPlanJob(database, guildId, jobs[0]!.id)?.status,
      "reconciliation_required",
    );
    assert.equal(getPlanJob(database, guildId, jobs[1]!.id)?.status, "queued");
    assert.equal(fake.writeAttempts, 0);
  } finally {
    await runner.stop();
    database.close();
  }
});
