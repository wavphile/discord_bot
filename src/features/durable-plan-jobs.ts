import type { ChangePlanChange } from "./change-plans.js";
import { matchesPlanValue } from "./plan-approval.js";

export type PlanJobStatus =
  | "queued"
  | "running"
  | "reconciliation_required"
  | "applied"
  | "partial"
  | "failed"
  | "conflicted"
  | "cancelled";

export type PlanJobItemStatus =
  "pending" | "applying" | "applied" | "failed" | "conflicted" | "cancelled";

export type PlanJobItem = Readonly<{
  ordinal: number;
  change: ChangePlanChange;
  status: PlanJobItemStatus;
  attempts: number;
  lastError: string | null;
}>;

export type PlanJob = Readonly<{
  id: string;
  planId: string;
  guildId: string;
  requestedBy: string;
  approvedBy: string;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: PlanJobStatus;
  cancelRequested: boolean;
  items: readonly PlanJobItem[];
}>;

export type AmbiguousItemResolution =
  "already_applied" | "safe_to_retry" | "conflicted" | "unreadable";

export function resolveAmbiguousPlanItem(
  change: ChangePlanChange,
  current: ChangePlanChange["before"] | null,
  targetAvailable: boolean,
  readable: boolean,
): AmbiguousItemResolution {
  if (!readable) return "unreadable";
  if (!targetAvailable) return "conflicted";
  if (matchesPlanValue(change, current, "after")) return "already_applied";
  if (matchesPlanValue(change, current, "before")) return "safe_to_retry";
  return "conflicted";
}

export function summarizePlanJob(
  items: readonly Pick<PlanJobItem, "status">[],
  cancelRequested: boolean,
): Readonly<{ jobStatus: PlanJobStatus; planStatus: string }> {
  if (items.some((item) => item.status === "applying")) {
    return { jobStatus: "reconciliation_required", planStatus: "applying" };
  }
  if (items.some((item) => item.status === "pending")) {
    return { jobStatus: "running", planStatus: "applying" };
  }

  const appliedCount = items.filter((item) => item.status === "applied").length;
  const failureCount = items.filter((item) => item.status === "failed").length;
  const conflictCount = items.filter(
    (item) => item.status === "conflicted",
  ).length;

  if (cancelRequested) {
    return {
      jobStatus: "cancelled",
      planStatus: appliedCount > 0 ? "partial" : "cancelled",
    };
  }
  if (conflictCount > 0) {
    return appliedCount > 0
      ? { jobStatus: "partial", planStatus: "partial" }
      : { jobStatus: "conflicted", planStatus: "conflicted" };
  }
  if (failureCount > 0) {
    return appliedCount > 0
      ? { jobStatus: "partial", planStatus: "partial" }
      : { jobStatus: "failed", planStatus: "failed" };
  }
  return { jobStatus: "applied", planStatus: "applied" };
}

export function describePlanJob(job: PlanJob): string[] {
  const counts = new Map<PlanJobItemStatus, number>();
  for (const item of job.items) {
    counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  }
  const heading = [
    `Job \`${job.id}\` for plan \`${job.planId}\`: **${job.status}**.`,
    `${counts.get("applied") ?? 0}/${job.items.length} items applied`,
  ];
  for (const status of [
    "pending",
    "applying",
    "failed",
    "conflicted",
    "cancelled",
  ] as const) {
    const count = counts.get(status) ?? 0;
    if (count > 0) heading.push(`${count} ${status}`);
  }
  if (job.cancelRequested && job.status === "running") {
    heading.push("Cancellation requested; the current item will finish first.");
  }
  if (job.status === "reconciliation_required") {
    heading.push(
      "An interrupted Discord write must be reconciled before retry.",
    );
  }

  const messages = [heading.join(" · ")];
  for (const item of job.items) {
    const detail = item.lastError ? ` — ${item.lastError.slice(0, 160)}` : "";
    const subject =
      item.change.settingKey === "channel.role_overwrite"
        ? ` · role \`${item.change.roleId}\``
        : "";
    const line = `Item ${item.ordinal + 1} · channel \`${item.change.channelId}\`${subject} · ${item.change.settingKey}: **${item.status}**${detail}`;
    const current = messages.at(-1) ?? "";
    if (current.length + line.length + 1 > 1_800) {
      messages.push(`Job \`${job.id}\` item results (continued):`);
    }
    messages[messages.length - 1] += `\n${line}`;
  }
  return messages;
}
