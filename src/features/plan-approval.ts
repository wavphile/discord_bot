import type {
  ChangePlan,
  ChangePlanChange,
  RoleOverwriteValue,
} from "./change-plans.js";

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

    if (!matchesBefore(change, observation.current)) {
      issues.push({
        item: index + 1,
        channelId: change.channelId,
        reason: "The current value has changed since this plan was previewed.",
      });
    }
  }

  return { ready: issues.length === 0, issues };
}

function matchesBefore(
  change: ChangePlanChange,
  current: PlanTargetObservation["current"],
): boolean {
  if (change.settingKey === "channel.topic") {
    return (
      (typeof current === "string" || current === null) &&
      current === change.before
    );
  }

  if (change.settingKey === "channel.slowmode") {
    return typeof current === "number" && current === change.before;
  }

  if (current === null || change.before === null) {
    return current === change.before;
  }

  return (
    typeof current === "object" &&
    current.allow === change.before.allow &&
    current.deny === change.before.deny
  );
}
