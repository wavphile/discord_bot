import assert from "node:assert/strict";
import test from "node:test";
import type { ChangePlanChange } from "../src/features/change-plans.js";
import { openDatabase } from "../src/storage/database.js";
import {
  approveChangePlan,
  createChangePlan,
  getChangePlan,
  submitChangePlanForApproval,
} from "../src/storage/change-plans.js";
import {
  beginPlanJobItemAttempt,
  cancelPendingPlanJobItems,
  claimPlanJob,
  enqueueApprovedPlan,
  finalizePlanJob,
  getPlanJob,
  PlanJobStorageError,
  requestPlanJobCancellation,
  setPlanJobItemStatus,
} from "../src/storage/plan-jobs.js";

const guildId = "11111111111111111";
const requesterId = "22222222222222222";
const approverId = "33333333333333333";
const executorId = "44444444444444444";
const channelA = "55555555555555555";
const channelB = "66666666666666666";
const now = new Date("2026-10-30T00:00:00.000Z");

function changes(): ChangePlanChange[] {
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

function createApprovedPlan() {
  const database = openDatabase(":memory:");
  const plan = createChangePlan(
    database,
    { guildId, requestedBy: requesterId, changes: changes() },
    now,
  );
  submitChangePlanForApproval(database, guildId, plan.id, requesterId, now);
  approveChangePlan(
    database,
    guildId,
    plan.id,
    approverId,
    new Date(now.getTime() + 1_000),
  );
  return { database, planId: plan.id };
}

test("enqueue persists the job and all ordered items atomically", () => {
  const { database, planId } = createApprovedPlan();
  try {
    const job = enqueueApprovedPlan(
      database,
      guildId,
      planId,
      executorId,
      new Date(now.getTime() + 2_000),
    );

    assert.equal(job.status, "queued");
    assert.equal(job.planId, planId);
    assert.equal(job.requestedBy, requesterId);
    assert.equal(job.approvedBy, approverId);
    assert.equal(job.createdBy, executorId);
    assert.deepEqual(
      job.items.map((item) => [item.ordinal, item.status, item.attempts]),
      [
        [0, "pending", 0],
        [1, "pending", 0],
      ],
    );
    assert.equal(getChangePlan(database, guildId, planId)?.status, "applying");
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM plan_job_items WHERE job_id = ?",
        )
        .get(job.id)?.["count"],
      2,
    );
  } finally {
    database.close();
  }
});

test("item attempt state persists across retries and terminal completion", () => {
  const { database, planId } = createApprovedPlan();
  try {
    const job = enqueueApprovedPlan(
      database,
      guildId,
      planId,
      executorId,
      new Date(now.getTime() + 2_000),
    );
    assert.equal(claimPlanJob(database, guildId, job.id), true);
    assert.equal(beginPlanJobItemAttempt(database, guildId, job.id, 0), 1);
    setPlanJobItemStatus(database, guildId, job.id, 0, "pending", "HTTP 503");
    assert.equal(beginPlanJobItemAttempt(database, guildId, job.id, 0), 2);
    setPlanJobItemStatus(database, guildId, job.id, 0, "applied", null);
    setPlanJobItemStatus(database, guildId, job.id, 1, "applied", null);
    finalizePlanJob(database, guildId, job.id, "applied", "applied");

    const saved = getPlanJob(database, guildId, job.id);
    assert.equal(saved?.status, "applied");
    assert.deepEqual(
      saved?.items.map((item) => [item.status, item.attempts]),
      [
        ["applied", 2],
        ["applied", 0],
      ],
    );
    assert.equal(getChangePlan(database, guildId, planId)?.status, "applied");
  } finally {
    database.close();
  }
});

test("cancellation is a durable request and cancels only pending items", () => {
  const { database, planId } = createApprovedPlan();
  try {
    const job = enqueueApprovedPlan(
      database,
      guildId,
      planId,
      executorId,
      new Date(now.getTime() + 2_000),
    );
    claimPlanJob(database, guildId, job.id);
    beginPlanJobItemAttempt(database, guildId, job.id, 0);
    setPlanJobItemStatus(database, guildId, job.id, 0, "applied", null);
    requestPlanJobCancellation(database, guildId, job.id);
    cancelPendingPlanJobItems(database, job.id);
    finalizePlanJob(database, guildId, job.id, "cancelled", "partial");

    const saved = getPlanJob(database, guildId, job.id);
    assert.equal(saved?.cancelRequested, true);
    assert.equal(saved?.status, "cancelled");
    assert.deepEqual(
      saved?.items.map((item) => item.status),
      ["applied", "cancelled"],
    );
    assert.equal(getChangePlan(database, guildId, planId)?.status, "partial");
  } finally {
    database.close();
  }
});

test("only unexpired approved plans can become jobs", () => {
  const database = openDatabase(":memory:");
  const plan = createChangePlan(
    database,
    { guildId, requestedBy: requesterId, changes: changes() },
    now,
  );
  try {
    assert.throws(
      () => enqueueApprovedPlan(database, guildId, plan.id, executorId, now),
      (error: unknown) =>
        error instanceof PlanJobStorageError &&
        error.code === "plan_not_approved",
    );
    submitChangePlanForApproval(database, guildId, plan.id, requesterId, now);
    approveChangePlan(
      database,
      guildId,
      plan.id,
      approverId,
      new Date(now.getTime() + 1_000),
    );
    assert.throws(
      () =>
        enqueueApprovedPlan(
          database,
          guildId,
          plan.id,
          executorId,
          new Date(now.getTime() + 31 * 60_000),
        ),
      (error: unknown) =>
        error instanceof PlanJobStorageError && error.code === "expired",
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM plan_jobs").get()?.[
        "count"
      ],
      0,
    );
  } finally {
    database.close();
  }
});
