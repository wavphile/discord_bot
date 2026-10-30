import type {
  ChangePlan,
  ChangePlanChange,
  RoleOverwriteValue,
} from "./change-plans.js";
import { reverseChangePlanChange } from "./change-plans.js";

export type PlanTargetObservation = Readonly<{
  current: string | number | RoleOverwriteValue | null;
  canWrite: boolean;
  reason?: string;
}>;

export type PlanPreflightIssue = Readonly<{
  item: number | null;
  channelId?: string;
  reason: string;
}>;

export type PlanPreflightResult = Readonly<{
  ready: boolean;
  issues: readonly PlanPreflightIssue[];
}>;

/**
 * Compare every saved target with a fresh Discord read before a plan is
 * approved. The executor must run this again immediately before each write.
 */
export function evaluatePlanPreflight(
  plan: Pick<ChangePlan, "changes">,
  requesterAuthorized: boolean,
  observations: readonly (PlanTargetObservation | null)[],
): PlanPreflightResult {
  const issues: PlanPreflightIssue[] = [];

  if (!requesterAuthorized) {
    issues.push({
      item: null,
      reason: "The requester is no longer authorized to use this bot.",
    });
  }

  if (observations.length !== plan.changes.length) {
    issues.push({
      item: null,
      reason: "Not every planned target could be checked.",
    });
  }

  for (const [index, change] of plan.changes.entries()) {
    const observation = observations[index];
    if (!observation) {
      issues.push({
        item: index + 1,
        channelId: change.channelId,
        reason: "The target could not be checked.",
      });
      continue;
    }

    if (!observation.canWrite) {
      issues.push({
        item: index + 1,
        channelId: change.channelId,
        reason:
          observation.reason ?? "The bot cannot safely change this target.",
      });
      continue;
    }

    if (!matchesPlanValue(change, observation.current, "before")) {
      issues.push({
        item: index + 1,
        channelId: change.channelId,
        reason: "The current value has changed since this plan was previewed.",
      });
    }
  }

  return { ready: issues.length === 0, issues };
}

export function matchesPlanValue(
  change: ChangePlanChange,
  current: PlanTargetObservation["current"],
  expected: "before" | "after",
): boolean {
  const expectedValue = change[expected];
  if (change.settingKey === "channel.topic") {
    return (
      (typeof current === "string" || current === null) &&
      current === expectedValue
    );
  }

  if (change.settingKey === "channel.slowmode") {
    return typeof current === "number" && current === expectedValue;
  }

  if (current === null || expectedValue === null) {
    return current === expectedValue;
  }

  if (typeof current !== "object" || typeof expectedValue !== "object") {
    return false;
  }
  return (
    current.allow === expectedValue.allow && current.deny === expectedValue.deny
  );
}

export type ReversalObservation = Readonly<{
  ordinal: number;
  current: PlanTargetObservation["current"];
  readable: boolean;
  targetAvailable: boolean;
  reason?: string;
}>;

export type ReversalItem = Readonly<{
  ordinal: number;
  change: ChangePlanChange;
}>;

export type ReversalPreparation = Readonly<{
  ready: boolean;
  changes: readonly ChangePlanChange[];
  issues: readonly Readonly<{
    ordinal: number;
    channelId: string;
    reason: string;
  }>[];
}>;

/** Build a reviewed inverse only if every applied target still has its after value. */
export function prepareReviewedReversal(
  appliedItems: readonly ReversalItem[],
  observations: readonly ReversalObservation[],
): ReversalPreparation {
  const byOrdinal = new Map(
    observations.map((observation) => [observation.ordinal, observation]),
  );
  const issues: Array<{ ordinal: number; channelId: string; reason: string }> =
    [];
  const changes: ChangePlanChange[] = [];
  for (const item of appliedItems) {
    const observation = byOrdinal.get(item.ordinal);
    if (!observation || !observation.readable || !observation.targetAvailable) {
      issues.push({
        ordinal: item.ordinal,
        channelId: item.change.channelId,
        reason:
          observation?.reason ?? "The applied target could not be read safely.",
      });
      continue;
    }
    if (!matchesPlanValue(item.change, observation.current, "after")) {
      issues.push({
        ordinal: item.ordinal,
        channelId: item.change.channelId,
        reason: "The current value differs from the value applied by the job.",
      });
      continue;
    }
    changes.push(reverseChangePlanChange(item.change));
  }
  if (observations.length !== appliedItems.length) {
    for (const item of appliedItems) {
      if (!byOrdinal.has(item.ordinal)) continue;
      if (issues.some((issue) => issue.ordinal === item.ordinal)) continue;
      issues.push({
        ordinal: item.ordinal,
        channelId: item.change.channelId,
        reason: "The reversal target set did not match the applied job items.",
      });
    }
  }
  return {
    ready: issues.length === 0 && appliedItems.length > 0,
    changes: issues.length === 0 ? changes : [],
    issues,
  };
}
